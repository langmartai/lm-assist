import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  notifyLocalWorkersOfClusterChange,
  buildClusterChangeMessage,
  isWorkerActive,
} from '../worker-role/cluster-change-notify';
import type { WorkerRecord } from '../worker-role/types';
import type { TaskStatus } from '../worker-role/types';
import type { InjectionResult } from '../session-messaging/types';

function worker(sessionId: string, status: TaskStatus = 'working'): WorkerRecord {
  return { sessionId, role: 'worker', tasks: [{ id: 't1', title: 'x', status }], orchestrator: {}, updatedAt: 1 };
}

const okResult: InjectionResult = { driver: 'cc-session', delivered: true, detail: 'ok' };

test('notify injects into the injectable worker only (skips one with no session)', async () => {
  const calls: Array<{ sessionId: string; text: string }> = [];
  const inject = async (sessionId: string, text: string): Promise<InjectionResult> => {
    calls.push({ sessionId, text });
    return okResult;
  };
  await notifyLocalWorkersOfClusterChange('alpha', 'beta', {
    listWorkers: () => [worker('s-active'), worker('')], // one injectable, one not
    inject,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 's-active');
  assert.match(calls[0].text, /⟦CLUSTER-CHANGE⟧/);
  assert.match(calls[0].text, /⟦\/CLUSTER-CHANGE⟧/);
  assert.ok(calls[0].text.includes('"alpha"'), 'message embeds fromCluster');
  assert.ok(calls[0].text.includes('"beta"'), 'message embeds toCluster');
});

test('notify never throws when the injector rejects', async () => {
  let called = 0;
  const inject = async (): Promise<InjectionResult> => {
    called++;
    throw new Error('boom');
  };
  await assert.doesNotReject(() =>
    notifyLocalWorkersOfClusterChange('alpha', 'beta', {
      listWorkers: () => [worker('s-active')],
      inject,
    }),
  );
  assert.equal(called, 1); // it did attempt the injection, then swallowed the rejection
});

test('notify never throws when the store read throws', async () => {
  await assert.doesNotReject(() =>
    notifyLocalWorkersOfClusterChange('alpha', 'beta', {
      listWorkers: () => {
        throw new Error('store down');
      },
      inject: async () => okResult,
    }),
  );
});

test('notify skips inactive workers (all tasks terminal)', async () => {
  const calls: string[] = [];
  await notifyLocalWorkersOfClusterChange('alpha', 'beta', {
    listWorkers: () => [worker('s-done', 'done'), worker('s-live', 'working')],
    inject: async (sessionId) => {
      calls.push(sessionId);
      return okResult;
    },
  });
  assert.deepEqual(calls, ['s-live']);
});

test('isWorkerActive: incomplete active, all-terminal inactive, no-tasks active', () => {
  assert.equal(isWorkerActive(worker('s', 'working')), true);
  assert.equal(isWorkerActive(worker('s', 'done')), false);
  assert.equal(isWorkerActive(worker('s', 'skipped')), false);
  assert.equal(isWorkerActive({ sessionId: 's', role: 'worker', tasks: [], orchestrator: {}, updatedAt: 1 }), true);
});

test('buildClusterChangeMessage embeds from/to + keep-running guidance', () => {
  const m = buildClusterChangeMessage('alpha', 'beta');
  assert.ok(m.includes('"alpha"'));
  assert.ok(m.includes('"beta"'));
  assert.match(m, /KEEP RUNNING/);
  assert.match(m, /report_status/);
});
