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
  /** PID of the gnome-terminal CLI client (exits after dispatching to the server). */
  pid: number | null;
  /** True if we found a usable desktop env; false → tab probably won't render. */
  displayAvailable: boolean;
  /**
   * PID of the bash process running INSIDE the new tab (child of
   * gnome-terminal-server). Used by `deleteTab` to close non-tmux gnome
   * tabs. Null if the server child couldn't be identified or there's
   * already a tmuxSession (which provides its own teardown path).
   */
  tabPid: number | null;
  /** Captured stderr from gnome-terminal (small; truncated at 4 KiB). */
  stderr: string;
}

/**
 * Find gnome-terminal-server's PID by reading /proc cmdlines directly.
 *
 * Can't use `pgrep -x gnome-terminal-server` here because the Linux
 * kernel truncates `/proc/PID/comm` to 15 chars ("gnome-terminal-"),
 * and pgrep -x compares against comm. `pgrep -f` would match our own
 * search processes. Reading /proc is unambiguous.
 */
function findGnomeTerminalServerPid(): number | null {
  try {
    const dirs = fs.readdirSync('/proc');
    for (const d of dirs) {
      if (!/^\d+$/.test(d)) continue;
      let cmdline: string;
      try {
        cmdline = fs.readFileSync(`/proc/${d}/cmdline`, 'utf-8');
      } catch { continue; }
      // /proc/PID/cmdline is NUL-separated argv. argv[0] for the server is
      // "/usr/libexec/gnome-terminal-server" (Ubuntu) or similar paths on
      // other distros.
      const argv0 = cmdline.split('\0')[0];
      if (/(?:^|\/)gnome-terminal-server$/.test(argv0)) {
        return parseInt(d, 10);
      }
    }
  } catch { /* /proc unreadable */ }
  return null;
}

/**
 * Snapshot the children of gnome-terminal-server. Each child PID is a bash
 * running inside one open tab. We diff before-vs-after the spawn to find
 * the bash we just created.
 *
 * Returns [] if gnome-terminal-server isn't running. Callers must treat
 * null tabPid as "tracking unavailable", not "tab not opened".
 */
function getGnomeServerChildren(): number[] {
  const serverPid = findGnomeTerminalServerPid();
  if (serverPid === null) return [];
  try {
    const childOut = execFileSync('pgrep', ['-P', String(serverPid)], { encoding: 'utf-8', timeout: 2000 }).trim();
    return childOut.split('\n').filter(Boolean).map(Number).filter(Number.isFinite);
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

export async function openGnomeTab(opts: OpenGnomeTabOptions): Promise<OpenGnomeTabResult> {
  if (!IS_POSIX) throw new TerminalError('PLATFORM_UNSUPPORTED', 'gnome-terminal is only available on POSIX');
  const desk = findDesktopEnv();
  // Fail loudly when no display env can be propagated. Without DISPLAY/
  // WAYLAND_DISPLAY the spawn would silently no-op (gnome-terminal exits
  // with "Failed to parse arguments" or similar that we'd never see).
  if (!desk) {
    throw new TerminalError(
      'SPAWN_FAILED',
      'no logged-in desktop session found for gnome-terminal — DISPLAY/WAYLAND_DISPLAY not available on this host',
    );
  }

  // Pre-check the cwd exists; gnome-terminal silently falls back to its
  // own cwd otherwise, leaving the caller confused about where the tab
  // actually opened.
  if (opts.cwd) {
    try {
      const stat = fs.statSync(opts.cwd);
      if (!stat.isDirectory()) {
        throw new TerminalError('INVALID_INPUT', `cwd is not a directory: ${opts.cwd}`);
      }
    } catch (e: unknown) {
      if (e instanceof TerminalError) throw e;
      throw new TerminalError('INVALID_INPUT', `cwd does not exist or is not accessible: ${opts.cwd}`, {
        cwd: opts.cwd, error: (e as Error).message,
      });
    }
  }

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY']) {
    if (desk[k]) env[k] = desk[k];
  }
  for (const [k, v] of Object.entries(opts.env)) env[k] = v;

  const args: string[] = ['--tab'];
  if (opts.title) args.push(`--title=${opts.title}`);
  if (opts.cwd) args.push(`--working-directory=${opts.cwd}`);

  if (opts.tmuxSession) {
    tmux.createUnlocked(opts.tmuxSession, { cwd: opts.cwd, cols: opts.cols, rows: opts.rows });
    if (opts.command) {
      tmux.sendKeysUnlocked(opts.tmuxSession, {
        keys: opts.command, literal: false, enter: true, paneQualifier: null,
      });
    }
    args.push('--', 'bash', '-c', 'tmux attach -t "$1"', 'lm-assist', opts.tmuxSession);
  } else if (opts.command) {
    // `eval "$1"` re-parses $1 as shell so `cd /foo && tail -f log` works as
    // a user types it. The command itself comes via argv (not interpolated
    // into the bash source), so quoting bugs at the lm-assist layer can't
    // produce stray code. Shell evaluation of the COMMAND CONTENT is by
    // design — that's what "open a tab and run X" means.
    args.push('--', 'bash', '-c', 'eval "$1"; exec bash', 'lm-assist', opts.command);
  }

  // Snapshot server children before spawn so we can identify the new tab.
  const before = new Set(getGnomeServerChildren());

  let capturedStderr = '';
  let clientPid: number | null = null;
  try {
    const child = spawn('gnome-terminal', args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        if (capturedStderr.length < 4096) capturedStderr += chunk.toString('utf-8');
      });
    }
    child.unref();
    clientPid = child.pid ?? null;
  } catch (e: unknown) {
    throw new TerminalError('SPAWN_FAILED', `gnome-terminal spawn failed: ${(e as Error).message}`);
  }

  // Wait briefly for gnome-terminal-server to spawn the new pane's bash.
  // 800ms is enough on a healthy session; the test suite verifies this.
  let tabPid: number | null = null;
  for (let attempt = 0; attempt < 8 && tabPid === null; attempt++) {
    await sleep(100);
    const after = getGnomeServerChildren();
    const newOnes = after.filter((p) => !before.has(p));
    // If multiple tabs opened concurrently, take the youngest one that's
    // still alive (we can't disambiguate further without a marker).
    if (newOnes.length > 0) {
      tabPid = newOnes[newOnes.length - 1];
    }
  }

  return {
    pid: clientPid,
    displayAvailable: true,
    tabPid,
    stderr: capturedStderr,
  };
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
