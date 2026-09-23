// core/src/__tests__/data-bundle/rt-routes.test.ts
// The REST surface over the bundle service (spec "Surfaces > REST"): routing precedence against
// the /data/:dataset/* routes, the confirm gate, id validation, chunk bounds, download, upload
// assembly + idempotency, the received-inbox import, a peer fetch served by the chunk route,
// takeover, the reserved `bundles` dataset id, and the coded-error → HTTP status mapping.
// Hermetic: the harness points HOME and LM_ASSIST_DATA_DIR at temp dirs before any lm-assist
// module loads, and every route set is bound to an injected service + store.
import { makeNode, ownedDataset, replicaDataset, rec, tmp, type TestNode } from './svc-harness';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createDataBundleRoutes } from '../../routes/core/data-bundle.routes';
import { createDataRoutes } from '../../routes/core/data.routes';
import { getDataService } from '../../data/data-service';
import { BundleStore, BundleError, BundleServiceError, MAX_CHUNK_BYTES, MAX_UPLOAD_CHUNK_B64 } from '../../data/bundle';
import type { ParsedRequest, RouteHandler } from '../../routes/index';

const ORIGIN = { machineId: 'gw-origin', hostname: 'origin-host', os: 'linux' };
const WELL_FORMED = 'lmb-20260923-120000-abcdef';

interface Res {
  success: boolean;
  data?: any;
  error?: { code: string; message: string; details?: any };
  httpStatus?: number;
  binary?: boolean;
  headers?: Record<string, string>;
}

/** What rest-server.ts sends: an explicit httpStatus, else success ? 200 : 400. */
const statusOf = (r: Res) => (typeof r.httpStatus === 'number' ? r.httpStatus : r.success ? 200 : 400);

function match(routes: RouteHandler[], method: string, pathname: string) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.pattern);
    if (m) return { route: r, params: m.groups ?? {} };
  }
  return null;
}

async function call(
  routes: RouteHandler[], method: string, url: string,
  opts: { body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<Res> {
  const u = new URL(url, 'http://core.test');
  const hit = match(routes, method, u.pathname);
  if (!hit) throw new Error(`no route for ${method} ${u.pathname}`);
  const req: ParsedRequest = {
    method, path: u.pathname, params: hit.params, query: Object.fromEntries(u.searchParams),
    body: opts.body ?? {},
    rawBody: opts.rawBody ?? (opts.body === undefined ? '' : JSON.stringify(opts.body)),
    headers: opts.headers ?? {}, clientIp: '127.0.0.1',
  };
  return hit.route.handler(req, {} as any);
}

function expectErr(r: Res, code: string, status: number): Res {
  assert.equal(r.success, false, `expected ${code}, got success`);
  assert.equal(r.error!.code, code, r.error!.message);
  assert.equal(statusOf(r), status, `${code} should be HTTP ${status}`);
  return r;
}

const routesOf = (n: TestNode) => createDataBundleRoutes({} as any, { service: () => n.svc, store: () => n.store });

/** A node owning `notes` (two live records + a tombstone) with one default export stored. */
async function exported(n: TestNode = makeNode()) {
  await ownedDataset(n, 'notes', [rec('a', 1, { t: 'x' }), rec('b', 2, { t: 'y' }), rec('c', 3, {}, { deleted: true })]);
  const routes = routesOf(n);
  const r = await call(routes, 'POST', '/data/bundles', { body: { note: 'rt' } });
  assert.equal(r.success, true, JSON.stringify(r.error));
  return { n, routes, id: r.data.bundleId as string, file: r.data.path as string };
}

// ─── routing ────────────────────────────────────────────────────────────────

test('routing: every bundle path wins over /data/:dataset/*, and the data paths still reach the data routes', () => {
  const bundle = createDataBundleRoutes({} as any);
  const data = createDataRoutes({} as any);
  const all = [...bundle, ...data]; // the order index.ts registers them in
  const mine = new Set<RouteHandler>(bundle);

  const bundlePaths: Array<[string, string]> = [
    ['GET', '/data/bundles/inventory'], ['GET', '/data/bundles'], ['POST', '/data/bundles'],
    ['POST', '/data/bundles/upload'], ['POST', '/data/bundles/fetch'], ['POST', '/data/bundles/received/x.lmbundle.gz'],
    ['POST', '/data/bundles/received/plan'],
    ['GET', `/data/bundles/${WELL_FORMED}`], ['GET', `/data/bundles/${WELL_FORMED}/chunk`],
    ['GET', `/data/bundles/${WELL_FORMED}/download`], ['DELETE', `/data/bundles/${WELL_FORMED}`],
    ['POST', `/data/bundles/${WELL_FORMED}/plan`], ['POST', `/data/bundles/${WELL_FORMED}/apply`],
    ['POST', '/data/datasets/backlog/takeover'],
  ];
  for (const [m, p] of bundlePaths) {
    const hit = match(all, m, p);
    assert.ok(hit && mine.has(hit.route), `${m} ${p} must resolve to a bundle route`);
  }
  // `received/plan` is the received import of a file named "plan", not a plan of bundle "received".
  assert.equal(match(all, 'POST', '/data/bundles/received/plan')!.params.name, 'plan');
  // Why the order matters: on their own the data routes' `/data/:dataset/fetch` captures it.
  assert.ok(match(data, 'POST', '/data/bundles/fetch'), 'the data routes alone would capture POST /data/bundles/fetch');

  const dataPaths: Array<[string, string]> = [
    ['GET', '/data/backlog/export'], ['POST', '/data/backlog/export'], ['POST', '/data/backlog/fetch'],
    ['GET', '/data/sync/manifest'], ['GET', '/data/sync/status'], ['POST', '/data/sync'],
    ['GET', '/data/catalog'], ['GET', '/data/keys'], ['POST', '/data/access'], ['DELETE', '/data/access/k1'],
    ['GET', '/data/datasets'], ['POST', '/data/datasets'], ['DELETE', '/data/datasets/backlog'],
    ['GET', '/data/backlog/records/x'], ['PUT', '/data/backlog/records'], ['DELETE', '/data/backlog/records/x'],
    ['POST', '/data/backlog/query'], ['POST', '/data/backlog/search'], ['POST', '/data/backlog/admin'], ['POST', '/data/backlog/sql'],
  ];
  for (const [m, p] of dataPaths) {
    const hit = match(all, m, p);
    assert.ok(hit && !mine.has(hit.route), `${m} ${p} must still reach the data routes`);
  }
});

test('index.ts registers the bundle routes BEFORE the data routes (first match wins)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../src/routes/core/index.ts'), 'utf8');
  const b = src.indexOf('...createDataBundleRoutes(ctx)');
  const d = src.indexOf('...createDataRoutes(ctx)');
  assert.ok(b > 0, 'createDataBundleRoutes is registered');
  assert.ok(d > 0 && b < d, 'createDataBundleRoutes comes before createDataRoutes');
});

test('reserved id: no dataset can be named "bundles", so /data/:dataset/* can never address one here', async () => {
  (getDataService() as any).enabledOverride = true;
  const data = createDataRoutes({} as any);
  const r = await call(data, 'POST', '/data/datasets', { body: { id: 'bundles', backend: 'cache', config: { kind: 'cache' } } });
  assert.equal(r.success, false);
  assert.match(r.error!.message, /reserved/);
});

// ─── inventory / create / list / inspect / delete ───────────────────────────

test('lifecycle: inventory → create → list → inspect → delete; relayed (hub) callers are served', async () => {
  const { n, routes, id } = await exported();

  const inv = await call(routes, 'GET', '/data/bundles/inventory', { headers: { 'x-relay-source': 'hub' } });
  assert.equal(inv.success, true, JSON.stringify(inv.error));
  const notes = inv.data.datasets.find((d: any) => d.id === 'notes');
  assert.deepEqual([notes.owned, notes.export, notes.records, notes.tombstones], [true, 'default', 3, 1]);
  assert.equal(inv.data.bundles.count, 1);

  const list = await call(routes, 'GET', '/data/bundles');
  assert.equal(list.success, true);
  assert.deepEqual(list.data.bundles.map((b: any) => b.bundleId), [id]);
  assert.equal(list.data.bundles[0].note, 'rt');

  const ins = await call(routes, 'GET', `/data/bundles/${id}`);
  assert.equal(ins.success, true);
  assert.equal(ins.data.bundleId, id);
  assert.equal(ins.data.manifest.format, 'lm-assist-bundle');
  const sec = ins.data.manifest.sections.find((s: any) => s.id === 'notes');
  assert.equal(sec.count, 3);
  assert.equal(sec.sha256, undefined, 'inspect shows compact sections');

  const del = await call(routes, 'DELETE', `/data/bundles/${id}`);
  assert.deepEqual(del.data, { bundleId: id, deleted: true });
  expectErr(await call(routes, 'GET', `/data/bundles/${id}`), 'BUNDLE_NOT_FOUND', 404);
  const again = await call(routes, 'DELETE', `/data/bundles/${id}`);
  assert.deepEqual(again.data, { bundleId: id, deleted: false }, 'a repeated delete is a no-op, not an error');
  assert.equal(n.store.exists(id), false);
});

test('create: options are validated — unknown fields, bad booleans, non-JSON body; plausible forms are coerced', async () => {
  const n = makeNode();
  await ownedDataset(n, 'notes', [rec('a', 1, {})]);
  const routes = routesOf(n);

  const typo = expectErr(await call(routes, 'POST', '/data/bundles', { body: { includeReplica: true } }), 'UNSUPPORTED_FIELD', 400);
  assert.match(typo.error!.message, /"includeReplica"/);
  assert.match(typo.error!.message, /includeReplicas/, 'the refusal lists what is supported');

  const bool = expectErr(await call(routes, 'POST', '/data/bundles', { body: { includeReplicas: 'maybe' } }), 'BAD_REQUEST', 400);
  assert.match(bool.error!.message, /"maybe"/, 'the refusal echoes what was sent');

  expectErr(await call(routes, 'POST', '/data/bundles', { body: {}, rawBody: '{"note": oops' }), 'BAD_REQUEST', 400);
  expectErr(await call(routes, 'POST', '/data/bundles', { body: [1, 2] }), 'BAD_REQUEST', 400);
  expectErr(await call(routes, 'POST', '/data/bundles', { body: { sections: ['bogus'] } }), 'BAD_REQUEST', 400);
  assert.equal((await n.store.list()).length, 0, 'no refused request wrote a bundle');

  // `node` is the connector's routing key; "false" and a CSV string are plausible caller forms.
  const ok = await call(routes, 'POST', '/data/bundles', { body: { node: 'gw-x', _actor: { kind: 'human' }, includeReplicas: 'false', sections: 'datasets' } });
  assert.equal(ok.success, true, JSON.stringify(ok.error));
  assert.deepEqual(ok.data.sections.map((s: any) => s.kind), ['dataset']);
  assert.equal(typeof ok.data.sizeBytes, 'number');
  assert.match(ok.data.sha256, /^[0-9a-f]{64}$/);
});

// ─── id validation ──────────────────────────────────────────────────────────

test('id validation: every :id route refuses a malformed bundle id with 400 BAD_BUNDLE_ID', async () => {
  const { routes } = await exported();
  const bad = ['lmb-bad', 'LMB-20260923-120000-abcdef', '..%2F..%2Fetc%2Fpasswd', 'lmb-20260923-120000-abcdeg', 'x.lmbundle.gz'];
  for (const id of bad) {
    expectErr(await call(routes, 'GET', `/data/bundles/${id}`), 'BAD_BUNDLE_ID', 400);
    expectErr(await call(routes, 'GET', `/data/bundles/${id}/chunk`), 'BAD_BUNDLE_ID', 400);
    expectErr(await call(routes, 'GET', `/data/bundles/${id}/download`), 'BAD_BUNDLE_ID', 400);
    expectErr(await call(routes, 'DELETE', `/data/bundles/${id}`), 'BAD_BUNDLE_ID', 400);
    expectErr(await call(routes, 'POST', `/data/bundles/${id}/plan`), 'BAD_BUNDLE_ID', 400);
    expectErr(await call(routes, 'POST', `/data/bundles/${id}/apply`, { body: { confirm: true } }), 'BAD_BUNDLE_ID', 400);
  }
  // A well-formed id that is not stored is a 404, not a 400.
  expectErr(await call(routes, 'GET', `/data/bundles/${WELL_FORMED}`), 'BUNDLE_NOT_FOUND', 404);
  expectErr(await call(routes, 'POST', `/data/bundles/${WELL_FORMED}/plan`), 'BUNDLE_NOT_FOUND', 404);
  // received:<name> is not a bundle id on this surface; the refusal says how to import it.
  const recv = expectErr(await call(routes, 'POST', '/data/bundles/received:x.gz/plan'), 'BAD_BUNDLE_ID', 400);
  assert.match(recv.error!.message, /POST \/data\/bundles\/received\/x\.gz/);
});

// ─── chunk bounds ───────────────────────────────────────────────────────────

test('chunk: exact {offset,length,total,dataB64,done}; pages reassemble the file; bounds refused or clamped', async () => {
  const { routes, id, file } = await exported();
  const bytes = fs.readFileSync(file);

  const first = await call(routes, 'GET', `/data/bundles/${id}/chunk?offset=0&length=100`);
  assert.equal(first.success, true, JSON.stringify(first.error));
  assert.deepEqual(Object.keys(first.data).sort(), ['dataB64', 'done', 'length', 'offset', 'total']);
  assert.equal(first.data.total, bytes.length);

  const parts: Buffer[] = [];
  for (let offset = 0; ;) {
    const c = await call(routes, 'GET', `/data/bundles/${id}/chunk?offset=${offset}&length=100`);
    assert.equal(c.data.offset, offset);
    const b = Buffer.from(c.data.dataB64, 'base64');
    assert.equal(b.length, c.data.length);
    parts.push(b);
    offset += b.length;
    if (c.data.done) break;
  }
  assert.ok(Buffer.concat(parts).equals(bytes), 'paged chunks reassemble to the stored file');

  // Defaults: offset 0, the max length.
  const whole = await call(routes, 'GET', `/data/bundles/${id}/chunk`);
  assert.deepEqual([whole.data.offset, whole.data.length, whole.data.done], [0, bytes.length, true]);
  // At the end: an empty, done chunk.
  const end = await call(routes, 'GET', `/data/bundles/${id}/chunk?offset=${bytes.length}`);
  assert.deepEqual([end.data.length, end.data.dataB64, end.data.done], [0, '', true]);

  for (const q of ['offset=-1', 'offset=abc', 'offset=1.5', `offset=${bytes.length + 1}`, 'length=0', 'length=-5', 'length=x']) {
    expectErr(await call(routes, 'GET', `/data/bundles/${id}/chunk?${q}`), 'INVALID_RANGE', 400);
  }
  // Over the cap is CLAMPED, not refused.
  const big = await call(routes, 'GET', `/data/bundles/${id}/chunk?length=${10 * 1024 * 1024}`);
  assert.equal(big.success, true, JSON.stringify(big.error));
});

test('chunk: a length over 512 KiB is clamped to exactly 512 KiB on a bundle larger than that', async () => {
  const n = makeNode();
  // Random bytes, base64-encoded: gzip cannot shrink them much, so the bundle stays > 512 KiB.
  const blobs = [0, 1, 2, 3].map((i) => rec(`blob${i}`, 1, { b: crypto.randomBytes(200 * 1024).toString('base64') }));
  await ownedDataset(n, 'blobs', blobs);
  const routes = routesOf(n);
  const made = await call(routes, 'POST', '/data/bundles', { body: {} });
  assert.equal(made.success, true, JSON.stringify(made.error));
  assert.ok(made.data.sizeBytes > MAX_CHUNK_BYTES, `fixture must exceed one chunk (got ${made.data.sizeBytes})`);

  const c = await call(routes, 'GET', `/data/bundles/${made.data.bundleId}/chunk?offset=0&length=${MAX_CHUNK_BYTES * 4}`);
  assert.equal(c.success, true, JSON.stringify(c.error));
  assert.equal(c.data.length, MAX_CHUNK_BYTES);
  assert.equal(c.data.done, false);
  assert.equal(Buffer.from(c.data.dataB64, 'base64').length, MAX_CHUNK_BYTES);
});

// ─── download ───────────────────────────────────────────────────────────────

test('download: raw application/gzip attachment for direct callers; relayed callers are sent to /chunk', async () => {
  const { routes, id, file } = await exported();
  const r = await call(routes, 'GET', `/data/bundles/${id}/download`);
  assert.equal(r.success, true);
  assert.equal(r.binary, true);
  assert.ok(Buffer.isBuffer(r.data) && (r.data as Buffer).equals(fs.readFileSync(file)));
  assert.equal(r.headers!['Content-Type'], 'application/gzip');
  assert.equal(r.headers!['Content-Disposition'], `attachment; filename="${id}.lmbundle.gz"`);
  assert.equal(r.headers!['Content-Length'], String(fs.statSync(file).size));

  for (const relay of ['hub', 'peer']) {
    const refused = expectErr(await call(routes, 'GET', `/data/bundles/${id}/download`, { headers: { 'x-relay-source': relay } }),
      'DOWNLOAD_NOT_RELAYABLE', 400);
    assert.match(refused.error!.message, /\/chunk/);
  }
  expectErr(await call(routes, 'GET', `/data/bundles/${WELL_FORMED}/download`), 'BUNDLE_NOT_FOUND', 404);
});

// ─── plan / apply: the confirm gate ─────────────────────────────────────────

test('plan is a dry run; apply requires confirm:true (CONFIRM_REQUIRED 400) and then writes', async () => {
  const a = await exported();
  const b = makeNode({ store: a.n.store }); // a second node that can see the same stored bundle
  const routes = routesOf(b);

  const plan = await call(routes, 'POST', `/data/bundles/${a.id}/plan`, { body: { policy: 'add_missing', node: 'gw-b' } });
  assert.equal(plan.success, true, JSON.stringify(plan.error));
  assert.equal(plan.data.dryRun, true);
  assert.equal(plan.data.policy, 'add-missing', 'a plausible spelling is coerced');
  assert.equal(plan.data.totals.add, 3);
  assert.equal(b.datasets.get('notes'), undefined, 'plan wrote nothing');

  for (const body of [{}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }] as Array<{ confirm?: unknown }>) {
    const r = expectErr(await call(routes, 'POST', `/data/bundles/${a.id}/apply`, { body }), 'CONFIRM_REQUIRED', 400);
    if ('confirm' in body) assert.ok(r.error!.message.includes(JSON.stringify(body.confirm)), `echoes what was sent: ${r.error!.message}`);
  }
  assert.equal(b.datasets.get('notes'), undefined, 'a refused apply wrote nothing');

  const dry = expectErr(await call(routes, 'POST', `/data/bundles/${a.id}/apply`, { body: { confirm: true, dryRun: true } }), 'UNSUPPORTED_FIELD', 400);
  assert.match(dry.error!.message, /"dryRun"/);
  const planConfirm = expectErr(await call(routes, 'POST', `/data/bundles/${a.id}/plan`, { body: { confirm: true } }), 'UNSUPPORTED_FIELD', 400);
  assert.match(planConfirm.error!.message, /apply/);
  const pol = expectErr(await call(routes, 'POST', `/data/bundles/${a.id}/plan`, { body: { policy: 'spicy' } }), 'BAD_REQUEST', 400);
  assert.match(pol.error!.message, /"spicy"/);
  expectErr(await call(routes, 'POST', `/data/bundles/${a.id}/plan`, { body: { takeOwnership: 'yes' } }), 'BAD_REQUEST', 400);
  assert.equal(b.datasets.get('notes'), undefined);

  const applied = await call(routes, 'POST', `/data/bundles/${a.id}/apply`, { body: { confirm: true, datasets: ['notes'] } });
  assert.equal(applied.success, true, JSON.stringify(applied.error));
  assert.equal(applied.data.dryRun, false);
  assert.equal(applied.data.applied.add, 3);
  assert.ok(b.datasets.get('notes'), 'apply created the dataset');
});

// ─── upload ─────────────────────────────────────────────────────────────────

test('upload: chunked assembly under a new bundleId; chunks idempotent per index; conflicts and oversize refused', async () => {
  const a = await exported();
  const bytes = fs.readFileSync(a.file);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const b = makeNode();
  const routes = routesOf(b);
  const cut = [0, Math.floor(bytes.length / 3), Math.floor((2 * bytes.length) / 3), bytes.length];
  const part = (i: number) => bytes.subarray(cut[i], cut[i + 1]).toString('base64');

  const c0 = await call(routes, 'POST', '/data/bundles/upload', { body: { index: 0, total: 3, name: 'from-a.lmbundle.gz', dataB64: part(0), sha256 } });
  assert.equal(c0.success, true, JSON.stringify(c0.error));
  const uploadId = c0.data.uploadId as string;
  assert.match(uploadId, /^upl-[0-9a-f]{16}$/);
  assert.deepEqual([c0.data.received, c0.data.done], [1, false]);

  // Same bytes for the same index: a no-op. Different bytes: a conflict.
  const again = await call(routes, 'POST', '/data/bundles/upload', { body: { uploadId, index: 0, total: 3, dataB64: part(0) } });
  assert.deepEqual([again.data.received, again.data.done], [1, false]);
  expectErr(await call(routes, 'POST', '/data/bundles/upload', { body: { uploadId, index: 0, total: 3, dataB64: part(1) } }), 'UPLOAD_CONFLICT', 409);
  expectErr(await call(routes, 'POST', '/data/bundles/upload', { body: { uploadId, index: 1, total: 4, dataB64: part(1) } }), 'UPLOAD_CONFLICT', 409);
  expectErr(await call(routes, 'POST', '/data/bundles/upload', { body: { uploadId: 'upl-0000000000000000', index: 1, total: 3, dataB64: part(1) } }), 'UPLOAD_NOT_FOUND', 404);
  expectErr(await call(routes, 'POST', '/data/bundles/upload', { body: { index: 1, total: 3, dataB64: part(1) } }), 'UPLOAD_INVALID', 400);
  const huge = expectErr(await call(routes, 'POST', '/data/bundles/upload', { body: { index: 0, total: 1, dataB64: 'A'.repeat(MAX_UPLOAD_CHUNK_B64 + 4) } }), 'CHUNK_TOO_LARGE', 413);
  assert.match(huge.error!.message, new RegExp(String(MAX_UPLOAD_CHUNK_B64)));
  expectErr(await call(routes, 'POST', '/data/bundles/upload', { body: { uploadId, index: 1, total: 3, dataB64: part(1), chunk: 1 } }), 'UNSUPPORTED_FIELD', 400);

  // String integers are a plausible caller form.
  const c1 = await call(routes, 'POST', '/data/bundles/upload', { body: { uploadId, index: '1', total: '3', dataB64: part(1) } });
  assert.deepEqual([c1.data.received, c1.data.done], [2, false]);
  const c2 = await call(routes, 'POST', '/data/bundles/upload', { body: { uploadId, index: 2, total: 3, dataB64: part(2) } });
  assert.equal(c2.success, true, JSON.stringify(c2.error));
  assert.equal(c2.data.done, true);
  assert.equal(c2.data.sha256, sha256, 'stored byte-for-byte');
  assert.notEqual(c2.data.bundleId, a.id, 'stored under a NEW bundleId');

  // A retried final chunk returns the same receipt instead of storing a second copy.
  const retry = await call(routes, 'POST', '/data/bundles/upload', { body: { uploadId, index: 2, total: 3, dataB64: part(2) } });
  assert.equal(retry.data.bundleId, c2.data.bundleId);
  assert.equal((await b.store.list()).length, 1);

  const ins = await call(routes, 'GET', `/data/bundles/${c2.data.bundleId}`);
  assert.equal(ins.data.imported.via, 'upload');
  assert.equal(ins.data.imported.importedFrom, a.id);
  assert.equal(ins.data.imported.name, 'from-a.lmbundle.gz');
});

test('upload: a whole-file sha256 mismatch is refused (422) and stores nothing', async () => {
  const a = await exported();
  const b = makeNode();
  const routes = routesOf(b);
  const r = await call(routes, 'POST', '/data/bundles/upload', {
    body: { index: 0, total: 1, dataB64: fs.readFileSync(a.file).toString('base64'), sha256: 'f'.repeat(64) },
  });
  expectErr(r, 'UPLOAD_SHA_MISMATCH', 422);
  assert.equal(r.error!.details.expected, 'f'.repeat(64));
  assert.equal((await b.store.list()).length, 0);
});

// ─── received ───────────────────────────────────────────────────────────────

test('received: POST /data/bundles/received/:name adopts one inbox file; bad and missing names refused', async () => {
  const a = await exported();
  const inbox = tmp('rt-inbox-');
  const store = new BundleStore({ dir: path.join(tmp('rt-store-'), 'bundles'), receivedDir: inbox, retention: 50, freeBytes: () => 1e15 });
  const b = makeNode({ store });
  const routes = routesOf(b);
  fs.copyFileSync(a.file, path.join(inbox, 'backup-1.lmbundle.gz'));

  const r = await call(routes, 'POST', '/data/bundles/received/backup-1.lmbundle.gz');
  assert.equal(r.success, true, JSON.stringify(r.error));
  assert.equal(r.data.imported.via, 'received');
  assert.equal(r.data.imported.importedFrom, a.id);
  assert.ok(store.exists(r.data.bundleId));
  assert.ok(fs.existsSync(path.join(inbox, 'backup-1.lmbundle.gz')), 'the inbox file is left in place');

  expectErr(await call(routes, 'POST', '/data/bundles/received/no-such.gz'), 'RECEIVED_NOT_FOUND', 404);
  expectErr(await call(routes, 'POST', '/data/bundles/received/a%20b'), 'RECEIVED_NAME_INVALID', 400);
  expectErr(await call(routes, 'POST', '/data/bundles/received/..%2Fsecret'), 'RECEIVED_NAME_INVALID', 400);
  fs.writeFileSync(path.join(inbox, 'junk.gz'), 'not a bundle');
  expectErr(await call(routes, 'POST', '/data/bundles/received/junk.gz'), 'BUNDLE_FORMAT', 422);
});

// ─── fetch ──────────────────────────────────────────────────────────────────

test('fetch: pulls through the PEER\'s chunk route, verifies, stores under a new id; bad input and peer callers refused', async () => {
  const a = await exported();
  const aRoutes = a.routes;
  // The transport mirrors hub-proxy's proxyGet: the peer's JSON body on 2xx, a throw carrying
  // the body otherwise — which is how the peer's own code (e.g. BUNDLE_NOT_FOUND) comes back.
  const transportCalls: string[] = [];
  const b = makeNode({
    deps: {
      fetchTransport: {
        get: async (node, urlPath) => {
          transportCalls.push(`${node} ${urlPath}`);
          const res = await call(aRoutes, 'GET', urlPath);
          if (statusOf(res) >= 300) throw new Error(`Proxy request to ${node}${urlPath} returned ${statusOf(res)} — ${JSON.stringify(res)}`);
          return res;
        },
      },
    },
  });
  const routes = routesOf(b);

  const r = await call(routes, 'POST', '/data/bundles/fetch', { body: { fromNode: 'gw-a', bundleId: a.id } });
  assert.equal(r.success, true, JSON.stringify(r.error));
  assert.equal(r.data.fromNode, 'gw-a');
  assert.equal(r.data.sourceBundleId, a.id);
  assert.notEqual(r.data.bundleId, a.id);
  assert.equal(r.data.imported.via, 'fetch');
  assert.ok(transportCalls[0].startsWith(`gw-a /data/bundles/${a.id}/chunk?offset=0&length=`));
  assert.ok(b.store.exists(r.data.bundleId));

  expectErr(await call(routes, 'POST', '/data/bundles/fetch', { body: { fromNode: 'gw-a', bundleId: WELL_FORMED } }), 'BUNDLE_NOT_FOUND', 404);
  expectErr(await call(routes, 'POST', '/data/bundles/fetch', { body: { bundleId: a.id } }), 'BAD_REQUEST', 400);
  expectErr(await call(routes, 'POST', '/data/bundles/fetch', { body: { fromNode: 'gw-a', bundleId: 'lmb-nope' } }), 'BAD_BUNDLE_ID', 400);
  expectErr(await call(routes, 'POST', '/data/bundles/fetch', { body: { fromNode: 'gw-a', bundleId: a.id, offset: 0 } }), 'UNSUPPORTED_FIELD', 400);
  // A fabric peer reaches this path only because it has the sync-read `/data/:ds/fetch` shape.
  expectErr(await call(routes, 'POST', '/data/bundles/fetch', { body: { fromNode: 'gw-a', bundleId: a.id }, headers: { 'x-relay-source': 'peer' } }), 'FORBIDDEN', 403);
  const viaHub = await call(routes, 'POST', '/data/bundles/fetch', { body: { fromNode: 'gw-a', bundleId: a.id, node: 'gw-b' }, headers: { 'x-relay-source': 'hub' } });
  assert.equal(viaHub.success, true, 'the owner through the hub relay may fetch');
});

// ─── takeover ───────────────────────────────────────────────────────────────

test('takeover: guarded promotion with 409 refusals, force only for an unavailable roster, ids validated', async () => {
  const n = makeNode();
  await ownedDataset(n, 'owned', []);
  await replicaDataset(n, 'mirror', ORIGIN, [rec('a', 1, {}), rec('b', 2, {}, { deleted: true })]);
  const routes = routesOf(n);
  const take = (id: string, body: unknown = {}) => call(routes, 'POST', `/data/datasets/${id}/takeover`, { body });

  expectErr(await take('Bad!Id'), 'BAD_DATASET_ID', 400);
  expectErr(await take('nope'), 'NOT_FOUND', 404);
  expectErr(await take('owned'), 'NOT_A_REPLICA', 409);
  expectErr(await take('mirror', { force: 'sure' }), 'BAD_REQUEST', 400);
  expectErr(await take('mirror', { forced: true }), 'UNSUPPORTED_FIELD', 400);

  n.roster.online(ORIGIN.machineId);
  const online = expectErr(await take('mirror', { force: true }), 'ORIGIN_ONLINE', 409);
  assert.deepEqual(online.error!.details, { machineId: ORIGIN.machineId, hostname: ORIGIN.hostname });

  n.roster.unavailable = 'hub down';
  const un = expectErr(await take('mirror'), 'ROSTER_UNAVAILABLE', 409);
  assert.match(un.error!.message, /hub down/);
  assert.ok(n.datasets.get('mirror')!.origin, 'refusals change nothing');

  const forced = await take('mirror', { force: 'true', node: 'gw-self' });
  assert.equal(forced.success, true, JSON.stringify(forced.error));
  assert.equal(forced.data.forced, true);
  assert.equal(forced.data.records, 2);
  assert.equal(forced.data.tombstones, 1);
  assert.equal(n.datasets.get('mirror')!.origin, undefined);
});

// ─── error mapping ──────────────────────────────────────────────────────────

test('errors: coded service/store errors map to HTTP statuses with their details; anything else is a 500', async () => {
  let next: unknown;
  const fake: any = new Proxy({}, { get: () => async () => { throw next; } });
  const routes = createDataBundleRoutes({} as any, { service: () => fake });
  const inv = () => call(routes, 'GET', '/data/bundles/inventory');

  next = new BundleError('DISK_LOW', 'not enough free disk', undefined, { freeBytes: 1, requiredBytes: 2, estimatedBytes: 0 });
  assert.deepEqual(expectErr(await inv(), 'DISK_LOW', 507).error!.details, { freeBytes: 1, requiredBytes: 2, estimatedBytes: 0 });
  next = new BundleError('BUNDLE_CORRUPT', 'bundle corrupt (end-hash): x', 'end-hash');
  assert.equal(expectErr(await inv(), 'BUNDLE_CORRUPT', 422).error!.details.check, 'end-hash');
  next = new BundleError('BUNDLE_FORMAT', 'not a bundle', 'gzip-magic');
  expectErr(await inv(), 'BUNDLE_FORMAT', 422);
  next = new BundleError('BUNDLE_TOO_LARGE', 'too big', 'total-cap');
  expectErr(await inv(), 'BUNDLE_TOO_LARGE', 413);
  next = new BundleServiceError('FETCH_FAILED', 'peer gone');
  expectErr(await inv(), 'FETCH_FAILED', 502);
  next = new BundleServiceError('EXPORT_INCOMPLETE', 'paging stalled');
  expectErr(await inv(), 'EXPORT_INCOMPLETE', 500);
  next = new BundleServiceError('READ_ONLY_REPLICA', 'a replica');
  const plain = await inv();
  assert.equal(plain.error!.code, 'READ_ONLY_REPLICA', 'an unmapped code passes through');
  assert.equal(statusOf(plain), 400);
  next = new Error('kaboom');
  const internal = expectErr(await inv(), 'INTERNAL_ERROR', 500);
  assert.match(internal.error!.message, /kaboom/);
  next = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  expectErr(await inv(), 'INTERNAL_ERROR', 500);
});
