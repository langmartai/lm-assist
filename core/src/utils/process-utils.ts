/**
 * Cross-Platform Process Utilities
 *
 * Abstracts platform-specific process management operations
 * (Linux /proc, pgrep, ps, ss, df) behind cross-platform APIs
 * using npm packages: tree-kill, pidtree, find-process, check-disk-space, get-port-please.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ============================================================================
// Platform Constants
// ============================================================================

export const IS_WINDOWS = process.platform === 'win32';
export const IS_POSIX = !IS_WINDOWS; // Linux, macOS, etc.

// ============================================================================
// Process Cmdline
// ============================================================================

/**
 * Get command line for a specific PID.
 * Linux: reads /proc/{pid}/cmdline (fast, sync, no subprocess).
 * Windows/macOS: returns null (caller should use ps output or find-process).
 */
export function getProcessCmdlineSync(pid: number): string | null {
  if (IS_POSIX) {
    try {
      const cmdlinePath = `/proc/${pid}/cmdline`;
      if (!fs.existsSync(cmdlinePath)) return null;
      const cmdline = fs.readFileSync(cmdlinePath, 'utf-8');
      return cmdline.replace(/\0/g, ' ').trim();
    } catch {
      return null;
    }
  }
  // On Windows, return null — callers use alternative methods
  return null;
}

// ============================================================================
// Child PIDs
// ============================================================================

/**
 * Get child PIDs of a process (sync, cross-platform).
 * Uses pidtree which works on Windows, macOS, and Linux.
 */
export function getChildPidsSync(ppid: number): number[] {
  try {
    // pidtree provides a sync API via .sync()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pidtree = require('pidtree');
    // pidtree returns all descendants, not just direct children
    // The root PID is excluded from results
    const pids: number[] = pidtree.sync(ppid);
    return pids;
  } catch {
    return [];
  }
}

// ============================================================================
// Kill Process Tree
// ============================================================================

/**
 * Kill a process and all its descendants (cross-platform).
 * Uses tree-kill: taskkill /T on Windows, signal walk on POSIX.
 */
export function killProcessTree(pid: number, signal?: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const treeKill = require('tree-kill');
    // tree-kill is async with callback, but we fire-and-forget for compatibility
    // with the existing sync API. Errors are swallowed (process may already be dead).
    treeKill(pid, signal || 'SIGTERM', () => {});
  } catch {
    // Fallback: try killing just the main process
    try {
      process.kill(pid, (signal as NodeJS.Signals) || 'SIGTERM');
    } catch {
      // Process already dead
    }
  }
}

// ============================================================================
// Find Processes by Name
// ============================================================================

export interface FoundProcess {
  pid: number;
  name: string;
  cmd?: string;
}

/**
 * Find processes by name (cross-platform, async).
 * Uses find-process which works on Windows, macOS, and Linux.
 */
export async function findProcessesByName(name: string): Promise<FoundProcess[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const findProcess = require('find-process');
    const list: Array<{ pid: number; name: string; cmd: string }> = await findProcess('name', name);
    return list.map(p => ({ pid: p.pid, name: p.name, cmd: p.cmd }));
  } catch {
    return [];
  }
}

/**
 * Find processes by name (sync, uses pgrep on POSIX, find-process fallback concept).
 * Returns array of PIDs.
 */
export function findProcessesByNameSync(name: string): number[] {
  if (IS_POSIX) {
    try {
      const output = execFileSync('pgrep', ['-x', name], { encoding: 'utf-8' }).trim();
      if (!output) return [];
      return output.split('\n').filter(l => l.trim()).map(l => parseInt(l.trim(), 10));
    } catch {
      return [];
    }
  }
  // On Windows, sync find-process is not available; return empty.
  // Callers should use the async findProcessesByName() instead.
  return [];
}

// ============================================================================
// Process CWD
// ============================================================================

/**
 * Get the current working directory of a process.
 * Linux: reads /proc/{pid}/cwd symlink.
 * Windows/macOS: returns null (not easily available without WMI/lsof).
 */
export function getProcessCwd(pid: number): string | null {
  if (IS_POSIX) {
    try {
      const cwdLink = `/proc/${pid}/cwd`;
      if (!fs.existsSync(cwdLink)) return null;
      return fs.readlinkSync(cwdLink);
    } catch {
      return null;
    }
  }
  return null;
}

// ============================================================================
// Process Alive Check
// ============================================================================

/**
 * Check if a process is alive (cross-platform).
 * Uses process.kill(pid, 0) which works on all platforms.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Available Port Detection
// ============================================================================

/**
 * Find an available port in a range (cross-platform, async).
 * Uses get-port-please which works on Windows, macOS, and Linux.
 */
export async function findAvailablePort(
  min: number,
  max: number,
  exclude?: Set<number>,
): Promise<number | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getPort } = require('get-port-please');
    // Try ports in the range, excluding already-allocated ones
    for (let port = min; port < max; port++) {
      if (exclude && exclude.has(port)) continue;
      try {
        const available = await getPort({ port, portRange: [port, port] });
        if (available === port) return port;
      } catch {
        // Port not available, try next
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Disk Stats
// ============================================================================

export interface DiskStats {
  totalGb: number;
  usedGb: number;
  freeGb: number;
  usagePercent: number;
}

/**
 * Get disk usage statistics (cross-platform, async).
 * Uses Node.js fs.statfs (fast, no subprocess) with check-disk-space as fallback.
 */
export async function getDiskStats(diskPath?: string): Promise<DiskStats> {
  // Prefer fs.statfs (Node 18.15+) — instant, no subprocess
  try {
    const targetPath = diskPath || (IS_WINDOWS ? 'C:/' : '/');
    const stats = await new Promise<any>((resolve, reject) => {
      fs.statfs(targetPath, (err: any, s: any) => err ? reject(err) : resolve(s));
    });
    const totalGb = Math.round((stats.blocks * stats.bsize) / (1024 * 1024 * 1024));
    const freeGb = Math.round((stats.bfree * stats.bsize) / (1024 * 1024 * 1024));
    const usedGb = totalGb - freeGb;
    const usagePercent = totalGb > 0 ? Math.round((usedGb / totalGb) * 100 * 10) / 10 : 0;
    return { totalGb, usedGb, freeGb, usagePercent };
  } catch {
    // Fallback to check-disk-space
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const checkDiskSpace = require('check-disk-space').default;
      const targetPath = diskPath || (IS_WINDOWS ? 'C:' : '/');
      const info = await checkDiskSpace(targetPath);
      const totalGb = Math.round(info.size / (1024 * 1024 * 1024));
      const freeGb = Math.round(info.free / (1024 * 1024 * 1024));
      const usedGb = totalGb - freeGb;
      const usagePercent = totalGb > 0 ? Math.round((usedGb / totalGb) * 100 * 10) / 10 : 0;
      return { totalGb, usedGb, freeGb, usagePercent };
    } catch {
      return { totalGb: 0, usedGb: 0, freeGb: 0, usagePercent: 0 };
    }
  }
}

/**
 * Get disk usage statistics (sync fallback).
 * Linux: uses df command. Windows/macOS: returns zeros (use async getDiskStats instead).
 */
export function getDiskStatsSync(): DiskStats {
  if (IS_POSIX) {
    try {
      const dfOut = execFileSync('df', ['-BG', '--output=size,used,avail', '/'], {
        encoding: 'utf-8',
      }).trim();
      const dfLines = dfOut.split('\n').filter(l => l.trim() && !l.includes('Size') && !l.includes('1G-blocks'));
      if (dfLines.length > 0) {
        const parts = dfLines[0].trim().split(/\s+/);
        const totalGb = parseInt(parts[0].replace(/G$/i, ''), 10) || 0;
        const usedGb = parseInt(parts[1].replace(/G$/i, ''), 10) || 0;
        const freeGb = parseInt(parts[2].replace(/G$/i, ''), 10) || 0;
        const usagePercent = totalGb > 0 ? Math.round((usedGb / totalGb) * 100 * 10) / 10 : 0;
        return { totalGb, usedGb, freeGb, usagePercent };
      }
    } catch { /* ignore */ }
  }
  return { totalGb: 0, usedGb: 0, freeGb: 0, usagePercent: 0 };
}

// ============================================================================
// Binary Installation Check
// ============================================================================

/**
 * Check if a binary is installed on the system (cross-platform, sync).
 * Uses 'which' on POSIX, 'where' on Windows.
 */
export function isBinaryInstalled(name: string): boolean {
  try {
    const cmd = IS_WINDOWS ? 'where' : 'which';
    const output = execFileSync(cmd, [name], { encoding: 'utf-8' }).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

// ============================================================================
// Terminal Support Guard
// ============================================================================

export interface TerminalSupport {
  supported: boolean;
  ttydInstalled: boolean;
  tmuxInstalled: boolean;
  error?: string;
}

/**
 * Check if terminal features (tmux/ttyd) are supported on this platform.
 * Returns { supported: true } on POSIX with ttyd installed.
 * Returns { supported: false, error } on Windows or when ttyd is missing.
 */
export function requireTerminalSupport(): TerminalSupport {
  if (IS_WINDOWS) {
    return {
      supported: false,
      ttydInstalled: false,
      tmuxInstalled: false,
      error: 'Terminal features (ttyd/tmux) are not supported on Windows',
    };
  }

  const ttydInstalled = isBinaryInstalled('ttyd');
  const tmuxInstalled = isBinaryInstalled('tmux');

  if (!ttydInstalled) {
    return {
      supported: false,
      ttydInstalled: false,
      tmuxInstalled,
      error: 'ttyd is not installed. Install with: sudo apt install ttyd',
    };
  }

  return {
    supported: true,
    ttydInstalled: true,
    tmuxInstalled,
  };
}

// ============================================================================
// PS Output (POSIX only)
// ============================================================================

/**
 * Get output from `ps -eo pid,ppid,etimes,tty,%cpu,rss,cmd` (POSIX only).
 * Returns empty string on Windows.
 */
export function getPsOutput(): string {
  if (!IS_POSIX) return '';
  try {
    return execFileSync('ps', ['-eo', 'pid,ppid,etimes,tty,%cpu,rss,cmd'], {
      encoding: 'utf-8',
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Get ps pid,ppid output for building parent-child maps (POSIX only).
 * Returns empty string on Windows.
 */
export function getPsPidPpidOutput(): string {
  if (!IS_POSIX) return '';
  try {
    return execFileSync('ps', ['-eo', 'pid,ppid', '--no-headers'], {
      encoding: 'utf-8',
    }).trim();
  } catch {
    return '';
  }
}

// ============================================================================
// Claude Binary Path
// ============================================================================

/**
 * Get the path to the Claude binary (cross-platform).
 * Windows: relies on 'claude' being in PATH.
 * POSIX: uses ~/.local/bin/claude.
 */
export function getClaudeBinaryPath(): string {
  if (IS_WINDOWS) {
    return 'claude';
  }
  return path.join(os.homedir(), '.local/bin/claude');
}

// ============================================================================
// Shell Quoting
// ============================================================================

/**
 * Shell-escape a string for safe use in shell commands (cross-platform).
 * POSIX: single-quote wrapping.
 * Windows: double-quote wrapping with caret-escaping.
 */
export function shellQuote(str: string): string {
  if (IS_WINDOWS) {
    // Windows cmd.exe: wrap in double quotes, escape inner double quotes with caret
    return `"${str.replace(/"/g, '^"')}"`;
  }
  // POSIX: single quotes prevent all interpretation except embedded single quotes
  return `'${str.replace(/'/g, "'\\''")}'`;
}
