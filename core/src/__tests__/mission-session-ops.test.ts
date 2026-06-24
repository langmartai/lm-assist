import { test } from 'node:test';
import assert from 'node:assert';
import { handleSessionRead, handleSessionDrive, handleSessionControl } from '../routes/core/mission.routes';
import type { SessionOpsDeps } from '../routes/core/mission.routes';
import type { Mission } from '../mission/mission-model';

function makeStubDeps(overrides: Partial<SessionOpsDeps> = {}): SessionOpsDeps {
  return {
    cloudRead: async (opts) => ({ sid: opts.sid, messages: [{ role: 'assistant' as const, turnIndex: 1, lineIndex: 0, content: 'hello' }], pendingQuestion: null }),
    cloudDrive: async (opts) => ({ delivered: true, sid: opts.sid }),
    cloudStop: async (sid) => ({ stopped: true, sid }),
    nativeRead: async (sid) => ({ messages: [{ role: 'user' as const, turnIndex: 1, lineIndex: 0, content: 'native msg' }] }),
    nativeDrive: async (_sid, _text) => {},
    nativeInterrupt: async (_sid) => {},
    nativeStop: async (_sid) => {},
    clearController: async () => {},
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

// -- drive tests --

test('handleSessionDrive dispatches to cloudDrive for cloud transport', async () => {
  let called = false;
  const deps = makeStubDeps({
    cloudDrive: async (opts) => { called = true; return { delivered: true, sid: opts.sid }; },
  });
  const r = await handleSessionDrive('session_y', 'do thing', undefined, deps);
  assert.ok(r.success);
  assert.ok(called, 'cloudDrive should be called');
});

test('handleSessionDrive dispatches to nativeDrive for native transport', async () => {
  let called = false;
  const deps = makeStubDeps({
    nativeDrive: async (_sid, _text) => { called = true; },
  });
  const r = await handleSessionDrive('4e15ac46-9999-477f-0000-0001', 'go', undefined, deps);
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

test('handleSessionControl restart on non-controller -> INVALID_INPUT error', async () => {
  const deps = makeStubDeps();
  // default resolve gives role 'worker', not 'controller'
  const r = await handleSessionControl('session_w', 'restart', deps);
  assert.equal(r.success, false);
  assert.equal((r as any).error?.code, 'INVALID_INPUT');
});

test('handleSessionControl restart on controller sid -> calls clearController', async () => {
  let cleared = false;
  const deps = makeStubDeps({
    resolve: (sid) => ({ sid, transport: 'cloud' as const, missionId: null, role: 'controller' as const }),
    clearController: async () => { cleared = true; },
  });
  const r = await handleSessionControl('session_ctrl', 'restart', deps);
  assert.ok(r.success);
  assert.ok(cleared, 'clearController should be called for controller restart');
});
