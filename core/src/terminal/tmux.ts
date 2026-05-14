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
import { execFileSync } from '../utils/exec';
import { IS_POSIX } from '../utils/process-utils';
import { TerminalError } from './errors';
import { withSessionLock } from './mutex';
import type { TmuxSessionState, SendKeysInput, WaitForInput, CaptureInput } from './types';

const TMUX = 'tmux';
const DEFAULT_TIMEOUT_MS = 5000;

// ---------- internal helpers ---------------------------------------------

function assertPosix(): void {
  if (!IS_POSIX) throw new TerminalError('PLATFORM_UNSUPPORTED', 'tmux control requires a POSIX host');
}

function tmuxCmd(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(TMUX, args, { encoding: 'utf-8', timeout: timeoutMs });
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
  tmuxCmd(args);
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

export function sendKeysUnlocked(name: string, opts: SendKeysInput): void {
  assertPosix();
  if (!exists(name)) throw new TerminalError('SESSION_NOT_FOUND', `tmux session not found: ${name}`);
  const target = targetFor(name, opts.paneQualifier);
  const args = ['send-keys', '-t', target];
  if (opts.literal) args.push('-l');
  args.push(opts.keys);
  if (opts.enter && !opts.literal) {
    args.push('Enter');
    tmuxCmd(args);
  } else {
    tmuxCmd(args);
    if (opts.enter) {
      tmuxCmd(['send-keys', '-t', target, 'Enter']);
    }
  }
}

export async function sendKeys(name: string, opts: SendKeysInput): Promise<void> {
  return await withSessionLock(name, async () => sendKeysUnlocked(name, opts));
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
