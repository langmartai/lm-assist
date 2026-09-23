/**
 * The run recorder — wraps every registered harness so each run leaves a
 * durable record, a redacted capture of its stream and a redacted prompt.
 *
 * Applied inside registerHarness(), not at each call site: harness.execute has
 * two callers in agent-api (foreground, awaited; background, not awaited) and a
 * decorator sees both, sees a rejection before agent-api's catch strips the
 * runner from it, and still sees the final response after a background abort
 * has deleted the in-memory entry. It must NOT import registry.ts (registry
 * imports this module).
 *
 * The contract with the caller is that recording is invisible: the inner
 * response is returned BY IDENTITY, a rejection is re-thrown unchanged, and no
 * store, filesystem or observer failure can alter either. The only behaviour
 * this adds is refusing an executionId that is invalid (it becomes a directory
 * name) or already used (it would overwrite another run's record and dir).
 */

import * as fs from 'fs';
import * as path from 'path';
import { isDevRepo } from '../utils/path-utils';
import type { AgentExecuteRequest, AgentExecuteResponse, AgentTokenUsage } from '../types/agent-api';
import type { AgentHarness, HarnessRunHooks } from './types';
import { RUN_ID_RE, RUN_LIMITS, type HarnessRunRecord, type HarnessRunStatus, type HarnessTermination } from './run-types';
import { harnessRunDir, harnessRunsRoot, relativeRunDir } from './run-paths';
import { collectSecrets, redactString } from './redact';
import {
  clearInFlight,
  getRun,
  hasRun,
  isRunInFlight,
  logRunStoreFailure,
  markInFlight,
  maybeCompact,
  patchRun,
  selfStartTicks,
  sourceRefFor,
  startRun,
} from './run-store';
import { opencodeDbPath, summarizeRun } from './transcript';

const RECORDED = Symbol.for('lm.harness.recorded');

/** Mirrors the harnesses' own default, so a record states the bound the run actually had. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

const EMPTY_USAGE: AgentTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalTokens: 0,
};

/** Where each runner prints its session id, so the record gets it at the first frame, not at the end. */
const SESSION_ID_RES: Record<string, RegExp> = {
  qwen: /"session_id"\s*:\s*"([A-Za-z0-9-]{8,64})"/,
  opencode: /"sessionID"\s*:\s*"(ses_[A-Za-z0-9]{8,64})"/,
};

type SettleInfo = Parameters<NonNullable<HarnessRunHooks['onSettle']>>[0];

/**
 * Runs an abort was actually delivered to, held in memory as well as stamped
 * on the record: a run on a node whose index cannot be written must still be
 * reported `aborted`, not `failed`, to the rest of this process.
 */
const abortRequested = new Set<string>();

/** §3.4 — the terminal status a settled run is recorded with. Order matters. */
export function terminalStatus(i: { termination?: HarnessTermination; abortRequested: boolean; success: boolean }): HarnessRunStatus {
  if (i.termination === 'config_error') return 'refused';
  if (i.termination === 'launch_error' || i.termination === 'spawn_throw') return 'launch_failed';
  if (i.abortRequested && !i.success) return 'aborted';
  if (i.termination === 'timeout') return 'timed_out';
  if (i.success) return 'succeeded';
  return 'failed';
}

/** The response a refused executionId gets: shaped like every other harness failure, never recorded. */
export function refusalResponse(runner: string, executionId: unknown, error: string): AgentExecuteResponse {
  return {
    success: false,
    result: '',
    sessionId: '',
    executionId: String(executionId),
    durationMs: 0,
    durationApiMs: 0,
    numTurns: 0,
    totalCostUsd: 0,
    usage: { ...EMPTY_USAGE },
    modelUsage: {},
    runner,
    error,
  };
}

export function invalidExecutionIdError(id: unknown): string {
  return `INVALID_EXECUTION_ID: ${JSON.stringify(String(id).slice(0, 80))} must match ${RUN_ID_RE.source} ` +
    '(it names the run\'s directory)';
}

export function duplicateExecutionIdError(id: string): string {
  return `DUPLICATE_EXECUTION_ID: ${JSON.stringify(id.slice(0, 80))} was already used on this node — use a new executionId`;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * Line-buffered, redacted, bounded capture of a run's stdout into
 * `<runDir>/stdout.log`, one `<epochMs>\t<line>` per line.
 *
 * Every line is redacted BEFORE it is written: the stream is where a key lands
 * if an agent runs `env`. A single line over 1 MB becomes a marker rather than
 * a megabyte of one frame, and writing stops at 8 MB (the run itself is not
 * affected — only the record of it is truncated, and says so).
 */
class CaptureWriter {
  bytes = 0;
  lines = 0;
  truncated = false;
  private fd: number | undefined;
  private partial = '';
  private oversizeBytes = 0;
  private sawFirstLine = false;
  private sessionFound = false;

  constructor(
    file: string | null,
    private readonly id: string,
    private readonly secrets: string[],
    private readonly sessionRe: RegExp[],
    private readonly onFirstLine: (sessionId: string | undefined) => void,
    private readonly onSessionId: (sessionId: string) => void,
  ) {
    if (!file) return;
    try {
      this.fd = fs.openSync(file, 'a', 0o600);
    } catch (err) {
      logRunStoreFailure('capture-open', id, err);
    }
  }

  write(chunk: string): void {
    if (typeof chunk !== 'string' || !chunk) return;
    let text = this.partial + chunk;
    this.partial = '';
    let nl: number;
    while ((nl = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, nl);
      text = text.slice(nl + 1);
      if (this.oversizeBytes) {
        this.emitOversize(this.oversizeBytes + Buffer.byteLength(line));
        this.oversizeBytes = 0;
      } else {
        this.emitLine(line);
      }
    }
    // A line still growing past the cap is dropped as it arrives rather than
    // held: a frame with no newline must not buffer without bound.
    if (text.length > RUN_LIMITS.captureLineMaxBytes || this.oversizeBytes) {
      this.oversizeBytes += Buffer.byteLength(text);
    } else {
      this.partial = text;
    }
  }

  close(): void {
    if (this.oversizeBytes) this.emitOversize(this.oversizeBytes);
    else if (this.partial) this.emitLine(this.partial);
    this.partial = '';
    this.oversizeBytes = 0;
    if (this.fd !== undefined) {
      try { fs.closeSync(this.fd); } catch { /* already closed */ }
      this.fd = undefined;
    }
  }

  private emitLine(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > RUN_LIMITS.captureLineMaxBytes) {
      this.emitOversize(Buffer.byteLength(line));
      return;
    }
    let sessionId: string | undefined;
    if (!this.sessionFound) {
      for (const re of this.sessionRe) {
        const m = re.exec(line);
        if (m) { sessionId = m[1]; break; }
      }
    }
    if (!this.sawFirstLine) {
      this.sawFirstLine = true;
      if (sessionId) this.sessionFound = true;
      this.onFirstLine(sessionId);
    } else if (sessionId) {
      this.sessionFound = true;
      this.onSessionId(sessionId);
    }
    this.append(redactString(line, this.secrets));
  }

  private emitOversize(bytes: number): void {
    this.append(JSON.stringify({ _lmTruncatedLine: true, bytes }));
  }

  private append(line: string): void {
    if (this.fd === undefined || this.truncated) return;
    const out = `${Date.now()}\t${line}\n`;
    const n = Buffer.byteLength(out);
    if (this.bytes + n > RUN_LIMITS.captureMaxBytes) {
      this.truncated = true;
      return;
    }
    try {
      fs.writeSync(this.fd, out);
      this.bytes += n;
      this.lines += 1;
    } catch (err) {
      logRunStoreFailure('capture-write', this.id, err);
      try { fs.closeSync(this.fd); } catch { /* nothing to do */ }
      this.fd = undefined;
    }
  }
}

/**
 * Create the run dir. The leaf is created WITHOUT `recursive`, so an existing
 * dir is an EEXIST — the filesystem itself refuses a reused executionId even
 * when the index could not be read.
 */
function makeRunDir(id: string): { dir: string | null; duplicate: boolean } {
  try {
    const root = harnessRunsRoot();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(root, 0o700); } catch { /* best effort */ }
  } catch (err) {
    logRunStoreFailure('mkdir-root', id, err);
    return { dir: null, duplicate: false };
  }
  const dir = harnessRunDir(id);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    return { dir, duplicate: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return { dir: null, duplicate: true };
    logRunStoreFailure('mkdir-run', id, err);
    return { dir: null, duplicate: false };
  }
}

async function recordExecute(
  inner: AgentHarness,
  request: AgentExecuteRequest,
  id: string,
  outerHooks?: HarnessRunHooks,
): Promise<AgentExecuteResponse> {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) {
    return refusalResponse(inner.id, id, invalidExecutionIdError(id));
  }
  let known = false;
  try { known = hasRun(id) || isRunInFlight(id); } catch { /* an unreadable index cannot vouch either way */ }
  if (known) return refusalResponse(inner.id, id, duplicateExecutionIdError(id));

  const { dir, duplicate } = makeRunDir(id);
  if (duplicate) return refusalResponse(inner.id, id, duplicateExecutionIdError(id));

  const startedAt = Date.now();
  const secrets = safeSecrets();
  const prompt = typeof request.prompt === 'string' ? request.prompt : '';
  // Redact the WHOLE prompt before cutting it: a key straddling the cut would
  // otherwise survive as a fragment the exact-value rule no longer matches.
  const redactedPrompt = redactString(prompt, secrets);
  if (dir) {
    try {
      fs.writeFileSync(path.join(dir, 'prompt.txt'), redactedPrompt.slice(0, RUN_LIMITS.promptFileChars), { mode: 0o600, flag: 'wx' });
    } catch (err) {
      logRunStoreFailure('prompt-write', id, err);
    }
  }

  const rec: HarnessRunRecord = {
    v: 1,
    id,
    executionId: id,
    runner: inner.id,
    origin: 'recorded',
    inferred: false,
    core: isDevRepo() ? 'dev' : 'prod',
    corePid: process.pid,
    ...(selfStartTicks() !== undefined ? { coreStartTicks: selfStartTicks() } : {}),
    status: 'running',
    background: Boolean(request.background),
    promptPreview: redactedPrompt.trim().slice(0, RUN_LIMITS.promptPreviewChars),
    promptChars: prompt.length,
    cwd: request.cwd || process.cwd(),
    cwdDefaulted: !request.cwd,
    model: typeof request.model === 'string' && request.model ? request.model : null,
    providerProfile: typeof request.providerProfile === 'string' && request.providerProfile ? request.providerProfile : null,
    baseUrlHost: null,
    timeoutMs: request.timeout ?? DEFAULT_TIMEOUT_MS,
    maxTurns: typeof request.maxTurns === 'number' ? request.maxTurns : null,
    maxTurnsEnforced: null,
    startedAt,
    costUsd: null,
    runDir: dir ? relativeRunDir(id) : null,
    ...(inner.id === 'qwen' ? { native: { kind: 'qwen-chat' as const } } : {}),
    updatedAt: startedAt,
  };
  swallow('start', id, () => startRun(rec));
  markInFlight(id);

  const capture = new CaptureWriter(
    dir ? path.join(dir, 'stdout.log') : null,
    id,
    secrets,
    SESSION_ID_RES[inner.id] ? [SESSION_ID_RES[inner.id]] : Object.values(SESSION_ID_RES),
    (sessionId) => swallow('first-output', id, () =>
      patchRun(id, { firstOutputAt: Date.now(), ...(sessionId ? { sessionId } : {}) })),
    (sessionId) => swallow('session-id', id, () => patchRun(id, { sessionId })),
  );

  let settle: SettleInfo | undefined;
  const forward = <A>(fn: ((a: A) => void) | undefined, arg: A) => {
    if (!fn) return;
    try { fn.call(outerHooks, arg); } catch { /* an outer observer cannot change the run either */ }
  };
  const hooks: HarnessRunHooks = {
    onResolved: (i) => {
      swallow('resolved', id, () => patchRun(id, {
        model: i.model,
        providerProfile: i.profileName,
        baseUrlHost: hostOf(i.baseUrl),
        cwd: i.cwd,
        maxTurnsEnforced: i.maxTurnsEnforced,
        ...(inner.id === 'opencode' ? { native: { kind: 'opencode-db' as const, dbPath: opencodeDbPath() } } : {}),
      }));
      forward(outerHooks?.onResolved, i);
    },
    onSpawn: (i) => {
      swallow('spawn', id, () => patchRun(id, { ...(typeof i.pid === 'number' ? { pid: i.pid } : {}), spawnedAt: Date.now() }));
      forward(outerHooks?.onSpawn, i);
    },
    onStdout: (chunk) => {
      try { capture.write(chunk); } catch (err) { logRunStoreFailure('capture', id, err); }
      forward(outerHooks?.onStdout, chunk);
    },
    onSettle: (i) => {
      settle = i;
      forward(outerHooks?.onSettle, i);
    },
  };

  let res: AgentExecuteResponse;
  try {
    res = await inner.execute(request, id, hooks);
  } catch (err) {
    swallow('close', id, () => capture.close());
    swallow('reject', id, () => {
      const endedAt = Date.now();
      patchRun(id, {
        status: 'launch_failed',
        termination: 'spawn_throw',
        endedAt,
        durationMs: endedAt - startedAt,
        error: redactString(err instanceof Error ? err.message : String(err), secrets).slice(0, RUN_LIMITS.errorChars),
        capture: { bytes: capture.bytes, lines: capture.lines, truncated: capture.truncated },
      });
    });
    abortRequested.delete(id);
    clearInFlight(id);
    throw err;
  }

  swallow('close', id, () => capture.close());
  swallow('finish', id, () => finish(id, startedAt, res, settle, capture, secrets));
  abortRequested.delete(id);
  clearInFlight(id);
  swallow('compact', id, () => maybeCompact());
  const imm = setImmediate(() => swallow('enrich', id, () => enrich(id)));
  imm.unref?.();
  return res;
}

function finish(
  id: string,
  startedAt: number,
  res: AgentExecuteResponse,
  settle: SettleInfo | undefined,
  capture: CaptureWriter,
  secrets: string[],
): void {
  const endedAt = Date.now();
  const rec = getRun(id);
  const usage = res.usage ?? EMPTY_USAGE;
  const patch: Partial<HarnessRunRecord> = {
    status: terminalStatus({
      termination: settle?.termination,
      abortRequested: Boolean(rec?.abortRequestedAt) || abortRequested.has(id),
      success: res.success === true,
    }),
    endedAt,
    durationMs: endedAt - startedAt,
    numTurns: typeof res.numTurns === 'number' ? res.numTurns : 0,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      reasoningTokens: null,
      cacheReadTokens: usage.cacheReadInputTokens ?? 0,
      cacheWriteTokens: usage.cacheCreationInputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      // The harnesses key modelUsage only when the stream reported usage, so
      // an empty map is how "0 tokens" is told apart from "never said".
      reported: Object.keys(res.modelUsage || {}).length > 0,
    },
    capture: { bytes: capture.bytes, lines: capture.lines, truncated: capture.truncated },
  };
  if (settle) {
    patch.termination = settle.termination;
    if (settle.exitCode !== undefined) patch.exitCode = settle.exitCode;
    if (settle.signal !== undefined) patch.signal = settle.signal;
  }
  const toolCalls = (res as unknown as { toolCalls?: unknown }).toolCalls;
  if (typeof toolCalls === 'number') patch.toolCalls = toolCalls;
  if (typeof res.result === 'string' && res.result) {
    patch.resultPreview = redactString(res.result, secrets).slice(0, RUN_LIMITS.resultPreviewChars);
  }
  if (typeof res.error === 'string' && res.error) {
    patch.error = redactString(res.error, secrets).slice(0, RUN_LIMITS.errorChars);
  }
  if (!rec?.sessionId && typeof res.sessionId === 'string' && res.sessionId) patch.sessionId = res.sessionId;
  patchRun(id, patch);
}

/**
 * Fill in what only the transcript knows — tool counts by name, files touched,
 * reasoning tokens, CLI version. Runs after the response has been returned, so
 * reading a transcript never delays the caller.
 */
function enrich(id: string): void {
  const rec = getRun(id);
  if (!rec) return;
  const e = summarizeRun(sourceRefFor(rec, false));
  const secrets = safeSecrets();
  // No readable transcript → the tool fields stay unset (unknown), never a written 0.
  const tools: Partial<HarnessRunRecord> = typeof e.toolCalls === 'number'
    ? {
        toolCalls: e.toolCalls,
        toolErrors: e.toolErrors ?? 0,
        toolsByName: Object.fromEntries(
          Object.entries(e.toolsByName ?? {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, RUN_LIMITS.toolsByNameMax),
        ),
      }
    : {};
  patchRun(id, {
    ...tools,
    filesTouched: (e.filesTouched ?? []).slice(0, RUN_LIMITS.filesTouchedMax).map((f) => redactString(f, secrets)),
    ...(rec.usage ? { usage: { ...rec.usage, reasoningTokens: e.reasoningTokens } } : {}),
    ...(e.cliVersion ? { cliVersion: e.cliVersion } : {}),
    ...(!rec.sessionId && e.sessionId ? { sessionId: e.sessionId } : {}),
    ...(!rec.model && e.model ? { model: e.model } : {}),
  });
}

function safeSecrets(): string[] {
  try {
    return collectSecrets();
  } catch {
    return [];
  }
}

function swallow(cls: string, id: string, fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    logRunStoreFailure(cls, id, err);
  }
}

/**
 * Wrap a harness so its runs are recorded. Idempotent: wrapping twice (a
 * re-registration of an already-wrapped harness) returns the same object.
 *
 * `abort` is defined only when the inner harness has one — a recorder must not
 * make a non-abortable harness look abortable — and stays synchronous when the
 * inner one is, because the background wrapper in agent-api reads its return
 * value directly.
 */
export function withRunRecording(inner: AgentHarness): AgentHarness {
  if ((inner as unknown as Record<symbol, unknown>)[RECORDED]) return inner;
  const outer: AgentHarness = {
    ...inner,
    execute: (request, executionId, hooks) => recordExecute(inner, request, executionId, hooks),
  };
  if (inner.abort) {
    const innerAbort = inner.abort.bind(inner);
    const stamp = (executionId: string) => {
      if (isRunInFlight(executionId)) abortRequested.add(executionId);
      swallow('abort-stamp', executionId, () => patchRun(executionId, { abortRequestedAt: Date.now() }));
    };
    outer.abort = (executionId: string) => {
      const r = innerAbort(executionId);
      if (r === true) {
        stamp(executionId);
      } else if (r && typeof (r as Promise<boolean>).then === 'function') {
        return (r as Promise<boolean>).then((v) => {
          if (v === true) stamp(executionId);
          return v;
        });
      }
      return r;
    };
  } else {
    delete outer.abort;
  }
  Object.defineProperty(outer, RECORDED, { value: true, enumerable: false });
  return outer;
}
