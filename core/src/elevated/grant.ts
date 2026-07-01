/**
 * Grant + lifecycle helpers for the Windows elevated worker (Core side).
 *
 * The ONLY elevation prompt in this whole feature is `grantCommand()`: a single
 * elevated PowerShell that registers the `LmAssistElevatedWorker` Scheduled Task
 * with RunLevel=Highest. After that one grant, starting/triggering the worker
 * and sending it commands never prompt UAC (the task runs highest-privilege
 * on-demand and at logon).
 *
 * Everything here is WINDOWS-ONLY. Callers must platform-gate; these functions
 * shell out to Windows tools (schtasks) and will simply fail on other platforms.
 */
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { apiTokenFilePath } from '../auth/api-token';
import { ELEVATED_TASK_NAME, elevatedPort, ELEVATED_HOST } from './common';

const execFileP = promisify(execFile);

/** Absolute path to the compiled worker entrypoint (sibling of this file in dist). */
export function workerScriptPath(): string {
  return path.resolve(__dirname, 'worker.js');
}

/** The working directory the task runs in — the compiled `core/` root. */
export function workerWorkingDir(): string {
  // __dirname = <...>/core/dist/elevated  →  up two = <...>/core/dist ; the
  // node_modules the worker needs resolve from core/, so use core/ as cwd.
  return path.resolve(__dirname, '../..');
}

/** The node executable that will run the worker. */
export function nodeExecPath(): string {
  return process.execPath;
}

/**
 * Is the scheduled task registered? `schtasks /query` exits non-zero when the
 * task does not exist, which we map to false.
 */
export async function isGranted(): Promise<boolean> {
  try {
    await execFileP('schtasks', ['/query', '/tn', ELEVATED_TASK_NAME], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The exact elevated PowerShell script that registers the task. A route runs
 * this via `Start-Process -Verb RunAs` so it triggers the SINGLE UAC prompt.
 * Idempotent: it deletes any prior task first, then re-registers (-Force).
 *
 * The task: RunLevel=Highest (elevated, no per-run prompt), AtLogon trigger for
 * the current user PLUS on-demand start, action = node worker.js --port <port>
 * with the compiled core/ dir as the working directory.
 */
export function grantCommand(): string {
  const node = nodeExecPath();
  const worker = workerScriptPath();
  const wd = workerWorkingDir();
  const port = elevatedPort();
  // PowerShell here uses backtick-escaped double quotes around the worker path.
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$node = ${psQuote(node)}`,
    `$worker = ${psQuote(worker)}`,
    `$wd = ${psQuote(wd)}`,
    `$user = "$env:USERDOMAIN\\$env:USERNAME"`,
    `schtasks /delete /tn ${ELEVATED_TASK_NAME} /f 2>$null | Out-Null`,
    `$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $worker + '" --port ${port}') -WorkingDirectory $wd`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user`,
    `$principal = New-ScheduledTaskPrincipal -UserId $user -RunLevel Highest -LogonType Interactive`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable`,
    `Register-ScheduledTask -TaskName ${ELEVATED_TASK_NAME} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
    `Write-Output 'LmAssistElevatedWorker registered'`,
  ].join('\n');
}

/** Single-quote a string for PowerShell (escape embedded single quotes). */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Start (trigger) the worker via the scheduled task — no UAC once granted. */
export async function startWorker(): Promise<void> {
  await execFileP('schtasks', ['/run', '/tn', ELEVATED_TASK_NAME], { windowsHide: true });
}

/** Stop the worker (best effort) + delete the scheduled task. */
export async function revoke(): Promise<void> {
  // Best-effort stop of the running instance.
  try {
    await execFileP('schtasks', ['/end', '/tn', ELEVATED_TASK_NAME], { windowsHide: true });
  } catch {
    /* task may not be running */
  }
  await execFileP('schtasks', ['/delete', '/tn', ELEVATED_TASK_NAME, '/f'], { windowsHide: true });
}

export interface WorkerHealth {
  ok: boolean;
  elevated?: boolean;
  integrity?: string;
  pid?: number;
  since?: string;
  port?: number;
}

/** GET the worker's /health (tokenless). Returns { ok:false } if unreachable. */
export async function workerHealth(timeoutMs = 2000): Promise<WorkerHealth> {
  const port = elevatedPort();
  try {
    const res = await fetch(`http://${ELEVATED_HOST}:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false };
    return (await res.json()) as WorkerHealth;
  } catch {
    return { ok: false };
  }
}

/** For diagnostics/reporting — the token file the worker authenticates against. */
export function tokenFileForReport(): string {
  return apiTokenFilePath();
}
