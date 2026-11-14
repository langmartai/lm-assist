import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lmb-files-home-'));
process.env.HOME = HOME;
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lmb-files-data-'));
delete process.env.CLAUDE_CONFIG_DIR;
import {
  createKnowledgeProvider, createClaudeMemoryProvider, createClaudeRulesProvider, createFilesProviders,
  resolveBundlePath, setKnowledgeReloadHook, MAX_FILE_BYTES,
} from '../../data/bundle/sections/files';
import type { BundleFile } from '../../data/bundle/format';

const tmp = (p = 'lmb-files-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sha = (s: string) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const file = (p: string, content: string): BundleFile => ({ path: p, content, sha256: sha(content), size: Buffer.byteLength(content), mtime: '2026-09-01T00:00:00.000Z' });
function put(root: string, rel: string, content: string | Buffer) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

test('default roots resolve inside the sandboxed HOME / data dir', () => {
  const [k, m, r] = createFilesProviders();
  assert.equal(k.root(), path.join(process.env.LM_ASSIST_DATA_DIR!, 'knowledge'));
  assert.equal(m.root(), path.join(HOME, '.claude', 'projects'));
  assert.equal(r.root(), path.join(HOME, '.claude', 'rules'));
});

test('resolveBundlePath refuses traversal, absolute, drive letters, NUL, backslash, empty segments', () => {
  const root = tmp();
  assert.equal(resolveBundlePath(root, 'a/b.md'), path.join(root, 'a', 'b.md'));
  for (const bad of ['../x.md', 'a/../../x.md', 'a/../b.md', '/etc/passwd', 'C:/x.md', 'c:x.md', 'a\\b.md', '..\\x.md',
    'a\0.md', '', './a.md', 'a//b.md', 'a/.', '\\\\server\\share\\x']) {
    assert.throws(() => resolveBundlePath(root, bad), (e: any) => e?.name === 'UnsafePathError', JSON.stringify(bad));
  }
});

test('claude-rules: collect excludes synced.* and reports binary / oversized / non-UTF-8; round-trips', async () => {
  const src = tmp();
  put(src, 'own.md', '# own rule ✓');
  put(src, 'synced.other-node.rule.md', 'mirror');
  put(src, 'notes.txt', 'not a rule');
  put(src, 'bin.md', Buffer.from([0x23, 0x00, 0x41]));
  put(src, 'latin1.md', Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in latin-1
  fs.writeFileSync(path.join(src, 'huge.md'), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
  fs.symlinkSync(path.join(src, 'own.md'), path.join(src, 'link.md'));
  const c = await createClaudeRulesProvider({ rulesDir: src }).collect();
  assert.deepEqual(c.files.map((f) => f.path), ['own.md']);
  assert.equal(c.files[0].sha256, sha('# own rule ✓'));
  assert.ok(c.warnings.some((w) => w.startsWith('binary: bin.md')));
  assert.ok(c.warnings.some((w) => w.startsWith('too-large: huge.md')));
  assert.ok(c.warnings.some((w) => w.startsWith('not-utf8: latin1.md')));
  assert.ok(!c.warnings.some((w) => w.includes('synced.')));

  const dst = tmp();
  const p = createClaudeRulesProvider({ rulesDir: dst });
  const res = await p.apply(c.files, 'add-missing');
  assert.equal(res.applied.add, 1);
  assert.equal(fs.readFileSync(path.join(dst, 'own.md'), 'utf8'), '# own rule ✓');
  // An import may never write a synced.* mirror or a nested path.
  const refused = await p.plan([file('synced.x.md', 'x'), file('sub/a.md', 'x')], 'replace');
  assert.equal(refused.counts.skipped, 2);
  assert.ok(refused.warnings.every((w) => w.startsWith('path-not-allowed')));
});

test('claude-rules: add-missing never overwrites; replace backs up first; identical is skipped', async () => {
  const dst = tmp();
  put(dst, 'a.md', 'LOCAL');
  const p = createClaudeRulesProvider({ rulesDir: dst });
  const incoming = [file('a.md', 'BUNDLE'), file('b.md', 'new')];
  for (const pol of ['add-missing', 'merge'] as const) {
    const plan = await p.plan(incoming, pol);
    assert.deepEqual([plan.counts.add, plan.counts.skipExists], [1, 1], pol);
  }
  await p.apply(incoming, 'merge');
  assert.equal(fs.readFileSync(path.join(dst, 'a.md'), 'utf8'), 'LOCAL');
  const rep = await p.apply(incoming, 'replace');
  assert.equal(rep.applied.update, 1);
  assert.equal(rep.counts.skipIdentical, 1); // b.md now identical
  assert.equal(fs.readFileSync(path.join(dst, 'a.md'), 'utf8'), 'BUNDLE');
  const baks = fs.readdirSync(dst).filter((n) => n.startsWith('a.md.bak-import-'));
  assert.equal(baks.length, 1);
  assert.equal(fs.readFileSync(path.join(dst, baks[0]), 'utf8'), 'LOCAL');
  assert.deepEqual(fs.readdirSync(dst).filter((n) => n.includes('.tmp-import-')), []);
});

test('claude-memory: only into existing project dirs (unknown-project otherwise); nested md kept', async () => {
  const src = tmp();
  put(src, 'proj-a/memory/MEMORY.md', 'index');
  put(src, 'proj-a/memory/topic/deep.md', 'deep');
  put(src, 'proj-a/memory/data.json', '{}');
  put(src, 'proj-a/session.jsonl', '{}');
  put(src, 'proj-b/memory/x.md', 'bx');
  const c = await createClaudeMemoryProvider({ projectsDir: src }).collect();
  assert.deepEqual(c.files.map((f) => f.path).sort(), ['proj-a/memory/MEMORY.md', 'proj-a/memory/topic/deep.md', 'proj-b/memory/x.md']);

  const dst = tmp();
  fs.mkdirSync(path.join(dst, 'proj-a')); // proj-a known here, proj-b not
  const p = createClaudeMemoryProvider({ projectsDir: dst });
  const plan = await p.plan(c.files, 'add-missing');
  assert.equal(plan.counts.add, 1);
  assert.equal(plan.counts.skipped, 2, 'MEMORY.md (managed per node) + proj-b (unknown project)');
  assert.ok(plan.warnings.some((w) => w.startsWith('unknown-project: proj-b')));
  assert.ok(plan.warnings.some((w) => w.startsWith('managed-file: proj-a/memory/MEMORY.md')));
  const res = await p.apply(c.files, 'add-missing');
  assert.equal(res.applied.add, 1);
  assert.equal(fs.readFileSync(path.join(dst, 'proj-a/memory/topic/deep.md'), 'utf8'), 'deep');
  assert.equal(fs.existsSync(path.join(dst, 'proj-b')), false, 'never creates a project dir');

  // Paths outside <slug>/memory/*.md are refused even when the project exists.
  const bad = await p.plan([file('proj-a/session.jsonl', '{}'), file('proj-a/memory/x.txt', 'x'), file('proj-a/memory/../../escape.md', 'x')], 'replace');
  assert.equal(bad.counts.skipped, 3);
  assert.ok(bad.warnings.some((w) => w.startsWith('unsafe-path')));
});

test('files import: safeJoin refusals, sha mismatch, oversize, symlinked subdir escape', async () => {
  const dst = tmp();
  fs.mkdirSync(path.join(dst, 'proj'));
  const outside = tmp('lmb-outside-');
  fs.symlinkSync(outside, path.join(dst, 'proj', 'memory'));
  const p = createClaudeMemoryProvider({ projectsDir: dst });
  const big = 'a'.repeat(MAX_FILE_BYTES + 1);
  const plan = await p.apply([
    file('/abs/memory/x.md', 'x'),
    file('C:/proj/memory/x.md', 'x'),
    file('proj/memory/n\0ul.md', 'x'),
    { ...file('proj/memory/tampered.md', 'x'), sha256: sha('y') },
    file('proj/memory/big.md', big),
    file('proj/memory/escape.md', 'x'), // proj/memory is a symlink to a dir outside the root
  ], 'replace');
  assert.equal(plan.counts.skipped, 4);
  assert.equal(plan.counts.tooLarge, 1);
  assert.equal(plan.applied.add, 0);
  assert.equal(plan.errors?.length, 1);
  assert.match(plan.errors![0], /outside the root/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('knowledge: collects the allow-listed files (never remote/), reload hook fires after a write', async () => {
  const src = tmp();
  put(src, 'K001.md', 'k1');
  put(src, 'index.json', '{"knowledges":{}}');
  put(src, 'settings.json', '{}');
  put(src, 'comments/K001.json', '[]');
  put(src, 'remote/node-x/K001.md', 'remote copy');
  put(src, 'other.txt', 'no');
  const c = await createKnowledgeProvider({ dir: src }).collect();
  assert.deepEqual(c.files.map((f) => f.path), ['index.json', 'K001.md', 'settings.json', 'comments/K001.json']);

  const dst = tmp();
  put(dst, 'K001.md', 'a different K001 from this node');
  let reloads = 0;
  const p = createKnowledgeProvider({ dir: dst, reload: () => { reloads++; } });
  const plan = await p.plan(c.files, 'merge');
  assert.equal(plan.counts.skipExists, 1, 'K-id collision surfaces as exists');
  assert.equal(reloads, 0);
  const res = await p.apply([...c.files, file('remote/node-x/K9.md', 'x')], 'add-missing');
  assert.equal(res.applied.add, 3);
  assert.equal(res.counts.skipped, 1); // remote/ refused
  assert.equal(reloads, 1);
  const none = await p.apply(c.files, 'add-missing');
  assert.equal(none.applied.add, 0);
  assert.equal(reloads, 1, 'no writes → no reload');

  // The module-level hook slot is used when no per-provider reload is given.
  const dst2 = tmp();
  let hooked = 0;
  setKnowledgeReloadHook(() => { hooked++; });
  try {
    await createKnowledgeProvider({ dir: dst2 }).apply(c.files, 'add-missing');
  } finally { setKnowledgeReloadHook(null); }
  assert.equal(hooked, 1);
});

test('claude-memory: the autosync .sync-base/ ancestors and credential-named files never travel', async () => {
  const src = tmp();
  put(src, '-slug/memory/a.md', 'L1\nL2\n');
  put(src, '-slug/memory/.sync-base/a.md', 'L1\n');
  put(src, '-slug/memory/live-broker-token.md', 'secret');
  put(src, '-slug/memory/feedback-api-key.md', 'secret');
  const c = await createClaudeMemoryProvider({ projectsDir: src }).collect();
  assert.deepEqual(c.files.map((f) => f.path), ['-slug/memory/a.md']);
  assert.ok(c.warnings.some((w) => w === 'credential-named: -slug/memory/live-broker-token.md not exported'));

  // A crafted bundle cannot plant either: the base keeps its content, nothing lands in a dot-dir.
  const dst = tmp();
  put(dst, '-slug/memory/.sync-base/a.md', 'L1\n');
  const p = createClaudeMemoryProvider({ projectsDir: dst });
  const res = await p.apply([file('-slug/memory/.sync-base/a.md', 'L1\nL2\n'), file('-slug/memory/my-token.md', 't'), file('-slug/memory/a.md', 'L1\nL2\n')], 'replace');
  assert.equal(res.applied.add, 1);
  assert.ok(res.warnings.some((w) => w.startsWith('path-not-allowed: -slug/memory/.sync-base/a.md')));
  assert.ok(res.warnings.some((w) => w.startsWith('credential-named: -slug/memory/my-token.md')));
  assert.equal(fs.readFileSync(path.join(dst, '-slug/memory/.sync-base/a.md'), 'utf8'), 'L1\n');
  assert.deepEqual(fs.readdirSync(path.join(dst, '-slug/memory/.sync-base')), ['a.md'], 'no .bak-import in the base dir');
});

test('claude-rules: credential names + oversize not exported, nested rules reported, synced mirrors never re-owned', async () => {
  const src = tmp();
  put(src, 'normal.md', 'n');
  put(src, 'broker-token.md', 'secret');
  put(src, 'big.md', 'x'.repeat(64 * 1024 + 1));
  put(src, 'team/nested.md', 'nested');
  const c = await createClaudeRulesProvider({ rulesDir: src }).collect();
  assert.deepEqual(c.files.map((f) => f.path), ['normal.md']);
  assert.ok(c.warnings.some((w) => w.startsWith('credential-named: broker-token.md')));
  assert.ok(c.warnings.some((w) => w.startsWith('too-large: big.md')));
  assert.ok(c.warnings.some((w) => w.startsWith('nested-rule-not-exported: team/nested.md')));

  const dst = tmp();
  put(dst, 'synced.hostA.foo.md', 'foo rule');
  const p = createClaudeRulesProvider({ rulesDir: dst });
  const plan = await p.plan([file('foo.md', 'foo rule'), file('bar.md', 'bar')], 'merge');
  assert.equal(plan.counts.add, 1, 'bar only');
  assert.equal(plan.counts.skipIdentical, 1);
  assert.ok(plan.warnings.some((w) => w.startsWith('already-mirrored: foo.md') && /hostA/.test(w)));
  const differs = await p.plan([file('foo.md', 'edited')], 'replace');
  assert.equal(differs.counts.skipped, 1);
});

test('knowledge: onto a node WITH an index, imported docs are indexed and nextId advances (no orphan, no clobber)', async () => {
  const dst = tmp();
  put(dst, 'index.json', JSON.stringify({ knowledges: { K001: { title: 'local one' } }, nextId: 2, lastUpdated: 1 }));
  put(dst, 'K001.md', 'local K001');
  const bundle = [
    file('index.json', JSON.stringify({ knowledges: { K001: { title: 'theirs' }, K002: { title: 'imported two' } }, nextId: 3, lastUpdated: 2 })),
    file('K001.md', 'their K001'),
    file('K002.md', 'their K002'),
  ];
  let reloads = 0;
  const p = createKnowledgeProvider({ dir: dst, reload: () => { reloads++; } });
  const plan = await p.plan(bundle, 'merge');
  assert.equal(plan.counts.add, 1, 'K002');
  assert.equal(plan.counts.skipExists, 1, 'K001 collides');
  assert.ok(plan.warnings.some((w) => /index-merged: 1 imported document\(s\) would be added/.test(w)));
  const res = await p.apply(bundle, 'merge');
  assert.equal(res.applied.add, 1);
  assert.equal(res.applied.update, 1, 'index.json merged');
  const idx = JSON.parse(fs.readFileSync(path.join(dst, 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(idx.knowledges).sort(), ['K001', 'K002']);
  assert.equal(idx.knowledges.K001.title, 'local one', 'the local entry is untouched');
  assert.equal(idx.knowledges.K002.title, 'imported two');
  assert.equal(idx.nextId, 3, 'the next generated doc is K003 — never over the imported K002');
  assert.equal(fs.readFileSync(path.join(dst, 'K001.md'), 'utf8'), 'local K001');
  assert.equal(reloads, 1);
  // A doc the bundle index does not describe still gets an entry, and nextId passes it.
  const res2 = await p.apply([file('K007.md', 'x')], 'merge');
  assert.equal(res2.applied.add, 1);
  const idx2 = JSON.parse(fs.readFileSync(path.join(dst, 'index.json'), 'utf8'));
  assert.equal(idx2.nextId, 8);
});

test('files: a symlinked comments/ dir is not read through; import never mkdirs through a symlink', async () => {
  const src = tmp();
  const secret = tmp('lmb-secret-');
  fs.writeFileSync(path.join(secret, 'id_rsa'), 'PRIVATE KEY');
  put(src, 'K001.md', 'k');
  fs.symlinkSync(secret, path.join(src, 'comments'));
  const c = await createKnowledgeProvider({ dir: src }).collect();
  assert.ok(!c.files.some((f) => f.path.startsWith('comments/')));
  assert.ok(c.warnings.some((w) => w.startsWith('symlinked-dir: comments')));

  const dst = tmp();
  fs.mkdirSync(path.join(dst, 'proj'));
  const outside = tmp('lmb-out2-');
  fs.symlinkSync(outside, path.join(dst, 'proj', 'memory'));
  const res = await createClaudeMemoryProvider({ projectsDir: dst }).apply([file('proj/memory/a/b/c.md', 'x')], 'replace');
  assert.equal(res.applied.add, 0);
  assert.deepEqual(fs.readdirSync(outside), [], 'no directory was created outside the root');
});
