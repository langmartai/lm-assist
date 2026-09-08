/**
 * Qwen Code harness — runs the `qwen` CLI headlessly against a model gateway.
 *
 * Chosen as the first non-Claude harness for one structural reason: it is
 * configured ENTIRELY by environment variables (OPENAI_BASE_URL / OPENAI_API_KEY /
 * OPENAI_MODEL), so a provider profile reaches it through the same `spawn({env})`
 * seam the existing runners already use — no config file to write, no global state
 * to mutate, and therefore no cross-talk between two concurrent runs on different
 * profiles. Its `--output-format stream-json` is also close to the Claude Code
 * stream-json the detached runner already parses.
 *
 * Verified end to end on 2026-09-09: a full tool-call → file-read → answer loop
 * through the gateway's native passthrough door on a zero-priced model.
 */

import { spawn, type ChildProcess } from 'child_process';
import type {
  AgentExecuteRequest,
  AgentExecuteResponse,
  AgentTokenUsage,
} from '../types/agent-api';
import type { AgentHarness, HarnessProbe } from './types';
import { resolveProfile, type ProviderProfile } from './provider-config';

export const QWEN_ID = 'qwen';

/** Wall-clock ceiling for a single run when the caller names none. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
/** Turn ceiling — an agent loop with no bound can spin against a flaky endpoint. */
const DEFAULT_MAX_TURNS = 40;
/** How long a terminated run may take to exit before it is killed outright. */
const KILL_GRACE_MS = 5000;

const EMPTY_USAGE: AgentTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalTokens: 0,
};

/**
 * Render a request into `qwen` argv.
 *
 * Pure and exported so the flag dialect is unit-testable on its own — the three
 * pre-existing option→flag mappers (buildCliArgs, buildLaunchFlags, buildLaunchCmd)
 * drifted apart precisely because they were embedded in their spawn paths.
 */
export function buildQwenArgs(request: AgentExecuteRequest, model: string): string[] {
  const args = [
    '-p', request.prompt,
    '--output-format', 'stream-json',
    // yolo auto-approves TOOL CALLS only. It is not a sandbox: qwen still runs
    // shell and edits at this process's privilege level.
    '--approval-mode', 'yolo',
    '--max-session-turns', String(request.maxTurns ?? DEFAULT_MAX_TURNS),
  ];
  if (model) args.push('-m', model);
  return args;
}

/**
 * Build the child environment.
 *
 * Assembled explicitly rather than by spreading caller-supplied values over
 * process.env: the generic `options.env` seam has no deny-list, so a caller can
 * override PATH/HOME there. A harness that is handed a credential should not also
 * widen that hole.
 */
export function buildQwenEnv(profile: ProviderProfile, model: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENAI_BASE_URL: profile.baseUrl,
    OPENAI_API_KEY: profile.apiKey,
    OPENAI_MODEL: model,
    // Ignore the operator's own qwen hooks/extensions/MCP servers. An agent run
    // triggered through lm-assist should not inherit a developer's local setup.
    QWEN_CODE_SAFE_MODE: 'true',
    FORCE_COLOR: '0',
  };
}

export interface QwenStreamSummary {
  sessionId: string;
  text: string;
  numTurns: number;
  toolCalls: number;
  errored: boolean;
  errorText?: string;
  /** Summed over the run's API calls. Zero when the stream reported none. */
  usage: AgentTokenUsage;
  /** False when no frame carried a usage block at all — 0 then means "unknown", not "free". */
  usageReported: boolean;
}

/**
 * Accumulate one frame's usage block.
 *
 * 🔴 Field names are snake_case and were READ OFF THE REAL CLI (qwen 0.15.10,
 * 2026-09-09), not guessed from the Claude Code stream-json they otherwise
 * resemble: `{input_tokens, output_tokens, cache_read_input_tokens, total_tokens}`.
 * Two things measured there drive this code:
 *
 *  - Frames carrying only `thinking` content report `{input_tokens: 0,
 *    output_tokens: 0}` with the other keys ABSENT, so every field must be
 *    optional-with-default; a `??` on the wrong key would silently zero a run.
 *  - Counts are PER API CALL, not cumulative, so they are summed. Input tokens
 *    therefore grow with the conversation, exactly as they do on the SDK path.
 *
 * `total_tokens` is deliberately not trusted for the total: the house convention
 * (convertResult in agent-api) is input + output, and mixing the two would make
 * a qwen run's totals incomparable with every other runner's.
 */
function addUsage(into: AgentTokenUsage, raw: any): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  into.inputTokens += num(raw.input_tokens);
  into.outputTokens += num(raw.output_tokens);
  into.cacheCreationInputTokens += num(raw.cache_creation_input_tokens);
  into.cacheReadInputTokens += num(raw.cache_read_input_tokens);
  into.totalTokens = into.inputTokens + into.outputTokens;
  return true;
}

/**
 * Fold qwen's NDJSON into a summary.
 *
 * 🔴 Framing: split on '\n' ONLY. Node's readline also splits on U+2028/U+2029,
 * which can legitimately appear inside a JSON string payload — a model that emits
 * one would corrupt the parse. A malformed line is skipped rather than fatal:
 * losing one frame must not lose the whole run.
 */
export function parseQwenStream(stdout: string): QwenStreamSummary {
  const out: QwenStreamSummary = {
    sessionId: '',
    text: '',
    numTurns: 0,
    toolCalls: 0,
    errored: false,
    usage: { ...EMPTY_USAGE },
    usageReported: false,
  };
  const texts: string[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;

    if (event.session_id && !out.sessionId) out.sessionId = String(event.session_id);

    if (event.type === 'assistant') {
      out.numTurns += 1;
      for (const block of event.message?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        if (block?.type === 'tool_use') out.toolCalls += 1;
      }
      if (event.message?.usage) out.usageReported = addUsage(out.usage, event.message.usage) || out.usageReported;
    } else if (event.type === 'result') {
      // The result frame is authoritative for the final answer.
      if (typeof event.result === 'string' && event.result.trim()) {
        out.text = event.result;
      }
      if (event.subtype && event.subtype !== 'success') {
        out.errored = true;
        out.errorText = typeof event.result === 'string' ? event.result : String(event.subtype);
      }
    }
  }

  if (!out.text) out.text = texts.join('\n').trim();

  // qwen exits 0 and reports subtype "success" even when the turn's only content
  // is a transport error from the endpoint, so the text has to be inspected too.
  const apiError = /^\s*\[API Error:/.test(out.text);
  if (apiError) {
    out.errored = true;
    out.errorText = out.text;
  }
  return out;
}

/**
 * Signal a run's whole process group, escalating to SIGKILL if it lingers.
 *
 * Why the GROUP and not just the child: under `--approval-mode yolo` qwen runs
 * shell commands itself, so a SIGTERM to qwen alone can leave a build or a curl
 * running with nobody tracking it — the abort would look clean and leak work.
 * `spawn({detached: true})` puts the run in its own process group precisely so
 * `kill(-pid)` can end all of it at once.
 *
 * Returns false when there was nothing alive to signal, which is what makes an
 * honest "no, that did not stop anything" answer possible upstream.
 */
export function terminateRun(child: ChildProcess, graceMs: number = KILL_GRACE_MS): boolean {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return false;

  const pid = child.pid;
  const signalGroup = (sig: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      // No process group (already reaped, or a platform without one) — fall back
      // to the single child so a lingering qwen is still ended.
      try {
        return child.kill(sig as NodeJS.Signals);
      } catch {
        return false;
      }
    }
  };

  if (!signalGroup('SIGTERM')) return false;

  // 🔴 The escalation probes the GROUP and is deliberately NOT cancelled when the
  // direct child exits. MEASURED on qwen 0.15.10: `qwen` forks a second node
  // process that ignores SIGTERM and OUTLIVES its parent. The obvious way to
  // write this — clear the timer on the child's `close` event — therefore cancels
  // the escalation moments before the only process that still needs killing, and
  // the abort looks clean while an agent keeps running. Signalling a group whose
  // leader has exited is valid for as long as any member remains, which is
  // exactly the window that matters here.
  const escalate = setTimeout(() => {
    if (signalGroup(0)) signalGroup('SIGKILL');
  }, graceMs);
  // A pending kill timer must not hold Core's event loop open on shutdown.
  escalate.unref?.();
  return true;
}

async function probeQwen(): Promise<HarnessProbe> {
  return new Promise((resolve) => {
    const child = spawn('qwen', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.on('error', () =>
      resolve({ available: false, reason: '`qwen` not found on PATH. Install with: npm i -g @qwen-code/qwen-code' })
    );
    child.on('close', (code) =>
      resolve(
        code === 0
          ? { available: true, version: out.trim(), binary: 'qwen' }
          : { available: false, reason: `\`qwen --version\` exited ${code}` }
      )
    );
  });
}

export function createQwenHarness(): AgentHarness {
  /**
   * Live runs by executionId.
   *
   * This map is the whole reason abort can be honest. The background bookkeeping
   * in agent-api holds a promise and a boolean — it can stop *tracking* a run but
   * owns no process handle, so before this existed "abort" flipped a flag while
   * the child carried on spending tokens against the gateway.
   *
   * Entries are removed on close/error, so a completed run cannot be "aborted".
   */
  const live = new Map<string, ChildProcess>();

  return {
    id: QWEN_ID,
    displayName: 'Qwen Code',
    capabilities: {
      // qwen reports token counts (and this harness now records them), but it
      // reports no price and gateway models have no trustworthy public rate card
      // here. Inventing a figure is worse than admitting we do not have one.
      cost: 'unavailable',
      sessionResume: false,
      mcp: false,
      permissionBroker: false,
      durableBackground: false,
      usesProviderProfile: true,
      abortable: true,
    },
    probe: probeQwen,

    abort(executionId: string): boolean {
      const child = live.get(executionId);
      if (!child) return false;
      const signalled = terminateRun(child);
      // Leave removal to the close handler: until the child is actually gone it
      // is still live, and dropping it here would make a second abort claim
      // there was nothing to stop.
      return signalled;
    },

    async execute(request: AgentExecuteRequest, executionId: string): Promise<AgentExecuteResponse> {
      const start = Date.now();
      const profile = resolveProfile((request as any).providerProfile);

      const base = (error: string): AgentExecuteResponse => ({
        success: false,
        result: '',
        sessionId: '',
        executionId,
        durationMs: Date.now() - start,
        durationApiMs: 0,
        numTurns: 0,
        totalCostUsd: 0,
        usage: { ...EMPTY_USAGE },
        modelUsage: {},
        error,
      });

      // Refuse rather than fall back. Falling through to the Claude default would
      // run an Anthropic agent for a request that explicitly asked for a gateway
      // model — the exact silent-substitution failure this work exists to remove.
      if (!profile) {
        return base(
          'No harness provider profile configured. Set one in ~/.lm-assist/harness-providers.json ' +
            `or via ${'LM_HARNESS_'}BASE_URL + ${'LM_HARNESS_'}API_KEY.`
        );
      }

      const model = request.model || profile.model;
      if (!model) return base(`Provider profile "${profile.name}" has no model and the request named none.`);

      const args = buildQwenArgs(request, model);
      const timeoutMs = request.timeout ?? DEFAULT_TIMEOUT_MS;

      return new Promise<AgentExecuteResponse>((resolve) => {
        const child = spawn('qwen', args, {
          cwd: request.cwd || process.cwd(),
          env: buildQwenEnv(profile, model),
          stdio: ['ignore', 'pipe', 'pipe'],
          // Own process group, so abort/timeout can end qwen AND the shell
          // commands it spawns under yolo. See terminateRun().
          detached: true,
        });
        live.set(executionId, child);

        let stdout = '';
        let stderr = '';
        let settled = false;

        // A timed-out run is still a run that HAPPENED: it burned tokens and may
        // have produced most of an answer. Returning the bare `base()` shape threw
        // all of that away and reported a zero-token, empty-result failure — the
        // same "0 means unknown" trap the cost work exists to close. Measured
        // 2026-09-09: this gateway model regularly answers and then never emits a
        // `result` frame, so the timeout is a COMMON path here, not a rare one.
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          terminateRun(child);
          const partial = parseQwenStream(stdout);
          resolve({
            ...base(`Timed out after ${timeoutMs}ms`),
            result: partial.text,
            sessionId: partial.sessionId,
            numTurns: partial.numTurns,
            usage: partial.usage,
            modelUsage: partial.usageReported ? { [model]: { ...partial.usage } } : {},
            durationMs: Date.now() - start,
            runner: QWEN_ID,
          });
        }, timeoutMs);

        child.stdout?.on('data', (d) => (stdout += d.toString()));
        child.stderr?.on('data', (d) => (stderr += d.toString()));

        child.on('error', (err) => {
          live.delete(executionId);
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            ...base(`Failed to launch qwen: ${err.message}. Install with: npm i -g @qwen-code/qwen-code`),
            runner: QWEN_ID,
          });
        });

        child.on('close', (code, signal) => {
          live.delete(executionId);
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          const summary = parseQwenStream(stdout);
          const ok = code === 0 && !summary.errored;

          resolve({
            success: ok,
            result: summary.text,
            sessionId: summary.sessionId,
            executionId,
            durationMs: Date.now() - start,
            durationApiMs: 0,
            numTurns: summary.numTurns,
            // 'unavailable', not free. See capabilities.cost — the token counts
            // below are real, but nothing here knows what they cost.
            totalCostUsd: 0,
            usage: summary.usage,
            modelUsage: summary.usageReported ? { [model]: { ...summary.usage } } : {},
            runner: QWEN_ID,
            ...(ok
              ? {}
              : {
                  error:
                    summary.errorText ||
                    stderr.trim().slice(0, 2000) ||
                    // A signal, not an exit code, is what an abort looks like from
                    // in here — say so instead of reporting "exited with code null".
                    (signal ? `qwen terminated by ${signal}` : `qwen exited with code ${code}`),
                }),
          });
        });
      });
    },
  };
}
