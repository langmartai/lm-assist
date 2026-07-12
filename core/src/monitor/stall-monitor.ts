/** The stall-monitor tick: election → local resume (always) → remote resume (monitor only). */
import { planStallAction, StallRecord, StallConfig } from './stall-state';
import { loadStallStore, saveStallStore, localKey, remoteKey } from './stall-store';
import { getProjectSettings } from '../project-settings';
import { amIMonitor } from './stall-election';
import { findLocalStalls } from './stall-detect-local';
import { findRemoteStalls } from './stall-detect-remote';
import { resumeLocal, resumeRemote } from './stall-resume';

export interface TickDeps {
  now: number;
  cfg: StallConfig;
  amMonitor: () => Promise<{ isMonitor: boolean; monitorNodeId: string | null }>;
  findLocal: () => Promise<{ sessionId: string; category: string }[]>;
  resumeLocal: (id: string) => Promise<boolean>;
  findRemote: () => Promise<{ sid: string; category: string }[]>;
  resumeRemote: (sid: string) => Promise<boolean>;
  remoteScan: boolean;
  load: () => Record<string, StallRecord>;
  save: (s: Record<string, StallRecord>) => void;
}

export async function runStallMonitorTick(deps: TickDeps) {
  const store = deps.load();
  const localNudged: string[] = [];
  const remoteNudged: string[] = [];
  const gaveUp: string[] = [];

  const { isMonitor } = await deps.amMonitor();

  // Build the current stall sets. Isolate detector failures: a throw in one
  // branch is treated as an EMPTY set so the tick still runs reset-on-recovery,
  // saves, and the other branch (a hub/cloud blip must not sink local resume).
  let local: { sessionId: string; category: string }[] = [];
  try { local = await deps.findLocal(); } catch { local = []; }
  let remote: { sid: string; category: string }[] = [];
  if (isMonitor && deps.remoteScan) {
    try { remote = await deps.findRemote(); } catch { remote = []; }
  }

  const stalledKeys = new Set<string>([...local.map((s) => localKey(s.sessionId)), ...remote.map((s) => remoteKey(s.sid))]);

  // 1) Any tracked key NOT in the current stall set has recovered → reset it.
  for (const key of Object.keys(store)) {
    if (!stalledKeys.has(key)) {
      const res = planStallAction(store[key], { now: deps.now, stillStalled: false, seenProgress: true, cfg: deps.cfg });
      if (res.action === 'reset') delete store[key];
    }
  }

  // 2) Process each currently-stalled session.
  const act = async (key: string, category: string, resume: () => Promise<boolean>) => {
    const res = planStallAction(store[key], { now: deps.now, stillStalled: true, seenProgress: false, cfg: deps.cfg });
    if (res.action === 'giveup') { store[key] = { ...res.next!, category }; gaveUp.push(key); return; }
    if (res.action === 'nudge') {
      const ok = await resume();
      // Persist regardless (so we back off even if a single send didn't land); stamp the fresh category.
      store[key] = { ...res.next!, category };
      return ok;
    }
    if (res.next) store[key] = { ...res.next, category }; // wait — keep/refresh
    return false;
  };

  for (const s of local) {
    const ok = await act(localKey(s.sessionId), s.category, () => deps.resumeLocal(s.sessionId));
    if (ok) localNudged.push(s.sessionId);
  }
  for (const s of remote) {
    const ok = await act(remoteKey(s.sid), s.category, () => deps.resumeRemote(s.sid));
    if (ok) remoteNudged.push(s.sid);
  }

  deps.save(store);
  return { localNudged, remoteNudged, gaveUp, isMonitor };
}

/** Register the scheduled-job handler. Reads live config each run; assembles real deps. */
export function registerStallMonitor(jobs: { registerHandler: (t: string, fn: any) => void }): void {
  jobs.registerHandler('stall-monitor', async (_config: any, _ctx: any) => {
    const s = getProjectSettings();
    if (!s.autoResumeStalledEnabled) return { result: 'auto-resume disabled', status: 'skipped' };
    const r = await runStallMonitorTick({
      now: Date.now(),
      cfg: {
        intervalMin: s.autoResumeIntervalMin,
        maxAttempts: s.autoResumeMaxAttempts,
        maxIntervalMin: s.autoResumeMaxIntervalMin,
        neverGiveUp: s.autoResumeNeverGiveUp,
      },
      amMonitor: () => amIMonitor().then((m) => ({ isMonitor: m.isMonitor, monitorNodeId: m.monitorNodeId })),
      findLocal: () => findLocalStalls(),
      resumeLocal: (id) => resumeLocal(id),
      findRemote: () => findRemoteStalls(),
      resumeRemote: (sid) => resumeRemote(sid),
      remoteScan: s.autoResumeRemoteScan,
      load: loadStallStore,
      save: saveStallStore,
    });
    return { result: `monitor=${r.isMonitor} localNudged=${r.localNudged.length} remoteNudged=${r.remoteNudged.length} gaveUp=${r.gaveUp.length}`, status: 'ok' };
  });
}
