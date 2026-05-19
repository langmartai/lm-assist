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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cc from '../terminal/cc';
import * as tmux from '../terminal/tmux';
import * as inspector from '../terminal/inspector';
import { readLastAssistantTurn, countUserPromptsInTranscript } from './cc-transcript';
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
  /**
   * Fingerprint of the launch-bound config (model/tools/effort/
   * settingSources/system-prompt) the CC process in this session was
   * started with. If a later call's fingerprint differs, the session is
   * relaunched so the new config takes effect. Undefined = session not
   * started by us / config unknown (never force-relaunch on unknown).
   */
  launchKey?: string;
}

const SESSIONS = new Map<string, SessionMeta>();
const TTL_MS = 2 * 60 * 60 * 1000;        // 2 hours of idleness → reap
const REAPER_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

/**
 * Background-path safety ceiling for the stable-screen wait.
 *
 * The runner detects "turn complete" by the CC TUI screen going quiet
 * (waitForStableScreen). A long autonomous job (analysis pipeline,
 * workflow) keeps the screen redrawing for 20-40+ min, so it only goes
 * quiet when the turn TRULY ends. A *foreground* tmux call holds an HTTP
 * connection, so it keeps the caller's `timeout` (or 300s) as a hard
 * bound. A *background* execution holds NO connection (startTmuxBackground
 * runs execute() unawaited), so it can — and must — wait the job out and
 * let the freshness-gated transcript read capture the REAL result, bounded
 * only by this generous ceiling that guards a genuinely wedged TUI. 90 min
 * comfortably covers worst-case real pipelines while still bounding a hung
 * TUI to finite time. Historically this was a flat 300s for ALL paths,
 * which made every healthy long background job false-fail at ~5 min.
 */
const BACKGROUND_SAFETY_CEILING_MS = 90 * 60 * 1000;

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

function touch(name: string, cwd: string, launchKey?: string): void {
  const existing = SESSIONS.get(name);
  if (existing) {
    existing.lastUsedAt = Date.now();
    if (launchKey !== undefined) existing.launchKey = launchKey;
  } else {
    const now = Date.now();
    SESSIONS.set(name, { name, createdAt: now, lastUsedAt: now, cwd, launchKey });
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
 *   settingSources        → --setting-sources <a,b,c>
 *
 * `model` is intentionally NOT here — cc.launch takes it as a dedicated
 * option and emits `--model` itself (see buildLaunchCmd in cc.ts), so
 * adding it here would double the flag. System-prompt flags are added
 * separately (they need temp files) — see materializeAppendSystemPrompt.
 *
 * All of these were empirically validated to take effect in the
 * INTERACTIVE `claude` launch (not just `-p`). NOTE: `--bare` is
 * deliberately NOT used to gate CLAUDE.md — it disables OAuth/keychain
 * auth, which breaks this deployment (no ANTHROPIC_API_KEY; "Not logged
 * in"). `--setting-sources` is the auth-safe lever and was verified to
 * gate project CLAUDE.md/settings.
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
  // settingSources: SDK parity for which settings/CLAUDE.md load. The
  // interactive TUI auto-discovers project+user CLAUDE.md by DEFAULT
  // (unlike the SDK, which is lean unless asked) — passing this lets a
  // caller opt out of that (e.g. ['user'] to skip project CLAUDE.md).
  if (request.settingSources && request.settingSources.length > 0) {
    flags.push('--setting-sources', request.settingSources.join(','));
  }
  return flags;
}

/**
 * Collapse `request.systemPrompt` + `request.context` into a single
 * APPEND string for the interactive TUI.
 *
 * Why append-only (deliberate divergence from the SDK's replace
 * semantics): only the append variants were validated to work in
 * interactive launch. `--system-prompt-file` (full replace) was tested
 * and does NOT work — it strips Claude Code's agent scaffolding and the
 * TUI stops answering. So a custom/string systemPrompt is APPENDED to
 * CC's default rather than replacing it: the caller's instructions are
 * still injected, and CC stays a functioning agent. The SDK itself
 * defaults to preset+append anyway (see sdk-runner.ts), so for the common
 * path this is faithful; only the rare full-replace case differs, by
 * design.
 */
export function planSystemPromptAppend(request: AgentExecuteRequest): string | null {
  const parts: string[] = [];
  const sp = request.systemPrompt;
  if (typeof sp === 'string') {
    if (sp.trim()) parts.push(sp);
  } else if (sp && typeof sp === 'object') {
    if (sp.type === 'custom' && typeof sp.content === 'string' && sp.content.trim()) {
      parts.push(sp.content);
    } else if (sp.type === 'preset' && typeof sp.append === 'string' && sp.append.trim()) {
      parts.push(sp.append);
    }
  }
  if (typeof request.context === 'string' && request.context.trim()) {
    parts.push(request.context);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * Write the append-system-prompt to a temp file and return the
 * `--append-system-prompt-file <path>` flag plus the temp paths to clean
 * up. File (not argv string) because the content can be large/multiline —
 * the `-file` variant was the one empirically validated and sidesteps
 * argv-length and shell-quoting limits entirely.
 */
function materializeAppendSystemPrompt(request: AgentExecuteRequest): { flags: string[]; tmpFiles: string[] } {
  const append = planSystemPromptAppend(request);
  if (!append) return { flags: [], tmpFiles: [] };
  const file = path.join(
    os.tmpdir(),
    `lm-assist-sysprompt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  fs.writeFileSync(file, append, 'utf-8');
  return { flags: ['--append-system-prompt-file', file], tmpFiles: [file] };
}

/**
 * Stable fingerprint of every launch-bound parameter. Launch flags are
 * fixed when the CC process starts; a warm session can't change them
 * mid-life (the SDK varies them per call — we can't). If a reused
 * session's fingerprint changes, the runner relaunches a fresh CC so the
 * new config actually takes effect instead of being silently ignored.
 */
export function launchKeyOf(request: AgentExecuteRequest): string {
  const effort = request.outputConfig?.effort
    ?? (request.extendedThinking?.enabled ? 'high' : null);
  return JSON.stringify({
    model: request.model ?? null,
    allowedTools: request.allowedTools ?? null,
    disallowedTools: request.disallowedTools ?? null,
    effort,
    settingSources: request.settingSources ?? null,
    append: planSystemPromptAppend(request),
  });
}

// ---------- No-turn classification (screen is the only source) -----------

export type NoTurnClassification =
  | { kind: 'blocked'; message: string }
  | { kind: 'dead'; message: string }
  | { kind: 'scrape' };

/**
 * When the freshness-gated transcript read found NO completed turn, decide
 * how to respond from the post-stable CC screen state. A permission /
 * trust / plan / choice dialog only ever exists on the screen (the SDK
 * gets it as a structured permission callback; we read it off the TUI) and
 * is never written to the transcript — so without this it would be
 * scraped and returned as if it were CC's answer.
 *
 * Pure so the decision is unit-testable without coercing a real dialog.
 */
export function classifyNoTurn(
  state: { phase: string; pendingDialog: string | null } | null,
  sessionName: string,
): NoTurnClassification {
  if (state && (state.pendingDialog !== null
      || state.phase === 'permission'
      || state.phase === 'trust-prompt'
      || state.phase === 'plan-mode')) {
    return {
      kind: 'blocked',
      message: `CC is blocked awaiting input (phase=${state.phase}, dialog=${state.pendingDialog ?? 'none'}) — no completed turn was produced. Inspect/answer via the /terminal/cc/${sessionName}/* endpoints.`,
    };
  }
  if (state && state.phase === 'dead') {
    return { kind: 'dead', message: `CC process is dead in session ${sessionName} — no completed turn was produced` };
  }
  return { kind: 'scrape' };
}

// ---------- Stable-screen timeout classification -------------------------

export type StabilizeTimeoutOutcome =
  | { kind: 'dead'; message: string }
  | { kind: 'incomplete'; message: string };

/**
 * When waitForStableScreen returns NOT-stable, decide whether that's a
 * genuine failure or a healthy long job that merely outran the
 * synchronous watch window.
 *
 * waitForStableScreen stops watching for two structurally different
 * reasons and ONLY ONE is a failure:
 *
 *   - the tmux session/pane vanished (capture threw) OR CC's process is
 *     dead → genuine failure ('dead').
 *   - the watch ceiling elapsed while the screen was STILL changing — i.e.
 *     CC is alive and actively working (that's literally WHY it never went
 *     quiet). The runner only stopped polling; it killed nothing, so the
 *     job continues to completion. This is NOT a failure ('incomplete') —
 *     reporting it as success:false is the long-job "false-fail" bug.
 *
 * Pure so the decision is unit-testable without coercing a real wedged
 * TUI (mirrors classifyNoTurn's design).
 */
export function classifyStabilizeTimeout(
  sessionGone: boolean,
  phase: string | null,
  sessionName: string,
  awaitMs: number,
): StabilizeTimeoutOutcome {
  if (sessionGone || phase === null || phase === 'dead') {
    return {
      kind: 'dead',
      message: `CC session ${sessionName} ended before producing a completed turn (waited ${awaitMs}ms)`,
    };
  }
  return {
    kind: 'incomplete',
    message: `CC in session ${sessionName} is still actively processing after ${awaitMs}ms — this is NOT a failure; the job is running headless and was not killed. Observe via /terminal/cc/${sessionName}/* or the job's own status file; do not relaunch.`,
  };
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
    const launchKey = launchKeyOf(request);
    let tmpFiles: string[] = [];

    try {
      // 1. Launch CC if not already idle in this session. cc.launch is
      //    idempotent — if the session has CC at idle, this returns
      //    quickly. If the session doesn't exist, it's created via
      //    tmux.createUnlocked inside cc.launch.
      const status = (() => {
        try { return cc.status(sessionName); } catch { return null; }
      })();

      let needsLaunch = !status || (status.phase !== 'idle' && status.phase !== 'busy' && status.phase !== 'plan-mode');

      // Warm-session config change. Launch flags (model / tools / effort /
      // settingSources / system-prompt) bind once when the CC process
      // starts and CANNOT change mid-life — the SDK varies them per call;
      // we can't. If this reused session was started with a different
      // config, relaunch a fresh CC so the new config actually takes
      // effect instead of being silently ignored. priorKey===undefined
      // means we didn't start it (or don't know) → never force-relaunch.
      if (!needsLaunch) {
        const priorKey = SESSIONS.get(sessionName)?.launchKey;
        if (priorKey !== undefined && priorKey !== launchKey) {
          try { await tmux.kill(sessionName); } catch { /* best-effort */ }
          SESSIONS.delete(sessionName);
          needsLaunch = true;
        }
      }

      if (needsLaunch) {
        const sp = materializeAppendSystemPrompt(request);
        tmpFiles = sp.tmpFiles;
        const launchResult = await cc.launch(sessionName, {
          cwd,
          model: request.model ? String(request.model) : null,
          extraFlags: [...buildLaunchFlags(request), ...sp.flags],
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
        // Record the config this CC process was started with, so a later
        // call with a different fingerprint triggers a relaunch.
        touch(sessionName, cwd, launchKey);
      }

      // 1b. FRESHNESS BASELINE. Count how many real user prompts the
      //     conversation transcript already has BEFORE we send ours. For a
      //     warm session this is >0; for a fresh launch it's 0 (no prior
      //     turns, sessionId not knowable until CC responds). We later
      //     require the count to grow past this before trusting a
      //     transcript read — otherwise a warm session returns the
      //     PREVIOUS turn's answer (ours isn't flushed yet). This is the
      //     hand-built equivalent of the SDK's per-call delimited stream.
      const baselinePrompts = (!needsLaunch && status?.sessionId)
        ? countUserPromptsInTranscript(status.sessionId, cwd)
        : 0;

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
      //    Watch-window policy: an EXPLICIT caller `timeout` always wins
      //    (caller intent). Otherwise a FOREGROUND tmux call holds an HTTP
      //    connection so it keeps the 300s default as a hard bound; a
      //    BACKGROUND execution holds no connection (startTmuxBackground
      //    runs this unawaited) so it waits the job out under the generous
      //    safety ceiling and lets the freshness-gated transcript read
      //    below capture the REAL result. A flat 300s for the background
      //    path was the long-job false-fail bug.
      const explicitTimeout = (request as AgentExecuteRequest & { timeout?: number }).timeout;
      const isBackground = (request as AgentExecuteRequest).background === true;
      const awaitMs = explicitTimeout
        ? Math.max(60000, explicitTimeout)
        : (isBackground ? BACKGROUND_SAFETY_CEILING_MS : 300000);
      const stable = await waitForStableScreen(sessionName, { timeoutMs: awaitMs, stableMs: 3000, pollMs: 400 });
      const promptElapsed = Date.now() - promptStart;
      if (!stable.stable) {
        // Reason from CC's ACTUAL state, not from "we stopped polling".
        const post = (() => { try { return cc.status(sessionName); } catch { return null; } })();
        const outcome = classifyStabilizeTimeout(
          stable.sessionGone, post?.phase ?? null, sessionName, awaitMs,
        );
        if (outcome.kind === 'dead') {
          // Session/pane gone or CC process dead → genuine failure.
          return errorResponse(executionId, start, outcome.message, sessionName);
        }
        // CC alive and was still actively redrawing when the watch window
        // elapsed — a long job that outran the synchronous watch, NOT a
        // failure. Nothing was killed; the job continues headless. Return
        // a NON-terminal marker so the background wrapper keeps the
        // execution 'running' (honest) instead of recording a false
        // 'failed', and a foreground caller can tell this apart from a
        // real failure and observe it via the terminal API.
        const liveSid = inspector.parseSessionId(stable.screen) ?? sessionName;
        return incompleteResponse(executionId, start, sessionName, liveSid, outcome.message);
      }

      // 6. Capture the after-screen — used to parse the sessionId and as
      //    the fallback output source if the transcript can't be read.
      const afterCapture = tmux.capture(sessionName, {
        paneQualifier: null, lines: null, start: -500,
      });

      // 7. Extract CC's CONVERSATION sessionId from the footer (sid: <uuid>).
      //    This is what the SDK returns and what /resume accepts. Falls
      //    back to the tmux session name if the footer isn't parseable
      //    (shouldn't happen at idle but defensive).
      const ccSessionId = inspector.parseSessionId(afterCapture) ?? sessionName;

      // 8. AUTHORITATIVE OUTPUT — freshness-gated transcript read. CC's
      //    TUI persists the exact same message stream the SDK consumes, so
      //    this is byte-accurate and complete (no width-wrap, no blank-line
      //    truncation, no ANSI). The `minUserPrompts` gate only accepts a
      //    turn once OUR prompt is recorded (prompt count past the
      //    pre-prompt baseline) AND it has assistant text — so a warm
      //    session never returns the PREVIOUS turn's answer. This is the
      //    hand-built substitute for the SDK's explicit `result` message.
      let result: string;
      let txUsage: import('./cc-transcript').TranscriptUsage | null = null;
      const turn = ccSessionId !== sessionName
        ? await readLastAssistantTurn(ccSessionId, cwd, {
            retries: 16,
            retryDelayMs: 250,
            minUserPrompts: baselinePrompts + 1,
          })
        : null;

      if (turn && turn.text.length > 0) {
        // CC produced a real, fresh answer — this always wins.
        result = turn.text;
        txUsage = turn.usage;
      } else {
        // 9. NO fresh completed turn. Distinguish "CC is blocked on a
        //    dialog the transcript never records" from "unknown — scrape".
        //    Without this, a permission / trust / plan / choice dialog
        //    would be scraped off the screen and returned as if it were
        //    CC's answer. The screen is the ONLY place this state exists
        //    (the SDK gets it as a structured permission callback; we have
        //    to read it off the TUI).
        const post = (() => { try { return cc.status(sessionName); } catch { return null; } })();
        const cls = classifyNoTurn(post, sessionName);
        if (cls.kind === 'blocked' || cls.kind === 'dead') {
          return errorResponse(executionId, start, cls.message, sessionName);
        }
        // Not a recognized blocked state and no transcript turn — fall
        // back to a best-effort screen scrape (legacy behaviour).
        result = extractResponse(beforeCapture, afterCapture, request.prompt);
      }

      touch(sessionName, cwd, launchKey);

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
          inputTokens: txUsage?.inputTokens ?? 0,
          outputTokens: txUsage?.outputTokens ?? 0,
          cacheCreationInputTokens: txUsage?.cacheCreationInputTokens ?? 0,
          cacheReadInputTokens: txUsage?.cacheReadInputTokens ?? 0,
          totalTokens: (txUsage?.inputTokens ?? 0) + (txUsage?.outputTokens ?? 0),
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
    } finally {
      // CC reads --append-system-prompt-file at startup; once launched the
      // temp file is no longer needed regardless of how the turn went.
      for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
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
): Promise<{ stable: boolean; screen: string; sessionGone: boolean }> {
  const start = Date.now();
  let last = '';
  let lastChangeAt = start;
  while (Date.now() - start < opts.timeoutMs) {
    let cur: string;
    try {
      cur = tmux.capture(session, { paneQualifier: null, lines: null, start: -200 });
    } catch {
      // Session/pane vanished — CC genuinely died. Distinct from a
      // watch-window overflow: the caller MUST treat this as a real
      // failure (sessionGone), never as "still running".
      return { stable: false, screen: last, sessionGone: true };
    }
    if (cur !== last) {
      last = cur;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= opts.stableMs) {
      return { stable: true, screen: cur, sessionGone: false };
    }
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
  // Ceiling elapsed while the screen was still changing — CC is alive and
  // actively working (that is WHY it never went quiet). Not a death.
  return { stable: false, screen: last, sessionGone: false };
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

/**
 * Non-terminal outcome: the synchronous watch window elapsed but CC is
 * alive and was still actively working (a long job that outran the
 * watch). Shaped like errorResponse (no result yet, success:false) but
 * carries `incomplete:true` so:
 *   - the background wrapper keeps the execution 'running' (honest)
 *     instead of recording a false 'failed', and
 *   - a foreground caller can tell this apart from a real failure.
 * `sessionId` is the live CC conversation UUID (or the tmux session name
 * fallback) so the caller can immediately observe the still-running job
 * via /terminal/cc/:session/* without another round-trip.
 */
function incompleteResponse(
  executionId: string,
  startMs: number,
  tmuxSession: string,
  sessionId: string,
  message: string,
): AgentExecuteResponse {
  return {
    success: false,
    incomplete: true,
    result: '',
    sessionId,
    tmuxSession,
    runner: 'tmux',
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
