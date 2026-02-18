/**
 * ttyd Manager
 *
 * Manages ttyd processes for web-based Claude Code terminal access.
 * Tracks process IDs, session mappings, and prevents concurrent session conflicts.
 */

import { spawn, execFileSync, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import WebSocket from 'ws';
import { getDataDir } from './utils/path-utils';

// ============================================================================
// Types
// ============================================================================

export interface TtydProcess {
  pid: number;
  port: number;
  sessionId: string;
  projectPath: string;
  startedAt: Date;
  claudePid?: number;
}

export interface ClaudeProcessInfo {
  pid: number;
  sessionId?: string;
  projectPath?: string;
  startedAt?: Date;
  managedBy: 'ttyd' | 'ttyd-tmux' | 'ttyd-shell' | 'wrapper' | 'unmanaged-terminal' | 'unmanaged-tmux' | 'unknown';
  tty?: string;
  source?: 'console-tab' | 'full-window' | 'external-terminal' | 'unknown';  // Where the session is running
  externalTtydPort?: number;  // If external process has a ttyd we could connect to
  tmuxSessionName?: string;       // tmux session name if inside tmux
  hasAttachedTtyd?: boolean;      // whether a ttyd is attached to this tmux session
  cmdline?: string;               // full command line that started this process
  cpuPercent?: number;            // CPU usage percentage from ps
  memoryRssKb?: number;           // Resident set size in KB from ps
}

export interface SessionProcessStatus {
  sessionId: string;
  projectPath: string;
  hasRunningProcess: boolean;
  processes: ClaudeProcessInfo[];
  ttydProcess?: TtydProcess;
  canStartTtyd: boolean;
  warnings: string[];
  ttydUrl?: string;  // URL if ttyd is running (managed or external)
  activeInstance?: {
    pid: number;
    source: 'console-tab' | 'full-window' | 'external-terminal' | 'unknown';
    message: string;
    canConnect?: boolean;  // Can we connect to this external instance?
    connectUrl?: string;   // URL to connect to if external ttyd
  };
}

export interface TtydStartResult {
  success: boolean;
  port?: number;
  url?: string;
  pid?: number;
  error?: string;
  warning?: string;  // Non-blocking warnings (e.g., external session, no content yet)
}

export interface TtydInstanceRecord {
  id: string;              // UUID per launch
  pid: number;
  port: number;
  sessionId: string;
  projectPath: string;
  type: 'direct' | 'tmux' | 'fallback';
  status: 'starting' | 'running' | 'stopped' | 'dead';
  startedAt: string;       // ISO
  stoppedAt?: string;
  lastValidatedAt?: string;
  tty?: string;
  tmuxSessionName?: string;
  claudePid?: number;
}

// ============================================================================
// Constants
// ============================================================================

const TTYD_BASE_PORT = 7681;
const TTYD_PORT_RANGE = 500; // 7681-8180
const CLAUDE_BINARY = path.join(os.homedir(), '.local/bin/claude');
const PID_SESSION_MAP_LOG = path.join(os.homedir(), '.claude/pid-session-map.log');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude/projects');

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Safe execFileSync wrapper that returns empty string on error
 */
function safeExecFileSync(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

/**
 * Get output from ps command
 */
function getPsOutput(): string {
  return safeExecFileSync('ps', ['-eo', 'pid,ppid,etimes,tty,%cpu,rss,cmd']);
}

export interface SystemStats {
  cpuCount: number;
  cpuModel: string;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  cpuUsagePercent: number;
  totalMemoryMb: number;
  usedMemoryMb: number;
  freeMemoryMb: number;
  memoryUsagePercent: number;
  totalDiskGb: number;
  usedDiskGb: number;
  freeDiskGb: number;
  diskUsagePercent: number;
}

/** Get system-level CPU, memory, and disk stats */
export function getSystemStats(): SystemStats {
  const cpus = os.cpus();
  const cpuCount = cpus.length;
  const cpuModel = cpus[0]?.model || 'unknown';
  const [loadAvg1, loadAvg5, loadAvg15] = os.loadavg();
  const cpuUsagePercent = Math.round((loadAvg1 / cpuCount) * 100 * 10) / 10;
  const totalMemoryMb = Math.round(os.totalmem() / (1024 * 1024));
  const freeMemoryMb = Math.round(os.freemem() / (1024 * 1024));
  const usedMemoryMb = totalMemoryMb - freeMemoryMb;
  const memoryUsagePercent = Math.round((usedMemoryMb / totalMemoryMb) * 100 * 10) / 10;

  // Disk stats from df (values come with G suffix like "97G")
  let totalDiskGb = 0, usedDiskGb = 0, freeDiskGb = 0, diskUsagePercent = 0;
  try {
    const dfOut = safeExecFileSync('df', ['-BG', '--output=size,used,avail', '/']);
    const dfLines = dfOut.split('\n').filter(l => l.trim() && !l.includes('Size') && !l.includes('1G-blocks'));
    if (dfLines.length > 0) {
      const parts = dfLines[0].trim().split(/\s+/);
      totalDiskGb = parseInt(parts[0].replace(/G$/i, ''), 10) || 0;
      usedDiskGb = parseInt(parts[1].replace(/G$/i, ''), 10) || 0;
      freeDiskGb = parseInt(parts[2].replace(/G$/i, ''), 10) || 0;
      diskUsagePercent = totalDiskGb > 0 ? Math.round((usedDiskGb / totalDiskGb) * 100 * 10) / 10 : 0;
    }
  } catch { /* ignore */ }

  return {
    cpuCount,
    cpuModel,
    loadAvg1: Math.round(loadAvg1 * 100) / 100,
    loadAvg5: Math.round(loadAvg5 * 100) / 100,
    loadAvg15: Math.round(loadAvg15 * 100) / 100,
    cpuUsagePercent,
    totalMemoryMb,
    usedMemoryMb,
    freeMemoryMb,
    memoryUsagePercent,
    totalDiskGb,
    usedDiskGb,
    freeDiskGb,
    diskUsagePercent,
  };
}

/**
 * Get command line for a specific PID from /proc
 */
function getProcessCmdline(pid: number): string | null {
  try {
    const cmdlinePath = `/proc/${pid}/cmdline`;
    if (!fs.existsSync(cmdlinePath)) return null;
    const cmdline = fs.readFileSync(cmdlinePath, 'utf-8');
    // cmdline uses null bytes as separators
    return cmdline.replace(/\0/g, ' ').trim();
  } catch {
    return null;
  }
}

/**
 * Extract session ID from Claude command line (looks for --resume <sessionId>)
 */
function extractSessionIdFromCmdline(cmdline: string): string | null {
  // Match --resume followed by a session ID (UUID format)
  const match = cmdline.match(/--resume\s+([a-f0-9-]{36})/i);
  return match ? match[1] : null;
}

/**
 * Get child PIDs of a process
 */
function getChildPids(ppid: number): number[] {
  const output = safeExecFileSync('pgrep', ['-P', String(ppid)]);
  if (!output) return [];
  return output.split('\n').filter(l => l.trim()).map(l => parseInt(l.trim(), 10));
}
/**
 * Check if a port is in use (fast TCP probe, no subprocess)
 */
function isPortInUse(port: number): boolean {
  const net = require('net');
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(200);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  }) as any; // sync usage needs wrapper
}

/**
 * Check if a port is in use - async version (fast TCP probe, no subprocess)
 */
async function isPortInUseAsync(port: number): Promise<boolean> {
  const net = require('net');
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(200);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Build parent→children map from a ps output (pid,ppid format)
 */
function buildParentToChildrenMap(psPidPpidOutput: string): Map<number, number[]> {
  const parentToChildren = new Map<number, number[]>();
  for (const line of psPidPpidOutput.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    if (!parentToChildren.has(ppid)) parentToChildren.set(ppid, []);
    parentToChildren.get(ppid)!.push(pid);
  }
  return parentToChildren;
}

/**
 * Build a map of descendant PID → ttyd port by walking the process tree
 * Uses the shared parentToChildren map (no extra ps call)
 */
function buildTtydDescendantMap(ttydPids: number[], parentToChildren: Map<number, number[]>): Map<number, number> {
  const descendantToPort = new Map<number, number>();
  if (ttydPids.length === 0) return descendantToPort;

  // Get ttyd ports from cmdline
  const ttydPortMap = new Map<number, number>(); // ttydPid → port
  for (const ttydPid of ttydPids) {
    const cmdline = getProcessCmdline(ttydPid);
    if (!cmdline) continue;
    const portMatch = cmdline.match(/-p\s+(\d+)/);
    if (portMatch) {
      ttydPortMap.set(ttydPid, parseInt(portMatch[1], 10));
    }
  }

  // BFS from each ttyd PID to find all descendants
  for (const [ttydPid, port] of ttydPortMap) {
    const queue = [ttydPid];
    let depth = 0;
    while (queue.length > 0 && depth < 6) {
      const nextQueue: number[] = [];
      for (const pid of queue) {
        const children = parentToChildren.get(pid) || [];
        for (const child of children) {
          descendantToPort.set(child, port);
          nextQueue.push(child);
        }
      }
      queue.length = 0;
      queue.push(...nextQueue);
      depth++;
    }
  }

  return descendantToPort;
}

/**
 * Build a map from pane_pid → tmux session name by querying actual tmux panes.
 * Returns Map<panePid, tmuxSessionName> e.g. { 27670 → "33", 2933590 → "claude-bc9297eb" }.
 */
function buildTmuxPanePidMap(): Map<number, string> {
  const pidToSession = new Map<number, string>();
  try {
    const output = execFileSync('tmux', ['list-panes', '-a', '-F', '#{session_name} #{pane_pid}'], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.indexOf(' ');
      if (spaceIdx < 0) continue;
      const sessionName = trimmed.slice(0, spaceIdx);
      const panePid = parseInt(trimmed.slice(spaceIdx + 1), 10);
      if (!isNaN(panePid)) {
        pidToSession.set(panePid, sessionName);
      }
    }
  } catch {
    // tmux not running or no sessions
  }
  return pidToSession;
}

/**
 * Find the tmux session for a given PID by walking its ancestor chain
 * and matching against tmux pane_pids.
 */
function findTmuxSessionForPid(
  pid: number,
  parentMap: Map<number, number>,
  panePidMap: Map<number, string>,
): string | undefined {
  let cur = pid;
  for (let i = 0; i < 10 && cur > 1; i++) {
    const match = panePidMap.get(cur);
    if (match) return match;
    const parent = parentMap.get(cur);
    if (!parent) break;
    cur = parent;
  }
  return undefined;
}

/**
 * For each ttyd process, read its cmdline. If it contains a tmux attach/linked-session
 * command (`tmux attach-session -t <name>` or `tmux new-session -t <name>`),
 * map that session name to the ttyd port.
 * Returns Map<tmuxSessionName, ttydPort>.
 */
function buildTtydToTmuxSessionMap(ttydPids: number[]): Map<string, number> {
  const sessionToPort = new Map<string, number>();

  for (const ttydPid of ttydPids) {
    const cmdline = getProcessCmdline(ttydPid);
    if (!cmdline) continue;

    // Check if this ttyd is running a tmux attach or linked-session command
    const attachMatch = cmdline.match(/tmux\s+(?:attach(?:-session)?|new-session)\s+-t\s+(\S+)/);
    if (attachMatch) {
      const portMatch = cmdline.match(/-p\s+(\d+)/);
      if (portMatch) {
        sessionToPort.set(attachMatch[1], parseInt(portMatch[1], 10));
      }
    }
  }

  return sessionToPort;
}

/**
 * Verify ttyd is healthy by checking HTTP and tmux session
 * Returns healthy: true if connection should proceed
 * warning: optional message for non-blocking issues (e.g., external/unmanaged sessions)
 * error: only set for blocking issues
 */
async function verifyTtydHealth(
  port: number,
  sessionId: string,
  isTmuxMode: boolean,
  timeoutMs: number = 5000,
  tmuxSessionOverride?: string,
): Promise<{ healthy: boolean; error?: string; warning?: string }> {
  try {
    // Check 1: HTTP endpoint responds
    const httpOk = await checkTtydHttp(port, timeoutMs);
    if (!httpOk) {
      return { healthy: false, error: 'ttyd HTTP not responding' };
    }

    // Check 2: For tmux mode, verify tmux session exists
    if (isTmuxMode) {
      const tmuxSession = tmuxSessionOverride || `claude-${sessionId.slice(0, 8)}`;
      const tmuxCheck = checkTmuxSession(tmuxSession);
      if (!tmuxCheck.exists) {
        return { healthy: false, error: `tmux session ${tmuxSession} not created` };
      }
      // No content is a warning, not an error - allows connecting to external/unmanaged sessions
      // that may not have started outputting yet or are managed outside the session manager
      if (!tmuxCheck.hasContent) {
        return {
          healthy: true,
          warning: `tmux session ${tmuxSession} has no content yet - this may be an external or newly started session`,
        };
      }
    }

    return { healthy: true };
  } catch (error) {
    return {
      healthy: false,
      error: `Health check error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Check if ttyd HTTP endpoint is responding
 */
async function checkTtydHttp(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const http = require('http');
    const timeout = setTimeout(() => resolve(false), timeoutMs);

    const req = http.get(`http://localhost:${port}/`, (res: any) => {
      clearTimeout(timeout);
      resolve(res.statusCode === 200);
    });

    req.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

/**
 * Check if tmux session exists and has content
 */
function checkTmuxSession(sessionName: string): { exists: boolean; hasContent: boolean } {
  try {
    // Check if session exists
    const hasSession = safeExecFileSync('tmux', ['has-session', '-t', sessionName]);
    // Note: has-session returns empty string on success, error on failure

    // Capture pane content to check if there's output
    const content = safeExecFileSync('tmux', ['capture-pane', '-t', sessionName, '-p']);

    // Check if content has meaningful output (not just empty lines)
    const hasContent = content.trim().length > 10;

    return { exists: true, hasContent };
  } catch {
    return { exists: false, hasContent: false };
  }
}

/**
 * Module-level cache for install checks (never change during process lifetime)
 */
let _ttydInstalled: boolean | null = null;
let _tmuxInstalled: boolean | null = null;

/**
 * Check if ttyd is installed (cached)
 */
function isTtydInstalled(): boolean {
  if (_ttydInstalled === null) {
    const output = safeExecFileSync('which', ['ttyd']);
    _ttydInstalled = output.length > 0;
  }
  return _ttydInstalled;
}

/**
 * Check if tmux is installed (cached)
 */
function isTmuxInstalled(): boolean {
  if (_tmuxInstalled === null) {
    const output = safeExecFileSync('which', ['tmux']);
    _tmuxInstalled = output.length > 0;
  }
  return _tmuxInstalled;
}

/**
 * Get terminal theme based on OS
 */
function getTerminalTheme(): { theme: string; fontFamily: string; fontSize: number } {
  const platform = os.platform();

  // Ubuntu/Linux theme - purple background
  const ubuntuTheme = {
    background: '#300A24',
    foreground: '#FFFFFF',
    cursor: '#FFFFFF',
    black: '#2E3436',
    red: '#CC0000',
    green: '#4E9A06',
    yellow: '#C4A000',
    blue: '#3465A4',
    magenta: '#75507B',
    cyan: '#06989A',
    white: '#D3D7CF',
    brightBlack: '#555753',
    brightRed: '#EF2929',
    brightGreen: '#8AE234',
    brightYellow: '#FCE94F',
    brightBlue: '#729FCF',
    brightMagenta: '#AD7FA8',
    brightCyan: '#34E2E2',
    brightWhite: '#EEEEEC'
  };

  // macOS theme - dark mode style
  const macTheme = {
    background: '#1E1E1E',
    foreground: '#FFFFFF',
    cursor: '#FFFFFF',
    black: '#000000',
    red: '#FF5F56',
    green: '#27C93F',
    yellow: '#FFBD2E',
    blue: '#0A84FF',
    magenta: '#BF5AF2',
    cyan: '#5AC8FA',
    white: '#FFFFFF',
    brightBlack: '#666666',
    brightRed: '#FF6961',
    brightGreen: '#77DD77',
    brightYellow: '#FDFD96',
    brightBlue: '#89CFF0',
    brightMagenta: '#E0B0FF',
    brightCyan: '#76D7EA',
    brightWhite: '#FFFFFF'
  };

  // Windows theme - PowerShell/CMD style dark
  const windowsTheme = {
    background: '#012456',
    foreground: '#CCCCCC',
    cursor: '#FFFFFF',
    black: '#000000',
    red: '#CD3131',
    green: '#0DBC79',
    yellow: '#E5E510',
    blue: '#2472C8',
    magenta: '#BC3FBC',
    cyan: '#11A8CD',
    white: '#E5E5E5',
    brightBlack: '#666666',
    brightRed: '#F14C4C',
    brightGreen: '#23D18B',
    brightYellow: '#F5F543',
    brightBlue: '#3B8EEA',
    brightMagenta: '#D670D6',
    brightCyan: '#29B8DB',
    brightWhite: '#FFFFFF'
  };

  switch (platform) {
    case 'darwin':
      return {
        theme: JSON.stringify(macTheme),
        fontFamily: 'SF Mono,Menlo,monospace',
        fontSize: 13
      };
    case 'win32':
      return {
        theme: JSON.stringify(windowsTheme),
        fontFamily: 'Cascadia Mono,Consolas,monospace',
        fontSize: 14
      };
    case 'linux':
    default:
      // Check if it's Ubuntu specifically
      try {
        const osRelease = fs.readFileSync('/etc/os-release', 'utf-8');
        if (osRelease.includes('Ubuntu')) {
          return {
            theme: JSON.stringify(ubuntuTheme),
            fontFamily: 'Ubuntu Mono,monospace',
            fontSize: 16
          };
        }
      } catch {
        // Ignore, use default Linux theme
      }
      return {
        theme: JSON.stringify(ubuntuTheme),
        fontFamily: 'DejaVu Sans Mono,monospace',
        fontSize: 16
      };
  }
}

/**
 * Poll a sync or async function until it returns true, with interval and timeout
 */
async function pollUntil(fn: () => boolean | Promise<boolean>, intervalMs: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return await fn(); // Final check
}

/**
 * Kill a process tree
 */
function killProcessTree(pid: number): void {
  // First kill children
  const children = getChildPids(pid);
  for (const childPid of children) {
    try {
      process.kill(childPid, 'SIGTERM');
    } catch {
      // Ignore errors
    }
  }
  // Then kill parent
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Ignore errors
  }
}

// ============================================================================
// TtydInstanceStore — persistent store for ttyd instance records
// ============================================================================

const INSTANCE_STORE_PATH = path.join(getDataDir(), 'ttyd-instances.json');
const MAX_STORED_RECORDS = 500;

export class TtydInstanceStore {
  private instances: Map<string, TtydInstanceRecord> = new Map(); // record.id → record
  private activeBySession: Map<string, string> = new Map(); // sessionId → record.id (active only)

  constructor() {
    this.loadFromDisk();
    this.validateAllActive();
  }

  upsert(record: TtydInstanceRecord): void {
    this.instances.set(record.id, record);
    this.rebuildIndex();
    this.saveToDisk();
  }

  getActiveBySessionId(sessionId: string): TtydInstanceRecord | undefined {
    const id = this.activeBySession.get(sessionId);
    if (!id) return undefined;
    return this.instances.get(id);
  }

  getActivePorts(): Set<number> {
    const ports = new Set<number>();
    for (const record of this.instances.values()) {
      if (record.status === 'starting' || record.status === 'running') {
        ports.add(record.port);
      }
    }
    return ports;
  }

  markStopped(id: string): void {
    const record = this.instances.get(id);
    if (!record) return;
    record.status = 'stopped';
    record.stoppedAt = new Date().toISOString();
    this.activeBySession.delete(record.sessionId);
    this.saveToDisk();
  }

  markDead(id: string): void {
    const record = this.instances.get(id);
    if (!record) return;
    record.status = 'dead';
    if (!record.stoppedAt) {
      record.stoppedAt = new Date().toISOString();
    }
    this.activeBySession.delete(record.sessionId);
    this.saveToDisk();
  }

  validateAllActive(): { markedDead: number; validated: number; activeCount: number } {
    let markedDead = 0;
    let validated = 0;
    for (const record of this.instances.values()) {
      if (record.status !== 'starting' && record.status !== 'running') continue;
      validated++;
      try {
        process.kill(record.pid, 0);
        record.lastValidatedAt = new Date().toISOString();
      } catch {
        this.markDead(record.id);
        markedDead++;
      }
    }
    const activeCount = Array.from(this.instances.values()).filter(
      r => r.status === 'starting' || r.status === 'running'
    ).length;
    return { markedDead, validated, activeCount };
  }

  getAll(): TtydInstanceRecord[] {
    return Array.from(this.instances.values());
  }

  getBySessionId(sessionId: string): TtydInstanceRecord[] {
    return Array.from(this.instances.values()).filter(r => r.sessionId === sessionId);
  }

  getByStatus(status: TtydInstanceRecord['status']): TtydInstanceRecord[] {
    return Array.from(this.instances.values()).filter(r => r.status === status);
  }

  recordToProcess(record: TtydInstanceRecord): TtydProcess {
    return {
      pid: record.pid,
      port: record.port,
      sessionId: record.sessionId,
      projectPath: record.projectPath,
      startedAt: new Date(record.startedAt),
      claudePid: record.claudePid,
    };
  }

  private rebuildIndex(): void {
    this.activeBySession.clear();
    for (const record of this.instances.values()) {
      if (record.status === 'starting' || record.status === 'running') {
        this.activeBySession.set(record.sessionId, record.id);
      }
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(INSTANCE_STORE_PATH)) return;
      const data = fs.readFileSync(INSTANCE_STORE_PATH, 'utf-8');
      const records: TtydInstanceRecord[] = JSON.parse(data);
      this.instances.clear();
      for (const record of records) {
        this.instances.set(record.id, record);
      }
      this.rebuildIndex();
    } catch {
      // Start empty on any error
      this.instances.clear();
      this.activeBySession.clear();
    }
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(INSTANCE_STORE_PATH);
      fs.mkdirSync(dir, { recursive: true });
      const records = Array.from(this.instances.values())
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, MAX_STORED_RECORDS);
      // Rebuild instances map from capped records
      this.instances.clear();
      for (const record of records) {
        this.instances.set(record.id, record);
      }
      this.rebuildIndex();
      fs.writeFileSync(INSTANCE_STORE_PATH, JSON.stringify(records, null, 2));
    } catch {
      // Ignore write errors
    }
  }
}

// ============================================================================
// ttyd Manager Class
// ============================================================================

export class TtydManager {
  private store: TtydInstanceStore;
  private startingLocks: Set<string> = new Set(); // Sessions currently being started
  private allocatingPorts: Set<number> = new Set(); // Ports reserved during ttyd startup (race guard)

  constructor() {
    this.store = new TtydInstanceStore();
  }

  /**
   * Get all running Claude processes on the system
   */
  getRunningClaudeProcesses(): ClaudeProcessInfo[] {
    try {
      const psOutput = getPsOutput();
      if (!psOutput) return [];

      const processes: ClaudeProcessInfo[] = [];
      const lines = psOutput.split('\n').filter(l => l.includes('claude') && !l.includes('grep'));

      // Build shared parent→children map and child→parent map from a single ps call
      const psPidPpid = safeExecFileSync('ps', ['-eo', 'pid,ppid', '--no-headers']);
      const parentToChildren = psPidPpid ? buildParentToChildrenMap(psPidPpid) : new Map<number, number[]>();
      const pidToParent = new Map<number, number>();
      if (psPidPpid) {
        for (const line of psPidPpid.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 2) continue;
          const cpid = parseInt(parts[0], 10);
          const ppid = parseInt(parts[1], 10);
          if (!isNaN(cpid) && !isNaN(ppid)) pidToParent.set(cpid, ppid);
        }
      }

      // Build ttyd descendant map (uses shared parentToChildren, no extra ps call)
      const ttydPids = this.getAllTtydPids();
      const ttydDescendantMap = buildTtydDescendantMap(ttydPids, parentToChildren);
      const ttydChildPids = new Set<number>(ttydDescendantMap.keys());

      // Build tmux maps: pane_pid→session (ancestor matching) and ttyd→tmux session mapping
      const tmuxPanePidMap = buildTmuxPanePidMap();
      const ttydToTmuxSessionMap = buildTtydToTmuxSessionMap(ttydPids);

      // Read wrapper log once for all isTrackedByWrapper calls
      let wrapperLogContent: string | undefined;
      try {
        if (fs.existsSync(PID_SESSION_MAP_LOG)) {
          wrapperLogContent = fs.readFileSync(PID_SESSION_MAP_LOG, 'utf-8');
        }
      } catch {
        // Ignore
      }

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 7) continue;

        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        const elapsedSecs = parseInt(parts[2], 10);
        const tty = parts[3];
        const cpuPercent = parseFloat(parts[4]) || 0;
        const memoryRssKb = parseInt(parts[5], 10) || 0;
        const cmd = parts.slice(6).join(' ');

        // Skip wrapper scripts, only track actual claude binary
        if (cmd.includes('claude-wrapper') || cmd.includes('/bin/bash')) continue;
        // Skip our bash -c restart-loop wrappers (they mention "claude" in args but aren't the real binary)
        if (/^bash\s+-c\s/.test(cmd) && cmd.includes('EXIT_CODE')) continue;
        if (!cmd.includes('claude')) continue;
        // Skip MCP servers and Chrome native host
        if (cmd.includes('--chrome-native-host') || cmd.includes('-mcp')) continue;
        // Skip tmux server processes (they just manage the session)
        if (cmd.includes('tmux new-session') || cmd.includes('tmux attach')) continue;

        // Get full command line to extract session ID
        const fullCmdline = getProcessCmdline(pid) || cmd;
        let sessionId = extractSessionIdFromCmdline(fullCmdline);

        // Compute process start time from elapsed seconds
        const startedAt = new Date(Date.now() - elapsedSecs * 1000);

        // Try to get working directory of process
        let processProjectPath: string | undefined;
        try {
          const cwdLink = `/proc/${pid}/cwd`;
          if (fs.existsSync(cwdLink)) {
            processProjectPath = fs.readlinkSync(cwdLink);
          }
        } catch {
          // Process may have exited
        }

        // Skip processes that aren't real Claude binaries:
        // If the cmd doesn't contain the actual claude binary path AND the
        // process CWD has no matching session directory, it's a false positive
        // (e.g. a node script whose cmdline happens to mention "claude")
        if (!fullCmdline.includes('/bin/claude')) {
          if (!processProjectPath) continue;
          const projKey = processProjectPath.replace(/\//g, '-');
          const sessDir = path.join(CLAUDE_PROJECTS_DIR, projKey);
          if (!fs.existsSync(sessDir)) continue;
        }

        // Classify the process
        let managedBy: ClaudeProcessInfo['managedBy'] = 'unknown';
        let source: ClaudeProcessInfo['source'] = 'unknown';
        let externalTtydPort: number | undefined;
        let tmuxSessionName: string | undefined;
        let hasAttachedTtyd: boolean | undefined;

        // 1. Check if this process is a descendant of a tmux pane (ancestor chain matching)
        const tmuxSession = findTmuxSessionForPid(pid, pidToParent, tmuxPanePidMap);
        if (tmuxSession) {
          tmuxSessionName = tmuxSession;
          const ttydPort = ttydToTmuxSessionMap.get(tmuxSession);

          if (ttydPort !== undefined) {
            // tmux session has a ttyd attached → managed via ttyd-tmux
            managedBy = 'ttyd-tmux';
            source = 'console-tab';
            externalTtydPort = ttydPort;
            hasAttachedTtyd = true;
          } else {
            // tmux session with no ttyd attached → user's own tmux
            managedBy = 'unmanaged-tmux';
            source = 'external-terminal';
            hasAttachedTtyd = false;
          }
        }
        // 2. Direct ttyd descendant (no tmux)
        else if (ttydChildPids.has(pid) || ttydChildPids.has(ppid)) {
          managedBy = 'ttyd';
          source = 'console-tab';
          externalTtydPort = ttydDescendantMap.get(pid) ?? ttydDescendantMap.get(ppid);
        }
        // 3. Tracked by wrapper script
        else if (this.isTrackedByWrapper(pid, wrapperLogContent)) {
          managedBy = 'wrapper';
          source = 'full-window';
          // Try to get session ID from wrapper log if not found in cmdline
          if (!sessionId) {
            sessionId = this.getSessionFromWrapperLog(pid) ?? null;
          }
        }
        // 4. Plain terminal (has a pts)
        else if (tty && tty.startsWith('pts/')) {
          managedBy = 'unmanaged-terminal';
          source = 'external-terminal';

          // If no session ID from cmdline, try to match with recent session files
          if (!sessionId && processProjectPath) {
            sessionId = this.matchSessionByProcessTime(startedAt, processProjectPath) ?? null;
          }
        }
        // 5. Has --chrome flag but no pts → browser-based but unmanaged
        else if (fullCmdline.includes('--chrome')) {
          managedBy = 'unmanaged-terminal';
          source = 'full-window';
        }
        // 6. Unknown

        processes.push({
          pid,
          sessionId: sessionId ?? undefined,
          projectPath: processProjectPath,
          managedBy,
          source,
          tty: tty === '?' ? undefined : tty,
          startedAt,
          externalTtydPort,
          tmuxSessionName,
          hasAttachedTtyd,
          cmdline: fullCmdline,
          cpuPercent,
          memoryRssKb,
        });
      }

      // Enrich tmux processes with cached SessionIdentifier results (sync, O(1) per process)
      // Covers both unmanaged-tmux AND ttyd-tmux (user tmux sessions that had ttyd attached)
      try {
        const { getSessionIdentifier } = require('./session-identifier');
        const identifier = getSessionIdentifier();
        for (const proc of processes) {
          if ((proc.managedBy === 'unmanaged-tmux' || proc.managedBy === 'ttyd-tmux') && !proc.sessionId && proc.tmuxSessionName) {
            const cached = identifier.getCachedIdentification(proc.pid);
            if (cached) {
              proc.sessionId = cached.sessionId;
            }
          }
        }
      } catch {
        // session-identifier not loaded yet — skip
      }

      return processes;
    } catch (error) {
      console.error('Error getting Claude processes:', error);
      return [];
    }
  }

  /**
   * Find if a ttyd process is serving a specific PID (as parent or grandparent)
   */
  private findTtydPortForPid(pid: number, ttydPids?: number[]): number | undefined {
    try {
      // Check if any ttyd has this pid in its process tree
      const pids = ttydPids ?? this.getAllTtydPids();
      for (const ttydPid of pids) {
        const cmdline = getProcessCmdline(ttydPid);
        if (!cmdline) continue;

        // Get ttyd's children recursively
        const checkDescendant = (parentPid: number, depth: number): boolean => {
          if (depth > 5) return false; // Prevent infinite recursion
          const children = getChildPids(parentPid);
          for (const child of children) {
            if (child === pid) return true;
            if (checkDescendant(child, depth + 1)) return true;
          }
          return false;
        };

        if (checkDescendant(ttydPid, 0)) {
          // Extract port from command line
          const portMatch = cmdline.match(/-p\s+(\d+)/);
          if (portMatch) {
            return parseInt(portMatch[1], 10);
          }
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Match a process start time with recent session files to find session ID
   */
  private matchSessionByProcessTime(processStartTime: Date, projectPath?: string): string | undefined {
    try {
      if (!projectPath) return undefined;

      const projectHash = this.getProjectHash(projectPath);
      const sessionDir = path.join(CLAUDE_PROJECTS_DIR, projectHash);

      if (!fs.existsSync(sessionDir)) return undefined;

      // Get all session files
      const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

      // Find session file created around the same time as the process
      const timeTolerance = 60000; // 1 minute tolerance
      let bestMatch: { sessionId: string; timeDiff: number } | undefined;

      for (const file of files) {
        const sessionId = file.replace('.jsonl', '');
        const filePath = path.join(sessionDir, file);
        const stat = fs.statSync(filePath);

        // Check both creation time (birthtime) and last modified time
        const fileTime = stat.birthtime || stat.mtime;
        const timeDiff = Math.abs(fileTime.getTime() - processStartTime.getTime());

        if (timeDiff < timeTolerance) {
          if (!bestMatch || timeDiff < bestMatch.timeDiff) {
            bestMatch = { sessionId, timeDiff };
          }
        }
      }

      return bestMatch?.sessionId;
    } catch {
      return undefined;
    }
  }

  /**
   * Get all ttyd PIDs on the system
   */
  private getAllTtydPids(): number[] {
    const output = safeExecFileSync('pgrep', ['-x', 'ttyd']);
    if (!output) return [];
    return output.split('\n').filter(l => l.trim()).map(l => parseInt(l.trim(), 10));
  }

  /**
   * Find processes running a specific session ID
   */
  findProcessesForSession(sessionId: string, cachedProcesses?: ClaudeProcessInfo[]): ClaudeProcessInfo[] {
    const allProcesses = cachedProcesses ?? this.getRunningClaudeProcesses();
    return allProcesses.filter(p => p.sessionId === sessionId);
  }

  /**
   * Find ttyd master process for a session and return its port
   * This handles cases where ttyd was started before the API server
   */
  findTtydProcessForSession(sessionId: string): { pid: number; port: number } | null {
    try {
      const psOutput = getPsOutput();
      if (!psOutput) return null;

      const lines = psOutput.split('\n').filter(l => l.includes('ttyd') && l.includes(sessionId));

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;

        const pid = parseInt(parts[0], 10);
        const cmd = parts.slice(4).join(' ');

        // Check if this is a ttyd process for this session
        if (cmd.includes('ttyd') && cmd.includes(`--resume ${sessionId}`)) {
          // Extract port from command: ttyd -p PORT ...
          const portMatch = cmd.match(/-p\s+(\d+)/);
          if (portMatch) {
            return { pid, port: parseInt(portMatch[1], 10) };
          }
        }
      }

      // Also check /proc for more detailed command line
      const ttydPids = this.getAllTtydPids();
      for (const pid of ttydPids) {
        const cmdline = getProcessCmdline(pid);
        if (cmdline && cmdline.includes(sessionId)) {
          const portMatch = cmdline.match(/-p\s+(\d+)/);
          if (portMatch) {
            return { pid, port: parseInt(portMatch[1], 10) };
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if a PID is tracked in the wrapper log
   */
  private isTrackedByWrapper(pid: number, wrapperLogContent?: string): boolean {
    try {
      if (wrapperLogContent !== undefined) {
        return wrapperLogContent.includes(`${pid}|`);
      }
      if (!fs.existsSync(PID_SESSION_MAP_LOG)) return false;
      const content = fs.readFileSync(PID_SESSION_MAP_LOG, 'utf-8');
      return content.includes(`${pid}|`);
    } catch {
      return false;
    }
  }

  /**
   * Get session ID for a project path from recent session files
   */
  private getProjectHash(projectPath: string): string {
    return projectPath.replace(/\//g, '-');
  }

  /**
   * Get session status including running processes and safety check
   */
  async getSessionStatus(sessionId: string, projectPath: string): Promise<SessionProcessStatus> {
    const warnings: string[] = [];
    const processes = this.getRunningClaudeProcesses();

    // Get project directory for this session
    const projectHash = this.getProjectHash(projectPath);
    const sessionDir = path.join(CLAUDE_PROJECTS_DIR, projectHash);
    const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);

    // Check if session file exists
    if (!fs.existsSync(sessionFile)) {
      warnings.push(`Session file not found: ${sessionFile}`);
    }

    // First, check if we have a tracked ttyd instance or can find an existing one
    let activeRecord = this.store.getActiveBySessionId(sessionId);
    let ttydProcess: TtydProcess | undefined;

    // Verify tracked process is still alive (direct mode uses -o flag, exits on disconnect)
    if (activeRecord) {
      try {
        process.kill(activeRecord.pid, 0);
        // For tmux-mode instances, also verify the tmux session still exists
        if (activeRecord.type === 'tmux' && activeRecord.tmuxSessionName) {
          try {
            execFileSync('tmux', ['has-session', '-t', activeRecord.tmuxSessionName], { encoding: 'utf-8', timeout: 3000 });
          } catch {
            // tmux session gone — mark dead
            this.store.markDead(activeRecord.id);
            activeRecord = undefined;
          }
        }
        if (activeRecord) {
          ttydProcess = this.store.recordToProcess(activeRecord);
        }
      } catch {
        // Process is dead — clean up stale tracking
        this.store.markDead(activeRecord.id);
        activeRecord = undefined;
      }
    }

    if (!activeRecord) {
      const existingTtyd = this.findTtydProcessForSession(sessionId);
      if (existingTtyd) {
        // Found an existing ttyd process - register it in the store
        const record: TtydInstanceRecord = {
          id: crypto.randomUUID(),
          pid: existingTtyd.pid,
          port: existingTtyd.port,
          sessionId,
          projectPath,
          type: 'direct',
          status: 'running',
          startedAt: new Date().toISOString(),
        };
        this.store.upsert(record);
        activeRecord = record;
        ttydProcess = this.store.recordToProcess(record);
      }
    }

    // Check if this session is already running ANYWHERE (reuse cached process list)
    const sessionProcesses = this.findProcessesForSession(sessionId, processes);
    let activeInstance: SessionProcessStatus['activeInstance'];

    // Only set activeInstance if the process is NOT managed by our ttyd
    // (ttyd-managed sessions are safe to connect to)
    if (sessionProcesses.length > 0 && !ttydProcess) {
      // Check if any process is NOT ttyd-managed
      const nonTtydProcess = sessionProcesses.find(p => p.managedBy !== 'ttyd' && p.managedBy !== 'ttyd-tmux');
      if (nonTtydProcess) {
        const sourceLabel = nonTtydProcess.managedBy === 'unmanaged-tmux'
          ? `User Tmux (${nonTtydProcess.tmuxSessionName || 'unknown'})`
          : nonTtydProcess.source === 'console-tab'
            ? 'Console Tab'
            : nonTtydProcess.source === 'full-window'
              ? 'Full Window'
              : nonTtydProcess.source === 'external-terminal'
                ? 'External Terminal'
                : 'another instance';

        // Check if external process has a ttyd we can connect to
        const canConnect = !!nonTtydProcess.externalTtydPort || !!nonTtydProcess.hasAttachedTtyd;
        const connectUrl = canConnect && nonTtydProcess.externalTtydPort
          ? `http://localhost:${nonTtydProcess.externalTtydPort}` : undefined;

        activeInstance = {
          pid: nonTtydProcess.pid,
          source: nonTtydProcess.source || 'unknown',
          message: canConnect
            ? `External session detected in ${sourceLabel} (PID ${nonTtydProcess.pid}), not managed by session manager. ` +
              `You can connect to it via the web console.`
            : `External session detected in ${sourceLabel} (PID ${nonTtydProcess.pid}), not managed by session manager. ` +
              `Only one instance of a session can run at a time to prevent file corruption.`,
          canConnect,
          connectUrl,
        };

        if (!canConnect) {
          warnings.push(activeInstance.message);
        }
      }
    }

    // Find processes that might be using this session (by project path)
    // Processes already have projectPath populated from getRunningClaudeProcesses()
    const relevantProcesses: ClaudeProcessInfo[] = [];

    for (const proc of processes) {
      if (proc.projectPath === projectPath) {
        // Try to find session ID from wrapper log if not already set
        if (!proc.sessionId) {
          const sessionFromLog = this.getSessionFromWrapperLog(proc.pid);
          if (sessionFromLog) {
            proc.sessionId = sessionFromLog;
          }
        }

        relevantProcesses.push(proc);
      }
    }

    // Check for unmanaged processes (excluding those already identified as running this session)
    const unmanagedProcesses = relevantProcesses.filter(
      p => p.managedBy === 'unknown' && p.sessionId !== sessionId
    );
    if (unmanagedProcesses.length > 0) {
      warnings.push(
        `Found ${unmanagedProcesses.length} unmanaged Claude process(es). ` +
        `PIDs: ${unmanagedProcesses.map(p => p.pid).join(', ')}. ` +
        `These may cause session file corruption if a new session is started.`
      );
    }

    // Determine if it's safe to start ttyd
    // Cannot start if: session already running elsewhere (and we can't connect), unmanaged processes exist, or ttyd already running for this session
    const canStartTtyd = (!activeInstance || activeInstance.canConnect === true) && unmanagedProcesses.length === 0 && !ttydProcess;

    // Determine ttyd URL (our managed one, or external connectable one)
    const ttydUrl = ttydProcess
      ? `http://localhost:${ttydProcess.port}`
      : activeInstance?.connectUrl;

    return {
      sessionId,
      projectPath,
      hasRunningProcess: relevantProcesses.length > 0 || sessionProcesses.length > 0,
      processes: relevantProcesses,
      ttydProcess,
      canStartTtyd,
      warnings,
      ttydUrl,
      activeInstance,
    };
  }

  /**
   * Get session ID from wrapper log for a PID
   */
  private getSessionFromWrapperLog(pid: number): string | undefined {
    try {
      if (!fs.existsSync(PID_SESSION_MAP_LOG)) return undefined;
      const content = fs.readFileSync(PID_SESSION_MAP_LOG, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        if (line.startsWith(`${pid}|`)) {
          const parts = line.split('|');
          if (parts.length >= 2) {
            return parts[1];
          }
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Find an available port for ttyd (batch check with single ss call)
   */
  private findAvailablePort(): number | null {
    const output = safeExecFileSync('ss', ['-tlnp']);
    const usedPorts = new Set<number>();
    const portRegex = /:(\d+)\s/g;
    let match;
    while ((match = portRegex.exec(output)) !== null) {
      usedPorts.add(parseInt(match[1], 10));
    }
    const activePorts = this.store.getActivePorts();
    for (let port = TTYD_BASE_PORT; port < TTYD_BASE_PORT + TTYD_PORT_RANGE; port++) {
      if (!activePorts.has(port) && !usedPorts.has(port) && !this.allocatingPorts.has(port)) {
        return port;
      }
    }
    return null;
  }

  /**
   * Start ttyd for a session
   * @param options.directMode - Skip tmux for direct TTY access (required for --chrome/MCP)
   *                            Uses -o (once) flag so ttyd exits on disconnect
   */
  async startTtyd(sessionId: string, projectPath: string, options?: {
    port?: number;
    resume?: boolean;
    directMode?: boolean;  // Direct TTY access (no tmux) - enables --chrome
    force?: boolean;  // Force start even with unmanaged processes
    precomputedStatus?: SessionProcessStatus;  // Skip internal getSessionStatus() call
    existingTmuxSession?: string;  // Attach to this existing tmux session instead of creating one
    existingTmuxPane?: string;     // Target specific pane ID (e.g. "%42") within the session
    forkSession?: boolean;  // Fork from this session (uses --resume + --fork-session)
  }): Promise<TtydStartResult> {
    // CRITICAL: Check if already starting (prevents race conditions from concurrent requests)
    if (this.startingLocks.has(sessionId)) {
      // Wait a bit and check if ttyd is now running
      await new Promise(resolve => setTimeout(resolve, 2000));
      const status = await this.getSessionStatus(sessionId, projectPath);
      if (status.ttydProcess) {
        return {
          success: true,
          port: status.ttydProcess.port,
          url: `http://localhost:${status.ttydProcess.port}`,
          pid: status.ttydProcess.pid,
        };
      }
      return {
        success: false,
        error: 'Session is currently being started by another request',
      };
    }

    // Acquire lock
    this.startingLocks.add(sessionId);
    let allocatedPort: number | null = null; // Track for cleanup in finally

    try {
      // First check status (use precomputed if available)
      const status = options?.precomputedStatus ?? await this.getSessionStatus(sessionId, projectPath);

      // Check if blocking conditions can be bypassed with force
      const hasUnmanagedProcesses = status.warnings.some(w => w.includes('unmanaged'));
      const canForceBypass = options?.force && !status.ttydProcess &&
        (hasUnmanagedProcesses || !!status.activeInstance);

      if (!status.canStartTtyd && !canForceBypass) {
        if (status.ttydProcess) {
          return {
            success: true,
            port: status.ttydProcess.port,
            url: `http://localhost:${status.ttydProcess.port}`,
            pid: status.ttydProcess.pid,
          };
        }

        return {
          success: false,
          error: status.warnings.join(' '),
        };
      }

      // Log force bypass warning
      let forceWarning: string | undefined;
      if (canForceBypass) {
        if (status.activeInstance) {
          forceWarning = `Force-starting ttyd despite active instance: ${status.activeInstance.message}`;
          console.warn(`[TtydManager] ${forceWarning}`);
        } else if (hasUnmanagedProcesses) {
          forceWarning = `Force-starting ttyd despite unmanaged processes`;
          console.warn(`[TtydManager] ${forceWarning}`);
        }
      }

      // Find available port and reserve it to prevent concurrent races
      const port = options?.port || this.findAvailablePort();
      if (!port) {
        return {
          success: false,
          error: 'No available ports for ttyd',
        };
      }
      allocatedPort = port;
      this.allocatingPorts.add(port);

      // Check if ttyd is installed
      if (!isTtydInstalled()) {
        return {
          success: false,
          error: 'ttyd is not installed. Install with: sudo apt install ttyd',
        };
      }

      // Auto-detect existing tmux session for this project
      // If the caller didn't explicitly pass existingTmuxSession, check if there's
      // an unmanaged-tmux process already running for this project path — attach to it
      // instead of creating a new tmux session. No sessionId match needed; we just
      // attach ttyd to the existing tmux so the user can see what's running.
      let resolvedExistingTmux = options?.existingTmuxSession;
      let resolvedExistingPane = options?.existingTmuxPane;
      if (!resolvedExistingTmux && !options?.directMode && options?.resume !== false) {
        const allProcesses = this.getRunningClaudeProcesses();
        // Find all unmanaged-tmux candidates: prefer sessionId match, fall back to projectPath
        let candidates = allProcesses.filter(
          p => p.managedBy === 'unmanaged-tmux' && p.tmuxSessionName && p.sessionId === sessionId
        );
        if (candidates.length === 0) {
          candidates = allProcesses.filter(
            p => p.managedBy === 'unmanaged-tmux' && p.tmuxSessionName && p.projectPath === projectPath
          );
        }
        // Sort: prefer processes without an attached ttyd (available), then newest first
        candidates.sort((a, b) => {
          if (a.hasAttachedTtyd !== b.hasAttachedTtyd) return a.hasAttachedTtyd ? 1 : -1;
          return (b.startedAt?.getTime() || 0) - (a.startedAt?.getTime() || 0);
        });
        const unmanagedTmux = candidates[0];
        if (unmanagedTmux) {
          resolvedExistingTmux = unmanagedTmux.tmuxSessionName;
          console.log(`[TtydManager] Auto-detected existing tmux session '${resolvedExistingTmux}' for project ${projectPath} (PID ${unmanagedTmux.pid})`);

          // If no sessionId was provided by the caller, try to identify it from terminal content
          if (sessionId === 'unknown' || sessionId === 'unmanaged') {
            try {
              const { getSessionIdentifier } = await import('./session-identifier');
              const identifier = getSessionIdentifier();
              const identified = await identifier.identify(
                unmanagedTmux.tmuxSessionName!,
                projectPath,
                unmanagedTmux.startedAt || new Date(),
              );
              if (identified) {
                sessionId = identified.sessionId;
                console.log(`[TtydManager] Identified session '${sessionId}' for tmux '${resolvedExistingTmux}' (confidence: ${(identified.confidence * 100).toFixed(0)}%)`);
              }
            } catch {
              // Non-fatal — proceed without identified sessionId
            }
          }
        }
      }

      // Build ttyd arguments
      let ttydArgs: string[];
      let isTmuxMode = false;

      // Get OS-specific terminal theme
      const terminalStyle = getTerminalTheme();

      if (options?.directMode) {
        // DIRECT MODE: Run Claude directly with full TTY access
        // - Enables --chrome flag for MCP/Chrome integration
        // - Uses -o (once) flag: ttyd exits when client disconnects
        // - Only ONE client can connect at a time
        // - Session ends when browser tab is closed
        ttydArgs = [
          '-p', String(port),
          '-o', // Once mode: exit when client disconnects
          '-t', `theme=${terminalStyle.theme}`,
          '-t', `fontFamily=${terminalStyle.fontFamily}`,
          '-t', `fontSize=${terminalStyle.fontSize}`,
          '-w', projectPath,
          CLAUDE_BINARY,
          '--dangerously-skip-permissions',
          '--chrome', // Enable Chrome/MCP integration (requires direct TTY)
        ];

        if (options?.forkSession) {
          ttydArgs.push('--resume', sessionId, '--fork-session');
        } else if (options?.resume !== false) {
          ttydArgs.push('--resume', sessionId);
        }
      } else if (resolvedExistingTmux) {
        // RECONNECT MODE: Attach ttyd to an existing tmux session (e.g., unmanaged)
        // - Skips creating a new tmux session or claude process
        // - Just starts ttyd pointing at the existing tmux session
        // - Triggered explicitly via existingTmuxSession param, OR auto-detected
        //   from unmanaged-tmux processes running for this sessionId
        isTmuxMode = true;
        const tmuxSessionName = resolvedExistingTmux;

        // Verify the tmux session exists
        try {
          execFileSync('tmux', ['has-session', '-t', tmuxSessionName], { encoding: 'utf-8' });
        } catch {
          return { success: false, error: `tmux session '${tmuxSessionName}' not found` };
        }

        // Pre-declare terminal features so tmux doesn't probe with DA queries
        // (Prevents xterm.js DA2 responses like [>0;276;0c leaking into pane input)
        try {
          execFileSync('tmux', ['set', '-s', 'terminal-features[0]',
            'xterm*:256:clipboard:ccolour:cstyle:focus:mouse:overline:rectfill:RGB:strikethrough:title:usstyle',
          ], { encoding: 'utf-8' });
          execFileSync('tmux', ['set', '-s', 'escape-time', '25'], { encoding: 'utf-8' });
        } catch {
          // tmux < 3.2 doesn't support terminal-features — ignore
        }

        // If a specific pane is targeted, select it before attaching so tmux
        // shows the correct pane (session may have multiple panes/windows).
        const tmuxPane = resolvedExistingPane;
        const selectCmd = tmuxPane ? `tmux select-pane -t '${tmuxPane}' 2>/dev/null; ` : '';
        // Use linked session (new-session -t) for independent sizing — avoids dots
        // when multiple clients attach with different terminal sizes.
        // destroy-unattached auto-cleans the linked session when the ttyd client disconnects.
        const tmuxCmd = `${selectCmd}tmux new-session -t ${tmuxSessionName} \\; set-option destroy-unattached on`;
        ttydArgs = [
          '-p', String(port),
          '-t', `theme=${terminalStyle.theme}`,
          '-t', `fontFamily=${terminalStyle.fontFamily}`,
          '-t', `fontSize=${terminalStyle.fontSize}`,
          '-w', projectPath,
          'bash', '-c', tmuxCmd,
        ];
      } else if (isTmuxInstalled()) {
        // TMUX MODE: Use tmux to allow multiple browser tabs to share session
        // - Multiple tabs can view the same terminal
        // - Session persists when tabs are closed
        // - --chrome NOT supported (no direct TTY access)
        isTmuxMode = true;
        const tmuxSessionName = `claude-${sessionId.slice(0, 8)}`;

        // Build the claude command (no --chrome in tmux mode)
        // Wrap in a shell that keeps the tmux session alive if claude exits/fails
        // This way ttyd can always attach, and the user sees the error message
        const resumeCmd = `${CLAUDE_BINARY} --dangerously-skip-permissions --resume ${sessionId}`;
        const forkCmd = `${CLAUDE_BINARY} --dangerously-skip-permissions --resume ${sessionId} --fork-session`;
        const freshCmd = `${CLAUDE_BINARY} --dangerously-skip-permissions`;
        // Shell wrapper: try --resume first, if it fails quickly (< 3s) fall back to fresh session
        // If claude exits normally or after running for a while, show restart prompt
        // For forks: use --fork-session on first run, then freshCmd for restarts
        const firstRunCmd = options?.forkSession ? forkCmd : resumeCmd;
        const claudeCmd = options?.resume !== false || options?.forkSession
          ? `bash -c 'START=$(date +%s); ${firstRunCmd}; EXIT_CODE=$?; END=$(date +%s); ELAPSED=$((END - START)); if [ $EXIT_CODE -ne 0 ] && [ $ELAPSED -lt 3 ]; then echo ""; echo "[Could not resume session. Starting fresh Claude session...]"; echo ""; ${freshCmd}; EXIT_CODE=$?; fi; while true; do echo ""; echo "[Claude exited with code $EXIT_CODE. Press Enter to restart, or Ctrl+C to exit]"; read; ${freshCmd}; EXIT_CODE=$?; done'`
          : `bash -c 'while true; do ${freshCmd}; EXIT_CODE=$?; echo ""; echo "[Claude exited with code $EXIT_CODE. Press Enter to restart, or Ctrl+C to exit]"; read; done'`;

        // Check if tmux session already exists
        let sessionCreatedNow = false;
        let tmuxSessionExists = false;
        try {
          execFileSync('tmux', ['has-session', '-t', tmuxSessionName], { encoding: 'utf-8' });
          tmuxSessionExists = true;
        } catch {
          // Session doesn't exist
        }

        if (tmuxSessionExists) {
          // Check if the pane is dead (e.g. process was killed) — if so, respawn it
          try {
            const paneDeadCheck = safeExecFileSync('tmux', [
              'list-panes', '-t', tmuxSessionName,
              '-F', '#{pane_dead}',
            ]).trim();
            if (paneDeadCheck === '1') {
              // Pane is dead — kill the old session and recreate it
              try {
                execFileSync('tmux', ['kill-session', '-t', tmuxSessionName], { encoding: 'utf-8' });
              } catch {
                // Ignore kill errors
              }
              tmuxSessionExists = false;
            }
          } catch {
            // If we can't check, treat as non-existent and recreate
            tmuxSessionExists = false;
          }
        }

        if (!tmuxSessionExists) {
          // Create the tmux session. If the global `destroy-unattached` is `on`
          // (user setting: "Close session on terminal exit"), any detached session
          // gets killed immediately. We temporarily disable it, create the session,
          // set per-session `destroy-unattached off`, then restore the original
          // global value. All execFileSync calls are synchronous and block the
          // event loop, so no other JS code can interleave — no mutex needed.
          //
          // Per-session overrides (always set regardless of global):
          //   - destroy-unattached off: parent session survives detached (ttyd connects later via linked session)
          //   - remain-on-exit on: pane stays alive even if Claude exits/crashes
          try {
            // Save current global destroy-unattached value (respects user's setting page preference)
            let globalDestroyUnattached = 'off'; // tmux default
            try {
              globalDestroyUnattached = execFileSync('tmux', ['show-options', '-gv', 'destroy-unattached'], {
                encoding: 'utf-8', timeout: 3000,
              }).trim();
            } catch { /* tmux not running or option not set — use default */ }

            // Temporarily disable if it's on (otherwise session dies before we can set per-session override)
            if (globalDestroyUnattached === 'on') {
              try { execFileSync('tmux', ['set-option', '-g', 'destroy-unattached', 'off'], { encoding: 'utf-8', timeout: 3000 }); } catch {}
            }

            try {
              execFileSync('tmux', [
                'new-session', '-d',
                '-s', tmuxSessionName,
                '-c', projectPath,
                claudeCmd,
              ], { encoding: 'utf-8', timeout: 5000 });
              sessionCreatedNow = true;

              // Set per-session options — destroy-unattached and remain-on-exit are critical,
              // status and mouse are cosmetic (wrapped in individual try/catch)
              execFileSync('tmux', ['set-option', '-t', tmuxSessionName, 'destroy-unattached', 'off'], { encoding: 'utf-8', timeout: 3000 });
              execFileSync('tmux', ['set-option', '-t', tmuxSessionName, 'remain-on-exit', 'on'], { encoding: 'utf-8', timeout: 3000 });
              try { execFileSync('tmux', ['set-option', '-t', tmuxSessionName, 'status', 'off'], { encoding: 'utf-8', timeout: 3000 }); } catch { /* cosmetic */ }
              try { execFileSync('tmux', ['set-option', '-t', tmuxSessionName, 'mouse', 'on'], { encoding: 'utf-8', timeout: 3000 }); } catch { /* cosmetic */ }
            } finally {
              // Restore global to original value (respects user's "Close session on terminal exit" preference)
              if (globalDestroyUnattached === 'on') {
                try { execFileSync('tmux', ['set-option', '-g', 'destroy-unattached', 'on'], { encoding: 'utf-8', timeout: 3000 }); } catch {}
              }
            }

            // Pre-declare terminal features so tmux doesn't probe with DA queries
            // (Prevents xterm.js DA2 responses like [>0;276;0c leaking into pane input)
            try {
              execFileSync('tmux', ['set', '-s', 'terminal-features[0]',
                'xterm*:256:clipboard:ccolour:cstyle:focus:mouse:overline:rectfill:RGB:strikethrough:title:usstyle',
              ], { encoding: 'utf-8', timeout: 3000 });
              execFileSync('tmux', ['set', '-s', 'escape-time', '25'], { encoding: 'utf-8', timeout: 3000 });
            } catch {
              // tmux < 3.2 doesn't support terminal-features — ignore
            }

            // Wait for tmux session to be ready (poll every 200ms, max 2s)
            const tmuxSessionName2 = tmuxSessionName; // capture for closure
            await pollUntil(() => {
              const check = checkTmuxSession(tmuxSessionName2);
              return check.exists;
            }, 200, 2000);
          } catch (tmuxError) {
            return {
              success: false,
              error: `Failed to create tmux session: ${tmuxError instanceof Error ? tmuxError.message : String(tmuxError)}`,
            };
          }
        }

        // Use linked session for independent sizing — each ttyd client gets its
        // own size without causing dots on other clients. destroy-unattached
        // auto-cleans the linked session when the ttyd client disconnects.
        const tmuxCmd = `tmux new-session -t ${tmuxSessionName} \\; set-option destroy-unattached on`;

        ttydArgs = [
          '-p', String(port),
          '-t', `theme=${terminalStyle.theme}`,
          '-t', `fontFamily=${terminalStyle.fontFamily}`,
          '-t', `fontSize=${terminalStyle.fontSize}`,
          '-w', projectPath,
          'bash', '-c', tmuxCmd,
        ];
      } else {
        // FALLBACK: No tmux, run claude directly with connection limit
        // - Only ONE client can connect at a time
        // - --chrome NOT supported (use directMode for that)
        ttydArgs = [
          '-p', String(port),
          '-m', '1', // Max 1 client connection when tmux not available
          '-t', `theme=${terminalStyle.theme}`,
          '-t', `fontFamily=${terminalStyle.fontFamily}`,
          '-t', `fontSize=${terminalStyle.fontSize}`,
          '-w', projectPath,
          CLAUDE_BINARY,
          '--dangerously-skip-permissions',
        ];

        if (options?.forkSession) {
          ttydArgs.push('--resume', sessionId, '--fork-session');
        } else if (options?.resume !== false) {
          ttydArgs.push('--resume', sessionId);
        }
      }

      // Start ttyd using spawn (safe - no shell)
      const ttydProcess = spawn('ttyd', ttydArgs, {
        detached: true,
        stdio: 'ignore',
      });

      ttydProcess.unref();

      // Determine instance type
      const instanceType: TtydInstanceRecord['type'] = options?.directMode
        ? 'direct'
        : isTmuxMode
          ? 'tmux'
          : 'fallback';

      // Track the process immediately with 'starting' status
      const record: TtydInstanceRecord = {
        id: crypto.randomUUID(),
        pid: ttydProcess.pid!,
        port,
        sessionId,
        projectPath,
        type: instanceType,
        status: 'starting',
        startedAt: new Date().toISOString(),
        tmuxSessionName: isTmuxMode
          ? (resolvedExistingTmux || `claude-${sessionId.slice(0, 8)}`)
          : undefined,
      };
      this.store.upsert(record);

      // Wait for ttyd to bind to port (poll every 50ms using async TCP probe, max 3s)
      const portReady = await pollUntil(() => isPortInUseAsync(port), 50, 3000);

      // Verify it's running
      if (!portReady) {
        this.store.markDead(record.id);
        return {
          success: false,
          error: 'ttyd failed to start - port not bound',
        };
      }

      // Verify ttyd is actually healthy and terminal is working
      const healthCheck = await verifyTtydHealth(port, sessionId, isTmuxMode, 2000, resolvedExistingTmux);
      if (!healthCheck.healthy) {
        // Try to clean up the failed process
        try {
          killProcessTree(ttydProcess.pid!);
        } catch {
          // Ignore cleanup errors
        }
        this.store.markDead(record.id);
        return {
          success: false,
          error: `ttyd started but terminal is not healthy: ${healthCheck.error}`,
        };
      }

      // Log warning if present but continue (non-blocking issues like external sessions)
      if (healthCheck.warning) {
        console.warn(`[TtydManager] Warning for session ${sessionId}: ${healthCheck.warning}`);
      }

      // Health check passed — update status to running
      record.status = 'running';
      this.store.upsert(record);

      return {
        success: true,
        port,
        url: `http://localhost:${port}`,
        pid: ttydProcess.pid,
        warning: forceWarning || healthCheck.warning,  // Pass through force or health check warning
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to start ttyd: ${error}`,
      };
    } finally {
      // Always release the lock and port reservation
      this.startingLocks.delete(sessionId);
      if (allocatedPort !== null) this.allocatingPorts.delete(allocatedPort);
    }
  }

  /**
   * Start a plain shell terminal (no Claude session).
   * Uses a synthetic session ID for tracking in the instance store.
   */
  async startShell(shellSessionId: string, projectPath: string, shellPath: string, options?: {
    port?: number;
  }): Promise<TtydStartResult> {
    // Find available port
    const port = options?.port || this.findAvailablePort();
    if (!port) {
      return { success: false, error: 'No available ports for ttyd' };
    }

    this.allocatingPorts.add(port);

    try {
      const terminalStyle = getTerminalTheme();

      const ttydArgs = [
        '-p', String(port),
        '-t', `theme=${terminalStyle.theme}`,
        '-t', `fontFamily=${terminalStyle.fontFamily}`,
        '-t', `fontSize=${terminalStyle.fontSize}`,
        '-w', projectPath,
        shellPath,
      ];

      const ttydProcess = spawn('ttyd', ttydArgs, {
        detached: true,
        stdio: 'ignore',
      });

      ttydProcess.unref();

      // Track instance with 'ttyd-shell' type metadata in the sessionId
      const record: TtydInstanceRecord = {
        id: crypto.randomUUID(),
        pid: ttydProcess.pid!,
        port,
        sessionId: shellSessionId,
        projectPath,
        type: 'direct',
        status: 'starting',
        startedAt: new Date().toISOString(),
      };
      this.store.upsert(record);

      // Wait for ttyd to bind to port
      const portReady = await pollUntil(() => isPortInUseAsync(port), 50, 3000);

      if (!portReady) {
        this.store.markDead(record.id);
        return { success: false, error: 'ttyd failed to start - port not bound' };
      }

      record.status = 'running';
      this.store.upsert(record);

      return {
        success: true,
        port,
        url: `http://localhost:${port}`,
        pid: ttydProcess.pid,
      };
    } catch (error) {
      return { success: false, error: `Failed to start shell ttyd: ${error}` };
    } finally {
      this.allocatingPorts.delete(port);
    }
  }

  /**
   * Stop ttyd for a session
   */
  async stopTtyd(sessionId: string): Promise<{ success: boolean; error?: string }> {
    const activeRecord = this.store.getActiveBySessionId(sessionId);

    if (!activeRecord) {
      // No tracked process — still success (already stopped)
      return { success: true };
    }

    // Mark stopped in the persistent store
    this.store.markStopped(activeRecord.id);

    try {
      // Check if process is still alive before killing
      process.kill(activeRecord.pid, 0);
      killProcessTree(activeRecord.pid);
    } catch {
      // Process already dead — that's fine
    }

    return { success: true };
  }

  /**
   * Kill all processes for a session (ttyd, wrapper, or any claude process running this session)
   */
  async killSessionProcesses(sessionId: string): Promise<{ success: boolean; killed: number[]; errors: string[] }> {
    const killed: number[] = [];
    const errors: string[] = [];

    // First, stop any tracked ttyd process
    const activeRecord = this.store.getActiveBySessionId(sessionId);
    if (activeRecord) {
      try {
        killProcessTree(activeRecord.pid);
        killed.push(activeRecord.pid);
        this.store.markStopped(activeRecord.id);
      } catch (error) {
        errors.push(`Failed to kill ttyd process ${activeRecord.pid}: ${error}`);
      }
    }

    // Find all processes running this session
    const sessionProcesses = this.findProcessesForSession(sessionId);

    for (const proc of sessionProcesses) {
      if (killed.includes(proc.pid)) continue; // Already killed

      try {
        killProcessTree(proc.pid);
        killed.push(proc.pid);
      } catch (error) {
        errors.push(`Failed to kill process ${proc.pid}: ${error}`);
      }
    }

    // Also kill any wrapper processes that might be parents
    const allProcesses = this.getRunningClaudeProcesses();
    for (const proc of allProcesses) {
      if (killed.includes(proc.pid)) continue;
      if (proc.managedBy === 'wrapper' && proc.sessionId === sessionId) {
        try {
          killProcessTree(proc.pid);
          killed.push(proc.pid);
        } catch (error) {
          errors.push(`Failed to kill wrapper process ${proc.pid}: ${error}`);
        }
      }
    }

    return {
      success: killed.length > 0 || errors.length === 0,
      killed,
      errors,
    };
  }

  /**
   * Kill a specific process by PID (with safety checks)
   */
  async killProcess(pid: number): Promise<{ success: boolean; error?: string }> {
    // Verify this is a claude-related process
    const allProcesses = this.getRunningClaudeProcesses();
    const proc = allProcesses.find(p => p.pid === pid);

    if (!proc) {
      return { success: false, error: `PID ${pid} is not a Claude-related process` };
    }

    try {
      killProcessTree(pid);

      // Clean up tracking if this was a tracked ttyd instance
      const activeRecords = this.store.getAll().filter(
        r => (r.status === 'starting' || r.status === 'running') &&
          (r.pid === pid || r.claudePid === pid)
      );
      for (const record of activeRecords) {
        this.store.markStopped(record.id);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: `Failed to kill process ${pid}: ${error}` };
    }
  }

  /**
   * Get all managed ttyd processes (active only, backward compat)
   */
  getAllProcesses(): TtydProcess[] {
    return this.store.getAll()
      .filter(r => r.status === 'starting' || r.status === 'running')
      .map(r => this.store.recordToProcess(r));
  }

  /**
   * Get ttyd process by session ID (active only, backward compat)
   */
  getProcessBySessionId(sessionId: string): TtydProcess | undefined {
    const record = this.store.getActiveBySessionId(sessionId);
    return record ? this.store.recordToProcess(record) : undefined;
  }

  /**
   * Clean up dead processes and return validation results
   */
  cleanup(): { markedDead: number; validated: number; activeCount: number } {
    return this.store.validateAllActive();
  }

  /**
   * Get recent instance records (all statuses), sorted by startedAt desc
   */
  getRecentInstances(limit: number = 50): TtydInstanceRecord[] {
    return this.store.getAll()
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  /**
   * Get all instance records for a session (active and historical)
   */
  getInstancesBySessionId(sessionId: string): TtydInstanceRecord[] {
    return this.store.getBySessionId(sessionId);
  }

  /**
   * Get instance records by status
   */
  getInstancesByStatus(status: TtydInstanceRecord['status']): TtydInstanceRecord[] {
    return this.store.getByStatus(status);
  }

  /**
   * Get the underlying instance store (for route access)
   */
  getInstanceStore(): TtydInstanceStore {
    return this.store;
  }

  /**
   * Check if an existing ttyd instance for a session is still healthy.
   * Unhealthy means the ttyd should be stopped and restarted. Checks:
   * 1. ttyd process is alive
   * 2. For tmux mode: the tmux pane is running Claude (not just bash)
   * 3. For tmux mode: the ttyd is attached to the NEWEST Claude process for this session
   *    (catches the case where user resumed session in a new terminal)
   */
  checkTtydSessionHealth(sessionId: string, cachedProcesses?: ClaudeProcessInfo[]): { healthy: boolean; reason?: string } {
    const record = this.store.getActiveBySessionId(sessionId);
    if (!record) {
      return { healthy: false, reason: 'No active ttyd instance' };
    }

    // Check if the ttyd process is alive
    try {
      process.kill(record.pid, 0);
    } catch {
      return { healthy: false, reason: 'ttyd process is dead' };
    }

    // For non-tmux modes, alive process = healthy
    if (record.type !== 'tmux' || !record.tmuxSessionName) {
      return { healthy: true };
    }

    // For tmux mode: check if the tmux pane is still running Claude.
    // Grace period: skip this check for recently started instances. New sessions
    // (resume=false) don't launch Claude until a web client connects to ttyd,
    // so the pane shows 'bash' during startup. Allow 60s for the user to open
    // the console before declaring unhealthy.
    const ageMs = Date.now() - new Date(record.startedAt).getTime();
    const GRACE_PERIOD_MS = 60_000;

    try {
      const paneCmd = safeExecFileSync('tmux', [
        'list-panes', '-t', record.tmuxSessionName,
        '-F', '#{pane_current_command}',
      ]).trim();

      if (!paneCmd) {
        return { healthy: false, reason: `tmux session '${record.tmuxSessionName}' has no panes` };
      }

      // Check if any pane is running claude (could be claude, claude-native, etc.)
      const paneCommands = paneCmd.split('\n').map(c => c.trim());
      const hasClaudeRunning = paneCommands.some(cmd => cmd.includes('claude'));

      if (!hasClaudeRunning) {
        if (ageMs < GRACE_PERIOD_MS) {
          // Within grace period — Claude may not have started yet
          return { healthy: true };
        }
        return {
          healthy: false,
          reason: `tmux session '${record.tmuxSessionName}' pane is running '${paneCommands[0]}', not Claude`,
        };
      }
    } catch {
      // tmux session doesn't exist anymore
      return { healthy: false, reason: `tmux session '${record.tmuxSessionName}' not found` };
    }

    // Check if a NEWER Claude process for this session exists in a different tmux session.
    // This catches the case where the user resumed the session in a new terminal —
    // the old tmux still has Claude running but the user wants to see the new one.
    try {
      const allProcesses = cachedProcesses ?? this.getRunningClaudeProcesses();
      const matchingProcesses = allProcesses.filter(
        p => p.sessionId === sessionId && p.tmuxSessionName
      );

      if (matchingProcesses.length > 1) {
        // Find the most recently started process
        const newest = matchingProcesses.reduce((a, b) =>
          (b.startedAt?.getTime() || 0) > (a.startedAt?.getTime() || 0) ? b : a
        );

        if (newest.tmuxSessionName && newest.tmuxSessionName !== record.tmuxSessionName) {
          return {
            healthy: false,
            reason: `Newer Claude process for session found in tmux '${newest.tmuxSessionName}' (PID ${newest.pid}), ttyd attached to older '${record.tmuxSessionName}'`,
          };
        }
      }
    } catch {
      // Non-fatal — if process scan fails, still consider healthy based on pane check
    }

    return { healthy: true };
  }
}

// Singleton instance
let ttydManager: TtydManager | null = null;

export function getTtydManager(): TtydManager {
  if (!ttydManager) {
    ttydManager = new TtydManager();
  }
  return ttydManager;
}

export function createTtydManager(): TtydManager {
  return new TtydManager();
}
