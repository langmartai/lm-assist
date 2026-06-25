import { test } from 'node:test';
import assert from 'node:assert';
import { Mission } from '../mission/mission-model';
import { MissionDataPort } from '../mission/mission-store';
import { handleCreate, handleList, handlePatch, LeaderAnchorDeps } from '../routes/core/mission.routes';

function fakePort(): MissionDataPort {
  const map = new Map<string, Mission>();
  return {
    isEnabled: () => true,
    get: async (id) => map.get(id) ?? null,
    list: async () => [...map.values()],
    put: async (m) => { map.set(m.id, JSON.parse(JSON.stringify(m))); },
    del: async (id) => { map.delete(id); },
  };
}

const leaderStub = (isMonitor: boolean, calls: any[]): LeaderAnchorDeps => ({
  getElection: async () => ({ isMonitor, monitorNodeId: isMonitor ? 'self' : 'gw-leader' }),
  proxyGet: async (node, path) => { calls.push(['GET', node, path]); return { success: true, data: [{ id: 'mission_remote' }] }; },
  proxyPost: async (node, path, body) => { calls.push(['POST', node, path, body]); return { success: true, data: { id: 'mission_remote', ...(body as object) } }; },
});

test('handleCreate on a NON-leader → proxies to the leader (does not write locally)', async () => {
  const port = fakePort();
  const calls: any[] = [];
  const env = await handleCreate({ title: 'T', objective: 'O' }, 'gw-self', port, undefined, leaderStub(false, calls));
  assert.equal((env as any).success, true);
  assert.equal((env as any).data.id, 'mission_remote', 'returned the leader proxy result');
  assert.deepEqual(calls[0].slice(0, 3), ['POST', 'gw-leader', '/mission']);
  assert.equal((await port.list()).length, 0, 'nothing written to the local store');
});

test('handleCreate on the LEADER → handles locally (no proxy)', async () => {
  const port = fakePort();
  const calls: any[] = [];
  const env = await handleCreate({ title: 'Local', objective: 'O' }, 'gw-self', port, undefined, leaderStub(true, calls));
  assert.equal((env as any).success, true);
  assert.equal(calls.length, 0, 'no proxy call on the leader');
  assert.equal((await port.list()).length, 1, 'written to the local (leader) store');
});

test('handleList on a NON-leader → returns the leader list via proxy', async () => {
  const port = fakePort();
  const calls: any[] = [];
  const env = await handleList(port, leaderStub(false, calls));
  assert.deepEqual((env as any).data, [{ id: 'mission_remote' }]);
  assert.deepEqual(calls[0], ['GET', 'gw-leader', '/mission']);
});

test('handlePatch on a NON-leader → proxies POST /mission/:id', async () => {
  const port = fakePort();
  const calls: any[] = [];
  const env = await handlePatch('mission_x', { title: 'New' }, port, undefined, leaderStub(false, calls));
  assert.equal((env as any).success, true);
  assert.deepEqual(calls[0].slice(0, 3), ['POST', 'gw-leader', '/mission/mission_x']);
});

test('no leader dep (tests/direct) → always local', async () => {
  const port = fakePort();
  const env = await handleCreate({ title: 'T', objective: 'O' }, 'gw-self', port);
  assert.equal((env as any).success, true);
  assert.equal((await port.list()).length, 1, 'local create when no anchor provided');
});
