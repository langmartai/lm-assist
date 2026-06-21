// core/src/worker-role/model.ts
import type { OrchestratorRef, OrchestratorLiveness } from './types';

export const ORCHESTRATOR_WINDOW_MS = 5 * 60_000;

export function liveness(orch: OrchestratorRef, now: number, windowMs = ORCHESTRATOR_WINDOW_MS): OrchestratorLiveness {
  if (!orch || !orch.id) return 'none';
  if (typeof orch.lastContact !== 'number') return 'inactive';
  return now - orch.lastContact <= windowMs ? 'active' : 'inactive';
}

import type { Task } from './types';

/** A worker may proceed past a task only when it has no gate, or its gate is agreed. */
export function canProceed(task: Task): boolean {
  if (!task.gate) return true;
  return task.gate.state === 'agreed';
}

/** Resolve an OPEN gate. Agreeing unblocks the task (need_approval → working). */
export function decideGate(task: Task, decision: 'agree' | 'reject', by: string, note: string | undefined, now: number): Task {
  if (!task.gate || task.gate.state !== 'open') throw new Error('no open gate to decide');
  const state = decision === 'agree' ? 'agreed' : 'rejected';
  const gate = { ...task.gate, state: state as 'agreed' | 'rejected', decidedBy: by, decidedAt: now, note };
  const status: Task['status'] = decision === 'agree' ? 'working' : 'blocked';
  return { ...task, gate, status };
}

/** Derive each parent's status from its direct children (leaves keep their own status). */
export function rollUp(tasks: Task[]): Task[] {
  const childrenOf = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.parentId) {
      const arr = childrenOf.get(t.parentId) ?? [];
      arr.push(t);
      childrenOf.set(t.parentId, arr);
    }
  }
  const derive = (kids: Task[]): Task['status'] => {
    if (kids.some((k) => k.status === 'working' || k.status === 'need_approval')) return 'working';
    if (kids.some((k) => k.status === 'blocked')) return 'blocked';
    if (kids.every((k) => k.status === 'done' || k.status === 'skipped')) return 'done';
    if (kids.some((k) => k.status !== 'todo')) return 'working';
    return 'todo';
  };
  return tasks.map((t) => {
    const kids = childrenOf.get(t.id);
    return kids && kids.length ? { ...t, status: derive(kids) } : t;
  });
}
