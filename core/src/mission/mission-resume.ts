// Resume a mission's bound worker session IN PLACE (same session, preserved context).
// Pure decision functions here; the I/O orchestrator (resumeWorker) is added in Task 2.

/** Terminal cloud session statuses (mirrors mission-controller.ts / mission.routes.ts). */
export const TERMINAL_CLOUD_STATUSES = ['stopped', 'completed', 'failed', 'error', 'archived'];

export type ResumeReason = 'ok' | 'alive' | 'gone' | 'conflict' | 'status-unknown' | 'needs-force' | 'kill-failed';

export interface ResumeResult {
  resumed: boolean;
  transport: 'cloud' | 'native';
  sid: string;
  reason: ResumeReason;
  note?: string;
}

/**
 * Decide what to do with a CLOUD worker, from its cloudStatus.
 *  'gone'  — terminal status, unrecoverable (respawn is a separate explicit action).
 *  'noop'  — alive and actively running; nothing to do.
 *  'wake'  — alive but idle/disconnected; re-drive with reBootstrap to continue.
 */
export function decideCloudResume(s: { status: string; workerStatus?: string }): 'noop' | 'wake' | 'gone' {
  if (TERMINAL_CLOUD_STATUSES.includes(s.status)) return 'gone';
  return s.workerStatus === 'running' ? 'noop' : 'wake';
}

/**
 * Decide what to do with a NATIVE worker, from its sessionVerdict.
 *  'attach'  — already live in a tmux; just re-read/attach.
 *  'resume'  — process dead but transcript present + safe → `claude --resume` + re-bridge.
 *  'conflict'— live but not in a tmux; a `--resume` would double-write the jsonl → refuse.
 *  'gone'    — no transcript; unrecoverable.
 */
export function decideNativeResume(v: { connectStrategy: string; safeToCreateTmux: boolean; inTmux: boolean }): 'attach' | 'resume' | 'conflict' | 'gone' {
  if (v.connectStrategy === 'attach-existing' || v.inTmux) return 'attach';
  if (v.connectStrategy === 'create-tmux' && v.safeToCreateTmux) return 'resume';
  if (v.connectStrategy === 'refuse') return 'conflict';
  return 'gone';
}

// ── resumeWorker orchestrator (Task 2) ────────────────────────────────────────

export interface ResumeWorkerDeps {
  /** Resolve transport for a sid (pure). */
  resolve: (sid: string) => { transport: 'cloud' | 'native'; missionId: string | null };
  /** Read cloud session status. */
  cloudStatus: (sid: string) => Promise<{ sid: string; status: string; connectionStatus?: string; raw: any }>;
  /** Wake an idle cloud worker (cloudDrive with reBootstrap). Best-effort. */
  cloudWake: (sid: string) => Promise<void>;
  /** Native liveness/safety verdict (sessionVerdict). */
  nativeVerdict: (sid: string) => { connectStrategy: string; safeToCreateTmux: boolean; inTmux: boolean };
  /** Resume a native worker IN PLACE: `claude --resume <sid>` + re-bridge + re-bind.
   *  MUST return the SAME sid (continuity); only the bridge cse changes. */
  resumeNative: (missionId: string | undefined, sid: string) => Promise<{ sid: string; boundAt: number }>;
  /** Inject-first / kill-gated connect for a LIVE native worker. Provided by the
   *  route layer (wires ensureRemoteControlled). Optional: when absent, resumeWorker
   *  falls back to the legacy attach/conflict verdict mapping. */
  ensureLive?: (sid: string, opts: { force?: boolean; missionId?: string }) => Promise<{ ok: boolean; state: string; sid: string; reason: string }>;
}

/**
 * Resume a mission's bound worker IN PLACE. Resume-only: a terminal/unrecoverable session
 * returns { resumed:false, reason:'gone'|'conflict' } and does NOT spawn a replacement.
 */
export async function resumeWorker(
  sid: string,
  missionId: string | undefined,
  deps: ResumeWorkerDeps,
  opts?: { force?: boolean },
): Promise<ResumeResult> {
  const { transport } = deps.resolve(sid);

  if (transport === 'cloud') {
    let st: { status: string; raw: any };
    try {
      st = await deps.cloudStatus(sid);
    } catch {
      // Transient (429/5xx/network): NOT a confirmed terminal status → grace.
      return { resumed: true, transport: 'cloud', sid, reason: 'status-unknown' };
    }
    const action = decideCloudResume({ status: st.status, workerStatus: st.raw?.worker_status });
    if (action === 'gone') return { resumed: false, transport: 'cloud', sid, reason: 'gone' };
    if (action === 'noop') return { resumed: true, transport: 'cloud', sid, reason: 'alive' };
    try { await deps.cloudWake(sid); } catch { /* best-effort wake */ }
    return { resumed: true, transport: 'cloud', sid, reason: 'ok' };
  }

  // native
  let v: { connectStrategy: string; safeToCreateTmux: boolean; inTmux: boolean };
  try {
    v = deps.nativeVerdict(sid);
  } catch {
    return { resumed: false, transport: 'native', sid, reason: 'gone' };
  }
  const action = decideNativeResume(v);
  if (action === 'gone') return { resumed: false, transport: 'native', sid, reason: 'gone' };
  if (action === 'resume') {
    // dead, transcript present, safe → claude --resume + re-bridge (preserves sid)
    const launched = await deps.resumeNative(missionId, sid);
    return { resumed: true, transport: 'native', sid: launched.sid, reason: 'ok' };
  }
  // action is 'attach' or 'conflict' → a LIVE native worker → inject-first / kill-gated ladder
  if (deps.ensureLive) {
    const e = await deps.ensureLive(sid, { force: opts?.force, missionId });
    return mapEnsureToResume(e, sid);
  }
  // fallback (no ensureLive wired): legacy verdict mapping
  return action === 'attach'
    ? { resumed: true, transport: 'native', sid, reason: 'alive' }
    : { resumed: false, transport: 'native', sid, reason: 'conflict' };
}

/** Map an ensureRemoteControlled result onto the ResumeResult contract. */
function mapEnsureToResume(e: { state: string; sid: string }, sid: string): ResumeResult {
  switch (e.state) {
    case 'connected': return { resumed: true, transport: 'native', sid: e.sid || sid, reason: 'ok' };
    case 'already-connected': return { resumed: true, transport: 'native', sid: e.sid || sid, reason: 'alive' };
    case 'needs-force': return { resumed: false, transport: 'native', sid, reason: 'needs-force' };
    case 'kill-failed': return { resumed: false, transport: 'native', sid, reason: 'kill-failed' };
    case 'gone': return { resumed: false, transport: 'native', sid, reason: 'gone' };
    default: return { resumed: false, transport: 'native', sid, reason: 'status-unknown' };
  }
}
