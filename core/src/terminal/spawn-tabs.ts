/**
 * Spawn GUI terminal tabs that view a tmux session.
 *
 * Two flavors:
 *   - gnome: opens `gnome-terminal --tab` on a Linux host with a logged-in
 *            desktop session (broader WM detection than the original).
 *   - wt-ssh: opens a Windows Terminal tab via SSH+tmux. Per-call bat file
 *             (no shared file race), explicit per-tab scheduled task name
 *             so concurrent calls don't clobber each other.
 *
 * Security notes:
 *   - All caller-controlled strings (cwd, sshTarget, command) are validated
 *     at the route layer (see validate.ts). This module assumes its inputs
 *     are already allowlisted.
 *   - `command` is passed as a POSITIONAL argv to bash -c '$0', not
 *     interpolated into a shell string, so an attacker who somehow gets a
 *     metachar past the allowlist still can't break out.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn } from '../utils/exec';
import { IS_POSIX, IS_WINDOWS } from '../utils/process-utils';
import { TerminalError } from './errors';
import * as tmux from './tmux';

// ---------- Linux gnome --------------------------------------------------

/**
 * Find a logged-in desktop session's display vars.
 *
 * Searches a broader set of WM/compositor processes than the original
 * (Wayland compositors and tiling WMs included). Filters by uid only when
 * lm-assist is running as a non-root user owning the desktop session.
 */
function findDesktopEnv(): Record<string, string> | null {
  if (!IS_POSIX) return null;
  const candidates = [
    'gnome-terminal-server', 'gnome-shell',
    'kwin_x11', 'kwin_wayland', 'plasmashell',
    'sway', 'i3', 'Hyprland',
    'Xorg', 'Xwayland',
  ];
  // Prefer same-uid processes; fall back to any uid (for root-owned services
  // that need to spawn into the user's display).
  const ourUid = process.getuid?.();
  for (const filterByUid of [true, false]) {
    for (const name of candidates) {
      const args = filterByUid && ourUid !== undefined
        ? ['-u', String(ourUid), '-x', name]
        : ['-x', name];
      let pids: string[];
      try {
        pids = execFileSync('pgrep', args, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
      } catch {
        continue;  // pgrep miss
      }
      for (const pid of pids) {
        try {
          const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
          const env: Record<string, string> = {};
          for (const kv of raw.split('\0')) {
            const i = kv.indexOf('=');
            if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
          }
          if (env.DISPLAY || env.WAYLAND_DISPLAY) return env;
        } catch { /* unreadable env (different uid) */ }
      }
    }
  }
  return null;
}

export interface OpenGnomeTabOptions {
  title: string | null;
  cwd: string | null;
  command: string | null;       // already validated; passed as positional argv
  tmuxSession: string | null;
  cols: number | null;
  rows: number | null;
  env: Record<string, string>;
}

export interface OpenGnomeTabResult {
  pid: number | null;
  /** True if we found a usable desktop env; false → tab probably won't render. */
  displayAvailable: boolean;
  /** Captured stderr from gnome-terminal (small; truncated at 4 KiB). */
  stderr: string;
}

export function openGnomeTab(opts: OpenGnomeTabOptions): OpenGnomeTabResult {
  if (!IS_POSIX) throw new TerminalError('PLATFORM_UNSUPPORTED', 'gnome-terminal is only available on POSIX');
  const desk = findDesktopEnv();

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (desk) {
    for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY']) {
      if (desk[k]) env[k] = desk[k];
    }
  }
  for (const [k, v] of Object.entries(opts.env)) env[k] = v;

  const args: string[] = ['--tab'];
  if (opts.title) args.push(`--title=${opts.title}`);
  if (opts.cwd) args.push(`--working-directory=${opts.cwd}`);

  if (opts.tmuxSession) {
    // Make sure the session exists before we attach.
    tmux.createUnlocked(opts.tmuxSession, { cwd: opts.cwd, cols: opts.cols, rows: opts.rows });
    if (opts.command) {
      tmux.sendKeysUnlocked(opts.tmuxSession, {
        keys: opts.command, literal: false, enter: true, paneQualifier: null,
      });
    }
    // Attach via bash -c '$0' so the session name is a positional arg, not
    // interpolated into a shell string.
    args.push('--', 'bash', '-c', 'tmux attach -t "$1"', 'lm-assist', opts.tmuxSession);
  } else if (opts.command) {
    // Run command via positional arg, then drop to interactive bash.
    args.push('--', 'bash', '-c', '"$1"; exec bash', 'lm-assist', opts.command);
  }

  // Capture stderr instead of stdio:'ignore' so silent failures surface.
  let capturedStderr = '';
  try {
    const child = spawn('gnome-terminal', args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        if (capturedStderr.length < 4096) capturedStderr += chunk.toString('utf-8');
      });
    }
    child.unref();
    return {
      pid: child.pid ?? null,
      displayAvailable: !!desk,
      stderr: capturedStderr,
    };
  } catch (e: unknown) {
    throw new TerminalError('SPAWN_FAILED', `gnome-terminal spawn failed: ${(e as Error).message}`);
  }
}

// ---------- Windows wt-ssh -----------------------------------------------

const WT_SCHED_PREFIX = 'LmAssistOpenWtTab-';
const WT_BAT_DIR = path.join(os.homedir(), '.lm-assist', 'wt-tabs');

function windowsEscape(s: string): string {
  // Wrap in double quotes; escape inner double quotes; caret-escape cmd
  // metacharacters that survive double-quoting (& | < > ^).
  return `"${s.replace(/"/g, '""').replace(/[&|<>^]/g, '^$&')}"`;
}

function shellQuotePosix(s: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface OpenWtSshTabOptions {
  title: string | null;
  sshTarget: string;            // already validated against SSH_TARGET_RE
  tmuxSession: string | null;
  command: string | null;
}

export interface OpenWtSshTabResult {
  scheduledTask: string;
  batPath: string;
}

export function openWtSshTab(opts: OpenWtSshTabOptions): OpenWtSshTabResult {
  if (!IS_WINDOWS) throw new TerminalError('PLATFORM_UNSUPPORTED', 'wt-ssh tabs require a Windows lm-assist host');

  // Per-call bat file + per-call scheduled task name so concurrent
  // openWtSshTab() calls do not race on a shared resource.
  const id = Math.random().toString(36).slice(2, 10);
  const batPath = path.join(WT_BAT_DIR, `wt-${id}.bat`);
  const taskName = `${WT_SCHED_PREFIX}${id}`;

  fs.mkdirSync(WT_BAT_DIR, { recursive: true });

  const title = opts.title || 'lm-assist';
  const innerSsh = opts.tmuxSession
    ? `tmux new-session -A -s ${shellQuotePosix(opts.tmuxSession)}${opts.command ? ' ' + shellQuotePosix(opts.command) : ''}`
    : (opts.command || 'bash -l');
  // sshTarget is already allowlisted to [A-Za-z0-9_]+(@[A-Za-z0-9_.-]+)?
  // — no shell metachars possible. Still wrap in windowsEscape for symmetry.
  const wtCmd = `wt.exe -w 0 new-tab --title ${windowsEscape(title)} ssh -t ${windowsEscape(opts.sshTarget)} ${windowsEscape(innerSsh)}`;
  fs.writeFileSync(batPath, `@echo off\r\n${wtCmd}\r\n`);

  // Create a one-shot scheduled task pointed at our per-call bat. Triggering
  // it routes the invocation to the interactive console session.
  try {
    execFileSync('schtasks', [
      '/create', '/tn', taskName,
      '/tr', batPath,
      '/sc', 'once', '/st', '23:59',
      '/f',
    ], { timeout: 10000 });
    execFileSync('schtasks', ['/run', '/tn', taskName], { timeout: 10000 });
  } catch (e: unknown) {
    // Best-effort cleanup so we don't leak per-call resources on failure.
    try { execFileSync('schtasks', ['/delete', '/tn', taskName, '/f'], { timeout: 5000 }); } catch { /* ignore */ }
    try { fs.unlinkSync(batPath); } catch { /* ignore */ }
    throw new TerminalError('SPAWN_FAILED', `wt-ssh task creation failed: ${(e as Error).message}`);
  }

  // Schedule cleanup of the per-call task + bat after a few minutes.
  setTimeout(() => {
    try { execFileSync('schtasks', ['/delete', '/tn', taskName, '/f'], { timeout: 5000 }); } catch { /* ignore */ }
    try { fs.unlinkSync(batPath); } catch { /* ignore */ }
  }, 5 * 60 * 1000).unref();

  return { scheduledTask: taskName, batPath };
}
