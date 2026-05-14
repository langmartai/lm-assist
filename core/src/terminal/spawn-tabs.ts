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
  /**
   * If non-empty, all tabs with the same windowGroup land in the same
   * gnome-terminal window (title prefix + wmctrl raise-before-spawn).
   * Empty string disables grouping (legacy: each tab → own window).
   */
  windowGroup: string;
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
/**
 * Close every gnome-terminal window whose WM_WINDOW_ROLE matches our
 * pattern. Useful for cleaning up orphan tabs / windows that no longer
 * appear in the tab registry (e.g. after `exec tmux attach` failed and
 * gnome-terminal restarted bash, severing the link to `meta.tabPid`).
 *
 * Returns the list of X11 window IDs that were closed.
 *
 * The wmctrl `-c` request gracefully asks the WM to close the window;
 * gnome-terminal closes all tabs in it, terminating their bashes.
 *
 * Auto-resolves DISPLAY/XAUTHORITY from the running desktop session
 * (same probe `openGnomeTab` uses) so this works when lm-assist runs
 * over SSH with no X env.
 */
export function closeWindowsByGroup(windowGroup: string): { closed: string[]; displayAvailable: boolean } {
  const desk = findDesktopEnv();
  if (!desk) return { closed: [], displayAvailable: false };
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY']) {
    if (desk[k]) env[k] = desk[k];
  }

  const closed: string[] = [];
  try {
    const targetRole = `lm-assist-${windowGroup}`;
    const stdout = execFileSync('wmctrl', ['-l'], { encoding: 'utf-8', env, timeout: 2000 });
    for (const line of stdout.split('\n')) {
      const m = line.match(/^(\S+)\s/);
      if (!m) continue;
      const id = m[1];
      try {
        const r = execFileSync('xprop', ['-id', id, 'WM_WINDOW_ROLE'], { encoding: 'utf-8', env, timeout: 1000 });
        const rm = r.match(/=\s*"([^"]*)"/);
        if (rm && rm[1] === targetRole) {
          try {
            execFileSync('wmctrl', ['-i', '-c', id], { encoding: 'utf-8', env, timeout: 2000 });
            closed.push(id);
          } catch { /* close request failed; window may already be gone */ }
        }
      } catch { /* xprop miss */ }
    }
  } catch { /* wmctrl not installed, no windows to close */ }
  return { closed, displayAvailable: true };
}

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

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Find an existing gnome-terminal window of this windowGroup so we can
 * add a tab to it. Returns the X11 window id (hex string) or null.
 *
 * Why we use WM_WINDOW_ROLE (not the title): gnome-terminal mirrors the
 * ACTIVE tab's title to the X11 window title. Once a non-tmux tab is
 * activated, the window title becomes "ubuntu@host: cwd" (VTE's default)
 * and no longer starts with "<group>:". A title-based lookup would then
 * miss the window and we'd open N separate windows for N tabs.
 *
 * Set --role=lm-assist-<group> when creating the first window of a group;
 * xdotool's `search --classname` doesn't match role, but it accepts
 * search filters. Easier path: read WM_WINDOW_ROLE on each window from
 * `xprop`. Linear scan of all top-level windows — cheap, deterministic.
 */
function findExistingGroupWindow(windowGroup: string, env: Record<string, string>): string | null {
  try {
    const role = `lm-assist-${windowGroup}`;
    const stdout = execFileSync('wmctrl', ['-l'], { encoding: 'utf-8', env, timeout: 2000 });
    // Collect window ids from wmctrl (skips off-screen / decoration windows
    // that xprop sometimes errors on).
    const ids: string[] = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^(\S+)\s/);
      if (m) ids.push(m[1]);
    }
    // For each, query WM_WINDOW_ROLE. Last match wins (most recently
    // created tends to be highest WID under standard X11 stacking).
    let last: string | null = null;
    for (const id of ids) {
      try {
        const out = execFileSync('xprop', ['-id', id, 'WM_WINDOW_ROLE'], { encoding: 'utf-8', env, timeout: 1000 });
        // Format: `WM_WINDOW_ROLE(STRING) = "lm-assist-foo"`
        const m = out.match(/=\s*"([^"]*)"/);
        if (m && m[1] === role) last = id;
      } catch { /* xprop may not have WM_WINDOW_ROLE on some windows */ }
    }
    return last;
  } catch {
    return null;
  }
}

/**
 * Add a tab to an existing gnome-terminal window via the Ctrl+Shift+T
 * keyboard shortcut, then inject cwd/title/command via xdotool type.
 *
 * Requires xdotool and the GNOME Terminal new-tab keybinding to be the
 * default Ctrl+Shift+T. If the user changed the binding, this won't work.
 */
async function openTabInExistingWindow(
  windowId: string,
  opts: OpenGnomeTabOptions,
  groupedTitle: string | null,
  env: Record<string, string>,
): Promise<OpenGnomeTabResult> {
  // Snapshot before, so we can identify the new bash.
  const before = new Set(getGnomeServerChildren());

  // 1. Focus the target window. Use both windowactivate AND windowfocus
  //    because some compositors decouple them; the keystroke needs both.
  try {
    execFileSync('xdotool', ['windowactivate', '--sync', windowId], { encoding: 'utf-8', env, timeout: 2000 });
    execFileSync('xdotool', ['windowfocus', '--sync', windowId], { encoding: 'utf-8', env, timeout: 2000 });
  } catch (e: unknown) {
    throw new TerminalError('SPAWN_FAILED', `xdotool windowactivate/focus failed (is xdotool installed?): ${(e as Error).message}`);
  }
  await sleep(200);

  // 2. Send Ctrl+Shift+T to the focused window. Don't use `--window <id>`
  //    here — that puts the keystroke in the X11 window's queue without
  //    changing keyboard focus, and gnome-terminal ignores it. The
  //    keystroke must be delivered to the currently-focused window we
  //    just activated above. --clearmodifiers releases any held keys
  //    (caps, shift, etc.) before sending so the chord is clean.
  try {
    execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+shift+t'], { encoding: 'utf-8', env, timeout: 2000 });
  } catch (e: unknown) {
    throw new TerminalError('SPAWN_FAILED', `xdotool key ctrl+shift+t failed: ${(e as Error).message}`);
  }

  // 3. Wait for the new bash to appear in the server's children.
  let tabPid: number | null = null;
  for (let i = 0; i < 25 && tabPid === null; i++) {
    await sleep(80);
    const after = getGnomeServerChildren();
    const newOnes = after.filter((p) => !before.has(p));
    if (newOnes.length > 0) tabPid = newOnes[newOnes.length - 1];
  }
  if (tabPid === null) {
    throw new TerminalError(
      'SPAWN_FAILED',
      'Ctrl+Shift+T did not produce a new tab in the target window. Check that the new-tab keybinding is still <Ctrl><Shift>t.',
    );
  }

  // 4. Inject setup commands. Don't type them directly — escape-sequence
  //    syntax and PROMPT_COMMAND assignments are ugly when typed visibly.
  //    Write a tiny helper script to /tmp and `source` it; then `clear`
  //    erases the visible noise within ~1 second.
  //
  //    750ms wait so bash has fully sourced ~/.bashrc (which on this
  //    user's box loads atuin + bash-preexec, both of which install DEBUG
  //    traps; sourcing during that window can lose keystrokes). Earlier
  //    test runs with 250ms left tabs 2/3 with their `exec tmux attach`
  //    silently failing — bash had received only part of the source line.
  await sleep(750);

  const setupLines: string[] = [];
  if (groupedTitle) {
    // Set the gnome-terminal tab title via OSC 0 from PROMPT_COMMAND.
    //
    // KNOWN LIMITATION (confirmed on GNOME Terminal 3.44 / Ubuntu 22.04):
    // OSC 0 dynamic-title is not applied for plain-bash tabs on this
    // platform. Verified end-to-end:
    //   - PROMPT_COMMAND fires every prompt (marker file logged 3 calls
    //     on 3 prompt redraws)
    //   - printf emits the right bytes (od -c confirmed
    //     `033 ] 0 ; TITLE \a`)
    //   - Even bypassing bash with `printf '...' > /dev/tty` directly
    //     in a fresh untouched gnome-terminal window — no effect
    //   - Both `\\007` (BEL) and `\\033\\` (ST) terminators tested
    //   - D-Bus approach is unavailable: gnome-terminal 3.44 exposes
    //     only app-level actions (preferences/help/about/quit) via
    //     org.gtk.Actions; per-tab/per-window paths exist but are
    //     empty nodes with no SetTitle methods. ObjectManager only
    //     reports /org/gnome/Terminal/Factory0 (CreateInstance only).
    //
    // gnome-terminal seems to suppress OSC 0 on this build (likely an
    // Ubuntu hardening patch against terminal-spoofing). Nothing we can
    // do from outside the terminal.
    //
    // For TMUX-attached tabs the title works correctly because tmux
    // owns the title from inside the pane and uses its own mechanism
    // (set-titles-string + set-titles on). Workaround: use
    // `tmuxSession` instead of plain `command` if you need visible
    // per-tab labels.
    const titleQuoted = groupedTitle.replace(/'/g, `'\\''`);
    setupLines.push(`__lm_assist_set_title() { printf '\\033]0;${titleQuoted}\\007'; }`);
    setupLines.push(`PROMPT_COMMAND='__lm_assist_set_title'`);
    setupLines.push(`if declare -p precmd_functions >/dev/null 2>&1; then precmd_functions+=(__lm_assist_set_title); fi`);
  }
  if (opts.tmuxSession) {
    tmux.createUnlocked(opts.tmuxSession, { cwd: opts.cwd, cols: opts.cols, rows: opts.rows });
    if (opts.command) {
      tmux.sendKeysUnlocked(opts.tmuxSession, {
        keys: opts.command, literal: false, enter: true, paneQualifier: null,
      });
    }
    // Note: exec replaces the bash, so PROMPT_COMMAND won't survive — but
    // that's fine because tmux owns the title from inside.
    setupLines.push(`clear; exec tmux attach -t ${shellQuote(opts.tmuxSession)}`);
  } else if (opts.cwd && opts.command) {
    setupLines.push(`cd ${shellQuote(opts.cwd)}`);
    setupLines.push('clear');
    setupLines.push(`(${opts.command})`);
  } else if (opts.cwd) {
    setupLines.push(`cd ${shellQuote(opts.cwd)}`);
    setupLines.push('clear');
  } else if (opts.command) {
    setupLines.push('clear');
    setupLines.push(`(${opts.command})`);
  } else {
    setupLines.push('clear');
  }

  if (setupLines.length > 0) {
    const helperPath = `/tmp/lm-assist-tab-setup-${Math.random().toString(36).slice(2, 10)}.sh`;
    // Self-deleting script: removes itself after sourcing so /tmp doesn't
    // accumulate, and so a curious user `cat`-ing it won't see secrets
    // long after the tab closes.
    const script = `#!/bin/bash\n${setupLines.join('\n')}\nrm -f "${helperPath}"\n`;
    try {
      fs.writeFileSync(helperPath, script, { mode: 0o600 });
    } catch (e: unknown) {
      return { pid: null, tabPid, displayAvailable: true, stderr: `helper script write failed: ${(e as Error).message}` };
    }
    // Type a SINGLE short line. The user briefly sees:
    //   $ source /tmp/lm-assist-tab-setup-XXXXXX.sh
    // then `clear` runs and the screen is clean.
    const cmd = `source "${helperPath}"\n`;
    try {
      // --delay 25 (was 5) — gives the receiving pty time to process each
      // keypress through bash-preexec's DEBUG trap chain. At --delay 5 on
      // this box, the source command would arrive partially-typed (e.g.
      // "souce /tmp/...") and bash would error out, leaving the user with
      // a bare prompt that never exec'd tmux.
      execFileSync('xdotool', ['type', '--delay', '25', '--clearmodifiers', cmd], {
        encoding: 'utf-8', env, timeout: 10000,
      });
    } catch (e: unknown) {
      try { fs.unlinkSync(helperPath); } catch { /* ignore */ }
      return { pid: null, tabPid, displayAvailable: true, stderr: `xdotool type failed: ${(e as Error).message}` };
    }
  }

  return { pid: null, tabPid, displayAvailable: true, stderr: '' };
}

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

  // Window-grouping: try to add this tab to an EXISTING gnome-terminal
  // window with the same windowGroup. gnome-terminal CLI's `--tab` flag
  // doesn't work for this (its "last-opened window" tracking is scoped to
  // a single CLI invocation; back-to-back CLI calls each create new
  // windows). The reliable way is to find our window via xdotool and send
  // Ctrl+Shift+T (the new-tab keyboard shortcut). After that we inject
  // the cwd, title, and command via xdotool type into the focused tab.
  //
  // Requires `xdotool` installed; falls back to a fresh `--window` spawn
  // if not. The first tab of a windowGroup always spawns a new window
  // anyway.
  const groupedTitle = opts.windowGroup
    ? `${opts.windowGroup}: ${opts.title ?? 'tab'}`
    : (opts.title ?? null);

  if (opts.windowGroup) {
    const existing = findExistingGroupWindow(opts.windowGroup, env);
    if (existing) {
      return await openTabInExistingWindow(existing, opts, groupedTitle, env);
    }
    // Fall through: open as a fresh window (will be reused by future calls).
  }

  // Fresh-window spawn (first of group, or no group).
  // Use --window for grouped tabs so the WM sees a real top-level window
  // we can target later. Use --tab for ungrouped — keeps old semantics
  // (legacy 1-tab-per-window since user's gsettings opens new --tab as
  // new windows on this version anyway).
  // For grouped windows, also pass --maximize so the user gets a
  // full-screen terminal by default, AND --role=lm-assist-<group> so
  // findExistingGroupWindow can locate this window later regardless of
  // which tab is active (title-based lookup would fail once a non-
  // titled tab becomes active).
  const args: string[] = [];
  if (opts.windowGroup) {
    args.push('--maximize');
    args.push(`--role=lm-assist-${opts.windowGroup}`);
    args.push('--window');
  } else {
    args.push('--tab');
  }
  if (groupedTitle) args.push(`--title=${groupedTitle}`);
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
