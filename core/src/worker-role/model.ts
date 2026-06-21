// core/src/worker-role/model.ts
import type {
  OrchestratorRef,
  OrchestratorLiveness,
  Task,
  WorkerRecord,
  SetRoleInput,
  ReportInput,
} from './types';

export const ORCHESTRATOR_WINDOW_MS = 5 * 60_000;

export function liveness(orch: OrchestratorRef, now: number, windowMs = ORCHESTRATOR_WINDOW_MS): OrchestratorLiveness {
  if (!orch || !orch.id) return 'none';
  if (typeof orch.lastContact !== 'number') return 'inactive';
  return now - orch.lastContact <= windowMs ? 'active' : 'inactive';
}

/** A worker may proceed past a task only when it has no gate, or its gate is agreed. */
export function canProceed(task: Task): boolean {
  if (!task.gate) return true;
  return task.gate.state === 'agreed';
}

/** Resolve an OPEN gate. Agreeing unblocks the task (need_approval → working). */
export function decideGate(task: Task, decision: 'agree' | 'reject', by: string, note: string | undefined, now: number): Task {
  if (!task.gate || task.gate.state !== 'open') throw new Error('no open gate to decide');
  const state = decision === 'agree' ? 'agreed' : 'rejected';
  const gate = { ...task.gate, state: state as 'agreed' | 'rejected', decidedBy: by, decidedAt: now, ...(note !== undefined && { note }) };
  const status: Task['status'] = decision === 'agree' ? 'working' : 'blocked';
  return { ...task, gate, status };
}

/** Set/replace the active role and (optionally) append a worker-OWNED task. One active role only. */
export function applySetRole(prev: WorkerRecord | null, sessionId: string, input: SetRoleInput, now: number, genId: () => string): WorkerRecord {
  const rec: WorkerRecord = prev && prev.sessionId === sessionId
    ? { ...prev, role: 'worker', updatedAt: now }
    : { sessionId, role: 'worker', tasks: [], orchestrator: {}, updatedAt: now };
  rec.tasks = [...rec.tasks];
  if (input.orchestrator) rec.orchestrator = { ...rec.orchestrator, id: input.orchestrator };
  if (input.task) {
    rec.tasks.push({ id: input.task.id ?? genId(), title: input.task.title, group: input.task.group, parentId: input.task.parentId, status: 'todo' });
  }
  return rec;
}

/** Apply a worker's status report to one of its tasks. status=need_approval opens a gate.
 *  When status moves past need_approval (any other status) and the task has a stale OPEN gate,
 *  that gate is cleared — the worker has self-cancelled it. Already-agreed/rejected gates are
 *  preserved as resolved history. */
export function applyReportStatus(prev: WorkerRecord, input: ReportInput, now: number): WorkerRecord {
  const tasks = prev.tasks.map((t) => {
    if (t.id !== input.taskId) return t;
    const next: Task = { ...t };
    if (input.status) next.status = input.status;
    if (input.progress !== undefined) next.progress = input.progress;
    if (input.detail !== undefined) next.detail = input.detail;
    if (input.status === 'need_approval') {
      next.gate = { state: 'open', reason: input.reason ?? 'approval required', requestedAt: now };
    } else if (input.status && t.gate?.state === 'open') {
      // Worker moved past need_approval — clear the stale open gate.
      // Only open gates are cleared; agreed/rejected are resolved history and must be kept.
      delete next.gate;
    }
    return next;
  });
  return { ...prev, tasks, updatedAt: now };
}

/**
 * Derive each parent's status from its direct children (leaves keep their own status).
 * Iterates the single-pass derivation to a fixpoint so arbitrary-depth trees
 * (grandparent → parent → child) propagate fully.
 */
export function rollUp(tasks: Task[]): Task[] {
  const derive = (kids: Task[]): Task['status'] => {
    if (kids.some((k) => k.status === 'working' || k.status === 'need_approval')) return 'working';
    if (kids.some((k) => k.status === 'blocked')) return 'blocked';
    if (kids.every((k) => k.status === 'done' || k.status === 'skipped')) return 'done';
    if (kids.some((k) => k.status !== 'todo')) return 'working';
    return 'todo';
  };
  let current = tasks;
  for (;;) {
    const childrenOf = new Map<string, Task[]>();
    for (const t of current) {
      if (t.parentId) {
        const arr = childrenOf.get(t.parentId) ?? [];
        arr.push(t);
        childrenOf.set(t.parentId, arr);
      }
    }
    let changed = false;
    const next = current.map((t) => {
      const kids = childrenOf.get(t.id);
      if (!kids || !kids.length) return t;
      const status = derive(kids);
      if (status === t.status) return t;
      changed = true;
      return { ...t, status };
    });
    current = next;
    if (!changed) return current;
  }
}
