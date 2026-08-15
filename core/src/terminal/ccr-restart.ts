/**
 * CCR restart — recycle a LOCAL Claude Code session's process so it re-fetches
 * its MCP tool list (Claude Code loads MCP tools at process START only; there is
 * no in-place reload for a running session).
 *
 * SAFETY CONTRACT (the whole point of this module — two processes resuming the
 * same session storage corrupt it):
 *   1. STOP any existing CCR bridge remotes for the session first.
 *   2. KILL the live owner process (SIGTERM → poll-verify → SIGKILL → poll-verify).
 *   3. VERIFY DEAD twice: killOwner's own waitDead AND a fresh sessionVerdict —
 *      if ANYTHING still owns the session, ABORT (state 'kill-failed'). We never
 *      resume over a live process.
 *   4. Only then spawn the fresh `claude --resume` (which re-fetches MCP tools).
 *
 * A BUSY session (mid-turn) is refused without force:true — killing a session
 * mid-write is the other corruption vector. Idle sessions restart without force.
 *
 * RETURN THE SCREEN, DO NOT CLASSIFY IT (design 2026-08-15, after a prod incident
 * on 117). Every result that has a reachable pane carries `screen` — the same bytes
 * `terminal_capture` would give — so the CALLER reads what the session is actually
 * showing and decides. Two things this replaces:
 *   - "restarted ok" that was in fact parked on a blocking modal (resume-from-summary,
 *     a new CLI version's first-run permission prompt) — invisible in the old result;
 *   - a frozen modal read as actively-busy, which sat in a 120s wait until the MCP
 *     connector timed out first and the caller reasonably suspected a dead node.
 * We deliberately do NOT ship a modal signature table: signatures rot one CLI release
 * at a time and their failure mode is silent misclassification. The screen is the
 * source of truth; `screenStable` says whether it stopped changing, which is the one
 * observation (not classification) worth making. Auto-dismiss stays OUT of this tool —
 * judging WHICH modal is safe to answer belongs to the caller (`terminal_send`, ONE
 * key per call), not to a restart primitive.
 *
 * Deps-injected (mirrors live-rc-connect's EnsureDeps style) so the orchestration
 * is unit-testable without tmux/processes.
 */

import { killEligibility, idleMs } from './live-rc-connect';

export type RestartState =
  | 'restarted'        // old process gone (or was already dead), fresh resume live
  | 'needs-force'      // live and actively busy — refuse without force:true
  | 'kill-failed'      // owner did not terminate / something still owns the session — ABORTED
  | 'gone'             // no transcript and no live process on this host
  | 'error';

export interface RestartResult {
  ok: boolean;
  state: RestartState;
  sid: string;
  /** what the old owner was, when there was one */
  oldPid?: number | null;
  wasLive?: boolean;
  killMethod?: string;
  /** how long we waited for the in-flight turn to finish (wait-for-idle path) */
  waitedMs?: number;
  /** the fresh resume's record (webUrl/tmux), present on ok */
  record?: unknown;
  /** true when the refusal is "it read as actively busy" — pair it with `screen`:
   *  a FROZEN modal reads identically to a running turn, and only the pane tells
   *  them apart. */
  busy?: boolean;
  /** the pane the screen was read from — hand it straight to terminal_capture /
   *  terminal_send to act on what you see. */
  tmuxSession?: string | null;
  /** what the session is showing, verbatim (bounded, tail-kept). Absent when there
   *  is no reachable pane (headless owner, tmux gone). */
  screen?: string;
  /** whether the screen was on the OLD process (refusal / kill-failed) or the FRESH
   *  one (restarted). */
  screenSource?: 'pre-restart' | 'post-restart';
  /** the pane held still long enough to be trusted. false = still repainting, which
   *  is itself evidence of real work; true on a busy-refusal is evidence of a FREEZE.
   *  false post-restart means the settle window expired while it was still changing —
   *  re-read it with terminal_capture rather than acting on this snapshot. */
  screenStable?: boolean;
  /** how long we watched the pane before returning it (settle + observation). */
  screenWatchedMs?: number;
  /** the pane was longer than the byte budget and the TAIL was kept. */
  screenTruncated?: boolean;
  reason: string;
}

export interface RestartDeps {
  now: () => number;
  verdict: (sid: string) => {
    live: boolean; connectStrategy: string; pid: number | null;
    tmuxSession: string | null; updatedAt: string | undefined;
  };
  /** Real TUI activity: 'idle' = at the prompt (safe to recycle NOW, whatever the
   *  transcript age); 'busy' = actively mid-turn; 'unknown' = can't tell (headless /
   *  non-tmux) → the conservative transcript-age gate applies instead. */
  phase?: (sid: string) => 'idle' | 'busy' | 'unknown';
  sleep?: (ms: number) => Promise<void>;
  /** Stop existing CCR bridge remotes registered for this session (best-effort). */
  stopExistingRemotes: (sid: string) => Promise<number>;
  /** Kill + VERIFY-DEAD the owner pid. Must not resolve killed:true unless the process is gone. */
  killOwner: (pid: number) => Promise<{ killed: boolean; wasAlive: boolean; method: string }>;
  /** Kill a stale ccr-<sid8> tmux left from a previous connect (best-effort). */
  killStaleCcrTmux: (sid: string) => Promise<void>;
  /** Spawn the fresh `claude --resume` bridge — ONLY called after verified-dead. */
  resume: (sid: string) => Promise<unknown>;
  /** Read the visible pane for the session. `tmuxSession` is a hint (the fresh
   *  resume's own pane, which the verdict may not have caught up to yet); without
   *  it, resolve the pane from the session. null = no reachable pane — say nothing
   *  rather than guess. */
  captureScreen?: (sid: string, tmuxSession?: string | null) => { tmuxSession: string; screen: string } | null;
}

const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;
/** Default: do NOT wait. A session that reads busy returns IMMEDIATELY with its screen
 *  attached so the caller can tell a frozen modal from a running turn. The old 120s
 *  default outlived the MCP connector's own timeout, so the caller got an opaque
 *  "connector isn't responding" instead of any information (measured 117, 2026-08-15:
 *  two blind retries, ~4 min, zero information gained, node healthy throughout).
 *  Waiting for genuine in-flight work is still available — pass wait_ms explicitly. */
const DEFAULT_WAIT_MS = 0;
const WAIT_POLL_MS = 2_000;

/** Screen budget. ~1–5KB is a normal pane; the cap is a guardrail, not a target, and
 *  the TAIL is what matters (modals and the prompt render at the bottom). */
const SCREEN_MAX_BYTES = 8_192;
const SCREEN_POLL_MS = 750;
/** THE WAIT LIVES HERE — after the restart completes, not before it.
 *  A freshly resumed TUI is still painting: it clears, redraws, loads the transcript,
 *  and only then opens its resume/first-run dialogs. Two identical captures 750ms
 *  apart can lock in a half-painted screen that changes a second later, so post-restart
 *  we SETTLE first (a fixed delay before the first capture) and then require the pane
 *  to hold still for a MINIMUM observation window before calling it stable.
 *  A pre-restart refusal is the opposite case — it must stay FAST, so it gets neither. */
const SCREEN_SETTLE_MS = 1_500;
const SCREEN_MIN_OBSERVE_MS = 3_000;
const SCREEN_POLLS_POST = 12;   // ≈1.5s settle + up to ~8s watching
const SCREEN_POLLS_PRE = 3;

/** Keep the last SCREEN_MAX_BYTES bytes, on a line boundary. */
function boundScreen(screen: string): { screen: string; truncated: boolean } {
  const trimmed = screen.replace(/\s+$/, '');
  if (Buffer.byteLength(trimmed, 'utf8') <= SCREEN_MAX_BYTES) return { screen: trimmed, truncated: false };
  const rows = trimmed.split('\n');
  const kept: string[] = [];
  let bytes = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const b = Buffer.byteLength(rows[i], 'utf8') + 1;
    if (bytes + b > SCREEN_MAX_BYTES) break;
    kept.unshift(rows[i]);
    bytes += b;
  }
  return { screen: kept.join('\n'), truncated: true };
}

/**
 * Observe the pane until it STOPS CHANGING, bounded.
 *
 * A single-shot capture reads the TUI mid-paint; that timing discipline is the one
 * piece of machinery worth keeping from the classifier design we rejected. Post-restart
 * (`settle`) it is stricter: sleep first so the fresh TUI can paint, then keep watching
 * for at least SCREEN_MIN_OBSERVE_MS even once two captures match — a screen that has
 * held still for 750ms is not yet evidence it has finished, and reporting a
 * half-painted pane as `screenStable` is exactly the confident-and-wrong answer this
 * whole design exists to avoid. Any change restarts the clock.
 *
 * Never throws — a screen we could not read must not fail a restart.
 */
async function observeScreen(
  sid: string,
  tmuxHint: string | null,
  maxPolls: number,
  deps: RestartDeps,
  sleep: (ms: number) => Promise<void>,
  settle = false,
): Promise<Pick<RestartResult, 'tmuxSession' | 'screen' | 'screenStable' | 'screenTruncated' | 'screenWatchedMs'> | null> {
  const capture = deps.captureScreen;
  if (!capture) return null;
  const startedAt = deps.now();
  const minHoldMs = settle ? SCREEN_MIN_OBSERVE_MS : 0;
  if (settle) await sleep(SCREEN_SETTLE_MS);

  let prev: string | null = null;
  let name: string | null = null;
  let heldSince: number | null = null;   // when the CURRENT pane content first appeared
  let stable = false;
  for (let i = 0; i < maxPolls; i++) {
    let cur: { tmuxSession: string; screen: string } | null = null;
    try { cur = capture(sid, tmuxHint); } catch { cur = null; }
    if (cur) {
      name = cur.tmuxSession;
      if (prev !== null && cur.screen === prev) {
        // Held since `heldSince`. Only call it stable once it has held long enough.
        if (heldSince !== null && deps.now() - heldSince >= minHoldMs) { stable = true; break; }
      } else {
        prev = cur.screen;
        heldSince = deps.now();          // it changed — the hold clock restarts
      }
    }
    if (i < maxPolls - 1) await sleep(SCREEN_POLL_MS);
  }
  if (prev === null || name === null) return null;
  const { screen, truncated } = boundScreen(prev);
  return {
    tmuxSession: name, screen, screenStable: stable, screenTruncated: truncated,
    screenWatchedMs: Math.max(0, deps.now() - startedAt),
  };
}

/** Is the session ACTUALLY working right now? Prefer the real TUI phase; fall back
 *  to the transcript-age gate when the phase is unknowable. */
function isActivelyBusy(
  v: { updatedAt: string | undefined },
  phase: 'idle' | 'busy' | 'unknown',
  now: number,
  idleThresholdMs: number,
): boolean {
  if (phase === 'idle') return false;   // at the prompt — safe now, whatever updatedAt says
  if (phase === 'busy') return true;    // genuinely mid-turn
  return killEligibility({ idleMs: idleMs(v.updatedAt, now), idleThresholdMs, force: false }) === 'needs-force';
}

export async function restartLocal(
  sid: string,
  opts: { force?: boolean; idleThresholdMs?: number; waitMs?: number },
  deps: RestartDeps,
): Promise<RestartResult> {
  const force = !!opts.force;
  const idleThresholdMs = opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  // How long to WAIT for an in-flight turn to finish before giving up. DEFAULT 0:
  // refuse immediately WITH THE SCREEN so the caller can see whether there is any
  // work in flight at all. Waiting is opt-in (wait_ms), capped at 10 min.
  const waitMs = opts.waitMs === undefined ? DEFAULT_WAIT_MS : Math.max(0, Math.min(opts.waitMs, 600_000));
  const phaseOf = deps.phase ?? (() => 'unknown' as const);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let v: ReturnType<RestartDeps['verdict']>;
  try { v = deps.verdict(sid); }
  catch (e) { return { ok: false, state: 'error', sid, reason: `verdict failed: ${(e as Error).message}` }; }

  if (v.connectStrategy === 'none') {
    return { ok: false, state: 'gone', sid, reason: 'no transcript and no live process on this host' };
  }

  let wasLive = v.live;
  let oldPid = v.pid;
  let waitedMs = 0;

  // BUSY gate BEFORE any destructive step: a session ACTUALLY mid-turn is not
  // killed silently. force:true kills immediately; otherwise WAIT (bounded) for
  // the current work to finish, then proceed. A session idle at its prompt
  // restarts right away — whatever the transcript age.
  if (wasLive && !force) {
    let busy = isActivelyBusy(v, phaseOf(sid), deps.now(), idleThresholdMs);
    if (busy && waitMs === 0) {
      // Return FAST with the pane attached. "Frozen on a modal" and "actively
      // mid-turn" read IDENTICALLY to the detector and are opposite states — only
      // the screen tells them apart, so hand it over instead of waiting.
      const obs = await observeScreen(sid, v.tmuxSession, SCREEN_POLLS_PRE, deps, sleep);
      return {
        ok: false, state: 'needs-force', sid, oldPid, wasLive, busy: true,
        ...(obs ?? {}), screenSource: obs ? 'pre-restart' : undefined,
        reason: obs
          ? 'session reads as actively busy — NOT restarted, nothing was killed. Its screen is in `screen`: if that is a BLOCKING MODAL (model-switch confirm, resume-from-summary, a new CLI version\'s first-run prompt) there is no in-flight turn to lose — answer it with terminal_send (ONE key per call, re-capture between) or call again with force:true. screenStable:true means the pane stopped changing, i.e. frozen. To wait for genuine in-flight work instead, pass wait_ms (e.g. 120000).'
          : 'session reads as actively busy — NOT restarted, nothing was killed. No pane was readable (headless owner or the tmux is gone), so the screen could not be attached — pass force:true to kill immediately, or wait_ms to wait for its current work.',
      };
    }
    const waitStart = deps.now();
    while (busy) {
      if (deps.now() - waitStart >= waitMs) {
        const obs = await observeScreen(sid, v.tmuxSession, SCREEN_POLLS_PRE, deps, sleep);
        return {
          ok: false, state: 'needs-force', sid, oldPid, wasLive, busy: true, waitedMs: deps.now() - waitStart,
          ...(obs ?? {}), screenSource: obs ? 'pre-restart' : undefined,
          reason: `session still read as busy after the full wait window (${Math.round(waitMs / 1000)}s) — NOT restarted, nothing was killed. Read \`screen\` before waiting longer: a session frozen on a modal reads busy forever, and screenStable:true says the pane is not changing. Answer the modal with terminal_send (ONE key per call) or pass force:true.`,
        };
      }
      await sleep(Math.min(WAIT_POLL_MS, waitMs));
      busy = isActivelyBusy(v, phaseOf(sid), deps.now(), idleThresholdMs);
    }
    waitedMs = deps.now() - waitStart;
    // The wait may have outlived the process (turn ended = session exited, or a
    // user closed it) — refresh the verdict so the kill targets the CURRENT owner.
    if (waitedMs > 0) {
      try { v = deps.verdict(sid); wasLive = v.live; oldPid = v.pid; } catch { /* keep the entry verdict */ }
    }
  }

  // 1. Stop existing bridge remotes (their bridge process + owned tmux) — before the
  //    owner kill so nothing races a half-dead session.
  try { await deps.stopExistingRemotes(sid); } catch { /* best-effort */ }

  let killMethod = 'none';
  if (wasLive) {
    // 2. Kill the owner and VERIFY it died.
    if (!oldPid) return { ok: false, state: 'error', sid, wasLive, waitedMs, reason: 'live session but no owner pid to kill' };
    const k = await deps.killOwner(oldPid).catch(() => ({ killed: false, wasAlive: true, method: 'error' }));
    killMethod = k.method;
    // INVARIANT: never resume over a live process.
    // Both abort paths carry the pane too — "the kill did not take" is exactly when
    // you want to see what that process is doing.
    if (!k.killed) {
      const obs = await observeScreen(sid, v.tmuxSession, SCREEN_POLLS_PRE, deps, sleep);
      return {
        ok: false, state: 'kill-failed', sid, oldPid, wasLive, killMethod, waitedMs,
        ...(obs ?? {}), screenSource: obs ? 'pre-restart' : undefined,
        reason: 'owner process did not terminate; NOT resuming over a live process',
      };
    }
    // 3. Independent re-verify: a fresh verdict must agree nothing owns the session
    //    (catches a second process owning the transcript beyond the killed pid).
    let stillLive = false;
    try { stillLive = deps.verdict(sid).live; } catch { stillLive = false; }
    if (stillLive) {
      const obs = await observeScreen(sid, v.tmuxSession, SCREEN_POLLS_PRE, deps, sleep);
      return {
        ok: false, state: 'kill-failed', sid, oldPid, wasLive, killMethod, waitedMs,
        ...(obs ?? {}), screenSource: obs ? 'pre-restart' : undefined,
        reason: 'session still reports a live owner after kill; ABORTING resume (no corruption)',
      };
    }
  }

  // 4. Clear a stale ccr-<sid8> tmux (ours by naming convention) so the fresh
  //    resume's create-tmux cannot collide on the name.
  try { await deps.killStaleCcrTmux(sid); } catch { /* best-effort */ }

  // 5. Fresh resume — new process ⇒ MCP tools re-fetched at startup.
  try {
    const record = await deps.resume(sid);
    const waited = waitedMs > 0 ? ` (waited ${Math.round(waitedMs / 1000)}s for its in-flight work to finish)` : '';
    // "restarted" says a fresh process spawned — NOT that it reached a usable state.
    // A resume re-opens modals rather than clearing them (resume-from-summary, and on
    // a just-upgraded CLI that version's first-run prompts), so the caller MUST read
    // the pane before assuming the session can take a turn.
    const recTmux = record && typeof record === 'object' && typeof (record as { tmuxSession?: unknown }).tmuxSession === 'string'
      ? (record as { tmuxSession: string }).tmuxSession
      : null;
    // WAIT HERE, not on the way in: give the fresh TUI time to paint and hold still,
    // so `screen` is the state it SETTLED on rather than a frame from mid-redraw.
    const obs = await observeScreen(sid, recTmux, SCREEN_POLLS_POST, deps, sleep, true);
    const screenNote = !obs
      ? ''
      : obs.screenStable
        ? ' — waited for the fresh session to settle; `screen` is what it came up on. A resume RE-OPENS modals (resume-from-summary; on a freshly upgraded CLI, that version\'s first-run prompts), so expect a chain of dialogs and drive them with terminal_send, ONE key per call, re-capturing between'
        : ' — ⚠️ the pane was STILL CHANGING when the settle window expired, so `screen` is a snapshot mid-paint, not a settled state: re-read it with terminal_capture before acting on it';
    return {
      ok: true, state: 'restarted', sid, oldPid, wasLive, killMethod, waitedMs, record,
      ...(obs ?? {}), screenSource: obs ? 'post-restart' : undefined,
      reason: (wasLive
        ? `killed the old owner (verified dead) and resumed fresh — MCP tools re-fetched at startup${waited}`
        : `session was not running; resumed fresh — MCP tools re-fetched at startup${waited}`) + screenNote,
    };
  } catch (e) {
    return { ok: false, state: 'error', sid, oldPid, wasLive, killMethod, waitedMs, reason: `resume failed: ${(e as Error).message}` };
  }
}
