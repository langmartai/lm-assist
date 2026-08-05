/**
 * tmux primitives.
 *
 * Every mutation is followed by a post-condition check (does the session
 * exist now? was the kill effective?) — tmux's exit code does not imply
 * semantic success (e.g. `new-session -c /bad/cwd` exits 0 but the session
 * dies instantly).
 *
 * send-keys is per-session-mutexed (see mutex.ts) so concurrent callers
 * cannot interleave text/Enter sub-commands.
 *
 * Read operations (list, capture) are not locked — they are idempotent
 * snapshot queries.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from '../utils/exec';
import { IS_POSIX } from '../utils/process-utils';
import { planDetachedTmuxSpawn, type DetachProbe } from './detach-plan';
import { readTmuxServerPid } from './tmux-server-guard';
import { TerminalError } from './errors';
import { withSessionLock } from './mutex';
import { NAMED_KEYS } from './types';
import type { TmuxSessionState, TmuxWindowState, SendKeysInput, WaitForInput, CaptureInput, CreateWindowInput } from './types';

const TMUX = 'tmux';
const DEFAULT_TIMEOUT_MS = 5000;

// ---------- internal helpers ---------------------------------------------

function assertPosix(): void {
  if (!IS_POSIX) throw new TerminalError('PLATFORM_UNSUPPORTED', 'tmux control requires a POSIX host');
}

function tmuxCmd(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS, extra: { input?: string } = {}): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(TMUX, args, {
      encoding: 'utf-8', timeout: timeoutMs,
      ...(extra.input !== undefined ? { input: extra.input } : {}),
    });
    const text = typeof stdout === 'string' ? stdout : (stdout as Buffer).toString('utf-8');
    return { stdout: text, stderr: '' };
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer | string; message?: string; code?: string };
    let stderr = '';
    if (err.stderr) {
      stderr = typeof err.stderr === 'string' ? err.stderr : (err.stderr as Buffer).toString('utf-8');
    }
    if (err.code === 'ENOENT') {
      throw new TerminalError('TMUX_NOT_INSTALLED', 'tmux binary not found on PATH');
    }
    throw new TerminalError('TMUX_ERROR', `tmux ${args[0]} failed: ${stderr || err.message || 'unknown'}`, {
      args, stderr,
    });
  }
}

function targetFor(session: string, paneQualifier: string | null): string {
  return paneQualifier ? `${session}:${paneQualifier}` : session;
}

// ---------- detached server start ----------------------------------------

/** Is `name` an executable on PATH? (No shell, no `which` dependency.) */
function onPath(name: string): boolean {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch { /* try the next PATH entry */ }
  }
  return false;
}

function realDetachProbe(): DetachProbe {
  return {
    hasBinary: onPath,
    pathExists: (p) => { try { fs.statSync(p); return true; } catch { return false; } },
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    xdgRuntimeDir: process.env.XDG_RUNTIME_DIR || null,
    dbusAddress: process.env.DBUS_SESSION_BUS_ADDRESS || null,
  };
}

/**
 * Start the tmux server in a cgroup of its own. Best effort by design: the
 * caller re-checks and falls back to a plain `tmux new-session`, because
 * process isolation must never be the reason a session fails to start.
 */
function startServerDetached(args: string[]): void {
  const plan = planDetachedTmuxSpawn(args, realDetachProbe());
  if (plan.kind === 'plain') return; // nothing a wrapper would buy us
  try {
    execFileSync(plan.file, plan.args, {
      timeout: DEFAULT_TIMEOUT_MS,
      env: { ...process.env, ...plan.env },
      stdio: 'ignore',
    });
  } catch { /* fall through to the caller's plain spawn */ }
}

// ---------- queries (no mutex) -------------------------------------------

export function exists(name: string): boolean {
  assertPosix();
  try {
    tmuxCmd(['has-session', '-t', `=${name}`]);  // =name = exact match
    return true;
  } catch (e) {
    if (e instanceof TerminalError && e.code === 'TMUX_ERROR') return false;
    throw e;
  }
}

export function list(): TmuxSessionState[] {
  assertPosix();
  // Use \x1f (unit separator) — tmux won't put it in a session name.
  const SEP = '\x1f';
  let stdout: string;
  try {
    stdout = tmuxCmd([
      'list-sessions', '-F',
      `#{session_name}${SEP}#{session_windows}${SEP}#{session_attached}${SEP}#{pane_pid}${SEP}#{pane_current_command}`,
    ]).stdout;
  } catch (e) {
    if (e instanceof TerminalError && /no server running/i.test((e.details.stderr as string) || '')) return [];
    throw e;
  }
  const out: TmuxSessionState[] = [];
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const parts = line.split(SEP);
    out.push({
      exists: true,
      windows: parseInt(parts[1], 10) || 0,
      attached: parts[2] === '1',
      panePid: parseInt(parts[3], 10) || null,
      paneCommand: parts[4] || null,
    });
    // Also stash the session name on the record via a Symbol-free mechanism:
    (out[out.length - 1] as TmuxSessionState & { name?: string }).name = parts[0];
  }
  // Stable sort by name for deterministic output.
  out.sort((a, b) =>
    ((a as TmuxSessionState & { name?: string }).name ?? '').localeCompare(
      (b as TmuxSessionState & { name?: string }).name ?? '',
    ),
  );
  return out;
}

export function getState(name: string): TmuxSessionState {
  assertPosix();
  if (!exists(name)) {
    return { exists: false, windows: 0, attached: false, panePid: null, paneCommand: null };
  }
  // Use the same -F format scoped to one session.
  const SEP = '\x1f';
  const out = tmuxCmd([
    'display-message', '-p', '-t', name,
    `#{session_windows}${SEP}#{session_attached}${SEP}#{pane_pid}${SEP}#{pane_current_command}`,
  ]).stdout.trim();
  const [windows, attached, pid, cmd] = out.split(SEP);
  return {
    exists: true,
    windows: parseInt(windows, 10) || 0,
    attached: attached === '1',
    panePid: parseInt(pid, 10) || null,
    paneCommand: cmd || null,
  };
}

export function capture(name: string, opts: CaptureInput): string {
  assertPosix();
  if (!exists(name)) throw new TerminalError('SESSION_NOT_FOUND', `tmux session not found: ${name}`);
  const args = ['capture-pane', '-t', targetFor(name, opts.paneQualifier), '-p'];
  if (opts.start !== null) args.push('-S', String(opts.start));
  let screen = tmuxCmd(args).stdout;
  if (opts.lines !== null) {
    const rows = screen.replace(/\n+$/, '').split('\n');
    screen = rows.slice(-opts.lines).join('\n');
  }
  return screen;
}

// ---------- mutations -----------------------------------------------------
//
// Two flavors of each mutation:
//   - `Unlocked` — the raw operation, callable from other modules that
//     already hold the per-session lock (cc.ts uses these to compose
//     multi-step ops without deadlocking on the re-entered lock).
//   - public form — wraps `Unlocked` in `withSessionLock` for outside
//     callers (routes, manager.ts).
//
// All variants run the post-condition check; lock acquisition is the only
// difference.

export interface CreateOptions {
  cwd: string | null;
  cols: number | null;
  rows: number | null;
}

export function createUnlocked(name: string, opts: CreateOptions): { existed: boolean } {
  assertPosix();
  if (exists(name)) return { existed: true };
  // Verify the cwd up-front: tmux silently ignores `-c /bad/path` (the new
  // pane inherits the server's cwd instead of failing), so the session
  // appears to exist but at the wrong cwd. Pre-checking is the only reliable
  // way to surface the misconfiguration to the caller.
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
  const args = ['new-session', '-d', '-s', name];
  if (opts.cols) args.push('-x', String(opts.cols));
  if (opts.rows) args.push('-y', String(opts.rows));
  if (opts.cwd) args.push('-c', opts.cwd);
  // The FIRST new-session on a host starts the tmux SERVER, and the server
  // inherits the cgroup of whichever process starts it. When that process is
  // Core, `systemctl restart lm-assist` SIGTERMs the server and every Claude Code
  // pane with it — KillMode defaults to control-group. Reproduced on yitest
  // 2026-07-28, where the server was already ppid=1 and died anyway. So start it
  // in a cgroup of its own. Once a server exists, later sessions just talk to it
  // over the socket and there is nothing left to detach.
  if (readTmuxServerPid() === null) startServerDetached(args);
  // Either a server was already up, or the detached start did not take.
  if (!exists(name)) tmuxCmd(args);
  if (!exists(name)) {
    throw new TerminalError('POSTCONDITION_FAILED', `tmux new-session reported success but session ${name} does not exist`);
  }
  return { existed: false };
}

export async function create(name: string, opts: CreateOptions): Promise<{ existed: boolean }> {
  return await withSessionLock(name, async () => createUnlocked(name, opts));
}

export function killUnlocked(name: string): { killed: boolean } {
  assertPosix();
  if (!exists(name)) return { killed: false };
  tmuxCmd(['kill-session', '-t', `=${name}`]);
  if (exists(name)) {
    throw new TerminalError('POSTCONDITION_FAILED', `tmux kill-session reported success but session ${name} still exists`);
  }
  return { killed: true };
}

export async function kill(name: string): Promise<{ killed: boolean }> {
  return await withSessionLock(name, async () => killUnlocked(name));
}

/**
 * The ONE position tmux's argv parser treats specially: an argument's TRAILING
 * unescaped `;` ends the command ("echo done;" delivers "echo done"; ";"
 * delivers nothing; with further args in the same call, parsing fails outright
 * and NOTHING is delivered). Inserting a backslash before the final `;`
 * delivers the original text exactly — measured on tmux 3.2a for `;`, `\;`
 * and `;;` tails.
 */
function escapeTrailingSemicolon(s: string): string {
  return s.endsWith(';') ? `${s.slice(0, -1)}\\;` : s;
}

let pasteSeq = 0;

/**
 * Literal text delivery. Single-line text goes through `send-keys -l` (typed
 * keystrokes — CC dialogs only react to those). Text containing a line break
 * is delivered as ONE tmux paste instead: send-keys hands the app raw \n/\r
 * bytes, which a shell and CC's composer treat as Enter — submitting at the
 * first line break. `paste-buffer -p` brackets the paste only when the app
 * opted into bracketed-paste mode, so CC inserts the newlines while a plain
 * pane still gets plain bytes (with the \n→\r translation a real terminal
 * paste performs).
 */
function sendLiteralText(target: string, text: string): void {
  if (!/[\r\n]/.test(text)) {
    // `--` ends option parsing — without it, text starting with `-` errors out.
    tmuxCmd(['send-keys', '-t', target, '-l', '--', escapeTrailingSemicolon(text)]);
    return;
  }
  // Unique buffer name: concurrent sends to OTHER sessions run outside this
  // session's lock, and the automatic buffer stack would swap payloads.
  const buf = `lm-send-${process.pid}-${++pasteSeq}`;
  // CRLF collapses to LF first — paste-buffer translates every \n to \r, and
  // an untouched \r\n would land as a DOUBLE line break.
  tmuxCmd(['load-buffer', '-b', buf, '-'], DEFAULT_TIMEOUT_MS, { input: text.replace(/\r\n/g, '\n') });
  try {
    tmuxCmd(['paste-buffer', '-d', '-p', '-b', buf, '-t', target]);
  } catch (e) {
    try {
      execFileSync(TMUX, ['delete-buffer', '-b', buf], { timeout: DEFAULT_TIMEOUT_MS, stdio: 'ignore' });
    } catch { /* buffer already gone */ }
    throw e;
  }
}

export function sendKeysUnlocked(name: string, opts: SendKeysInput): void {
  assertPosix();
  const text = opts.text ?? null;
  const legacy = opts.keys ?? null;
  const keyNames = opts.keyNames ?? [];
  // Refuse a bad key BEFORE anything is typed, so a partial sequence cannot land.
  for (const k of keyNames) {
    if (!NAMED_KEYS.has(k)) {
      throw new TerminalError('INVALID_INPUT',
        `key '${k}' is not in the named-key allowlist (C-c/C-d/C-z are deliberately excluded — interrupt goes through the interrupt endpoint)`,
        { key: k });
    }
  }
  if (text === null && legacy === null && keyNames.length === 0 && !opts.enter) {
    throw new TerminalError('INVALID_INPUT', 'nothing to send: provide text, keys or enter');
  }
  if (!exists(name)) throw new TerminalError('SESSION_NOT_FOUND', `tmux session not found: ${name}`);
  const target = targetFor(name, opts.paneQualifier);
  if (text !== null) sendLiteralText(target, text);
  if (legacy !== null) {
    if (opts.literal) {
      sendLiteralText(target, legacy);
    } else {
      // One argument: a key name, or literal-text fallback for anything else.
      tmuxCmd(['send-keys', '-t', target, '--', escapeTrailingSemicolon(legacy)]);
    }
  }
  if (keyNames.length > 0) {
    tmuxCmd(['send-keys', '-t', target, '--', ...keyNames]);
  }
  // Enter is ALWAYS its own call: appended to the text argv, a trailing-`;`
  // text turned 'Enter' into a tmux COMMAND ("unknown command: Enter") and
  // the whole send delivered nothing.
  if (opts.enter) {
    tmuxCmd(['send-keys', '-t', target, 'Enter']);
  }
}

export async function sendKeys(name: string, opts: SendKeysInput): Promise<void> {
  return await withSessionLock(name, async () => sendKeysUnlocked(name, opts));
}

// ---------- multi-window support -----------------------------------------

/** List all windows in a session. */
export function listWindows(name: string): TmuxWindowState[] {
  assertPosix();
  if (!exists(name)) throw new TerminalError('SESSION_NOT_FOUND', `tmux session not found: ${name}`);
  const SEP = '\x1f';
  const stdout = tmuxCmd([
    'list-windows', '-t', `=${name}`, '-F',
    `#{window_index}${SEP}#{window_name}${SEP}#{window_active}${SEP}#{pane_current_command}${SEP}#{pane_pid}`,
  ]).stdout;
  const out: TmuxWindowState[] = [];
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const parts = line.split(SEP);
    out.push({
      index: parseInt(parts[0], 10) || 0,
      name: parts[1] || '',
      active: parts[2] === '1',
      paneCommand: parts[3] || null,
      panePid: parseInt(parts[4], 10) || null,
    });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

/** Add a new window to a session. Returns its index. */
export async function createWindow(name: string, opts: CreateWindowInput): Promise<{ index: number }> {
  assertPosix();
  return await withSessionLock(name, async () => {
    if (!exists(name)) throw new TerminalError('SESSION_NOT_FOUND', `tmux session not found: ${name}`);
    // Verify cwd if given (mirrors createUnlocked's defensive check).
    if (opts.cwd) {
      try {
        const stat = fs.statSync(opts.cwd);
        if (!stat.isDirectory()) throw new TerminalError('INVALID_INPUT', `cwd is not a directory: ${opts.cwd}`);
      } catch (e: unknown) {
        if (e instanceof TerminalError) throw e;
        throw new TerminalError('INVALID_INPUT', `cwd does not exist: ${opts.cwd}`, { cwd: opts.cwd });
      }
    }
    const before = new Set(listWindows(name).map((w) => w.index));
    const args = ['new-window', '-t', `=${name}`, '-P', '-F', '#{window_index}'];
    if (opts.cwd) args.push('-c', opts.cwd);
    if (opts.name) args.push('-n', opts.name);
    // Don't pass command via -- so we get default shell; send-keys after for
    // consistency with how createUnlocked treats the session shell.
    const stdout = tmuxCmd(args).stdout.trim();
    const newIndex = parseInt(stdout, 10);
    if (!Number.isFinite(newIndex) || before.has(newIndex)) {
      // Fallback: query and pick the highest new index.
      const after = listWindows(name).map((w) => w.index);
      const fresh = after.filter((i) => !before.has(i));
      if (fresh.length === 0) {
        throw new TerminalError('POSTCONDITION_FAILED', `new-window reported success but no new window appeared`);
      }
      return { index: fresh[fresh.length - 1] };
    }
    if (opts.command) {
      // Through the hardened path — a command ending in `;` or starting with
      // `-` corrupted or errored on the raw argv form.
      sendKeysUnlocked(name, { keys: opts.command, literal: false, enter: true, paneQualifier: String(newIndex) });
    }
    return { index: newIndex };
  });
}

/** Select (focus) a window in the session by index or name. */
export async function selectWindow(name: string, target: string): Promise<void> {
  assertPosix();
  return await withSessionLock(name, async () => {
    if (!exists(name)) throw new TerminalError('SESSION_NOT_FOUND', `tmux session not found: ${name}`);
    tmuxCmd(['select-window', '-t', `${name}:${target}`]);
  });
}

/** Kill a specific window in the session. The last window's kill also kills the session. */
export async function killWindow(name: string, target: string): Promise<{ killed: boolean; sessionGone: boolean }> {
  assertPosix();
  return await withSessionLock(name, async () => {
    if (!exists(name)) return { killed: false, sessionGone: true };
    try {
      tmuxCmd(['kill-window', '-t', `${name}:${target}`]);
    } catch (e: unknown) {
      // tmux returns error if window doesn't exist; treat as not-killed.
      if (e instanceof TerminalError && /can't find window/i.test((e.details.stderr as string) || '')) {
        return { killed: false, sessionGone: !exists(name) };
      }
      throw e;
    }
    // Session may have ended if that was the last window.
    return { killed: true, sessionGone: !exists(name) };
  });
}

export type WaitOutcome = 'matched' | 'timeout' | 'session-gone';

export async function waitFor(name: string, opts: WaitForInput): Promise<{
  outcome: WaitOutcome;
  elapsedMs: number;
  screen: string;
}> {
  assertPosix();
  const re = opts.literal ? null : new RegExp(opts.pattern, opts.flags);
  const start = Date.now();
  let screen = '';
  // No mutex on read, but check existence on each poll so we surface the
  // distinct "session went away" outcome.
  while (Date.now() - start < opts.timeoutMs) {
    if (!exists(name)) {
      return { outcome: 'session-gone', elapsedMs: Date.now() - start, screen };
    }
    try {
      screen = capture(name, { paneQualifier: opts.paneQualifier, lines: opts.lines, start: null });
    } catch (e) {
      if (e instanceof TerminalError && e.code === 'SESSION_NOT_FOUND') {
        return { outcome: 'session-gone', elapsedMs: Date.now() - start, screen };
      }
      throw e;
    }
    const hit = re ? re.test(screen) : screen.includes(opts.pattern);
    if (hit) return { outcome: 'matched', elapsedMs: Date.now() - start, screen };
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
  return { outcome: 'timeout', elapsedMs: Date.now() - start, screen };
}
