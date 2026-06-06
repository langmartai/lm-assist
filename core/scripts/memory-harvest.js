#!/usr/bin/env node
/**
 * memory-harvest.js -- Stream A feeder: recent sessions -> PROPOSED memory records.
 *
 * PROPOSE-ONLY -- never writes memory files, never commits.
 * Proposals: ~/.lm-assist/memory-proposals.jsonl
 * See: docs/plans/2026-06-06-record-level-memory-map-and-sync.md sec 10/12/13
 *
 *   node core/scripts/memory-harvest.js [--project <slug>] [--since <iso|ms|Nh|Nd>]
 *        [--session <id>] [--limit N] [--dry-run]
 */
'use strict';
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const http  = require('http');

const PORT        = process.env.API_PORT || (__dirname.includes('node_modules') ? '3100' : '3200');
const MAP_SCRIPT  = path.join(__dirname, 'memory-map.js');
const PROPOSALS   = path.join(os.homedir(), '.lm-assist', 'memory-proposals.jsonl');
const PROJECT_DIR = path.join(os.homedir(), '.claude', 'projects');
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;

const argv = process.argv.slice(2);
const opt  = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has  = (k) => argv.includes('--' + k);
const filterProject = opt('project');
const filterSession = opt('session');
const limitN        = parseInt(opt('limit', '0'), 10);
const dryRun        = has('dry-run');

function parseSince(raw) {
  if (!raw) return Date.now() - DEFAULT_SINCE_MS;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  const rel = raw.match(/^(\d+)([hHdD])$/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    return Date.now() - n * (rel[2].toLowerCase() === 'h' ? 3600000 : 86400000);
  }
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.getTime();
  console.error('[harvest] Cannot parse --since value:', raw); process.exit(1);
}
const sinceMs = parseSince(opt('since'));

function discoverSessions() {
  const found = [];
  let dirs;
  try { dirs = fs.readdirSync(PROJECT_DIR, { withFileTypes: true }); }
  catch (e) { console.error('[harvest] Cannot read projects dir:', e.message); return []; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const slug = d.name;
    if (filterProject && !slug.includes(filterProject)) continue;
    const pd = path.join(PROJECT_DIR, slug);
    let files;
    try { files = fs.readdirSync(pd, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const sessionId = f.name.replace('.jsonl', '');
      if (filterSession && sessionId !== filterSession) continue;
      const fp = path.join(pd, f.name);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      if (st.mtimeMs < sinceMs) continue;
      found.push({ sessionId, projectSlug: slug, filePath: fp, mtimeMs: st.mtimeMs, sizeBytes: st.size });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return limitN > 0 ? found.slice(0, limitN) : found;
}

function buildPrompt(session) {
  const { sessionId, projectSlug, filePath, mtimeMs } = session;
  const sessionDate = new Date(mtimeMs).toISOString();
  return [
    '=== HARVESTER CONTRACT -- READ CAREFULLY BEFORE DOING ANYTHING ===',
    '',
    'You are a DEEP MEMORY ANALYST. Your role is to analyse a Claude Code session and',
    'identify facts worth persisting as long-term memory records. You are an ANALYST,',
    'NOT a recorder. You MUST NOT write any memory files or run any git commands.',
    'Your ONLY output is a JSON array of proposed records (may be empty: []).',
    '',
    '=== SESSION TO ANALYSE ===',
    'Session ID   : ' + sessionId,
    'Project slug : ' + projectSlug,
    'File         : ' + filePath,
    'Last modified: ' + sessionDate,
    '',
    '=== STEP 1 -- READ AND SUMMARISE THE SESSION ===',
    '',
    'Read the session file:',
    '  cat "' + filePath + '"',
    '',
    'The file is JSONL. Each line is a JSON event. Key types:',
    '  - type=user      : user message (message.content)',
    '  - type=assistant : assistant message (message.content[].type=text or tool_use)',
    '  - tool_use blocks: tool calls (name + input)',
    '  - tool_result    : tool output (content)',
    '  - type=system/subtype=ai_title : AI-generated session title',
    '',
    'Focus on what was ACTUALLY DONE: code written, files edited, tests run, endpoints',
    'validated, decisions made, bugs found+fixed, user confirmations.',
    'Ignore API errors, overloaded retries, and system-level noise lines.',
    '',
    '=== STEP 2 -- APPLY THE WHY-MEMORY TEST (per candidate fact) ===',
    '',
    'For each candidate fact ask ALL FOUR questions:',
    '  A. Is it SIGNIFICANT? (not trivial, not obvious boilerplate)',
    '  B. Is it NON-OBVIOUS? (requires reasoning or experience to know)',
    '  C. Is it NOT already captured by the codebase / CLAUDE.md / docs /,',
    '     the EXISTING MEMORY MAP? Check:',
    '       node ' + MAP_SCRIPT + ' --q "<keywords>" --level brief --format json --limit 20',
    '  D. Is it durable? (outlasts this session; not debugging noise or a reverted attempt)',
    '',
    'REJECT anything that fails A, B, C, or D. When in doubt, reject.',
    '',
    '=== STEP 3 -- GRADED CONFIRMATION (spec section 13) ===',
    '',
    'For each passing fact, determine the validation tier:',
    '',
    '  code-confirmed   : Read the ACTUAL code/config file and verify the fact holds.',
    '                     Record file+line as evidence.',
    '  session-confirmed: Session transcript shows developed->tested->validated.',
    '                     Tool results show tests passed or round-trip succeeded.',
    '                     Evidence = session message UUID range.',
    '  asserted         : Stated but not verified. Use sparingly.',
    '',
    'Prefer code-confirmed. Fall back to asserted only for high-value fresh facts.',
    '',
    '=== STEP 4 -- VALIDITY WINDOW ===',
    '',
    'For each kept fact, reason about when it STOPS being true:',
    '  - Tie validity to code/feature state.',
    '  - Set validFrom = today if newly established, or earlier if known.',
    '  - Set validUntil (YYYY-MM-DD) or null if genuinely open-ended.',
    '  - Set validUntilCondition -- human-readable condition that makes the fact false.',
    '',
    '=== STEP 5 -- DEDUPLICATE AGAINST EXISTING MAP ===',
    '',
    'For each proposal run:',
    '  node ' + MAP_SCRIPT + ' --q "<title keywords>" --level brief --format json --limit 10',
    'If a highly similar record already exists (same topic + same project), skip.',
    '',
    '=== STEP 6 -- OUTPUT FORMAT ===',
    '',
    'Return ONLY a JSON array. Each element:',
    '',
    '{',
    '  "title": "Short factual title (80 chars max)",',
    '  "brief": "One-sentence description for memory index (120 chars max)",',
    '  "body": "Full body -- multi-paragraph detail, evidence refs, file paths.",',
    '  "category": "architecture|deployment|component|endpoint|feature|config|lesson|knowledge",',
    '  "type": "project|feature|reference|feedback|knowledge",',
    '  "validationTier": "code-confirmed|session-confirmed|asserted",',
    '  "evidence": "file:line OR session message UUID OR description",',
    '  "validFrom": "YYYY-MM-DD",',
    '  "validUntil": "YYYY-MM-DD or null",',
    '  "validUntilCondition": "condition under which this fact becomes false",',
    '  "originSessionId": "' + sessionId + '",',
    '  "originProjectSlug": "' + projectSlug + '",',
    '  "suggestedProject": "project slug this memory should be filed under",',
    '  "suggestedFilename": "snake_case_short_name.md"',
    '}',
    '',
    'Output rules:',
    '  - Return [] if nothing passes the WHY-MEMORY test.',
    '  - Do NOT include runtime noise, boilerplate, or things the codebase documents.',
    '  - Maximum 10 proposals per session -- quality over quantity.',
    '  - NO prose before or after the JSON array. Output starts with [ ends with ].',
    '',
    '=== CRITICAL SAFETY CONSTRAINT -- ABSOLUTE, NO EXCEPTIONS ===',
    '',
    'You MUST NOT:',
    '  - Write or modify any file under ~/.claude/ or any memory/ directory',
    '  - Run git add, git commit, git push, or any git mutation',
    '  - Call any /memory/* write API endpoints',
    '  - Fabricate memory content -- every claim must trace to the session or code',
    '',
    'You are a PROPOSER only. The CLI wrapper appends proposals to',
    '~/.lm-assist/memory-proposals.jsonl. A human reviews before anything',
    'becomes real memory. This constraint is absolute and non-negotiable.',
    '',
    '=== BEGIN ===',
    '',
    'Analyse the session now. Return only the JSON proposals array. CRITICAL: your FINAL message must BE the JSON array itself, emitted VERBATIM as text — running the tool is NOT enough; if your final reply is empty or a summary the result is lost.',
  ].join('\n');
}

function spawnOpusAgent(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      prompt, cwd: '/home/ubuntu/lm-assist', model: 'opus', background: false,
      permissionMode: 'bypassPermissions', settingSources: ['project', 'user'],
      outputConfig: { effort: 'high' },
    });
    const req = http.request(
      { host: 'localhost', port: PORT, path: '/agent/execute', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let d = '';
        res.on('data', c => (d += c));
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
      }
    );
    req.on('error', reject); req.write(body); req.end();
  });
}

function parseProposals(agentResult) {
  let text = '';
  if (typeof agentResult === 'string') text = agentResult;
  else if (agentResult && typeof agentResult === 'object') {
    if (agentResult.data && typeof agentResult.data === 'string') text = agentResult.data;
    else if (agentResult.result && typeof agentResult.result === 'string') text = agentResult.result;
    else if (agentResult.data && typeof agentResult.data === 'object' && typeof agentResult.data.result === 'string') text = agentResult.data.result;
    else text = JSON.stringify(agentResult);
  }
  const cands = [];
  const fence = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  if (fence) cands.push(fence[1]);
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '[') continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === '[') depth++;
      else if (text[j] === ']') { if (--depth === 0) { cands.push(text.slice(i, j + 1)); i = j; break; } }
    }
  }
  for (const c of cands) {
    try { const a = JSON.parse(c); if (Array.isArray(a) && (a.length === 0 || typeof a[0] === 'object')) return a; } catch {}
  }
  console.error('[harvest] no parseable JSON proposals array; raw(600): ' + (text || '').slice(0, 600));
  return [];
}

function appendProposals(proposals, session) {
  if (!proposals || proposals.length === 0) return;
  fs.mkdirSync(path.dirname(PROPOSALS), { recursive: true });
  const ts = Date.now();
  for (const p of proposals) {
    const record = Object.assign({}, p, {
      _harvestedAt: ts,
      _harvestedAtIso: new Date(ts).toISOString(),
      _originSessionId: p.originSessionId || session.sessionId,
      _originProjectSlug: p.originProjectSlug || session.projectSlug,
      _proposalStatus: 'pending',
    });
    fs.appendFileSync(PROPOSALS, JSON.stringify(record) + '\n');
  }
}

(async () => {
  const sessions = discoverSessions();
  if (sessions.length === 0) {
    console.log('[harvest] No sessions found matching criteria.');
    console.log('[harvest]   --project : ' + (filterProject || '(all projects)'));
    console.log('[harvest]   --since   : ' + new Date(sinceMs).toISOString());
    console.log('[harvest]   --session : ' + (filterSession || '(any)'));
    console.log('[harvest]   --limit   : ' + (limitN || 'unlimited'));
    return;
  }
  console.log('[harvest] Found ' + sessions.length + ' session(s) to analyse.');
  console.log('[harvest] Proposals file : ' + PROPOSALS);
  console.log('[harvest] Agent endpoint : http://localhost:' + PORT + '/agent/execute');
  console.log('[harvest] Model          : opus (deep analyst -- spec section 11)');
  if (dryRun) {
    console.log('[harvest] DRY-RUN mode   : prompt(s) printed, NO Opus agents spawned.');
    console.log('');
  }
  let totalProposed = 0;
  for (const session of sessions) {
    const prompt = buildPrompt(session);
    if (dryRun) {
      console.log('='.repeat(72));
      console.log('TARGET SESSION');
      console.log('  ID      : ' + session.sessionId);
      console.log('  Project : ' + session.projectSlug);
      console.log('  File    : ' + session.filePath);
      console.log('  Size    : ' + session.sizeBytes + ' bytes');
      console.log('  mtime   : ' + new Date(session.mtimeMs).toISOString());
      console.log('');
      console.log('ASSEMBLED OPUS PROMPT (' + prompt.length + ' chars):');
      console.log('-'.repeat(72));
      console.log(prompt);
      console.log('='.repeat(72));
      console.log('');
      continue;
    }
    console.log('[harvest] Analysing session ' + session.sessionId + ' ...');
    let agentResponse;
    try {
      agentResponse = await spawnOpusAgent(prompt);
    } catch (e) {
      console.error('[harvest] Agent endpoint error for session ' + session.sessionId + ':', e.message);
      console.error('[harvest] NOTE: live Opus harvest requires the full prod agent stack.');
      continue;
    }
    const proposals = parseProposals(agentResponse);
    console.log('[harvest]   -> ' + proposals.length + ' proposal(s)');
    appendProposals(proposals, session);
    totalProposed += proposals.length;
  }
  if (!dryRun) {
    console.log('');
    console.log('[harvest] Done. ' + totalProposed + ' total proposal(s) appended to ' + PROPOSALS);
    console.log('[harvest] IMPORTANT: No memory files were written. Review proposals first.');
    console.log('[harvest] NOTE: Live Opus execution needs the full prod agent stack (not dev :3200).');
  }
})();