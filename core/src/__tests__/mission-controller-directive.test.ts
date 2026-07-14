import { test } from 'node:test';
import assert from 'node:assert';
import { runSupervisorTick, CONTROLLER_PASS_DIRECTIVE, CONTROLLER_SYSTEM_PROMPT, type SupervisorDeps } from '../mission/mission-controller';

function baseDeps(overrides: Partial<SupervisorDeps>): SupervisorDeps {
  const cs = { node: 'n1', sessionId: 'uuid-1', cse: null, tmux: 't', startedAt: 1, lastDriveAt: undefined } as any;
  return {
    amMonitor: async () => ({ isMonitor: true, monitorNodeId: 'n1' }),
    getControllerSession: async () => cs,
    putControllerSession: async () => {},
    isLive: () => true,
    launch: async () => cs,
    drive: async () => {},
    teardown: async () => {},
    driveIntervalMin: 5,
    now: 10 * 60_000,
    ...overrides,
  } as SupervisorDeps;
}

test('drive uses the injected passDirective render', async () => {
  let sent = '';
  const deps = baseDeps({
    drive: async (_cs, directive) => { sent = directive ?? ''; },
    passDirective: async () => 'RENDERED-PASS',
  });
  const r = await runSupervisorTick(deps);
  assert.equal(r.action, 'drive');
  assert.equal(sent, 'RENDERED-PASS');
});

test('passDirective failure falls back to the TS const', async () => {
  let sent = '';
  const deps = baseDeps({
    drive: async (_cs, directive) => { sent = directive ?? ''; },
    passDirective: async () => { throw new Error('registry down'); },
  });
  await runSupervisorTick(deps);
  assert.equal(sent, CONTROLLER_PASS_DIRECTIVE);
});

test('roster-change still overrides with the roster directive', async () => {
  // engagement deps present, roster changed → CONTROLLER_ROSTER_CHANGED_DIRECTIVE regardless of passDirective
  let sent = '';
  const deps = baseDeps({
    drive: async (_cs, directive) => { sent = directive ?? ''; },
    passDirective: async () => 'RENDERED-PASS',
    listActiveForEngage: async () => [],
    readSignal: async () => ({ alive: true, gated: false, cursor: 0, newLines: [] }),
    getEngagement: async () => ({ lastEngagedAt: 1, lastActiveIds: [], seen: {}, lastRosterKey: 'old' }),
    putEngagement: async () => {},
    rosterKey: async () => 'new',
  });
  await runSupervisorTick(deps);
  assert.ok(sent.startsWith('⟦CLUSTER ROSTER CHANGED⟧'));
});

test('system prompt points at the workflow registry', () => {
  assert.ok(CONTROLLER_SYSTEM_PROMPT.includes('mission_workflow_get'));
  assert.ok(CONTROLLER_SYSTEM_PROMPT.includes('workflow registry') || CONTROLLER_SYSTEM_PROMPT.includes('mission-workflows'));
});
