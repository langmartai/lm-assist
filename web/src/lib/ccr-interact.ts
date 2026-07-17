/**
 * Pure helpers for the CCR page's session interaction (drive / answer / control /
 * resume through the /mission/session/:sid/* stack). Unit-tested in
 * __tests__/ccr-interact.test.ts.
 */

// ── Error envelopes ─────────────────────────────────────────────────────────

export interface EnvelopeError {
  /** Machine code from the mission envelope, e.g. STANDBY_MODE / ONBOARDED_PROTECTED. */
  code?: string;
  message: string;
}

/**
 * fetchJson throws `API 400: {"success":false,"error":{code,message}}` on a mission
 * fail() envelope — recover the code+message so the UI can react to the onboarded
 * rails (standby rejection, stop force-gate) instead of showing raw JSON.
 */
export function parseEnvelopeError(e: unknown): EnvelopeError {
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j?.error?.code || j?.error?.message) {
        return { code: j.error.code, message: j.error.message || raw };
      }
    } catch { /* not json — fall through to raw */ }
  }
  return { message: raw };
}

// ── Session state ───────────────────────────────────────────────────────────

export type CcrSessionState = 'checking' | 'live' | 'idle' | 'resuming' | 'gone' | 'conflict' | 'needs-force';

export type SessionTransport = 'cloud' | 'native';

/**
 * Map a GET /mission/session/:sid/status result → UI state. Accepts the enveloped
 * ({data:{transport,alive}}) and unwrapped shapes. A garbage/failed check assumes
 * live (missions-page behavior) so a status hiccup never locks the controls.
 */
export function deriveStateFromStatus(res: unknown): { transport: SessionTransport | null; state: 'live' | 'idle' } {
  const d = (res as { data?: unknown })?.data ?? res;
  const transport = (d as { transport?: unknown })?.transport;
  const alive = (d as { alive?: unknown })?.alive;
  const t: SessionTransport | null = transport === 'cloud' || transport === 'native' ? transport : null;
  if (typeof alive === 'boolean') return { transport: t, state: alive ? 'live' : 'idle' };
  return { transport: t, state: 'live' };
}

/**
 * Map a POST /mission/session/:sid/resume result (ResumeResult) → UI state + notice.
 * Reasons mirror mission-resume.ts: ok/alive/status-unknown are live; gone/conflict/
 * needs-force each get a distinct state so the controls can react (e.g. force retry).
 */
export function deriveStateFromResume(res: unknown): { state: CcrSessionState; notice: string | null } {
  const d = ((res as { data?: unknown })?.data ?? res) as
    | { resumed?: boolean; reason?: string; autoCloseAt?: number }
    | null
    | undefined;
  const reason = d?.reason;
  if (reason === 'conflict') return { state: 'conflict', notice: "This session is live elsewhere and can't be safely resumed." };
  if (reason === 'needs-force') return { state: 'needs-force', notice: 'Session is live but unreachable/busy — Force resume kills and relaunches it.' };
  if (reason === 'gone') return { state: 'gone', notice: 'Session ended — cannot resume.' };
  if (d?.resumed) {
    if (reason === 'alive' || reason === 'status-unknown') return { state: 'live', notice: null };
    return {
      state: 'live',
      notice: d.autoCloseAt ? 'Session resumed — auto-closes after idle timeout.' : 'Session resumed.',
    };
  }
  return { state: 'gone', notice: 'Session ended — cannot resume.' };
}

// ── Mission lookup ──────────────────────────────────────────────────────────

/** The slice of a Mission the CCR page needs to resolve a sid's binding. */
export interface MissionLite {
  id: string;
  status?: string;
  origin?: string;
  manageMode?: string;
  binding?: {
    sessionId?: string | null;
    node?: string | null;
    ccr?: { sid?: string | null } | null;
  } | null;
}

/**
 * Find the mission bound to a sid (binding.sessionId or binding.ccr.sid).
 * done/failed missions are stale bindings — never matched. Used to pass
 * missionId on resume (worktree relaunch) and to name the onboarded mission
 * in rail errors.
 */
export function findMissionForSid(missions: MissionLite[], sid: string): MissionLite | null {
  if (!Array.isArray(missions) || !sid) return null;
  for (const m of missions) {
    if (!m || m.status === 'done' || m.status === 'failed') continue;
    const b = m.binding;
    if (!b) continue;
    if (b.sessionId === sid || b.ccr?.sid === sid) return m;
  }
  return null;
}

// ── Human-readable session-mode explanation ─────────────────────────────────

export interface SessionModeInput {
  kind: 'cloud' | 'remote' | 'local';
  state: CcrSessionState;
  transport: SessionTransport | null;
  /** an active CCR bridge on a local session, if any. */
  bridgeMode?: 'load' | 'mirror' | 'connected' | null;
  /** mission-onboarded with manageMode=standby (mission control hands-off). */
  standby?: boolean;
  /** friendly hostname of the session's node (multi-node fleets). */
  nodeName?: string | null;
}

/**
 * One plain-language line explaining what THIS session's current mode means
 * and what the user can do with it — shown under the state pill so "live/
 * idle/conflict" is never just a word.
 */
export function describeSessionMode(i: SessionModeInput): string {
  const where = i.nodeName ? `on ${i.nodeName}` : 'on this machine';
  const bridge =
    i.bridgeMode === 'load' ? ' A read-only replay of it exists on claude.ai/code.'
    : i.bridgeMode === 'mirror' ? ' Its live output is mirrored (read-only) to claude.ai/code.'
    : i.bridgeMode === 'connected' ? ' It is two-way connected to claude.ai/code — the Claude apps can drive it too.'
    : '';
  const standby = i.standby ? ' Mission-onboarded in standby: mission control stays hands-off; your own input is always allowed.' : '';

  switch (i.state) {
    case 'checking':
      return 'Checking how this session can be reached…';
    case 'conflict':
      return 'Another live process owns this session — input from here is blocked to protect its transcript. Use Load or Mirror for a safe view.';
    case 'gone':
      return `The session process has ended — the transcript stays readable here.${bridge}`;
    case 'resuming':
      return 'Relaunching the session — it will accept input as soon as it is live.';
    case 'needs-force':
      return 'The session is live but unresponsive — Force resume kills and relaunches it in place.';
    case 'idle':
      if (i.kind === 'cloud') return `The cloud worker is idle. Typing wakes it and delivers your message; Resume re-drives it with bootstrap.${standby}`;
      return `Not running right now. Messages you type are queued and delivered on its next turn — or press Resume to relaunch it now.${bridge}${standby}`;
    case 'live':
    default:
      if (i.kind === 'cloud') return `Running in Anthropic's cloud. Typing drives it live; Interrupt/Stop control the cloud worker; the Claude app opens the same session.${standby}`;
      if (i.kind === 'remote') return `A local CLI bridged two-way with claude.ai/code (remote control). Typing here or in the Claude app drives the same live session.${standby}`;
      if (i.transport === 'cloud') return `Live via its cloud bridge — typing drives it in real time.${bridge}${standby}`;
      return `Running live in a terminal ${where}. Typing delivers a real user turn to the CLI immediately; Interrupt and Stop are available.${bridge}${standby}`;
  }
}
