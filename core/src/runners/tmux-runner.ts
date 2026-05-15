/**
 * Tmux runner — executes agent prompts via a long-lived Claude Code TUI
 * inside a tmux session, instead of through the @anthropic-ai/claude-agent-sdk.
 *
 * Why: callers that want to reuse a CC session across many prompts get
 * cold-start savings (~3s per call collapses to ~50ms) AND access to the
 * full interactive surface (slash commands, dialogs, plan mode) that the
 * SDK doesn't expose. Sessions live by default for 2 hours of idleness;
 * after that a background reaper kills them.
 *
 * Returns the same `AgentExecuteResponse` shape as the SDK runner so
 * callers don't have to branch on `runner`. Cost/usage fields are 0/null
 * because we have no telemetry from CC's TUI — the SDK emits them
 * structurally, the TUI doesn't.
 */

import * as cc from '../terminal/cc';
import * as tmux from '../terminal/tmux';
import * as inspector from '../terminal/inspector';
import { TerminalError } from '../terminal/errors';
import { IS_POSIX } from '../utils/process-utils';
import type {
  AgentExecuteRequest,
  AgentExecuteResponse,
  AgentResumeRequest,
} from '../types/agent-api';

// ---------- Session lifecycle tracking -----------------------------------

interface SessionMeta {
  /** tmux session name */
  name: string;
  /** First time we touched this session */
  createdAt: number;
  /** Most recent prompt completion */
  lastUsedAt: number;
  /** cwd CC was launched in (for cache-key style validation) */
  cwd: string;
}

const SESSIONS = new Map<string, SessionMeta>();
const TTL_MS = 2 * 60 * 60 * 1000;        // 2 hours of idleness → reap
const REAPER_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

let reaperTimer: NodeJS.Timeout | null = null;

function ensureReaper(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    const now = Date.now();
    for (const [name, meta] of SESSIONS) {
      if (now - meta.lastUsedAt < TTL_MS) continue;
      try {
        // Best-effort kill; if tmux is gone we just drop the entry.
        // Use Promise + catch since tmux.kill is async; we don't await
        // because reaper runs detached.
        tmux.kill(name).catch(() => { /* swallow */ });
      } catch { /* ignore */ }
      SESSIONS.delete(name);
    }
  }, REAPER_INTERVAL_MS);
  // Don't keep the event loop alive just for the reaper.
  if (typeof reaperTimer.unref === 'function') reaperTimer.unref();
}

function touch(name: string, cwd: string): void {
  const existing = SESSIONS.get(name);
  if (existing) {
    existing.lastUsedAt = Date.now();
  } else {
    const now = Date.now();
    SESSIONS.set(name, { name, createdAt: now, lastUsedAt: now, cwd });
  }
  ensureReaper();
}

// ---------- Response extraction ------------------------------------------

/**
 * Extract CC's response from the post-prompt screen capture.
 *
 * CC marks every assistant response line with the `●` glyph (occasionally
 * `⏺` for tool calls). Find the LAST contiguous block of such lines —
 * that's the most-recent response. Block ends at a `✻ Worked/Brewed for ...`
 * status line, a separator (`─`), the next prompt indicator (`❯`), or a
 * blank line.
 *
 * Falls back to "everything after the last `●`" if the block boundary
 * heuristics miss.
 */
function extractResponse(_beforeText: string, afterText: string, _prompt: string): string {
  // Strip ANSI escape codes + OSC sequences.
  // eslint-disable-next-line no-control-regex
  const clean = afterText
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

  const lines = clean.split('\n');
  // Find the LAST line that starts with the response marker (after
  // optional whitespace).
  let lastBlockStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[●⏺]\s+\S/.test(lines[i])) { lastBlockStart = i; break; }
  }
  if (lastBlockStart < 0) return '';

  // Walk backwards from there to include earlier ●/⏺ lines that belong
  // to the same response (consecutive markers, possibly with continuation
  // lines indented under them).
  while (lastBlockStart > 0) {
    const prev = lines[lastBlockStart - 1];
    if (/^\s*[●⏺]\s+\S/.test(prev)) { lastBlockStart--; continue; }
    // Continuation: indented non-marker line right above the block, no
    // separator/footer keyword.
    const trimmed = prev.trim();
    if (trimmed === '' || /^[─━]/.test(trimmed) || /^✻/.test(trimmed) || trimmed.startsWith('❯')) break;
    if (/^\s{2,}\S/.test(prev)) { lastBlockStart--; continue; }
    break;
  }

  // Find the END of the block (first line that's a separator/status/empty).
  let lastBlockEnd = lines.length;
  for (let j = lastBlockStart + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === '' || /^[─━]/.test(t) || /^✻/.test(t) || t.startsWith('❯')) {
      lastBlockEnd = j; break;
    }
  }

  const block = lines.slice(lastBlockStart, lastBlockEnd)
    .map((l) => l.replace(/^\s*[●⏺]\s*/, '').trimEnd())
    .filter((l) => l.length > 0);
  return block.join('\n').trim();
}

// ---------- Launch-flag mapping (SDK parity) -----------------------------

/**
 * Map SDK-parity request fields onto Claude Code CLI flags for the
 * interactive TUI launch. Flag names mirror detached-runner.ts exactly
 * (the canonical SDK→CLI mapping) so tmux-runner behaviour matches the
 * SDK runner:
 *
 *   allowedTools          → --allowedTools <t> <t> ...
 *   disallowedTools       → --disallowedTools <t> <t> ...
 *   outputConfig.effort   → --effort <level>
 *   extendedThinking.enabled (no explicit effort) → --effort high
 *
 * `model` is intentionally NOT here — cc.launch takes it as a dedicated
 * option and emits `--model` itself (see buildLaunchCmd in cc.ts), so
 * adding it here would double the flag.
 *
 * The interactive `claude` binary accepts these as global session-config
 * flags (the same way cc.ts already passes `--model` to the TUI launch).
 */
export function buildLaunchFlags(request: AgentExecuteRequest): string[] {
  const flags: string[] = [];
  if (request.allowedTools && request.allowedTools.length > 0) {
    flags.push('--allowedTools', ...request.allowedTools);
  }
  if (request.disallowedTools && request.disallowedTools.length > 0) {
    flags.push('--disallowedTools', ...request.disallowedTools);
  }
  // Effort is the only TUI lever for thinking depth. An explicit
  // outputConfig.effort wins; otherwise extendedThinking.enabled implies
  // 'high' (adaptive/enabled thinking ≈ high effort on Opus 4.6).
  const effort = request.outputConfig?.effort
    ?? (request.extendedThinking?.enabled ? 'high' : undefined);
  if (effort) {
    flags.push('--effort', effort);
  }
  return flags;
}

// ---------- Public: execute ----------------------------------------------

export interface TmuxRunnerOptions {
  /** Override the default 2h idle TTL. */
  ttlMs?: number;
}

export function createTmuxRunner(opts: TmuxRunnerOptions = {}) {
  const ttlMs = opts.ttlMs ?? TTL_MS;

  async function execute(
    request: AgentExecuteRequest,
    executionId: string,
  ): Promise<AgentExecuteResponse> {
    const start = Date.now();
    if (!IS_POSIX) {
      return errorResponse(executionId, start, 'tmux runner requires a POSIX host');
    }

    // Decide on session name. If caller provided tmuxSession, use it; else
    // derive from executionId so each call is its own session unless caller
    // explicitly opts into sharing.
    const sessionName = (request as AgentExecuteRequest & { tmuxSession?: string }).tmuxSession
      ?? `agent-${executionId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)}`;

    const cwd = request.cwd ?? process.cwd();

    try {
      // 1. Launch CC if not already idle in this session. cc.launch is
      //    idempotent — if the session has CC at idle, this returns
      //    quickly. If the session doesn't exist, it's created via
      //    tmux.createUnlocked inside cc.launch.
      const status = (() => {
        try { return cc.status(sessionName); } catch { return null; }
      })();

      const needsLaunch = !status || (status.phase !== 'idle' && status.phase !== 'busy' && status.phase !== 'plan-mode');
      if (needsLaunch) {
        const launchResult = await cc.launch(sessionName, {
          cwd,
          model: request.model ? String(request.model) : null,
          extraFlags: buildLaunchFlags(request),
          skipPermissions: true,
          cols: 220,
          rows: 60,
          readyPattern: 'ctx:',
          readyTimeoutMs: 60000,
          autoAcceptTrust: true,
        });
        if (!launchResult.ready) {
          return errorResponse(executionId, start, `cc.launch did not reach idle: phase=${launchResult.finalPhase}`);
        }
      }

      // 2. Snapshot the screen before sending the prompt — we'll use it
      //    both to detect "CC has started processing" (screen changed)
      //    and to extract the response (diff after).
      const beforeCapture = tmux.capture(sessionName, {
        paneQualifier: null, lines: null, start: -200,
      });
      const beforeSnapshot = { text: beforeCapture };

      // 3. Send the prompt.
      await cc.prompt(sessionName, { text: request.prompt, allowNewlines: true });

      // 4. Wait for the screen to MATERIALLY CHANGE (CC drew the typed
      //    prompt) — this just confirms CC accepted the input.
      const promptStart = Date.now();
      const changed = await inspector.awaitScreenChange(sessionName, beforeSnapshot, { timeoutMs: 5000, pollMs: 100 });
      if (!changed.changed) {
        return errorResponse(executionId, start, 'CC did not acknowledge the prompt within 5s', sessionName);
      }

      // 5. Wait for the screen to STABILIZE — no further changes for
      //    `stableMs`. CC's TUI redraws constantly while processing
      //    (spinner + elapsed-seconds counter). When the screen stops
      //    changing for 3 seconds, the response is fully rendered.
      //
      //    Pure phase-based detection (await-idle) is unreliable because
      //    CC's `❯` prompt indicator stays visible even mid-response, so
      //    `derivePhase` returns 'idle' immediately. Stability detection
      //    is slower-by-3s but immune to TUI quirks.
      const awaitMs = Math.max(60000, (request as AgentExecuteRequest & { timeout?: number }).timeout ?? 300000);
      const stable = await waitForStableScreen(sessionName, { timeoutMs: awaitMs, stableMs: 3000, pollMs: 400 });
      const promptElapsed = Date.now() - promptStart;
      if (!stable.stable) {
        return errorResponse(executionId, start, `screen never stabilized within ${awaitMs}ms (CC may still be processing)`, sessionName);
      }

      // 6. Capture the after-screen and extract the response.
      const afterCapture = tmux.capture(sessionName, {
        paneQualifier: null, lines: null, start: -500,
      });
      const result = extractResponse(beforeCapture, afterCapture, request.prompt);

      // 7. Extract CC's CONVERSATION sessionId from the footer (sid: <uuid>).
      //    This is what the SDK returns and what /resume accepts. Falls
      //    back to the tmux session name if the footer isn't parseable
      //    (shouldn't happen at idle but defensive).
      const ccSessionId = inspector.parseSessionId(afterCapture) ?? sessionName;

      touch(sessionName, cwd);

      const response: AgentExecuteResponse & { tmuxSession?: string; runner?: string } = {
        success: true,
        result,
        sessionId: ccSessionId,
        executionId,
        durationMs: Date.now() - start,
        durationApiMs: promptElapsed,
        numTurns: 1,
        totalCostUsd: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalTokens: 0,
        },
        modelUsage: {},
        // tmux-runner-specific fields (additive, ignored by SDK consumers).
        tmuxSession: sessionName,
        runner: 'tmux',
      };
      return response;
    } catch (e: unknown) {
      const msg = e instanceof TerminalError ? `${e.code}: ${e.message}` : String(e);
      return errorResponse(executionId, start, msg, sessionName);
    }
  }

  async function resume(
    request: AgentResumeRequest,
    executionId: string,
  ): Promise<AgentExecuteResponse> {
    // For tmux runner, "resume" means: keep using the existing tmuxSession.
    // The SDK has its own concept of resume (re-attaching to a SDK session).
    // For us, if tmuxSession exists it's already kept-warm; just execute.
    return execute(request as unknown as AgentExecuteRequest, executionId);
  }

  /** Test/admin: list currently-tracked sessions and their last-used age. */
  function listSessions(): Array<SessionMeta & { idleMs: number; ttlRemainingMs: number }> {
    const now = Date.now();
    return Array.from(SESSIONS.values()).map((m) => ({
      ...m,
      idleMs: now - m.lastUsedAt,
      ttlRemainingMs: Math.max(0, ttlMs - (now - m.lastUsedAt)),
    }));
  }

  /** Test/admin: explicitly drop a session (also kills the tmux session). */
  async function killSession(name: string): Promise<{ killed: boolean }> {
    SESSIONS.delete(name);
    try {
      const r = await tmux.kill(name);
      return { killed: r.killed };
    } catch {
      return { killed: false };
    }
  }

  return { execute, resume, listSessions, killSession };
}

/**
 * Poll the pane's screen until it goes `stableMs` without any change.
 * Returns the most recent screen text. Used as the "response complete"
 * signal for CC, which redraws its busy spinner constantly while
 * processing and stops the moment the response is rendered.
 */
async function waitForStableScreen(
  session: string,
  opts: { timeoutMs: number; stableMs: number; pollMs: number },
): Promise<{ stable: boolean; screen: string }> {
  const start = Date.now();
  let last = '';
  let lastChangeAt = start;
  while (Date.now() - start < opts.timeoutMs) {
    let cur: string;
    try {
      cur = tmux.capture(session, { paneQualifier: null, lines: null, start: -200 });
    } catch {
      // Session went away — return what we have.
      return { stable: false, screen: last };
    }
    if (cur !== last) {
      last = cur;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= opts.stableMs) {
      return { stable: true, screen: cur };
    }
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
  return { stable: false, screen: last };
}

function errorResponse(executionId: string, startMs: number, message: string, sessionId = ''): AgentExecuteResponse {
  return {
    success: false,
    result: '',
    sessionId,
    executionId,
    durationMs: Date.now() - startMs,
    durationApiMs: 0,
    numTurns: 0,
    totalCostUsd: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
    },
    modelUsage: {},
    error: message,
  };
}
