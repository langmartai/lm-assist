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
  m.control.lastOutputCursor = 0; // past first-read baseline — isolates marker-detection, not baseline behavior
  const s = await readOnboardedSignal(m, deps({
    readLocalConversation: async () => ({ messages: msgs([[ 'user', `${MISSION_CONTROL_MARKER} continue`]]) }),
  }));
  assert.equal(s.humanActive, false);
});

test('remote native routes through proxyRead/proxyStatus', async () => {
  const m = buildOnboardMission({ sid: 'u1', node: 'n2', transport: 'native', mode: 'handoff', crossCluster: false, ownerNode: 'n1', createdBy: who }, 1, () => 'mission_o3');
  m.control.lastOutputCursor = 0; // past first-read baseline — isolates cross-node routing, not baseline behavior
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
  m.control.lastOutputCursor = 0; // past first-read baseline — isolates the transient-failure grace path
  const s = await readOnboardedSignal(m, deps({
    proxyRead: async () => { throw new Error('net'); },
    proxyStatus: async () => { throw new Error('net'); },
  }));
  assert.equal(s.alive, true);
  assert.equal(s.cursor, 0);
  assert.equal(s.humanActive, false);
});

// ── I2 — first-read baseline (no lastOutputCursor → no humanActive, cursor set, empty newLines) ──

test('I2: first-ever read (no lastOutputCursor) baselines silently — no humanActive, cursor=len, empty newLines', async () => {
  const m = buildOnboardMission({ sid: 'u1', node: 'n1', transport: 'native', mode: 'handoff', crossCluster: false, ownerNode: 'n1', createdBy: who }, 1, () => 'mission_o5');
  assert.equal(m.control.lastOutputCursor, undefined, 'precondition: a freshly-onboarded mission has no lastOutputCursor yet');
  const s = await readOnboardedSignal(m, deps({
    // A long pre-onboard history INCLUDING plain human text — must NOT flag humanActive on
    // the very first read (it would be re-litigating history the controller never missed).
    readLocalConversation: async () => ({ messages: msgs([
      ['user', 'kick off the feature'],
      ['assistant', 'working on it'],
      ['user', 'also handle the edge case'],
    ]) }),
  }));
  assert.equal(s.humanActive, false, 'first-ever read must never flag pre-onboard history as human activity');
  assert.equal(s.cursor, 3, 'cursor baselines to the full pre-onboard transcript length');
  assert.deepEqual(s.newLines, [], 'no lines are treated as "new" on the baseline read');
  assert.equal(s.alive, true);
});

// ── I2 — second-read delta (with lastOutputCursor set → only fresh msgs) ──

test('I2: second read (lastOutputCursor set) only surfaces messages PAST the cursor', async () => {
  const m = buildOnboardMission({ sid: 'u1', node: 'n1', transport: 'native', mode: 'handoff', crossCluster: false, ownerNode: 'n1', createdBy: who }, 1, () => 'mission_o6');
  m.control.lastOutputCursor = 3; // simulates the baseline from the prior (first) read
  const s = await readOnboardedSignal(m, deps({
    readLocalConversation: async () => ({ messages: msgs([
      ['user', 'kick off the feature'],
      ['assistant', 'working on it'],
      ['user', 'also handle the edge case'],
      ['assistant', 'done with the edge case'],
      ['user', 'one more thing please'],
    ]) }),
  }));
  assert.equal(s.cursor, 5);
  assert.deepEqual(s.newLines, ['done with the edge case', 'one more thing please'], 'only messages past the persisted cursor are "new"');
  assert.equal(s.humanActive, true, '"one more thing please" is a fresh plain human prompt');
});

// ── I2 — shrunk transcript → baseline reset ──

test('I2: shrunk transcript (lastOutputCursor > messages.length) resets to baseline, no newLines/humanActive', async () => {
  const m = buildOnboardMission({ sid: 'u1', node: 'n1', transport: 'native', mode: 'handoff', crossCluster: false, ownerNode: 'n1', createdBy: who }, 1, () => 'mission_o7');
  m.control.lastOutputCursor = 10; // stale high-water mark from BEFORE the transcript shrank
  const s = await readOnboardedSignal(m, deps({
    readLocalConversation: async () => ({ messages: msgs([
      ['user', 'shorter transcript now'],
      ['assistant', 'ok'],
    ]) }),
  }));
  assert.equal(s.cursor, 2, 'cursor resets to the (shrunk) current transcript length');
  assert.deepEqual(s.newLines, [], 'a backward cursor must not attempt a negative/nonsensical slice');
  assert.equal(s.humanActive, false, 'a baseline reset never flags humanActive');
  assert.equal(s.alive, true);
});
