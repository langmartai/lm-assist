import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lmb-store-home-'));
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lmb-store-data-'));
import {
  BundleStore, defaultBundlesDir, defaultReceivedDir, readBundleRetention, MAX_CHUNK_BYTES,
} from '../../data/bundle/store';
import { BundleError, type BundleEntry } from '../../data/bundle/format';

const tmp = (p = 'lmb-st-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const BIG_DISK = () => 1e15;

const source = { nodeId: 'node-a', hostname: 'host-a', platform: 'linux', lmAssistVersion: '0.0.0-test', mode: 'dev' as const };
function entries(n = 3, pad = 0): BundleEntry[] {
  const out: BundleEntry[] = [{ t: 'dataset', id: 'ds1', descriptor: { id: 'ds1' } as any }];
  for (let i = 0; i < n; i++) {
    out.push({ t: 'record', ds: 'ds1', r: { id: `r${i}`, version: 1, fields: { i, pad: crypto.randomBytes(pad).toString('hex') }, createdAt: 'a', updatedAt: 'b' } as any });
  }
  return out;
}

/** A store whose clock advances one second per call, so minted ids sort in creation order. */
function store(over: Partial<ConstructorParameters<typeof BundleStore>[0]> = {}) {
  let t = Date.parse('2026-09-23T00:00:00Z');
  return new BundleStore({
    dir: path.join(tmp(), 'bundles'), receivedDir: tmp('lmb-recv-'), retention: 20, freeBytes: BIG_DISK,
    now: () => (t += 1000), ...over,
  });
}

async function rejectsCode(p: Promise<unknown> | (() => unknown), code: string) {
  const run = typeof p === 'function' ? Promise.resolve().then(p) : p;
  await assert.rejects(run, (e: unknown) => {
    assert.ok(e instanceof BundleError, `expected BundleError, got ${e}`);
    assert.equal(e.code, code, e.message);
    return true;
  });
}

test('default dirs: bundles under the data dir with the dev suffix; received mirrors receiver.ts', () => {
  assert.equal(defaultBundlesDir(), path.join(process.env.LM_ASSIST_DATA_DIR!, 'bundles-dev'));
  assert.equal(defaultReceivedDir(), path.join(process.env.HOME!, '.lm-assist', 'received'));
});

test('write / list / manifest / delete; 0700 dir, 0600 file; ids only', async () => {
  const s = store();
  const w = await s.writeBundle({ source, note: 'hello' }, entries());
  assert.match(w.bundleId, /^lmb-20260923-\d{6}-[0-9a-f]{6}$/);
  assert.equal(fs.statSync(s.dir()).mode & 0o777, 0o700);
  assert.equal(fs.statSync(w.path).mode & 0o777, 0o600);
  const list = await s.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].bundleId, w.bundleId);
  assert.equal(list[0].note, 'hello');
  assert.equal(list[0].sizeBytes, w.sizeBytes);
  assert.equal(list[0].imported, undefined);
  assert.equal((await s.getManifest(w.bundleId)).totals.entries, 4);
  const read = await s.read(w.bundleId);
  assert.equal(read.sections[0].records.length, 3);

  for (const bad of ['../etc/passwd', 'lmb-x', w.bundleId + '/..', '']) {
    await rejectsCode(() => s.pathFor(bad), 'BUNDLE_ID_INVALID');
  }
  await rejectsCode(s.getManifest('lmb-20000101-000000-000000'), 'BUNDLE_NOT_FOUND');
  assert.equal(s.delete(w.bundleId), true);
  assert.equal(s.delete(w.bundleId), false);
  assert.deepEqual(await s.list(), []);
});

test('list tolerates a corrupt file: listed with an error, still deletable', async () => {
  const s = store();
  const good = await s.writeBundle({ source }, entries());
  const badId = 'lmb-20990101-000000-abcdef';
  fs.writeFileSync(s.pathFor(badId), 'not a bundle');
  const list = await s.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].bundleId, badId); // newest first
  assert.equal(list[0].error?.code, 'BUNDLE_FORMAT');
  assert.equal(list[1].bundleId, good.bundleId);
  assert.equal(list[1].error, undefined);
  assert.equal(s.delete(badId), true);
});

test('retention keeps the newest N; bundleRetention comes from project-settings', async () => {
  let keep = 3;
  const s = store({ retention: () => keep });
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await s.writeBundle({ source }, entries(1))).bundleId);
  assert.deepEqual((await s.list()).map((b) => b.bundleId), ids.slice(2).reverse());
  keep = 1;
  assert.deepEqual(s.prune(), [ids[3], ids[2]]);
  assert.deepEqual((await s.list()).map((b) => b.bundleId), [ids[4]]);

  const f = path.join(tmp(), 'project-settings.json');
  assert.equal(readBundleRetention(f), 20);
  fs.writeFileSync(f, JSON.stringify({ bundleRetention: 7 }));
  assert.equal(readBundleRetention(f), 7);
  fs.writeFileSync(f, JSON.stringify({ bundleRetention: 0 }));
  assert.equal(readBundleRetention(f), 20);
});

test('DISK_LOW refuses the export with the numbers, before writing', async () => {
  const s = store({ freeBytes: () => 100 * 1024 * 1024 });
  await assert.rejects(s.writeBundle({ source }, entries()), (e: any) => {
    assert.ok(e instanceof BundleError);
    assert.equal(e.code, 'DISK_LOW');
    assert.equal(e.details?.freeBytes, 100 * 1024 * 1024);
    assert.equal(e.details?.requiredBytes, 512 * 1024 * 1024);
    return true;
  });
  assert.deepEqual(fs.readdirSync(s.dir()), []);
  // 3 × estimate wins over the floor when the estimate is large.
  const c = store({ freeBytes: () => 1e12 }).checkDiskSpace(400 * 1024 * 1024);
  assert.equal(c.requiredBytes, 1200 * 1024 * 1024);
  assert.equal(c.ok, true);
  // Unknown free space never blocks.
  assert.equal(store({ freeBytes: () => null }).checkDiskSpace(1e12).ok, true);
});

test('readChunk: bounds, and chunks reassemble to the file', async () => {
  const s = store();
  const w = await s.writeBundle({ source }, entries(400, 1500));
  const total = fs.statSync(w.path).size;
  assert.ok(total > MAX_CHUNK_BYTES, `test bundle should exceed one chunk (${total})`);
  await rejectsCode(() => s.readChunk(w.bundleId, 0, MAX_CHUNK_BYTES + 1), 'INVALID_RANGE');
  await rejectsCode(() => s.readChunk(w.bundleId, 0, 0), 'INVALID_RANGE');
  await rejectsCode(() => s.readChunk(w.bundleId, -1, 10), 'INVALID_RANGE');
  await rejectsCode(() => s.readChunk(w.bundleId, 1.5, 10), 'INVALID_RANGE');
  await rejectsCode(() => s.readChunk(w.bundleId, total + 1, 10), 'INVALID_RANGE');
  await rejectsCode(() => s.readChunk('../x', 0, 10), 'BUNDLE_ID_INVALID');
  const atEnd = s.readChunk(w.bundleId, total, 10);
  assert.deepEqual({ length: atEnd.length, done: atEnd.done, dataB64: atEnd.dataB64 }, { length: 0, done: true, dataB64: '' });

  const parts: Buffer[] = [];
  let off = 0;
  for (;;) {
    const c = s.readChunk(w.bundleId, off);
    assert.equal(c.total, total);
    assert.ok(c.length <= MAX_CHUNK_BYTES);
    parts.push(Buffer.from(c.dataB64, 'base64'));
    off += c.length;
    if (c.done) break;
  }
  assert.ok(Buffer.concat(parts).equals(fs.readFileSync(w.path)));
});

function chunksOf(buf: Buffer, n: number): string[] {
  const size = Math.ceil(buf.length / n);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(buf.subarray(i * size, (i + 1) * size).toString('base64'));
  return out;
}

test('upload: idempotent per index, out of order, verified, stored under a NEW id with importedFrom', async () => {
  const src = store();
  const w = await src.writeBundle({ source }, entries(50, 200));
  const bytes = fs.readFileSync(w.path);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const [c0, c1, c2] = chunksOf(bytes, 3);

  const s = store();
  const r0 = await s.uploadChunk({ index: 0, total: 3, dataB64: c0, name: 'my.lmbundle.gz' });
  assert.match(r0.uploadId, /^upl-[0-9a-f]{16}$/);
  assert.deepEqual({ received: r0.received, done: r0.done }, { received: 1, done: false });
  const uploadId = r0.uploadId;
  const r2 = await s.uploadChunk({ uploadId, index: 2, total: 3, dataB64: c2, sha256: sha });
  assert.equal(r2.received, 2);
  const r2b = await s.uploadChunk({ uploadId, index: 2, total: 3, dataB64: c2 }); // retry: no-op
  assert.equal(r2b.received, 2);
  await rejectsCode(s.uploadChunk({ uploadId, index: 2, total: 3, dataB64: c1 }), 'UPLOAD_CONFLICT');
  await rejectsCode(s.uploadChunk({ uploadId, index: 1, total: 4, dataB64: c1 }), 'UPLOAD_CONFLICT');
  const done = await s.uploadChunk({ uploadId, index: 1, total: 3, dataB64: c1 });
  assert.equal(done.done, true);
  assert.ok(done.bundleId && done.bundleId !== w.bundleId);
  assert.equal(done.sha256, sha);
  assert.equal(done.manifest?.bundleId, w.bundleId);

  // A retried chunk after completion returns the same result.
  const again = await s.uploadChunk({ uploadId, index: 1, total: 3, dataB64: c1 });
  assert.equal(again.bundleId, done.bundleId);

  const list = await s.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].bundleId, done.bundleId);
  assert.equal(list[0].imported?.importedFrom, w.bundleId);
  assert.equal(list[0].imported?.via, 'upload');
  assert.equal(list[0].imported?.name, 'my.lmbundle.gz');
  assert.ok(fs.readFileSync(s.pathFor(done.bundleId!)).equals(bytes), 'bytes kept verbatim');
  // No partials left behind.
  assert.deepEqual(fs.readdirSync(path.join(s.dir(), '.uploads')).filter((n) => !n.endsWith('.done.json')), []);
});

test('upload: a declared sha256 mismatch and a corrupt payload are refused; nothing stored', async () => {
  const src = store();
  const w = await src.writeBundle({ source }, entries(5));
  const bytes = fs.readFileSync(w.path);
  const s = store();
  await rejectsCode(s.uploadChunk({ index: 0, total: 1, dataB64: bytes.toString('base64'), sha256: 'a'.repeat(64) }), 'UPLOAD_SHA_MISMATCH');
  const broken = Buffer.from(bytes);
  broken[Math.floor(broken.length / 2)] ^= 0xff;
  await rejectsCode(s.uploadChunk({ index: 0, total: 1, dataB64: broken.toString('base64') }), 'BUNDLE_CORRUPT');
  assert.deepEqual(await s.list(), []);
  assert.deepEqual(fs.readdirSync(s.dir()).filter((n) => n !== '.uploads'), []);
});

test('upload: input validation, unknown continuation, and the 1 h sweep', async () => {
  let now = Date.parse('2026-09-23T00:00:00Z');
  const s = store({ now: () => now });
  await rejectsCode(s.uploadChunk({ index: 0, total: 0, dataB64: 'AAAA' }), 'UPLOAD_INVALID');
  await rejectsCode(s.uploadChunk({ index: 2, total: 2, dataB64: 'AAAA' }), 'UPLOAD_INVALID');
  await rejectsCode(s.uploadChunk({ index: 1, total: 2, dataB64: 'AAAA' }), 'UPLOAD_INVALID'); // no uploadId
  await rejectsCode(s.uploadChunk({ index: 0, total: 2, dataB64: 'not base64!' }), 'UPLOAD_INVALID');
  await rejectsCode(s.uploadChunk({ uploadId: '../../x', index: 0, total: 2, dataB64: 'AAAA' }), 'UPLOAD_INVALID');
  await rejectsCode(s.uploadChunk({ index: 0, total: 2, dataB64: 'A'.repeat(700 * 1024 + 4) }), 'UPLOAD_INVALID');
  await rejectsCode(s.uploadChunk({ uploadId: 'upl-0123456789abcdef', index: 1, total: 2, dataB64: 'AAAA' }), 'UPLOAD_NOT_FOUND');

  const r0 = await s.uploadChunk({ index: 0, total: 2, dataB64: 'AAAA' });
  const partial = path.join(s.dir(), '.uploads', r0.uploadId);
  assert.ok(fs.existsSync(partial));
  const old = new Date(now - 2 * 60 * 60 * 1000);
  fs.utimesSync(partial, old, old);
  const staleTmp = path.join(s.dir(), 'lmb-20260923-000000-abcdef.lmbundle.gz.tmp-1-deadbeef');
  fs.writeFileSync(staleTmp, 'x');
  fs.utimesSync(staleTmp, old, old);
  assert.deepEqual(s.sweepUploads().sort(), [r0.uploadId, path.basename(staleTmp)].sort());
  assert.equal(fs.existsSync(partial), false);
  assert.equal(fs.existsSync(staleTmp), false);
  await rejectsCode(s.uploadChunk({ uploadId: r0.uploadId, index: 1, total: 2, dataB64: 'AAAA' }), 'UPLOAD_NOT_FOUND');
});

test('importReceived: confined to the inbox, verified, stored under a new id', async () => {
  const src = store();
  const w = await src.writeBundle({ source }, entries(4));
  const s = store();
  const inbox = (s as any).inbox as string;
  fs.copyFileSync(w.path, path.join(inbox, 'from-peer.lmbundle.gz'));
  const r = await s.importReceived('from-peer.lmbundle.gz');
  assert.notEqual(r.bundleId, w.bundleId);
  assert.equal(r.imported.importedFrom, w.bundleId);
  assert.equal(r.imported.via, 'received');
  assert.ok(fs.existsSync(path.join(inbox, 'from-peer.lmbundle.gz')), 'source left in place');

  for (const bad of ['../x', '..', '.', 'a/b', '/etc/passwd', 'x'.repeat(129), '']) {
    await rejectsCode(s.importReceived(bad), 'RECEIVED_NAME_INVALID');
  }
  await rejectsCode(s.importReceived('missing.gz'), 'RECEIVED_NOT_FOUND');
  // A symlink inside the inbox pointing elsewhere is refused.
  const outside = path.join(tmp(), 'outside.gz');
  fs.copyFileSync(w.path, outside);
  fs.symlinkSync(outside, path.join(inbox, 'link.gz'));
  await rejectsCode(s.importReceived('link.gz'), 'RECEIVED_NAME_INVALID');
  // A directory is refused.
  fs.mkdirSync(path.join(inbox, 'adir'));
  await rejectsCode(s.importReceived('adir'), 'RECEIVED_NAME_INVALID');
  // A corrupt file is refused before it reaches the store.
  fs.writeFileSync(path.join(inbox, 'junk.gz'), 'junk');
  await rejectsCode(s.importReceived('junk.gz'), 'BUNDLE_FORMAT');
  assert.equal((await s.list()).length, 1);
});

test('retention never deletes the bundle just written: same-second siblings and a clock that stepped back', async () => {
  // Every write in the same second: the random suffix alone orders them.
  const fixed = Date.parse('2026-09-23T10:00:00Z');
  for (let i = 0; i < 20; i++) {
    const s = store({ retention: 1, now: () => fixed });
    await s.writeBundle({ source }, entries(1));
    const w = await s.writeBundle({ source }, entries(1));
    assert.ok(s.exists(w.bundleId), 'the returned id exists');
    assert.equal(w.pruned.length, 1);
    assert.equal(s.exists(w.pruned[0]), false, 'pruned lists exactly what was deleted');
  }
  // Three bundles dated in the FUTURE (clock stepped back since), retention 3.
  let t = Date.parse('2026-09-25T00:00:00Z');
  const s = store({ retention: 3, now: () => t });
  for (let i = 0; i < 3; i++) { t += 1000; await s.writeBundle({ source }, entries(1)); }
  t = Date.parse('2026-09-23T00:00:00Z');
  for (let i = 0; i < 3; i++) {
    t += 1000;
    const w = await s.writeBundle({ source }, entries(1));
    assert.ok(s.exists(w.bundleId), `write ${i}: the new restore point is kept`);
    assert.equal(w.pruned.length, 1);
  }
  assert.equal((await s.list()).length, 3);
});

test('disk: an IMPORT needs 2 × size + 16 MiB, not the 512 MB export floor', async () => {
  const src = store();
  const w = await src.writeBundle({ source }, entries(2));
  const s = store({ freeBytes: () => 400 * 1024 * 1024 });
  fs.copyFileSync(w.path, path.join((s as any).inbox, 'small.lmbundle.gz'));
  const r = await s.importReceived('small.lmbundle.gz');
  assert.ok(s.exists(r.bundleId), 'a small restore works on a node with 400 MB free');
  const c = s.checkDiskSpace(1000, 'import');
  assert.equal(c.requiredBytes, 2000 + 16 * 1024 * 1024);
  assert.equal(store({ freeBytes: () => 1 }).checkDiskSpace(1000, 'import').ok, false);
});

test('upload: every new part is disk-checked and counted toward the 1 GiB cap; total is bounded', async () => {
  let free = 1e15;
  const s = store({ freeBytes: () => free });
  await rejectsCode(s.uploadChunk({ index: 0, total: 100000, dataB64: 'AAAA' }), 'UPLOAD_INVALID');
  const r0 = await s.uploadChunk({ index: 0, total: 3, dataB64: 'AAAA' });
  free = 1;                                               // the disk filled up after chunk 0
  await rejectsCode(s.uploadChunk({ uploadId: r0.uploadId, index: 1, total: 3, dataB64: 'A'.repeat(4096) }), 'DISK_LOW');
  const meta = JSON.parse(fs.readFileSync(path.join(s.dir(), '.uploads', r0.uploadId, 'upload.json'), 'utf8'));
  assert.equal(meta.bytes, 3, 'the running total of stored parts is kept');
});

test('first use of a store sweeps stale tmp files (not only when an upload arrives)', async () => {
  const dir = path.join(tmp(), 'bundles');
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, 'lmb-20260101-000000-abcdef.lmbundle.gz.tmp-9-cafebabe');
  fs.writeFileSync(stale, 'partial');
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  const s = new BundleStore({ dir, receivedDir: tmp(), retention: 20, freeBytes: BIG_DISK });
  await s.list();
  assert.equal(fs.existsSync(stale), false);
});

test('read refuses a bundle whose declared size would not fit in the heap that is left (no OOM)', async () => {
  const s = store();
  const w = await s.writeBundle({ source }, entries(5, 100));
  s.heapHeadroom = () => 10;
  await rejectsCode(s.read(w.bundleId), 'BUNDLE_TOO_LARGE');
  s.heapHeadroom = () => 1e12;
  assert.equal((await s.read(w.bundleId)).manifest.bundleId, w.bundleId);
});
