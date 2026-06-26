import { test } from 'node:test';
import assert from 'node:assert';
import {
  killOwner, injectRemoteControl, clearInjectedInput, pollForCloudConnection,
  type KillExec, type InjectExec, type CloudSession,
} from '../terminal/live-rc-connect';

const noSleep = async () => {};

function killExec(aliveSeq: boolean[]): { exec: KillExec; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const exec: KillExec = {
    isAlive: () => (i < aliveSeq.length ? aliveSeq[i++] : aliveSeq[aliveSeq.length - 1]),
    signal: (_pid, sig) => calls.push(sig),
    taskkill: () => calls.push('taskkill'),
    sleep: noSleep,
  };
  return { exec, calls };
}

// ── killOwner ─────────────────────────────────────────────────────────────────
test('killOwner: not alive → killed, method none, no signals', async () => {
  const { exec, calls } = killExec([false]);
  const r = await killOwner(1, { isWindows: false }, exec);
  assert.deepStrictEqual(r, { killed: true, wasAlive: false, method: 'none' });
  assert.deepStrictEqual(calls, []);
});
test('killOwner: SIGTERM works (dies within grace) → method sigterm', async () => {
  // alive (initial check), then dead on first poll
  const { exec, calls } = killExec([true, false]);
  const r = await killOwner(1, { isWindows: false, graceMs: 1000, pollMs: 250 }, exec);
  assert.strictEqual(r.killed, true);
  assert.strictEqual(r.method, 'sigterm');
  assert.deepStrictEqual(calls, ['SIGTERM']);
});
test('killOwner: SIGTERM fails → escalates to SIGKILL', async () => {
  // alive for the SIGTERM grace window, then dead after SIGKILL
  const { exec, calls } = killExec([true, true, true, true, true, false]);
  const r = await killOwner(1, { isWindows: false, graceMs: 500, pollMs: 250 }, exec);
  assert.strictEqual(r.method, 'sigkill');
  assert.strictEqual(r.killed, true);
  assert.deepStrictEqual(calls, ['SIGTERM', 'SIGKILL']);
});
test('killOwner: never dies → killed false (caller ABORTS)', async () => {
  const { exec } = killExec([true]); // always alive
  const r = await killOwner(1, { isWindows: false, graceMs: 500, pollMs: 250 }, exec);
  assert.strictEqual(r.killed, false);
});
test('killOwner: windows uses taskkill', async () => {
  const { exec, calls } = killExec([true, false]);
  const r = await killOwner(1, { isWindows: true, graceMs: 1000, pollMs: 250 }, exec);
  assert.strictEqual(r.method, 'taskkill');
  assert.deepStrictEqual(calls, ['taskkill']);
});
test('killOwner: signal throwing is swallowed', async () => {
  const calls: string[] = [];
  let i = 0; const aliveSeq = [true, false];
  const exec: KillExec = {
    isAlive: () => (i < aliveSeq.length ? aliveSeq[i++] : false),
    signal: () => { throw new Error('EPERM'); },
    taskkill: () => calls.push('tk'),
    sleep: noSleep,
  };
  const r = await killOwner(1, { isWindows: false }, exec);
  assert.strictEqual(r.killed, true); // process died anyway
});

// ── injectRemoteControl ───────────────────────────────────────────────────────
test('injectRemoteControl: tmux sends /remote-control literal + Enter', async () => {
  const sends: Array<[string, string, boolean, boolean]> = [];
  const exec: InjectExec = {
    tmuxSend: (t, k, lit, ent) => sends.push([t, k, lit, ent]),
    windowsSend: async () => ({ ok: false }),
  };
  const r = await injectRemoteControl({ via: 'tmux', tmuxTarget: 'sess:0.0' }, exec);
  assert.deepStrictEqual(r, { ok: true, via: 'tmux' });
  assert.deepStrictEqual(sends, [['sess:0.0', '/remote-control', true, true]]);
});
test('injectRemoteControl: windows uses windowsSend with submit', async () => {
  let got: any = null;
  const exec: InjectExec = {
    tmuxSend: () => {},
    windowsSend: async (pid, opts) => { got = { pid, opts }; return { ok: true }; },
  };
  const r = await injectRemoteControl({ via: 'windows', pid: 42 }, exec);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(got, { pid: 42, opts: { text: '/remote-control', submit: true } });
});
test('injectRemoteControl: tmux throw → ok false with error', async () => {
  const exec: InjectExec = { tmuxSend: () => { throw new Error('no server'); }, windowsSend: async () => ({ ok: false }) };
  const r = await injectRemoteControl({ via: 'tmux', tmuxTarget: 't' }, exec);
  assert.strictEqual(r.ok, false);
  assert.match(r.error || '', /no server/);
});
test('injectRemoteControl: missing target → ok false', async () => {
  const exec: InjectExec = { tmuxSend: () => {}, windowsSend: async () => ({ ok: true }) };
  assert.strictEqual((await injectRemoteControl({ via: 'tmux' }, exec)).ok, false);
  assert.strictEqual((await injectRemoteControl({ via: 'windows' }, exec)).ok, false);
});

// ── pollForCloudConnection ────────────────────────────────────────────────────
test('pollForCloudConnection: finds a NEW active session not in baseline', async () => {
  const list = async (): Promise<CloudSession[]> => [
    { sid: 'old', status: 'running' },
    { sid: 'new', status: 'running', title: 'Mission X' },
  ];
  const r = await pollForCloudConnection(
    { title: 'Mission X', excludeSids: new Set(['old']) }, list,
    { timeoutMs: 0, intervalMs: 10, sleep: noSleep },
  );
  assert.deepStrictEqual(r, { connected: true, sid: 'new' });
});
test('pollForCloudConnection: a baseline session does NOT count', async () => {
  const list = async (): Promise<CloudSession[]> => [{ sid: 'old', status: 'running', title: 'Mission X' }];
  const r = await pollForCloudConnection(
    { title: 'Mission X', excludeSids: new Set(['old']) }, list,
    { timeoutMs: 0, intervalMs: 10, sleep: noSleep },
  );
  assert.strictEqual(r.connected, false);
});
test('pollForCloudConnection: dead-status new session does NOT count', async () => {
  const list = async (): Promise<CloudSession[]> => [{ sid: 'new', status: 'stopped' }];
  const r = await pollForCloudConnection(
    { excludeSids: new Set() }, list, { timeoutMs: 0, intervalMs: 10, sleep: noSleep },
  );
  assert.strictEqual(r.connected, false);
});
test('pollForCloudConnection: list throwing mid-poll is swallowed (returns not connected)', async () => {
  const list = async (): Promise<CloudSession[]> => { throw new Error('429'); };
  const r = await pollForCloudConnection(
    { excludeSids: new Set() }, list, { timeoutMs: 0, intervalMs: 10, sleep: noSleep },
  );
  assert.strictEqual(r.connected, false);
});
