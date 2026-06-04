/**
 * Unit tests for terminal-attach-policy.ts — the safety rule that forbids
 * attaching a writable console / launching a `claude --resume` duplicate against
 * a Claude session running OUTSIDE tmux.
 *
 * Pure functions; liveness is injected, so no real PIDs / ps / tmux are touched.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isNonTmuxProcess, findLiveNonTmuxSession, type AttachCandidate } from '../../terminal-attach-policy';

const alive = (_pid: number) => true;
const dead = (_pid: number) => false;

test('isNonTmuxProcess: a tmux-backed process is NOT non-tmux', () => {
  assert.equal(isNonTmuxProcess({ pid: 1, tmuxSessionName: 'claude-abc' }), false);
});

test('isNonTmuxProcess: a process with no tmux session IS non-tmux', () => {
  assert.equal(isNonTmuxProcess({ pid: 1 }), true);
  assert.equal(isNonTmuxProcess({ pid: 1, tmuxSessionName: undefined }), true);
});

test('findLiveNonTmuxSession: blocks a LIVE non-tmux session for the id', () => {
  const procs: AttachCandidate[] = [
    { pid: 10, sessionId: 'S1', source: 'external-terminal' }, // non-tmux, live
  ];
  const hit = findLiveNonTmuxSession(procs, 'S1', alive);
  assert.ok(hit, 'expected a block');
  assert.equal(hit!.pid, 10);
});

test('findLiveNonTmuxSession: a tmux-backed session is ALLOWED (returns null)', () => {
  const procs: AttachCandidate[] = [
    { pid: 11, sessionId: 'S1', tmuxSessionName: 'claude-S1' },
  ];
  assert.equal(findLiveNonTmuxSession(procs, 'S1', alive), null);
});

test('findLiveNonTmuxSession: a DEAD non-tmux session does NOT block', () => {
  const procs: AttachCandidate[] = [
    { pid: 12, sessionId: 'S1', source: 'external-terminal' },
  ];
  assert.equal(findLiveNonTmuxSession(procs, 'S1', dead), null);
});

test('findLiveNonTmuxSession: only matches the requested sessionId', () => {
  const procs: AttachCandidate[] = [
    { pid: 13, sessionId: 'OTHER', source: 'external-terminal' },
  ];
  assert.equal(findLiveNonTmuxSession(procs, 'S1', alive), null);
});

test('findLiveNonTmuxSession: empty sessionId never blocks (fresh session)', () => {
  const procs: AttachCandidate[] = [{ pid: 14, sessionId: '', source: 'external-terminal' }];
  assert.equal(findLiveNonTmuxSession(procs, '', alive), null);
});

test('findLiveNonTmuxSession: among mixed processes, returns the non-tmux live one', () => {
  const procs: AttachCandidate[] = [
    { pid: 20, sessionId: 'S1', tmuxSessionName: 'claude-S1' }, // tmux-backed (safe)
    { pid: 21, sessionId: 'S1', source: 'external-terminal' },  // non-tmux live (block)
  ];
  const hit = findLiveNonTmuxSession(procs, 'S1', alive);
  assert.ok(hit, 'expected a block on the non-tmux process');
  assert.equal(hit!.pid, 21);
});

test('findLiveNonTmuxSession: no processes → no block', () => {
  assert.equal(findLiveNonTmuxSession([], 'S1', alive), null);
});
