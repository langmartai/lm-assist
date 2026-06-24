/** Pure Mission model: types + constructors + decision/placement logic. No IO. */

import { backoffMinutes } from '../monitor/stall-state';

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
  ccr?: { cse: string; sid: string; webUrl?: string | null; tmuxSession?: string };
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

/** Display name for a controller-spawned executor session — identifiable + traceable to the mission. */
export function missionSessionTitle(m: Mission): string {
  return `Mission: ${m.title} · ${m.id.replace(/^mission_/, '')}`;
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

export interface ExecutorOutput {
  cursor: number;
  messages: string[];
  results: Array<{ ref: string; summary?: string }>;
}

export interface ExecutorState {
  alive: boolean;
  serverStalled: boolean;
  gate: { taskId: string; reason: string } | null;
  newOutput: ExecutorOutput | null;
  idle: boolean;
}

export type MissionDecision =
  | { kind: 'rebind' }
  | { kind: 'defer' }
  | { kind: 'gate'; reason: string }
  | { kind: 'adjust'; output: ExecutorOutput }
  | { kind: 'place' };

/** Pure phase dispatch for one mission given its executor's state. */
export function decideMission(m: Mission, st: ExecutorState): MissionDecision {
  const bound = !!m.binding?.sessionId;
  if (bound && !st.alive) return { kind: 'rebind' };
  if (st.serverStalled) return { kind: 'defer' };
  if (st.gate) return { kind: 'gate', reason: st.gate.reason };
  if (st.newOutput) return { kind: 'adjust', output: st.newOutput };
  return { kind: 'place' };
}

export interface MissionNudgeCfg {
  intervalMin: number;
  maxNudges: number;
}

/** Capped, widening backoff for the parked-executor `continue` nudge (reuses backoffMinutes). */
export function planMissionNudge(
  control: MissionControl,
  cfg: MissionNudgeCfg,
  now: number,
): { action: 'nudge' | 'wait' | 'giveup'; control: MissionControl } {
  if (control.gaveUp) return { action: 'wait', control };
  if (control.nudgeCount >= cfg.maxNudges) return { action: 'giveup', control: { ...control, gaveUp: true } };
  if (control.nudgeCount > 0) {
    const dueAt = (control.lastNudgeAt ?? 0) + backoffMinutes(control.backoffStep, cfg.intervalMin) * 60_000;
    if (now < dueAt) return { action: 'wait', control };
  }
  return { action: 'nudge', control: { ...control, nudgeCount: control.nudgeCount + 1, lastNudgeAt: now, backoffStep: control.backoffStep + 1 } };
}

export type AdjustVerdict = 'continue' | 'revise' | 'done' | 'blocked' | 'gate';
export interface AdjustResult {
  verdict: AdjustVerdict;
  revisedObjective: string | null;
  revisedNextSteps: string[] | null;
  isMaterialPivot: boolean;
  nextDirective: string;
  reason: string;
}

export const ADJUST_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['continue', 'revise', 'done', 'blocked', 'gate'] },
    revisedObjective: { type: ['string', 'null'] },
    revisedNextSteps: { type: ['array', 'null'], items: { type: 'string' } },
    isMaterialPivot: { type: 'boolean' },
    nextDirective: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['verdict', 'nextDirective'],
} as const;

const VERDICTS = new Set<AdjustVerdict>(['continue', 'revise', 'done', 'blocked', 'gate']);
const DEFAULT_ADJUST: AdjustResult = {
  verdict: 'continue', revisedObjective: null, revisedNextSteps: null,
  isMaterialPivot: false, nextDirective: 'continue', reason: 'default (unparseable adjust result)',
};

function extractJson(raw: string): string {
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s === -1 || e === -1 || e < s) throw new Error('no json');
  return raw.slice(s, e + 1);
}

/** Parse the adjust LLM output; never throws — defaults to a safe `continue`. */
export function parseAdjustResult(raw: string): AdjustResult {
  try {
    const j = JSON.parse(extractJson(raw)) as Record<string, unknown>;
    const verdict = VERDICTS.has(j.verdict as AdjustVerdict) ? (j.verdict as AdjustVerdict) : 'continue';
    const directive = typeof j.nextDirective === 'string' && j.nextDirective.trim() ? (j.nextDirective as string) : 'continue';
    return {
      verdict,
      revisedObjective: typeof j.revisedObjective === 'string' ? (j.revisedObjective as string) : null,
      revisedNextSteps: Array.isArray(j.revisedNextSteps) ? (j.revisedNextSteps as unknown[]).filter((x) => typeof x === 'string') as string[] : null,
      isMaterialPivot: j.isMaterialPivot === true,
      nextDirective: directive,
      reason: typeof j.reason === 'string' ? (j.reason as string) : '',
    };
  } catch {
    return { ...DEFAULT_ADJUST };
  }
}
