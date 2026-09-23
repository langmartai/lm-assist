import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lmb-fmt-home-'));
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lmb-fmt-data-'));
import {
  BUNDLE_ID_RE, isBundleId, newBundleId, writeBundleFile, readBundle, readBundleManifest,
  verifyBundleFile, summarizeBundle, findSection, BundleError,
  type BundleEntry, type BundleInput,
} from '../../data/bundle/format';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lmb-fmt-'));

function input(over: Partial<BundleInput> = {}): BundleInput {
  return {
    bundleId: 'lmb-20260923-101500-abcdef',
    createdAt: '2026-09-23T10:15:00.000Z',
    source: { nodeId: 'node-a', hostname: 'host-a', platform: 'linux', lmAssistVersion: '0.0.0-test', mode: 'dev' },
    options: { includeReplicas: false },
    sections: [
      { kind: 'dataset', id: 'backlog', title: 'Backlog', owned: true, backend: 'cache', syncMode: 'full', scope: 'fleet' },
      { kind: 'config', id: 'project-settings', title: 'Project settings', redactedKeys: ['x.apiKey'] },
      { kind: 'files', id: 'claude-rules', title: 'Claude rules' },
    ],
    ...over,
  };
}

const rec = (id: string, deleted = false) => ({
  id, version: 3, fields: deleted ? {} : { title: `t-${id}`, note: 'ünïcødé ✓' }, deleted: deleted || undefined,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
});

function entries(): BundleEntry[] {
  return [
    { t: 'dataset', id: 'backlog', descriptor: { id: 'backlog', backend: 'cache', ownerNode: 'node-a', visibility: 'cross-node-readable', config: { kind: 'cache' }, acl: [], createdAt: 'a', updatedAt: 'b' } as any },
    { t: 'record', ds: 'backlog', r: rec('bl_1') as any },
    { t: 'record', ds: 'backlog', r: rec('bl_2', true) as any },
    { t: 'config', id: 'project-settings', data: { excludedPaths: [] } },
    { t: 'file', section: 'claude-rules', path: 'a.md', mtime: '2026-09-01T00:00:00.000Z', size: 3, sha256: 'x', content: 'abc' },
  ];
}

async function write(dir: string, ents = entries(), inp = input()) {
  return writeBundleFile(path.join(dir, 'b.lmbundle.gz'), inp, ents);
}

/** Rewrite a bundle's decompressed lines with `edit`, re-gzipped, so a check other than gzip trips. */
function rewrite(file: string, edit: (lines: string[]) => string[]): void {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  const lines = text.split('\n');
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(edit(lines).join('\n'), 'utf8')));
}

async function rejectsCode(p: Promise<unknown>, code: string, check?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof BundleError, `expected BundleError, got ${e}`);
    assert.equal(e.code, code, e.message);
    if (check) assert.match(e.check ?? '', check);
    return true;
  });
}

test('bundle ids: generated ids match the validator; junk does not', () => {
  const id = newBundleId(new Date('2026-09-23T10:15:07.000Z'));
  assert.match(id, /^lmb-20260923-101507-[0-9a-f]{6}$/);
  assert.ok(isBundleId(id));
  assert.ok(BUNDLE_ID_RE.test(id));
  for (const bad of ['', 'lmb-1-2-3', '../lmb-20260923-101507-abcdef', 'lmb-20260923-101507-ABCDEF', 'lmb-20260923-101507-abcdef.lmbundle.gz', 42]) {
    assert.equal(isBundleId(bad), false, String(bad));
  }
});

test('round trip: manifest first, entries grouped by section, summaries computed', async () => {
  const dir = tmp();
  const w = await write(dir);
  assert.equal((fs.statSync(w.path).mode & 0o777), 0o600);
  assert.equal(w.sha256, crypto.createHash('sha256').update(fs.readFileSync(w.path)).digest('hex'));
  assert.equal(w.sizeBytes, fs.statSync(w.path).size);

  // Inspectable: line 1 is the manifest.
  const first = JSON.parse(zlib.gunzipSync(fs.readFileSync(w.path)).toString('utf8').split('\n')[0]);
  assert.equal(first.t, 'manifest');
  assert.equal(first.format, 'lm-assist-bundle');

  const b = await readBundle(w.path);
  assert.equal(b.manifest.bundleId, 'lmb-20260923-101500-abcdef');
  assert.equal(b.manifest.totals.entries, 5);
  const ds = findSection(b, 'dataset', 'backlog')!;
  assert.equal(ds.summary.count, 2);
  assert.equal(ds.summary.tombstones, 1);
  assert.equal(ds.summary.owned, true);
  assert.equal(ds.dataset?.descriptor.id, 'backlog');
  assert.deepEqual(ds.records.map((r) => r.id), ['bl_1', 'bl_2']);
  assert.equal(ds.records[1].deleted, true);
  assert.equal((ds.records[0].fields as any).note, 'ünïcødé ✓');
  const cfg = findSection(b, 'config', 'project-settings')!;
  assert.deepEqual(cfg.config?.data, { excludedPaths: [] });
  assert.deepEqual(cfg.summary.redactedKeys, ['x.apiKey']);
  const files = findSection(b, 'files', 'claude-rules')!;
  assert.deepEqual(files.files, [{ path: 'a.md', mtime: '2026-09-01T00:00:00.000Z', size: 3, sha256: 'x', content: 'abc' }]);
  for (const s of b.manifest.sections) assert.match(s.sha256, /^[0-9a-f]{64}$/);

  const m = await readBundleManifest(w.path);
  assert.deepEqual(m, b.manifest);
  const v = await verifyBundleFile(w.path);
  assert.equal(v.entries, 5);
});

test('a section with entries but no summary input still gets a declared summary; empty declared sections verify', async () => {
  const dir = tmp();
  const ents: BundleEntry[] = [...entries(), { t: 'config', id: 'mcp-profile', data: { profile: 'admin' } }];
  const w = await writeBundleFile(path.join(dir, 'x.lmbundle.gz'),
    input({ sections: [...input().sections!, { kind: 'files', id: 'knowledge', title: 'Knowledge' }] }), ents);
  const b = await readBundle(w.path);
  assert.equal(findSection(b, 'config', 'mcp-profile')?.summary.count, 1);
  assert.equal(findSection(b, 'files', 'knowledge')?.summary.count, 0);
});

test('writer refuses a record before its dataset line', () => {
  assert.throws(() => summarizeBundle(input(), [{ t: 'record', ds: 'nope', r: rec('a') as any }]), /precedes/);
});

test('corrupt: truncated file (gzip cut short)', async () => {
  const dir = tmp();
  const w = await write(dir);
  const buf = fs.readFileSync(w.path);
  fs.writeFileSync(w.path, buf.subarray(0, Math.floor(buf.length * 0.6)));
  await rejectsCode(readBundle(w.path), 'BUNDLE_CORRUPT', /gzip/);
});

test('corrupt: truncated at a line boundary (no end line)', async () => {
  const dir = tmp();
  const w = await write(dir);
  rewrite(w.path, (lines) => lines.slice(0, 3).concat(''));
  await rejectsCode(readBundle(w.path), 'BUNDLE_CORRUPT', /^truncated$/);
});

test('corrupt: flipped byte inside a record is caught by the end hash', async () => {
  const dir = tmp();
  const w = await write(dir);
  rewrite(w.path, (lines) => lines.map((l, i) => (i === 2 ? l.replace('t-bl_1', 't-bl_X') : l)));
  await rejectsCode(readBundle(w.path), 'BUNDLE_CORRUPT', /^end-hash$/);
});

test('corrupt: flipped byte in the compressed stream', async () => {
  const dir = tmp();
  const w = await write(dir);
  const buf = fs.readFileSync(w.path);
  buf[Math.floor(buf.length / 2)] ^= 0xff;
  fs.writeFileSync(w.path, buf);
  await assert.rejects(readBundle(w.path), (e: any) => e instanceof BundleError && e.code === 'BUNDLE_CORRUPT');
});

test('corrupt: wrong end count', async () => {
  const dir = tmp();
  const w = await write(dir);
  rewrite(w.path, (lines) => lines.map((l) => {
    const o = l ? JSON.parse(l) : null;
    return o?.t === 'end' ? JSON.stringify({ ...o, entries: o.entries + 1 }) : l;
  }));
  await rejectsCode(readBundle(w.path), 'BUNDLE_CORRUPT', /^end-count$/);
});

test('corrupt: a section hash mismatch is named even when the end hash is recomputed', async () => {
  const dir = tmp();
  const w = await write(dir);
  rewrite(w.path, (lines) => {
    const body = lines.filter((l) => l && JSON.parse(l).t !== 'end');
    body[5] = body[5].replace('"abc"', '"abd"'); // the file line's content
    const h = crypto.createHash('sha256');
    for (const l of body) h.update(l + '\n');
    return [...body, JSON.stringify({ t: 'end', entries: body.length - 1, sha256: h.digest('hex') }), ''];
  });
  await rejectsCode(readBundle(w.path), 'BUNDLE_CORRUPT', /^section-hash:files:claude-rules$/);
});

test('corrupt: data after the end line', async () => {
  const dir = tmp();
  const w = await write(dir);
  rewrite(w.path, (lines) => [...lines.filter(Boolean), '{"t":"record"}', '']);
  await rejectsCode(readBundle(w.path), 'BUNDLE_CORRUPT', /^trailing-data$/);
});

test('format: not gzip, not a bundle manifest, wrong formatVersion', async () => {
  const dir = tmp();
  const a = path.join(dir, 'a.gz');
  fs.writeFileSync(a, 'plain text');
  await rejectsCode(readBundleManifest(a), 'BUNDLE_FORMAT');
  const b = path.join(dir, 'b.gz');
  fs.writeFileSync(b, zlib.gzipSync('{"hello":1}\n'));
  await rejectsCode(readBundle(b), 'BUNDLE_FORMAT');
  const w = await write(dir);
  rewrite(w.path, (lines) => lines.map((l, i) => (i === 0 ? l.replace('"formatVersion":1', '"formatVersion":2') : l)));
  await rejectsCode(readBundleManifest(w.path), 'BUNDLE_FORMAT', /format-version/);
  await rejectsCode(readBundle(path.join(dir, 'missing.gz')), 'BUNDLE_NOT_FOUND');
});

test('caps: line cap and total cap are enforced by writer and reader', async () => {
  const dir = tmp();
  const big: BundleEntry[] = [{ t: 'config', id: 'project-settings', data: { blob: 'x'.repeat(5000) } }];
  assert.throws(() => summarizeBundle(input(), big, { maxLineBytes: 1000 }),
    (e: any) => e instanceof BundleError && e.code === 'BUNDLE_TOO_LARGE' && e.check === 'line-cap');
  assert.throws(() => summarizeBundle(input(), big, { maxUncompressedBytes: 1000 }),
    (e: any) => e instanceof BundleError && e.code === 'BUNDLE_TOO_LARGE' && e.check === 'total-cap');
  const w = await writeBundleFile(path.join(dir, 'big.lmbundle.gz'), input(), big);
  await rejectsCode(readBundle(w.path, { maxLineBytes: 1000 }), 'BUNDLE_TOO_LARGE', /line-cap/);
  await rejectsCode(readBundle(w.path, { maxUncompressedBytes: 2000 }), 'BUNDLE_TOO_LARGE', /total-cap/);
  // Within caps it reads.
  const ok = await readBundle(w.path, { maxLineBytes: 100_000 });
  assert.equal(ok.manifest.totals.entries, 1);
});

test('beforeWrite sees the manifest and can veto before a byte is written', async () => {
  const dir = tmp();
  const f = path.join(dir, 'v.lmbundle.gz');
  await assert.rejects(writeBundleFile(f, input(), entries(), {
    beforeWrite: (m) => { assert.equal(m.totals.entries, 5); throw new Error('veto'); },
  }), /veto/);
  assert.equal(fs.existsSync(f), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('writer refuses a bundle the reader could never read back (manifest + end line count toward the cap)', async () => {
  const dir = tmp();
  const ents = entries();
  const limit = summarizeBundle(input(), ents).totals.uncompressedBytes;
  await rejectsCode(writeBundleFile(path.join(dir, 'edge.lmbundle.gz'), input(), ents, { maxUncompressedBytes: limit }), 'BUNDLE_TOO_LARGE', /total-cap/);
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing written');
});

test('manifest sections are shape-checked: a duplicate or null section is a coded BUNDLE_FORMAT', async () => {
  const dir = tmp();
  const reHash = (file: string, editManifest: (m: any) => any) => rewrite(file, (lines) => {
    const body = lines.filter((l) => l && JSON.parse(l).t !== 'end');
    body[0] = JSON.stringify(editManifest(JSON.parse(body[0])));
    const h = crypto.createHash('sha256');
    for (const l of body) h.update(l + '\n');
    return [...body, JSON.stringify({ t: 'end', entries: body.length - 1, sha256: h.digest('hex') }), ''];
  });
  const a = await write(dir);
  reHash(a.path, (m) => ({ ...m, sections: [...m.sections, m.sections[1]] }));
  await rejectsCode(verifyBundleFile(a.path), 'BUNDLE_FORMAT', /^manifest-sections$/);
  const dir2 = tmp();
  const b = await write(dir2);
  reHash(b.path, (m) => ({ ...m, sections: [...m.sections, null] }));
  await rejectsCode(verifyBundleFile(b.path), 'BUNDLE_FORMAT', /^manifest-sections$/);
});
