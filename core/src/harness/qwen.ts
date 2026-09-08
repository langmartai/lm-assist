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

import { spawn } from 'child_process';
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
  return {
    id: QWEN_ID,
    displayName: 'Qwen Code',
    capabilities: {
      // qwen reports token counts, but this harness does not yet price them, and
      // inventing a figure would be worse than admitting we do not have one.
      cost: 'unavailable',
      sessionResume: false,
      mcp: false,
      permissionBroker: false,
      durableBackground: false,
      usesProviderProfile: true,
    },
    probe: probeQwen,

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
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGTERM');
          resolve({ ...base(`Timed out after ${timeoutMs}ms`), runner: QWEN_ID as any });
        }, timeoutMs);

        child.stdout?.on('data', (d) => (stdout += d.toString()));
        child.stderr?.on('data', (d) => (stderr += d.toString()));

        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            ...base(`Failed to launch qwen: ${err.message}. Install with: npm i -g @qwen-code/qwen-code`),
            runner: QWEN_ID,
          });
        });

        child.on('close', (code) => {
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
            // 'unavailable', not free. See capabilities.cost.
            totalCostUsd: 0,
            usage: { ...EMPTY_USAGE },
            modelUsage: {},
            runner: QWEN_ID,
            ...(ok
              ? {}
              : {
                  error:
                    summary.errorText ||
                    stderr.trim().slice(0, 2000) ||
                    `qwen exited with code ${code}`,
                }),
          });
        });
      });
    },
  };
}
