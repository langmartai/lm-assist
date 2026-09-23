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
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type {
  AgentExecuteRequest,
  AgentExecuteResponse,
  AgentTokenUsage,
} from '../types/agent-api';
import type { AgentHarness, HarnessProbe, HarnessRunHooks } from './types';
import { resolveProfile, type ProviderProfile } from './provider-config';
import { terminateRun } from './process';
import { redactString } from './redact';
import { harnessRunDir } from './run-paths';

export const QWEN_ID = 'qwen';

/** Wall-clock ceiling for a single run when the caller names none. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
/** Turn ceiling — an agent loop with no bound can spin against a flaky endpoint. */
const DEFAULT_MAX_TURNS = 40;

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
    '--output-format', 'stream-json',
    // yolo auto-approves TOOL CALLS only. It is not a sandbox: qwen still runs
    // shell and edits at this process's privilege level.
    '--approval-mode', 'yolo',
    '--max-session-turns', String(request.maxTurns ?? DEFAULT_MAX_TURNS),
  ];
  if (model) args.push('-m', model);
  // The prompt is NOT on argv — it goes to stdin (see qwenStdinPrompt). MEASURED with
  // a real auth path (an invalid key, so the run reaches the API and 401s only if the
  // prompt was consumed):
  //   `-p <prompt>`        deprecated per qwen --help, AND a dash-leading value is
  //                        parsed as flags ("Unknown argument")
  //   bare positional      same "Unknown argument" on a dash-leading value
  //   `-- <prompt>`        NOT consumed at all — qwen's `query` positional ignores
  //                        post-`--` tokens; it then fails "No input provided via
  //                        stdin". (An earlier version of this file claimed this form
  //                        was "measured to parse and run" — that probe had no
  //                        credential, so qwen died on auth BEFORE checking for a
  //                        prompt, and the inference was wrong.)
  //   `--prompt=<prompt>`  works, but is the deprecated flag
  //   stdin                works for every shape tried: dash-leading, multi-line,
  //                        quotes, `$HOME` — verbatim, no parsing. qwen's own error
  //                        names it ("Input can be provided by piping").
  return args;
}

/** What is written to the child's stdin: the prompt, verbatim. Kept as a function so
 *  the contract ("argv never carries the prompt") is testable on its own. */
export function qwenStdinPrompt(request: AgentExecuteRequest): string {
  return request.prompt;
}

/**
 * Build the child environment FROM SCRATCH.
 *
 * Nothing is copied from process.env. Review measured what Core's own environment
 * carried — SERVER_ENCRYPTION_KEY, NPM_TOKEN, CLAUDE_CODE_MESSAGING_TOKEN, hub keys —
 * and the first version spread all of it into a child that runs auto-approved shell
 * for a model. One `env` from the agent would have exfiltrated every one. Same stance
 * as plugins/client.ts buildPluginEnv(): the child gets exactly what it needs.
 *
 * QWEN_HOME is the REAL isolation knob (measured: it relocates the entire ~/.qwen
 * root — settings, MCP servers, hooks, extensions, AND the projects/<cwd>/chats
 * transcripts). The first version set a `QWEN_CODE_SAFE_MODE` that qwen does not
 * read at all — zero occurrences in the binary — so the run silently inherited the
 * operator's whole config while claiming not to. Pointing QWEN_HOME at a per-run dir
 * gives a fresh config AND makes the transcript findable by execution id:
 *   <runHome>/projects/<cwd-with-slashes-as-dashes>/chats/<sessionId>.jsonl
 */
export function buildQwenEnv(profile: ProviderProfile, model: string, runHome: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? os.homedir(),
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: 'dumb',
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    QWEN_HOME: runHome,
    OPENAI_BASE_URL: profile.baseUrl,
    OPENAI_API_KEY: profile.apiKey,
    OPENAI_MODEL: model,
    FORCE_COLOR: '0',
  };
}

/** Per-run home for qwen inside the run's dir (see run-paths), keyed by execution id. Stays
 *  after the run so the transcript can be inspected; retention removes it with the run. */
export function qwenRunHome(executionId: string): string {
  return path.join(harnessRunDir(executionId), 'qwen-home');
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

/** A usage block with any non-zero count — a thinking-only frame's `{0, 0}` is "nothing reported yet". */
function frameReportsUsage(raw: any): boolean {
  if (!raw || typeof raw !== 'object') return false;
  return ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    .some((k) => typeof raw[k] === 'number' && Number.isFinite(raw[k]) && raw[k] > 0);
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
  const seenTurnIds = new Set<string>();
  /**
   * The open model turn — the transcript layer's rule (transcript/qwen-stream.ts), so
   * the recorded count and the timeline agree. MEASURED on qwen 0.15.10: one turn is
   * TWO assistant frames with DIFFERENT uuids — thinking-only with usage 0/0, then the
   * tool_use/text frame carrying the real usage — so a uuid dedupe alone counted every
   * turn twice. A new frame joins the open turn until that turn has reported non-zero
   * usage; a tool_result (`user`) or the result frame closes it.
   */
  let open = false;
  let openHasUsage = false;
  /** The CLI's own count, from the result frame: authoritative when present. */
  let resultTurns: number | null = null;

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
      // A frame repeating a uuid (else message.id) restates the open turn; a new one
      // starts a turn only once the open turn has reported usage (see `open` above).
      const id = typeof event.uuid === 'string' ? event.uuid : (typeof event.message?.id === 'string' ? event.message.id : null);
      const repeat = !!id && seenTurnIds.has(id);
      if (id) seenTurnIds.add(id);
      if (open && !repeat && openHasUsage) open = false;
      if (!open) {
        out.numTurns += 1;
        open = true;
        openHasUsage = false;
      }
      if (frameReportsUsage(event.message?.usage)) openHasUsage = true;
      for (const block of event.message?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        if (block?.type === 'tool_use') out.toolCalls += 1;
      }
      if (event.message?.usage) out.usageReported = addUsage(out.usage, event.message.usage) || out.usageReported;
    } else if (event.type === 'user') {
      open = false;
    } else if (event.type === 'result') {
      open = false;
      if (Number.isInteger(event.num_turns) && event.num_turns >= 0) resultTurns = event.num_turns;
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
  // A timed-out run has no result frame; the open-turn count above stands in for it.
  if (resultTurns !== null) out.numTurns = resultTurns;

  // qwen exits 0 and reports subtype "success" even when the turn's only content
  // is a transport error from the endpoint, so the text has to be inspected too.
  const apiError = /^\s*\[API Error:/.test(out.text);
  if (apiError) {
    out.errored = true;
    out.errorText = out.text;
  }
  return out;
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

    async execute(request: AgentExecuteRequest, executionId: string, hooks?: HarnessRunHooks): Promise<AgentExecuteResponse> {
      const start = Date.now();
      const profile = resolveProfile((request as any).providerProfile);

      // Hooks are observers. A throwing one must not change what this run does or returns.
      const safe = <A>(fn: ((a: A) => void) | undefined, arg: A): void => {
        if (!fn) return;
        try { fn.call(hooks, arg); } catch { /* observer failure is not a run failure */ }
      };

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
        runner: QWEN_ID,
        error,
      });

      // Refuse rather than fall back. Falling through to the Claude default would
      // run an Anthropic agent for a request that explicitly asked for a gateway
      // model — the exact silent-substitution failure this work exists to remove.
      if (!profile) {
        safe(hooks?.onSettle, { termination: 'config_error' });
        return base(
          'No harness provider profile configured. Set one in ~/.lm-assist/harness-providers.json ' +
            `or via ${'LM_HARNESS_'}BASE_URL + ${'LM_HARNESS_'}API_KEY.`
        );
      }

      const model = request.model || profile.model;
      if (!model) {
        safe(hooks?.onSettle, { termination: 'config_error' });
        return base(`Provider profile "${profile.name}" has no model and the request named none.`);
      }
      safe(hooks?.onResolved, {
        model,
        profileName: profile.name,
        baseUrl: profile.baseUrl,
        cwd: request.cwd || process.cwd(),
        maxTurnsEnforced: true,
      });

      const args = buildQwenArgs(request, model);
      const timeoutMs = request.timeout ?? DEFAULT_TIMEOUT_MS;

      const runHome = qwenRunHome(executionId);
      // The run dir holds the transcript, which can quote anything the agent read,
      // so it is owner-only. The recorder normally made it already; this covers a
      // harness used on its own.
      try { fs.mkdirSync(path.dirname(runHome), { recursive: true, mode: 0o700 }); } catch { /* spawn will surface it */ }
      try { fs.mkdirSync(runHome, { recursive: true, mode: 0o700 }); } catch { /* spawn will surface it */ }

      return new Promise<AgentExecuteResponse>((resolve) => {
        let child: ChildProcess;
        try {
          child = spawn('qwen', args, {
            cwd: request.cwd || process.cwd(),
            env: buildQwenEnv(profile, model, runHome),
            stdio: ['pipe', 'pipe', 'pipe'],
            // Own process group, so abort/timeout can end qwen AND the shell
            // commands it spawns under yolo. See terminateRun().
            detached: true,
          });
        } catch (err) {
          // spawn() throws SYNCHRONOUSLY on some inputs (a NUL byte in argv or
          // cwd). Inside this executor that became a rejection nothing reported
          // as a launch failure; resolve it as one instead.
          safe(hooks?.onSettle, { termination: 'spawn_throw' });
          resolve(base(`Failed to launch qwen: ${err instanceof Error ? err.message : String(err)}`));
          return;
        }
        // Hand the prompt over on stdin and close it — see buildQwenArgs for why not argv.
        child.stdin?.on('error', () => { /* child exited before reading; the close handler reports it */ });
        child.stdin?.end(qwenStdinPrompt(request));
        live.set(executionId, child);
        // Decode as UTF-8 at the stream, not per chunk: a multi-byte character
        // split across two chunks would otherwise decode as two replacement chars.
        child.stdout?.setEncoding('utf8');
        safe(hooks?.onSpawn, { pid: child.pid });

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
          safe(hooks?.onSettle, { termination: 'timeout' });
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

        child.stdout?.on('data', (d) => {
          const chunk = typeof d === 'string' ? d : d.toString('utf8');
          stdout += chunk;
          safe(hooks?.onStdout, chunk);
        });
        child.stderr?.on('data', (d) => (stderr += d.toString()));

        child.on('error', (err) => {
          live.delete(executionId);
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          safe(hooks?.onSettle, { termination: 'launch_error' });
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
          safe(hooks?.onSettle, { termination: 'exit', exitCode: code, signal });

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
                    // Redacted BEFORE the cut: a key straddling char 2000 would otherwise
                    // survive as a fragment the exact-value rule no longer matches.
                    redactString(stderr.trim()).slice(0, 2000) ||
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
