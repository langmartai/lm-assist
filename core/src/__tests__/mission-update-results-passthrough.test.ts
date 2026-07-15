/**
 * mission_update MCP → POST /mission/:id passthrough for the results fields
 * (mission_3922a14d requirement 3). The MCP handler forwards its args wholesale
 * (`withActorHint(a, …)`), so resultsAppend / results / resultsReplace must reach
 * handlePatch verbatim — and a rejection (UNSUPPORTED_FIELD, guidance) must surface
 * as a loud MCP error, not a silent success. workerPost is intercepted at the
 * _passthrough seam and spliced into the REAL handlePatch over a mem port, with a
 * JSON round-trip to simulate the wire, mirroring unwrapEnvelope's throw-on-failure.
 */
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as passthrough from '../mcp-server/tools/_passthrough';
import { MISSION_HANDLERS } from '../mcp-server/tools/mission';
import { handlePatch } from '../routes/core/mission.routes';
import { newMission, type Mission, type MissionActor, type MissionResult } from '../mission/mission-model';

const human: MissionActor = { kind: 'user', channel: 'user', node: 'n', at: 1 };

const mk = (id: string): Mission =>
  ({ ...newMission({ title: id, objective: 'o', ownerNode: 'n', createdBy: human }, 1, () => id), id });

function memPort(seed: Mission[]) {
  const db = new Map(seed.map((m) => [m.id, JSON.parse(JSON.stringify(m)) as Mission]));
  return {
    db,
    isEnabled: () => true,
    get: async (id: string) => { const v = db.get(id); return v ? JSON.parse(JSON.stringify(v)) : null; },
    list: async () => [...db.values()].map((m) => JSON.parse(JSON.stringify(m))),
    put: async (m: Mission) => { db.set(m.id, JSON.parse(JSON.stringify(m))); },
    del: async (id: string) => { db.delete(id); },
  };
}

/** Splice workerPost into the real handlePatch over `port`, JSON-round-tripped like the wire. */
function spliceWorkerPost(port: ReturnType<typeof memPort>) {
  const captured: Array<{ path: string; body: Record<string, unknown> }> = [];
  mock.method(passthrough, 'workerPost', async (path: string, body: Record<string, unknown>) => {
    const wire = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    captured.push({ path, body: wire });
    const id = decodeURIComponent(path.replace(/^\/mission\//, ''));
    const env = await handlePatch(id, wire, port as any, human);
    if (!env.success) throw new Error(env.error!.message); // unwrapEnvelope contract
    return env.data;
  });
  return captured;
}

afterEach(() => mock.restoreAll());

test('mission_update carries resultsAppend end-to-end: forwarded verbatim, applied, attributed', async () => {
  const port = memPort([mk('mission_pt1')]);
  const captured = spliceWorkerPost(port);
  const res = await MISSION_HANDLERS.mission_update({
    id: 'mission_pt1',
    resultsAppend: { ref: 'core/src/x.ts @ abc', summary: 'delivered' },
  });
  assert.notEqual((res as { isError?: boolean }).isError, true, JSON.stringify(res));
  assert.equal(captured.length, 1);
  assert.equal(captured[0].path, '/mission/mission_pt1');
  assert.deepEqual(captured[0].body.resultsAppend, { ref: 'core/src/x.ts @ abc', summary: 'delivered' }, 'field reaches the route verbatim');
  assert.equal((captured[0].body._actor as { channel?: string }).channel, 'mcp', 'actor hint rides along');
  const m = port.db.get('mission_pt1')!;
  assert.equal(m.results.length, 1);
  assert.equal(m.results[0].ref, 'core/src/x.ts @ abc');
  assert.ok((m.results[0] as MissionResult).by, 'entry actor-attributed');
  assert.equal(m.rev, 2, 'tracked-field rev bump through the MCP path');
});

test('mission_update carries results + resultsReplace end-to-end (human replace applies)', async () => {
  const port = memPort([mk('mission_pt2')]);
  port.db.get('mission_pt2')!.results = [{ at: 1, ref: 'old.ts', summary: 'old' }];
  spliceWorkerPost(port);
  const res = await MISSION_HANDLERS.mission_update({
    id: 'mission_pt2',
    results: [{ ref: 'curated.ts', summary: 'kept', at: 42 }],
    resultsReplace: true,
  });
  assert.notEqual((res as { isError?: boolean }).isError, true, JSON.stringify(res));
  const m = port.db.get('mission_pt2')!;
  assert.equal(m.results.length, 1);
  assert.equal(m.results[0].ref, 'curated.ts');
  assert.equal(m.results[0].at, 42, 'given at preserved through the MCP path');
});

test('mission_update surfaces route rejections loudly (UNSUPPORTED_FIELD + replace guidance)', async () => {
  const port = memPort([mk('mission_pt3')]);
  spliceWorkerPost(port);

  const r1 = await MISSION_HANDLERS.mission_update({ id: 'mission_pt3', control: { nudgeCount: 9 } });
  assert.equal((r1 as { isError?: boolean }).isError, true, 'unknown field must be an MCP error, not silent success');
  const t1 = JSON.stringify(r1);
  assert.match(t1, /unsupported field/i);
  assert.match(t1, /control/);

  const r2 = await MISSION_HANDLERS.mission_update({ id: 'mission_pt3', results: [{ ref: 'r.ts', summary: 's' }] });
  assert.equal((r2 as { isError?: boolean }).isError, true, 'replace without the flag must error');
  assert.match(JSON.stringify(r2), /resultsAppend/, 'guidance reaches the MCP caller');

  assert.equal(port.db.get('mission_pt3')!.results.length, 0, 'nothing applied by rejected calls');
  assert.equal(port.db.get('mission_pt3')!.rev, 1);
});
