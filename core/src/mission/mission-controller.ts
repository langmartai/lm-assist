/** The super Mission Controller tick: election → per-mission liveness/adjust/placement. */
import {
  Mission, MissionBinding, ExecutorState, ExecutorOutput, AdjustResult, PlacementDecision,
  decideMission, place, planMissionNudge, missionSessionTitle, missionSessionName, MissionActor,
} from './mission-model';
import { randomBytes } from 'crypto';
import { pickNewSession, cseToSessionSid, isNativeBinding } from './mission-native';
import type { ExecNow } from './mission-engagement';
import { listMissions, putMission, thisNode, getControllerSession, putControllerSession, ControllerSession, EngagementState } from './mission-store';
import { DEFAULT_WORKFLOWS } from './workflow-defaults';
import { clusterOf, type ClusterRecord } from '../cluster/cluster-map';
import { getClusterRecords } from '../cluster/cluster-store';
import { getMyCluster } from '../cluster/cluster-config';
import { fleetIdentity } from '../mcp-server/fleet-identity';
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
import { detectHumanActivity } from './mission-onboard';

/**
 * Resolve a host string (which may be a hostname/label OR a gatewayId) to the
 * canonical gatewayId used by clusterOf. Pure — no I/O.
 * Unknown hosts fall through unchanged so clusterOf resolves them to 'default'.
 */
export function resolveHostToId(host: string, records: ClusterRecord[]): string {
  // host may already be a gatewayId
  if (records.some((r) => r.gatewayId === host)) return host;
  // or it may be a hostname/label that maps to one
  const byHost = records.find((r) => r.hostname === host);
  return byHost ? byHost.gatewayId : host; // unknown falls through (clusterOf → 'default' → rejected, as intended)
}

/**
 * Pure placement guard: returns true if a host is allowed for this cluster.
 * Passes through undefined / 'local' / 'cloud' (no specific node required).
 * host may be a gatewayId OR a hostname/label — resolveHostToId normalises it
 * before the cluster lookup so hostname-pinned missions resolve correctly.
 * An unknown host (not in records and not self) resolves to 'default' — allowed
 * only when selfCluster is also 'default'.
 */
export function placementAllowed(
  host: string | undefined,
  records: ClusterRecord[],
  selfId: string | null,
  selfCluster: string,
): boolean {
  if (!host || host === 'local' || host === 'cloud') return true;
  return clusterOf(resolveHostToId(host, records), records, selfId, selfCluster) === selfCluster;
}

/**
 * Pure: a stable key for THIS node's in-cluster roster — the SORTED gatewayIds of
 * the cluster records whose cluster === `cluster`, joined by ','. Two ticks produce
 * the same key iff the in-cluster node membership is identical (order-independent),
 * so the supervisor can cheaply detect when its cluster's roster changed.
 */
export function computeRosterKey(records: ClusterRecord[], cluster: string): string {
  return records
    .filter((r) => r.cluster === cluster)
    .map((r) => r.gatewayId)
    .sort()
    .join(',');
}

/**
 * A bound, active executor whose host just left THIS node's cluster — the controller must
 * ACTIVELY MIGRATE it (not kill it) onto an in-cluster node.
 *   • `sid`       — the operable session id (cloud `binding.ccr.sid` when present, else `binding.sessionId`)
 *   • `host`      — the (now out-of-cluster) node the worker is bound to (`'unknown'` if unresolved)
 *   • `transport` — `'native'` (a local --remote-control worktree session, re-placed via env.host)
 *                   vs `'cloud'` (a `session_…` cloud session, resumed on an in-cluster node)
 */
export interface MigrationCandidate { missionId: string; sid: string; host: string; transport: 'cloud' | 'native'; }

/**
 * Pure: from the active missions, the bound executors whose host is NOT in this node's cluster
 * (`placementAllowed` === false). These are the workers a roster change orphaned — the controller
 * should migrate each onto an in-cluster node (keeping it running until its replacement is up),
 * NOT kill it. Unbound missions, terminal/non-active missions, and undefined/`'local'`/`'cloud'`/
 * in-cluster hosts are excluded. No I/O — trivially testable.
 */
export function computeMigrationCandidates(
  missions: Mission[],
  records: ClusterRecord[],
  selfId: string | null,
  selfCluster: string,
): MigrationCandidate[] {
  const out: MigrationCandidate[] = [];
  for (const m of missions) {
    const b = m.binding;
    if (!b?.sessionId) continue;                                  // unbound — nothing to migrate
    if (m.status !== 'active' && m.status !== 'waiting') continue; // only live missions
    const host = b.node ?? m.env.host ?? undefined;
    if (placementAllowed(host, records, selfId, selfCluster)) continue; // still in-cluster (or local/cloud)
    out.push({ missionId: m.id, sid: b.ccr?.sid || b.sessionId, host: host ?? 'unknown', transport: isNativeBinding(b) ? 'native' : 'cloud' });
  }
  return out;
}

export interface MissionTickDeps {
  now: number;
  cfg: { intervalMin: number; maxNudges: number; model: string };
  amMonitor: () => Promise<{ isMonitor: boolean; monitorNodeId: string | null; indeterminate?: boolean; stale?: boolean }>;
  listAll: () => Promise<Mission[]>;
  readExecutor: (m: Mission) => Promise<ExecutorState>;
  adjust: (m: Mission, out: ExecutorOutput) => Promise<AdjustResult>;
  startExecutor: (m: Mission, decision: PlacementDecision) => Promise<MissionBinding>;
  drive: (m: Mission, directive: string) => Promise<void>;
  save: (m: Mission) => Promise<void>;
}

/**
 * Cluster placement guard (async). Returns true when it is OK to spawn.
 * If denied: tags the mission with `ctl:placement-error`, persists via d.save(m),
 * logs the skip, and returns false so the caller can return early.
 */
async function checkPlacement(m: Mission, d: MissionTickDeps): Promise<boolean> {
  const records = await getClusterRecords();
  if (placementAllowed(m.env.host, records, thisNode(), getMyCluster())) return true;
  // Refused — tag the mission and skip spawn
  if (!m.tags) m.tags = {};
  const h = m.env.host ?? 'unknown';
  const existing = m.tags['ctl:placement-error'] ?? [];
  if (!existing.includes(h)) existing.push(h);
  m.tags['ctl:placement-error'] = existing;
  await d.save(m);
  console.info(`[mission-controller] placement blocked for ${m.id}: host "${h}" not in this cluster — tagged ctl:placement-error`);
  return false;
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
    if (!await checkPlacement(m, d)) return;
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
    if (!await checkPlacement(m, d)) return;
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
      const res = await tmuxCcController.launch({ cwd, remoteControl: true, skipPermissions: true, autoTrust: true, name: missionSessionTitle(m), renameTo: missionSessionName(m), tmuxPrefix: 'lmx' });
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

/** The standing directive sent to the controller agent each pass. Sourced from the workflow
 *  registry's default ('controller.pass') so there is exactly one copy of the text — this is
 *  the TS-const fallback used when the live registry render is unavailable (see passDirective
 *  on SupervisorDeps). The Task-2 default body = this old text + an onboarded-missions addendum. */
export const CONTROLLER_PASS_DIRECTIVE = DEFAULT_WORKFLOWS['controller.pass'].body;

/** Drive sent INSTEAD of CONTROLLER_PASS_DIRECTIVE when the supervisor detected that this
 *  node's cluster roster (in-cluster node membership) changed since the last pass. Tells the
 *  controller to re-scope its cluster before the normal pass and ACTIVELY MIGRATE the workers
 *  orphaned by the change: each KEEPS RUNNING until its in-cluster replacement is up (never
 *  killed), the controller re-adopts any now-in-cluster worker, and — when the supervisor knows
 *  the specific orphaned sessions — they are appended below as an explicit migration list. */
export const CONTROLLER_ROSTER_CHANGED_DIRECTIVE =
  '⟦CLUSTER ROSTER CHANGED⟧ Your cluster\'s node membership just changed. Re-read your scope (call cluster_list), then re-evaluate every executor/worker: RE-ADOPT any that is now IN your cluster, and ACTIVELY MIGRATE any whose node just LEFT your cluster onto an in-cluster node (or cloud) — do NOT kill it and do NOT merely forget it; keep it RUNNING until its in-cluster replacement is up, then retire the original so no in-flight work is dropped. Also place any pending in-cluster task. Then run a normal controller pass (mission_changes → mission_schedule). If a list of specific workers to migrate follows below, act on each of them FIRST.';

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
  '⟦BOOTSTRAP — DO THIS FIRST, ONCE⟧ At the very start of this session, BEFORE acting on any',
  'mission or pass directive, call `guide("missions")` to load your complete controller',
  'playbook (how to spawn an executor, bind it, handle gates, and answer a pending question).',
  'This is mandatory self-bootstrap for your role — do not skip it, and do not wait to be told.',
  'If `guide` is unavailable, proceed using the rules in this prompt. (You only need to load it',
  'once per session; later passes can rely on what you loaded.)',
  '',
  'You are **event-driven, not polling**: a non-LLM supervisor watches the executors for you',
  'and drives you ONLY when something material happens — an executor finished, blocked, or',
  'needs approval; a new mission was created; or a periodic safety check. Ongoing executor',
  'progress is tracked for you and shown on each mission (`interim`) — you do NOT need to poll',
  'it; look only if relevant to acting now.',
  '',
  '⟦RESPONSE CONTRACT — EVERY COMMAND⟧ Commands reach you wrapped with a ⟦CMD cmd-…⟧ id.',
  'ALWAYS end your reply with the matching line "⟦RESULT cmd-…⟧" followed by ONE line per',
  'assigned task: "- <task>: done|in-progress|blocked|skipped — <verifiable evidence: mission',
  'id+rev, session id, commit, file, count>". The supervisor PARSES this block to pair every',
  'command with a verified result; a missing block is journaled as an unacknowledged command',
  'and re-flagged. No tasks assigned → "- no-op: acknowledged". Evidence must be CHECKABLE —',
  'ids and numbers, never adjectives.',
  '',
  'YOUR SESSION IS A DURABLE IDENTITY: restarts, teardowns and failovers RESUME this same',
  'session from the tracked controller lineage — never re-establish context after a relaunch;',
  'continue exactly where the transcript leaves off. Every decision about you (drives, your',
  '⟦RESULT⟧ acks, lifecycle) is journaled and visible to the human in the Missions Trace panel.',
  '',
  'When driven, act on the CURRENT state via the SCHEDULING INTELLIGENCE flow below: call',
  '`mission_changes` then `mission_schedule` (the authoritative plan); for every active mission',
  'assess its executor (`mission_executor_status`), drive/adapt as needed, and mark it done when',
  'complete. `mission_list` gives full state; take placement/gating from `mission_schedule`, not',
  'per-mission `mission_place`.',
  '',
  'SPAWNING AN EXECUTOR (do it EXACTLY this way — there is NO dedicated "spawn" tool, so do NOT',
  'improvise): to run a mission worker, start a SESSION you can monitor and answer:',
  '  • cloud (PREFERRED, simplest): `ccr_cloud_start({prompt})` → returns a `session_…` sid.',
  '  • native: a `--remote-control` worktree session (never idle-suspends).',
  'Then IMMEDIATELY `mission_update({id, binding:{sessionId, kind:"worker"}})` to attach it — an',
  'UNBOUND worker is invisible to the supervisor, so its question is never surfaced to you.',
  '🚫 NEVER use `agent_execute` (or any one-shot agent tool) to run a mission worker. It cannot',
  'surface or let you answer an `AskUserQuestion`, so any worker that must ask a question is',
  'permanently unreachable through it. `agent_execute` is ONLY for fire-and-forget side tasks',
  'with no interaction — never for a mission executor.',
  '',
  'ANSWERING A WORKER FAST: if `mission_session_read(sid)` shows a `pendingQuestion`, answer it',
  'IMMEDIATELY with `mission_session_answer(sid, answer)` (an option label or free text) — top',
  'priority, before anything else. A CLOUD worker left blocked on a question idle-suspends within',
  'a couple of minutes and then CANNOT resume to consume a late answer; answered promptly it',
  'resumes and finishes in seconds. Do NOT use `mission_session_drive` to answer (it queues behind',
  'the open question). If a worker already suspended unanswered, RESUME it first via',
  '`mission_session_resume(sid)`; only if that returns `gone`/`conflict`/`kill-failed` do you mark the mission',
  '`blocked` (NOT `done`) and spawn a fresh worker; for a must-ask worker, prefer a native session.',
  '',
  'RESUMING / RECONNECTING A WORKER (resume-only, inject-first): ALWAYS prefer ' +
  '`mission_session_resume(sid)` — it reconnects the SAME session in place, so do NOT spawn a ' +
  'fresh worker for a resumable one. A LIVE worker is ' +
  'reconnected by injecting `/remote-control` into its terminal (no restart, context preserved); ' +
  'you do NOT need to do anything special — the tool handles it. If the worker is unreachable ' +
  '(headless) AND actively busy, the tool returns reason:"needs-force". Only then, and only if ' +
  'you are sure the work is stuck, re-call with `force:true` to kill-and-resume. An IDLE ' +
  'unreachable worker is auto-killed-and-resumed (no force needed). reason:"kill-failed" = the ' +
  'process would not die; do NOT keep retrying — surface it. reason:"gone" = terminal; spawn a ' +
  'FRESH worker as a separate, explicit action. Resume-first preserves context; respawn loses it.',
  '',
  'SCHEDULING INTELLIGENCE (tags · dependencies · history): each pass is driven by two read tools.',
  '  • `mission_schedule` is the DETERMINISTIC plan — {ready, blocked[{id,reason}], serializeGroups,',
  '    epicRollups, containers}. ALWAYS take the hard gating (dependency / resource / serialize / epic',
  '    rollup) from it; never re-derive those yourself. Act on `ready`; never spawn for a `container`',
  '    (an epic with children) — schedule its children instead and apply its `epicRollups` status via',
  '    mission_update when it differs from the stored parent.',
  '  • `mission_changes` lists recent EXTERNAL edits (anyone but you). Call it FIRST each pass and',
  '    re-evaluate those missions before acting — a human may have re-scoped or re-tagged one; adapt,',
  '    do not blindly override.',
  'SMART-TAGGING (you OWN the `ctl:` tag dimensions; NEVER write author dims project/feature/component):',
  '  use mission_tag to record decisions — `ctl:readiness` (ready/blocked/running/done), `ctl:serialize-group`',
  '  (<group> — missions sharing a value run one-at-a-time; the scheduler enforces it), `ctl:phase` (a batch',
  '  label). For two `ready` missions that touch the same area with no dependsOn, judge parallel-vs-sequence',
  '  via mission_neighbors/mission_graph; to serialize them, tag them the same `ctl:serialize-group`. Your tag',
  '  writes are auto-versioned + attributed, so the dashboard + history show what you decided.',
  'CLUSTER SCOPE: You control missions for YOUR cluster ONLY, and you place every executor on a',
  'node in your cluster (or cloud/local) — never on another cluster\'s host.',
  '',
  'CONTENTION: before placing an executor, call session_footprints to see what unmanaged sessions across your cluster occupy (node/repo/branch/worktree/open-changes/ports); do not spawn into a conflict — defer and retag instead.',
  '',
  'HEARTBEAT: only on a safety-check drive where there is genuinely nothing to do (no active',
  'missions, or nothing actionable), reply with EXACTLY one line beginning `⟦HEARTBEAT⟧` and',
  'nothing else (e.g. `⟦HEARTBEAT⟧ idle — 0 active missions`). When you take a real action or',
  'answer the user, narrate normally and DO NOT use that marker.',
  '',
  'PROCESS DOCS: your operating processes live in the workflow registry (fleet-synced,',
  'human-editable). The pass directive names which doc to fetch for a mission —',
  'mission_workflow_get(id) returns the rendered text to FOLLOW. You may improve an',
  '"open" doc via mission_workflow_set when experience warrants it, but ANNOUNCE every',
  'self-edit in chat with a one-line rationale; humans can inspect and roll back any',
  'edit (mission_workflow_history / mission_workflow_rollback).',
  '',
  'The user may message you directly in this session — treat their messages as authoritative',
  'instructions (create/pause/adjust missions, answer questions) and reply substantively.',
  'The mission store is cross-node shared; you run on the elected leader node.',
].join('\n');

/** Drive sent ONCE per Core-process boot when the supervisor ADOPTS a still-alive controller
 *  (lm-assist restarted around it). Tells the controller to reattach and resume in-flight work
 *  rather than waiting for the next material engagement. */
export const CONTROLLER_ADOPT_RESUME_DIRECTIVE =
  '⟦CORE RESTARTED — REATTACH⟧ The lm-assist Core under you restarted; you were NOT relaunched (your session and context are intact). Re-establish situational awareness and RESUME in-flight work now: run a normal pass (mission_changes → mission_schedule), then for every active mission re-check its executor/session state (mission_executor_status / mission_session_read) and continue where it left off — resume-first for anything that went stale during the restart. If a tool call failed mid-restart, simply retry it.';

/** Pure: the lmcc-* tmux sessions that are NOT the recorded controller — duplicates to sweep.
 *  (Observed live: a Core restart + tick race can launch a second controller while the original
 *  survives; the recorded one is authoritative, everything else lmcc-* is a stray.) */
export function pickStrayControllers(tmuxNames: string[], recordedTmux: string | null | undefined): string[] {
  return tmuxNames.filter((n) => n.startsWith('lmcc-') && !!n && n !== recordedTmux);
}

/**
 * Pure builder for the controller launch extras (system-prompt file + optional
 * hub-MCP keystone config file). `writeFile(name, body)` persists a file and
 * returns its path — injected so this stays unit-testable (no fs).
 *
 * Always writes the system-prompt file. MCP config preference order:
 *   1. localMcp (this node's own /mcp + worker token) — the controller is launched BY a
 *      running Core, so unlike login-time sessions there is no startup-ordering problem,
 *      and local tools are CLUSTER-CORRECT by construction: every mission_* call leader-
 *      anchors within THIS node's cluster. The hub keystone routes by account, which
 *      post-clusters can land the handler on another cluster's node (observed live:
 *      the stage leader's mission_list executing on the prod node → empty store).
 *   2. hub keystone (derived from hubUrl + apiKey) — fallback when no local token.
 *   3. neither — connector inheritance (non-fatal).
 * The server NAME is identical in both shapes so the controller's tool surface
 * (mcp__lm-assist-hub__*) and every playbook referencing it are unaffected.
 */
export function buildControllerLaunchExtras(args: {
  hubUrl: string | null;
  apiKey: string | null;
  writeFile: (name: string, body: string) => string;
  /** This node's own MCP endpoint + worker token (preferred over the hub keystone). */
  localMcp?: { url: string; token: string } | null;
}): { appendSystemPromptFile: string; mcpConfigPath?: string } {
  // Lead with the fleet/connector identity so the controller knows its fleet + cluster boundary
  // (it places executors only within its cluster; this names the boundary). Dynamic at launch.
  const appendSystemPromptFile = args.writeFile('mission-controller-sp.txt', fleetIdentity() + '\n\n' + CONTROLLER_SYSTEM_PROMPT);
  const out: { appendSystemPromptFile: string; mcpConfigPath?: string } = { appendSystemPromptFile };
  if (args.localMcp?.url && args.localMcp.token) {
    const cfg = {
      mcpServers: {
        'lm-assist-hub': { type: 'http', url: args.localMcp.url, headers: { 'x-api-key': args.localMcp.token } },
      },
    };
    out.mcpConfigPath = args.writeFile('mission-controller-mcp.json', JSON.stringify(cfg, null, 2));
    return out;
  }
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
 *   !isMonitor (2+ consecutive ticks) → teardown  (leadership genuinely moved)
 *   !isMonitor (first tick)           → idle      (election blip — see below)
 *   isMonitor && !live                → launch    (no live session; always launch regardless of driveDue)
 *   isMonitor && live && driveDue     → drive     (time for another adapt pass)
 *   isMonitor && live && !driveDue    → idle      (lifecycle OK, drive cadence not yet elapsed)
 *
 * The teardown DEBOUNCE exists because the election reads hub + cluster state
 * that is briefly wrong right after a core restart (hub not yet authenticated →
 * amIMonitor throws → "not monitor"; cluster map cold → every node pools into
 * `default` → a lower gateway-id on another cluster "wins"). One such tick used
 * to DESTROY a healthy controller and relaunch a fresh one a minute later
 * (observed live 2026-07-19: drive → teardown → launch across a deploy
 * restart). Real leadership loss persists across ticks, so a 2-tick streak
 * still tears down — just ~1 min later, which is fine for loser cleanup.
 */
export function decideSupervisor(input: { isMonitor: boolean; live: boolean; driveDue: boolean; notMonitorStreak?: number; indeterminate?: boolean }): { action: 'teardown' | 'launch' | 'drive' | 'idle' } {
  // Election inputs unavailable and no recent confident answer → do NOTHING
  // destructive (no teardown, no launch). The next confident tick decides.
  if (input.indeterminate) return { action: 'idle' };
  if (!input.isMonitor) return (input.notMonitorStreak ?? 0) >= 2 ? { action: 'teardown' } : { action: 'idle' };
  if (!input.live) return { action: 'launch' };
  if (input.driveDue) return { action: 'drive' };
  return { action: 'idle' };
}

// ── Controller context-health: compact a near-full controller ────────────────
// A controller near its context limit wedges (observed live 2026-07-21 at ctx:94%
// — idle, not surfacing finished executor work; its next drive risks failing).
// Compacting (native /compact) sheds context while KEEPING the session, so it
// retains its identity + a running summary. NOTE resume-first recovery does NOT
// help this case — resuming reloads the SAME full context.
const CONTROLLER_COMPACT_THRESHOLD_PCT = 85;        // ctx% at/above which we compact
const CONTROLLER_COMPACT_COOLDOWN_MS = 10 * 60_000; // don't re-fire while it settles
let _lastControllerCompactAt: number | null = null;
export function _resetControllerCompactState(): void { _lastControllerCompactAt = null; }

/** Pure: should the supervisor compact the controller now? True when its context
 *  is at/above the threshold and we're past the cooldown since the last compact. */
export function shouldCompactController(input: {
  contextPct: number | null;
  threshold: number;
  lastCompactAt: number | null;
  now: number;
  cooldownMs: number;
}): boolean {
  if (input.contextPct === null || input.contextPct < input.threshold) return false;
  if (input.lastCompactAt !== null && input.now - input.lastCompactAt < input.cooldownMs) return false;
  return true;
}

// ── Command contract: every command to the controller is TRACKED ─────────────
// Each drive carries a cmd id and instructs the controller to end its reply
// with a verifiable per-task ⟦RESULT⟧ block; the tick scans replies for those
// blocks and journals ack / ack-missing — so "command sent" always pairs with
// "verifiable result received" (or a visible gap).

export function newCmdId(): string {
  return `cmd-${randomBytes(3).toString('hex')}`;
}

/** Pure: append the response contract to a controller-bound command. */
export function wrapControllerCommand(text: string, cmdId: string): string {
  return `${text}

⟦CMD ${cmdId}⟧ End your reply with the line "⟦RESULT ${cmdId}⟧" followed by ONE line per task assigned above, format: "- <task>: done|in-progress|blocked|skipped — <verifiable evidence: commit/file/id/count/url>". No tasks assigned → reply "⟦RESULT ${cmdId}⟧" then "- no-op: acknowledged".`;
}

/** Pure: find a ⟦RESULT <cmdId>⟧ block in reply text → its task lines. */
export function extractResultBlock(text: string, cmdId: string): { found: boolean; tasks: string[] } {
  const marker = `⟦RESULT ${cmdId}⟧`;
  const idx = text.lastIndexOf(marker);
  if (idx < 0) return { found: false, tasks: [] };
  const after = text.slice(idx + marker.length).split('\n');
  const tasks: string[] = [];
  for (const raw of after) {
    const line = raw.trim();
    if (!line) { if (tasks.length) break; continue; }
    if (line.startsWith('- ')) { tasks.push(line.slice(2, 200)); if (tasks.length >= 20) break; continue; }
    if (line.startsWith('⟦')) break; // next marker/block
    if (tasks.length) break;         // prose after the block ends it
  }
  return { found: true, tasks };
}

// Consecutive not-monitor ticks (module state — the supervisor is a singleton per Core).
let _notMonitorStreak = 0;
export function _resetNotMonitorStreak(): void { _notMonitorStreak = 0; }
// Journal de-noising: remember the last monitor state + whether boot was recorded,
// so idle ticks only journal when something CHANGED.
let _lastJournaledMonitor: boolean | null = null;
let _bootJournaled = false;
export function _resetJournalState(): void { _lastJournaledMonitor = null; _bootJournaled = false; }

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
  amMonitor: () => Promise<{ isMonitor: boolean; monitorNodeId: string | null; indeterminate?: boolean; stale?: boolean }>;
  getControllerSession: () => Promise<ControllerSession | null>;
  putControllerSession: (cs: ControllerSession | null) => Promise<void>;
  isLive: (cs: ControllerSession) => boolean;
  /** Optional control-journal sink — real deps append to control-journal.jsonl; tests omit. */
  journal?: (entry: { at: number; kind: 'boot' | 'tick' | 'drive' | 'lifecycle' | 'election' | 'ack' | 'ack-missing'; [k: string]: unknown }) => void;
  /** Optional control-journal READER — the loop consumes its own traces
   *  (drive-failure recovery, launch-churn back-off, pending-command acks). */
  recentJournal?: () => Array<{ at: number; kind: string; [k: string]: unknown }>;
  /** Optional: recent assistant reply text of the controller session — scanned
   *  for ⟦RESULT cmd-…⟧ blocks to verify command acknowledgment. */
  readControllerTail?: (sessionId: string) => Promise<string>;
  /** Optional: the session's transcript-declared bridge sid (bridge_status line)
   *  — backfills record.cse for resumed/adopted controllers. */
  readBridgeSid?: (sessionId: string) => Promise<string | null>;
  /** Optional: a handoff-onboarded local session blocked on a TUI dialog →
   *  its mission id. Makes the tick drive the controller within ~1 min so the
   *  dialog gets answered instead of sitting until the next cadence. */
  onboardedDialogPending?: () => Promise<string | null>;
  launch: () => Promise<ControllerSession>;
  /** Drive the live controller. `directive` defaults to CONTROLLER_PASS_DIRECTIVE; the
   *  supervisor passes CONTROLLER_ROSTER_CHANGED_DIRECTIVE when a cluster-roster change
   *  triggered the engagement. */
  drive: (cs: ControllerSession, directive?: string) => Promise<void>;
  teardown: (cs: ControllerSession) => Promise<void>;
  /** Read the controller session's context-usage percent (0-100), or null if unknown.
   *  Absent → the context-health compact guard is skipped (behaviour unchanged). */
  controllerContextPct?: (cs: ControllerSession) => Promise<number | null>;
  /** Compact the controller (native /compact) to shed context. Returns true when the
   *  compact was initiated; false if the session was busy (retry next tick). */
  compactController?: (cs: ControllerSession) => Promise<boolean>;
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
  /** Long safety interval (min) — once elapsed, engage even without a MATERIAL change,
   *  as long as something (material or interim) happened since the last engagement.
   *  A fully quiescent fleet (zero activity the whole interval) never force-engages —
   *  there would be nothing new to review. Default 45. */
  safetyIntervalMin?: number;
  /** Current stable key of THIS node's in-cluster roster (sorted in-cluster gatewayIds).
   *  When present, evaluateEngagement force-engages on a change vs the persisted lastRosterKey
   *  so the controller re-scopes its cluster. Production wires it to computeRosterKey over
   *  getClusterRecords()+getMyCluster(); omitted → no roster-change trigger (unchanged behavior). */
  rosterKey?: () => Promise<string>;
  /** Fetch this node's cluster records (gatewayId→cluster map). When present together with
   *  myCluster + selfId, a roster-change engagement computes the orphaned-worker migration list
   *  (computeMigrationCandidates) so the controller's directive can name the exact sessions to
   *  migrate. Production wires it to getClusterRecords. Omitted → no migration list (base directive). */
  listClusterRecords?: () => Promise<ClusterRecord[]>;
  /** This node's cluster name (wired to getMyCluster). Used with listClusterRecords + selfId. */
  myCluster?: () => string;
  /** This node's own gatewayId / self identity (wired to thisNode). Used with listClusterRecords + myCluster. */
  selfId?: () => string | null;
  /** Render the standard pass directive from the workflow registry ('controller.pass').
   *  Optional; absent or throwing → CONTROLLER_PASS_DIRECTIVE (TS fallback). */
  passDirective?: () => Promise<string>;
  /** Restart-adopt (optional): once per Core-process boot, when the recorded controller is
   *  found ALIVE, fire one CONTROLLER_ADOPT_RESUME_DIRECTIVE drive so in-flight work resumes
   *  promptly instead of waiting for the next material engagement. `done()` reads / `mark()`
   *  sets a process-lifetime flag (module-level in production; injected fakes in tests). */
  bootAdopt?: { done: () => boolean; mark: () => void };
  /** Stray-controller sweep (optional): list all tmux session names; the tick kills every
   *  lmcc-* session that is not the recorded controller (self-healing duplicate cleanup). */
  listTmuxSessions?: () => Promise<string[]>;
  /** Kill one stray tmux session by name (best-effort; used only by the sweep). */
  killStrayTmux?: (name: string) => Promise<void>;
  /** I2 — persist an onboarded mission's advanced `control.lastOutputCursor` (best-effort;
   *  production wires it to `putMission`). Optional: absent → the cursor advance in
   *  evaluateEngagement is computed in-memory but never durably persisted (unchanged legacy
   *  behavior for callers that don't wire this dep — e.g. tests that don't care about it). */
  persistMissionControl?: (m: Mission) => Promise<void>;
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
 * returns whether a material change / new mission / safety interval / cluster-roster
 * change means the controller should be driven (plus an optional `reason` so the
 * caller can pick a roster-specific directive, and — on a roster change — the
 * `migrationCandidates` list of orphaned workers the controller must actively migrate).
 * Caller guarantees the engagement deps are present.
 */
async function evaluateEngagement(
  deps: SupervisorDeps,
): Promise<{ engage: boolean; reason?: 'roster-change'; migrationCandidates?: MigrationCandidate[] }> {
  const eng = await deps.getEngagement!();
  const active = await deps.listActiveForEngage!();
  const now = deps.now;
  const curSeen: EngagementState['seen'] = {};
  let materialCount = 0;
  // Wave 4.1 — tracks whether ANYTHING happened this tick (material or merely interim,
  // i.e. a mission's cursor/liveness/gate moved at all). Combined with the persisted
  // dirtySinceEngage flag below to gate the safety-interval fallback: it must not force
  // an LLM pass on pure elapsed time when the fleet has been completely quiescent.
  let anyUpdateThisTick = false;
  for (const m of active) {
    let sig: ExecNow;
    try {
      sig = await deps.readSignal!(m);
    } catch {
      // A read failure for one mission must not sink the tick — carry forward prior state.
      curSeen[m.id] = eng.seen[m.id] ?? { alive: true, gated: false, cursor: 0 };
      continue;
    }
    // I2 — persist the advanced cursor onto the mission for an onboarded (origin:'onboarded')
    // mission. Without this, `m.control.lastOutputCursor` was NEVER written back for an onboarded
    // session (only `processMission`'s cloud/native executor path writes it, via the 'adjust'
    // decision branch — a path onboarded missions never take, since they're already-bound and
    // never scheduled/adjusted like a normal executor). The result: every tick re-read the SAME
    // stale cursor, so `readOnboardedSignal`'s first-read baseline (I2 above) would fire on EVERY
    // read forever, and the delta/humanActive detection could never advance past the initial
    // baseline. `putMission` does not version control-field changes (TRACKED_FIELDS excludes
    // `control`), so this write is cheap and does not spam the mission's edit history.
    if (m.origin === 'onboarded' && sig.cursor !== (m.control.lastOutputCursor ?? 0)) {
      m.control.lastOutputCursor = sig.cursor;
      if (deps.persistMissionControl) {
        try { await deps.persistMissionControl(m); } catch { /* best-effort — never sink the tick on a persist failure */ }
      }
    }
    const act = classifyExecutorActivity(eng.seen[m.id], sig);
    curSeen[m.id] = { alive: sig.alive, gated: sig.gated, cursor: sig.cursor };
    if (act.material) {
      materialCount++;
      anyUpdateThisTick = true;
    } else if (act.interim) {
      anyUpdateThisTick = true;
      if (deps.setInterim) {
        try { await deps.setInterim(m.id, { at: now, text: act.interim.summary }); } catch { /* best-effort */ }
      }
    }
  }
  const activeIds = active.map((m) => m.id);
  const dirtySinceEngage = (eng.dirtySinceEngage ?? false) || anyUpdateThisTick;
  let engage = shouldEngage({
    now,
    lastEngagedAt: eng.lastEngagedAt,
    safetyIntervalMin: deps.safetyIntervalMin ?? 45,
    materialCount,
    activeIds,
    lastActiveIds: eng.lastActiveIds,
    anyUpdateSinceEngage: dirtySinceEngage,
  });

  // ── Cluster-roster change — ADDITIONAL force-engage trigger ──
  // When THIS node's in-cluster node membership changes, drive the controller so it
  // re-scopes its cluster (release out-of-cluster workers, adopt now-in-cluster ones).
  // The very first observation only records the baseline (no spurious boot-time drive).
  // Best-effort: a roster read failure must never sink the tick.
  let reason: 'roster-change' | undefined;
  let migrationCandidates: MigrationCandidate[] | undefined;
  let nextRosterKey = eng.lastRosterKey;
  if (deps.rosterKey) {
    try {
      const rosterKey = await deps.rosterKey();
      if (eng.lastRosterKey === undefined) {
        nextRosterKey = rosterKey;          // baseline — record without forcing a drive
      } else if (eng.lastRosterKey !== rosterKey) {
        engage = true;                      // membership changed → re-scope the cluster now
        reason = 'roster-change';
        nextRosterKey = rosterKey;
        // Compute the orphaned-worker migration list ONCE (best-effort) so the caller can
        // enrich the roster-changed directive with the exact sessions to migrate. A failure
        // here must never sink the tick — leave migrationCandidates undefined (base directive).
        if (deps.listClusterRecords && deps.myCluster && deps.selfId) {
          try {
            const records = await deps.listClusterRecords();
            migrationCandidates = computeMigrationCandidates(active, records, deps.selfId(), deps.myCluster());
          } catch { /* best-effort — leave migrationCandidates undefined on error */ }
        }
      }
    } catch { /* leave lastRosterKey unchanged on a read failure */ }
  }

  // Persist `seen` every tick (cursor/liveness/gate tracking advances regardless);
  // stamp lastEngagedAt + lastActiveIds only when we actually engage; carry/advance
  // lastRosterKey so a detected roster change fires exactly once; dirtySinceEngage
  // clears on any engage (its purpose served) and otherwise carries forward so an
  // interim-only tick is still remembered by the next safety-interval check.
  await deps.putEngagement!({
    lastEngagedAt: engage ? now : eng.lastEngagedAt,
    lastActiveIds: engage ? activeIds : eng.lastActiveIds,
    seen: curSeen,
    lastRosterKey: nextRosterKey,
    dirtySinceEngage: engage ? false : dirtySinceEngage,
  });
  return { engage, reason, migrationCandidates };
}

export async function runSupervisorTick(deps: SupervisorDeps): Promise<{ action: string; controllerSession: ControllerSession | null }> {
  const verdict = await deps.amMonitor();
  const { isMonitor } = verdict;
  const cs = await deps.getControllerSession();
  let live = cs ? deps.isLive(cs) : false;

  // ── THE LOOP CONSUMES ITS OWN TRACES ──
  // Drive-failure recovery: a controller that LOOKS live (tmux exists) but has
  // rejected the last 3+ drives is wedged — treat it as not-live so this tick
  // relaunches it (lossless: the launcher resumes the same session from the
  // lineage). Any successful drive resets the streak.
  let recoveryReason: string | null = null;
  if (cs && live && deps.recentJournal) {
    try {
      const { driveFailureStreak } = require('./control-journal') as typeof import('./control-journal');
      const streak = driveFailureStreak(deps.recentJournal() as never, cs.sessionId);
      if (streak >= 3) {
        live = false;
        recoveryReason = `drive-failure streak ${streak} → relaunch (resume-first keeps the session)`;
      }
    } catch { /* advisory */ }
  }

  // Stray-controller sweep (self-healing): a Core restart + tick race has been observed to
  // leave a duplicate lmcc-* tmux beside the recorded controller. The record is authoritative —
  // kill every other lmcc-* session. Leader-only, best-effort, never sinks the tick.
  if (isMonitor && cs?.tmux && deps.listTmuxSessions && deps.killStrayTmux) {
    try {
      const strays = pickStrayControllers(await deps.listTmuxSessions(), cs.tmux);
      for (const s of strays) {
        try { await deps.killStrayTmux(s); } catch { /* per-stray best-effort */ }
      }
    } catch { /* sweep is best-effort */ }
  }

  // Restart-adopt: this Core process found a still-ALIVE recorded controller (lm-assist was
  // restarted around it — never kill or orphan it). Once per process boot, drive it with the
  // reattach directive so in-flight work resumes promptly instead of waiting for the next
  // material engagement or safety interval.
  if (isMonitor && live && cs && deps.bootAdopt && !deps.bootAdopt.done()) {
    deps.bootAdopt.mark();
    await deps.drive(cs, CONTROLLER_ADOPT_RESUME_DIRECTIVE);
    const adopted: ControllerSession = { ...cs, lastDriveAt: deps.now };
    await deps.putControllerSession(adopted);
    return { action: 'adopt-drive', controllerSession: adopted };
  }

  // Context-health: compact a near-full controller BEFORE driving it. A controller
  // at its context limit wedges (idle, not surfacing progress; its next drive risks
  // failing). /compact sheds context while keeping the session. Idle-guarded by
  // compactController (returns false when busy → retry next tick). Best-effort —
  // a read/compact failure never sinks the tick.
  if (isMonitor && live && cs && deps.controllerContextPct && deps.compactController) {
    try {
      const pct = await deps.controllerContextPct(cs);
      if (shouldCompactController({ contextPct: pct, threshold: CONTROLLER_COMPACT_THRESHOLD_PCT, lastCompactAt: _lastControllerCompactAt, now: deps.now, cooldownMs: CONTROLLER_COMPACT_COOLDOWN_MS })) {
        const sent = await deps.compactController(cs);
        if (sent) {
          _lastControllerCompactAt = deps.now;
          deps.journal?.({ at: deps.now, kind: 'lifecycle', event: 'compact-controller', sessionId: cs.sessionId, contextPct: pct });
          return { action: `compact-controller(ctx=${pct}%)`, controllerSession: cs };
        }
      }
    } catch { /* context read / compact is best-effort */ }
  }

  // Drive gate. Wave 4 (when the engagement deps are present): change-based — the
  // non-LLM detector reads each active executor cheaply, surfaces interim progress
  // WITHOUT engaging, and drives only on a material change / new mission / safety
  // interval. Otherwise (Wave-3 fallback): time-based isDriveDue. Only evaluated
  // when monitor+live (the only case decideSupervisor uses driveDue).
  let driveDue = false;
  let driveReason: 'roster-change' | undefined;
  let driveCands: MigrationCandidate[] | undefined;
  if (isMonitor && live && cs) {
    if (deps.listActiveForEngage && deps.readSignal && deps.getEngagement && deps.putEngagement) {
      const ev = await evaluateEngagement(deps);
      driveDue = ev.engage;
      driveReason = ev.reason;
      driveCands = ev.migrationCandidates;
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
    // Fast-track: a handoff-onboarded session blocked on a TUI dialog must not
    // wait out the cadence — drive the controller NOW so it answers (the pass
    // directive already says pendingQuestion is answered first).
    if (!driveDue && deps.onboardedDialogPending) {
      try {
        const mid = await deps.onboardedDialogPending();
        if (mid) {
          driveDue = true;
          deps.journal?.({ at: Date.now(), kind: 'tick', action: 'dialog-fasttrack', missionId: mid, isMonitor, live, driveDue: true });
        }
      } catch { /* advisory */ }
    }
  }

  // Streak accounting: only a FRESH confident "not monitor" advances the
  // teardown streak. Indeterminate/stale answers carry no new information —
  // they freeze the streak (and indeterminate also forces idle below).
  if (verdict.indeterminate || verdict.stale) {
    /* freeze */
  } else {
    _notMonitorStreak = isMonitor ? 0 : _notMonitorStreak + 1;
  }
  let { action } = decideSupervisor({ isMonitor, live, driveDue, notMonitorStreak: _notMonitorStreak, indeterminate: verdict.indeterminate });

  // Launch-churn back-off: 3+ launches/resumes inside 10 min means the loop is
  // feeding a crash cycle (launch → die → launch …). Idle this tick instead —
  // the journal shows the churn, and a human (or the next quiet window) breaks it.
  if (action === 'launch' && deps.recentJournal) {
    try {
      const { recentLaunchCount } = require('./control-journal') as typeof import('./control-journal');
      const launches = recentLaunchCount(deps.recentJournal() as never, deps.now);
      if (launches >= 3) {
        action = 'idle';
        recoveryReason = `churn-backoff: ${launches} launches in 10min — holding this tick`;
        deps.journal?.({ at: Date.now(), kind: 'tick', action: 'churn-backoff', launchesInWindow: launches, isMonitor, live, record: cs?.sessionId ?? null });
      }
    } catch { /* advisory */ }
  }

  // ── Control journal: every non-idle decision, every monitor-state change,
  //    and a once-per-boot marker — each with the FULL inputs so a wrong
  //    action is diagnosable (and recoverable) from the trace alone. ──
  if (deps.journal) {
    try {
      if (!_bootJournaled) {
        _bootJournaled = true;
        deps.journal({ at: Date.now(), kind: 'boot', record: cs?.sessionId ?? null, tmux: cs?.tmux ?? null, live, isMonitor, indeterminate: verdict.indeterminate, stale: verdict.stale });
      }
      const monitorChanged = _lastJournaledMonitor !== null && _lastJournaledMonitor !== isMonitor;
      if (action !== 'idle' || monitorChanged) {
        deps.journal({
          at: Date.now(), kind: monitorChanged && action === 'idle' ? 'election' : 'tick',
          action, isMonitor, indeterminate: verdict.indeterminate, stale: verdict.stale,
          monitorNodeId: (verdict as { monitorNodeId?: string | null }).monitorNodeId ?? null,
          notMonitorStreak: _notMonitorStreak, live, driveDue,
          record: cs?.sessionId ?? null, tmux: cs?.tmux ?? null,
          ...(recoveryReason ? { reason: recoveryReason } : {}),
        });
      }
      _lastJournaledMonitor = isMonitor;
    } catch { /* advisory */ }
  }

  // ── Bridge-sid backfill: a live controller whose record lacks its cloud
  //    handle (resumed/adopted — the launch-time poll missed the bridge)
  //    gets it from its OWN transcript's bridge_status line. Unlocks the
  //    Claude-app deep link and cloud-transport drives. ──
  if (cs && live && !cs.cse && deps.readBridgeSid) {
    try {
      const bridgeSid = await deps.readBridgeSid(cs.sessionId);
      if (bridgeSid) {
        const updated = { ...cs, cse: bridgeSid };
        await deps.putControllerSession(updated);
        deps.journal?.({ at: Date.now(), kind: 'lifecycle', event: 'cse-discovered', sessionId: cs.sessionId, cse: bridgeSid });
      }
    } catch { /* advisory — retry next tick */ }
  }

  // ── Command-ack scan: pair every tracked command with its verifiable
  //    ⟦RESULT⟧ block from the controller's replies (or journal the gap). ──
  if (deps.journal && deps.recentJournal && deps.readControllerTail && cs) {
    try {
      const { pendingCommandIds, ackMissingWarned } = require('./control-journal') as typeof import('./control-journal');
      const entries = deps.recentJournal() as never[];
      const pending = pendingCommandIds(entries, { now: Date.now() });
      if (pending.length) {
        const tail = await deps.readControllerTail(cs.sessionId).catch(() => '');
        for (const cmdId of pending) {
          const res = extractResultBlock(tail, cmdId);
          if (res.found) {
            deps.journal({ at: Date.now(), kind: 'ack', cmdId, tasks: res.tasks.slice(0, 12) });
          } else {
            const sent = (entries as Array<{ kind: string; cmdId?: unknown; at: number }>).find((e) => e.kind === 'drive' && e.cmdId === cmdId);
            if (sent && Date.now() - sent.at > 10 * 60_000 && !ackMissingWarned(entries as never, cmdId)) {
              deps.journal({ at: Date.now(), kind: 'ack-missing', cmdId, sentAt: sent.at });
            }
          }
        }
      }
    } catch { /* advisory */ }
  }

  if (action === 'teardown') {
    if (cs) {
      await deps.teardown(cs);
      await deps.putControllerSession(null);
    }
    return { action: 'teardown', controllerSession: null };
  }

  if (action === 'launch') {
    // TOCTOU guard (restart-adopt): the liveness read above may be stale — a controller that was
    // mid-registration, or one this fresh Core process hasn't observed yet (lm-assist restart),
    // can read false-dead and trigger a duplicate launch. Re-verify RIGHT before acting: if the
    // recorded controller is actually alive now, ADOPT it instead of relaunching (never kill or
    // orphan a live controller on a Core restart). EXCEPTION: a drive-failure recovery
    // (recoveryReason set) targets a controller whose tmux IS alive but wedged — adopting it
    // back would perpetuate the wedge; fall through to teardown + resume-first relaunch.
    if (cs && !recoveryReason && deps.isLive(cs)) {
      return { action: 'adopt', controllerSession: cs };
    }
    // Defensive dedupe: if a prior controller record exists but we're (re)launching (it was deemed
    // !live, or its bridge failed), tear down its tmux FIRST so a relaunch never stacks a second
    // controller on top of a still-running one (belt-and-suspenders with the isLive fix).
    if (cs) { try { await deps.teardown(cs); } catch { /* best-effort */ } }
    // Launch with lastDriveAt unset so the next tick triggers a drive immediately.
    const newCs = await deps.launch();
    await deps.putControllerSession(newCs);
    // A controller launched BY this process needs no restart-adopt drive later.
    deps.bootAdopt?.mark();
    return { action: 'launch', controllerSession: newCs };
  }

  if (action === 'idle') {
    // Lifecycle is fine, drive cadence not yet elapsed — nothing to do.
    return { action: 'idle', controllerSession: cs };
  }

  // action === 'drive' — pick the roster-changed directive when a cluster-roster change
  // triggered this engagement (enriched with the EXACT workers to migrate, when known),
  // else the standard pass directive.
  let directive = CONTROLLER_PASS_DIRECTIVE;
  if (deps.passDirective) {
    try { directive = await deps.passDirective(); } catch { /* registry unavailable → TS fallback */ }
  }
  if (driveReason === 'roster-change') {
    directive = CONTROLLER_ROSTER_CHANGED_DIRECTIVE;
    if (driveCands && driveCands.length) {
      directive += '\n\nWorkers to MIGRATE now (their node left your cluster — migrate each onto an in-cluster node; do NOT kill them):\n'
        + driveCands.map((c) => `- mission ${c.missionId} · session ${c.sid} · was on ${c.host} · ${c.transport}`).join('\n')
        + '\n\nFor each — CLOUD: call mission_session_resume(sid) so an in-cluster node takes over driving the same session, then mission_update its binding host to an in-cluster node. NATIVE: mission_update(env.host=<an in-cluster host from cluster_list>) then mission_session_resume(sid, missionId) (or mission_place) to re-place it in-cluster. Keep the orphaned session running until its replacement is up, then retire it. Never drop in-flight work.';
    }
  }
  await deps.drive(cs!, directive);
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

/**
 * Onboarded-mission read deps (local + cross-node) — deps-injected for testability.
 * Cross-node reads go through the session ops proxy on the session's own node
 * (`POST /mission/session/:sid/read` / `/status`), NOT the cloud path.
 */
export interface OnboardedReadDeps {
  selfNode: () => string;
  /** Local role-aware native read (AgentSessionStore). */
  readLocalConversation: (sid: string) => Promise<{ messages: Array<{ role: string; text: string }> }>;
  /** Local native liveness. */
  verdict: (sid: string) => { driveable: boolean };
  /** Cross-node read via the session ops proxy (POST /mission/session/:sid/read on the session's node). */
  proxyRead: (node: string, sid: string) => Promise<{ messages: Array<{ role: string; text: string }> }>;
  /** Cross-node liveness (POST /mission/session/:sid/status on the session's node). */
  proxyStatus: (node: string, sid: string) => Promise<{ alive: boolean }>;
}

/**
 * Wave "onboarded" — read an onboarded mission's live session (local or cross-node) and
 * additionally detect HUMAN activity (a plain new user prompt, not our drive marker / harness
 * noise) so the engagement classifier can be nudged to engage even without a status marker.
 * Cloud onboarded bindings delegate to `readCloudExecutor` (humanActive stays false — v1
 * limit: cloud messages here are plain strings, not role-tagged, so we can't yet tell human
 * from driven text on that path).
 */
export async function readOnboardedSignal(m: Mission, deps: OnboardedReadDeps): Promise<ExecNow & { humanActive: boolean }> {
  const sid = m.binding?.sessionId;
  if (!sid) return { alive: false, gated: false, cursor: 0, newLines: [], humanActive: false };
  if (m.binding?.node === 'cloud' || detectTransportSafe(sid) === 'cloud') {
    const st = await readCloudExecutor(m);
    return { alive: st.alive, gated: !!st.gate, cursor: st.newOutput?.cursor ?? (m.control.lastOutputCursor ?? 0), newLines: st.newOutput?.messages ?? [], humanActive: false };
  }
  const node = m.binding?.node;
  const local = !node || node === deps.selfNode();
  try {
    let alive: boolean; let messages: Array<{ role: string; text: string }>;
    if (local) {
      alive = deps.verdict(sid).driveable;
      messages = (await deps.readLocalConversation(sid)).messages;
    } else {
      alive = (await deps.proxyStatus(node!, sid)).alive;
      messages = (await deps.proxyRead(node!, sid)).messages;
    }
    // I2 — first-read baseline: lastOutputCursor is undefined/absent when this onboarded
    // mission has never been read before (the session may already have a long pre-onboard
    // history). Baseline it silently: cursor = messages.length, no newLines, no humanActive —
    // else the ENTIRE pre-onboard transcript would be treated as "new" on the very first tick
    // and could spuriously flag humanActive (or spam interim) for messages the controller never
    // actually missed.
    if (m.control.lastOutputCursor === undefined) {
      return { alive, gated: false, cursor: messages.length, newLines: [], humanActive: false };
    }
    const last = m.control.lastOutputCursor;
    // I2 — backward-cursor safety: if the persisted cursor is now BEYOND the transcript length
    // (e.g. the transcript was rotated/shrunk, or cross-node message shape changed), slicing
    // from `last` would silently produce [] anyway, but resolving `cursor` from the SHRUNK
    // messages.length while `last` is even bigger risks the next-tick delta going negative /
    // re-surfacing stale lines once the transcript grows again. Treat it as a baseline reset:
    // same shape as first-read (no newLines, cursor pinned to the current length).
    if (last > messages.length) {
      return { alive, gated: false, cursor: messages.length, newLines: [], humanActive: false };
    }
    const fresh = messages.slice(last);
    return { alive, gated: false, cursor: messages.length, newLines: fresh.map((x) => x.text), humanActive: detectHumanActivity(fresh) };
  } catch {
    // transient (remote hop, fs): grace — alive, nothing new (mirrors handleSessionStatus's cloud grace)
    return { alive: true, gated: false, cursor: m.control.lastOutputCursor ?? 0, newLines: [], humanActive: false };
  }
}
function detectTransportSafe(sid: string): 'cloud' | 'native' {
  const { detectTransport } = require('./mission-onboard') as typeof import('./mission-onboard');
  return detectTransport(sid);
}

/** Real deps for `readOnboardedSignal` — local native read/verdict + cross-node via the peer proxy. */
function defaultOnboardedReadDeps(): OnboardedReadDeps {
  return {
    selfNode: () => thisNode(),
    // I3: `driveable` must reflect PROCESS liveness (`v.live`), not tmux membership
    // (`v.inTmux`). A user's plain-terminal session (never launched in tmux, e.g. a
    // bare `claude` in an SSH shell) is `live:true, inTmux:false` — using `inTmux`
    // here falsely reported it as not-driveable/dead, which would have surfaced a
    // spurious "session ended" signal for a perfectly healthy onboarded session.
    verdict: (sid) => { const v = sessionVerdict(sid); return { driveable: v.live }; },
    readLocalConversation: async (sid) => {
      const store = new AgentSessionStore({ projectPath: process.cwd(), persist: false });
      const res = await store.getConversation({ sessionId: sid });
      return { messages: (res?.messages ?? []).map((msg: any) => ({ role: msg.role, text: msg.content })) };
    },
    proxyRead: async (node, sid) => {
      const { proxyPost } = require('../data/peer-client') as typeof import('../data/peer-client');
      const r = (await proxyPost(node, `/mission/session/${encodeURIComponent(sid)}/read`, {})) as any;
      const data = r?.data ?? r;
      return { messages: (data?.messages ?? []).map((x: any) => ({ role: x.role, text: x.text })) };
    },
    proxyStatus: async (node, sid) => {
      const { proxyPost } = require('../data/peer-client') as typeof import('../data/peer-client');
      const r = (await proxyPost(node, `/mission/session/${encodeURIComponent(sid)}/status`, {})) as any;
      const data = r?.data ?? r;
      return { alive: data?.alive !== false };
    },
  };
}

/** Seeded once into the controller workspace — standing, human-editable context the
 *  controller session picks up natively (CLAUDE.md) on every launch from that folder. */
export const CONTROLLER_WORKSPACE_CLAUDE_MD = `# Mission Control workspace

This folder is the dedicated home project of this node's lm-assist **Mission Controller**
session — nothing else runs here. It exists so controller sessions never launch inside the
npm install directory: repo work belongs to executors in their own project worktrees.

- Operating rules arrive via the launch system prompt and the \`mission-workflows\` process
  registry (start at \`process.overview\` / \`controller.pass\`).
- Spawn NATIVE executors with \`mission_spawn\` — the sanctioned path that names the worker
  session after its mission and records the binding. Never hand-roll \`tmux new-session\`
  (hand-spawned workers lose their name). Cloud executors: \`ccr_cloud_start\` with
  \`title: "Mission: <title> · <shortid>"\`.
- Cross-pass scratch files may live here; keep them small and dated.

## Response contract (every command)

Commands reach you wrapped with a \`⟦CMD cmd-…⟧\` id. ALWAYS end your reply with the
matching \`⟦RESULT cmd-…⟧\` line followed by ONE line per assigned task:
\`- <task>: done|in-progress|blocked|skipped — <verifiable evidence: mission id+rev,
session id, commit, file, count>\`. The supervisor parses this block to pair every
command with a verified result — a missing block is journaled as an unacknowledged
command and re-flagged. No tasks assigned → \`- no-op: acknowledged\`. Evidence must be
checkable (ids and numbers), never adjectives.

## Durable identity & tractability

You are a durable identity: restarts, teardowns and failovers RESUME this same session
from the tracked lineage — never re-establish context after a relaunch; continue where
the transcript leaves off. The trace files live HERE:

- \`controller-history.jsonl\` — which session is the controller and how it got there
  (launched / resumed / adopted / teardown).
- \`control-journal.jsonl\` — every supervisor decision with inputs, every drive with its
  outcome, and your ⟦RESULT⟧ acks (or their absence).

Both feed the control loop's self-recovery (drive-failure relaunch, churn back-off,
resume-first) and the Missions page **Trace** panel the human watches.
`;

/** Dedicated home-project folder for controller sessions (~/.lm-assist/mission-control).
 *  Keeps the controller OUT of process.cwd() — on a prod npm install that was the package
 *  dir itself, so controller transcripts landed in the .../node_modules/... project bucket.
 *  Exported + base-dir-injectable for tests. */
export function ensureControllerWorkspace(baseDir?: string): string {
  const fsmod = require('fs') as typeof import('fs');
  const { getDataDir } = require('../utils/path-utils') as typeof import('../utils/path-utils');
  const dir = path.join(baseDir || getDataDir(), 'mission-control');
  fsmod.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const claudeMd = path.join(dir, 'CLAUDE.md');
  if (!fsmod.existsSync(claudeMd)) fsmod.writeFileSync(claudeMd, CONTROLLER_WORKSPACE_CLAUDE_MD, { mode: 0o644 });
  return dir;
}

export function controllerCwd(): string {
  const s = getProjectSettings();
  const override = (s as any).missionControllerRepo;
  if (override) return override;
  // Default: the dedicated workspace. process.cwd() only as a last-resort fallback
  // (workspace creation failing must never stop a controller launch).
  try { return ensureControllerWorkspace(); } catch { return process.cwd(); }
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
/**
 * Pure: the session's OWN declared bridge sid. The claude CLI writes a
 * `bridge_status` system line into its transcript ("/remote-control is
 * active · … at https://claude.ai/code/<sid>") — authoritative per-session,
 * needs no launch-time baseline, so it works for resumed/adopted controllers
 * whose bridge registered after the launch poll gave up.
 */
export function extractBridgeSid(jsonlTailLines: string[]): string | null {
  for (let i = jsonlTailLines.length - 1; i >= 0; i--) {
    const l = jsonlTailLines[i];
    if (!l.includes('bridge_status') && !l.includes('/remote-control is active')) continue;
    const m = l.match(/https:\/\/claude\.ai\/code\/((?:session_|cse_)[A-Za-z0-9]+)/);
    if (m) return m[1];
  }
  return null;
}

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
    // Reentrancy lock: a launch takes ~40s (cse poll) while the lifecycle tick fires every ~1min —
    // an overlapping tick raced the in-flight launch and produced a DUPLICATE controller (observed
    // live, twice). One tick at a time; overlaps skip cleanly.
    if (missionTickInFlight) {
      return { result: 'previous supervisor tick still in flight — skipped', status: 'skipped' };
    }
    missionTickInFlight = true;
    try {

    const realDeps: SupervisorDeps = {
      amMonitor: () =>
        amIMonitor().then((mon) => ({
          isMonitor: mon.isMonitor,
          monitorNodeId: mon.monitorNodeId,
          indeterminate: mon.indeterminate,
          stale: mon.stale,
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
      readSignal: async (m) => {
        if (m.origin === 'onboarded') {
          const s = await readOnboardedSignal(m, defaultOnboardedReadDeps());
          if (s.humanActive) {
            // A human message is MATERIAL for the engagement classifier: inject a synthetic
            // status-marker line so classifyExecutorActivity fires without changing its API.
            return { ...s, newLines: ['⟦WORKER-STATUS⟧ human-activity', ...s.newLines] };
          }
          return s;
        }
        return readExecutorSignal(m);
      },
      // I2 — persist an onboarded mission's advanced control.lastOutputCursor. putMission does
      // not version control-field changes (TRACKED_FIELDS excludes `control`), so this is a
      // cheap, history-clean write.
      persistMissionControl: async (m) => {
        const { putMission: pm } = require('./mission-store') as typeof import('./mission-store');
        await pm(m);
      },
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
      // Roster-change trigger — the stable key of this node's in-cluster membership.
      // A change vs the persisted lastRosterKey force-engages the controller to re-scope.
      rosterKey: async () => computeRosterKey(await getClusterRecords(), getMyCluster()),
      // Cluster records + identity — on a roster change, evaluateEngagement uses these to
      // compute the orphaned-worker migration list (the exact sessions whose node left the
      // cluster) so the roster-changed directive can tell the controller which to migrate.
      listClusterRecords: getClusterRecords,
      myCluster: getMyCluster,
      selfId: thisNode,
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
          // Local-first MCP: the controller's tools must execute on THIS node so mission
          // ops leader-anchor within THIS cluster (the hub keystone routes by account and
          // can land on another cluster's node). Port per the core detection pattern.
          let localMcp: { url: string; token: string } | null = null;
          try {
            const { localApiToken } = require('../auth/api-token') as typeof import('../auth/api-token');
            const token = localApiToken();
            const port = process.env.API_PORT || (__dirname.includes('node_modules') ? '3100' : '3200');
            if (token) localMcp = { url: `http://127.0.0.1:${port}/mcp`, token };
          } catch { /* no local token — hub keystone fallback below */ }
          extras = buildControllerLaunchExtras({ hubUrl: hub.hubUrl || null, apiKey: hub.apiKey || null, writeFile, localMcp });
        } catch (e) {
          console.debug(`[mission-supervisor] controller bootstrap extras failed: ${(e as Error).message}`);
        }
        // Capture cloud baseline BEFORE launching so we can detect the new cse afterward.
        const baselineArr = await cloudListAccount().then((ss) => ss.map((s2) => s2.sid)).catch(() => [] as string[]);
        const controllerName = `Mission Controller · ${getHubConfig().hostname} · ${getMyCluster()}`;
        // Resume-first: the controller is a DURABLE IDENTITY. Consult the tracked
        // lineage (controller-history.jsonl in the workspace) and resume the most
        // recent usable controller session — full transcript + context preserved
        // across reboot/restart/teardown. Fresh session only without usable history.
        let resumeSid: string | null = null;
        try {
          const { latestResumableController } = require('./controller-history') as typeof import('./controller-history');
          const { sessionVerdict } = require('../terminal/cc-sessions') as typeof import('../terminal/cc-sessions');
          resumeSid = latestResumableController(cwd, (sid) => sessionVerdict(sid));
        } catch { /* lineage unavailable — fresh launch */ }
        const launched = await tmuxCcController.launch({
          cwd, remoteControl: true, skipPermissions: true, autoTrust: true,
          appendSystemPromptFile: extras.appendSystemPromptFile,
          mcpConfigPath: extras.mcpConfigPath,
          name: controllerName,
          ...(resumeSid ? { resume: resumeSid } : {}),
        });
        const sessionId = ((launched.sessionId as string | null) ?? '') || (resumeSid ?? '');
        const tmux = (launched.tmuxSession as string) ?? '';
        try {
          const { recordControllerEvent } = require('./controller-history') as typeof import('./controller-history');
          if (resumeSid && !sessionId) {
            recordControllerEvent(cwd, { at: Date.now(), event: 'resume-failed', sessionId: resumeSid, reason: 'no live session after resume launch' });
          } else if (sessionId) {
            recordControllerEvent(cwd, { at: Date.now(), event: resumeSid ? 'resumed' : 'launched', sessionId, tmux, node: thisNode() });
            const { recordControl } = require('./control-journal') as typeof import('./control-journal');
            recordControl(cwd, { at: Date.now(), kind: 'lifecycle', event: resumeSid ? 'resumed' : 'launched', sessionId, tmux });
          }
        } catch { /* advisory */ }
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
        try {
          const { seedDefaultWorkflows } = require('./workflow-store') as typeof import('./workflow-store');
          const n = await seedDefaultWorkflows();
          if (n > 0) console.log(`[mission-controller] seeded ${n} default workflow docs`);
        } catch { /* best-effort — defaults render as fallback anyway */ }
        return cs;
      },
      passDirective: async () => {
        const { renderWorkflow } = require('./workflow-store') as typeof import('./workflow-store');
        return renderWorkflow('controller.pass');
      },
      journal: (entry) => {
        try {
          const { recordControl } = require('./control-journal') as typeof import('./control-journal');
          recordControl(controllerCwd(), entry);
        } catch { /* advisory */ }
      },
      recentJournal: () => {
        try {
          const { readControlJournal } = require('./control-journal') as typeof import('./control-journal');
          return readControlJournal(controllerCwd(), 80);
        } catch { return []; }
      },
      drive: async (cs, directive) => {
        // Every command carries the response CONTRACT: a cmd id + the
        // instruction to end the reply with a per-task verifiable ⟦RESULT⟧
        // block. The tick's ack scan pairs it back up.
        const cmdId = newCmdId();
        const text = wrapControllerCommand(directive ?? CONTROLLER_PASS_DIRECTIVE, cmdId);
        const sid = cs.cse || cs.sessionId;
        const journalDrive = (transport: string, ok: boolean, error?: string) => {
          try {
            const { recordControl } = require('./control-journal') as typeof import('./control-journal');
            recordControl(controllerCwd(), { at: Date.now(), kind: 'drive', sid, transport, ok, cmdId, directive: (directive ?? CONTROLLER_PASS_DIRECTIVE).slice(0, 80), ...(error ? { error: error.slice(0, 200) } : {}) });
          } catch { /* advisory */ }
        };
        if (cs.cse) {
          await cloudDrive({ sid, text }).then(() => journalDrive('cloud', true)).catch((e: Error) => {
            console.debug(`[mission-supervisor] drive to ${sid} failed: ${e.message}`);
            journalDrive('cloud', false, e.message);
          });
        } else {
          await getCcController().prompt(cs.sessionId, text).then(() => journalDrive('tmux', true)).catch((e: Error) => {
            console.debug(`[mission-supervisor] native drive to ${cs.sessionId} failed: ${e.message}`);
            journalDrive('tmux', false, e.message);
          });
        }
      },
      readControllerTail: async (sessionId) => {
        const { AgentSessionStore } = require('../agent-session-store') as typeof import('../agent-session-store');
        const store = new AgentSessionStore({ projectPath: process.cwd(), persist: false });
        const res = await store.getConversation({ sessionId, lastN: 30 });
        return ((res?.messages ?? []) as Array<{ role?: string; content?: string }>)
          .filter((m) => m.role === 'assistant')
          .map((m) => m.content ?? '')
          .join('\n');
      },
      readBridgeSid: async (sessionId) => {
        const { sessionVerdict } = require('../terminal/cc-sessions') as typeof import('../terminal/cc-sessions');
        const jsonl = sessionVerdict(sessionId).jsonl;
        if (!jsonl) return null;
        const fsmod = require('fs') as typeof import('fs');
        const text = fsmod.readFileSync(jsonl, 'utf-8');
        const lines = text.split('\n');
        return extractBridgeSid(lines.slice(-400));
      },
      onboardedDialogPending: async () => {
        const { listActiveMissions } = require('./mission-store') as typeof import('./mission-store');
        const { probeTuiDialog } = require('../routes/core/mission.routes') as typeof import('../routes/core/mission.routes');
        const self = thisNode();
        const missions = await listActiveMissions().catch(() => []);
        for (const m of missions as Array<{ id: string; origin?: string; manageMode?: string; binding?: { sessionId?: string | null; node?: string | null } | null }>) {
          if (m.origin !== 'onboarded' || m.manageMode !== 'handoff') continue;
          const sid = m.binding?.sessionId;
          if (!sid || !/^[0-9a-f-]{36}$/.test(sid)) continue;
          if (m.binding?.node && m.binding.node !== self) continue;
          if (probeTuiDialog(sid)) return m.id;
        }
        return null;
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
        try {
          const { recordControllerEvent } = require('./controller-history') as typeof import('./controller-history');
          recordControllerEvent(controllerCwd(), { at: Date.now(), event: 'teardown', sessionId: cs.sessionId, tmux: cs.tmux, cse: cs.cse ?? null, node: cs.node, reason: 'not monitor (confident, debounced)' });
          const { recordControl } = require('./control-journal') as typeof import('./control-journal');
          recordControl(controllerCwd(), { at: Date.now(), kind: 'lifecycle', event: 'teardown', sessionId: cs.sessionId, tmux: cs.tmux });
        } catch { /* advisory */ }
      },
      // Restart-adopt (once per Core-process boot) + stray-controller sweep wiring.
      bootAdopt: { done: () => missionBootAdoptDone, mark: () => { missionBootAdoptDone = true; } },
      listTmuxSessions: async () => {
        const { execFile } = require('child_process') as typeof import('child_process');
        return new Promise<string[]>((resolve) => {
          execFile('tmux', ['list-sessions', '-F', '#{session_name}'], { timeout: 5000 }, (err, stdout) => {
            resolve(err ? [] : String(stdout).split('\n').map((x) => x.trim()).filter(Boolean));
          });
        });
      },
      killStrayTmux: async (name) => {
        const backend = require('../terminal/tmux-backend') as typeof import('../terminal/tmux-backend');
        await backend.tmuxTerminalBackend.close(name);
        console.log(`[mission-supervisor] swept stray controller tmux ${name}`);
      },
      controllerContextPct: async (cs) => {
        if (!cs.tmux) return null;
        try {
          const { parseContextPct } = require('../terminal/inspector') as typeof import('../terminal/inspector');
          const tmux = require('../terminal/tmux') as typeof import('../terminal/tmux');
          return parseContextPct(tmux.capture(cs.tmux, { paneQualifier: null, lines: null, start: null }));
        } catch { return null; }
      },
      compactController: async (cs) => {
        if (!cs.tmux) return false;
        try {
          const cc = require('../terminal/cc') as typeof import('../terminal/cc');
          await cc.slash(cs.tmux, { cmd: 'compact', args: null }); // cc.slash asserts idle → throws if the controller is busy
          console.log(`[mission-supervisor] controller ctx high → /compact ${cs.tmux}`);
          return true;
        } catch (e) {
          console.debug(`[mission-supervisor] /compact skipped (busy?): ${(e as Error).message}`);
          return false;
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
    } finally {
      missionTickInFlight = false;
    }
  });
}

// ── Restart-adopt / tick-lock process state (module-level; reset naturally on process boot) ──
let missionTickInFlight = false;
let missionBootAdoptDone = false;
