import { test } from 'node:test';
import assert from 'node:assert';
import { handleSessionDrive, handleSessionRead, handlePatch, handleSessionControl } from '../routes/core/mission.routes';
import { buildOnboardMission, MISSION_CONTROL_MARKER } from '../mission/mission-onboard';
import type { MissionActor, Mission } from '../mission/mission-model';

const user: MissionActor = { kind: 'user', channel: 'mcp', at: 1 };
const ctrl: MissionActor = { kind: 'controller', channel: 'controller', at: 1 };

function onboarded(mode: 'handoff' | 'standby'): Mission {
  return buildOnboardMission({ sid: 'uuid-1', node: 'n1', transport: 'native', mode, crossCluster: false, ownerNode: 'n1', createdBy: user }, 1, () => 'mission_ob');
}

function driveDeps(m: Mission | null) {
  const sent: string[] = [];
  const deps = {
    resolve: () => ({ sid: 'uuid-1', transport: 'native' as const, missionId: m?.id ?? null, role: 'worker' as const }),
    cloudRead: async () => ({ messages: [] }),
    cloudDrive: async () => ({ delivered: true }),
    cloudStop: async () => ({ stopped: true }),
    nativeRead: async () => ({ messages: [] }),
    nativeRawMessages: async () => [],
    nativeDrive: async (_sid: string, text: string) => { sent.push(text); },
    nativeInterrupt: async () => {},
    nativeStop: async () => {},
    clearController: async () => {},
    getControllerSession: async () => null,
    findMission: async () => m,
    // I1: these tests exercise the drive-mode rails (marker prefix / standby rejection) locally —
    // pin selfNode to the fixture mission's own binding.node ('n1') so autoResolveOnboardedNode
    // sees self === binding.node and does NOT proxy away (I1's cross-node routing has its own
    // dedicated tests below).
    selfNode: () => 'n1',
  } as any;
  return { deps, sent };
}

test('standby drive rejected at the route', async () => {
  const { deps } = driveDeps(onboarded('standby'));
  const r = await handleSessionDrive('uuid-1', 'do things', deps);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'STANDBY_MODE');
});

test('handoff drive is marker-prefixed exactly once', async () => {
  const { deps, sent } = driveDeps(onboarded('handoff'));
  await handleSessionDrive('uuid-1', 'do things', deps);
  await handleSessionDrive('uuid-1', `${MISSION_CONTROL_MARKER} again`, deps);
  assert.equal(sent[0], `${MISSION_CONTROL_MARKER} do things`);
  assert.equal(sent[1], `${MISSION_CONTROL_MARKER} again`);
});

test('non-onboarded drive untouched', async () => {
  const { deps, sent } = driveDeps(null);
  await handleSessionDrive('uuid-1', 'plain', deps);
  assert.equal(sent[0], 'plain');
});

test('manageMode patch: human ok, controller forbidden, non-onboarded invalid', async () => {
  const m = onboarded('standby');
  const port = { isEnabled: () => true, get: async () => m, list: async () => [m], put: async (x: Mission) => { Object.assign(m, x); }, del: async () => {} } as any;
  const okFlip = await handlePatch(m.id, { manageMode: 'handoff' }, port, user);
  assert.equal(okFlip.success, true);
  assert.equal((okFlip.data as any).manageMode, 'handoff');
  const denied = await handlePatch(m.id, { manageMode: 'standby' }, port, ctrl);
  assert.equal(denied.success, false);
  assert.equal(denied.error!.code, 'FORBIDDEN');
  const plainPort = { isEnabled: () => true, get: async () => ({ ...m, origin: undefined }), list: async () => [], put: async () => {}, del: async () => {} } as any;
  const invalid = await handlePatch(m.id, { manageMode: 'handoff' }, plainPort, user);
  assert.equal(invalid.error!.code, 'INVALID_INPUT');
});

// ── I1: controller tools auto-resolve node for an onboarded mission bound elsewhere ─────────

/** An onboarded mission whose binding.node is 'n2' (a DIFFERENT node than this test's 'self'='n1'). */
function onboardedOnNode2(mode: 'handoff' | 'standby' = 'handoff'): Mission {
  return buildOnboardMission({ sid: 'uuid-remote-1', node: 'n2', transport: 'native', mode, crossCluster: false, ownerNode: 'n1', createdBy: user }, 1, () => 'mission_ob_n2');
}

function proxyCapture() {
  const calls: Array<{ node: string; path: string; body: unknown }> = [];
  const proxyDeps = {
    proxyPost: async (node: string, path: string, body: unknown) => {
      calls.push({ node, path, body });
      return { success: true, data: { proxied: true } };
    },
  };
  return { proxyDeps, calls };
}

test('I1: drive with no node + onboarded mission bound to n2 (self=n1) → proxies to n2', async () => {
  const m = onboardedOnNode2();
  const deps = {
    resolve: () => ({ sid: 'uuid-remote-1', transport: 'native' as const, missionId: m.id, role: 'worker' as const }),
    cloudRead: async () => ({ messages: [] }),
    cloudDrive: async () => ({ delivered: true }),
    cloudStop: async () => ({ stopped: true }),
    nativeRead: async () => ({ messages: [] }),
    nativeRawMessages: async () => [],
    nativeDrive: async () => { throw new Error('must not drive locally — should have proxied'); },
    nativeInterrupt: async () => {},
    nativeStop: async () => {},
    clearController: async () => {},
    getControllerSession: async () => null,
    findMission: async () => m,
    selfNode: () => 'n1',
  } as any;
  const { proxyDeps, calls } = proxyCapture();
  // NOTE: node is explicitly undefined/omitted — this is exactly the case I1 fixes.
  const r = await handleSessionDrive('uuid-remote-1', 'do the thing', deps, undefined, proxyDeps);
  assert.ok(r.success, JSON.stringify(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].node, 'n2');
  assert.ok(calls[0].path.includes('/drive'));
});

test('I1: read with no node + onboarded mission bound to n2 (self=n1) → proxies to n2', async () => {
  const m = onboardedOnNode2();
  const deps = {
    resolve: () => ({ sid: 'uuid-remote-1', transport: 'native' as const, missionId: m.id, role: 'worker' as const }),
    cloudRead: async () => ({ messages: [] }),
    cloudDrive: async () => ({ delivered: true }),
    cloudStop: async () => ({ stopped: true }),
    nativeRead: async () => { throw new Error('must not read locally — should have proxied'); },
    nativeRawMessages: async () => [],
    nativeDrive: async () => {},
    nativeInterrupt: async () => {},
    nativeStop: async () => {},
    clearController: async () => {},
    getControllerSession: async () => null,
    findMission: async () => m,
    selfNode: () => 'n1',
  } as any;
  const { proxyDeps, calls } = proxyCapture();
  const r = await handleSessionRead('uuid-remote-1', undefined, deps, undefined, proxyDeps);
  assert.ok(r.success, JSON.stringify(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].node, 'n2');
  assert.ok(calls[0].path.includes('/read'));
});

test('I1: drive with EXPLICIT node still wins over auto-resolve (explicit node takes precedence)', async () => {
  const m = onboardedOnNode2(); // bound to n2
  const deps = {
    resolve: () => ({ sid: 'uuid-remote-1', transport: 'native' as const, missionId: m.id, role: 'worker' as const }),
    cloudRead: async () => ({ messages: [] }),
    cloudDrive: async () => ({ delivered: true }),
    cloudStop: async () => ({ stopped: true }),
    nativeRead: async () => ({ messages: [] }),
    nativeRawMessages: async () => [],
    nativeDrive: async () => {},
    nativeInterrupt: async () => {},
    nativeStop: async () => {},
    clearController: async () => {},
    getControllerSession: async () => null,
    findMission: async () => m,
    selfNode: () => 'n1',
  } as any;
  const { proxyDeps, calls } = proxyCapture();
  const r = await handleSessionDrive('uuid-remote-1', 'x', deps, 'n3-explicit', proxyDeps);
  assert.ok(r.success, JSON.stringify(r));
  assert.equal(calls[0].node, 'n3-explicit', 'the explicitly-passed node must win, not the mission binding');
});

test('I1: drive/read do NOT auto-resolve for a non-onboarded (executor) mission — stays leader-local', async () => {
  // A normal (non-onboarded) mission bound to n2 must NOT trigger auto-proxy — executor
  // placement/routing is leader-local by design; I1 is scoped to onboarded missions only.
  const executorMission = { origin: undefined, binding: { sessionId: 'uuid-exec-1', node: 'n2', kind: 'worker', boundAt: 1 } } as any;
  let drove = false;
  const deps = {
    resolve: () => ({ sid: 'uuid-exec-1', transport: 'native' as const, missionId: 'mission_exec', role: 'worker' as const }),
    cloudRead: async () => ({ messages: [] }),
    cloudDrive: async () => ({ delivered: true }),
    cloudStop: async () => ({ stopped: true }),
    nativeRead: async () => ({ messages: [] }),
    nativeRawMessages: async () => [],
    nativeDrive: async () => { drove = true; },
    nativeInterrupt: async () => {},
    nativeStop: async () => {},
    clearController: async () => {},
    getControllerSession: async () => null,
    findMission: async () => executorMission,
    selfNode: () => 'n1',
  } as any;
  const { proxyDeps, calls } = proxyCapture();
  const r = await handleSessionDrive('uuid-exec-1', 'continue', deps, undefined, proxyDeps);
  assert.ok(r.success, JSON.stringify(r));
  assert.equal(calls.length, 0, 'must not proxy an executor session even if its binding.node differs from self');
  assert.equal(drove, true, 'drove locally instead');
});

test('I1: drive/read do NOT auto-resolve when binding.node === self (already local)', async () => {
  const m = onboarded('handoff'); // bound to n1, same as selfNode below
  let drove = false;
  const deps = {
    resolve: () => ({ sid: 'uuid-1', transport: 'native' as const, missionId: m.id, role: 'worker' as const }),
    cloudRead: async () => ({ messages: [] }),
    cloudDrive: async () => ({ delivered: true }),
    cloudStop: async () => ({ stopped: true }),
    nativeRead: async () => ({ messages: [] }),
    nativeRawMessages: async () => [],
    nativeDrive: async () => { drove = true; },
    nativeInterrupt: async () => {},
    nativeStop: async () => {},
    clearController: async () => {},
    getControllerSession: async () => null,
    findMission: async () => m,
    selfNode: () => 'n1',
  } as any;
  const { proxyDeps, calls } = proxyCapture();
  const r = await handleSessionDrive('uuid-1', 'continue', deps, undefined, proxyDeps);
  assert.ok(r.success, JSON.stringify(r));
  assert.equal(calls.length, 0);
  assert.equal(drove, true);
});

test('I1: drive/read do NOT auto-resolve a cloud-bound onboarded mission (binding.node="cloud")', async () => {
  const m = buildOnboardMission({ sid: 'session_cloud1', node: 'cloud', transport: 'cloud', mode: 'handoff', crossCluster: false, ownerNode: 'n1', createdBy: user }, 1, () => 'mission_ob_cloud');
  let clouddrove = false;
  const deps = {
    resolve: () => ({ sid: 'session_cloud1', transport: 'cloud' as const, missionId: m.id, role: 'worker' as const }),
    cloudRead: async () => ({ sid: 'session_cloud1', messages: [], pendingQuestion: null }),
    cloudDrive: async () => { clouddrove = true; return { delivered: true, sid: 'session_cloud1' }; },
    cloudStop: async () => ({ stopped: true, sid: 'session_cloud1' }),
    nativeRead: async () => ({ messages: [] }),
    nativeRawMessages: async () => [],
    nativeDrive: async () => {},
    nativeInterrupt: async () => {},
    nativeStop: async () => {},
    clearController: async () => {},
    getControllerSession: async () => null,
    findMission: async () => m,
    selfNode: () => 'n1',
  } as any;
  const { proxyDeps, calls } = proxyCapture();
  const r = await handleSessionDrive('session_cloud1', 'continue', deps, undefined, proxyDeps);
  assert.ok(r.success, JSON.stringify(r));
  assert.equal(calls.length, 0, 'cloud sessions have their own transport path, not a node-proxy');
  assert.equal(clouddrove, true);
});

test('I1: auto-resolve lookup throwing degrades to local (best-effort, no proxy, no error)', async () => {
  let drove = false;
  const deps = {
    resolve: () => ({ sid: 'uuid-err-1', transport: 'native' as const, missionId: null, role: 'worker' as const }),
    cloudRead: async () => ({ messages: [] }),
    cloudDrive: async () => ({ delivered: true }),
    cloudStop: async () => ({ stopped: true }),
    nativeRead: async () => ({ messages: [] }),
    nativeRawMessages: async () => [],
    nativeDrive: async () => { drove = true; },
    nativeInterrupt: async () => {},
    nativeStop: async () => {},
    clearController: async () => {},
    getControllerSession: async () => null,
    findMission: async () => { throw new Error('store hiccup'); },
    selfNode: () => 'n1',
  } as any;
  const { proxyDeps, calls } = proxyCapture();
  const r = await handleSessionDrive('uuid-err-1', 'continue', deps, undefined, proxyDeps);
  assert.ok(r.success, JSON.stringify(r));
  assert.equal(calls.length, 0);
  assert.equal(drove, true);
});

// ── I4(a): binding upsert is human-only on an onboarded mission ─────────────────────────────

test('I4(a): controller-attributed binding change on an onboarded mission is REJECTED', async () => {
  const m = onboarded('handoff');
  const port = { isEnabled: () => true, get: async () => m, list: async () => [m], put: async (x: Mission) => { Object.assign(m, x); }, del: async () => {} } as any;
  const r = await handlePatch(m.id, { binding: { sessionId: 'uuid-hijack', kind: 'worker' } }, port, ctrl);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'FORBIDDEN');
  assert.equal(m.binding?.sessionId, 'uuid-1', 'the original binding must be untouched');
});

test('I4(a): controller-attributed UNBIND (binding:null) on an onboarded mission is REJECTED', async () => {
  const m = onboarded('handoff');
  const port = { isEnabled: () => true, get: async () => m, list: async () => [m], put: async (x: Mission) => { Object.assign(m, x); }, del: async () => {} } as any;
  const r = await handlePatch(m.id, { binding: null }, port, ctrl);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'FORBIDDEN');
  assert.ok(m.binding, 'must not have been unbound');
});

test('I4(a): human-attributed binding change on an onboarded mission is ALLOWED', async () => {
  const m = onboarded('handoff');
  const port = { isEnabled: () => true, get: async () => m, list: async () => [m], put: async (x: Mission) => { Object.assign(m, x); }, del: async () => {} } as any;
  const r = await handlePatch(m.id, { binding: { sessionId: 'uuid-rebind', kind: 'worker' } }, port, user);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal((r.data as Mission).binding?.sessionId, 'uuid-rebind');
});

test('I4(a): binding change on a NON-onboarded mission is unaffected by the guard (controller allowed)', async () => {
  const executorMission = { id: 'mission_exec', origin: undefined, binding: null } as any as Mission;
  const port = { isEnabled: () => true, get: async () => executorMission, list: async () => [executorMission], put: async (x: Mission) => { Object.assign(executorMission, x); }, del: async () => {} } as any;
  const r = await handlePatch('mission_exec', { binding: { sessionId: 'uuid-new-worker', kind: 'worker' } }, port, ctrl);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal((r.data as Mission).binding?.sessionId, 'uuid-new-worker');
});

// ── I4(b): stop requires force:true on an onboarded mission ──────────────────────────────────

function controlDeps(m: Mission | null, overrides: Record<string, unknown> = {}) {
  let stopped = false;
  const deps = {
    resolve: () => ({ sid: 'uuid-1', transport: 'native' as const, missionId: m?.id ?? null, role: 'worker' as const }),
    cloudRead: async () => ({ messages: [] }),
    cloudDrive: async () => ({ delivered: true }),
    cloudStop: async (sid: string) => ({ stopped: true, sid }),
    nativeRead: async () => ({ messages: [] }),
    nativeRawMessages: async () => [],
    nativeDrive: async () => {},
    nativeInterrupt: async () => {},
    nativeStop: async () => { stopped = true; },
    clearController: async () => {},
    getControllerSession: async () => null,
    findMission: async () => m,
    selfNode: () => 'n1',
    ...overrides,
  } as any;
  return { deps, wasStopped: () => stopped };
}

test('I4(b): stop on an onboarded mission WITHOUT force is REJECTED', async () => {
  const m = onboarded('handoff');
  const { deps, wasStopped } = controlDeps(m);
  const r = await handleSessionControl('uuid-1', 'stop', deps);
  assert.equal(r.success, false);
  assert.equal(r.error!.code, 'ONBOARDED_PROTECTED');
  assert.equal(wasStopped(), false, 'the session must NOT actually have been stopped');
});

test('I4(b): stop on an onboarded mission WITH force:true is ALLOWED', async () => {
  const m = onboarded('handoff');
  const { deps, wasStopped } = controlDeps(m);
  const r = await handleSessionControl('uuid-1', 'stop', deps, undefined, undefined, true);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(wasStopped(), true);
});

test('I4(b): stop on a NON-onboarded mission is unaffected (no force needed)', async () => {
  const { deps, wasStopped } = controlDeps(null);
  const r = await handleSessionControl('uuid-1', 'stop', deps);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(wasStopped(), true);
});

test('I4(b): interrupt on an onboarded mission stays ALLOWED without force', async () => {
  const m = onboarded('handoff');
  let interrupted = false;
  const { deps } = controlDeps(m, { nativeInterrupt: async () => { interrupted = true; } });
  const r = await handleSessionControl('uuid-1', 'interrupt', deps);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(interrupted, true);
});

test('I4(b): findMission lookup throwing degrades to allowing stop (best-effort, never blocks a normal stop)', async () => {
  const { deps, wasStopped } = controlDeps(null, { findMission: async () => { throw new Error('store down'); } });
  const r = await handleSessionControl('uuid-1', 'stop', deps);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(wasStopped(), true);
});

test('human rebind of an onboarded mission preserves kind onboarded', async () => {
  const m = onboarded('standby');
  const port = { isEnabled: () => true, get: async () => m, list: async () => [m], put: async (x: Mission) => { Object.assign(m, x); }, del: async () => {} } as any;
  const r = await handlePatch(m.id, { binding: { sessionId: 'new-sid-1', kind: 'onboarded' } }, port, user);
  assert.equal(r.success, true);
  assert.equal((r.data as any).binding.kind, 'onboarded');
  assert.equal((r.data as any).binding.sessionId, 'new-sid-1');
});
