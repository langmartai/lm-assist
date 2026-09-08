/**
 * OpenCode harness — runs the `opencode` CLI headlessly against a model gateway.
 *
 * The interesting difference from qwen, and the reason this file is longer than
 * it looks like it should be: OpenCode has NO environment-variable route to a
 * custom provider. Its providers are declared in a CONFIG FILE, so a run must
 * write one. That file holds a live credential, which forces three decisions:
 *
 *   - it is written to a fresh 0700 temp dir, 0600, ONE PER RUN, and pointed at
 *     with `OPENCODE_CONFIG`. A shared or long-lived file would leave a
 *     credential on disk between runs and would make two concurrent runs on
 *     different profiles fight over one file — the cross-talk qwen avoids by
 *     being env-configured;
 *   - it is removed when the child exits, including after an abort or a timeout;
 *   - it never contains anything but the profile being used.
 *
 * Everything below about the wire format was MEASURED against opencode 1.18.29
 * on 2026-09-09, not taken from documentation:
 *
 *   `--format json` is a STREAM of NDJSON events, not one object at completion.
 *   Observed types: `step_start`, `tool_use`, `text`, `step_finish`, `error`.
 *   Usage rides on `step_finish` as
 *   `part.tokens = {total, input, output, reasoning, cache:{write,read}}`.
 *   A failure emits `{type:"error", error:{name, data:{message}}}` and exit 1.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  AgentExecuteRequest,
  AgentExecuteResponse,
  AgentTokenUsage,
} from '../types/agent-api';
import type { AgentHarness, HarnessProbe } from './types';
import { resolveProfile, type ProviderProfile } from './provider-config';
import { terminateRun } from './process';

export const OPENCODE_ID = 'opencode';

/** Wall-clock ceiling for a single run when the caller names none. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The provider id this harness declares inside the generated config. A fixed
 * literal, not the profile name: it is an internal handle that appears in the
 * `-m <provider>/<model>` argument, and deriving it from a caller-supplied name
 * would let that name reach the config's key space.
 */
export const PROVIDER_ID = 'lmharness';

/**
 * The npm adapter OpenCode loads for an OpenAI-compatible endpoint. Pinned by
 * name here because it is part of the contract with the generated config, not a
 * detail of the gateway.
 */
const OPENAI_COMPATIBLE_ADAPTER = '@ai-sdk/openai-compatible';

const EMPTY_USAGE: AgentTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalTokens: 0,
};

/**
 * Render the per-run config.
 *
 * Pure and exported so the shape can be tested without writing a credential to
 * disk — the schema is the fragile part, and a wrong key here fails as
 * "provider not found" long after the fact.
 */
export function buildOpencodeConfig(profile: ProviderProfile, model: string): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [PROVIDER_ID]: {
        npm: OPENAI_COMPATIBLE_ADAPTER,
        name: 'lm-assist harness provider',
        options: { baseURL: profile.baseUrl, apiKey: profile.apiKey },
        // The key IS the model id sent to the endpoint, slashes and all
        // (`vendor/model:free` verified working as `-m <provider>/vendor/model:free`).
        models: { [model]: { name: model } },
      },
    },
  };
}

/**
 * Render a request into `opencode` argv.
 *
 * 🔴 `--dir` is NOT optional here. MEASURED: `opencode` IGNORES the cwd it is
 * spawned with — a child spawned with `cwd: /tmp/…/wk` from a parent sitting in
 * the lm-assist checkout ran the agent in the CHECKOUT. Under `--auto` that is
 * an agent editing a tree nobody asked it to touch, and it fails silently: the
 * run succeeds, it just did its work somewhere else. The directory must
 * therefore always be stated explicitly, never inherited.
 *
 * ⚠️ `opencode run` has NO turn ceiling — nothing corresponds to qwen's
 * `--max-session-turns`, so `request.maxTurns` cannot be honoured and the
 * wall-clock timeout is the ONLY bound on a run. That is a real capability
 * difference, not an oversight; it is why a caller must not assume maxTurns is
 * enforced just because the request carried it.
 */
export function buildOpencodeArgs(request: AgentExecuteRequest, model: string, dir: string): string[] {
  return [
    'run',
    '--format', 'json',
    // --auto auto-approves PERMISSIONS only. Like qwen's yolo it is not a
    // sandbox: opencode still runs shell and edits at this process's privilege.
    '--auto',
    // No external plugins — an agent run triggered through lm-assist should not
    // inherit a developer's local OpenCode setup.
    '--pure',
    '--dir', dir,
    '-m', `${PROVIDER_ID}/${model}`,
    // Everything after `--` is the message. Without it a prompt beginning with a
    // dash is parsed as a flag (verified: `-- "-x say hi"` reaches the model).
    '--',
    request.prompt,
  ];
}

/**
 * Build the child environment.
 *
 * Assembled explicitly rather than by spreading caller-supplied values over
 * process.env, for the same reason as the qwen harness: the generic
 * `options.env` seam has no deny-list, so a caller could override PATH/HOME
 * there, and a harness holding a credential should not also widen that hole.
 */
export function buildOpencodeEnv(configPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCODE_CONFIG: configPath,
    FORCE_COLOR: '0',
  };
}

export interface OpencodeStreamSummary {
  sessionId: string;
  text: string;
  numTurns: number;
  toolCalls: number;
  errored: boolean;
  errorText?: string;
  usage: AgentTokenUsage;
  /** False when no step reported tokens — 0 then means "unknown", not "free". */
  usageReported: boolean;
}

/**
 * Fold opencode's NDJSON into a summary.
 *
 * Framing follows the qwen parser: split on '\n' ONLY (a raw U+2028 is legal
 * inside a JSON string and a generic line reader would corrupt the frame), and
 * skip a malformed line rather than losing the whole run.
 */
export function parseOpencodeStream(stdout: string): OpencodeStreamSummary {
  const out: OpencodeStreamSummary = {
    sessionId: '',
    text: '',
    numTurns: 0,
    toolCalls: 0,
    errored: false,
    usage: { ...EMPTY_USAGE },
    usageReported: false,
  };

  // Text is collected PER STEP and the last step's wins. A multi-step run emits
  // the model's intermediate commentary as `text` too, so joining everything
  // returns the reasoning-out-loud along with the answer; taking only the last
  // event would instead split an answer that arrived as several parts.
  let stepTexts: string[] = [];
  let lastStepTexts: string[] = [];

  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

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

    if (event.sessionID && !out.sessionId) out.sessionId = String(event.sessionID);
    const part = event.part ?? {};

    switch (event.type) {
      case 'step_start':
        stepTexts = [];
        break;

      case 'text':
        if (typeof part.text === 'string') stepTexts.push(part.text);
        break;

      case 'tool_use':
        out.toolCalls += 1;
        break;

      case 'step_finish': {
        out.numTurns += 1;
        if (stepTexts.length) lastStepTexts = stepTexts;
        const t = part.tokens;
        if (t && typeof t === 'object') {
          out.usageReported = true;
          out.usage.inputTokens += num(t.input);
          // 🔴 `reasoning` is counted as output. MEASURED: this gateway model
          // reports `output: 0, reasoning: 82` for a step that plainly generated
          // text, so dropping reasoning would report a run that produced nothing.
          out.usage.outputTokens += num(t.output) + num(t.reasoning);
          out.usage.cacheCreationInputTokens += num(t.cache?.write);
          out.usage.cacheReadInputTokens += num(t.cache?.read);
          out.usage.totalTokens = out.usage.inputTokens + out.usage.outputTokens;
        }
        break;
      }

      case 'error':
        out.errored = true;
        out.errorText =
          event.error?.data?.message || event.error?.name || 'opencode reported an error';
        break;
    }
  }

  // A run cut short (abort, timeout) never reaches a step_finish, so fall back to
  // whatever the current step had produced rather than returning nothing.
  out.text = (lastStepTexts.length ? lastStepTexts : stepTexts).join('\n').trim();
  return out;
}

async function probeOpencode(): Promise<HarnessProbe> {
  return new Promise((resolve) => {
    const child = spawn('opencode', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.on('error', () =>
      resolve({ available: false, reason: '`opencode` not found on PATH. Install with: npm i -g opencode-ai' })
    );
    child.on('close', (code) =>
      resolve(
        code === 0
          ? { available: true, version: out.trim(), binary: 'opencode' }
          : { available: false, reason: `\`opencode --version\` exited ${code}` }
      )
    );
  });
}

export function createOpencodeHarness(): AgentHarness {
  /** Live runs by executionId — see the qwen harness for why abort needs this. */
  const live = new Map<string, ChildProcess>();

  return {
    id: OPENCODE_ID,
    displayName: 'OpenCode',
    capabilities: {
      // opencode DOES report a `cost` per step, but for a custom provider it has
      // no rate card and reports 0 — the same "unknown pricing looks free" trap
      // this codebase already closed for unknown Claude models. Token counts are
      // real; the price is not, so we decline to state one.
      cost: 'unavailable',
      // `opencode run --session <id>` exists, but this harness does not implement
      // resume(). The capability describes what the HARNESS does, not the CLI.
      sessionResume: false,
      mcp: false,
      permissionBroker: false,
      durableBackground: false,
      usesProviderProfile: true,
      abortable: true,
    },
    probe: probeOpencode,

    abort(executionId: string): boolean {
      const child = live.get(executionId);
      if (!child) return false;
      // Removal is left to the close handler: until the child is actually gone it
      // is still live, and dropping it here would make a second abort claim there
      // was nothing to stop.
      return terminateRun(child);
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

      // Refuse rather than fall back — running a Claude agent for a request that
      // named a gateway harness is the silent substitution this work removes.
      if (!profile) {
        return base(
          'No harness provider profile configured. Set one with PUT /harness/provider/:name ' +
            `or via ${'LM_HARNESS_'}BASE_URL + ${'LM_HARNESS_'}API_KEY.`
        );
      }

      const model = request.model || profile.model;
      if (!model) return base(`Provider profile "${profile.name}" has no model and the request named none.`);

      // One temp dir per run. mkdtemp gives 0700; the config inside is 0600
      // because it holds the credential.
      let configDir: string;
      let configPath: string;
      try {
        configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-harness-opencode-'));
        configPath = path.join(configDir, 'opencode.json');
        fs.writeFileSync(configPath, JSON.stringify(buildOpencodeConfig(profile, model), null, 2), { mode: 0o600 });
      } catch (err) {
        return base(`Could not write the opencode provider config: ${err instanceof Error ? err.message : String(err)}`);
      }

      const cleanup = () => {
        try {
          fs.rmSync(configDir, { recursive: true, force: true });
        } catch {
          // Best effort. A leftover file in a 0700 temp dir is bad enough to try
          // for, not bad enough to fail a completed run over.
        }
      };

      // Resolved once and passed BOTH as --dir and as the spawn cwd: --dir is what
      // opencode actually honours, the cwd keeps anything else the child does
      // (and any error message quoting it) consistent with that.
      const dir = request.cwd || process.cwd();
      const args = buildOpencodeArgs(request, model, dir);
      const timeoutMs = request.timeout ?? DEFAULT_TIMEOUT_MS;

      return new Promise<AgentExecuteResponse>((resolve) => {
        const child = spawn('opencode', args, {
          cwd: dir,
          env: buildOpencodeEnv(configPath),
          stdio: ['ignore', 'pipe', 'pipe'],
          // Own process group: opencode starts a local server subprocess, so
          // killing only the top-level process would strand it.
          detached: true,
        });
        live.set(executionId, child);

        let stdout = '';
        let stderr = '';
        let settled = false;

        // A timed-out run still HAPPENED — it burned tokens and may hold most of
        // an answer — so report what was collected instead of an empty failure.
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          terminateRun(child);
          const partial = parseOpencodeStream(stdout);
          resolve({
            ...base(`Timed out after ${timeoutMs}ms`),
            result: partial.text,
            sessionId: partial.sessionId,
            numTurns: partial.numTurns,
            usage: partial.usage,
            modelUsage: partial.usageReported ? { [model]: { ...partial.usage } } : {},
            durationMs: Date.now() - start,
            runner: OPENCODE_ID,
          });
        }, timeoutMs);

        child.stdout?.on('data', (d) => (stdout += d.toString()));
        child.stderr?.on('data', (d) => (stderr += d.toString()));

        child.on('error', (err) => {
          live.delete(executionId);
          cleanup();
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            ...base(`Failed to launch opencode: ${err.message}. Install with: npm i -g opencode-ai`),
            runner: OPENCODE_ID,
          });
        });

        child.on('close', (code, signal) => {
          live.delete(executionId);
          // Only now: opencode re-reads its config while disposing the instance,
          // so removing the file earlier would race a still-running child.
          cleanup();
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          const summary = parseOpencodeStream(stdout);
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
            usage: summary.usage,
            modelUsage: summary.usageReported ? { [model]: { ...summary.usage } } : {},
            runner: OPENCODE_ID,
            ...(ok
              ? {}
              : {
                  error:
                    summary.errorText ||
                    stderr.trim().slice(0, 2000) ||
                    (signal ? `opencode terminated by ${signal}` : `opencode exited with code ${code}`),
                }),
          });
        });
      });
    },
  };
}
