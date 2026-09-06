/**
 * Zombie-aware process liveness — the guard for the ccr_restart "kill-failed"
 * false positive (2026-09, node 117): a `<defunct>` claude answered signal 0,
 * so killOwner's SIGTERM→SIGKILL ladder reported "owner process did not
 * terminate; NOT resuming over a live process" for a process that had already
 * exited. A Z-state pid must count as DEAD.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProcessAlive, procStateFromStat, type ProcessAliveDeps } from '../utils/process-utils';
import { killOwner, type KillExec } from '../terminal/live-rc-connect';

const stat = (state: string, comm = 'claude') => `4242 (${comm}) ${state} 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 12345 0 0 18446744073709551615`;

test('procStateFromStat: reads field 3 after the LAST ")" — comm may contain spaces and parens', () => {
  assert.equal(procStateFromStat(stat('S')), 'S');
  assert.equal(procStateFromStat(stat('Z')), 'Z');
  assert.equal(procStateFromStat(stat('R', 'node (x) y')), 'R');
  assert.equal(procStateFromStat('garbage'), null);
  assert.equal(procStateFromStat(''), null);
});

function deps(over: Partial<ProcessAliveDeps>): ProcessAliveDeps {
  return { kill: () => undefined, readStat: () => null, ...over };
}

test('isProcessAlive: signal-0 failure → dead, stat never consulted', () => {
  let statReads = 0;
  const d = deps({ kill: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); }, readStat: () => { statReads++; return stat('S'); } });
  assert.equal(isProcessAlive(1, d), false);
  assert.equal(statReads, 0);
});

test('isProcessAlive: running / sleeping / stopped states are alive', () => {
  for (const st of ['R', 'S', 'D', 'T', 't', 'I']) {
    assert.equal(isProcessAlive(1, deps({ readStat: () => stat(st) })), true, st);
  }
});

test('isProcessAlive: a ZOMBIE (Z) or dead (X) pid is DEAD even though signal 0 succeeds', () => {
  assert.equal(isProcessAlive(1, deps({ readStat: () => stat('Z') })), false);
  assert.equal(isProcessAlive(1, deps({ readStat: () => stat('X') })), false);
});

test('isProcessAlive: unreadable stat (non-Linux, EACCES, race) stays conservative = alive', () => {
  assert.equal(isProcessAlive(1, deps({ readStat: () => null })), true);
  assert.equal(isProcessAlive(1, deps({ readStat: () => 'not a stat line' })), true);
});

test('killOwner over a zombie owner: reports killed (dead) instead of kill-failed', async () => {
  // The exact 117 shape: the pid exists (signal 0 ok) but /proc says Z from the start.
  const zombieStat = stat('Z');
  const calls: string[] = [];
  const exec: KillExec = {
    isAlive: (p) => isProcessAlive(p, deps({ readStat: () => zombieStat })),
    signal: (_p, sig) => calls.push(sig),
    taskkill: () => calls.push('taskkill'),
    sleep: async () => {},
  };
  const r = await killOwner(4242, { isWindows: false, graceMs: 500, pollMs: 250 }, exec);
  assert.equal(r.killed, true);
  assert.equal(r.wasAlive, false, 'a zombie was never alive to kill');
  assert.equal(r.method, 'none');
  assert.deepEqual(calls, [], 'no signal is sent to a corpse');
});

test('killOwner: owner turns zombie AFTER SIGTERM (parent slow to reap) → sigterm succeeded, no SIGKILL escalation', async () => {
  const seq = ['S', 'Z'];
  let i = 0;
  const calls: string[] = [];
  const exec: KillExec = {
    isAlive: (p) => isProcessAlive(p, deps({ readStat: () => stat(seq[Math.min(i++, seq.length - 1)]) })),
    signal: (_p, sig) => calls.push(sig),
    taskkill: () => calls.push('taskkill'),
    sleep: async () => {},
  };
  const r = await killOwner(4242, { isWindows: false, graceMs: 1000, pollMs: 250 }, exec);
  assert.equal(r.killed, true);
  assert.equal(r.method, 'sigterm');
  assert.deepEqual(calls, ['SIGTERM']);
});
