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

export type PlacementDecision =
  | { go: false; reason: 'dependency'; waitOn: string[] }
  | { go: false; reason: 'resource'; conflictWith: string }
  | { go: true; env: 'cloud' }
  | { go: true; env: 'worktree'; host: string; repo: string; branch: string }
  | { go: true; env: 'shared'; lease: string };

function isRunning(m: Mission): boolean {
  return m.status === 'active' && !!m.binding?.sessionId;
}

function isTerminal(m: Mission): boolean {
  return m.status === 'done' || m.status === 'failed';
}

/** Resolve where a mission's executor may run: dependency gate → resource conflict → isolation. */
export function place(m: Mission, all: Mission[]): PlacementDecision {
  // 1) ordering gate — a dependency is met only if it exists AND is done.
  const unmet = m.dependsOn.filter((id) => {
    const dep = all.find((x) => x.id === id);
    return !dep || dep.status !== 'done';
  });
  if (unmet.length > 0) return { go: false, reason: 'dependency', waitOn: unmet };

  // 2) resource conflict — same host, same resource. A running holder always blocks;
  //    an exclusive resource (either side) is reserved even when its holder is idle/paused.
  for (const res of m.env.resources) {
    const holder = all.find(
      (a) =>
        a.id !== m.id &&
        a.env.host === m.env.host &&
        a.env.resources.includes(res) &&
        !isTerminal(a) &&
        (isRunning(a) || a.env.exclusive === true || m.env.exclusive === true),
    );
    if (holder) return { go: false, reason: 'resource', conflictWith: holder.id };
  }

  // 3) isolate: cloud (separate VM) > worktree (branchable repo); else explicitly shared.
  if (m.env.isolation === 'cloud') return { go: true, env: 'cloud' };
  if (m.env.isolation === 'worktree') {
    return { go: true, env: 'worktree', host: m.env.host ?? '', repo: m.env.repo ?? '', branch: m.env.branch ?? `mission/${m.id}` };
  }
  return { go: true, env: 'shared', lease: m.env.resources.join(',') || m.id };
}
