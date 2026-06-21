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
