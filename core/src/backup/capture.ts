/**
 * The five capture targets.
 *
 * Ported from `backup-claude.ps1` on 107, with three deliberate changes:
 *
 *  1. THE LOCAL MIRROR IS A NODE WALK, NOT `robocopy /MIR`. Not for portability
 *     — the collector is Windows either way — but because the tree has to be
 *     walked to index it, and robocopy would mean walking twice. It also fixes
 *     a real hole: `robocopy /XF` is NOT retroactive, so an excluded secret
 *     already in the destination is neither copied nor deleted, it just stays.
 *     This mirror removes what it excludes, so adding an exclusion cleans.
 *  2. SECRETS ARE FILTERED AT CAPTURE (see secrets.ts).
 *  3. EVERY TARGET FEEDS THE INDEX in the same pass that writes it.
 *
 * Retention, the `status.json` shape, the tar-verify step and the claude.ai
 * incremental manifest are all inherited unchanged — they worked.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { BackupConfig, RemoteTarget, TargetName } from './config';
import { REMOTE_TARGETS, targetDir, storePaths } from './config';
import { excludeReason, tarExcludeArgs } from './secrets';
import { BackupIndex, itemId, type IndexItem, type ItemKind } from './search-index';
import { containedPath, readTarGz, safeMemberPath } from './tar-reader';
import {
  appendHistory, readExcludes, isUserExcluded, runStamp, stamp,
  type TargetStatus,
} from './store';

/** Per-item indexed text ceiling — keeps one huge file from dominating the index. */
const MAX_INDEX_TEXT = 64 * 1024;

export interface CaptureResult extends TargetStatus {
  secretsExcluded: number;
  indexedRows: number;
}

// ------------------------------------------------------------- classification

/** What a `.claude`-relative path is, for search filtering. */
export function classify(rel: string): { kind: ItemKind; project: string; title: string } {
  const p = rel.replace(/\\/g, '/');
  const base = path.posix.basename(p);
  let project = '';
  const proj = /^projects\/([^/]+)\//.exec(p);
  if (proj) project = proj[1];

  if (/^projects\/[^/]+\/memory\/.+\.md$/i.test(p)) return { kind: 'memory', project, title: base };
  if (/^rules\/.+\.md$/i.test(p)) return { kind: 'rule', project, title: base };
  if (/^projects\/[^/]+\/[^/]+\.jsonl$/i.test(p)) return { kind: 'session', project, title: base };
  return { kind: 'file', project, title: base };
}

/** Does this path carry text worth indexing? Metadata-only otherwise. */
export function carriesText(rel: string): boolean {
  const k = classify(rel).kind;
  return k === 'memory' || k === 'rule' || k === 'session';
}

/**
 * Text of a Claude Code session for the index: user prompts and assistant
 * prose only.
 *
 * Tool payloads are the bulk of a session file and of the 90,414 entries in the
 * 117 snapshot. Indexing them would inflate the index toward the size of the
 * backup and bury real hits under base64 and file dumps — you would search for
 * a decision and find the diff that followed it.
 */
export function sessionText(raw: string, cap = MAX_INDEX_TEXT): string {
  const out: string[] = [];
  let len = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim() || len > cap) break;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj?.message;
    const role = msg?.role ?? obj?.type;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = msg?.content;
    const parts: string[] = [];
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const c of content) if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    }
    for (const t of parts) {
      if (len > cap) break;
      out.push(t);
      len += t.length;
    }
  }
  return out.join('\n').slice(0, cap);
}

/** Text of a backed-up claude.ai conversation JSON, incl. attachment contents. */
export function conversationText(raw: string, cap = MAX_INDEX_TEXT): string {
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return ''; }
  const out: string[] = [];
  for (const m of obj?.chat_messages ?? []) {
    if (typeof m?.text === 'string') out.push(m.text);
    for (const c of m?.content ?? []) if (typeof c?.text === 'string') out.push(c.text);
    // ".md files inside the conversation" live here, not as separate blobs.
    for (const a of m?.attachments ?? []) {
      if (typeof a?.extracted_content === 'string') out.push(a.extracted_content);
    }
    if (out.join('\n').length > cap) break;
  }
  return out.join('\n').slice(0, cap);
}

function indexTextFor(rel: string, raw: string): string {
  const kind = classify(rel).kind;
  if (kind === 'session') return sessionText(raw);
  return raw.slice(0, MAX_INDEX_TEXT);
}

// -------------------------------------------------------------- local mirror

interface MirrorStats { files: number; bytes: number; excluded: number; indexed: number }

/**
 * Mirror `src` → `dst`, applying the deny-list and the user exclusion list, and
 * indexing as it goes. Extra files in `dst` (including ones that became
 * excluded) are deleted — that is what makes an exclusion clean the store.
 */
function mirrorTree(
  src: string, dst: string, source: string,
  index: BackupIndex | null, userExcludes: string[],
): MirrorStats {
  const st: MirrorStats = { files: 0, bytes: 0, excluded: 0, indexed: 0 };
  const keep = new Set<string>();
  const batch: IndexItem[] = [];

  const walk = (relDir: string): void => {
    const absSrc = path.join(src, relDir);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(absSrc, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const reason = excludeReason(rel, path.join(src, rel));
      if (reason || isUserExcluded(userExcludes, rel)) { st.excluded++; continue; }
      if (e.isSymbolicLink()) continue;          // never follow links out of the tree
      if (e.isDirectory()) { walk(rel); continue; }
      if (!e.isFile()) continue;

      keep.add(rel);
      const from = path.join(src, rel);
      const to = path.join(dst, rel);
      let s: fs.Stats;
      try { s = fs.statSync(from); } catch { continue; }

      let needCopy = true;
      try {
        const d = fs.statSync(to);
        needCopy = d.size !== s.size || Math.floor(d.mtimeMs) !== Math.floor(s.mtimeMs);
      } catch { /* absent — copy */ }

      if (needCopy) {
        try {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
          fs.utimesSync(to, s.atime, s.mtime);
        } catch { continue; }        // locked by a live Chrome/session — next run gets it
      }
      st.files++; st.bytes += s.size;

      if (index) {
        const { kind, project, title } = classify(rel);
        let text = '';
        if (carriesText(rel) && s.size <= 4 * 1024 * 1024) {
          try { text = indexTextFor(rel, fs.readFileSync(from, 'utf-8')); } catch { /* binary */ }
        }
        batch.push({
          id: itemId(source, '', rel), kind, source, store: 'mirror', project, path: rel,
          container: '', member: '', title, mtime: s.mtimeMs, size: s.size, text,
        });
      }
    }
  };
  walk('');

  // Mirror semantics: drop destination files the source no longer offers.
  const prune = (relDir: string): void => {
    const absDst = path.join(dst, relDir);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(absDst, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) { prune(rel); continue; }
      if (!keep.has(rel)) {
        try { fs.rmSync(path.join(dst, rel), { force: true }); } catch { /* ignore */ }
        if (index) index.deleteItem(itemId(source, '', rel));
      }
    }
  };
  prune('');

  if (index && batch.length) st.indexed = index.upsertMany(batch);
  return st;
}

export function captureLocal(cfg: BackupConfig, index: BackupIndex | null): CaptureResult {
  const dst = path.join(targetDir(cfg, 'windows-desk'), '.claude');
  fs.mkdirSync(dst, { recursive: true });
  const st = mirrorTree(cfg.localSource, dst, 'windows-desk', index, readExcludes(cfg));
  return {
    method: 'node mirror (secret-filtered)',
    source: cfg.localSource,
    target: dst,
    lastRun: stamp(),
    result: 'ok',
    detail: `${st.files} files copied/verified, ${st.excluded} excluded by policy`,
    sizeMB: Math.round((st.bytes / 1048576) * 10) / 10,
    items: st.files,
    secretsExcluded: st.excluded,
    indexedRows: st.indexed,
  };
}

// ------------------------------------------------------------ remote snapshot

function sshTarToFile(r: RemoteTarget, outFile: string): Promise<number> {
  return new Promise((resolve) => {
    const remote = `tar czf - ${tarExcludeArgs().join(' ')} -C ${r.home} .claude`;
    const out = fs.createWriteStream(outFile);
    const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', r.sshHost, remote], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    p.stdout.pipe(out);
    // GNU tar exits 1 for "file changed as we read it" — expected while sessions
    // are live on the remote host, and NOT a failure.
    p.on('close', (code) => out.end(() => resolve(code ?? 255)));
    p.on('error', () => out.end(() => resolve(255)));
  });
}

export async function captureRemote(
  cfg: BackupConfig, r: RemoteTarget, index: BackupIndex | null,
): Promise<CaptureResult> {
  const dir = targetDir(cfg, r.name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `claude-${runStamp()}.tar.gz`);
  const code = await sshTarToFile(r, file);

  let sizeMB = 0;
  try { sizeMB = Math.round((fs.statSync(file).size / 1048576) * 10) / 10; } catch { /* absent */ }

  if (sizeMB === 0 || code > 1) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    return {
      method: 'ssh tar.gz snapshot', source: `${r.sshHost}:${r.home}/.claude`, target: file,
      lastRun: stamp(), result: 'FAILED', detail: `ssh/tar exit ${code}, ${sizeMB} MB written`,
      sizeMB, items: 0, secretsExcluded: 0, indexedRows: 0,
    };
  }

  // Verify by walking it — the same pass that builds the index, so the archive
  // is proven readable end-to-end rather than merely non-empty.
  const { items, indexed, excluded } = await indexSnapshot(cfg, r.name, file, index);

  // Retention: newest N snapshots. Names sort chronologically by construction.
  const kept = fs.readdirSync(dir).filter((f) => /^claude-.*\.tar\.gz$/.test(f)).sort().reverse();
  for (const old of kept.slice(cfg.keepSnapshots)) {
    try {
      fs.rmSync(path.join(dir, old), { force: true });
      if (index) index.dropContainer(old);
      appendHistory(cfg, `${r.name} retention: removed ${old}`);
    } catch { /* ignore */ }
  }

  return {
    method: 'ssh tar.gz snapshot',
    source: `${r.sshHost}:${r.home}/.claude`,
    target: file,
    lastRun: stamp(),
    result: code === 1 ? 'ok (tar warned: files changed during read)' : 'ok',
    detail: `verified ${items} entries, indexed ${indexed}, ${excluded} excluded by policy`,
    sizeMB, items, secretsExcluded: excluded, indexedRows: indexed,
  };
}

/**
 * Stream a snapshot to verify + index it. Reads from local disk, so re-indexing
 * an archive captured by the PowerShell era costs no network — which is how the
 * 4.7 GB already on E: becomes searchable without re-downloading anything.
 */
export async function indexSnapshot(
  cfg: BackupConfig, source: TargetName, file: string, index: BackupIndex | null,
): Promise<{ items: number; indexed: number; excluded: number }> {
  const container = path.basename(file);
  const userExcludes = readExcludes(cfg);
  if (index) index.dropContainer(container);

  let items = 0, excluded = 0;
  const batch: IndexItem[] = [];
  const want = (e: { name: string }) => {
    const rel = e.name.replace(/^\.claude\//, '');
    return carriesText(rel);
  };

  for await (const { entry, content } of readTarGz(file, want)) {
    if (entry.type !== '0') continue;
    items++;
    // A member name that would be unsafe to EXTRACT is unsafe to RECORD: the
    // index feeds backup_read and backup_remove, so a poisoned name would come
    // back as a path later. Validate once, here, at the point of entry.
    const safe = safeMemberPath(entry.name);
    if (!safe) { excluded++; continue; }
    const rel = safe.replace(/^\.claude\//, '');
    if (excludeReason(rel) || isUserExcluded(userExcludes, rel)) { excluded++; continue; }
    if (!index) continue;
    const { kind, project, title } = classify(rel);
    let text = '';
    if (content) { try { text = indexTextFor(rel, content.toString('utf-8')); } catch { /* binary */ } }
    batch.push({
      id: itemId(source, container, entry.name), kind, source, store: 'snapshot', project,
      path: rel, container, member: entry.name, title, mtime: entry.mtime, size: entry.size, text,
    });
    if (batch.length >= 2000) { index.upsertMany(batch); batch.length = 0; }
  }
  const indexed = index && batch.length ? index.upsertMany(batch) : 0;
  return { items, indexed, excluded };
}

// ------------------------------------------------------------------ claude.ai

async function lmFetch(cfg: BackupConfig, route: string, token: string, timeoutMs = 60000): Promise<any> {
  const res = await fetch(`${cfg.claudeAiBaseUrl}${route}`, {
    headers: { 'x-api-key': token },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${route} → HTTP ${res.status}`);
  return res.json();
}

export async function captureClaudeAi(
  cfg: BackupConfig, index: BackupIndex | null, skipBlobs: boolean,
): Promise<CaptureResult> {
  const dir = targetDir(cfg, 'claudeai');
  const convDir = path.join(dir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  const manPath = path.join(dir, '_manifest.json');
  const base: Omit<CaptureResult, 'result' | 'detail'> = {
    method: 'lm-assist claude.ai', source: `${cfg.claudeAiBaseUrl}/claude-ai/conversations`,
    target: convDir, lastRun: stamp(), sizeMB: 0, items: 0, secretsExcluded: 0, indexedRows: 0,
  };

  let token = '';
  try {
    token = fs.readFileSync(path.join(require('os').homedir(), '.lm-assist', 'api-token'), 'utf-8').trim();
  } catch {
    return { ...base, result: 'FAILED (no api-token)', detail: 'missing ~/.lm-assist/api-token' };
  }

  try {
    const hz = await lmFetch(cfg, '/claude-ai/healthz', token, 20000);
    if (!hz?.data?.ok) {
      return { ...base, result: `FAILED (session ${hz?.data?.reason ?? 'invalid'})`, detail: hz?.data?.hint ?? '' };
    }
  } catch (e) {
    return { ...base, result: 'FAILED (lm-assist unreachable)', detail: e instanceof Error ? e.message : String(e) };
  }

  // refresh=true forces a full pull; without it the cached view is reduced.
  let list: any[] = [];
  try {
    const lr = await lmFetch(cfg, '/claude-ai/conversations?limit=1000&refresh=true', token, 90000);
    list = Array.isArray(lr?.data?.data) ? lr.data.data : Array.isArray(lr?.data) ? lr.data : [];
  } catch (e) {
    return { ...base, result: 'FAILED (list error)', detail: e instanceof Error ? e.message : String(e) };
  }

  let prev: Record<string, string> = {};
  try { prev = JSON.parse(fs.readFileSync(manPath, 'utf-8').replace(/^﻿/, '')); } catch { /* first run */ }

  const manifest: Record<string, string> = {};
  let fetched = 0, skipped = 0, failed = 0;
  const batch: IndexItem[] = [];

  for (const c of list) {
    const file = path.join(convDir, `${c.uuid}.json`);
    manifest[c.uuid] = c.updated_at;
    if (fs.existsSync(file) && prev[c.uuid] === c.updated_at) { skipped++; }
    else {
      try {
        const full = await lmFetch(
          cfg,
          `/claude-ai/conversations/${c.uuid}?tree=true&rendering_mode=messages&render_all_tools=true`,
          token,
        );
        fs.writeFileSync(file, JSON.stringify(full.data, null, 2), 'utf-8');
        fetched++;
      } catch (e) {
        failed++;
        appendHistory(cfg, `claudeai fetch FAILED ${c.uuid} — ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
    }
    if (index) {
      let text = '';
      try { text = conversationText(fs.readFileSync(file, 'utf-8')); } catch { /* unreadable */ }
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      batch.push({
        id: itemId('claudeai', '', `${c.uuid}.json`), kind: 'conversation', source: 'claudeai',
        store: 'claudeai', project: '', path: `conversations/${c.uuid}.json`, container: '', member: '',
        title: c.name || '(untitled)', mtime: Date.parse(c.updated_at) || Date.now(), size, text,
      });
    }
  }

  fs.writeFileSync(manPath, JSON.stringify(manifest, null, 2), 'utf-8');
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(list, null, 2), 'utf-8');
  const md = ['# claude.ai Conversation Backup Index', '', `Updated: ${stamp()}`, `Total: ${list.length}`, '',
    '| Updated | Name | UUID |', '|---------|------|------|'];
  for (const c of [...list].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))) {
    md.push(`| ${c.updated_at} | ${String(c.name || '(untitled)').replace(/\|/g, '/')} | ${c.uuid} |`);
  }
  fs.writeFileSync(path.join(dir, 'INDEX.md'), md.join('\n'), 'utf-8');

  // claude.ai ACCOUNT memory — the persistent profile. It lives in the web
  // account and in no `.claude` folder, so this target is its only capture.
  try {
    const mem = await lmFetch(cfg, '/claude-ai/memory', token, 25000);
    fs.writeFileSync(path.join(dir, 'account-memory.json'), JSON.stringify(mem.data, null, 2), 'utf-8');
    if (mem?.data?.memory) fs.writeFileSync(path.join(dir, 'account-memory.md'), mem.data.memory, 'utf-8');
  } catch (e) {
    appendHistory(cfg, `claudeai account-memory fetch failed — ${e instanceof Error ? e.message : String(e)}`);
  }

  const indexed = index && batch.length ? index.upsertMany(batch) : 0;
  const all = fs.readdirSync(convDir).filter((f) => f.endsWith('.json'));
  let bytes = 0;
  for (const f of all) { try { bytes += fs.statSync(path.join(convDir, f)).size; } catch { /* ignore */ } }

  return {
    ...base,
    result: failed > 0 ? `partial (${failed} fetch errors)` : 'ok',
    detail: `total ${list.length}: fetched ${fetched}, unchanged ${skipped}, failed ${failed}` +
      (skipBlobs ? '; blobs skipped' : '; blobs unchanged (use the PowerShell fetcher for new blobs)'),
    sizeMB: Math.round((bytes / 1048576) * 10) / 10,
    items: all.length,
    indexedRows: indexed,
  };
}

// -------------------------------------------------------------- memory+rules

/**
 * Pull `rules/` and every `projects/*.memory/` out of each host into a small,
 * browsable, diffable tree. The same content is inside the whole-`.claude`
 * capture; this exists so memory and rules can be read and compared WITHOUT
 * unpacking a 2 GB tarball. Additive — a deleted memory keeps its last copy.
 */
export async function captureMemoryRules(
  cfg: BackupConfig, index: BackupIndex | null,
): Promise<CaptureResult> {
  const base = targetDir(cfg, 'memory-rules');
  fs.mkdirSync(base, { recursive: true });
  let files = 0, bytes = 0, indexed = 0, excluded = 0, unsafe = 0;

  // Collector's own rules + memory.
  const localDst = path.join(base, 'windows-desk');
  for (const sub of ['rules', 'projects']) {
    const src = path.join(cfg.localSource, sub);
    if (!fs.existsSync(src)) continue;
    const st = copyMemoryRules(src, path.join(localDst, sub), sub, 'windows-desk', index);
    files += st.files; bytes += st.bytes; indexed += st.indexed; excluded += st.excluded;
  }

  // Remote hosts: tar just the relevant dirs, extract locally (additive).
  for (const r of REMOTE_TARGETS) {
    const hdst = path.join(base, r.name);
    fs.mkdirSync(hdst, { recursive: true });
    const tmp = path.join(hdst, '_mr.tar.gz');
    const remote =
      `cd ${r.home}/.claude && tar czf - rules $(find projects -maxdepth 2 -name memory -type d)`;
    const code = await new Promise<number>((resolve) => {
      const out = fs.createWriteStream(tmp);
      const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', r.sshHost, remote],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      p.stdout.pipe(out);
      p.on('close', (c) => out.end(() => resolve(c ?? 255)));
      p.on('error', () => out.end(() => resolve(255)));
    });
    if (code > 1 || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
      appendHistory(cfg, `memory-rules ${r.name} produced no data (exit ${code})`);
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      continue;
    }
    const batch: IndexItem[] = [];
    for await (const { entry, content } of readTarGz(tmp, () => true)) {
      // Regular files only. This drops symlinks ('2'), hardlinks ('1'), devices
      // and directories — a symlink member is the other half of a tar-slip, since
      // a later regular member can then be written THROUGH it.
      if (entry.type !== '0') continue;
      // The archive came off another host over ssh; its member names are input,
      // not facts. A `..`/absolute/drive-qualified name escapes hdst.
      const rel = safeMemberPath(entry.name);
      if (!rel) {
        unsafe++;
        appendHistory(cfg, `memory-rules ${r.name}: REFUSED unsafe tar member "${entry.name}"`);
        continue;
      }
      if (excludeReason(rel)) { excluded++; continue; }
      const to = containedPath(hdst, rel);
      if (!to) {
        unsafe++;
        appendHistory(cfg, `memory-rules ${r.name}: REFUSED escaping tar member "${entry.name}"`);
        continue;
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (content) fs.writeFileSync(to, content);
      files++; bytes += entry.size;
      if (index && content) {
        const { kind, project, title } = classify(rel);
        batch.push({
          id: itemId(r.name, '', `memory-rules/${rel}`), kind, source: r.name,
          store: 'memory-rules', project, path: rel, container: '', member: '',
          title, mtime: entry.mtime, size: entry.size,
          text: content.toString('utf-8').slice(0, MAX_INDEX_TEXT),
        });
      }
    }
    if (index && batch.length) indexed += index.upsertMany(batch);
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }

  return {
    method: 'per-host rules + projects/*/memory extract',
    source: 'all hosts .claude', target: base, lastRun: stamp(), result: 'ok',
    detail: `${files} memory/rule files across all hosts` +
      (unsafe ? `; REFUSED ${unsafe} unsafe tar member(s) — see logs/history.log` : ''),
    sizeMB: Math.round((bytes / 1048576) * 10) / 10,
    items: files, secretsExcluded: excluded, indexedRows: indexed,
  };
}

function copyMemoryRules(
  src: string, dst: string, sub: string, source: string, index: BackupIndex | null,
): MirrorStats {
  const st: MirrorStats = { files: 0, bytes: 0, excluded: 0, indexed: 0 };
  const batch: IndexItem[] = [];
  const walk = (rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(src, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Under projects/, only descend toward a `memory` directory.
        if (sub === 'projects' && rel.split('/').length >= 2 && e.name !== 'memory') continue;
        walk(r); continue;
      }
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
      const logical = `${sub}/${r}`;
      if (excludeReason(logical)) { st.excluded++; continue; }
      const from = path.join(src, r);
      const to = path.join(dst, r);
      let s: fs.Stats;
      try { s = fs.statSync(from); } catch { continue; }
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      } catch { continue; }
      st.files++; st.bytes += s.size;
      if (index) {
        const { kind, project, title } = classify(logical);
        let text = '';
        try { text = fs.readFileSync(from, 'utf-8').slice(0, MAX_INDEX_TEXT); } catch { /* ignore */ }
        batch.push({
          id: itemId(source, '', `memory-rules/${logical}`), kind, source,
          store: 'memory-rules', project, path: logical, container: '', member: '',
          title, mtime: s.mtimeMs, size: s.size, text,
        });
      }
    }
  };
  walk('');
  if (index && batch.length) st.indexed = index.upsertMany(batch);
  return st;
}

// ----------------------------------------------------------------- dry run

/** Enumerate what a local capture WOULD do, writing nothing. */
export function dryRunLocal(cfg: BackupConfig): { files: number; excluded: number; sample: string[] } {
  const userExcludes = readExcludes(cfg);
  let files = 0, excluded = 0;
  const sample: string[] = [];
  const walk = (rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(cfg.localSource, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const reason = excludeReason(r, path.join(cfg.localSource, r));
      if (reason || isUserExcluded(userExcludes, r)) {
        excluded++;
        if (sample.length < 25) sample.push(`${r} — ${reason ?? 'user exclusion'}`);
        continue;
      }
      if (e.isDirectory()) { walk(r); continue; }
      if (e.isFile()) files++;
    }
  };
  walk('');
  return { files, excluded, sample };
}

