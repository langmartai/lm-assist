/**
 * Process Status Store
 *
 * In-memory cache of running Claude process classification data with
 * background refresh. All API endpoints read from this store for O(1)
 * lookups instead of calling getRunningClaudeProcesses() synchronously.
 *
 * Pattern follows HookEventStore / TtydInstanceStore singleton approach.
 *
 * @packageDocumentation
 */

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import * as os from 'os';
import type { ClaudeProcessInfo, SystemStats } from './ttyd-manager';
import { IS_WINDOWS } from './utils/process-utils';

export interface ProcessRunningInfo {
  pid: number;
  source: string;
  managedBy: string;
  tmuxSessionName?: string;
  hasAttachedTtyd?: boolean;
}

/** Pre-computed response for GET /ttyd/processes — ready to return without blocking */
export interface CachedProcessResponse {
  managed: Array<{ pid: number; port: number; sessionId: string; projectPath: string; startedAt: string }>;
  allClaudeProcesses: ClaudeProcessInfo[];
  summary: {
    totalManaged: number;
    totalClaude: number;
    unmanagedCount: number;
    byCategory: Record<string, number>;
  };
  processStatus: {
    totalProcesses: number;
    runningSessions: number;
    lastRefreshedAt: string | null;
    intervalMs: number | null;
  };
  systemStats: SystemStats;
}

export class ProcessStatusStore {
  private cachedProcesses: ClaudeProcessInfo[] = [];
  private cachedResponse: CachedProcessResponse | null = null;
  private runningBySession = new Map<string, ProcessRunningInfo>();
  private lastRefreshedAt: Date | null = null;
  private refreshInterval: NodeJS.Timeout | null = null;
  private refreshing = false;
  /** Hash of the current process state — changes when process list changes */
  private _hash: string = '';
  /** Counter for periodic deep health checks (every 15 refreshes = ~15s at 1s interval) */
  private deepCheckCounter = 0;
  /** Windows: cached disk stats (fetched in background to avoid wmic slowness) */
  private _cachedDiskStats: { totalGb: number; usedGb: number; freeGb: number; usagePercent: number } | null = null;
  private _diskStatsUpdatedAt = 0;
  private _diskStatsFetching = false;

  constructor(private intervalMs = 1000) {}

  /** Start background refresh loop */
  start(): void {
    if (this.refreshInterval) return;
    this.refresh(); // initial sync refresh
    this.refreshInterval = setInterval(() => this.refresh(), this.intervalMs);
  }

  /** Stop background refresh */
  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  /** Refresh from ttydManager.getRunningClaudeProcesses() + cleanup */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      // On Windows: skip all process management (no ttyd/tmux/ps).
      // Just collect system stats using Node.js built-ins.
      if (IS_WINDOWS) {
        await this.refreshWindows();
        return;
      }

      await this.refreshPosix();
    } catch (e) {
      console.error('ProcessStatusStore refresh error:', e);
    } finally {
      this.refreshing = false;
    }
  }

  /** Windows refresh: system stats only, no process scanning */
  private async refreshWindows(): Promise<void> {
    const cpus = os.cpus();
    const cpuCount = cpus.length;
    const cpuModel = cpus[0]?.model || 'unknown';
    const [loadAvg1, loadAvg5, loadAvg15] = os.loadavg();
    const cpuUsagePercent = Math.round((loadAvg1 / cpuCount) * 100 * 10) / 10;
    const totalMemoryMb = Math.round(os.totalmem() / (1024 * 1024));
    const freeMemoryMb = Math.round(os.freemem() / (1024 * 1024));
    const usedMemoryMb = totalMemoryMb - freeMemoryMb;
    const memoryUsagePercent = Math.round((usedMemoryMb / totalMemoryMb) * 100 * 10) / 10;

    // Disk stats: use cached value or background-fetch to avoid wmic slowness
    let diskStats = this._cachedDiskStats;
    if (!diskStats || Date.now() - this._diskStatsUpdatedAt > 60_000) {
      // Fire-and-forget disk stats update (runs in background, doesn't block refresh)
      if (!this._diskStatsFetching) {
        this._diskStatsFetching = true;
        import('./utils/process-utils').then(pu => pu.getDiskStats()).then(ds => {
          this._cachedDiskStats = ds;
          this._diskStatsUpdatedAt = Date.now();
          this._diskStatsFetching = false;
        }).catch(() => { this._diskStatsFetching = false; });
      }
    }

    const systemStats: SystemStats = {
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
      totalDiskGb: diskStats?.totalGb ?? 0,
      usedDiskGb: diskStats?.usedGb ?? 0,
      freeDiskGb: diskStats?.freeGb ?? 0,
      diskUsagePercent: diskStats?.usagePercent ?? 0,
    };

    this.cachedProcesses = [];
    this.runningBySession = new Map();
    this.lastRefreshedAt = new Date();

    this.cachedResponse = {
      managed: [],
      allClaudeProcesses: [],
      summary: {
        totalManaged: 0,
        totalClaude: 0,
        unmanagedCount: 0,
        byCategory: {},
      },
      processStatus: this.getStats(),
      systemStats,
    };

    this._hash = createHash('md5')
      .update(`win-${systemStats.cpuUsagePercent}:${systemStats.usedMemoryMb}:${systemStats.totalDiskGb}`)
      .digest('hex').slice(0, 12);
  }

  /** POSIX refresh: full process scanning, tmux health checks, etc. */
  private async refreshPosix(): Promise<void> {
      const { getTtydManager } = await import('./ttyd-manager');
      const mgr = getTtydManager();

      // Cleanup dead ttyd instances (previously done per-request)
      mgr.cleanup();

      const processes = mgr.getRunningClaudeProcesses();
      this.cachedProcesses = processes;

      // Cached identifications are already applied by getRunningClaudeProcesses().
      // Here we: (1) clean up dead PIDs, (2) trigger async identification for uncached ones.
      const { getSessionIdentifier } = await import('./session-identifier');
      const identifier = getSessionIdentifier();
      identifier.cleanup(new Set(processes.map(p => p.pid)));

      for (const proc of processes) {
        if ((proc.managedBy === 'unmanaged-tmux' || proc.managedBy === 'ttyd-tmux') && !proc.sessionId && proc.tmuxSessionName) {
          // Schedule async identification (non-blocking, result appears next refresh)
          if (identifier.shouldAttempt(proc.pid) && proc.projectPath && proc.startedAt) {
            identifier.identifyForPid(proc.pid, proc.tmuxSessionName, proc.projectPath, proc.startedAt)
              .catch(() => {}); // Will retry after cooldown
          }
        }
      }

      const bySession = new Map<string, ProcessRunningInfo>();
      for (const proc of processes) {
        if (proc.sessionId) {
          bySession.set(proc.sessionId, {
            pid: proc.pid,
            source: proc.source || 'unknown',
            managedBy: proc.managedBy,
            tmuxSessionName: proc.tmuxSessionName,
            hasAttachedTtyd: proc.hasAttachedTtyd,
          });
        }
      }
      this.runningBySession = bySession;
      this.lastRefreshedAt = new Date();

      // Reconcile managed ttyd entries: if the ttyd is attached to a tmux session
      // whose Claude process has been identified with a different sessionId, update
      // the instance store so managed entries stay in sync with reality.
      const instanceStore = mgr.getInstanceStore();
      const tmuxToSession = new Map<string, string>();
      for (const proc of processes) {
        if (proc.tmuxSessionName && proc.sessionId) {
          tmuxToSession.set(proc.tmuxSessionName, proc.sessionId);
        }
      }
      for (const record of instanceStore.getAll()) {
        if ((record.status === 'starting' || record.status === 'running') && record.tmuxSessionName) {
          const identifiedSessionId = tmuxToSession.get(record.tmuxSessionName);
          if (identifiedSessionId && identifiedSessionId !== record.sessionId) {
            record.sessionId = identifiedSessionId;
            instanceStore.upsert(record);
          }
        }
      }

      // Periodic deep health check: every 15 refreshes (~15s), validate tmux-mode
      // ttyd instances are still healthy. If stale, stop them proactively so the
      // next console request gets a fresh one.
      this.deepCheckCounter++;
      if (this.deepCheckCounter % 15 === 0) {
        let aliveTmuxSessions: Set<string>;
        try {
          const tmuxOut = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
            encoding: 'utf-8', timeout: 3000,
          }).trim();
          aliveTmuxSessions = new Set(tmuxOut ? tmuxOut.split('\n').map(s => s.trim()) : []);
        } catch {
          aliveTmuxSessions = new Set(); // tmux not running or no sessions
        }

        for (const record of instanceStore.getAll()) {
          if ((record.status === 'running' || record.status === 'starting') && record.type === 'tmux' && record.tmuxSessionName) {
            try {
              process.kill(record.pid, 0);
            } catch {
              console.log(`[ProcessStatusStore] Deep health check: ttyd PID ${record.pid} dead for session ${record.sessionId}. Marking dead.`);
              instanceStore.markDead(record.id);
              continue;
            }
            if (!aliveTmuxSessions.has(record.tmuxSessionName)) {
              console.log(`[ProcessStatusStore] Deep health check: tmux '${record.tmuxSessionName}' gone for session ${record.sessionId} (PID ${record.pid}). Stopping.`);
              try { process.kill(record.pid, 'SIGTERM'); } catch { /* already dead */ }
              instanceStore.markDead(record.id);
            }
          }
        }
      }

      // Pre-compute the full response object
      const managed = mgr.getAllProcesses().map(p => ({
        pid: p.pid,
        port: p.port,
        sessionId: p.sessionId,
        projectPath: p.projectPath,
        startedAt: p.startedAt instanceof Date ? p.startedAt.toISOString() : String(p.startedAt),
      }));

      const unmanagedCount = processes.filter(p =>
        p.managedBy === 'unknown' ||
        p.managedBy === 'unmanaged-terminal' ||
        p.managedBy === 'unmanaged-tmux'
      ).length;

      // Inject shell ttyd instances (not Claude processes, but tracked in instance store)
      const allInstances = instanceStore.getAll();
      for (const inst of allInstances) {
        if (inst.sessionId.startsWith('shell-') && (inst.status === 'running' || inst.status === 'starting')) {
          try {
            process.kill(inst.pid, 0);
            processes.push({
              pid: inst.pid,
              sessionId: inst.sessionId,
              projectPath: inst.projectPath,
              startedAt: new Date(inst.startedAt),
              managedBy: 'ttyd-shell',
              source: 'console-tab',
            });
          } catch {
            instanceStore.markDead(inst.id);
          }
        }
      }

      const byCategory: Record<string, number> = {
        'ttyd': 0, 'ttyd-tmux': 0, 'ttyd-shell': 0, 'wrapper': 0,
        'unmanaged-terminal': 0, 'unmanaged-tmux': 0, 'unknown': 0,
      };
      for (const p of processes) {
        byCategory[p.managedBy] = (byCategory[p.managedBy] || 0) + 1;
      }

      const { getSystemStats } = await import('./ttyd-manager');
      const systemStats = await getSystemStats();

      this.cachedResponse = {
        managed,
        allClaudeProcesses: processes,
        summary: {
          totalManaged: managed.length,
          totalClaude: processes.length,
          unmanagedCount,
          byCategory,
        },
        processStatus: this.getStats(),
        systemStats,
      };

      // Compute hash from sorted PIDs + managed ports + resource usage
      const pidKey = processes.map(p => `${p.pid}:${p.managedBy}:${p.sessionId || ''}:${p.cpuPercent}:${p.memoryRssKb}`).sort().join('|');
      const managedKey = managed.map(p => `${p.pid}:${p.port}:${p.sessionId}`).sort().join('|');
      const statsKey = `${systemStats.cpuUsagePercent}:${systemStats.usedMemoryMb}`;
      this._hash = createHash('md5').update(pidKey + '||' + managedKey + '||' + statsKey).digest('hex').slice(0, 12);
  }

  /** Read cached processes (O(1)) */
  getCachedProcesses(): ClaudeProcessInfo[] {
    return this.cachedProcesses;
  }

  /** Read pre-computed full response for GET /ttyd/processes (O(1)) */
  getCachedResponse(): CachedProcessResponse | null {
    return this.cachedResponse;
  }

  /** Get current hash — changes when process list changes */
  getHash(): string {
    return this._hash;
  }

  /** Read cached session→process map (O(1)) */
  getRunningSessionMap(): Map<string, ProcessRunningInfo> {
    return this.runningBySession;
  }

  /** Check if a session has a running process */
  isSessionRunning(sessionId: string): boolean {
    return this.runningBySession.has(sessionId);
  }

  /** Get process info for a session */
  getSessionProcess(sessionId: string): ProcessRunningInfo | undefined {
    return this.runningBySession.get(sessionId);
  }

  /** Get store stats */
  getStats() {
    return {
      totalProcesses: this.cachedProcesses.length,
      runningSessions: this.runningBySession.size,
      lastRefreshedAt: this.lastRefreshedAt?.toISOString() || null,
      intervalMs: this.refreshInterval ? this.intervalMs : null,
    };
  }
}

// Singleton
let instance: ProcessStatusStore | null = null;

export function getProcessStatusStore(): ProcessStatusStore {
  if (!instance) {
    instance = new ProcessStatusStore();
    instance.start();
  }
  return instance;
}
