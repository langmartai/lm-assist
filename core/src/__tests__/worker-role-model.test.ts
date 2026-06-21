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

test('liveness: exactly at the window boundary is still active', () => {
  const now = 1_000_000_000_000;
  const WIN = 5 * 60_000;
  assert.equal(liveness({ id: 'o1', lastContact: now - WIN }, now, WIN), 'active');
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

test('gate: decideGate reject halts the task and omits note when not given', () => {
  const t: Task = { id: 't1', title: 'x', status: 'need_approval', gate: { state: 'open', reason: 'deploy?', requestedAt: 1 } };
  const rejected = decideGate(t, 'reject', 'orch-1', undefined, 2000);
  assert.equal(rejected.status, 'blocked');
  assert.deepEqual(rejected.gate, { state: 'rejected', reason: 'deploy?', requestedAt: 1, decidedBy: 'orch-1', decidedAt: 2000 });
});

test('gate: decideGate throws when there is no open gate', () => {
  const t: Task = { id: 't1', title: 'x', status: 'working' };
  assert.throws(() => decideGate(t, 'agree', 'o', undefined, 1), /no open gate/i);
});

import { rollUp } from '../worker-role/model';

test('rollUp: a parent is done only when all children are done/skipped', () => {
  const tasks: Task[] = [
    { id: 'p', title: 'phase', status: 'todo' },
    { id: 'a', title: 'a', parentId: 'p', status: 'done' },
    { id: 'b', title: 'b', parentId: 'p', status: 'skipped' },
  ];
  assert.equal(rollUp(tasks).find((t) => t.id === 'p')!.status, 'done');
});

test('rollUp: a parent is working when any child is working/need_approval', () => {
  const tasks: Task[] = [
    { id: 'p', title: 'phase', status: 'todo' },
    { id: 'a', title: 'a', parentId: 'p', status: 'done' },
    { id: 'b', title: 'b', parentId: 'p', status: 'working' },
  ];
  assert.equal(rollUp(tasks).find((t) => t.id === 'p')!.status, 'working');
});

test('rollUp: leaves (no children) are unchanged', () => {
  const tasks: Task[] = [{ id: 'a', title: 'a', status: 'blocked' }];
  assert.deepEqual(rollUp(tasks), tasks);
});

test('rollUp: propagates through multi-level trees (grandparent → parent → child)', () => {
  const tasks: Task[] = [
    { id: 'gp', title: 'grandparent', status: 'todo' },
    { id: 'p', title: 'parent', parentId: 'gp', status: 'todo' },
    { id: 'c', title: 'child', parentId: 'p', status: 'working' },
  ];
  const rolled = rollUp(tasks);
  assert.equal(rolled.find((t) => t.id === 'p')!.status, 'working');
  assert.equal(rolled.find((t) => t.id === 'gp')!.status, 'working');
});

import { applySetRole, applyReportStatus } from '../worker-role/model';
import type { WorkerRecord } from '../worker-role/types';

test('applySetRole: creates a worker record with a worker-owned task (auto-id)', () => {
  const rec = applySetRole(null, 'sess-1', { task: { title: 'do X' }, orchestrator: 'orch-9' }, 1000, () => 'task-aaa');
  assert.equal(rec.role, 'worker');
  assert.equal(rec.sessionId, 'sess-1');
  assert.equal(rec.tasks.length, 1);
  assert.equal(rec.tasks[0].id, 'task-aaa');
  assert.equal(rec.tasks[0].status, 'todo');
  assert.equal(rec.orchestrator.id, 'orch-9');
});

test('applySetRole: a second call appends a task, keeps ONE active role', () => {
  const r1 = applySetRole(null, 'sess-1', { task: { title: 'first' } }, 1000, () => 'task-1');
  const r2 = applySetRole(r1, 'sess-1', { task: { title: 'second' } }, 2000, () => 'task-2');
  assert.equal(r2.tasks.length, 2);
  assert.equal(r2.role, 'worker');
});

test('applyReportStatus: updates a task status; need_approval opens a gate', () => {
  const r1 = applySetRole(null, 'sess-1', { task: { title: 'deploy' } }, 1000, () => 'task-1');
  const r2 = applyReportStatus(r1, { taskId: 'task-1', status: 'need_approval', reason: 'prod?' }, 3000);
  const t = r2.tasks[0];
  assert.equal(t.status, 'need_approval');
  assert.equal(t.gate?.state, 'open');
  assert.equal(t.gate?.reason, 'prod?');
  assert.equal(r2.updatedAt, 3000);
});

test('applyReportStatus: a non-need_approval status updates the task without a gate', () => {
  const r1 = applySetRole(null, 'sess-1', { task: { title: 'deploy' } }, 1000, () => 'task-1');
  const r2 = applyReportStatus(r1, { taskId: 'task-1', status: 'done' }, 3000);
  const t = r2.tasks[0];
  assert.equal(t.status, 'done');
  assert.equal(t.gate, undefined);
});
