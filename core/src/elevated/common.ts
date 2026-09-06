/**
 * Shared constants + paths for the Windows elevated-worker feature.
 *
 * The elevated worker is a WINDOWS-ONLY, standalone (out-of-Core) resident
 * process that runs at HIGH integrity. The non-elevated Core talks to it over
 * loopback so it can run elevated commands (restarting the elevated prod Core
 * is its whole reason to exist) WITHOUT a per-command UAC prompt — the single
 * UAC prompt is the one-time Scheduled-Task registration.
 *
 * This module holds only pure constants + path helpers so it can be imported by
 * BOTH the standalone worker (which must not pull in Core services) and the
 * in-Core client / routes.
 */
import * as path from 'path';
import { getDataDir } from '../utils/path-utils';

/** The scheduled task registered by the one-time grant. */
export const ELEVATED_TASK_NAME = 'LmAssistElevatedWorker';

/** Default loopback port for the worker command channel. */
export const DEFAULT_ELEVATED_PORT = 3110;

/** Loopback host — NEVER 0.0.0.0. This is a local privilege-escalation surface. */
export const ELEVATED_HOST = '127.0.0.1';

/** Resolve the worker port: env override wins, else the default. */
export function elevatedPort(): number {
  const v = Number(process.env.LM_ELEVATED_PORT);
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : DEFAULT_ELEVATED_PORT;
}

/** `<dataDir>/elevated` — all worker-owned files live here. */
export function elevatedDir(): string {
  return path.join(getDataDir(), 'elevated');
}

export function auditFilePath(): string {
  return path.join(elevatedDir(), 'audit.jsonl');
}

export function workerLogPath(): string {
  return path.join(elevatedDir(), 'worker.log');
}

export function pidFilePath(): string {
  return path.join(elevatedDir(), 'worker.pid');
}

/** Timeout clamps for /exec (ms). */
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const MAX_EXEC_TIMEOUT_MS = 600_000;

export const IS_WINDOWS = process.platform === 'win32';

// ─── command-line assembly (pure; unit-tested) ────────────────────────────

export type ElevatedShell = 'cmd' | 'powershell';

/**
 * Quote ONE argument for cmd.exe so it reaches the program as a single argv
 * entry and is NOT re-interpreted by cmd's parser.
 *
 * Rules (CommandLineToArgvW + cmd.exe metacharacters):
 *   - a plain token ([A-Za-z0-9_\-./:=@+,\\]) passes through untouched;
 *   - anything else is wrapped in double quotes — inside quotes cmd.exe stops
 *     treating | < > & ^ ( ) and whitespace as syntax;
 *   - an embedded double quote becomes \" (CommandLineToArgvW), and the run of
 *     backslashes before it is doubled so it is not eaten as an escape;
 *   - `%` is left alone: cmd expands %VAR% even inside quotes, and doubling it
 *     (%%) is only honoured in batch files, not on a /c command line. Callers
 *     that need a literal % should use shell:'powershell'.
 */
export function quoteCmdArg(arg: string): string {
  if (arg === '') return '""';
  if (/^[A-Za-z0-9_\-./:=@+,\\]+$/.test(arg)) return arg;
  // \" escaping per CommandLineToArgvW: double every backslash run that precedes a quote
  let out = '';
  let bs = 0;
  for (const ch of arg) {
    if (ch === '\\') { bs++; continue; }
    if (ch === '"') { out += '\\'.repeat(bs * 2 + 1) + '"'; bs = 0; continue; }
    out += '\\'.repeat(bs) + ch; bs = 0;
  }
  // trailing backslashes before the closing quote must be doubled too
  out += '\\'.repeat(bs * 2);
  return `"${out}"`;
}

/** Quote ONE argument for PowerShell: single-quoted literal, embedded ' doubled. */
export function quotePwshArg(arg: string): string {
  if (arg === '') return "''";
  if (/^[A-Za-z0-9_\-./:=@+,\\]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "''")}'`;
}

/**
 * The full command line the elevated worker hands to the shell.
 *
 * CONTRACT (documented on elevated_exec):
 *   - `cmd` is passed VERBATIM — it is the shell command line, so pipes,
 *     redirects, `&&`, and a pre-quoted `bash -c "…"` all work exactly as typed
 *     at a prompt. Quote it yourself as you would in that shell.
 *   - each `args[i]` is ONE argument: it is quoted per-arg for the chosen shell
 *     so spaces, quotes and | > & inside it are data, never syntax.
 *
 * Before this the args were `join(' ')`-ed raw, so `args:["a b"]` became two
 * words and `args:["|"]` became a pipe (observed 2026-09 driving 107 through
 * the connector); the only way to pass a multi-word remote command was to
 * pre-quote the whole thing into `cmd` — which still works, and is now the
 * documented path for shell syntax.
 */
export function buildShellCommandLine(cmd: string, args: string[], shell: ElevatedShell): string {
  const q = shell === 'powershell' ? quotePwshArg : quoteCmdArg;
  const parts = args.map(q);
  return parts.length ? `${cmd} ${parts.join(' ')}` : cmd;
}

