/**
 * Native remote-control resume — the pure half of the ccr_restart resume path.
 *
 * WHY: `ccr_restart` used to resume a killed session with a bare
 * `claude --resume <sid>` and then spawn `ccr/ccr-bridge.js`, which POSTs a
 * brand-new `/v1/code/sessions` — so every restart MINTED A NEW claude.ai
 * session URL and the operator's existing link (the tab they had open, the
 * mission's recorded cse) went dead. Observed 2026-09 on node 117: three
 * restarted sessions, three lost links.
 *
 * Claude Code has its own `--remote-control` and records the bridge it is
 * connected to in `~/.claude/sessions/<pid>.json` as `bridgeSessionId`
 * (`session_…`, the tail of the claude.ai/code URL). Resuming NATIVELY
 * (`claude --resume <sid> --remote-control`) lets Claude Code reclaim / rebind
 * that bridge itself; we only OBSERVE the id it records and report honestly
 * whether it is the one the session had before (`reclaimed`) or a fresh one.
 *
 * Everything here is pure / deps-injected; the tmux + registry I/O lives in
 * ccr-manager.ts (connectDeadNative).
 */

export const CLAUDE_CODE_URL_BASE = 'https://claude.ai/code/';

/** The `claude` command line that resumes `sid` natively remote-controlled.
 *  `permFlags` is the already-leading-space flag string from resumePermissionFlags. */
export function nativeResumeCommand(sid: string, permFlags: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(sid)) throw new Error(`refusing to build a shell command from session id ${JSON.stringify(sid)}`);
  return `claude --resume ${sid} --remote-control${permFlags || ''}`;
}

/** claude.ai/code URL for a bridge id in either spelling (`session_X` or `cse_X`). */
export function bridgeWebUrl(bridgeSessionId: string | null | undefined): string | null {
  if (!bridgeSessionId) return null;
  const m = bridgeSessionId.match(/^(?:session_|cse_)([A-Za-z0-9]+)$/);
  if (!m) return null;
  return `${CLAUDE_CODE_URL_BASE}session_${m[1]}`;
}

/** Normalise `session_X` / `cse_X` / a full URL to the bare `X` for comparison. */
export function bridgeKey(id: string | null | undefined): string | null {
  if (!id) return null;
  const m = String(id).match(/(?:session_|cse_)([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

export type ReclaimVerdict = 'reclaimed' | 'new-bridge' | 'first-bridge' | 'none';

/** Did the resumed session come back on the bridge it had before? */
export function describeReclaim(previous: string | null | undefined, current: string | null | undefined): ReclaimVerdict {
  const p = bridgeKey(previous);
  const c = bridgeKey(current);
  if (!c) return 'none';
  if (!p) return 'first-bridge';
  return p === c ? 'reclaimed' : 'new-bridge';
}

export interface NativeResumeObservation {
  /** owner pid of the resumed session (live in the registry) */
  pid: number;
  bridgeSessionId: string | null;
}

export interface WaitDeps {
  /** the session registry view: null when `sid` is not live yet */
  lookup: (sid: string) => { pid: number | null; bridgeSessionId?: string | null } | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * Poll the registry until the resumed session is live AND has recorded a bridge
 * id, or the deadline passes. Returns what was observed: a live pid with a null
 * bridge id means the session came up but never connected in time — the caller
 * reports that, it does not invent a URL.
 */
export async function waitForNativeBridge(
  sid: string,
  deps: WaitDeps,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<NativeResumeObservation | null> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const pollMs = opts.pollMs ?? 750;
  const deadline = deps.now() + timeoutMs;
  let last: NativeResumeObservation | null = null;
  for (;;) {
    let v: ReturnType<WaitDeps['lookup']> = null;
    try { v = deps.lookup(sid); } catch { v = null; }
    if (v && v.pid) {
      last = { pid: v.pid, bridgeSessionId: v.bridgeSessionId || null };
      if (last.bridgeSessionId) return last;
    }
    if (deps.now() >= deadline) return last;
    await deps.sleep(pollMs);
  }
}
