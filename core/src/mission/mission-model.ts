/** Pure Mission model: types + constructors + decision/placement logic. No IO. */

export type MissionStatus = 'draft' | 'active' | 'waiting' | 'paused' | 'blocked' | 'done' | 'failed';
export type ExecutorKind = 'orchestrator' | 'worker';
export type Isolation = 'cloud' | 'worktree' | 'shared';

export interface MissionEnv {
  isolation: Isolation;
  host?: string;
  repo?: string;
  branch?: string;
  resources: string[];
  exclusive?: boolean;
}
export interface MissionBinding {
  sessionId: string | null;
  node: string | null;
  kind: ExecutorKind | null;
  boundAt?: number;
}
export interface MissionProgress { percent: number; summary: string; updatedAt: number; }
export interface MissionControl {
  lastTickAt?: number;
  lastNudgeAt?: number;
  nudgeCount: number;
  backoffStep: number;
  lastOutputCursor?: number;
  waitReason?: 'dependency' | 'resource';
  gaveUp?: boolean;
}
export interface MissionResult { at: number; ref: string; summary?: string; }
export interface MissionAdjustment { at: number; trigger: string; change: string; by: 'controller' | 'user'; }

export interface Mission {
  id: string;
  title: string;
  objective: string;
  plan?: string;
  nextSteps?: string[];
  projects: string[];
  dependsOn: string[];
  env: MissionEnv;
  binding: MissionBinding | null;
  progress: MissionProgress | null;
  control: MissionControl;
  results: MissionResult[];
  adjustments: MissionAdjustment[];
  status: MissionStatus;
  ownerNode: string;
  createdAt: number;
  updatedAt: number;
}

export interface NewMissionInput {
  title: string;
  objective: string;
  ownerNode: string;
  projects?: string[];
  dependsOn?: string[];
  env?: Partial<MissionEnv>;
  plan?: string;
  nextSteps?: string[];
}

export function newMission(input: NewMissionInput, now: number, genId: () => string): Mission {
  return {
    id: genId(),
    title: input.title,
    objective: input.objective,
    plan: input.plan,
    nextSteps: input.nextSteps,
    projects: input.projects ?? [],
    dependsOn: input.dependsOn ?? [],
    env: {
      isolation: input.env?.isolation ?? 'cloud',
      host: input.env?.host,
      repo: input.env?.repo,
      branch: input.env?.branch,
      resources: input.env?.resources ?? [],
      exclusive: input.env?.exclusive,
    },
    binding: null,
    progress: null,
    control: { nudgeCount: 0, backoffStep: 0 },
    results: [],
    adjustments: [],
    status: 'active',
    ownerNode: input.ownerNode,
    createdAt: now,
    updatedAt: now,
  };
}
