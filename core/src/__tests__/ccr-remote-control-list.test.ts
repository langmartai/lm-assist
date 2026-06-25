import { test } from 'node:test';
import assert from 'node:assert';
import { handleRemoteControlList } from '../routes/core/ccr.routes';

const mkMission = (over: any): any => ({
  id: 'mission_abc', title: 'Build dashboard', binding: null, status: 'active',
  objective: 'o', projects: [], dependsOn: [], env: {}, progress: null,
  control: {}, results: [], adjustments: [], ...over,
});

test('remote-control list: controller named + executors named from the store', async () => {
  const env = await handleRemoteControlList({
    getController: async () => ({ sessionId: 'uuid-ctrl', cse: null, tmux: 'lmcc-x', node: 'gw1', startedAt: 100 }),
    listMissions: async () => [
      mkMission({ id: 'mission_abc', title: 'Build dashboard', binding: { sessionId: 'session_exec1', ccr: { sid: 'cse_exec1' } } }),
      mkMission({ id: 'mission_def', title: 'No binding yet', binding: null }),
    ],
    listAccount: async () => [{ sid: 'cse_other', status: 'active', title: 'Some other RC' }],
  });
  assert.equal((env as any).success, true);
  const d = (env as any).data;
  assert.equal(d.controller.title, 'Mission Controller');
  assert.equal(d.controller.sid, 'uuid-ctrl');
  assert.equal(d.executors.length, 1, 'only the bound mission is an executor');
  assert.equal(d.executors[0].title, 'Mission: Build dashboard · abc');
  assert.equal(d.executors[0].cse, 'cse_exec1');
  assert.deepEqual(d.accountRc, [{ sid: 'cse_other', status: 'active', title: 'Some other RC' }]);
});

test('remote-control list: no controller → controller null; account failure → empty', async () => {
  const env = await handleRemoteControlList({
    getController: async () => null,
    listMissions: async () => [],
    listAccount: async () => { throw new Error('OAuth down'); },
  });
  const d = (env as any).data;
  assert.equal(d.controller, null);
  assert.deepEqual(d.executors, []);
  assert.deepEqual(d.accountRc, []);
});
