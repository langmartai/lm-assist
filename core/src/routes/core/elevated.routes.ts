/**
 * Elevated worker routes (WINDOWS-ONLY).
 *
 *   GET  /elevated/status  → platform/support/grant/worker state
 *   POST /elevated/grant   → one-time Scheduled-Task registration (SINGLE UAC)
 *   POST /elevated/exec    → run a command elevated via the worker
 *   POST /elevated/revoke  → stop worker + delete the task
 *
 * On non-Windows every route returns { success:false, error:{ code:
 * 'UNSUPPORTED_PLATFORM' } } — no crash.
 *
 * Route return convention (mirrors github/whatsapp routes): `success` drives the
 * HTTP status (200 vs 400); a typed `error.code` in the body distinguishes the
 * failure (e.g. ELEVATED_NOT_GRANTED, the "409-not-granted" case for /exec).
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { IS_WINDOWS, ELEVATED_TASK_NAME, elevatedPort, elevatedDir, auditFilePath } from '../../elevated/common';
import { isGranted, grantCommand, revoke, workerHealth } from '../../elevated/grant';
import { elevatedExec, ElevatedError } from '../../elevated/client';

const execFileP = promisify(execFile);

function unsupported() {
  return {
    success: false,
    error: { code: 'UNSUPPORTED_PLATFORM', message: 'the elevated worker is only supported on Windows' },
  };
}

/** Best-effort count of audit records (informational). */
function auditCount(): number | undefined {
  try {
    const c = fs.readFileSync(auditFilePath(), 'utf8');
    return c.split('\n').filter((l) => l.trim()).length;
  } catch {
    return undefined;
  }
}

export function createElevatedRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // ─── GET /elevated/status ──────────────────────────────────────────────
    {
      method: 'GET',
      pattern: /^\/elevated\/status$/,
      handler: async () => {
        if (!IS_WINDOWS) {
          return { success: true, data: { platform: process.platform, supported: false, granted: false, workerUp: false } };
        }
        const granted = await isGranted();
        const health = await workerHealth();
        return {
          success: true,
          data: {
            platform: process.platform,
            supported: true,
            granted,
            workerUp: !!health.ok,
            elevated: health.elevated ?? null,
            integrity: health.integrity ?? null,
            port: elevatedPort(),
            taskName: ELEVATED_TASK_NAME,
            pendingAudit: auditCount(),
          },
        };
      },
    },

    // ─── POST /elevated/grant ──────────────────────────────────────────────
    // Writes the grant script and runs it via Start-Process -Verb RunAs — the
    // SINGLE UAC prompt. Idempotent (the script deletes + re-registers).
    {
      method: 'POST',
      pattern: /^\/elevated\/grant$/,
      handler: async () => {
        if (!IS_WINDOWS) return unsupported();
        if (await isGranted()) {
          return { success: true, data: { granted: true, hint: 'already granted (task exists)' } };
        }
        const script = grantCommand();
        fs.mkdirSync(elevatedDir(), { recursive: true });
        const scriptPath = path.join(elevatedDir(), `grant-${Date.now()}.ps1`);
        fs.writeFileSync(scriptPath, script, { encoding: 'utf8' });

        // Launcher: elevate the grant script with a single UAC shield and wait.
        const launcher =
          `Start-Process powershell -Verb RunAs -Wait -ArgumentList ` +
          `'-NoProfile','-ExecutionPolicy','Bypass','-File','${scriptPath.replace(/'/g, "''")}'`;
        try {
          await execFileP('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launcher], {
            windowsHide: true,
            timeout: 180_000,
          });
        } catch (e) {
          return {
            success: false,
            error: {
              code: 'ELEVATED_GRANT_FAILED',
              message: e instanceof Error ? e.message : String(e),
            },
            data: { scriptPath },
          };
        }
        const granted = await isGranted();
        return {
          success: granted,
          data: {
            granted,
            hint: granted
              ? 'task registered; the worker starts at next logon and can be started on demand'
              : 'grant launcher returned but the task is not present — check whether the UAC prompt was approved',
            scriptPath,
          },
          ...(granted ? {} : { error: { code: 'ELEVATED_GRANT_INCOMPLETE', message: 'task not registered after grant' } }),
        };
      },
    },

    // ─── POST /elevated/exec ───────────────────────────────────────────────
    {
      method: 'POST',
      pattern: /^\/elevated\/exec$/,
      handler: async (req: ParsedRequest) => {
        if (!IS_WINDOWS) return unsupported();
        const body = (req.body || {}) as Record<string, unknown>;
        const cmd = String(body.cmd || '').trim();
        if (!cmd) return { success: false, error: { code: 'BAD_REQUEST', message: '`cmd` is required' } };
        try {
          const result = await elevatedExec({
            cmd,
            args: Array.isArray(body.args) ? (body.args as unknown[]).map(String) : undefined,
            cwd: body.cwd ? String(body.cwd) : undefined,
            timeoutMs: body.timeoutMs !== undefined ? Number(body.timeoutMs) : undefined,
            shell: body.shell === 'powershell' ? 'powershell' : undefined,
          });
          return { success: true, data: result };
        } catch (e) {
          if (e instanceof ElevatedError) {
            return { success: false, error: { code: e.code, message: e.message } };
          }
          return { success: false, error: { code: 'ELEVATED_EXEC_FAILED', message: e instanceof Error ? e.message : String(e) } };
        }
      },
    },

    // ─── POST /elevated/revoke ─────────────────────────────────────────────
    {
      method: 'POST',
      pattern: /^\/elevated\/revoke$/,
      handler: async () => {
        if (!IS_WINDOWS) return unsupported();
        try {
          await revoke();
          return { success: true, data: { granted: false, hint: 'worker stopped (best effort) and task deleted' } };
        } catch (e) {
          return { success: false, error: { code: 'ELEVATED_REVOKE_FAILED', message: e instanceof Error ? e.message : String(e) } };
        }
      },
    },
  ];
}
