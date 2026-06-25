/** The super Mission Controller tick: election → per-mission liveness/adjust/placement. */
import {
  Mission, MissionBinding, ExecutorState, ExecutorOutput, AdjustResult, PlacementDecision,
  decideMission, place, planMissionNudge, missionSessionTitle, MissionActor,
} from './mission-model';
import { pickNewSession, cseToSessionSid, isNativeBinding } from './mission-native';
import type { ExecNow } from './mission-engagement';
import { listMissions, putMission, thisNode, getControllerSession, putControllerSession, ControllerSession, EngagementState } from './mission-store';
import { classifyExecutorActivity, shouldEngage } from './mission-engagement';
import { runAdjust } from './mission-adjust';
import { getProjectSettings } from '../project-settings';
import { deriveHubMcpUrl, upsertHubMcpServer } from '../utils/claude-mcp-config';
import { getHubConfig } from '../hub-client/hub-config';
import { amIMonitor } from '../monitor/stall-election';
import { cloudStart, cloudDrive, cloudRead, cloudStatus, cloudListAccount } from '../terminal/ccr-cloud';
import { getCcController } from '../terminal/backend';
import { gitCommand } from '../checkpoint/git-utils';
import * as path from 'path';
import { sessionVerdict } from '../terminal/cc-sessions';
import { AgentSessionStore } from '../agent-session-store';

export interface MissionTickDeps {
  now: number;
  cfg: { intervalMin: number; maxNudges: number; model: string };
  amMonitor: () => Promise<{ isMonitor: boolean; monitorNodeId: string | null }>;
  listAll: () => Promise<Mission[]>;
  readExecutor: (m: Mission) => Promise<ExecutorState>;
  adjust: (m: Mission, out: ExecutorOutput) => Promise<AdjustResult>;
  startExecutor: (m: Mission, decision: PlacementDecision) => Promise<MissionBinding>;
  drive: (m: Mission, directive: string) => Promise<void>;
  save: (m: Mission) => Promise<void>;
}

function setWaiting(m: Mission, pd: Extract<PlacementDecision, { go: false }>): void {
  m.status = 'waiting';
  m.control.waitReason = pd.reason;
}

export function addAdjustment(m: Mission, now: number, trigger: string, change: string): void {
  const node = thisNode();
  const ccr = m.binding?.ccr;
  const actor: MissionActor = ccr
    ? { kind: 'ccr', id: ccr.sid, node, channel: 'controller', at: now }
    : { kind: 'controller', id: m.binding?.sessionId ?? null, node, channel: 'controller', at: now };
  m.adjustments.push({ at: now, trigger, change, by: 'controller', actor });
  m.lastUpdatedBy = actor;
}

async function processMission(m: Mission, all: Mission[], d: MissionTickDeps): Promise<void> {
  m.control.lastTickAt = d.now;
  const bound = !!m.binding?.sessionId;
  const st: ExecutorState = bound
    ? await d.readExecutor(m)
    : { alive: false, serverStalled: false, gate: null, newOutput: null, idle: true };
  const decision = decideMission(m, st);

  if (decision.kind === 'defer') { await d.save(m); return; }

  if (decision.kind === 'gate') {
    m.status = 'paused';
    addAdjustment(m, d.now, 'gate', `need_approval: ${decision.reason}`);
    await d.save(m);
    return;
  }

  if (decision.kind === 'rebind') {
    const pd = place(m, all);
    if (!pd.go) { setWaiting(m, pd); await d.save(m); return; }
    m.binding = await d.startExecutor(m, pd);
    m.status = 'active';
    await d.save(m);
    return;
  }

  if (decision.kind === 'adjust') {
    // Fresh progress — reset parked-nudge backoff.
    m.control.nudgeCount = 0;
    m.control.backoffStep = 0;
    m.control.gaveUp = false;
    m.control.lastOutputCursor = decision.output.cursor;
    const res = await d.adjust(m, decision.output);
    if (res.verdict === 'done') { m.status = 'done'; await d.save(m); return; }
    if (res.verdict === 'blocked') { m.status = 'blocked'; addAdjustment(m, d.now, 'blocked', res.reason); await d.save(m); return; }
    if (res.verdict === 'gate') { m.status = 'paused'; addAdjustment(m, d.now, 'gate', res.reason); await d.save(m); return; }
    if (res.verdict === 'revise' && res.isMaterialPivot) {
      // Gate the pivot — do NOT drive; human must approve the direction change.
      m.status = 'paused';
      addAdjustment(m, d.now, 'material-pivot', res.reason);
      await d.save(m);
      return;
    }
    if (res.verdict === 'revise') {
      if (res.revisedObjective) m.objective = res.revisedObjective;
      if (res.revisedNextSteps) m.nextSteps = res.revisedNextSteps;
      addAdjustment(m, d.now, 'revise', res.reason);
    }
    await d.drive(m, res.nextDirective);
    await d.save(m);
    return;
  }

  // decision.kind === 'place' — start (unbound) or nudge (parked/idle)
  const pd = place(m, all);
  if (!pd.go) { setWaiting(m, pd); await d.save(m); return; }
  if (m.status === 'waiting') m.status = 'active'; // dependency unblocked
  if (!bound) {
    m.binding = await d.startExecutor(m, pd);
    m.status = 'active';
    await d.save(m);
    return;
  }
  const np = planMissionNudge(m.control, { intervalMin: d.cfg.intervalMin, maxNudges: d.cfg.maxNudges }, d.now);
  m.control = np.control;
  if (np.action === 'giveup') { m.status = 'blocked'; await d.save(m); return; }
  if (np.action === 'nudge') { await d.drive(m, 'continue'); }
  await d.save(m);
}

export async function runMissionTick(
  d: MissionTickDeps,
): Promise<{ acted: string[]; skipped: boolean; isMonitor: boolean }> {
  const { isMonitor } = await d.amMonitor();
  if (!isMonitor) return { acted: [], skipped: true, isMonitor: false };
  const all = await d.listAll();
  const active = all.filter((m) => m.status === 'active' || m.status === 'waiting');
  const acted: string[] = [];
  for (const m of active) {
    try {
      await processMission(m, all, d);
      acted.push(m.id);
    } catch (e) {
      // Per-mission isolation: one mission's failure never aborts the tick.
      console.error(`[mission-controller] mission ${m.id} failed:`, (e as Error).message);
    }
  }
  return { acted, skipped: false, isMonitor: true };
}

// ---------------------------------------------------------------------------
// Real-deps wiring (cloud executors end-to-end; native start is phase-2 per spec §8)
// ---------------------------------------------------------------------------

const SERVER_STALL = /overloaded|rate.?limit|server error|529|503|502|500/i;

/**
 * Terminal cloud session statuses. Everything else (active/idle/pending/running/disconnected/
 * requires_action/unknown) is a LIVE state — the SESSION_STATUS_* enum's working values plus
 * connection_status:disconnected (the UI reconnects) and the unknown fallback (don't kill on a
 * transient read). `archived` is the confirmed terminal SESSION_STATUS_ value; the others cover
 * how a cloud session can end (a deleted session 404s → cloudStatus throws → null → grace).
 */
const TERMINAL_CLOUD_STATUSES = ['stopped', 'completed', 'failed', 'error', 'archived'];

/** Is a bound cloud executor still alive? Non-terminal status = alive; within the
 *  startup grace window after boundAt, treat as alive (pending/just-started/transient). */
export function executorLiveness(opts: { status: string | null; boundAt: number | undefined; now: number; graceMs: number }): boolean {
  if (opts.status && TERMINAL_CLOUD_STATUSES.includes(opts.status)) return false; // confirmed terminal: no grace
  if (opts.status && !TERMINAL_CLOUD_STATUSES.includes(opts.status)) return true; // confirmed alive
  if (opts.boundAt && (opts.now - opts.boundAt) < opts.graceMs) return true; // unknown/missing status: grace
  return false;
}

/**
 * Pure cursor math over the FULL transcript. `prevCursor` (= `m.control.lastOutputCursor`)
 * is an ABSOLUTE high-water mark; `messages` MUST be the full transcript (not a tail slice),
 * else the cursor caps at the slice length and adjust never re-fires past it.
 */
export function computeNewOutput(
  messages: { text: string }[],
  prevCursor: number,
): { cursor: number; newOutput: ExecutorOutput | null } {
  const cursor = messages.length; // absolute position in the FULL transcript
  if (cursor <= prevCursor) return { cursor, newOutput: null };
  return { cursor, newOutput: { cursor, messages: messages.slice(prevCursor).map((m) => m.text), results: [] } };
}

async function readCloudExecutor(m: Mission): Promise<ExecutorState> {
  const sid = m.binding?.sessionId;
  if (!sid) return { alive: false, serverStalled: false, gate: null, newOutput: null, idle: true };
  // Liveness via cloudStatus(sid) — it works with the `session_<id>` form cloudStart returns,
  // whereas cloudListAccount returns the SAME session as `cse_<id>` (different prefix) so a
  // membership test never matched → a pending executor looked dead → runaway re-start every tick.
  const st = await cloudStatus(sid).catch(() => null);
  const GRACE_MS = 120000;
  if (!executorLiveness({ status: st?.status ?? null, boundAt: m.binding?.boundAt, now: Date.now(), graceMs: GRACE_MS })) {
    return { alive: false, serverStalled: false, gate: null, newOutput: null, idle: true };
  }
  // Full transcript (no lastN) — the cursor is an ABSOLUTE high-water mark, so a tail
  // slice would cap it and stop adjust from re-firing once the session passes the cap.
  const read = await cloudRead({ sid }).catch(
    () => ({ messages: [] as Array<{ text: string }>, pendingQuestion: null as null }),
  );
  const { newOutput } = computeNewOutput(read.messages, m.control.lastOutputCursor ?? 0);
  const lastText = read.messages.length ? read.messages[read.messages.length - 1].text : '';
  return {
    alive: true,
    serverStalled: SERVER_STALL.test(lastText),
    gate: read.pendingQuestion ? { taskId: 'cloud', reason: 'pending question / approval' } : null,
    newOutput,
    idle: !newOutput,
  };
}

async function startCloudExecutor(m: Mission, decision: PlacementDecision): Promise<MissionBinding> {
  if (decision.go && decision.env === 'cloud') {
    const res = await cloudStart({
      prompt: `Mission: ${m.title}\n\nObjective:\n${m.objective}`,
      repo: m.env.repo,
      setup: true,
      role: m.binding?.kind === 'orchestrator' ? 'orchestrator' : 'worker',
      title: missionSessionTitle(m),
    });
    return {
      sessionId: res.sid,
      node: m.env.host ?? 'cloud',
      kind: m.binding?.kind ?? 'worker',
      boundAt: Date.now(),
    };
  }
  // Native (worktree / shared) executor — launch via tmux with --remote-control.
  const decisionAny = decision as any;
  const repoRaw: string = (decision.go ? decisionAny.repo : null) || process.cwd();
  const repoAbs = path.isAbsolute(repoRaw) ? repoRaw : path.resolve(process.cwd(), repoRaw);
  const baselineArr = await cloudListAccount().then((ss) => ss.map((s) => s.sid)).catch(() => [] as string[]);
  const { tmuxCcController } = require('../terminal/tmux-backend') as typeof import('../terminal/tmux-backend');
  const realNativeDeps: NativeStartDeps = {
    ensureWorktree: async (repo: string, dir: string, branch: string): Promise<string> => {
      const absRepo = path.isAbsolute(repo) ? repo : path.resolve(process.cwd(), repo);
      const absDir = path.isAbsolute(dir) ? dir : path.resolve(absRepo, dir);
      try {
        gitCommand(['worktree', 'add', absDir, '-b', branch], absRepo);
      } catch (err) {
        const msg = (err as Error).message || '';
        // If the worktree/branch already exists, that's fine — just reuse it.
        if (!/already exists|already checked out|is already/i.test(msg)) throw err;
        console.debug(`[mission-controller] ensureWorktree: reusing existing worktree/branch (${msg.slice(0, 80)})`);
      }
      return absDir;
    },
    launch: async (cwd: string): Promise<{ sessionId: string | null; tmuxSession: string }> => {
      const res = await tmuxCcController.launch({ cwd, remoteControl: true, skipPermissions: true, autoTrust: true, name: missionSessionTitle(m) });
      return {
        sessionId: (res.sessionId as string | null) ?? null,
        tmuxSession: res.tmuxSession as string,
      };
    },
    listAccount: cloudListAccount,
    baseline: baselineArr,
    drive: async (sid: string, text: string): Promise<void> => {
      await cloudDrive({ sid, text }).catch((e: Error) => {
        console.debug(`[mission-controller] drive to ${sid} failed: ${e.message}`);
      });
    },
  };
  return startNativeExecutor(m, { ...(decision.go ? decision : {}), repo: repoAbs }, realNativeDeps);
}

async function driveExecutor(m: Mission, directive: string): Promise<void> {
  const sid = m.binding?.sessionId;
  if (!sid) return;
  await cloudDrive({ sid, text: directive });
}

// ---------------------------------------------------------------------------
// Native read executor — deps-injected for testability
// ---------------------------------------------------------------------------

export interface NativeReadDeps {
  /** Return an object with `driveable` boolean for a given sessionId. */
  verdict: (sessionId: string) => { driveable: boolean };
  /** Return the full local conversation as `{ messages: Array<{ text: string }> }`. */
  readConversation: (sessionId: string) => Promise<{ messages: Array<{ text: string }> }>;
}

/**
 * Read the state of a locally-running (native) executor.
 * Uses `computeNewOutput` in the same way as `readCloudExecutor`.
 */
export async function readNativeExecutor(m: Mission, deps: NativeReadDeps): Promise<ExecutorState> {
  const uuid = m.binding?.sessionId;
  if (!uuid) return { alive: false, serverStalled: false, gate: null, newOutput: null, idle: true };
  const v = deps.verdict(uuid);
  const alive = !!v.driveable;
  const read = await deps.readConversation(uuid).catch(() => ({ messages: [] as Array<{ text: string }> }));
  const { newOutput } = computeNewOutput(read.messages, m.control.lastOutputCursor ?? 0);
  return { alive, serverStalled: false, gate: null, newOutput, idle: !newOutput };
}

// ---------------------------------------------------------------------------
// Native executor (worktree / shared) — deps-injected for testability
// ---------------------------------------------------------------------------

export interface NativeStartDeps {
  ensureWorktree: (repo: string, dir: string, branch: string) => Promise<string>;
  launch: (cwd: string) => Promise<{ sessionId: string | null; tmuxSession: string }>;
  listAccount: () => Promise<Array<{ sid: string; status?: string }>>;
  baseline: string[];
  drive: (sid: string, text: string) => Promise<void>;
}

export async function startNativeExecutor(m: Mission, decision: any, deps: NativeStartDeps): Promise<MissionBinding> {
  const branch = decision.branch || `mission/${m.id}`;
  const dir = decision.env === 'shared' ? (decision.repo || '.') : `.claude/worktrees/mission-${m.id}`;
  const cwd = decision.env === 'shared' ? (decision.repo || '.') : await deps.ensureWorktree(decision.repo, dir, branch);
  const launched = await deps.launch(cwd);
  const uuid = launched.sessionId;
  if (!uuid) throw new Error('native launch did not resolve a session id');
  const cur = await deps.listAccount().catch(() => []);
  const hit = pickNewSession(deps.baseline, cur);
  const kind = m.binding?.kind === 'orchestrator' ? 'orchestrator' : 'worker';
  const binding: MissionBinding = { sessionId: uuid, node: decision.host || 'local', kind, boundAt: Date.now() };
  if (hit) {
    const sid = cseToSessionSid(hit.sid);
    binding.ccr = { cse: hit.sid, sid, webUrl: `https://claude.ai/code/${sid}`, tmuxSession: launched.tmuxSession };
    await deps.drive(sid, `Mission: ${m.title}\n\nObjective:\n${m.objective}`).catch(() => {});
  }
  return binding;
}

// ---------------------------------------------------------------------------
// Supervisor (Wave 2): election + controller-session lifecycle + cadence
// ---------------------------------------------------------------------------

/** The standing directive sent to the controller agent each pass. */
export const CONTROLLER_PASS_DIRECTIVE =
  'Run a controller pass now: review every active mission via mission_list; ' +
  'for each, call mission_place, spawn/drive/adapt/decide as needed; ' +
  'then await the next pass.';

/**
 * Guarded system prompt for the Mission Controller agent. Passed at launch via
 * --append-system-prompt-file so the controller's role, scope, and heartbeat
 * convention are reliable on any node (not dependent on connector inheritance).
 *
 * The `⟦HEARTBEAT⟧` convention keeps the chat clean: idle passes collapse to a
 * single marker line the web filters out, while real actions/answers narrate
 * normally and stay visible.
 */
export const CONTROLLER_SYSTEM_PROMPT = [
  'You are the **Mission Controller** — a fleet-elected agent. Your SOLE job is to drive',
  '*missions* to completion through the `mission_*` tools (mission_list, mission_place,',
  'mission_executor_status, …) and the executor sessions you spawn. You NEVER edit code,',
  'run builds, or touch unrelated systems yourself — you only orchestrate missions and',
  'their executors through tools.',
  '',
  'You are **event-driven, not polling**: a non-LLM supervisor watches the executors for you',
  'and drives you ONLY when something material happens — an executor finished, blocked, or',
  'needs approval; a new mission was created; or a periodic safety check. Ongoing executor',
  'progress is tracked for you and shown on each mission (`interim`) — you do NOT need to poll',
  'it; look only if relevant to acting now.',
  '',
  'When driven, act on the CURRENT state: call `mission_list`; for every active mission assess',
  'its executor (`mission_executor_status`), place/spawn/drive/adapt as needed (`mission_place`',
  'and session drive), and mark it done when complete.',
  '',
  'HEARTBEAT: only on a safety-check drive where there is genuinely nothing to do (no active',
  'missions, or nothing actionable), reply with EXACTLY one line beginning `⟦HEARTBEAT⟧` and',
  'nothing else (e.g. `⟦HEARTBEAT⟧ idle — 0 active missions`). When you take a real action or',
  'answer the user, narrate normally and DO NOT use that marker.',
  '',
  'The user may message you directly in this session — treat their messages as authoritative',
  'instructions (create/pause/adjust missions, answer questions) and reply substantively.',
  'The mission store is cross-node shared; you run on the elected leader node.',
].join('\n');

/**
 * Pure builder for the controller launch extras (system-prompt file + optional
 * hub-MCP keystone config file). `writeFile(name, body)` persists a file and
 * returns its path — injected so this stays unit-testable (no fs).
 *
 * Always writes the system-prompt file. Writes the MCP config file only when an
 * apiKey is present AND a hub MCP URL can be derived from hubUrl; otherwise the
 * controller still gets its tools via connector inheritance (non-fatal).
 */
export function buildControllerLaunchExtras(args: {
  hubUrl: string | null;
  apiKey: string | null;
  writeFile: (name: string, body: string) => string;
}): { appendSystemPromptFile: string; mcpConfigPath?: string } {
  const appendSystemPromptFile = args.writeFile('mission-controller-sp.txt', CONTROLLER_SYSTEM_PROMPT);
  const out: { appendSystemPromptFile: string; mcpConfigPath?: string } = { appendSystemPromptFile };
  const mcpUrl = deriveHubMcpUrl(args.hubUrl);
  if (args.apiKey && mcpUrl) {
    const cfg = upsertHubMcpServer({}, { url: mcpUrl, key: args.apiKey });
    out.mcpConfigPath = args.writeFile('mission-controller-mcp.json', JSON.stringify(cfg, null, 2));
  }
  return out;
}

/**
 * Pure decision table — what should the supervisor do on this tick?
 *
 * `driveDue` separates the cheap lifecycle check (run every ~1 min for prompt
 * failover) from the costly adapt-DRIVE pass (run every ~5 min).
 *
 * Decision table:
 *   !isMonitor                      → teardown  (not the leader)
 *   isMonitor && !live              → launch     (no live session; always launch regardless of driveDue)
 *   isMonitor && live && driveDue   → drive      (time for another adapt pass)
 *   isMonitor && live && !driveDue  → idle       (lifecycle OK, drive cadence not yet elapsed)
 */
export function decideSupervisor(input: { isMonitor: boolean; live: boolean; driveDue: boolean }): { action: 'teardown' | 'launch' | 'drive' | 'idle' } {
  if (!input.isMonitor) return { action: 'teardown' };
  if (!input.live) return { action: 'launch' };
  if (input.driveDue) return { action: 'drive' };
  return { action: 'idle' };
}

/**
 * Pure drive-cadence gate. When there are active missions the controller drives
 * at the (fast) active cadence; when idle (0 active missions) it drives at the
 * slower idle cadence so the heartbeat is infrequent. Never-driven → always due.
 */
export function isDriveDue(input: {
  lastDriveAt: number | null;
  now: number;
  activeCount: number;
  activeMin: number;
  idleMin: number;
}): boolean {
  if (!input.lastDriveAt) return true;
  const intervalMin = input.activeCount > 0 ? input.activeMin : input.idleMin;
  return input.now - input.lastDriveAt >= intervalMin * 60_000;
}

/** Deps interface for runSupervisorTick — all IO points are injectable for tests. */
export interface SupervisorDeps {
  amMonitor: () => Promise<{ isMonitor: boolean; monitorNodeId: string | null }>;
  getControllerSession: () => Promise<ControllerSession | null>;
  putControllerSession: (cs: ControllerSession | null) => Promise<void>;
  isLive: (cs: ControllerSession) => boolean;
  launch: () => Promise<ControllerSession>;
  drive: (cs: ControllerSession) => Promise<void>;
  teardown: (cs: ControllerSession) => Promise<void>;
  /** The adapt cadence in minutes (from project settings). Used to compute driveDue. */
  driveIntervalMin: number;
  /** Idle drive cadence (min) when there are no active missions. Default = driveIntervalMin (no change). */
  idleDriveIntervalMin?: number;
  /** Count of active missions — picks active vs idle cadence. Default = () => 1 (always active). */
  activeMissionCount?: () => Promise<number>;
  /** Current time in ms. Injected for deterministic tests. */
  now: number;
  // ── Wave 4 — change-detection engagement (all optional; when present, the drive
  //    gate becomes change-based instead of time-based). Absent → Wave-3 isDriveDue. ──
  /** List active missions to watch for change. */
  listActiveForEngage?: () => Promise<Mission[]>;
  /** Token-free executor signal for one mission. */
  readSignal?: (m: Mission) => Promise<ExecNow>;
  /** Read the engagement bookkeeping. */
  getEngagement?: () => Promise<EngagementState>;
  /** Persist the engagement bookkeeping. */
  putEngagement?: (s: EngagementState) => Promise<void>;
  /** Write a mission's token-free interim progress line (no engage). */
  setInterim?: (id: string, x: { at: number; text: string }) => Promise<void>;
  /** Long safety interval (min) — engage at least this often even with no change. Default 45. */
  safetyIntervalMin?: number;
}

/**
 * The supervisor tick: elect → reconcile the controller session → drive or launch or teardown.
 *
 * Lifecycle (launch/teardown) runs on every tick (~1 min) for prompt failover.
 * The costly adapt-DRIVE pass only fires when `driveDue` — i.e. driveIntervalMin has elapsed
 * since the last drive (stored as `cs.lastDriveAt`). This decouples failover speed from
 * drive cadence: a new leader can launch its controller within ~1 min while drives still
 * run every ~5 min.
 *
 * Called by `registerMissionController`'s scheduled handler (replaces `runMissionTick`).
 */
/**
 * Wave 4 — the change-detection engagement evaluation (side-effecting). Reads each
 * active executor cheaply (no LLM), classifies vs the last-seen record, surfaces
 * interim progress WITHOUT engaging, persists the updated `seen` every tick, and
 * returns whether a material change / new mission / safety interval means the
 * controller should be driven. Caller guarantees the engagement deps are present.
 */
async function evaluateEngagement(deps: SupervisorDeps): Promise<boolean> {
  const eng = await deps.getEngagement!();
  const active = await deps.listActiveForEngage!();
  const now = deps.now;
  const curSeen: EngagementState['seen'] = {};
  let materialCount = 0;
  for (const m of active) {
    let sig: ExecNow;
    try {
      sig = await deps.readSignal!(m);
    } catch {
      // A read failure for one mission must not sink the tick — carry forward prior state.
      curSeen[m.id] = eng.seen[m.id] ?? { alive: true, gated: false, cursor: 0 };
      continue;
    }
    const act = classifyExecutorActivity(eng.seen[m.id], sig);
    curSeen[m.id] = { alive: sig.alive, gated: sig.gated, cursor: sig.cursor };
    if (act.material) {
      materialCount++;
    } else if (act.interim && deps.setInterim) {
      try { await deps.setInterim(m.id, { at: now, text: act.interim.summary }); } catch { /* best-effort */ }
    }
  }
  const activeIds = active.map((m) => m.id);
  const engage = shouldEngage({
    now,
    lastEngagedAt: eng.lastEngagedAt,
    safetyIntervalMin: deps.safetyIntervalMin ?? 45,
    materialCount,
    activeIds,
    lastActiveIds: eng.lastActiveIds,
  });
  // Persist `seen` every tick (cursor/liveness/gate tracking advances regardless);
  // stamp lastEngagedAt + lastActiveIds only when we actually engage.
  await deps.putEngagement!({
    lastEngagedAt: engage ? now : eng.lastEngagedAt,
    lastActiveIds: engage ? activeIds : eng.lastActiveIds,
    seen: curSeen,
  });
  return engage;
}

export async function runSupervisorTick(deps: SupervisorDeps): Promise<{ action: string; controllerSession: ControllerSession | null }> {
  const { isMonitor } = await deps.amMonitor();
  const cs = await deps.getControllerSession();
  const live = cs ? deps.isLive(cs) : false;

  // Drive gate. Wave 4 (when the engagement deps are present): change-based — the
  // non-LLM detector reads each active executor cheaply, surfaces interim progress
  // WITHOUT engaging, and drives only on a material change / new mission / safety
  // interval. Otherwise (Wave-3 fallback): time-based isDriveDue. Only evaluated
  // when monitor+live (the only case decideSupervisor uses driveDue).
  let driveDue = false;
  if (isMonitor && live && cs) {
    if (deps.listActiveForEngage && deps.readSignal && deps.getEngagement && deps.putEngagement) {
      driveDue = await evaluateEngagement(deps);
    } else {
      const activeCount = deps.activeMissionCount ? await deps.activeMissionCount() : 1;
      driveDue = isDriveDue({
        lastDriveAt: cs.lastDriveAt ?? null,
        now: deps.now,
        activeCount,
        activeMin: deps.driveIntervalMin,
        idleMin: deps.idleDriveIntervalMin ?? deps.driveIntervalMin,
      });
    }
  }

  const { action } = decideSupervisor({ isMonitor, live, driveDue });

  if (action === 'teardown') {
    if (cs) {
      await deps.teardown(cs);
      await deps.putControllerSession(null);
    }
    return { action: 'teardown', controllerSession: null };
  }

  if (action === 'launch') {
    // Defensive dedupe: if a prior controller record exists but we're (re)launching (it was deemed
    // !live, or its bridge failed), tear down its tmux FIRST so a relaunch never stacks a second
    // controller on top of a still-running one (belt-and-suspenders with the isLive fix).
    if (cs) { try { await deps.teardown(cs); } catch { /* best-effort */ } }
    // Launch with lastDriveAt unset so the next tick triggers a drive immediately.
    const newCs = await deps.launch();
    await deps.putControllerSession(newCs);
    return { action: 'launch', controllerSession: newCs };
  }

  if (action === 'idle') {
    // Lifecycle is fine, drive cadence not yet elapsed — nothing to do.
    return { action: 'idle', controllerSession: cs };
  }

  // action === 'drive'
  await deps.drive(cs!);
  // Stamp lastDriveAt and persist so the next tick knows when we last drove.
  const updatedCs: ControllerSession = { ...cs!, lastDriveAt: deps.now };
  await deps.putControllerSession(updatedCs);
  return { action: 'drive', controllerSession: updatedCs };
}

/**
 * Read the executor state for a mission using the real cloud/native deps.
 * Exported so the rail route `handleExecutorStatus` can call it without duplicating logic.
 */
export async function readExecutorState(m: Mission): Promise<ExecutorState> {
  if (isNativeBinding(m.binding)) {
    const store = new AgentSessionStore({ projectPath: process.cwd(), persist: false });
    const realReadDeps: NativeReadDeps = {
      verdict: (sid) => {
        const v = sessionVerdict(sid);
        return { driveable: v.inTmux };
      },
      readConversation: async (sid) => {
        const res = await store.getConversation({ sessionId: sid });
        const msgs = res?.messages ?? [];
        return { messages: msgs.map((msg) => ({ text: msg.content })) };
      },
    };
    return readNativeExecutor(m, realReadDeps);
  }
  return readCloudExecutor(m);
}

/**
 * Wave 4 — token-free executor signal for change detection. Reuses readExecutorState's
 * cheap read (liveness + gate + new output; NO LLM) and maps it to the engagement
 * classifier's input (absolute cursor + the new output lines).
 */
export async function readExecutorSignal(m: Mission): Promise<ExecNow> {
  const st = await readExecutorState(m);
  return {
    alive: st.alive,
    gated: !!st.gate,
    cursor: st.newOutput?.cursor ?? (m.control.lastOutputCursor ?? 0),
    newLines: st.newOutput?.messages ?? [],
  };
}

function controllerCwd(): string {
  const s = getProjectSettings();
  return (s as any).missionControllerRepo || process.cwd();
}

/**
 * Pure helper: discover a new CSE that appeared after a launch by comparing a baseline
 * against a sequence of snapshots. Returns the new sid as soon as it appears in any snapshot,
 * or null if it never appears.
 *
 * @param baseline  - sids that existed BEFORE the launch
 * @param snapshots - successive polls of cloudListAccount (each is an array of {sid,...})
 * @param pickFn    - selection function (default: pickNewSession)
 */
export function discoverNewCse(
  baseline: string[],
  snapshots: Array<Array<{ sid: string; status?: string }>>,
  pickFn: (base: string[], cur: Array<{ sid: string; status?: string }>) => { sid: string } | null = pickNewSession,
): { sid: string } | null {
  for (const snap of snapshots) {
    const hit = pickFn(baseline, snap);
    if (hit) return hit;
  }
  return null;
}

/**
 * Register the scheduled-job handler AND force the job's tick interval to
 * `missionControllerLifecycleMin` (default 1 min) so that lifecycle reconciliation
 * (launch/teardown on leader election) is prompt regardless of what the persisted
 * interval was. The costly adapt-DRIVE pass is still gated by `missionControllerIntervalMin`
 * (default 5 min) via `driveDue` inside `runSupervisorTick`.
 */
export function registerMissionController(
  jobs: { registerHandler: (t: string, fn: any) => void; upsertJob?: (patch: any) => any },
): void {
  // Force the lifecycle-tick interval to 1 min so a new leader relaunches its controller
  // promptly after election. This overrides any stale 5-min value that may be persisted
  // from an older deployment. We upsert only intervalMinutes — other fields are preserved.
  if (jobs.upsertJob) {
    try {
      jobs.upsertJob({ id: 'mission-controller', intervalMinutes: 1 });
    } catch {
      // Best-effort — if upsert fails (e.g. job not yet seeded), the seed will set it to 1 via makeBuiltinJobs
    }
  }

  jobs.registerHandler('mission-controller', async (_config: any, _ctx: any) => {
    const s = getProjectSettings();
    if (!s.missionControllerEnabled || !s.dataServiceEnabled) {
      return { result: 'mission controller disabled (or data service off)', status: 'skipped' };
    }

    const realDeps: SupervisorDeps = {
      amMonitor: () =>
        amIMonitor().then((mon) => ({
          isMonitor: mon.isMonitor,
          monitorNodeId: mon.monitorNodeId,
        })),
      getControllerSession: () => getControllerSession(),
      putControllerSession: (cs) => putControllerSession(cs),
      isLive: (cs) => {
        // cs.sessionId may be a cse_ (cloud handle) once the bridge registers — sessionVerdict
        // CANNOT resolve a cse_ to a tmux, so it would report !inTmux and the supervisor would
        // relaunch a NEW controller EVERY tick (runaway duplicate proliferation — observed: 9
        // controllers in 18 min). The record carries the tmux name; check that session directly.
        if (cs.tmux) {
          try {
            const tmuxMod = require('../terminal/tmux') as typeof import('../terminal/tmux');
            return tmuxMod.exists(cs.tmux);
          } catch { /* fall through to the verdict path */ }
        }
        const v = sessionVerdict(cs.sessionId);
        return !!v.inTmux;
      },
      driveIntervalMin: getProjectSettings().missionControllerIntervalMin,
      idleDriveIntervalMin: getProjectSettings().missionControllerIdleIntervalMin,
      activeMissionCount: async () => {
        const { listActiveMissions } = require('./mission-store') as typeof import('./mission-store');
        return (await listActiveMissions()).length;
      },
      // Wave 4 — change-detection engagement deps (replaces the time-based gate above).
      safetyIntervalMin: getProjectSettings().missionControllerSafetyIntervalMin,
      listActiveForEngage: async () => {
        const { listActiveMissions } = require('./mission-store') as typeof import('./mission-store');
        return listActiveMissions();
      },
      readSignal: (m) => readExecutorSignal(m),
      getEngagement: async () => {
        const { getEngagementState } = require('./mission-store') as typeof import('./mission-store');
        return getEngagementState();
      },
      putEngagement: async (s) => {
        const { putEngagementState } = require('./mission-store') as typeof import('./mission-store');
        return putEngagementState(s);
      },
      setInterim: async (id, x) => {
        const { setMissionInterim } = require('./mission-store') as typeof import('./mission-store');
        await setMissionInterim(id, x);
      },
      now: Date.now(),
      launch: async () => {
        const { tmuxCcController } = require('../terminal/tmux-backend') as typeof import('../terminal/tmux-backend');
        const cwd = controllerCwd();
        // Build the controller bootstrap extras (guarded system prompt + hub-MCP
        // keystone). Non-fatal: on any failure, launch without extras (the
        // controller still works via connector inheritance).
        let extras: { appendSystemPromptFile?: string; mcpConfigPath?: string } = {};
        try {
          const hub = getHubConfig();
          const fsmod = require('fs') as typeof import('fs');
          const { getDataDir } = require('../utils/path-utils') as typeof import('../utils/path-utils');
          // The mcp file holds the hub bearer key — write it to the user-private
          // lm-assist data dir (where hub.json's key already lives), NOT a
          // world-writable /tmp. Fixed path (overwrite in place, no accumulation)
          // + unlink-then-O_EXCL create (refuses a planted symlink/file, so a
          // predictable path can't be exploited for a symlink-swap attack).
          const dir = path.join(getDataDir(), 'controller');
          fsmod.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const writeFile = (name: string, body: string): string => {
            const p = path.join(dir, name);
            try { fsmod.unlinkSync(p); } catch { /* not present — fine */ }
            const fd = fsmod.openSync(p, fsmod.constants.O_WRONLY | fsmod.constants.O_CREAT | fsmod.constants.O_EXCL, 0o600);
            try { fsmod.writeFileSync(fd, body); } finally { fsmod.closeSync(fd); }
            return p;
          };
          extras = buildControllerLaunchExtras({ hubUrl: hub.hubUrl || null, apiKey: hub.apiKey || null, writeFile });
        } catch (e) {
          console.debug(`[mission-supervisor] controller bootstrap extras failed: ${(e as Error).message}`);
        }
        // Capture cloud baseline BEFORE launching so we can detect the new cse afterward.
        const baselineArr = await cloudListAccount().then((ss) => ss.map((s2) => s2.sid)).catch(() => [] as string[]);
        const controllerName = `Mission Controller · ${getHubConfig().hostname}`;
        const launched = await tmuxCcController.launch({
          cwd, remoteControl: true, skipPermissions: true, autoTrust: true,
          appendSystemPromptFile: extras.appendSystemPromptFile,
          mcpConfigPath: extras.mcpConfigPath,
          name: controllerName,
        });
        const sessionId = (launched.sessionId as string | null) ?? '';
        const tmux = (launched.tmuxSession as string) ?? '';
        // Poll cloudListAccount up to 20 times (~40s) for the new --remote-control cse to register.
        const POLL_ATTEMPTS = 20;
        const POLL_INTERVAL_MS = 2000;
        let hit: { sid: string } | null = null;
        for (let i = 0; i < POLL_ATTEMPTS && !hit; i++) {
          if (i > 0) await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
          const cur = await cloudListAccount().catch(() => [] as Array<{ sid: string; status?: string }>);
          hit = pickNewSession(baselineArr, cur);
        }
        const cs: ControllerSession = {
          node: thisNode(),
          // Keep the NATIVE session uuid as sessionId (the .jsonl that holds the full transcript) and
          // the cloud handle separately as cse. Previously sessionId was overwritten with the cse once
          // the bridge registered → the mission web chat read the controller via the cse (cloud path,
          // sparse client-events) and showed "No turns yet" while the 200-line native transcript was
          // unreachable. Fall back to the cse only when no native uuid resolved.
          sessionId: sessionId || (hit ? hit.sid : ''),
          cse: hit ? hit.sid : null,
          tmux,
          startedAt: Date.now(),
        };
        return cs;
      },
      drive: async (cs) => {
        const sid = cs.cse || cs.sessionId;
        if (cs.cse) {
          await cloudDrive({ sid, text: CONTROLLER_PASS_DIRECTIVE }).catch((e: Error) => {
            console.debug(`[mission-supervisor] drive to ${sid} failed: ${e.message}`);
          });
        } else {
          await getCcController().prompt(cs.sessionId, CONTROLLER_PASS_DIRECTIVE).catch((e: Error) => {
            console.debug(`[mission-supervisor] native drive to ${cs.sessionId} failed: ${e.message}`);
          });
        }
      },
      teardown: async (cs) => {
        try {
          if (cs.tmux) {
            const backend = require('../terminal/tmux-backend') as typeof import('../terminal/tmux-backend');
            // tmuxTerminalBackend.close(id) kills a tmux session by its session name.
            await backend.tmuxTerminalBackend.close(cs.tmux);
          }
        } catch {
          // Best-effort teardown — don't crash the tick
        }
      },
    };

    const r = await runSupervisorTick(realDeps);

    // Reaper sweep: auto-close resumed native sessions that have been idle past the threshold.
    // Only the leader runs the sweep (non-leaders return skipped=true above, but we also
    // gate here to be explicit about the leader-only contract).
    const { isMonitor: amMonitorNow } = await amIMonitor().catch(() => ({ isMonitor: false }));
    if (amMonitorNow) {
      try {
        const { sweepIdle } = require('./mission-session-reaper') as typeof import('./mission-session-reaper');
        const idleMin = getProjectSettings().missionSessionIdleCloseMin ?? 30;
        await sweepIdle({
          now: Date.now(),
          idleMin,
          close: async (sid: string) => {
            // Resolve sid → tmuxSession via sessionVerdict, then kill via tmuxTerminalBackend.
            const verdict = sessionVerdict(sid);
            const tmuxSid = verdict.tmuxSession;
            if (tmuxSid) {
              const backend = require('../terminal/tmux-backend') as typeof import('../terminal/tmux-backend');
              await backend.tmuxTerminalBackend.close(tmuxSid);
            } else {
              // Fallback: try getCcController().close() which uses the sid directly.
              await getCcController().close(sid).catch(() => {});
            }
          },
        });
      } catch (e) {
        // Best-effort: never crash the tick because of the reaper.
        console.debug(`[mission-controller] reaper sweep failed: ${(e as Error).message}`);
      }
    }

    return { result: `supervisor action=${r.action}`, controllerSession: r.controllerSession, status: 'ok' };
  });
}
