// core/src/worker-role/types.ts
export type TaskStatus = 'todo' | 'working' | 'blocked' | 'need_approval' | 'done' | 'skipped';
export type GateState = 'open' | 'agreed' | 'rejected';
export type OrchestratorLiveness = 'none' | 'active' | 'inactive';

export interface Gate {
  state: GateState;
  reason: string;
  requestedAt: number;            // epoch ms
  decidedBy?: string;
  decidedAt?: number;
  note?: string;
}

export interface Task {
  id: string;
  title: string;
  group?: string;                 // phase label
  parentId?: string;              // sub-task linkage
  status: TaskStatus;
  progress?: string;
  detail?: string;
  gate?: Gate;
}

export interface OrchestratorRef {
  id?: string;
  lastContact?: number;           // epoch ms
}

export interface WorkerRecord {
  sessionId: string;
  role: 'worker';
  tasks: Task[];
  orchestrator: OrchestratorRef;
  updatedAt: number;
}

/** The one-block-per-turn status line the worker prints (derived from a task + narration). */
export interface StatusLine {
  taskId: string;
  phase?: string;
  status: TaskStatus;
  progress?: string;
  last?: string;
  next?: string;
  gate?: string;                  // reason; present when status === 'need_approval'
}
