/** The super Mission Controller tick: election → per-mission liveness/adjust/placement. */
import {
  Mission, MissionBinding, ExecutorState, ExecutorOutput, AdjustResult, PlacementDecision,
  decideMission, place, planMissionNudge,
} from './mission-model';
import { listMissions, putMission } from './mission-store';
import { runAdjust } from './mission-adjust';
import { getProjectSettings } from '../project-settings';
import { amIMonitor } from '../monitor/stall-election';
import { cloudStart, cloudDrive, cloudRead, cloudListAccount } from '../terminal/ccr-cloud';

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

function addAdjustment(m: Mission, now: number, trigger: string, change: string): void {
  m.adjustments.push({ at: now, trigger, change, by: 'controller' });
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

async function readCloudExecutor(m: Mission): Promise<ExecutorState> {
  const sid = m.binding?.sessionId;
  if (!sid) return { alive: false, serverStalled: false, gate: null, newOutput: null, idle: true };
  const account = await cloudListAccount(100).catch(
    () => [] as Array<{ sid: string; status: string }>,
  );
  const live = account.find((a) => a.sid === sid);
  if (!live) return { alive: false, serverStalled: false, gate: null, newOutput: null, idle: true };
  const read = await cloudRead({ sid, lastN: 20 }).catch(
    () => ({ messages: [] as Array<{ text: string }>, pendingQuestion: null as null }),
  );
  const prevCursor = m.control.lastOutputCursor ?? 0;
  const cursor = read.messages.length;
  const lastText = read.messages.length ? read.messages[read.messages.length - 1].text : '';
  const serverStalled = SERVER_STALL.test(lastText);
  const gate = read.pendingQuestion
    ? { taskId: 'cloud', reason: 'pending question / approval' }
    : null;
  const hasNew = cursor > prevCursor;
  const newOutput: ExecutorOutput | null = hasNew
    ? { cursor, messages: read.messages.slice(prevCursor).map((x) => x.text), results: [] }
    : null;
  return { alive: true, serverStalled, gate, newOutput, idle: !hasNew };
}

async function startCloudExecutor(m: Mission, decision: PlacementDecision): Promise<MissionBinding> {
  if (decision.go && decision.env === 'cloud') {
    const res = await cloudStart({
      prompt: `Mission: ${m.title}\n\nObjective:\n${m.objective}`,
      repo: m.env.repo,
      setup: true,
      role: m.binding?.kind === 'orchestrator' ? 'orchestrator' : 'worker',
      title: m.title,
    });
    return {
      sessionId: res.sid,
      node: m.env.host ?? 'cloud',
      kind: m.binding?.kind ?? 'worker',
      boundAt: Date.now(),
    };
  }
  // Native (worktree/shared) auto-start is phase-2 (spec §8).
  // Surface clearly; the per-mission try/catch keeps the mission as-is.
  throw new Error(
    `native executor auto-start not implemented for env=${decision.go ? (decision as any).env : 'n/a'} (assign manually for now)`,
  );
}

async function driveExecutor(m: Mission, directive: string): Promise<void> {
  const sid = m.binding?.sessionId;
  if (!sid) return;
  await cloudDrive({ sid, text: directive });
}

/** Register the scheduled-job handler. Reads live config each run; assembles real deps. */
export function registerMissionController(
  jobs: { registerHandler: (t: string, fn: any) => void },
): void {
  jobs.registerHandler('mission-controller', async (_config: any, _ctx: any) => {
    const s = getProjectSettings();
    if (!s.missionControllerEnabled) {
      return { result: 'mission controller disabled', status: 'skipped' };
    }
    const r = await runMissionTick({
      now: Date.now(),
      cfg: {
        intervalMin: s.missionControllerIntervalMin,
        maxNudges: s.missionControllerMaxNudges,
        model: s.missionControllerModel,
      },
      amMonitor: () =>
        amIMonitor().then((mon) => ({
          isMonitor: mon.isMonitor,
          monitorNodeId: mon.monitorNodeId,
        })),
      listAll: () => listMissions(),
      readExecutor: (m) => readCloudExecutor(m),
      adjust: (m, out) => runAdjust(m, out, s.missionControllerModel),
      startExecutor: (m, dec) => startCloudExecutor(m, dec),
      drive: (m, directive) => driveExecutor(m, directive),
      save: (m) => putMission(m).then(() => undefined),
    });
    if (r.skipped) return { result: 'not the mission controller (skipped)', status: 'skipped' };
    return { result: `acted=${r.acted.length} missions`, status: 'ok' };
  });
}
