#!/usr/bin/env node
/**
 * memory-map.js — deterministic cross-project/node memory map (records, two-level).
 *
 * The script the Haiku agent orchestrates (§7/§8 of the design doc): the LLM picks
 * filters, this prints the ACTUAL records — no LLM-generated memory content.
 *
 *   node core/scripts/memory-map.js [--level brief|complete] [--projects a,b]
 *        [--nodes windows-desk,linux-117] [--types project,reference] [--q query]
 *        [--since ms] [--limit N] [--record <id>] [--stats] [--format json|md] [--port 3100]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { loopbackAuthHeader } = require('./lib/loopback-auth');
const { extractRecords } = require(path.join(__dirname, '..', 'dist', 'memory', 'record-extract'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes('--' + k);
const list = (v) => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : null);

const level = opt('level', 'brief');
const fProjects = list(opt('projects'));
const fNodes = list(opt('nodes'));
const fTypes = list(opt('types'));
const fCats = list(opt('category'));
const fRefs = list(opt('references'));
const q = (opt('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
const since = parseInt(opt('since', '0'), 10);
const limit = parseInt(opt('limit', '0'), 10);
const wantRecord = opt('record');
const wantStats = has('stats');
const format = opt('format', wantRecord ? 'md' : 'json');
const port = opt('port', '3100');

function fetchProjects() {
  return new Promise((resolve) => {
    http.get(`http://localhost:${port}/memory/projects`, { headers: loopbackAuthHeader() }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).data || []); } catch { resolve([]); } });
    }).on('error', () => resolve([]));
  });
}

function resolveMyHostId(projectPath) {
  const hf = path.join(projectPath, 'memory', '_hosts.md');
  try {
    const txt = fs.readFileSync(hf, 'utf8');
    const ips = Object.values(os.networkInterfaces()).flat().filter(Boolean).map(n => n.address);
    for (const line of txt.split('\n')) {
      const id = (line.match(/`([a-z0-9-]+)`/) || [])[1] || (line.match(/^\|\s*([a-z0-9-]+)\s*\|/) || [])[1];
      if (id && ips.some(ip => line.includes(ip))) return id;
    }
  } catch {}
  return null;
}

function readDir(dir, node, source, project, out) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md') || e.name === '_hosts.md') continue;
    const fp = path.join(dir, e.name);
    let content, st; try { content = fs.readFileSync(fp, 'utf8'); st = fs.statSync(fp); } catch { continue; }
    try {
      out.push(...extractRecords({ node, project, source, filename: e.name, content, mtimeMs: st.mtimeMs, size: st.size }));
    } catch {}
  }
}

function claudeFilesIn(root, maxDepth) {
  const SKIP = new Set(['node_modules','.git','.next','dist','dist-test','.cache','coverage','.npm','ms-playwright-go']);
  const out = [];
  (function walk(dir, depth, rel){
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile() && (e.name === 'CLAUDE.md' || e.name === 'CLAUDE.local.md')) out.push(rel ? rel + '/' + e.name : e.name);
      else if (e.isDirectory() && depth < maxDepth && !SKIP.has(e.name) && (!e.name.startsWith('.') || e.name === '.claude') && !fs.existsSync(path.join(dir, e.name, '.git'))) walk(path.join(dir, e.name), depth + 1, rel ? rel + '/' + e.name : e.name);
    }
  })(root, 0, '');
  return out;
}

function projShort(p){ return (p.projectPath||"").split("/").filter(Boolean).pop() || p.projectId; }
function buildProjIndex(projects){ const idx=[]; for(const p of projects){ const s=projShort(p); if(!s||s==="ubuntu") continue; const markers=[s.toLowerCase()]; if(p.projectPath) markers.push(p.projectPath.toLowerCase()); idx.push({slug:p.projectId, short:s, markers}); } return idx; }
function isWord(c){ return !!c && ((c>="a"&&c<="z")||(c>="0"&&c<="9")||c==="-"); }
function mentions(hay,m){ let i=hay.indexOf(m); while(i>=0){ const b=i===0?"":hay[i-1]; const a=(i+m.length>=hay.length)?"":hay[i+m.length]; if(!isWord(b)&&!isWord(a)) return true; i=hay.indexOf(m,i+1);} return false; }
function computeRefs(r, idx){ const hay=(r.title+" "+(r.complete||r.brief||"")).toLowerCase(); const refs=new Set(); for(const p of idx){ for(const m of p.markers){ if(mentions(hay,m)){ refs.add(p.short); break; } } } if(refs.size===0){ const sp=idx.find(p=>p.slug===r.project); if(sp) refs.add(sp.short); } return Array.from(refs); }

async function collect() {
  const projects = await fetchProjects();
  const home = os.homedir();
  const liveNode = process.env.LM_HOST_ID || projects.map(function(p){return resolveMyHostId(p.projectPath || '');}).find(Boolean) || os.hostname();
  const recs = [];
  for (const gf of ['CLAUDE.md','CLAUDE.local.md']) {
    const gp = path.join(home, '.claude', gf);
    if (fs.existsSync(gp)) { const c=fs.readFileSync(gp,'utf8'); const st=fs.statSync(gp);
      recs.push(...extractRecords({ node: liveNode, project:'(user-global)', source:'live', filename:gf, content:c, mtimeMs:st.mtimeMs, size:st.size })); }
  }
  for (const p of projects) {
    const liveDir = path.join(home, '.claude', 'projects', p.projectId, 'memory');
    const myHost = liveNode;
    readDir(liveDir, myHost, 'live', p.projectId, recs);
    // CLAUDE.md (special) — index the project root instructions
    if (p.projectPath) {
      for (const rel of claudeFilesIn(p.projectPath, 2)) {
        const fpath = path.join(p.projectPath, rel);
        let c, st; try { c = fs.readFileSync(fpath,'utf8'); st = fs.statSync(fpath); } catch { continue; }
        recs.push(...extractRecords({ node: myHost, project: p.projectId, source: 'live', filename: rel, content: c, mtimeMs: st.mtimeMs, size: st.size }));
      }
      const repoBase = path.join(p.projectPath, 'memory');
      let hosts; try { hosts = fs.readdirSync(repoBase, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { hosts = []; }
      for (const h of hosts) readDir(path.join(repoBase, h), h, 'repo:' + h, p.projectId, recs);
    }
  }
  const _pidx = buildProjIndex(projects);
  for (const r of recs) r.referencedProjects = computeRefs(r, _pidx);
  return recs;
}

function match(r) {
  if (fProjects && !fProjects.some(x => r.project.includes(x))) return false;
  if (fNodes && !fNodes.includes(r.node)) return false;
  if (fTypes && !fTypes.includes(r.type)) return false;
  if (fCats && !fCats.includes(r.category)) return false;
  if (fRefs && !(r.referencedProjects||[]).some(x => fRefs.includes(x))) return false;
  if (since && r.recordedAtMs < since) return false;
  if (q.length) { const hay = (r.title + ' ' + r.brief + ' ' + r.complete).toLowerCase(); if (!q.every(t => hay.includes(t))) return false; }
  return true;
}

const SNAP = opt('snapshot-file', path.join(os.homedir(), '.lm-assist', 'memory-map.json'));
const CHLOG = path.join(os.homedir(), '.lm-assist', 'memory-changes.jsonl');
function snapKey(r){ return { contentHash: r.contentHash, title: r.title, node: r.node, project: r.project, file: r.file, category: r.category, recordedAtMs: r.recordedAtMs }; }
function loadSnap(){ try { return JSON.parse(fs.readFileSync(SNAP,'utf8')); } catch { return {}; } }
function writeSnap(recs){ const m={}; for(const r of recs) m[r.recordId]=snapKey(r); fs.mkdirSync(path.dirname(SNAP),{recursive:true}); fs.writeFileSync(SNAP, JSON.stringify(m)); return Object.keys(m).length; }
function diffSnap(prev, recs){ const cur={}; for(const r of recs) cur[r.recordId]=r; const added=[],modified=[],removed=[]; for(const id in cur){ if(!prev[id]) added.push(cur[id]); else if(prev[id].contentHash!==cur[id].contentHash) modified.push(cur[id]); } for(const id in prev){ if(!cur[id]) removed.push(Object.assign({recordId:id}, prev[id])); } return {added,modified,removed}; }
function appendLog(obj){ fs.appendFileSync(CHLOG, JSON.stringify(obj) + String.fromCharCode(10)); }

(async () => {
  let recs = (await collect()).filter(match);
  recs.sort((a, b) => b.recordedAtMs - a.recordedAtMs);
  if (has('duplicates')) {
    const byFile = {};
    for (const r of recs) { if (r.kind !== 'memory') continue; const k = r.project + '::' + r.file; (byFile[k] = byFile[k] || []).push(r); }
    const divergent = Object.keys(byFile).map(function(k){ return [k, byFile[k]]; })
      .filter(function(e){ return new Set(e[1].map(function(r){return r.contentHash;})).size > 1; })
      .map(function(e){ return { key: e[0], nodes: e[1].map(function(r){ return { node: r.node, source: r.source, hash: r.contentHash.slice(0,10), recordedAtMs: r.recordedAtMs }; }) }; });
    const byHash = {}; for (const r of recs) (byHash[r.contentHash] = byHash[r.contentHash] || []).push(r);
    const exact = Object.keys(byHash).map(function(h){return byHash[h];}).filter(function(g){return g.length>1;}).length;
    console.log(JSON.stringify({ exactDuplicateClusters: exact, divergentMirrorCount: divergent.length, divergentMirrors: divergent.slice(0,20) }, null, 2));
    return;
  }
  if (has('snapshot')) { const n=writeSnap(recs); console.log(JSON.stringify({snapshot:SNAP,records:n})); return; }
  if (has('changes')) {
    const d=diffSnap(loadSnap(), recs);
    if (has('commit')) { const ts=String(Date.now());
      for(const r of d.added) appendLog({t:ts,op:'add',id:r.recordId,title:r.title,node:r.node,category:r.category});
      for(const r of d.modified) appendLog({t:ts,op:'mod',id:r.recordId,title:r.title,node:r.node});
      for(const r of d.removed) appendLog({t:ts,op:'del',id:r.recordId});
      writeSnap(recs); }
    console.log(JSON.stringify({ added:d.added.length, modified:d.modified.length, removed:d.removed.length,
      addedRecords:d.added.map(function(r){return {id:r.recordId,title:r.title,node:r.node,category:r.category};}),
      modifiedRecords:d.modified.map(function(r){return {id:r.recordId,title:r.title};}),
      removedRecords:d.removed.map(function(r){return r.recordId;}) }, null, 2));
    return;
  }

  if (wantRecord) {
    const r = recs.find(x => x.recordId === wantRecord) || (await collect()).find(x => x.recordId === wantRecord);
    if (!r) { console.error('record not found: ' + wantRecord); process.exit(2); }
    if (format === 'json') console.log(JSON.stringify(r, null, 2));
    else console.log(`# ${r.title}\n\n_${r.node} · ${r.project} · ${r.file}${r.anchor ? '#' + r.anchor : ''} · ${r.type}${r.originSessionId ? ' · session ' + r.originSessionId : ''}_\n\n${r.complete}`);
    return;
  }

  if (wantStats) {
    const by = (k) => recs.reduce((m, r) => (m[r[k]] = (m[r[k]] || 0) + 1, m), {});
    console.log(JSON.stringify({ total: recs.length, byProject: by('project'), byNode: by('node'), byType: by('type'), byCategory: by('category'), byKind: by('kind'), byReferencedProject: recs.reduce((m,r)=>{(r.referencedProjects||[]).forEach(p=>{m[p]=(m[p]||0)+1;});return m;},{}) }, null, 2));
    return;
  }

  if (limit) recs = recs.slice(0, limit);

  if (format === 'json') {
    console.log(JSON.stringify(recs.map(r => level === 'complete' ? r : { recordId: r.recordId, node: r.node, project: r.project, file: r.file, kind: r.kind, title: r.title, brief: r.brief, type: r.type, category: r.category, validity: r.validity, referencedProjects: r.referencedProjects, recordedAtMs: r.recordedAtMs }), null, 2));
  } else {
    for (const r of recs) {
      if (level === 'complete') console.log(`## ${r.title}\n_${r.node} · ${r.project} · ${r.file} · ${r.type}_\n\n${r.complete}\n`);
      else console.log(`- [${r.category}] ${r.title} — ${r.brief}  \`(${r.node}:${r.project}:${r.file})\``);
    }
  }
})();
