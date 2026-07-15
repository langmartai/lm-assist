/**
 * Registry store (spec §4.2) — workflow-store mirror over an in-memory port:
 * rev/history semantics, merge-on-put, protected-disable refusal (store-level so
 * EVERY write path is covered), rollback from inline full-state history entries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_REGISTRY_DATASET,
  getToolDoc,
  listToolDocs,
  putToolDoc,
  rollbackToolDoc,
  type ToolRegistryPort,
} from '../mcp-server/registry/store';
import { TOOL_REGISTRY_HISTORY_CAP, type ToolRegistryDoc } from '../mcp-server/registry/model';
import type { MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'api', node: 'gw-117', at: 1 };

function memPort(): ToolRegistryPort & { docs: Map<string, ToolRegistryDoc>; puts: () => number } {
  const docs = new Map<string, ToolRegistryDoc>();
  let puts = 0;
  return {
    docs,
    puts: () => puts,
    isEnabled: () => true,
    get: async (name) => docs.get(name) ?? null,
    list: async () => [...docs.values()],
    put: async (d) => { puts++; docs.set(d.name, d); },
  };
}

test('dataset id matches the spec', () => {
  assert.equal(TOOL_REGISTRY_DATASET, 'mcp-tool-registry');
});

test('putToolDoc creates rev 1 with defaults for omitted fields', async () => {
  const port = memPort();
  const { doc, changed } = await putToolDoc({ name: 'detail', descriptionOverride: 'better words' }, actor, port);
  assert.equal(changed, true);
  assert.equal(doc.rev, 1);
  assert.equal(doc.enabled, true, 'enabled defaults true');
  assert.equal(doc.descriptionOverride, 'better words');
  assert.equal(doc.history.length, 1);
  assert.deepEqual(doc.history[0].state, { descriptionOverride: 'better words', enabled: true });
  assert.equal(doc.createdBy, actor);
});

test('putToolDoc merges over the existing doc: omitted field keeps its value', async () => {
  const port = memPort();
  await putToolDoc({ name: 'search', descriptionOverride: 'o1' }, actor, port);
  const { doc } = await putToolDoc({ name: 'search', enabled: false }, actor, port);
  assert.equal(doc.rev, 2);
  assert.equal(doc.descriptionOverride, 'o1', 'override kept when omitted');
  assert.equal(doc.enabled, false);
  const { doc: d3 } = await putToolDoc({ name: 'search', descriptionOverride: null }, actor, port);
  assert.equal(d3.rev, 3);
  assert.equal(d3.descriptionOverride, null, 'null explicitly clears');
  assert.equal(d3.enabled, false, 'enabled kept when omitted');
});

test('putToolDoc no-ops when nothing changes', async () => {
  const port = memPort();
  await putToolDoc({ name: 'search', descriptionOverride: 'o' }, actor, port);
  const before = port.puts();
  const { changed, doc } = await putToolDoc({ name: 'search', descriptionOverride: 'o', enabled: true }, actor, port);
  assert.equal(changed, false);
  assert.equal(doc.rev, 1);
  assert.equal(port.puts(), before, 'no write on no-op');
});

test('history entries carry full state and are capped', async () => {
  const port = memPort();
  for (let i = 1; i <= TOOL_REGISTRY_HISTORY_CAP + 5; i++) {
    await putToolDoc({ name: 'search', descriptionOverride: `o${i}` }, actor, port);
  }
  const doc = (await getToolDoc('search', port))!;
  assert.equal(doc.rev, TOOL_REGISTRY_HISTORY_CAP + 5);
  assert.equal(doc.history.length, TOOL_REGISTRY_HISTORY_CAP, 'capped');
  const last = doc.history[doc.history.length - 1];
  assert.equal(last.rev, doc.rev);
  assert.deepEqual(last.state, { descriptionOverride: `o${doc.rev}`, enabled: true });
  // description change summarized as byte lengths, not full text (workflow idiom)
  assert.match(String(last.changes.descriptionOverride?.from), /^len:/);
});

test('protected tools refuse enabled:false at the store level', async () => {
  const port = memPort();
  for (const name of ['bootstrap', 'guide', 'session_status']) {
    await assert.rejects(
      putToolDoc({ name, enabled: false }, actor, port),
      (e: Error & { code?: string }) => e.code === 'PROTECTED_TOOL',
      name,
    );
  }
  assert.equal(port.puts(), 0, 'nothing persisted');
});

test('protected tools still accept a description override', async () => {
  const port = memPort();
  const { doc } = await putToolDoc({ name: 'guide', descriptionOverride: 'friendlier guide' }, actor, port);
  assert.equal(doc.descriptionOverride, 'friendlier guide');
  assert.equal(doc.enabled, true);
});

test('invalid names and oversized overrides are rejected with coded errors', async () => {
  const port = memPort();
  await assert.rejects(putToolDoc({ name: 'Bad.Name' }, actor, port), (e: any) => e.code === 'INVALID_INPUT');
  await assert.rejects(
    putToolDoc({ name: 'detail', descriptionOverride: 'x'.repeat(3000) }, actor, port),
    (e: any) => e.code === 'OVERRIDE_TOO_LARGE',
  );
});

test('unknown/fake tool names are storable (mixed-version fleets + e2e scratch doc)', async () => {
  const port = memPort();
  const { doc } = await putToolDoc({ name: 'zz-e2e-probe', descriptionOverride: 'scratch' }, actor, port);
  assert.equal(doc.name, 'zz-e2e-probe');
  assert.equal((await listToolDocs(port)).length, 1);
});

test('rollback restores the state of an earlier rev as a NEW rev', async () => {
  const port = memPort();
  await putToolDoc({ name: 'search', descriptionOverride: 'v1' }, actor, port);        // rev 1
  await putToolDoc({ name: 'search', descriptionOverride: 'v2', enabled: false }, actor, port); // rev 2
  const r = await rollbackToolDoc('search', 1, actor, port);
  assert.ok(!('error' in r), JSON.stringify(r));
  if (!('error' in r)) {
    assert.equal(r.doc.rev, 3, 'rollback is a new revision');
    assert.equal(r.doc.descriptionOverride, 'v1');
    assert.equal(r.doc.enabled, true);
  }
});

test('rollback to a rev not in history → NOT_FOUND envelope', async () => {
  const port = memPort();
  await putToolDoc({ name: 'search', descriptionOverride: 'v1' }, actor, port);
  const r = await rollbackToolDoc('search', 99, actor, port);
  assert.ok('error' in r && r.error.code === 'NOT_FOUND');
  const r2 = await rollbackToolDoc('never-stored', 1, actor, port);
  assert.ok('error' in r2 && r2.error.code === 'NOT_FOUND');
});

test('rollback that would disable a protected tool is refused', async () => {
  const port = memPort();
  // Forge a doc whose history contains enabled:false for a protected tool (e.g. written
  // by a build that predates protection) — restoring it must still be refused today.
  const forged: ToolRegistryDoc = {
    name: 'guide', descriptionOverride: null, enabled: true, rev: 2,
    history: [
      { rev: 1, at: 1, actor, state: { descriptionOverride: null, enabled: false }, changes: {} },
      { rev: 2, at: 2, actor, state: { descriptionOverride: null, enabled: true }, changes: {} },
    ],
    createdBy: actor, lastUpdatedBy: actor, createdAt: 1, updatedAt: 2,
  };
  port.docs.set('guide', forged);
  await assert.rejects(rollbackToolDoc('guide', 1, actor, port), (e: any) => e.code === 'PROTECTED_TOOL');
});

test('writes throw a coded error when the data service is disabled', async () => {
  const port: ToolRegistryPort = {
    isEnabled: () => false,
    get: async () => null,
    list: async () => [],
    put: async () => { throw new Error('unreachable'); },
  };
  await assert.rejects(
    putToolDoc({ name: 'detail', descriptionOverride: 'x' }, actor, port),
    (e: any) => e.code === 'DATA_SERVICE_DISABLED',
  );
});

test('getToolDoc / listToolDocs read through the port', async () => {
  const port = memPort();
  assert.equal(await getToolDoc('detail', port), null);
  await putToolDoc({ name: 'detail', descriptionOverride: 'x' }, actor, port);
  assert.equal((await getToolDoc('detail', port))?.descriptionOverride, 'x');
  assert.equal((await listToolDocs(port)).length, 1);
});

// --- concurrent-writer serialization (origin-anchored ⇒ one process sees all writes) ---

test('two concurrent putToolDoc on the same name serialize: sequential revs, no lost update', async () => {
  // A port whose get() yields the event loop, forcing the interleaving window a
  // naive read-modify-write loses an update in.
  const docs = new Map<string, ToolRegistryDoc>();
  const port: ToolRegistryPort = {
    isEnabled: () => true,
    get: async (name) => { await new Promise((r) => setImmediate(r)); return docs.get(name) ?? null; },
    list: async () => [...docs.values()],
    put: async (d) => { await new Promise((r) => setImmediate(r)); docs.set(d.name, d); },
  };
  const [a, b] = await Promise.all([
    putToolDoc({ name: 'detail', enabled: false }, actor, port),
    putToolDoc({ name: 'detail', descriptionOverride: 'concurrent override' }, actor, port),
  ]);
  const revs = [a.doc.rev, b.doc.rev].sort();
  assert.deepEqual(revs, [1, 2], `expected sequential revs, got ${revs}`);
  const final = docs.get('detail')!;
  assert.equal(final.rev, 2);
  assert.equal(final.history.length, 2, 'both writes recorded in history');
  // The second write merged on top of the first — neither edit was lost.
  assert.equal(final.enabled, false, 'first write (disable) survived');
  assert.equal(final.descriptionOverride, 'concurrent override', 'second write (override) survived');
});

// --- malformed docs (hand-authored via data_put / foreign builds) ------------------

test('rollbackToolDoc returns NOT_FOUND (not TypeError) for a doc missing its history array', async () => {
  const port = memPort();
  port.docs.set('detail', {
    name: 'detail', descriptionOverride: null, enabled: true, rev: 3,
    createdBy: actor, lastUpdatedBy: actor, createdAt: 1, updatedAt: 1,
  } as unknown as ToolRegistryDoc); // hand-authored record without `history`
  const r = await rollbackToolDoc('detail', 1, actor, port);
  assert.ok('error' in r, 'refusal envelope, no throw');
  assert.equal((r as { error: { code: string } }).error.code, 'NOT_FOUND');
});
