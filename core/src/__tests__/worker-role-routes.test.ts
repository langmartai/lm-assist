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

// ── Task 8: MCP tool + scope coverage ───────────────────────────────────────
import { TOOL_SCOPES } from '../mcp-server/configure';
import { WORKER_ROLE_TOOL_DEFS } from '../mcp-server/tools/worker-role';

test('every worker-role tool has a TOOL_SCOPES entry (else Core crashes on /mcp)', () => {
  for (const def of WORKER_ROLE_TOOL_DEFS) {
    assert.ok(def.name in TOOL_SCOPES, `${def.name} missing from TOOL_SCOPES`);
  }
});

test('worker-role advertises the five tools', () => {
  const names = WORKER_ROLE_TOOL_DEFS.map((d) => d.name).sort();
  assert.deepEqual(names, ['decide_gate', 'list_workers', 'report_status', 'set_role', 'worker_status']);
});

// ── Task 9: Bootstrap ROLE section ──────────────────────────────────────────
import { renderRoleSection } from '../mcp-server/mcp-session-resolver';
import type { WorkerRecord } from '../worker-role/types';

test('renderRoleSection: worker contract names role, task, orchestrator + the print rule', () => {
  const rec: WorkerRecord = { sessionId: 's1', role: 'worker', tasks: [{ id: 't1', title: 'deploy', status: 'working' }], orchestrator: { id: 'o1', lastContact: Date.now() }, updatedAt: Date.now() };
  const s = renderRoleSection(rec, Date.now());
  assert.match(s, /You are a WORKER/);
  assert.match(s, /WORKER-STATUS/);            // the print contract
  assert.match(s, /orchestrator/i);
  assert.match(s, /active/);                    // liveness reflected
});

test('renderRoleSection: no record → a one-line set_role hint, no guessing', () => {
  const s = renderRoleSection(null, Date.now());
  assert.match(s, /set_role/);
  assert.doesNotMatch(s, /You are a WORKER/);
});

// ── Task 11: End-to-end integration test ────────────────────────────────────
import { liveness as live2 } from '../worker-role/model';

test('e2e: self-directed worker (orchestrator none) then an orchestrator attaches and agrees a gate', async () => {
  // 1) manual mode: worker self-assigns, orchestrator none
  const set = await call('POST', '/worker/role', { sessionId: 'e2e', task: { title: 'ship', group: 'Phase 1' } });
  const taskId = (set as any).data.tasks[0].id;
  assert.equal(live2((set as any).data.orchestrator, Date.now()), 'none');

  // 2) worker raises an agree-gate and stops
  await call('POST', '/worker/status', { sessionId: 'e2e', taskId, status: 'need_approval', reason: 'prod deploy?' });

  // 3) an orchestrator reads it → becomes active
  const read = await (async () => { const { r, params } = find('GET', '/worker/e2e'); return r.handler({ params, query: { orchestrator: 'orch-e2e' }, body: undefined } as any, {} as any); })();
  assert.equal((read as any).data.orchestratorLiveness, 'active');

  // 4) orchestrator agrees the gate → task unblocks
  const decided = await call('POST', '/worker/e2e/gate', { taskId, decision: 'agree', by: 'orch-e2e' });
  assert.equal((decided as any).data.tasks[0].gate.state, 'agreed');
  assert.equal((decided as any).data.tasks[0].status, 'working');
});
