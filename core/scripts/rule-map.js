#!/usr/bin/env node
/**
 * rule-map.js — deterministic cross-project/node RULES map (records, two-level).
 *
 * The sibling of core/scripts/memory-map.js, but for Claude Code RULES
 * (`.claude/rules/**.md`, USER + PROJECT scope) instead of auto-memory. The LLM
 * orchestrator picks filters; this prints the ACTUAL rule records — no
 * LLM-generated content. See docs/plans/2026-06-06-rules-map-and-sync.md
 *
 *   node core/scripts/rule-map.js [--level brief|complete] [--projects a,b]
 *        [--nodes windows-desk,linux-117] [--category lesson,config]
 *        [--scope user|project] [--paths <glob-substr>] [--always]
 *        [--os <plat>] [--os-dependent] [--active]
 *        [--q query] [--limit N] [--record <id>] [--stats]
 *        [--snapshot] [--changes [--commit]] [--duplicates]
 *        [--format json|md] [--port 3100]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { loopbackAuthHeader } = require('./lib/loopback-auth');
const { extractRule, normalizeOsList } = require(path.join(__dirname, '..', 'dist', 'rules', 'rule-extract'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes('--' + k);
const list = (v) => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : null);

const level = opt('level', 'brief');
const fProjects = list(opt('projects'));
const fNodes = list(opt('nodes'));
const fCats = list(opt('category'));
const fScope = opt('scope');                       // 'user' | 'project'
const fPaths = (opt('paths') || '').toLowerCase(); // substring match against any glob
const fAlways = has('always');                     // loadCondition === 'always'
let fOs = opt('os');                               // platform filter (friendly or canonical)
if (fOs) { try { fOs = normalizeOsList([fOs])[0]; } catch {} }
const fOsDependent = has('os-dependent');
const fActive = has('active');
const q = (opt('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
const limit = parseInt(opt('limit', '0'), 10);
// See memory-map.js for why these exist and why they are additive: the default
// (no `--meta`) output shape is unchanged for the REST route and the web UI.
const offset = Math.max(0, parseInt(opt('offset', '0'), 10) || 0);
const wantMeta = has('meta');
const wantRecord = opt('record');
const wantStats = has('stats');
const format = opt('format', wantRecord ? 'md' : 'json');
const port = opt('port', '3100');

const USER_PROJECT = '(user)';

function fetchProjects() {
  return new Promise((resolve) => {
    http.get(`http://localhost:${port}/memory/projects`, { headers: loopbackAuthHeader() }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).data || []); } catch { resolve([]); } });
    }).on('error', () => resolve([]));
  });
}

function resolveMyHostId(projectPath) {
  if (process.env.LM_HOST_ID) return process.env.LM_HOST_ID;
  const hf = path.join(projectPath, 'memory', '_hosts.md');
  try {
    const txt = fs.readFileSync(hf, 'utf8');
    const ips = Object.values(os.networkInterfaces()).flat().filter(Boolean).map(n => n.address);
    for (const line of txt.split('\n')) {
      const id = (line.match(/`([a-z0-9-]+)`/) || [])[1] || (line.match(/^\|\s*([a-z0-9-]+)\s*\|/) || [])[1];
      if (id && ips.some(ip => line.includes(ip))) return id;
    }
  } catch {}
  return os.hostname();
}

/** Recursively walk a .claude/rules dir, emitting one record per .md file. */
function readRulesDir(rootDir, node, source, project, scope, out, opts) {
  const walk = (dir) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp); continue; }
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      let content, st; try { content = fs.readFileSync(fp, 'utf8'); st = fs.statSync(fp); } catch { continue; }
      const relpath = path.relative(rootDir, fp).split(path.sep).join('/');
      let rec;
      try { rec = extractRule({ node, project, source, scope, relpath, content, mtimeMs: st.mtimeMs, size: st.size }); } catch { continue; }
      if (opts && opts.detectSynced) {
        const m = path.basename(relpath).match(/^synced\.([A-Za-z0-9_-]+)\.(.+)$/);
        if (m) { rec = Object.assign({}, rec, { node: m[1], source: 'repo:' + m[1] }); }
      }
      if (opts && opts.forceInactive) rec = Object.assign({}, rec, { active: false });
      out.push(rec);
    }
  };
  walk(rootDir);
}

async function collect() {
  const projects = await fetchProjects();
  const home = os.homedir();
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const dataDir = process.env.LM_ASSIST_DATA_DIR || path.join(home, '.lm-assist');
  const recs = [];
  // USER rules — machine-wide, apply to every project on this node.
  const myHost = resolveMyHostId((projects[0] && projects[0].projectPath) || '');
  readRulesDir(path.join(claudeDir, 'rules'), myHost, 'live', USER_PROJECT, 'user', recs, { detectSynced: true });
  // PROJECT rules — per project, committed under <projectRoot>/.claude/rules.
  for (const p of projects) {
    if (!p.projectPath) continue;
    const host = resolveMyHostId(p.projectPath);
    readRulesDir(path.join(p.projectPath, '.claude', 'rules'), host, 'live', p.projectId, 'project', recs);
    // Cross-node repo mirrors of project rules, if a memory/<host>/.claude/rules exists.
    const repoBase = path.join(p.projectPath, 'memory');
    let hosts; try { hosts = fs.readdirSync(repoBase, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { hosts = []; }
    for (const h of hosts) {
      readRulesDir(path.join(repoBase, h, '.claude', 'rules'), h, 'repo:' + h, p.projectId, 'project', recs);
    }
  }
  // Inert mirror of wrong-OS synced rules — rules-mirror/<host>/*.md (active:false, source repo:<host>).
  const mirrorRoot = path.join(dataDir, 'rules-mirror');
  let mhosts; try { mhosts = fs.readdirSync(mirrorRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { mhosts = []; }
  for (const h of mhosts) {
    readRulesDir(path.join(mirrorRoot, h), h, 'repo:' + h, USER_PROJECT, 'user', recs, { forceInactive: true });
  }
  return recs;
}

function match(r) {
  if (fProjects && !fProjects.some(x => r.project.includes(x))) return false;
  if (fNodes && !fNodes.includes(r.node)) return false;
  if (fCats && !fCats.includes(r.category)) return false;
  if (fScope && r.scope !== fScope) return false;
  if (fAlways && r.loadCondition !== 'always') return false;
  if (fPaths && !(r.paths || []).some(g => g.toLowerCase().includes(fPaths))) return false;
  if (q.length) { const hay = (r.title + ' ' + r.brief + ' ' + r.complete + ' ' + (r.paths || []).join(' ')).toLowerCase(); if (!q.every(t => hay.includes(t))) return false; }
  if (fOs && !((r.os || []).length === 0 || (r.os || []).includes(fOs))) return false;
  if (fOsDependent && !r.osDependent) return false;
  if (fActive && !r.active) return false;
  return true;
}

const SNAP = opt('snapshot-file', path.join(os.homedir(), '.lm-assist', 'rule-map.json'));
const CHLOG = path.join(os.homedir(), '.lm-assist', 'rule-changes.jsonl');
function snapKey(r){ return { contentHash: r.contentHash, title: r.title, node: r.node, project: r.project, scope: r.scope, file: r.file, category: r.category, loadCondition: r.loadCondition, recordedAtMs: r.recordedAtMs }; }
function loadSnap(){ try { return JSON.parse(fs.readFileSync(SNAP,'utf8')); } catch { return {}; } }
function writeSnap(recs){ const m={}; for(const r of recs) m[r.recordId]=snapKey(r); fs.mkdirSync(path.dirname(SNAP),{recursive:true}); fs.writeFileSync(SNAP, JSON.stringify(m)); return Object.keys(m).length; }
function diffSnap(prev, recs){ const cur={}; for(const r of recs) cur[r.recordId]=r; const added=[],modified=[],removed=[]; for(const id in cur){ if(!prev[id]) added.push(cur[id]); else if(prev[id].contentHash!==cur[id].contentHash) modified.push(cur[id]); } for(const id in prev){ if(!cur[id]) removed.push(Object.assign({recordId:id}, prev[id])); } return {added,modified,removed}; }
function appendLog(obj){ fs.appendFileSync(CHLOG, JSON.stringify(obj) + String.fromCharCode(10)); }

(async () => {
  let recs = (await collect()).filter(match);
  recs.sort((a, b) => b.recordedAtMs - a.recordedAtMs);

  if (has('duplicates')) {
    // Same rule mirrored across nodes that diverged (project rules in repo mirrors),
    // plus user-vs-project CONFLICTS: a path-scope or title overlap across scopes.
    const byKey = {};
    for (const r of recs) { const k = r.project + '::' + r.scope + '::' + r.file; (byKey[k] = byKey[k] || []).push(r); }
    const divergent = Object.keys(byKey).map(function(k){ return [k, byKey[k]]; })
      .filter(function(e){ return new Set(e[1].map(function(r){return r.contentHash;})).size > 1; })
      .map(function(e){ return { key: e[0], nodes: e[1].map(function(r){ return { node: r.node, source: r.source, hash: r.contentHash.slice(0,10), recordedAtMs: r.recordedAtMs }; }) }; });
    const byHash = {}; for (const r of recs) (byHash[r.contentHash] = byHash[r.contentHash] || []).push(r);
    const exact = Object.keys(byHash).map(function(h){return byHash[h];}).filter(function(g){return g.length>1;}).length;
    // user-vs-project conflict candidates: same title (case-insensitive) present at both scopes.
    const byTitle = {};
    for (const r of recs) { const k = r.title.toLowerCase().trim(); (byTitle[k] = byTitle[k] || []).push(r); }
    const conflicts = Object.keys(byTitle).map(function(k){return byTitle[k];})
      .filter(function(g){ const scopes = new Set(g.map(function(r){return r.scope;})); return scopes.has('user') && scopes.has('project'); })
      .map(function(g){ return { title: g[0].title, scopes: g.map(function(r){ return { scope: r.scope, project: r.project, node: r.node, winsOnConflict: r.scope === 'project' }; }) }; });
    console.log(JSON.stringify({ exactDuplicateClusters: exact, divergentMirrorCount: divergent.length, divergentMirrors: divergent.slice(0,20), userVsProjectConflicts: conflicts.slice(0,20) }, null, 2));
    return;
  }

  if (has('snapshot')) { const n=writeSnap(recs); console.log(JSON.stringify({snapshot:SNAP,records:n})); return; }
  if (has('changes')) {
    const d=diffSnap(loadSnap(), recs);
    if (has('commit')) { const ts=String(Date.now());
      for(const r of d.added) appendLog({t:ts,op:'add',id:r.recordId,title:r.title,node:r.node,scope:r.scope,category:r.category,loadCondition:r.loadCondition});
      for(const r of d.modified) appendLog({t:ts,op:'mod',id:r.recordId,title:r.title});
      for(const r of d.removed) appendLog({t:ts,op:'del',id:r.recordId});
      writeSnap(recs); }
    console.log(JSON.stringify({ added:d.added.length, modified:d.modified.length, removed:d.removed.length,
      addedRecords:d.added.map(function(r){return {id:r.recordId,title:r.title,node:r.node,scope:r.scope,loadCondition:r.loadCondition};}),
      modifiedRecords:d.modified.map(function(r){return {id:r.recordId,title:r.title};}),
      removedRecords:d.removed.map(function(r){return r.recordId;}) }, null, 2));
    return;
  }

  if (wantRecord) {
    const r = recs.find(x => x.recordId === wantRecord) || (await collect()).find(x => x.recordId === wantRecord);
    if (!r) { console.error('record not found: ' + wantRecord); process.exit(2); }
    if (format === 'json') console.log(JSON.stringify(r, null, 2));
    else {
      const cond = r.loadCondition === 'always' ? 'always-on' : 'path-scoped: ' + r.paths.join(', ');
      console.log(`# ${r.title}\n\n_${r.node} · ${r.scope} · ${r.project} · ${r.file} · ${cond}${r.originSessionId ? ' · session ' + r.originSessionId : ''}_\n\n${r.complete}`);
    }
    return;
  }

  if (wantStats) {
    const by = (k) => recs.reduce((m, r) => (m[r[k]] = (m[r[k]] || 0) + 1, m), {});
    console.log(JSON.stringify({ total: recs.length, byProject: by('project'), byNode: by('node'), byScope: by('scope'), byLoadCondition: by('loadCondition'), byCategory: by('category'), active: recs.filter(r => r.active).length, osDependent: recs.filter(r => r.osDependent).length }, null, 2));
    return;
  }

  const total = recs.length;
  recs = recs.slice(offset, limit ? offset + limit : undefined);

  if (format === 'json') {
    const rows = recs.map(r => level === 'complete' ? r : { recordId: r.recordId, node: r.node, project: r.project, source: r.source, scope: r.scope, file: r.file, title: r.title, brief: r.brief, category: r.category, loadCondition: r.loadCondition, paths: r.paths, os: r.os, osDependent: r.osDependent, active: r.active, recordedAtMs: r.recordedAtMs });
    console.log(JSON.stringify(wantMeta ? { total, shown: rows.length, offset, limit, records: rows } : rows, null, 2));
  } else {
    for (const r of recs) {
      const cond = r.loadCondition === 'always' ? 'always' : 'paths:' + r.paths.join('|');
      if (level === 'complete') console.log(`## ${r.title}\n_${r.node} · ${r.scope} · ${r.project} · ${r.file} · ${cond}_\n\n${r.complete}\n`);
      else console.log(`- [${r.category}/${r.scope}/${cond}] ${r.title} — ${r.brief}  \`(${r.node}:${r.project}:${r.file})\``);
    }
  }
})();
