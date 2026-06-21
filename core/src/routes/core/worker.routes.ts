/**
 * Worker Role Routes
 *
 * Five REST endpoints for the worker-role protocol.
 * All are behind the standard worker x-api-key (not data-access-key gated).
 *
 * POST /worker/role                        – set/update the WORKER role + append a task
 * POST /worker/status                      – a worker reports progress on one of its tasks
 * GET  /worker                             – list all worker records with orchestrator liveness
 * GET  /worker/:sessionId                  – read one worker record; ?orchestrator= stamps lastContact
 * POST /worker/:sessionId/gate             – resolve an open agree-gate (agree|reject)
 */

import type { RouteHandler, RouteContext } from '../index';
import { randomBytes } from 'crypto';
import { getRecord, listRecords, putRecord, stampOrchestrator } from '../../worker-role/worker-store';
import { applySetRole, applyReportStatus, decideGate, liveness } from '../../worker-role/model';

interface Envelope { success: boolean; data?: unknown; error?: { code: string; message: string }; }
const ok = <T>(data: T): Envelope => ({ success: true, data });
const fail = (code: string, message: string): Envelope => ({ success: false, error: { code, message } });
const genId = () => 'task_' + randomBytes(4).toString('hex');
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Attach derived orchestrator liveness to a record for read responses. */
function withLiveness(rec: any, now: number) {
  return { ...rec, orchestratorLiveness: liveness(rec.orchestrator, now) };
}

export function createWorkerRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // POST /worker/role — set/update the WORKER role and optionally append a task
    {
      method: 'POST',
      pattern: /^\/worker\/role$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const sessionId = str(b.sessionId);
        if (!sessionId) return fail('INVALID_INPUT', 'sessionId is required');
        const task = b.task as { title?: string } | undefined;
        if (b.role === 'none') {
          putRecord({ sessionId, role: 'worker', tasks: [], orchestrator: {}, updatedAt: Date.now() });
          return ok({ cleared: true });
        }
        if (task && !task.title) return fail('INVALID_INPUT', 'task.title is required');
        const rec = applySetRole(
          getRecord(sessionId),
          sessionId,
          { task: task as any, orchestrator: str(b.orchestrator) },
          Date.now(),
          genId,
        );
        return ok(putRecord(rec));
      },
    },

    // POST /worker/status — a worker reports progress on one of its tasks
    {
      method: 'POST',
      pattern: /^\/worker\/status$/,
      handler: async (req) => {
        const b = (req.body || {}) as Record<string, unknown>;
        const sessionId = str(b.sessionId);
        const taskId = str(b.taskId);
        if (!sessionId || !taskId) return fail('INVALID_INPUT', 'sessionId and taskId are required');
        const prev = getRecord(sessionId);
        if (!prev) return fail('NOT_FOUND', `no worker record for ${sessionId} (call /worker/role first)`);
        const rec = applyReportStatus(
          prev,
          { taskId, status: b.status as any, progress: str(b.progress), detail: str(b.detail), reason: str(b.reason) },
          Date.now(),
        );
        return ok(putRecord(rec));
      },
    },

    // GET /worker — list all worker records with orchestrator liveness
    {
      method: 'GET',
      pattern: /^\/worker$/,
      handler: async () => {
        const now = Date.now();
        return ok({ workers: listRecords().map((r) => withLiveness(r, now)) });
      },
    },

    // GET /worker/:sessionId — read one worker record; ?orchestrator= stamps lastContact
    {
      method: 'GET',
      pattern: /^\/worker\/(?<sessionId>[^/]+)$/,
      handler: async (req) => {
        const sessionId = req.params.sessionId;
        const orchestrator = str((req.query || {}).orchestrator);
        const now = Date.now();
        const rec = orchestrator
          ? stampOrchestrator(sessionId, orchestrator, now)
          : getRecord(sessionId);
        if (!rec) return fail('NOT_FOUND', `no worker record for ${sessionId}`);
        return ok(withLiveness(rec, now));
      },
    },

    // POST /worker/:sessionId/gate — resolve an open agree-gate
    {
      method: 'POST',
      pattern: /^\/worker\/(?<sessionId>[^/]+)\/gate$/,
      handler: async (req) => {
        const sessionId = req.params.sessionId;
        const b = (req.body || {}) as Record<string, unknown>;
        const taskId = str(b.taskId);
        const decision = b.decision;
        if (!taskId || (decision !== 'agree' && decision !== 'reject')) {
          return fail('INVALID_INPUT', 'taskId and decision (agree|reject) are required');
        }
        const prev = getRecord(sessionId);
        if (!prev) return fail('NOT_FOUND', `no worker record for ${sessionId}`);
        const idx = prev.tasks.findIndex((t) => t.id === taskId);
        if (idx < 0) return fail('NOT_FOUND', `task ${taskId} not found`);
        try {
          const tasks = [...prev.tasks];
          tasks[idx] = decideGate(tasks[idx], decision, str(b.by) ?? 'unknown', str(b.note), Date.now());
          return ok(putRecord({ ...prev, tasks, updatedAt: Date.now() }));
        } catch (e) {
          return fail('PRECONDITION_FAILED', (e as Error).message);
        }
      },
    },
  ];
}
