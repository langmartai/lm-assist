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
