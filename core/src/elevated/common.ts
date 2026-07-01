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
