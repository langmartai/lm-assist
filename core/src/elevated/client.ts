/**
 * Non-elevated client for the elevated worker (Core side).
 *
 * The Core runs NON-elevated. To run an elevated command it POSTs here; this
 * module ensures the worker is up (starting it via the granted scheduled task
 * if needed — no UAC once granted) and forwards the command over loopback with
 * the api-token attached.
 *
 * WINDOWS-ONLY. Callers should platform-gate; on other platforms `isGranted()`
 * is false and `elevatedExec` throws ELEVATED_NOT_GRANTED.
 */
import { lmAuthHeaders } from '../auth/api-token';
import { ELEVATED_HOST, elevatedPort, DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS } from './common';
import { isGranted, startWorker, workerHealth } from './grant';

/** Typed error the caller can branch on. */
export class ElevatedError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ElevatedError';
    this.code = code;
  }
}

export interface ElevatedExecInput {
  cmd: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  shell?: 'cmd' | 'powershell';
}

export interface ElevatedExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut?: boolean;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Ensure the worker is reachable: return immediately if up; else, if granted,
 *  trigger it and poll /health for up to ~15s. Throws if it never comes up. */
async function ensureWorkerUp(): Promise<void> {
  if ((await workerHealth()).ok) return;
  if (!(await isGranted())) {
    throw new ElevatedError(
      'ELEVATED_NOT_GRANTED',
      'elevated worker is not granted; run the one-time grant (POST /elevated/grant) first',
    );
  }
  try {
    await startWorker();
  } catch (e) {
    throw new ElevatedError('ELEVATED_START_FAILED', e instanceof Error ? e.message : String(e));
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(500);
    if ((await workerHealth()).ok) return;
  }
  throw new ElevatedError('ELEVATED_UNREACHABLE', 'elevated worker did not become reachable within 15s');
}

/**
 * Run a command in the elevated worker. Ensures the worker is up (starting it if
 * granted), then POSTs /exec with the api-token. Throws ElevatedError with a
 * typed `code` on failure (ELEVATED_NOT_GRANTED / ELEVATED_UNREACHABLE / ...).
 */
export async function elevatedExec(input: ElevatedExecInput): Promise<ElevatedExecResult> {
  const cmd = String(input.cmd || '').trim();
  if (!cmd) throw new ElevatedError('BAD_REQUEST', '`cmd` is required');

  await ensureWorkerUp();

  let timeoutMs = Number(input.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_EXEC_TIMEOUT_MS;
  timeoutMs = Math.min(timeoutMs, MAX_EXEC_TIMEOUT_MS);

  const body: ElevatedExecInput = { cmd };
  if (Array.isArray(input.args)) body.args = input.args.map(String);
  if (input.cwd) body.cwd = String(input.cwd);
  if (input.shell === 'powershell') body.shell = 'powershell';
  body.timeoutMs = timeoutMs;

  const port = elevatedPort();
  let res: Response;
  try {
    res = await fetch(`http://${ELEVATED_HOST}:${port}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...lmAuthHeaders() },
      body: JSON.stringify(body),
      // client-side ceiling a bit above the worker's own kill timeout
      signal: AbortSignal.timeout(timeoutMs + 10_000),
    });
  } catch (e) {
    throw new ElevatedError('ELEVATED_TRANSPORT', e instanceof Error ? e.message : String(e));
  }

  const json = (await res.json()) as { ok?: boolean; error?: { code?: string; message?: string } } & ElevatedExecResult;
  if (res.status === 401) {
    throw new ElevatedError('UNAUTHORIZED', json.error?.message || 'worker rejected the api token');
  }
  if (!res.ok || json.ok === false) {
    throw new ElevatedError(json.error?.code || 'ELEVATED_EXEC_FAILED', json.error?.message || `exec returned ${res.status}`);
  }
  return {
    exitCode: json.exitCode,
    stdout: json.stdout,
    stderr: json.stderr,
    elapsedMs: json.elapsedMs,
    timedOut: json.timedOut,
  };
}
