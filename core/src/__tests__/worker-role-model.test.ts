import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStatusBlock, parseStatusBlock } from '../worker-role/status-block';
import type { StatusLine } from '../worker-role/types';

test('status-block: format → parse round-trips a full line', () => {
  const s: StatusLine = { taskId: 't1', phase: 'Phase 1', status: 'working', progress: '3/5', last: 'wrote the codec', next: 'add the store' };
  const round = parseStatusBlock(formatStatusBlock(s));
  assert.deepEqual(round, s);
});

test('status-block: a need_approval line carries the gate reason', () => {
  const s: StatusLine = { taskId: 't9', status: 'need_approval', last: 'ready to deploy', gate: 'prod deploy — confirm?' };
  const text = formatStatusBlock(s);
  assert.match(text, /status=need_approval/);
  assert.match(text, /gate: prod deploy — confirm\?/);
  assert.deepEqual(parseStatusBlock(text), s);
});

test('status-block: parse ignores surrounding prose, returns null when absent', () => {
  const s: StatusLine = { taskId: 't1', status: 'done' };
  const wrapped = `Some narration above.\n${formatStatusBlock(s)}\nMore prose below.`;
  assert.deepEqual(parseStatusBlock(wrapped), s);
  assert.equal(parseStatusBlock('no block here'), null);
});

import { liveness } from '../worker-role/model';
import type { OrchestratorRef } from '../worker-role/types';

test('liveness: none when no id, active within window, inactive when stale', () => {
  const now = 1_000_000_000_000;
  const WIN = 5 * 60_000;
  assert.equal(liveness({}, now, WIN), 'none');
  assert.equal(liveness({ id: 'o1' }, now, WIN), 'inactive');                       // id but never contacted
  assert.equal(liveness({ id: 'o1', lastContact: now - 1000 }, now, WIN), 'active');
  assert.equal(liveness({ id: 'o1', lastContact: now - WIN - 1 }, now, WIN), 'inactive');
});

import { decideGate, canProceed } from '../worker-role/model';
import type { Task } from '../worker-role/types';

test('gate: canProceed true when no gate or agreed; false when open', () => {
  const base: Task = { id: 't1', title: 'x', status: 'working' };
  assert.equal(canProceed(base), true);
  assert.equal(canProceed({ ...base, status: 'need_approval', gate: { state: 'open', reason: 'r', requestedAt: 1 } }), false);
  assert.equal(canProceed({ ...base, gate: { state: 'agreed', reason: 'r', requestedAt: 1 } }), true);
  assert.equal(canProceed({ ...base, gate: { state: 'rejected', reason: 'r', requestedAt: 1 } }), false);
});

test('gate: decideGate flips an open gate and stamps the decider', () => {
  const t: Task = { id: 't1', title: 'x', status: 'need_approval', gate: { state: 'open', reason: 'deploy?', requestedAt: 1 } };
  const agreed = decideGate(t, 'agree', 'orch-1', 'go ahead', 2000);
  assert.equal(agreed.gate?.state, 'agreed');
  assert.equal(agreed.gate?.decidedBy, 'orch-1');
  assert.equal(agreed.gate?.decidedAt, 2000);
  assert.equal(agreed.gate?.note, 'go ahead');
  assert.equal(agreed.status, 'working');                       // agreeing unblocks the task
});

test('gate: decideGate throws when there is no open gate', () => {
  const t: Task = { id: 't1', title: 'x', status: 'working' };
  assert.throws(() => decideGate(t, 'agree', 'o', undefined, 1), /no open gate/i);
});
