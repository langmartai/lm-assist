import { test } from 'node:test';
import assert from 'node:assert';
import { readOnboardedSignal, type OnboardedReadDeps } from '../mission/mission-controller';
import { buildOnboardMission, MISSION_CONTROL_MARKER } from '../mission/mission-onboard';
import type { MissionActor } from '../mission/mission-model';

const who: MissionActor = { kind: 'user', channel: 'mcp', at: 1 };
const msgs = (arr: Array<[string, string]>) => arr.map(([role, text]) => ({ role, text }));

function deps(over: Partial<OnboardedReadDeps> = {}): OnboardedReadDeps {
  return {
    selfNode: () => 'n1',
    readLocalConversation: async () => ({ messages: msgs([['user', 'start'], ['assistant', 'working']]) }),
    verdict: () => ({ driveable: true }),
    proxyRead: async () => { throw new Error('not expected'); },
    proxyStatus: async () => { throw new Error('not expected'); },
    ...over,
  };
}

test('local native: cursor advances, human plain prompt flags humanActive', async () => {
  const m = buildOnboardMission({ sid: 'u1', node: 'n1', transport: 'native', mode: 'handoff', crossCluster: false, ownerNode: 'n1', createdBy: who }, 1, () => 'mission_o1');
  m.control.lastOutputCursor = 1;
  const s = await readOnboardedSignal(m, deps({
    readLocalConversation: async () => ({ messages: msgs([['user', 'start'], ['user', 'please also handle errors']]) }),
  }));
  assert.equal(s.alive, true);
  assert.equal(s.cursor, 2);
  assert.deepEqual(s.newLines, ['please also handle errors']);
  assert.equal(s.humanActive, true);
});

test('marker-prefixed drives are NOT humanActive', async () => {
  const m = buildOnboardMission({ sid: 'u1', node: 'n1', transport: 'native', mode: 'handoff', crossCluster: false, ownerNode: 'n1', createdBy: who }, 1, () => 'mission_o2');
  const s = await readOnboardedSignal(m, deps({
    readLocalConversation: async () => ({ messages: msgs([[ 'user', `${MISSION_CONTROL_MARKER} continue`]]) }),
  }));
  assert.equal(s.humanActive, false);
});

test('remote native routes through proxyRead/proxyStatus', async () => {
  const m = buildOnboardMission({ sid: 'u1', node: 'n2', transport: 'native', mode: 'handoff', crossCluster: false, ownerNode: 'n1', createdBy: who }, 1, () => 'mission_o3');
  let readNode = ''; let statusNode = '';
  const s = await readOnboardedSignal(m, deps({
    proxyRead: async (node) => { readNode = node; return { messages: msgs([['user', 'hi from remote']]) }; },
    proxyStatus: async (node) => { statusNode = node; return { alive: true }; },
  }));
  assert.equal(readNode, 'n2');
  assert.equal(statusNode, 'n2');
  assert.equal(s.humanActive, true);
});

test('remote status/read failure degrades to alive (grace), no throw', async () => {
  const m = buildOnboardMission({ sid: 'u1', node: 'n2', transport: 'native', mode: 'standby', crossCluster: false, ownerNode: 'n1', createdBy: who }, 1, () => 'mission_o4');
  const s = await readOnboardedSignal(m, deps({
    proxyRead: async () => { throw new Error('net'); },
    proxyStatus: async () => { throw new Error('net'); },
  }));
  assert.equal(s.alive, true);
  assert.equal(s.cursor, 0);
  assert.equal(s.humanActive, false);
});
