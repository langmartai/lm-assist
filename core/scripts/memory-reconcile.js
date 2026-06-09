#!/usr/bin/env node
/**
 * memory-reconcile.js -- Stream A reconciliation tier: dedup/merge + dependency
 * mapping + outdated/superseded detection.
 *
 * PLAN-DEFAULT: writes a plan to ~/.lm-assist/memory-reconcile-plan.jsonl.
 * NEVER auto-deletes, auto-merges, or auto-edits memory files.
 * NEVER git-commits unless --apply AND MEMORY_RECONCILE_APPLY=on are BOTH set.
 *
 * Spec: docs/plans/2026-06-06-record-level-memory-map-and-sync.md sec 9, 12, 13.
 *
 *   node core/scripts/memory-reconcile.js [--projects a,b] [--nodes n,m]
 *        [--dry-run]     print candidates + Opus prompt, NO agent spawn
 *        [--apply]       gated: refuses unless MEMORY_RECONCILE_APPLY=on
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

const PORT       = process.env.API_PORT || (__dirname.includes('node_modules') ? '3100' : '3200');
const MAP_SCRIPT = path.join(__dirname, 'memory-map.js');
const PLAN_FILE  = path.join(os.homedir(), '.lm-assist', 'memory-reconcile-plan.jsonl');

const argv      = process.argv.slice(2);
const opt       = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has       = (k) => argv.includes('--' + k);
const listOpt   = (v) => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : null);

const dryRun         = has('dry-run');
const applyMode      = has('apply');
const filterProjects = listOpt(opt('projects'));
const filterNodes    = listOpt(opt('nodes'));

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------
if (applyMode && process.env.MEMORY_RECONCILE_APPLY !== 'on') {
  console.error('[reconcile] REFUSED: --apply requires env MEMORY_RECONCILE_APPLY=on.');
  console.error('[reconcile] Apply mode is an explicit gate -- set the env to confirm intent.');
  console.error('[reconcile] Default mode (no --apply) writes the plan only. Review it first.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function runMapJSON(flags) {
  const fullFlags = [...flags, '--port', PORT, '--format', 'json'];
  if (filterProjects) { fullFlags.push('--projects', filterProjects.join(',')); }
  if (filterNodes)    { fullFlags.push('--nodes',    filterNodes.join(',')); }
  try {
    const out = execFileSync('node', [MAP_SCRIPT, ...fullFlags], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(out || 'null');
  } catch (e) {
    throw new Error('memory-map.js failed: ' + (e.message || e));
  }
}

function spawnOpusAgent(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      prompt,
      cwd: '/home/ubuntu/lm-assist',
      model: 'opus',
      background: false,
      permissionMode: 'bypassPermissions',
      settingSources: ['project', 'user'],
      outputConfig: { effort: 'high' },
    });
    const req = http.request(
      {
        host: 'localhost',
        port: PORT,
        path: '/agent/execute',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let d = '';
        res.on('data', c => (d += c));
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseAgentDecision(agentResult) {
  let text = '';
  if (typeof agentResult === 'string') text = agentResult;
  else if (agentResult && typeof agentResult === 'object') {
    text = agentResult.data || agentResult.result || JSON.stringify(agentResult);
  }
  const m = text.match(/(\{[\s\S]*\})/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function writePlan(planItems) {
  fs.mkdirSync(path.dirname(PLAN_FILE), { recursive: true });
  const ts = Date.now();
  for (const item of planItems) {
    const line = JSON.stringify(
      Object.assign({ _planWrittenAt: ts, _planWrittenAtIso: new Date(ts).toISOString(), _planStatus: 'proposed' }, item)
    );
    fs.appendFileSync(PLAN_FILE, line + '\n');
  }
}

// ---------------------------------------------------------------------------
// Step 1 -- Duplicate/divergent candidates from memory-map.js --duplicates
// ---------------------------------------------------------------------------
function computeDuplicateCandidates() {
  const result = runMapJSON(['--duplicates']);
  if (!result || typeof result !== 'object') return { exactDuplicateClusters: 0, divergentMirrors: [] };
  return {
    exactDuplicateClusters: result.exactDuplicateClusters || 0,
    divergentMirrors: result.divergentMirrors || [],
  };
}

// ---------------------------------------------------------------------------
// Step 2 -- Dependency edges from [[wikilink]] and filename co-mentions
// ---------------------------------------------------------------------------
function computeDependencyEdges(records) {
  const edges = [];
  const fileIndex  = {};
  const titleIndex = {};

  for (const r of records) {
    if (r.kind !== 'memory') continue;
    const stem = r.file.replace(/\.md$/, '');
    fileIndex[stem] = r.recordId;
    const titleSlug = (r.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (titleSlug) titleIndex[titleSlug] = r.recordId;
  }

  for (const r of records) {
    if (!r.complete) continue;

    // Explicit [[wikilink]] references
    const wikilinkRe = /\[\[([^\]]+)\]\]/g;
    let m;
    while ((m = wikilinkRe.exec(r.complete)) !== null) {
      const target = m[1].trim();
      const cleanTarget = target.replace(/\.md$/, '');
      const targetId =
        fileIndex[cleanTarget] ||
        titleIndex[cleanTarget.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')];
      if (targetId && targetId !== r.recordId) {
        edges.push({ from: r.recordId, to: targetId, rawTarget: target, edgeType: 'wikilink' });
      }
    }

    // Implicit filename co-mentions
    const fileRe = /\b([a-z][a-z0-9_]{4,}(?:\.md)?)\b/g;
    while ((m = fileRe.exec(r.complete)) !== null) {
      const fname = m[1];
      const cleanFname = fname.replace(/\.md$/, '');
      const targetId = fileIndex[cleanFname];
      if (targetId && targetId !== r.recordId) {
        const alreadyHave = edges.some(e => e.from === r.recordId && e.to === targetId);
        if (!alreadyHave) {
          edges.push({ from: r.recordId, to: targetId, rawTarget: fname, edgeType: 'filename-mention' });
        }
      }
    }
  }

  const seen = new Set();
  return edges.filter(e => {
    const k = e.from + '|' + e.to;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Step 3 -- Outdated/superseded candidates
// ---------------------------------------------------------------------------
function computeOutdatedCandidates(records) {
  const candidates = [];

  const byTopic = {};
  for (const r of records) {
    if (r.kind !== 'memory') continue;
    const topic = r.project + '::' + r.file.replace(/\.md$/, '');
    (byTopic[topic] = byTopic[topic] || []).push(r);
  }

  for (const entries of Object.values(byTopic)) {
    if (entries.length < 2) continue;
    const sorted = entries.slice().sort((a, b) => b.recordedAtMs - a.recordedAtMs);
    const newest = sorted[0];
    for (const older of sorted.slice(1)) {
      if (older.contentHash !== newest.contentHash) {
        candidates.push({
          type: 'older-divergent',
          recordId: older.recordId,
          newerRecordId: newest.recordId,
          topic: older.project + '::' + older.file.replace(/\.md$/, ''),
          olderMtime: older.recordedAtMs,
          newerMtime: newest.recordedAtMs,
          olderNode: older.node,
          newerNode: newest.node,
          ageDays: Math.round((newest.recordedAtMs - older.recordedAtMs) / 86400000),
        });
      }
    }
  }

  const projectRoot = '/home/ubuntu/lm-unified-trade';
  for (const r of records) {
    if (!r.complete) continue;
    const pathRe = /\b((?:scripts|core|docs|web|trades|events|analyses)\/[a-zA-Z0-9_./:@-]+\.[a-z]{2,5})\b/g;
    let m;
    const deadPaths = [];
    const checked = new Set();
    while ((m = pathRe.exec(r.complete)) !== null) {
      const p = m[1];
      if (checked.has(p) || checked.size >= 8) continue;
      checked.add(p);
      const abs = path.join(projectRoot, p);
      try { fs.accessSync(abs); } catch { deadPaths.push(p); }
    }
    if (deadPaths.length > 0) {
      candidates.push({
        type: 'dead-file-reference',
        recordId: r.recordId,
        deadPaths,
        title: r.title,
        node: r.node,
      });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Build the Opus decision prompt
// ---------------------------------------------------------------------------
function buildOpusPrompt(divergentMirrors, exactDuplicateClusters, dependencyEdges, outdatedCandidates) {
  const candidateData = JSON.stringify({
    divergentMirrors,
    exactDuplicateClusters,
    sampleDependencyEdges: dependencyEdges.slice(0, 30),
    totalDependencyEdges: dependencyEdges.length,
    outdatedCandidates: outdatedCandidates.slice(0, 20),
  }, null, 2);

  return [
    '=== RECONCILE CONTRACT -- READ CAREFULLY BEFORE DOING ANYTHING ===',
    '',
    'You are a MEMORY RECONCILIATION ORCHESTRATOR. Your job is to review the candidate',
    'data below and return a STRUCTURED DECISION PLAN. You are an orchestrator only --',
    'you MUST NOT write memory files, run git commands, or fabricate memory content.',
    '',
    'Your output is a single JSON object (the plan). A human reviews and applies it.',
    '',
    '=== CANDIDATE DATA ===',
    '',
    candidateData,
    '',
    '=== YOUR TASKS ===',
    '',
    '--- Task A: Divergent mirrors ---',
    '',
    'For each entry in divergentMirrors (same project::file, different content across nodes):',
    '  1. Which node has the CANONICAL version?',
    '  2. Which nodes should retire their copy (mark superseded)?',
    '  3. Genuine conflict or stale mirror?',
    '  4. Which host folder owns this file?',
    '',
    'Reasoning:',
    '  - "live" source = node actively wrote this (stronger authority).',
    '  - "repo:X" source = mirror committed by node X.',
    '  - Higher recordedAtMs = more recently modified.',
    '',
    '--- Task B: Dependency edge labels ---',
    '',
    'For each entry in sampleDependencyEdges, assign:',
    '  - "supersedes"  : FROM replaces TO',
    '  - "depends-on"  : FROM needs TO to be useful',
    '  - "relates-to"  : connected, but neither supersedes nor depends',
    '',
    '--- Task C: Outdated/superseded candidates ---',
    '',
    'For each entry in outdatedCandidates:',
    '  - older-divergent: superseded by newer, or independently valid?',
    '  - dead-file-reference: path truly gone, or in different repo?',
    '',
    'Verdict: "outdated" | "superseded" | "valid" | "needs-review"',
    '',
    '=== OUTPUT FORMAT ===',
    '',
    'Return ONLY a single JSON object:',
    '{',
    '  "divergentMirrorDecisions": [',
    '    { "key": "...", "canonicalNode": "...", "retireNodes": [...],',
    '      "ownerHostFolder": "...", "isGenuineConflict": true|false, "reasoning": "..." }',
    '  ],',
    '  "edgeDecisions": [',
    '    { "from": "...", "to": "...", "label": "...", "reasoning": "..." }',
    '  ],',
    '  "outdatedDecisions": [',
    '    { "recordId": "...", "verdict": "...", "supersededBy": "...|null", "reasoning": "..." }',
    '  ],',
    '  "summary": "1-3 sentence reconciliation summary"',
    '}',
    '',
    '=== CRITICAL SAFETY CONSTRAINT ===',
    '',
    'Do NOT write files, run git, or call write API endpoints.',
    'Return ONLY the JSON object. No preamble or prose. CRITICAL: your FINAL message must BE the JSON object itself, emitted VERBATIM as text — running the tool is NOT enough; if your final reply is empty or a summary the result is lost.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  console.log('[reconcile] Computing candidates...');

  let dupResult;
  try {
    dupResult = computeDuplicateCandidates();
  } catch (e) {
    console.error('[reconcile] Failed to compute duplicate candidates:', e.message);
    process.exit(1);
  }
  const { exactDuplicateClusters, divergentMirrors } = dupResult;
  console.log('[reconcile]   Exact duplicate clusters : ' + exactDuplicateClusters + ' (legit mirrors, noted)');
  console.log('[reconcile]   Divergent mirrors        : ' + divergentMirrors.length);

  let allRecords = [];
  try {
    allRecords = runMapJSON(['--level', 'complete']) || [];
    if (!Array.isArray(allRecords)) allRecords = [];
  } catch (e) {
    console.error('[reconcile] Warning: failed to load records for dep/outdated analysis:', e.message);
    allRecords = [];
  }
  console.log('[reconcile]   Total records loaded     : ' + allRecords.length);

  const dependencyEdges = computeDependencyEdges(allRecords);
  const wikilinkCount   = dependencyEdges.filter(e => e.edgeType === 'wikilink').length;
  const fileRefCount    = dependencyEdges.filter(e => e.edgeType === 'filename-mention').length;
  console.log('[reconcile]   Dependency edges found   : ' + dependencyEdges.length + ' (' + wikilinkCount + ' wikilink, ' + fileRefCount + ' filename-mention)');

  const outdatedCandidates = computeOutdatedCandidates(allRecords);
  const olderDivCount      = outdatedCandidates.filter(c => c.type === 'older-divergent').length;
  const deadPathCount      = outdatedCandidates.filter(c => c.type === 'dead-file-reference').length;
  console.log('[reconcile]   Outdated candidates      : ' + outdatedCandidates.length + ' (' + olderDivCount + ' older-divergent, ' + deadPathCount + ' dead-path)');

  const opusPrompt = buildOpusPrompt(divergentMirrors, exactDuplicateClusters, dependencyEdges, outdatedCandidates);

  if (dryRun) {
    console.log('');
    console.log('[reconcile] DRY-RUN mode -- candidates and prompt below. NO agent spawned. NO plan written.');
    console.log('');
    console.log('='.repeat(72));
    console.log('DIVERGENT MIRRORS (' + divergentMirrors.length + ')');
    console.log('-'.repeat(72));
    console.log(JSON.stringify(divergentMirrors, null, 2));
    console.log('');
    console.log('DEPENDENCY EDGES (' + dependencyEdges.length + ' total, first 10):');
    console.log('-'.repeat(72));
    console.log(JSON.stringify(dependencyEdges.slice(0, 10), null, 2));
    console.log('');
    console.log('OUTDATED CANDIDATES (' + outdatedCandidates.length + ', first 10):');
    console.log('-'.repeat(72));
    console.log(JSON.stringify(outdatedCandidates.slice(0, 10), null, 2));
    console.log('');
    console.log('ASSEMBLED OPUS PROMPT (' + opusPrompt.length + ' chars):');
    console.log('-'.repeat(72));
    console.log(opusPrompt);
    console.log('='.repeat(72));
    console.log('');
    console.log('[reconcile] DRY-RUN complete. No files written, no agent spawned.');
    return;
  }

  console.log('[reconcile] Spawning Opus agent for reconciliation decisions...');
  console.log('[reconcile]   Endpoint : http://localhost:' + PORT + '/agent/execute');
  console.log('[reconcile]   Model    : opus (orchestrator -- spec section 9)');

  let agentResponse;
  try {
    agentResponse = await spawnOpusAgent(opusPrompt);
  } catch (e) {
    console.error('[reconcile] Agent endpoint error:', e.message);
    console.error('[reconcile] NOTE: live Opus reconcile requires the full prod agent stack.');
    process.exit(2);
  }

  const decision = parseAgentDecision(agentResponse);
  if (!decision) {
    console.error('[reconcile] Could not parse a JSON decision from agent response.');
    console.error('[reconcile] Raw response (first 500 chars):', JSON.stringify(agentResponse).slice(0, 500));
    process.exit(3);
  }

  const planItems = [];

  for (const d of (decision.divergentMirrorDecisions || [])) {
    planItems.push({
      planType: 'divergent-mirror',
      key: d.key,
      canonicalNode: d.canonicalNode,
      retireNodes: d.retireNodes,
      ownerHostFolder: d.ownerHostFolder,
      isGenuineConflict: d.isGenuineConflict,
      reasoning: d.reasoning,
      action: 'PROPOSE: mark non-canonical copies superseded; sync canonical to owning host folder via git (human-applied)',
    });
  }

  for (const e of (decision.edgeDecisions || [])) {
    planItems.push({
      planType: 'dependency-edge',
      from: e.from,
      to: e.to,
      label: e.label,
      reasoning: e.reasoning,
      action: 'PROPOSE: add labeled edge to dependency graph',
    });
  }

  for (const o of (decision.outdatedDecisions || [])) {
    planItems.push({
      planType: 'outdated-record',
      recordId: o.recordId,
      verdict: o.verdict,
      supersededBy: o.supersededBy || null,
      reasoning: o.reasoning,
      action: (o.verdict === 'outdated' || o.verdict === 'superseded')
        ? 'PROPOSE: set validity=' + o.verdict + ' in frontmatter; set supersededBy if applicable (human-applied)'
        : 'no-action',
    });
  }

  planItems.push({
    planType: 'summary',
    summary: decision.summary || '(no summary from agent)',
    divergentMirrorCount: divergentMirrors.length,
    dependencyEdgeCount:  dependencyEdges.length,
    outdatedCandidateCount: outdatedCandidates.length,
    planItemCount: planItems.length,
  });

  writePlan(planItems);

  console.log('');
  console.log('[reconcile] Plan written to  : ' + PLAN_FILE);
  console.log('[reconcile] Plan items       : ' + planItems.length);
  console.log('[reconcile] Summary          : ' + (decision.summary || '(no summary)'));
  console.log('');
  console.log('[reconcile] IMPORTANT: This is a PLAN only. No memory files were modified.');
  console.log('[reconcile] Review the plan, then apply changes manually:');
  console.log('[reconcile]   1. For divergent-mirror: sync canonical to memory/<ownerHostFolder>/');
  console.log('[reconcile]      and git-commit (scoped to that folder only).');
  console.log('[reconcile]   2. For outdated/superseded: update record frontmatter (validity +');
  console.log('[reconcile]      supersededBy), then: node core/scripts/memory-map.js --snapshot');

  if (applyMode) {
    console.log('');
    console.log('[reconcile] --apply + MEMORY_RECONCILE_APPLY=on are set.');
    console.log('[reconcile] Apply automation is a future phase. Plan written; apply manually above.');
  }
})();
