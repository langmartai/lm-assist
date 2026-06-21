import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wrkroutes-'));

import { createWorkerRoutes } from '../routes/core/worker.routes';

const routes = createWorkerRoutes({} as any);
const find = (method: string, urlPath: string) => {
  const r = routes.find((x) => x.method === method && x.pattern.test(urlPath));
  if (!r) throw new Error(`no route ${method} ${urlPath}`);
  const params = (r.pattern.exec(urlPath) as any)?.groups ?? {};
  return { r, params };
};
const call = async (method: string, urlPath: string, body?: any) => {
  const { r, params } = find(method, urlPath);
  return r.handler({ params, query: {}, body } as any, {} as any);
};

test('routes: set role → report status → read → decide gate', async () => {
  const set = await call('POST', '/worker/role', { sessionId: 's1', task: { title: 'deploy' } });
  assert.equal((set as any).success, true);
  const taskId = (set as any).data.tasks[0].id;

  await call('POST', '/worker/status', { sessionId: 's1', taskId, status: 'need_approval', reason: 'prod?' });
  const read = await call('GET', '/worker/s1', undefined);
  assert.equal((read as any).data.tasks[0].gate.state, 'open');

  const decided = await call('POST', '/worker/s1/gate', { taskId, decision: 'agree', by: 'orch-1', note: 'go' });
  assert.equal((decided as any).data.tasks[0].gate.state, 'agreed');
  assert.equal((decided as any).data.tasks[0].status, 'working');
});

test('routes: GET /worker/:id stamps the reader as orchestrator when ?orchestrator= is given', async () => {
  await call('POST', '/worker/role', { sessionId: 's2', task: { title: 't' } });
  const { r, params } = find('GET', '/worker/s2');
  const read = await r.handler({ params, query: { orchestrator: 'orch-9' }, body: undefined } as any, {} as any);
  assert.equal((read as any).data.orchestrator.id, 'orch-9');
  assert.equal(typeof (read as any).data.orchestrator.lastContact, 'number');
});

// ── Negative tests: validation / 404 / precondition logic lives ONLY in the route layer ──

const errOf = (res: any) => (res as any).error?.code;

test('routes: POST /worker/role without sessionId → INVALID_INPUT', async () => {
  const res = await call('POST', '/worker/role', { task: { title: 'x' } });
  assert.equal((res as any).success, false);
  assert.equal(errOf(res), 'INVALID_INPUT');
});

test('routes: POST /worker/role with a task missing title → INVALID_INPUT', async () => {
  const res = await call('POST', '/worker/role', { sessionId: 'neg-role', task: { group: 'Phase 1' } });
  assert.equal((res as any).success, false);
  assert.equal(errOf(res), 'INVALID_INPUT');
});

test('routes: POST /worker/status for an unknown sessionId → NOT_FOUND', async () => {
  const res = await call('POST', '/worker/status', { sessionId: 'does-not-exist', taskId: 't1', status: 'working' });
  assert.equal((res as any).success, false);
  assert.equal(errOf(res), 'NOT_FOUND');
});

test('routes: POST /worker/status for an unknown taskId → NOT_FOUND (no silent no-op)', async () => {
  await call('POST', '/worker/role', { sessionId: 'neg-status', task: { title: 'real' } });
  const res = await call('POST', '/worker/status', { sessionId: 'neg-status', taskId: 'task_ghost', status: 'working' });
  assert.equal((res as any).success, false);
  assert.equal(errOf(res), 'NOT_FOUND');
});

test('routes: POST /worker/status with an invalid status value → INVALID_INPUT', async () => {
  const set = await call('POST', '/worker/role', { sessionId: 'neg-statusval', task: { title: 'real' } });
  const taskId = (set as any).data.tasks[0].id;
  const res = await call('POST', '/worker/status', { sessionId: 'neg-statusval', taskId, status: 'bogus' });
  assert.equal((res as any).success, false);
  assert.equal(errOf(res), 'INVALID_INPUT');
});

test('routes: GET /worker/:sessionId for an unknown sessionId → NOT_FOUND', async () => {
  const res = await call('GET', '/worker/no-such-session', undefined);
  assert.equal((res as any).success, false);
  assert.equal(errOf(res), 'NOT_FOUND');
});

test('routes: POST /worker/:sessionId/gate with no record → NOT_FOUND', async () => {
  const res = await call('POST', '/worker/no-record/gate', { taskId: 't1', decision: 'agree' });
  assert.equal((res as any).success, false);
  assert.equal(errOf(res), 'NOT_FOUND');
});

test('routes: POST /worker/:sessionId/gate for an unknown taskId → NOT_FOUND', async () => {
  await call('POST', '/worker/role', { sessionId: 'neg-gate', task: { title: 'real' } });
  const res = await call('POST', '/worker/neg-gate/gate', { taskId: 'task_ghost', decision: 'agree' });
  assert.equal((res as any).success, false);
  assert.equal(errOf(res), 'NOT_FOUND');
});

test('routes: POST /worker/:sessionId/gate when the task has no open gate → PRECONDITION_FAILED', async () => {
  const set = await call('POST', '/worker/role', { sessionId: 'neg-gateopen', task: { title: 'real' } });
  const taskId = (set as any).data.tasks[0].id;
  // task is 'todo' with no gate — decideGate should throw, mapped to PRECONDITION_FAILED
  const res = await call('POST', '/worker/neg-gateopen/gate', { taskId, decision: 'agree' });
  assert.equal((res as any).success, false);
  assert.equal(errOf(res), 'PRECONDITION_FAILED');
});
