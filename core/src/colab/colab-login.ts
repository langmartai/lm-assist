/**
 * Guided OAuth2 & ADC login flow for Google Colab CLI (`google-colab-cli`).
 *
 * Upstream `google-colab-cli` has no `colab login` subcommand: invoking any
 * authenticated command (such as `colab whoami`) triggers Google's remote
 * copy-paste OAuth2 flow (`_run_remote_flow` -> prints an authorization URL on
 * `https://accounts.google.com/o/oauth2/...` and reads an authorization code
 * from stdin), or instructs `--auth=adc` users to run `gcloud auth
 * application-default login`.
 *
 * This module splits the interactive OAuth2 prompt into two stateless HTTP/MCP
 * steps (`startColabLogin` -> returns `authUrl` + `loginId`; `completeColabLogin`
 * -> feeds the pasted authorization `code` to the waiting child stdin) and
 * reports credential & keyring status cleanly without ever logging secrets.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import type { EventEmitter } from 'node:events';
import {
  buildGlobalArgs,
  redactColabText,
  resolveColabBinary,
  type ColabActionResult,
  type ColabAuthMode,
} from './colab-service';

export const ADC_LOGIN_COMMAND =
  'gcloud auth application-default login --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory';

const LOGIN_TTL_MS = 5 * 60_000;
const MAX_PENDING_LOGINS = 5;

export interface ColabChildLike extends EventEmitter {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type ColabSpawnFn = (
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] },
) => ColabChildLike;

interface PendingColabLogin {
  loginId: string;
  child: ColabChildLike;
  expiresAt: number;
  createdAt: number;
  auth: ColabAuthMode;
  globalArgs: string[];
  stdout: string;
  stderr: string;
  exited: boolean;
  exitCode: number | null;
}

const pendingLogins = new Map<string, PendingColabLogin>();

function reapExpiredLogins(): void {
  const now = Date.now();
  for (const [id, entry] of pendingLogins.entries()) {
    if (entry.expiresAt <= now || entry.exited) {
      pendingLogins.delete(id);
      if (!entry.exited) {
        try {
          entry.child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  }
}

export function clearPendingColabLogins(): void {
  for (const [, entry] of pendingLogins.entries()) {
    try {
      entry.child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
  pendingLogins.clear();
}

export function parseColabWhoami(text: string): {
  email: string | null;
  provider: string | null;
  expiresIn: string | null;
  scopes: string[];
} {
  const providerMatch = text.match(/^\s*Auth provider:\s*(.+)$/im);
  const emailMatch = text.match(/^\s*Email:\s*(.+)$/im);
  const expiresMatch = text.match(/^\s*Expires in:\s*(.+)$/im);

  const rawEmail = emailMatch ? emailMatch[1].trim() : '';
  const rawExpires = expiresMatch ? expiresMatch[1].trim() : '';
  const email = rawEmail && !rawEmail.startsWith('<') ? rawEmail : null;
  const expiresIn = rawExpires && !rawExpires.startsWith('<') ? rawExpires : null;
  const provider = providerMatch ? providerMatch[1].trim() : null;

  const scopes: string[] = [];
  const lines = text.split(/\r?\n/);
  let inScopes = false;
  for (const line of lines) {
    if (/^\s*Scopes:\s*<none>/i.test(line)) {
      inScopes = false;
      continue;
    }
    if (/^\s*Scopes:\s*$/i.test(line)) {
      inScopes = true;
      continue;
    }
    if (inScopes) {
      const m = line.match(/^\s*-\s+(\S+)/);
      if (m) {
        scopes.push(m[1]);
      } else if (line.trim()) {
        inScopes = false;
      }
    }
  }

  return { email, provider, expiresIn, scopes };
}

export function detectKeyringWarning(text: string): string | null {
  if (!text) return null;
  const patterns = [
    /Could not (?:read|save) the OAuth token[^.\n]*keyring[^\n]*/i,
    /Keyring\s+'[^']+'\s+is locked[^\n]*/i,
    /No OS keyring available[^\n]*/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

export function extractColabAuthUrl(text: string): string | null {
  if (!text) return null;
  const m = text.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/\S+/i);
  return m ? m[0].replace(/[),.;]+$/, '') : null;
}

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] },
): ColabChildLike {
  return spawn(cmd, args, opts) as ChildProcess;
}

export async function startColabLogin(
  params: { auth?: ColabAuthMode; oauthConfig?: string; config?: string } = {},
  opts: {
    bin?: string;
    platform?: NodeJS.Platform;
    spawnFn?: ColabSpawnFn;
    startTimeoutMs?: number;
  } = {},
): Promise<ColabActionResult> {
  reapExpiredLogins();

  let globalArgs: string[];
  try {
    globalArgs = buildGlobalArgs(params as Record<string, unknown>);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        backend: 'colab-cli',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  const platform = opts.platform ?? process.platform;
  const bin = opts.bin ?? resolveColabBinary(platform);
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const authMode: ColabAuthMode = params.auth === 'adc' ? 'adc' : 'oauth2';
  const startTimeoutMs = opts.startTimeoutMs ?? 15_000;

  let child: ColabChildLike;
  try {
    child = spawnFn(bin, [...globalArgs, 'whoami'], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    const errObj = e as NodeJS.ErrnoException;
    if (errObj?.code === 'ENOENT') {
      return {
        ok: false,
        error: {
          code: platform === 'win32' ? 'UNSUPPORTED_PLATFORM' : 'CLI_NOT_INSTALLED',
          backend: 'colab-cli',
          message:
            platform === 'win32'
              ? `google-colab-cli only supports Linux and macOS (binary "${bin}" not found on Windows).`
              : `Colab CLI binary "${bin}" not found. Install via: uv tool install google-colab-cli`,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'LOGIN_START_FAILED',
        backend: 'colab-cli',
        message: errObj?.message || String(e),
      },
    };
  }

  const entry: PendingColabLogin = {
    loginId: crypto.randomUUID(),
    child,
    expiresAt: Date.now() + LOGIN_TTL_MS,
    createdAt: Date.now(),
    auth: authMode,
    globalArgs,
    stdout: '',
    stderr: '',
    exited: false,
    exitCode: null,
  };

  if (authMode === 'adc') {
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    let urlFlushTimer: NodeJS.Timeout | null = null;

    const finish = (res: ColabActionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (urlFlushTimer) clearTimeout(urlFlushTimer);
      resolve(res);
    };

    const cleanupChild = () => {
      if (!entry.exited) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    };

    const handleCombinedUpdate = () => {
      if (settled || authMode === 'adc') return;
      const combined = `${entry.stderr}\n${entry.stdout}`;
      const authUrl = extractColabAuthUrl(combined);
      if (!authUrl || urlFlushTimer) return;

      // Wait briefly for any trailing prompt / keyring warning in adjacent chunks.
      urlFlushTimer = setTimeout(() => {
        if (settled || entry.exited) return;
        const fullCombined = redactColabText(`${entry.stderr}\n${entry.stdout}`);
        const keyringWarning = detectKeyringWarning(fullCombined);

        while (pendingLogins.size >= MAX_PENDING_LOGINS) {
          const oldestKey = pendingLogins.keys().next().value;
          if (!oldestKey) break;
          const old = pendingLogins.get(oldestKey);
          pendingLogins.delete(oldestKey);
          if (old && !old.exited) {
            try {
              old.child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }
        }

        pendingLogins.set(entry.loginId, entry);
        finish({
          ok: true,
          backend: 'colab-cli',
          data: {
            status: 'awaiting_code',
            loggedIn: false,
            auth: authMode,
            loginId: entry.loginId,
            authUrl,
            expiresAt: entry.expiresAt,
            keyringWarning,
            instructions:
              'Open authUrl in any browser, sign in and approve access, copy the authorization code shown by Google, and submit it to POST /colab/login/complete (or colab_mutate action="login-complete") with { loginId, code }.',
          },
        });
      }, 60);
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      entry.stdout += chunk.toString();
      handleCombinedUpdate();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      entry.stderr += chunk.toString();
      handleCombinedUpdate();
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      entry.exited = true;
      entry.exitCode = -1;
      if (settled) return;
      if (err?.code === 'ENOENT') {
        finish({
          ok: false,
          error: {
            code: platform === 'win32' ? 'UNSUPPORTED_PLATFORM' : 'CLI_NOT_INSTALLED',
            backend: 'colab-cli',
            message:
              platform === 'win32'
                ? `google-colab-cli only supports Linux and macOS (binary "${bin}" not found on Windows).`
                : `Colab CLI binary "${bin}" not found. Install via: uv tool install google-colab-cli`,
          },
        });
        return;
      }
      finish({
        ok: false,
        error: {
          code: 'LOGIN_START_FAILED',
          backend: 'colab-cli',
          message: err?.message || String(err),
        },
      });
    });

    child.on('close', (code: number | null) => {
      entry.exited = true;
      entry.exitCode = typeof code === 'number' ? code : -1;
      pendingLogins.delete(entry.loginId);
      if (settled) return;

      const combined = redactColabText(`${entry.stdout}\n${entry.stderr}`).trim();
      if (entry.exitCode === 0) {
        const parsed = parseColabWhoami(combined);
        finish({
          ok: true,
          backend: 'colab-cli',
          data: {
            status: 'already_logged_in',
            loggedIn: true,
            ...parsed,
            output: combined,
          },
        });
        return;
      }

      if (authMode === 'adc') {
        finish({
          ok: true,
          backend: 'colab-cli',
          data: {
            status: 'adc_setup_required',
            loggedIn: false,
            auth: 'adc',
            command: ADC_LOGIN_COMMAND,
            instructions:
              'Run the gcloud command on the target Linux/macOS node to configure Application Default Credentials with Colaboratory scopes, then retry.',
            output: combined,
          },
        });
        return;
      }

      finish({
        ok: false,
        error: {
          code: 'LOGIN_START_FAILED',
          backend: 'colab-cli',
          message: combined || `colab whoami exited with code ${entry.exitCode}`,
        },
      });
    });

    const timeoutHandle = setTimeout(() => {
      cleanupChild();
      const combined = redactColabText(`${entry.stderr}\n${entry.stdout}`).trim();
      finish({
        ok: false,
        error: {
          code: 'LOGIN_START_FAILED',
          backend: 'colab-cli',
          message: combined
            ? `Timed out waiting for Colab auth URL: ${combined}`
            : 'Timed out waiting for Colab OAuth2 authorization URL.',
        },
      });
    }, startTimeoutMs);
  });
}

export async function completeColabLogin(
  params: { loginId?: string; code?: string } = {},
  opts: { timeoutMs?: number } = {},
): Promise<ColabActionResult> {
  reapExpiredLogins();

  const loginId = typeof params.loginId === 'string' ? params.loginId.trim() : '';
  const code = typeof params.code === 'string' ? params.code.trim() : '';
  if (!loginId) {
    return {
      ok: false,
      error: { code: 'VALIDATION', backend: 'colab-cli', message: 'loginId is required' },
    };
  }
  if (!code || code.includes('\0')) {
    return {
      ok: false,
      error: { code: 'VALIDATION', backend: 'colab-cli', message: 'code is required (non-empty)' },
    };
  }

  const entry = pendingLogins.get(loginId);
  if (!entry) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        backend: 'colab-cli',
        message: 'Invalid or expired loginId. Call login-start again.',
      },
    };
  }
  pendingLogins.delete(loginId);

  const childStdin = entry.child.stdin;
  if (entry.exited || !childStdin) {
    return {
      ok: false,
      error: {
        code: 'LOGIN_FAILED',
        backend: 'colab-cli',
        message: 'Login process already exited before code was submitted. Call login-start again.',
      },
    };
  }

  const timeoutMs = opts.timeoutMs ?? 20_000;
  const baseOutLen = entry.stdout.length;
  const baseErrLen = entry.stderr.length;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (res: ColabActionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    entry.child.once('close', (exitCode: number | null) => {
      entry.exited = true;
      entry.exitCode = typeof exitCode === 'number' ? exitCode : -1;
      const tailOut = entry.stdout.slice(baseOutLen);
      const tailErr = entry.stderr.slice(baseErrLen);
      const fullRedacted = redactColabText(`${tailOut}\n${tailErr}`).trim();
      const allRedacted = redactColabText(`${entry.stdout}\n${entry.stderr}`).trim();
      const keyringWarning = detectKeyringWarning(allRedacted);

      if (entry.exitCode === 0) {
        const parsed = parseColabWhoami(fullRedacted || allRedacted);
        finish({
          ok: true,
          backend: 'colab-cli',
          data: {
            status: 'logged_in',
            loggedIn: true,
            ...parsed,
            persisted: !keyringWarning,
            keyringWarning,
            output: fullRedacted,
          },
        });
      } else {
        finish({
          ok: false,
          error: {
            code: 'LOGIN_FAILED',
            backend: 'colab-cli',
            message: fullRedacted || `colab login exited with code ${entry.exitCode}`,
            data: { keyringWarning },
          },
        });
      }
    });

    entry.child.once('error', (err: Error) => {
      entry.exited = true;
      finish({
        ok: false,
        error: {
          code: 'LOGIN_FAILED',
          backend: 'colab-cli',
          message: err.message || String(err),
        },
      });
    });

    const timer = setTimeout(() => {
      try {
        entry.child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish({
        ok: false,
        error: {
          code: 'LOGIN_FAILED',
          backend: 'colab-cli',
          message: 'Timed out exchanging authorization code with Google.',
        },
      });
    }, timeoutMs);

    try {
      childStdin.write(`${code}\n`);
      childStdin.end();
    } catch (e) {
      clearTimeout(timer);
      finish({
        ok: false,
        error: {
          code: 'LOGIN_FAILED',
          backend: 'colab-cli',
          message: e instanceof Error ? e.message : String(e),
        },
      });
    }
  });
}
