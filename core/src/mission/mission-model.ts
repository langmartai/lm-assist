/** Pure Mission model: types + constructors + decision/placement logic. No IO. */

import { backoffMinutes } from '../monitor/stall-state';

export type MissionStatus = 'draft' | 'active' | 'waiting' | 'paused' | 'blocked' | 'done' | 'failed';
export type ExecutorKind = 'orchestrator' | 'worker' | 'onboarded';
export type ManageMode = 'handoff' | 'standby';
export type Isolation = 'cloud' | 'worktree' | 'shared';

export interface MissionEnv {
  isolation: Isolation;
  host?: string;
  repo?: string;
  branch?: string;
  resources: string[];
  exclusive?: boolean;
  /**
   * Reasoning effort for THIS mission's executor (`--effort`: low|medium|high|xhigh|max).
   * Omitted ⇒ `missionEffort()` decides from priority. An invalid value is dropped at
   * launch rather than forwarded, so it can never silently read as "effort applied".
   */
  effort?: string;
}
export interface MissionBinding {
  sessionId: string | null;
  node: string | null;
  kind: ExecutorKind | null;
  boundAt?: number;
  /** `terminal` is the platform-neutral handle (tmux session name / WT tab RuntimeId);
   *  `tmuxSession` is the legacy POSIX-only alias, still written on tmux hosts. */
  ccr?: { cse: string; sid: string; webUrl?: string | null; terminal?: string; tmuxSession?: string };
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
  /** Step B: a relayed spawn is outstanding to this node. Present ⇒ do not relay again
   *  until it is older than the TTL — a second send is how one mission gets two executors. */
  spawnInFlight?: { node: string; requestId: string; at: number };
  /** Step B: the idempotency key of the spawn that produced the current binding. Written in
   *  the SAME persist as the binding, so a repeat resolves instead of launching again. */
  lastSpawnRequest?: string;
}
export interface MissionResult { at: number; ref: string; summary?: string; by?: MissionActor; }
export interface MissionAdjustment { at: number; trigger: string; change: string; by: 'controller' | 'user'; actor: MissionActor; }

export interface FieldDiff { from: unknown; to: unknown; }
export interface MissionChange {
  rev: number;
  at: number;
  actor: MissionActor;
  changes: Record<string, FieldDiff>;
}

export type ActorKind = 'local-session' | 'ccr' | 'claudeai-conversation' | 'controller' | 'user';
export type ActorChannel = 'mcp' | 'controller' | 'user' | 'api';
export interface MissionActor {
  kind: ActorKind;
  id?: string | null;
  node?: string | null;
  channel: ActorChannel;
  label?: string;
  toolUseId?: string | null;
  at: number;
}
/** Fallback actor when the caller can't be resolved to a session/conversation. */
export function coarseActor(channel: ActorChannel, node: string, now: number): MissionActor {
  return { kind: channel === 'controller' ? 'controller' : 'user', channel, node, at: now };
}

/** Read-path back-compat: fill any missing provenance on a (possibly legacy) mission record. */
export function withActorBackfill(m: Mission): Mission {
  const node = m.ownerNode ?? 'unknown';
  if (!m.createdBy) m.createdBy = { kind: 'user', channel: 'api', node, at: m.createdAt ?? 0 };
  if (!m.lastUpdatedBy) m.lastUpdatedBy = m.createdBy;
  if (!m.tags || typeof m.tags !== 'object') m.tags = {};
  if (m.parentId === undefined) m.parentId = null;
  if (typeof m.rev !== 'number') m.rev = 1;
  if (!Array.isArray(m.history)) m.history = [];
  if (!Array.isArray(m.results)) m.results = [];
  if (Array.isArray(m.adjustments)) {
    for (const a of m.adjustments) {
      if (!a.actor) {
        const k = a.by === 'controller' ? 'controller' : 'user';
        a.actor = { kind: k, channel: k === 'controller' ? 'controller' : 'user', node, at: a.at };
      }
    }
  }
  return m;
}

export const RESULT_REF_MAX = 500;
export const RESULT_SUMMARY_MAX = 2000;
export const RESULTS_MAX_PER_CALL = 20;
export const RESULTS_MAX_TOTAL = 100;

export type ResultsValidation =
  | { ok: true; entries: MissionResult[] }
  | { ok: false; message: string };

/**
 * Validate + normalize a patch-supplied results write.
 * Append (`resultsAppend`, entry or array): entries are {ref, summary} — summary required
 * (a completion record must say what was delivered); `at`/`by` are stamped server-side.
 * Replace (`results` + resultsReplace:true, array only): entries round-trip {at, by} and
 * summary is optional so telemetry-era records survive read-modify-write curation.
 * Unknown entry keys are rejected — the same no-silent-drop contract as the patch body.
 */
export function validateResultsPatch(
  raw: unknown,
  mode: 'append' | 'replace',
  actor: MissionActor,
  existingCount: number,
  now: number,
): ResultsValidation {
  const field = mode === 'append' ? 'resultsAppend' : 'results';
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return { ok: false, message: `${field} is a string that is not valid JSON` }; }
  }
  const list = Array.isArray(v) ? v : mode === 'append' ? [v] : null;
  if (list === null) return { ok: false, message: 'results must be the full replacement array of entries' };
  if (mode === 'append' && list.length === 0) return { ok: false, message: 'resultsAppend is empty — nothing to append' };
  if (mode === 'append' && list.length > RESULTS_MAX_PER_CALL) {
    return { ok: false, message: `resultsAppend accepts at most ${RESULTS_MAX_PER_CALL} entries per call (got ${list.length})` };
  }
  const total = mode === 'append' ? existingCount + list.length : list.length;
  if (total > RESULTS_MAX_TOTAL) return { ok: false, message: `results would hold ${total} entries — the cap is ${RESULTS_MAX_TOTAL}` };
  const allowed = mode === 'append' ? ['ref', 'summary'] : ['ref', 'summary', 'at', 'by'];
  const out: MissionResult[] = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i] as unknown;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      return { ok: false, message: `${field} entry ${i} is not an object — each entry is {${allowed.join(', ')}}` };
    }
    const rec = e as Record<string, unknown>;
    const unknown = Object.keys(rec).filter((k) => !allowed.includes(k));
    if (unknown.length) {
      return { ok: false, message: `${field} entry ${i} has unsupported key(s): ${unknown.map((k) => `"${k}"`).join(', ')} — allowed: ${allowed.join(', ')}` };
    }
    const ref = rec.ref;
    if (typeof ref !== 'string' || !ref.trim()) return { ok: false, message: `${field} entry ${i}: ref (non-empty string) is required` };
    if (ref.length > RESULT_REF_MAX) return { ok: false, message: `${field} entry ${i}: ref exceeds ${RESULT_REF_MAX} chars (${ref.length})` };
    const summary = rec.summary;
    if (mode === 'append' && (typeof summary !== 'string' || !summary.trim())) {
      return { ok: false, message: `${field} entry ${i}: summary (non-empty string) is required — say what was delivered` };
    }
    if (summary !== undefined && (typeof summary !== 'string' || !summary.trim())) {
      return { ok: false, message: `${field} entry ${i}: summary must be a non-empty string when present` };
    }
    if (typeof summary === 'string' && summary.length > RESULT_SUMMARY_MAX) {
      return { ok: false, message: `${field} entry ${i}: summary exceeds ${RESULT_SUMMARY_MAX} chars (${summary.length})` };
    }
    const entry: MissionResult = { at: now, ref };
    if (typeof summary === 'string') entry.summary = summary;
    if (mode === 'append') {
      entry.by = actor;
    } else {
      if (rec.at !== undefined) {
        const at = Number(rec.at);
        if (!Number.isFinite(at) || at <= 0) return { ok: false, message: `${field} entry ${i}: at must be a positive epoch-ms number` };
        entry.at = at;
      }
      if (rec.by !== undefined) {
        if (!rec.by || typeof rec.by !== 'object' || Array.isArray(rec.by)) {
          return { ok: false, message: `${field} entry ${i}: by must be an actor object` };
        }
        entry.by = rec.by as MissionActor;
      }
    }
    out.push(entry);
  }
  return { ok: true, entries: out };
}

export interface Mission {
  id: string;
  title: string;
  objective: string;
  plan?: string;
  nextSteps?: string[];
  projects: string[];
  dependsOn: string[];
  tags: Record<string, string[]>;
  parentId: string | null;
  env: MissionEnv;
  binding: MissionBinding | null;
  progress: MissionProgress | null;
  /** Token-free interim executor progress (Wave 4) — surfaced by the supervisor, not the controller. */
  interim?: { at: number; text: string };
  /** 'onboarded' = an EXISTING user session adopted into mission control (spec 2026-07-14). */
  origin?: 'onboarded';
  /** Onboarded-only: handoff = controller drives; standby = observe-only. Human-switched. */
  manageMode?: ManageMode;
  control: MissionControl;
  results: MissionResult[];
  adjustments: MissionAdjustment[];
  createdBy: MissionActor;
  lastUpdatedBy: MissionActor;
  rev: number;
  history: MissionChange[];
  status: MissionStatus;
  ownerNode: string;
  createdAt: number;
  updatedAt: number;
}

/** Display name for a controller-spawned executor session — identifiable + traceable to the mission. */
export function missionSessionTitle(m: Mission): string {
  return `Mission: ${m.title} · ${m.id.replace(/^mission_/, '')}`;
}

/** Concise, human-readable session name for `/rename` (the customTitle the sessions
 *  UI shows). Prefers the mission's feature branch slug (e.g. feat/mobile-mcp-plugin
 *  → "mobile-mcp-plugin"), else a slug of the title, else the short mission id. */
export function missionSessionName(m: Mission): string {
  const branch = m.env?.branch?.replace(/^(feat|fix|chore)\//, '').trim();
  if (branch) return branch.slice(0, 48);
  const titleSlug = (m.title || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return titleSlug || m.id.replace(/^mission_/, '');
}

export interface NewMissionInput {
  title: string;
  objective: string;
  ownerNode: string;
  createdBy: MissionActor;
  projects?: string[];
  dependsOn?: string[];
  tags?: Record<string, string[]>;
  parentId?: string | null;
  env?: Partial<MissionEnv>;
  plan?: string;
  nextSteps?: string[];
}

/**
 * The birth isolation of a mission nobody specified one for.
 *
 * 🔴 It is NATIVE, not `cloud`. A cloud mission cannot be placed by `mission_spawn`
 * or by the supervisor's starvation safety net — both refuse it with
 * `CLOUD_PLACEMENT`, because cloud needs `ccr_cloud_start`. While `cloud` was the
 * DEFAULT, the most common mission in the fleet was precisely the one no automated
 * placement path could rescue (bl_1c861246). Native placement is the one both the
 * controller and the backstop can actually perform.
 *
 * The flavour follows the work, not a preference:
 *   • a repo ⇒ `worktree` — branch isolation, so concurrent missions on one repo
 *     cannot tread on each other;
 *   • no repo ⇒ `shared` — research, fleet ops, investigations. Forcing a worktree
 *     on repo-less work would refuse legitimate missions (several in this store), and
 *     leaving them on `cloud` would preserve the exact hole this closes.
 *
 * `cloud` remains fully supported — it is now an explicit opt-in rather than what you
 * get by saying nothing.
 */
export function defaultIsolation(repo: string | undefined): Isolation {
  return repo && repo.trim() ? 'worktree' : 'shared';
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
    tags: input.tags ?? {},
    parentId: input.parentId ?? null,
    env: {
      isolation: input.env?.isolation ?? defaultIsolation(input.env?.repo),
      host: input.env?.host,
      repo: input.env?.repo,
      branch: input.env?.branch,
      resources: input.env?.resources ?? [],
      exclusive: input.env?.exclusive,
      // `env` is rebuilt field-by-field, so every field must be listed HERE or it is
      // silently discarded no matter how carefully the caller and the route validated
      // it. `effort` was missing: the MCP top-level alias (liftEffort) and the route's
      // own ccEffortOrUndefined check both worked, and the value died on this line.
      effort: input.env?.effort,
    },
    binding: null,
    progress: null,
    control: { nudgeCount: 0, backoffStep: 0 },
    results: [],
    adjustments: [],
    createdBy: input.createdBy,
    lastUpdatedBy: input.createdBy,
    rev: 1,
    history: [],
    // A newborn mission has NO executor (binding is null two fields up), so it must be
    // born in a state the scheduler will start: SCHEDULABLE is {draft,waiting,blocked}
    // (mission-scheduler.ts). `active` is a RUNTIME state the controller writes only
    // after startExecutor succeeds, and that isRunning()/epic rollups read as "an
    // executor IS on this". Born `active`, every API-created mission was invisible to
    // the scheduler forever and never received an executor (bl_28543c78).
    status: 'waiting',
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
  | { go: true; env: 'shared'; host: string; lease: string };

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
  // `host` travels with EVERY placement that can run on a specific machine. Without it
  // startNativeExecutor's `decision.host || 'local'` recorded a worker on another node as
  // `binding.node: 'local'` — the only durable record of WHICH MACHINE is running the
  // mission, and the field a relayed placement is verified from.
  return { go: true, env: 'shared', host: m.env.host ?? '', lease: m.env.resources.join(',') || m.id };
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

/**
 * Reasoning effort for a mission's executor (`--effort`).
 *
 * Precedence: an explicit `env.effort` always wins. Otherwise effort scales with the
 * mission's own priority — `critical`/`high` work gets `max`, everything else inherits the
 * CLI default (returned as undefined, so no flag is passed and nothing is claimed).
 *
 * Deliberately NOT max-for-everything: a lot of mission work is mechanical (deploy, sync,
 * rollout) where max effort buys nothing and costs latency and tokens on every executor in
 * the fleet. The hard root-cause missions are the ones that need it.
 */
export function missionEffort(m: { env?: Partial<MissionEnv> | null; tags?: Record<string, string[]> | null } | null | undefined): string | undefined {
  const explicit = m?.env?.effort;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const priority = (m?.tags?.priority ?? [])[0];
  return priority === 'critical' || priority === 'high' ? 'max' : undefined;
}
