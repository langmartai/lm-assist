/**
 * Terminal Manager
 *
 * Creates and controls terminal tabs across platforms, using tmux as the
 * uniform control surface.
 *
 * Supported tab kinds:
 *   - "gnome"    Linux: opens a new gnome-terminal --tab (requires a running
 *                X/Wayland session owned by the current user).
 *   - "wt-ssh"   Windows: opens a new Windows Terminal tab that SSHes into a
 *                remote Linux host and attaches to a tmux session. Uses a
 *                scheduled task under the hood to bridge SSH session 0 → the
 *                interactive console session 1.
 *   - "tmux"     No GUI viewer — just creates/controls a detached tmux
 *                session on this host. The session is the controllable unit;
 *                any number of viewers (ttyd, native terminals, SSH clients)
 *                can attach.
 *
 * Cross-machine control: all endpoints exposed by routes/core/terminal.routes
 * are callable from another lm-assist instance via the Hub API relay — the
 * caller just targets the host where the tmux session (or desired tab kind)
 * actually lives.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn } from './utils/exec';
import { IS_WINDOWS, IS_POSIX } from './utils/process-utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TabKind = 'gnome' | 'wt-ssh' | 'tmux';

export interface CreateTabOptions {
  kind: TabKind;
  /** Optional title shown in the tab. */
  title?: string;
  /** Working directory for the spawned shell (local tabs only). */
  cwd?: string;
  /**
   * Shell command to run when the tab opens. For `tmux` kind this is the
   * command executed inside the newly-created tmux window. For `gnome`
   * without a tmux session, this runs in the tab directly.
   */
  command?: string;
  /**
   * tmux session name to attach to (or create if it doesn't exist). When
   * set, the tab always lands inside tmux, and control is via tmux.
   */
  tmuxSession?: string;
  /**
   * SSH target for `wt-ssh` tabs, e.g. `ubuntu@10.0.1.117`. The tab will run
   * `ssh -t <target> tmux attach -t <tmuxSession>` (or the given command).
   */
  sshTarget?: string;
  /** Extra env vars set only inside the spawned command. */
  env?: Record<string, string>;
  /** tmux pane size when creating a new session. */
  cols?: number;
  rows?: number;
}

export interface TabRecord {
  id: string;
  kind: TabKind;
  title: string | null;
  tmuxSession: string | null;
  sshTarget: string | null;
  command: string | null;
  cwd: string | null;
  createdAt: string;
  /** Platform-specific bookkeeping (e.g. Windows scheduled-task name). */
  meta: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Registry (in-memory + persisted JSON)
// ---------------------------------------------------------------------------

const REGISTRY_DIR = path.join(os.homedir(), '.cache', 'lm-assist');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'terminal-tabs.json');

function loadRegistry(): Record<string, TabRecord> {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveRegistry(reg: Record<string, TabRecord>): void {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2) + '\n');
}

function newId(): string {
  return 'tab-' + Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------------------
// tmux primitives (POSIX only — Windows lm-assist controls remote tmux via SSH)
// ---------------------------------------------------------------------------

export class TmuxError extends Error {
  constructor(message: string, public stderr?: string) { super(message); }
}

function tmuxBin(): string {
  if (IS_WINDOWS) throw new TmuxError('tmux control requires a POSIX host');
  return 'tmux';
}

export interface TmuxCreateOptions {
  name: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  command?: string;
}

export function tmuxCreate(opts: TmuxCreateOptions): void {
  const args = ['new-session', '-d', '-s', opts.name];
  if (opts.cols) args.push('-x', String(opts.cols));
  if (opts.rows) args.push('-y', String(opts.rows));
  if (opts.cwd) args.push('-c', opts.cwd);
  if (opts.command) args.push(opts.command);
  try {
    execFileSync(tmuxBin(), args, { encoding: 'utf-8', timeout: 5000 });
  } catch (e: any) {
    const msg = e?.stderr?.toString() || e?.message || String(e);
    if (/duplicate session/i.test(msg)) return; // idempotent
    throw new TmuxError(`tmux new-session failed: ${msg}`);
  }
}

export function tmuxKill(name: string): void {
  try {
    execFileSync(tmuxBin(), ['kill-session', '-t', name], { encoding: 'utf-8', timeout: 5000 });
  } catch (e: any) {
    const msg = e?.stderr?.toString() || '';
    if (/can't find session|no server running/i.test(msg)) return;
    throw new TmuxError(`tmux kill-session failed: ${msg}`);
  }
}

export interface TmuxSessionInfo {
  name: string;
  windows: number;
  attached: boolean;
  created: number;
}

export function tmuxList(): TmuxSessionInfo[] {
  try {
    const out = execFileSync(tmuxBin(), [
      'list-sessions', '-F',
      '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}',
    ], { encoding: 'utf-8', timeout: 5000 });
    return out.trim().split('\n').filter(Boolean).map((line: string) => {
      const [name, windows, attached, created] = line.split('\t');
      return {
        name,
        windows: parseInt(windows, 10) || 0,
        attached: attached === '1',
        created: parseInt(created, 10) || 0,
      };
    });
  } catch (e: any) {
    const msg = e?.stderr?.toString() || '';
    if (/no server running/i.test(msg)) return [];
    throw new TmuxError(`tmux list-sessions failed: ${msg}`);
  }
}

export interface SendKeysOptions {
  /** Text (or tmux key names like 'Enter', 'C-c'). */
  keys: string;
  /** If true, send as literal text (tmux -l) — no key-name interpretation. */
  literal?: boolean;
  /** If true, append Enter after the keys. */
  enter?: boolean;
  /** tmux target, defaults to session name. Use 'name:win.pane' for pane. */
  target?: string;
}

export function tmuxSendKeys(session: string, opts: SendKeysOptions): void {
  const target = opts.target || session;
  const args = ['send-keys', '-t', target];
  if (opts.literal) args.push('-l');
  args.push(opts.keys);
  try {
    execFileSync(tmuxBin(), args, { encoding: 'utf-8', timeout: 5000 });
    if (opts.enter) {
      execFileSync(tmuxBin(), ['send-keys', '-t', target, 'Enter'], { encoding: 'utf-8', timeout: 5000 });
    }
  } catch (e: any) {
    throw new TmuxError(`tmux send-keys failed: ${e?.stderr?.toString() || e?.message}`);
  }
}

export function tmuxCapture(session: string, opts: { lines?: number; target?: string; start?: number } = {}): string {
  const target = opts.target || session;
  const args = ['capture-pane', '-t', target, '-p'];
  if (typeof opts.start === 'number') args.push('-S', String(opts.start));
  try {
    const out = execFileSync(tmuxBin(), args, { encoding: 'utf-8', timeout: 5000 });
    if (opts.lines && opts.lines > 0) {
      // Trim trailing blank lines so "last N" reflects visible content, not
      // the empty bottom rows of an unattached session.
      const all = out.replace(/\n+$/, '').split('\n');
      return all.slice(-opts.lines).join('\n');
    }
    return out;
  } catch (e: any) {
    throw new TmuxError(`tmux capture-pane failed: ${e?.stderr?.toString() || e?.message}`);
  }
}

export interface WaitForOptions {
  pattern: string;
  /** Interpret pattern as regex (default) or literal substring. */
  literal?: boolean;
  flags?: string;
  timeoutMs?: number;
  pollMs?: number;
  target?: string;
  lines?: number;
}

export async function tmuxWaitFor(session: string, opts: WaitForOptions): Promise<{
  matched: boolean;
  elapsedMs: number;
  screen: string;
}> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const pollMs = opts.pollMs ?? 200;
  const re = opts.literal
    ? null
    : new RegExp(opts.pattern, opts.flags || '');
  const start = Date.now();
  let screen = '';
  while (Date.now() - start < timeoutMs) {
    try {
      screen = tmuxCapture(session, { target: opts.target, lines: opts.lines });
    } catch (e) {
      // session may have gone away mid-wait
      return { matched: false, elapsedMs: Date.now() - start, screen };
    }
    const hit = re ? re.test(screen) : screen.includes(opts.pattern);
    if (hit) return { matched: true, elapsedMs: Date.now() - start, screen };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { matched: false, elapsedMs: Date.now() - start, screen };
}

// ---------------------------------------------------------------------------
// Native GNOME terminal tab (Linux)
// ---------------------------------------------------------------------------

/**
 * Find a logged-in desktop session's DISPLAY/DBus env vars so we can spawn
 * gnome-terminal from a headless context (SSH, service). Looks at the running
 * gnome-terminal-server process, then falls back to gnome-shell.
 */
function findDesktopEnv(): Record<string, string> | null {
  if (!IS_POSIX) return null;
  const candidates = ['gnome-terminal-server', 'gnome-shell', 'Xorg'];
  for (const name of candidates) {
    try {
      const pids = execFileSync('pgrep', ['-u', String(process.getuid?.() ?? 1000), '-x', name], { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try {
          const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
          const env: Record<string, string> = {};
          for (const kv of raw.split('\0')) {
            const i = kv.indexOf('=');
            if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
          }
          if (env.DISPLAY || env.WAYLAND_DISPLAY) return env;
        } catch { /* ignore */ }
      }
    } catch { /* pgrep miss */ }
  }
  return null;
}

interface GnomeTabResult {
  pid: number | null;
  displayEnv: Record<string, string> | null;
}

function openGnomeTab(o: CreateTabOptions): GnomeTabResult {
  if (!IS_POSIX) throw new Error('gnome-terminal is only available on POSIX');
  const desk = findDesktopEnv();
  const env: Record<string, string> = { ...process.env as any };
  // Propagate the desktop session's display vars if we're running headless.
  if (desk) {
    for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY']) {
      if (desk[k]) env[k] = desk[k];
    }
  }
  for (const [k, v] of Object.entries(o.env || {})) env[k] = v;

  const args: string[] = ['--tab'];
  if (o.title) args.push(`--title=${o.title}`);
  if (o.cwd) args.push(`--working-directory=${o.cwd}`);

  // Build the inner command. If tmuxSession is specified we attach (creating
  // if needed via -A); otherwise run the user command in a shell that stays
  // open.
  if (o.tmuxSession) {
    tmuxCreate({ name: o.tmuxSession, cwd: o.cwd, cols: o.cols, rows: o.rows });
    if (o.command) {
      // send command into tmux so the tab shows it running
      tmuxSendKeys(o.tmuxSession, { keys: o.command, enter: true });
    }
    args.push('--', 'bash', '-lc', `tmux attach -t ${shellQuote(o.tmuxSession)}`);
  } else if (o.command) {
    args.push('--', 'bash', '-lc', `${o.command}; exec bash`);
  }

  const child = spawn('gnome-terminal', args, { env, detached: true, stdio: 'ignore' });
  child.unref();
  return { pid: child.pid ?? null, displayEnv: desk };
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Windows Terminal tab over SSH (Windows lm-assist host)
// ---------------------------------------------------------------------------

/**
 * SSH session 0 → console session 1 bridge. We register a named scheduled
 * task that invokes a batch file; each request rewrites the batch file and
 * kicks off the task. The task is created on first use and left in place.
 */
const WT_TASK_NAME = 'LmAssistOpenWtTab';
const WT_BAT_PATH = path.join(os.homedir(), '.lm-assist-run-wt.bat');

function windowsEscape(s: string): string {
  // Escape for cmd.exe `call`-style single-line arg. Avoid `&|<>^` by
  // wrapping in double quotes and escaping embedded double quotes.
  return `"${s.replace(/"/g, '""').replace(/[&|<>^]/g, '^$&')}"`;
}

function ensureWtScheduledTask(): void {
  if (!IS_WINDOWS) throw new Error('wt-ssh tabs can only be opened from a Windows lm-assist host');
  try {
    execFileSync('schtasks', ['/query', '/tn', WT_TASK_NAME], { timeout: 5000 });
    return;
  } catch { /* not yet created */ }
  // Create a one-shot task pointed at the bat file we'll rewrite per call.
  execFileSync('schtasks', [
    '/create', '/tn', WT_TASK_NAME,
    '/tr', WT_BAT_PATH,
    '/sc', 'once', '/st', '23:59',
    '/f',
  ], { timeout: 10000 });
}

function writeWtBat(o: CreateTabOptions): void {
  const lines: string[] = ['@echo off'];
  // Compose the wt.exe invocation. Use -w 0 to open in existing WT window,
  // falling through to a new window if none exists.
  const title = o.title || 'lm-assist';
  let wtTail: string;
  if (o.kind === 'wt-ssh') {
    if (!o.sshTarget) throw new Error('wt-ssh requires sshTarget');
    const sshCmd = o.tmuxSession
      ? `tmux new-session -A -s ${shellQuote(o.tmuxSession)}${o.command ? ' ' + shellQuote(o.command) : ''}`
      : (o.command || 'bash -l');
    // ssh -t forces a pty which is needed for interactive shells + tmux.
    wtTail = `ssh -t ${o.sshTarget} ${windowsEscape(sshCmd)}`;
  } else {
    wtTail = o.command ? `cmd /k ${windowsEscape(o.command)}` : 'cmd';
  }
  lines.push(`wt.exe -w 0 new-tab --title ${windowsEscape(title)} ${wtTail}`);
  fs.writeFileSync(WT_BAT_PATH, lines.join('\r\n') + '\r\n');
}

function openWtTab(o: CreateTabOptions): { taskName: string } {
  ensureWtScheduledTask();
  writeWtBat(o);
  execFileSync('schtasks', ['/run', '/tn', WT_TASK_NAME], { timeout: 10000 });
  return { taskName: WT_TASK_NAME };
}

// ---------------------------------------------------------------------------
// Public manager API
// ---------------------------------------------------------------------------

export class TerminalManager {
  private tabs: Record<string, TabRecord> = loadRegistry();

  listTabs(): TabRecord[] { return Object.values(this.tabs); }

  getTab(id: string): TabRecord | undefined { return this.tabs[id]; }

  createTab(o: CreateTabOptions): TabRecord {
    if (!o.kind) throw new Error('kind is required');
    const id = newId();
    const meta: Record<string, any> = {};

    if (o.kind === 'gnome') {
      if (!IS_POSIX) throw new Error('gnome tabs require a POSIX host');
      const res = openGnomeTab(o);
      meta.pid = res.pid;
      meta.displayAvailable = !!res.displayEnv;
    } else if (o.kind === 'wt-ssh') {
      if (!IS_WINDOWS) throw new Error('wt-ssh tabs must be created from a Windows lm-assist host');
      const res = openWtTab(o);
      meta.scheduledTask = res.taskName;
    } else if (o.kind === 'tmux') {
      if (!o.tmuxSession) throw new Error('tmux kind requires tmuxSession');
      // Create with default shell (not command-as-shell which exits immediately),
      // then send the command as input so the session persists for control.
      tmuxCreate({ name: o.tmuxSession, cwd: o.cwd, cols: o.cols, rows: o.rows });
      if (o.command) {
        tmuxSendKeys(o.tmuxSession, { keys: o.command, enter: true });
      }
    } else {
      throw new Error(`unsupported tab kind: ${o.kind}`);
    }

    const rec: TabRecord = {
      id,
      kind: o.kind,
      title: o.title || null,
      tmuxSession: o.tmuxSession || null,
      sshTarget: o.sshTarget || null,
      command: o.command || null,
      cwd: o.cwd || null,
      createdAt: new Date().toISOString(),
      meta,
    };
    this.tabs[id] = rec;
    saveRegistry(this.tabs);
    return rec;
  }

  deleteTab(id: string): { removed: boolean; killedTmux: boolean } {
    const rec = this.tabs[id];
    if (!rec) return { removed: false, killedTmux: false };
    let killedTmux = false;
    if (rec.tmuxSession && IS_POSIX) {
      try { tmuxKill(rec.tmuxSession); killedTmux = true; } catch { /* ignore */ }
    }
    delete this.tabs[id];
    saveRegistry(this.tabs);
    return { removed: true, killedTmux };
  }

  // ---- CC convenience wrappers (tmux-pivot pattern) ---------------------

  /**
   * Launch Claude Code inside a new (or existing) tmux session and wait for
   * its prompt indicator to appear. Returns when CC is ready to receive a
   * prompt.
   */
  async ccLaunch(params: {
    tmuxSession: string;
    cwd: string;
    model?: string;
    flags?: string[];
    readyPattern?: string;
    readyTimeoutMs?: number;
  }): Promise<{ ready: boolean; elapsedMs: number; screen: string }> {
    tmuxCreate({ name: params.tmuxSession, cwd: params.cwd, cols: 220, rows: 60 });
    const flags = params.flags || ['--dangerously-skip-permissions'];
    const model = params.model ? ['--model', params.model] : [];
    const cmd = `claude ${[...flags, ...model].map(shellQuote).join(' ')}`;
    tmuxSendKeys(params.tmuxSession, { keys: cmd, enter: true });
    const wait = await tmuxWaitFor(params.tmuxSession, {
      pattern: params.readyPattern || 'ctx:',
      timeoutMs: params.readyTimeoutMs ?? 30000,
      lines: 20,
    });
    return { ready: wait.matched, elapsedMs: wait.elapsedMs, screen: wait.screen };
  }

  /**
   * Pivot a running CC to a different session:
   *   /resume <id> Enter → wait for prompt → send literal text → Enter
   */
  async ccPivot(params: {
    tmuxSession: string;
    newSessionId: string;
    prompt: string;
    promptPattern?: string;
    timeoutMs?: number;
  }): Promise<{ pivoted: boolean; elapsedMs: number; screen: string }> {
    const start = Date.now();
    tmuxSendKeys(params.tmuxSession, { keys: `/resume ${params.newSessionId}`, enter: true });
    const wait = await tmuxWaitFor(params.tmuxSession, {
      pattern: params.promptPattern || '❯',
      timeoutMs: params.timeoutMs ?? 15000,
      lines: 10,
    });
    if (!wait.matched) {
      return { pivoted: false, elapsedMs: Date.now() - start, screen: wait.screen };
    }
    tmuxSendKeys(params.tmuxSession, { keys: params.prompt, literal: true });
    tmuxSendKeys(params.tmuxSession, { keys: 'Enter' });
    return { pivoted: true, elapsedMs: Date.now() - start, screen: wait.screen };
  }

  /** Send a plain prompt to a running CC tmux session. */
  ccPrompt(tmuxSession: string, text: string): void {
    tmuxSendKeys(tmuxSession, { keys: text, literal: true });
    tmuxSendKeys(tmuxSession, { keys: 'Enter' });
  }
}

// Singleton
let instance: TerminalManager | null = null;
export function getTerminalManager(): TerminalManager {
  if (!instance) instance = new TerminalManager();
  return instance;
}

// Re-exports for convenience
export const _internal = {
  findDesktopEnv,
  shellQuote,
  writeWtBat,
  ensureWtScheduledTask,
  WT_TASK_NAME,
  WT_BAT_PATH,
};
