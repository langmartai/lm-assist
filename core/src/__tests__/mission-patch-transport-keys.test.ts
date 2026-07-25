/** `node` is the connector's ROUTING parameter — it rides along on every relayed MCP
 *  call (`{"node":"gw4-…", …}` appears in the args of literally every entry in
 *  mcp-calls.jsonl) and is consumed at the hub, long before the worker route sees it.
 *  `mission_update` forwarded its raw args, so the whitelist met a leftover transport
 *  key and refused the WHOLE write:
 *
 *    2026-07-25T00:51:54.266Z  mission_update  46ms
 *      Error: unsupported field(s): "node" — supported: title, objective, plan, …
 *
 *  `cluster` was already consumed as a routing hint here; `node` simply never was.
 *  The UNSUPPORTED_FIELD guard itself is correct and must stay (the assist-content
 *  200-noop lesson) — only the KNOWN transport keys are stripped. */
import { test } from 'node:test';
import assert from 'node:assert';
import { handleCreate, handlePatch } from '../routes/core/mission.routes';
import type { Mission, MissionActor } from '../mission/mission-model';

const actor: MissionActor = { kind: 'user', channel: 'user', node: 'n', at: 1 };
function memPort() {
  const db = new Map<string, Mission>();
  return {
    db,
    get: async (id: string) => { const v = db.get(id); return v ? JSON.parse(JSON.stringify(v)) : null; },
    list: async () => [...db.values()],
    put: async (m: Mission) => { db.set(m.id, JSON.parse(JSON.stringify(m))); },
  };
}
const mk = async (port: ReturnType<typeof memPort>) =>
  (await handleCreate({ title: 't', objective: 'o' }, 'n', port as any, actor)).data as Mission;

test('THE incident: a patch carrying the connector routing key `node` applies instead of refusing', async () => {
  const port = memPort();
  const m = await mk(port);
  const r = await handlePatch(m.id, { node: 'gw4-332c6620-92db-4d57-99dc-db49f29faa39', progress: { percent: 50 } }, port as any, actor);
  assert.equal(r.success, true, JSON.stringify(r.error));
  assert.equal((r.data as Mission).progress!.percent, 50);
});

test('`node` is stripped as transport, never stored as a mission field', async () => {
  const port = memPort();
  const m = await mk(port);
  await handlePatch(m.id, { node: 'gw-x', title: 't2' }, port as any, actor);
  const stored = port.db.get(m.id) as unknown as Record<string, unknown>;
  assert.equal(stored.node, undefined, 'the routing hint must not leak into the mission');
  assert.equal(stored.title, 't2');
});

test('a genuine unknown field is STILL refused, and the message names the transport keys', async () => {
  const port = memPort();
  const m = await mk(port);
  const r = await handlePatch(m.id, { node: 'gw-x', objectve: 'typo' }, port as any, actor);
  assert.equal(r.success, false, 'a real typo must not be silently dropped');
  assert.equal(r.error!.code, 'UNSUPPORTED_FIELD');
  assert.match(r.error!.message, /objectve/);
  assert.ok(!/"node"/.test(r.error!.message), 'node was consumed, so it is not part of the complaint');
});
