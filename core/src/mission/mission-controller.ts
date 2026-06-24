/** The super Mission Controller tick: election → per-mission liveness/adjust/placement. */
import {
  Mission, MissionBinding, ExecutorState, ExecutorOutput, AdjustResult, PlacementDecision,
  decideMission, place, planMissionNudge, missionSessionTitle, MissionActor,
} from './mission-model';
import { pickNewSession, cseToSessionSid, isNativeBinding } from './mission-native';
import { listMissions, putMission, thisNode, getControllerSession, putControllerSession, ControllerSession } from './mission-store';
import { runAdjust } from './mission-adjust';
import { getProjectSettings } from '../project-settings';
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
      const res = await tmuxCcController.launch({ cwd, remoteControl: true, skipPermissions: true, autoTrust: true });
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

/** Pure decision table — what should the supervisor do on this tick? */
export function decideSupervisor(input: { isMonitor: boolean; live: boolean }): { action: 'teardown' | 'launch' | 'drive' | 'idle' } {
  if (!input.isMonitor) return { action: 'teardown' };
  if (!input.live) return { action: 'launch' };
  return { action: 'drive' };
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
}

/**
 * The supervisor tick: elect → reconcile the controller session → drive or launch or teardown.
 * Called by `registerMissionController`'s scheduled handler (replaces `runMissionTick`).
 */
export async function runSupervisorTick(deps: SupervisorDeps): Promise<{ action: string; controllerSession: ControllerSession | null }> {
  const { isMonitor } = await deps.amMonitor();
  const cs = await deps.getControllerSession();
  const live = cs ? deps.isLive(cs) : false;
  const { action } = decideSupervisor({ isMonitor, live });

  if (action === 'teardown') {
    if (cs) {
      await deps.teardown(cs);
      await deps.putControllerSession(null);
    }
    return { action: 'teardown', controllerSession: null };
  }

  if (action === 'launch') {
    const newCs = await deps.launch();
    await deps.putControllerSession(newCs);
    return { action: 'launch', controllerSession: newCs };
  }

  // action === 'drive'
  await deps.drive(cs!);
  return { action: 'drive', controllerSession: cs };
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

function controllerCwd(): string {
  const s = getProjectSettings();
  return (s as any).missionControllerRepo || process.cwd();
}

/** Register the scheduled-job handler. Uses the supervisor (Wave 2). */
export function registerMissionController(
  jobs: { registerHandler: (t: string, fn: any) => void },
): void {
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
        const v = sessionVerdict(cs.sessionId);
        return !!v.inTmux;
      },
      launch: async () => {
        const { tmuxCcController } = require('../terminal/tmux-backend') as typeof import('../terminal/tmux-backend');
        const cwd = controllerCwd();
        const launched = await tmuxCcController.launch({ cwd, remoteControl: true, skipPermissions: true, autoTrust: true });
        const sessionId = (launched.sessionId as string | null) ?? '';
        const tmux = (launched.tmuxSession as string) ?? '';
        // Try to discover the cloud cse for this session (optional)
        const baselineArr = await cloudListAccount().then((ss) => ss.map((s2) => s2.sid)).catch(() => [] as string[]);
        const cur = await cloudListAccount().catch(() => [] as Array<{ sid: string; status?: string }>);
        const { pickNewSession: pns } = require('./mission-native') as typeof import('./mission-native');
        const hit = pns(baselineArr, cur);
        const cs: ControllerSession = {
          node: thisNode(),
          sessionId: hit ? hit.sid : sessionId,
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
          const backend = require('../terminal/tmux-backend') as typeof import('../terminal/tmux-backend');
          const ctrl = backend.tmuxCcController as any;
          if (cs.tmux && typeof ctrl.kill === 'function') {
            await ctrl.kill(cs.tmux);
          }
        } catch {
          // Best-effort teardown — don't crash the tick
        }
      },
    };

    const r = await runSupervisorTick(realDeps);
    return { result: `supervisor action=${r.action}`, controllerSession: r.controllerSession, status: 'ok' };
  });
}
