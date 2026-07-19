import { test } from 'node:test';
import assert from 'node:assert';
import { handleSessionRead, handleSessionDrive, handleSessionControl } from '../routes/core/mission.routes';
import type { SessionOpsDeps, SessionProxyDeps } from '../routes/core/mission.routes';
import type { SupervisorDeps } from '../mission/mission-controller';
import { thisNode } from '../mission/mission-store';
import type { ControllerSession } from '../mission/mission-store';

function makeStubDeps(overrides: Partial<SessionOpsDeps> = {}): SessionOpsDeps {
  return {
    cloudRead: async (opts) => ({ sid: opts.sid, messages: [{ role: 'assistant', text: 'hello' }], pendingQuestion: null }),
    cloudDrive: async (opts) => ({ delivered: true, sid: opts.sid }),
    cloudStop: async (sid) => ({ stopped: true, sid }),
    nativeRead: async (_sid) => ({ messages: [{ role: 'user', content: 'native msg' }] }),
    nativeRawMessages: async (_sid) => ([]),
    nativeDrive: async (_sid, _text) => {},
    nativeInterrupt: async (_sid) => {},
    nativeStop: async (_sid) => {},
    clearController: async () => {},
    getControllerSession: async () => null,
    resolve: (sid) => ({
      sid,
      transport: sid.startsWith('session_') ? 'cloud' : 'native',
      missionId: null,
      role: 'worker' as const,
    }),
    ...overrides,
  };
}

// -- read tests --

test('handleSessionRead dispatches to cloudRead for session_ sid', async () => {
  let called = false;
  const deps = makeStubDeps({
    cloudRead: async (opts) => { called = true; return { sid: opts.sid, messages: [], pendingQuestion: null }; },
  });
  const r = await handleSessionRead('session_x', undefined, deps);
  assert.ok(r.success);
  assert.ok(called, 'cloudRead should be called');
});

test('handleSessionRead dispatches to nativeRead for uuid sid', async () => {
  let called = false;
  const deps = makeStubDeps({
    nativeRead: async (_sid) => { called = true; return { messages: [] }; },
  });
  const r = await handleSessionRead('4e15ac46-1234-477f-9dae-0001', undefined, deps);
  assert.ok(r.success);
  assert.ok(called, 'nativeRead should be called');
});

// FIX 3: native read maps content -> text
test('handleSessionRead native: normalizes content -> text', async () => {
  const deps = makeStubDeps({
    nativeRead: async (_sid) => ({
      messages: [
        { role: 'user', content: 'hello from native' },
        { role: 'assistant', content: 'reply from native' },
      ],
    }),
  });
  const r = await handleSessionRead('4e15ac46-fix3-477f-0000-0001', undefined, deps);
  assert.ok(r.success);
  const msgs = (r as any).data?.messages as Array<{ role: string; text: string }>;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].text, 'hello from native');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].text, 'reply from native');
  // content field must NOT be on the normalized output
  assert.equal((msgs[0] as any).content, undefined);
});

// CHANGE 1: cloud read exposes tools[] per message
test('handleSessionRead cloud: messages with tools include tools array', async () => {
  const deps = makeStubDeps({
    cloudRead: async (opts) => ({
      sid: opts.sid,
      messages: [
        { role: 'assistant', text: 'I will search', type: 'assistant', tools: ['Bash', 'Read'] },
        { role: 'assistant', text: 'plain reply', type: 'assistant' },
      ],
      pendingQuestion: null,
    }),
  });
  const r = await handleSessionRead('session_tools_cloud', undefined, deps);
  assert.ok(r.success);
  const msgs = (r as any).data?.messages as Array<{ role: string; text: string; tools?: string[] }>;
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0].tools, ['Bash', 'Read'], 'tools should be passed through from cloud message');
  assert.equal(msgs[1].tools, undefined, 'message without tools should not have tools field');
});

// CHANGE 1: native read exposes tools[] from toolCalls[].name
test('handleSessionRead native: messages with toolCalls expose tools by name', async () => {
  const deps = makeStubDeps({
    nativeRead: async (_sid) => ({
      messages: [
        { role: 'assistant', content: '[2 tool call(s)]', toolCalls: [{ id: 'tu1', name: 'Bash' }, { id: 'tu2', name: 'Read' }] },
        { role: 'user', content: 'do the thing' },
      ],
    }),
  });
  const r = await handleSessionRead('4e15ac46-tools-native-0001', undefined, deps);
  assert.ok(r.success);
  const msgs = (r as any).data?.messages as Array<{ role: string; text: string; tools?: string[] }>;
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0].tools, ['Bash', 'Read'], 'tool names should be extracted from toolCalls');
  assert.equal(msgs[0].text, '[2 tool call(s)]', 'text should remain unchanged');
  assert.equal(msgs[1].tools, undefined, 'user message with no toolCalls should not have tools field');
});

// FIX 3: cloud read passes text through (not content)
test('handleSessionRead cloud: messages keep .text field', async () => {
  const deps = makeStubDeps({
    cloudRead: async (opts) => ({
      sid: opts.sid,
      messages: [{ role: 'assistant', text: 'cloud text', type: 'assistant' }],
      pendingQuestion: null,
    }),
  });
  const r = await handleSessionRead('session_fix3', undefined, deps);
  assert.ok(r.success);
  const msgs = (r as any).data?.messages as Array<{ role: string; text: string }>;
  assert.equal(msgs[0].text, 'cloud text');
  assert.equal(msgs[0].role, 'assistant');
});

// -- drive tests --

test('handleSessionDrive dispatches to cloudDrive for cloud transport', async () => {
  let called = false;
  const deps = makeStubDeps({
    cloudDrive: async (opts) => { called = true; return { delivered: true, sid: opts.sid }; },
  });
  const r = await handleSessionDrive('session_y', 'do thing', deps);
  assert.ok(r.success);
  assert.ok(called, 'cloudDrive should be called');
});

test('handleSessionDrive dispatches to nativeDrive for native transport', async () => {
  let called = false;
  const deps = makeStubDeps({
    nativeDrive: async (_sid, _text) => { called = true; },
  });
  const r = await handleSessionDrive('4e15ac46-9999-477f-0000-0001', 'go', deps);
  assert.ok(r.success);
  assert.ok(called, 'nativeDrive should be called');
});

// -- control tests --

test('handleSessionControl stop calls cloudStop for cloud session', async () => {
  let called = false;
  const deps = makeStubDeps({
    cloudStop: async (sid) => { called = true; return { stopped: true, sid }; },
  });
  const r = await handleSessionControl('session_z', 'stop', deps);
  assert.ok(r.success);
  assert.ok(called, 'cloudStop should be called');
});

test('handleSessionControl stop calls nativeStop for native session', async () => {
  let called = false;
  const deps = makeStubDeps({
    nativeStop: async (_sid) => { called = true; },
  });
  const r = await handleSessionControl('4e15ac46-aaaa-477f-bbbb-0001', 'stop', deps);
  assert.ok(r.success);
  assert.ok(called, 'nativeStop should be called');
});

test('handleSessionControl interrupt calls cloudDrive for cloud session', async () => {
  let driveCalled = false;
  const deps = makeStubDeps({
    cloudDrive: async (opts) => { driveCalled = true; return { delivered: true, sid: opts.sid }; },
  });
  const r = await handleSessionControl('session_i', 'interrupt', deps);
  assert.ok(r.success);
  assert.ok(driveCalled, 'cloudDrive should be called for interrupt');
});

test('handleSessionControl interrupt calls nativeInterrupt for native session', async () => {
  let called = false;
  const deps = makeStubDeps({
    nativeInterrupt: async (_sid) => { called = true; },
  });
  const r = await handleSessionControl('4e15ac46-cccc-477f-dddd-0001', 'interrupt', deps);
  assert.ok(r.success);
  assert.ok(called, 'nativeInterrupt should be called');
});

// FIX 1: restart checks getControllerSession, not role from resolver
test('handleSessionControl restart: no stored controller -> INVALID_INPUT', async () => {
  const deps = makeStubDeps({
    // getControllerSession returns null => not a controller
    getControllerSession: async () => null,
  });
  const r = await handleSessionControl('session_w', 'restart', deps);
  assert.equal(r.success, false);
  assert.equal((r as any).error?.code, 'INVALID_INPUT');
});

test('handleSessionControl restart: stored controller sessionId matches -> STOPS old controller, then clears', async () => {
  const calls: string[] = [];
  const deps = makeStubDeps({
    getControllerSession: async () => ({
      sessionId: 'session_ctrl',
      cse: null,
      node: 'gw1',
      tmux: 'lm-ctrl',
      startedAt: 1000,
    }),
    // The old controller's tmux MUST be killed before the record is cleared, else the supervisor
    // relaunches a fresh controller while the old one is still running (duplicate controllers).
    nativeStop: async (sid: string) => { calls.push(`stop:${sid}`); },
    clearController: async () => { calls.push('clear'); },
  });
  const r = await handleSessionControl('session_ctrl', 'restart', deps);
  assert.ok(r.success, 'restart should succeed when sid matches controller sessionId');
  assert.deepStrictEqual(calls, ['stop:session_ctrl', 'clear'], 'must stop the old controller BEFORE clearing the record');
});

test('handleSessionControl restart: stored controller cse matches -> calls clearController', async () => {
  let cleared = false;
  const deps = makeStubDeps({
    getControllerSession: async () => ({
      sessionId: 'session_ctrl',
      cse: 'session_cse_ctrl',
      node: 'gw1',
      tmux: 'lm-ctrl',
      startedAt: 1000,
    }),
    clearController: async () => { cleared = true; },
  });
  // Drive via the cse sid
  const r = await handleSessionControl('session_cse_ctrl', 'restart', deps);
  assert.ok(r.success, 'restart should succeed when sid matches controller cse');
  assert.ok(cleared, 'clearController should be called');
});

test('handleSessionControl restart: stored controller but different sid -> INVALID_INPUT', async () => {
  const deps = makeStubDeps({
    getControllerSession: async () => ({
      sessionId: 'session_ctrl',
      cse: null,
      node: 'gw1',
      tmux: 'lm-ctrl',
      startedAt: 1000,
    }),
  });
  // sid is NOT the controller session
  const r = await handleSessionControl('session_some_worker', 'restart', deps);
  assert.equal(r.success, false);
  assert.equal((r as any).error?.code, 'INVALID_INPUT');
});

// FIX 2: test teardown calls the tmux dep (via supervisor test — stub assertion)
// (The real teardown uses tmuxTerminalBackend.close which is tested via integration;
//  here we verify the supervisor's teardown dep is invoked with the cs.tmux name.)
test('supervisor teardown dep is called with cs.tmux (after the debounce streak)', async () => {
  const { runSupervisorTick, _resetNotMonitorStreak } = require('../mission/mission-controller') as typeof import('../mission/mission-controller');
  _resetNotMonitorStreak();
  const cs: ControllerSession = { node: 'gw1', sessionId: 'session_ctrl', cse: null, tmux: 'lmcc-test123', startedAt: 1000 };
  let tornDownWith: string | null = null;
  const deps: SupervisorDeps = {
    amMonitor: async () => ({ isMonitor: false, monitorNodeId: 'gw2' }),
    getControllerSession: async () => cs,
    putControllerSession: async () => {},
    isLive: () => false,
    launch: async () => cs,
    drive: async () => {},
    teardown: async (c) => { tornDownWith = c.tmux; },
    driveIntervalMin: 5,
    now: Date.now(),
  };
  await runSupervisorTick(deps); // confident-false #1 → debounced, no teardown yet
  await runSupervisorTick(deps); // confident-false #2 → teardown proceeds
  assert.equal(tornDownWith, 'lmcc-test123', 'teardown should be called with the controller cs.tmux name');
  _resetNotMonitorStreak();
});

// ── Cross-node proxy: session ops (Step 3) ───────────────────────────────────
// thisNode() returns 'unknown' in test env (no hub config). Any other node triggers proxy.

function makeProxyDeps(
  onPost: (node: string, urlPath: string, body: unknown) => Promise<unknown>,
): SessionProxyDeps {
  return { proxyPost: onPost };
}

test('handleSessionRead: node !== self → dispatches to proxyPost', async () => {
  let proxyNode: string | undefined;
  let proxyPath: string | undefined;
  const pd = makeProxyDeps(async (node, urlPath, _body) => {
    proxyNode = node; proxyPath = urlPath;
    return { data: { messages: [{ role: 'assistant', text: 'proxied' }] } };
  });
  const r = await handleSessionRead('session_abc', 10, undefined, 'gw-leader', pd);
  assert.ok(r.success, 'should succeed');
  assert.equal(proxyNode, 'gw-leader', 'should proxy to gw-leader');
  assert.ok(proxyPath?.includes('session_abc'), 'path should include the sid');
  assert.ok(proxyPath?.includes('/read'), 'path should end in /read');
});

test('handleSessionRead: node === self → executes locally, no proxy', async () => {
  let proxyCalled = false;
  const pd = makeProxyDeps(async () => { proxyCalled = true; return {}; });
  const deps = makeStubDeps({
    cloudRead: async (opts) => ({ sid: opts.sid, messages: [{ role: 'assistant', text: 'local' }], pendingQuestion: null }),
  });
  const r = await handleSessionRead('session_self', undefined, deps, thisNode(), pd);
  assert.ok(r.success);
  assert.equal(proxyCalled, false, 'should NOT proxy when node === self');
});

test('handleSessionRead: node absent → executes locally, no proxy', async () => {
  let proxyCalled = false;
  const pd = makeProxyDeps(async () => { proxyCalled = true; return {}; });
  const deps = makeStubDeps({
    nativeRead: async (_sid) => ({ messages: [{ role: 'user', content: 'local native' }] }),
  });
  const r = await handleSessionRead('4e15ac46-local-0001', undefined, deps, undefined, pd);
  assert.ok(r.success);
  assert.equal(proxyCalled, false, 'should NOT proxy when node is absent');
});

test('handleSessionDrive: node !== self → dispatches to proxyPost', async () => {
  let proxyNode: string | undefined;
  let proxyPath: string | undefined;
  let proxyBody: unknown;
  const pd = makeProxyDeps(async (node, urlPath, body) => {
    proxyNode = node; proxyPath = urlPath; proxyBody = body;
    return { data: { delivered: true } };
  });
  const r = await handleSessionDrive('session_def', 'hello', undefined, 'gw-leader', pd);
  assert.ok(r.success);
  assert.equal(proxyNode, 'gw-leader');
  assert.ok(proxyPath?.includes('/drive'));
  assert.equal((proxyBody as any).text, 'hello');
});

test('handleSessionDrive: node === self → executes locally', async () => {
  let proxyCalled = false;
  const pd = makeProxyDeps(async () => { proxyCalled = true; return {}; });
  const deps = makeStubDeps({
    cloudDrive: async (opts) => ({ delivered: true, sid: opts.sid }),
  });
  const r = await handleSessionDrive('session_local', 'go', deps, thisNode(), pd);
  assert.ok(r.success);
  assert.equal(proxyCalled, false);
});

test('handleSessionControl: node !== self → dispatches to proxyPost', async () => {
  let proxyNode: string | undefined;
  let proxyBody: unknown;
  const pd = makeProxyDeps(async (node, _urlPath, body) => {
    proxyNode = node; proxyBody = body;
    return { data: { action: 'interrupt' } };
  });
  const r = await handleSessionControl('session_ghi', 'interrupt', undefined, 'gw-leader', pd);
  assert.ok(r.success);
  assert.equal(proxyNode, 'gw-leader');
  assert.equal((proxyBody as any).action, 'interrupt');
});

test('handleSessionControl: node === self → executes locally', async () => {
  let proxyCalled = false;
  const pd = makeProxyDeps(async () => { proxyCalled = true; return {}; });
  const deps = makeStubDeps({
    cloudDrive: async (opts) => ({ delivered: true, sid: opts.sid }),
  });
  const r = await handleSessionControl('session_local_ctrl', 'interrupt', deps, thisNode(), pd);
  assert.ok(r.success);
  assert.equal(proxyCalled, false);
});
