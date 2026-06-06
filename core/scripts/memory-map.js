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
const q = (opt('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
const since = parseInt(opt('since', '0'), 10);
const limit = parseInt(opt('limit', '0'), 10);
const wantRecord = opt('record');
const wantStats = has('stats');
const format = opt('format', wantRecord ? 'md' : 'json');
const port = opt('port', '3100');

function fetchProjects() {
  return new Promise((resolve) => {
    http.get(`http://localhost:${port}/memory/projects`, (res) => {
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
  return os.hostname();
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

async function collect() {
  const projects = await fetchProjects();
  const home = os.homedir();
  const recs = [];
  for (const p of projects) {
    const liveDir = path.join(home, '.claude', 'projects', p.projectId, 'memory');
    const myHost = resolveMyHostId(p.projectPath || '');
    readDir(liveDir, myHost, 'live', p.projectId, recs);
    // CLAUDE.md (special) — index the project root instructions
    if (p.projectPath) {
      const claude = path.join(p.projectPath, 'CLAUDE.md');
      if (fs.existsSync(claude)) {
        const c = fs.readFileSync(claude, 'utf8'); const st = fs.statSync(claude);
        recs.push(...extractRecords({ node: myHost, project: p.projectId, source: 'live', filename: 'CLAUDE.md', content: c, mtimeMs: st.mtimeMs, size: st.size }));
      }
      const repoBase = path.join(p.projectPath, 'memory');
      let hosts; try { hosts = fs.readdirSync(repoBase, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { hosts = []; }
      for (const h of hosts) readDir(path.join(repoBase, h), h, 'repo:' + h, p.projectId, recs);
    }
  }
  return recs;
}

function match(r) {
  if (fProjects && !fProjects.some(x => r.project.includes(x))) return false;
  if (fNodes && !fNodes.includes(r.node)) return false;
  if (fTypes && !fTypes.includes(r.type)) return false;
  if (fCats && !fCats.includes(r.category)) return false;
  if (since && r.recordedAtMs < since) return false;
  if (q.length) { const hay = (r.title + ' ' + r.brief + ' ' + r.complete).toLowerCase(); if (!q.every(t => hay.includes(t))) return false; }
  return true;
}

(async () => {
  let recs = (await collect()).filter(match);
  recs.sort((a, b) => b.recordedAtMs - a.recordedAtMs);

  if (wantRecord) {
    const r = recs.find(x => x.recordId === wantRecord) || (await collect()).find(x => x.recordId === wantRecord);
    if (!r) { console.error('record not found: ' + wantRecord); process.exit(2); }
    if (format === 'json') console.log(JSON.stringify(r, null, 2));
    else console.log(`# ${r.title}\n\n_${r.node} · ${r.project} · ${r.file}${r.anchor ? '#' + r.anchor : ''} · ${r.type}${r.originSessionId ? ' · session ' + r.originSessionId : ''}_\n\n${r.complete}`);
    return;
  }

  if (wantStats) {
    const by = (k) => recs.reduce((m, r) => (m[r[k]] = (m[r[k]] || 0) + 1, m), {});
    console.log(JSON.stringify({ total: recs.length, byProject: by('project'), byNode: by('node'), byType: by('type'), byCategory: by('category'), byKind: by('kind') }, null, 2));
    return;
  }

  if (limit) recs = recs.slice(0, limit);

  if (format === 'json') {
    console.log(JSON.stringify(recs.map(r => level === 'complete' ? r : { recordId: r.recordId, node: r.node, project: r.project, file: r.file, title: r.title, brief: r.brief, type: r.type, category: r.category, validity: r.validity, recordedAtMs: r.recordedAtMs }), null, 2));
  } else {
    for (const r of recs) {
      if (level === 'complete') console.log(`## ${r.title}\n_${r.node} · ${r.project} · ${r.file} · ${r.type}_\n\n${r.complete}\n`);
      else console.log(`- [${r.category}] ${r.title} — ${r.brief}  \`(${r.node}:${r.project}:${r.file})\``);
    }
  }
})();
