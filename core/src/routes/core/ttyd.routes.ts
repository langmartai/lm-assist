/**
 * ttyd Routes
 *
 * Endpoints for managing web-based Claude Code terminal access via ttyd.
 *
 * Endpoints:
 *   GET  /ttyd/status                        Get ttyd installation status
 *   GET  /ttyd/processes                     List all ttyd-managed processes
 *   GET  /ttyd/instances                     Query ttyd instance history
 *   GET  /ttyd/session/:sessionId/status     Check session process status
 *   POST /ttyd/session/:sessionId/start      Start ttyd for session
 *   POST /ttyd/session/:sessionId/stop       Stop ttyd for session
 *   POST /ttyd/process/identify               PID-based session identify with screen-to-turn matching
 *   POST /ttyd/session/identify              Identify session for unmanaged tmux
 */

import type { RouteHandler, RouteContext } from '../index';
import { getTtydManager } from '../../ttyd-manager';
import { getTtydProxyUrl } from '../../ttyd-proxy';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { IS_WINDOWS, IS_POSIX, isBinaryInstalled } from '../../utils/process-utils';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude/projects');
import * as fs from 'fs';
import { decodePath } from '../../utils/path-utils';

/**
 * Find projectPath from sessionId by scanning ~/.claude/projects/
 * Returns the decoded project path (e.g., "/home/ubuntu/tier-agent")
 */
async function findProjectPathForSession(sessionId: string): Promise<string | null> {
  try {
    const projects = await fs.promises.readdir(CLAUDE_PROJECTS_DIR);

    for (const projectDir of projects) {
      // Check for session directory (sessions with subagents)
      const sessionDirPath = path.join(CLAUDE_PROJECTS_DIR, projectDir, sessionId);
      // Check for session .jsonl file (all sessions)
      const sessionFilePath = path.join(CLAUDE_PROJECTS_DIR, projectDir, `${sessionId}.jsonl`);

      try {
        await fs.promises.access(sessionFilePath);
        return decodePath(projectDir);
      } catch {
        // No .jsonl file, check directory
      }

      try {
        const stat = await fs.promises.stat(sessionDirPath);
        if (stat.isDirectory()) {
          return decodePath(projectDir);
        }
      } catch {
        // Session not in this project dir
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get base URL for proxy from request headers
 */
function getProxyBaseUrl(req: any): string {
  const host = req.headers?.host || 'localhost:3100';
  const protocol = req.headers?.['x-forwarded-proto'] || 'http';
  return `${protocol}://${host}`;
}

/**
 * Check if ttyd is installed (cross-platform)
 */
function isTtydInstalled(): boolean {
  if (IS_WINDOWS) return false;
  return isBinaryInstalled('ttyd');
}

/**
 * Get ttyd version (POSIX only)
 */
function getTtydVersion(): string | null {
  if (IS_WINDOWS) return null;
  try {
    const output = execFileSync('ttyd', ['--version'], { encoding: 'utf-8' });
    const match = output.match(/ttyd\s+([\d.]+)/);
    return match ? match[1] : output.trim().split('\n')[0];
  } catch {
    return null;
  }
}

/**
 * Decode project path from URL-safe format
 */
function decodeProjectPath(encoded: string): string {
  // Handle URL-encoded paths
  const decoded = decodeURIComponent(encoded);
  // Convert dashes back to slashes if it looks like an encoded path
  if (decoded.startsWith('-')) {
    return decoded.replace(/-/g, '/');
  }
  return decoded;
}

export function createTtydRoutes(ctx: RouteContext): RouteHandler[] {
  const ttydManager = getTtydManager();

  return [
    // GET /ttyd/status - Get ttyd installation status
    {
      method: 'GET',
      pattern: /^\/ttyd\/status$/,
      handler: async (req, api) => {
        const platformSupported = IS_POSIX;
        const installed = platformSupported ? isTtydInstalled() : false;
        const version = installed ? getTtydVersion() : null;
        const processes = ttydManager.getAllProcesses();

        return {
          success: true,
          data: {
            installed,
            version,
            platformSupported,
            activeProcesses: processes.length,
            installCommand: platformSupported ? 'sudo apt install ttyd' : 'Not supported on this platform',
          },
        };
      },
    },

    // GET /ttyd/processes - List all ttyd-managed processes
    // Returns pre-computed cached data instantly (background refreshes every 1s)
    // Query params:
    //   forceCheck=true  — trigger async background refresh
    //   hash=<string>    — delta check: if hash matches current state, returns { unchanged: true }
    {
      method: 'GET',
      pattern: /^\/ttyd\/processes$/,
      handler: async (req, api) => {
        const { getProcessStatusStore } = await import('../../process-status-store');
        const processStore = getProcessStatusStore();

        // forceCheck triggers background refresh but doesn't block the response
        if (req.query.forceCheck === 'true') {
          processStore.refresh(); // fire-and-forget (no await)
        }

        const currentHash = processStore.getHash();

        // Delta check: if client sends hash and it matches, return minimal response
        if (req.query.hash && req.query.hash === currentHash) {
          return {
            success: true,
            unchanged: true,
            hash: currentHash,
          };
        }

        // Return pre-computed cached response (O(1), no ps/pgrep/cleanup calls)
        const cached = processStore.getCachedResponse();
        if (cached) {
          const baseUrl = getProxyBaseUrl(req);
          return {
            success: true,
            hash: currentHash,
            data: {
              ...cached,
              managed: cached.managed.map(p => ({
                ...p,
                url: getTtydProxyUrl(p.port, baseUrl),
              })),
            },
          };
        }

        // First request before any refresh has completed
        return {
          success: true,
          hash: currentHash,
          data: {
            managed: [],
            allClaudeProcesses: [],
            summary: { totalManaged: 0, totalClaude: 0, unmanagedCount: 0, byCategory: {} },
            processStatus: processStore.getStats(),
          },
        };
      },
    },

    // GET /ttyd/session/:sessionId/status - Check session process status
    {
      method: 'GET',
      pattern: /^\/ttyd\/session\/(?<sessionId>[^/]+)\/status$/,
      handler: async (req, api) => {
        const { sessionId } = req.params;
        const projectPath = req.query.projectPath || ctx.projectPath;

        if (!projectPath) {
          return {
            success: false,
            error: 'projectPath query parameter is required',
          };
        }

        const decodedPath = decodeProjectPath(projectPath);
        const status = await ttydManager.getSessionStatus(sessionId, decodedPath);
        const baseUrl = getProxyBaseUrl(req);

        return {
          success: true,
          data: {
            ...status,
            ttydUrl: status.ttydProcess
              ? getTtydProxyUrl(status.ttydProcess.port, baseUrl)
              : null,
            // Clear indicator if session can be started
            canStart: status.canStartTtyd,
            blockedReason: status.activeInstance
              ? `Session already running in ${status.activeInstance.source}`
              : status.warnings.length > 0
                ? status.warnings[0]
                : null,
          },
        };
      },
    },

    // POST /ttyd/session/:sessionId/start - Start ttyd for session
    {
      method: 'POST',
      pattern: /^\/ttyd\/session\/(?<sessionId>[^/]+)\/start$/,
      handler: async (req, api) => {
        const { sessionId } = req.params;
        const { projectPath, port, resume, directMode, force, existingTmuxSession, connectPid, forkSession } = req.body || {};

        // Subagent sessions cannot be resumed via console
        // Subagent IDs start with "agent-" prefix (e.g., "agent-abc123")
        if (sessionId.startsWith('agent-')) {
          return {
            success: false,
            error: 'Subagent sessions cannot be started via the web console. Subagents run within their parent session context.',
            code: 'SUBAGENT_NOT_SUPPORTED',
          };
        }

        // If connectPid is provided, resolve the PID to its tmux session + pane
        // by walking the ancestor chain and matching against tmux pane_pids.
        // POSIX only — tmux not available on Windows.
        let resolvedTmuxSession = typeof existingTmuxSession === 'string' ? existingTmuxSession : undefined;
        let resolvedTmuxPane: string | undefined;
        if (IS_POSIX && connectPid && !resolvedTmuxSession) {
          try {
            // Build set of ancestor PIDs (walk ppid chain)
            const ancestors = new Set<number>();
            let cur = connectPid;
            for (let i = 0; i < 10 && cur > 1; i++) {
              ancestors.add(cur);
              try {
                const ppidStr = execFileSync('ps', ['-p', String(cur), '-o', 'ppid='], {
                  encoding: 'utf-8', timeout: 1000,
                }).trim();
                cur = parseInt(ppidStr, 10);
              } catch { break; }
            }

            // Find tmux pane whose pane_pid matches an ancestor (include pane_id for targeting)
            const paneOutput = execFileSync('tmux', ['list-panes', '-a', '-F', '#{session_name} #{pane_id} #{pane_pid}'], {
              encoding: 'utf-8',
              timeout: 3000,
            });
            for (const line of paneOutput.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              const parts = trimmed.split(' ');
              if (parts.length < 3) continue;
              const sessName = parts[0];
              const paneId = parts[1];   // e.g. "%42"
              const panePid = parseInt(parts[2], 10);
              if (ancestors.has(panePid)) {
                resolvedTmuxSession = sessName;
                resolvedTmuxPane = paneId;
                break;
              }
            }
          } catch {
            // Process may have exited or tmux not available
          }
        }

        // Try to get projectPath from: request body > session lookup > context
        // Session lookup is preferred over ctx.projectPath because ctx.projectPath
        // is the server's startup project, which may differ from the session's project.
        let actualProjectPath = projectPath;

        if (!actualProjectPath) {
          // Try to derive from sessionId first (most accurate)
          actualProjectPath = await findProjectPathForSession(sessionId);
        }

        if (!actualProjectPath) {
          // Fall back to server context project path
          actualProjectPath = ctx.projectPath;
        }

        if (!actualProjectPath) {
          return {
            success: false,
            error: 'projectPath is required (could not derive from sessionId)',
          };
        }

        const decodedPath = decodeProjectPath(actualProjectPath);

        // Check status first
        let status = await ttydManager.getSessionStatus(sessionId, decodedPath);

        // Check for unmanaged processes - block unless force=true
        const hasUnmanagedProcesses = status.warnings.some(w => w.includes('unmanaged'));
        // When attaching to an existing tmux session, auto-force (the session is already running,
        // we're just attaching ttyd to view it — not starting a new Claude instance).
        // Also auto-force when activeInstance is an unmanaged-tmux — startTtyd will auto-detect
        // and attach to the existing tmux session rather than creating a new one.
        const hasUnmanagedTmuxActive = status.activeInstance &&
          status.activeInstance.message?.includes('User Tmux');
        const effectiveForce = force || !!resolvedTmuxSession || !!hasUnmanagedTmuxActive;
        // Determine if we can bypass blocking conditions with force
        const canBypassWithForce = effectiveForce && (hasUnmanagedProcesses || status.activeInstance);

        if (!status.canStartTtyd && !status.ttydProcess && !canBypassWithForce) {
          // Session already running elsewhere - block unless force=true
          if (status.activeInstance) {
            return {
              success: false,
              error: status.activeInstance.message,
              code: 'SESSION_ALREADY_RUNNING',
              data: {
                activeInstance: status.activeInstance,
                canForce: true,
                userMessage: `${status.activeInstance.message}. Starting another instance may cause session file conflicts.`,
                action: 'You can proceed anyway or close the existing session first.',
              },
            };
          }

          // For unmanaged processes, allow with force=true
          if (hasUnmanagedProcesses && !force) {
            // Extract PID count from warnings
            const unmanagedWarning = status.warnings.find(w => w.includes('unmanaged'));
            const pidMatch = unmanagedWarning?.match(/PIDs?: ([\d, ]+)/);
            const pids = pidMatch ? pidMatch[1].split(', ').map(p => p.trim()) : [];

            return {
              success: false,
              error: 'Other Claude sessions detected',
              code: 'UNMANAGED_PROCESSES',
              data: {
                warnings: status.warnings,
                canForce: true,
                processCount: pids.length,
                pids,
                userMessage: `Found ${pids.length} other Claude session${pids.length > 1 ? 's' : ''} running locally that ${pids.length > 1 ? 'are' : 'is'} not managed by the session manager. Starting a new session while these are running may cause session file conflicts.`,
                action: 'You can proceed anyway or close the other sessions first.',
              },
            };
          }

          // Other blocking conditions
          return {
            success: false,
            error: 'Cannot start console: ' + status.warnings.join(' '),
            code: 'CANNOT_START',
            data: {
              status,
              action: 'Please resolve the issues before starting',
            },
          };
        }

        const baseUrl = getProxyBaseUrl(req);

        // If already running, verify the tmux session is still showing Claude
        // (not a stale bash shell from a previous Claude process that exited)
        if (status.ttydProcess) {
          const health = ttydManager.checkTtydSessionHealth(sessionId);
          if (health.healthy) {
            return {
              success: true,
              data: {
                alreadyRunning: true,
                port: status.ttydProcess.port,
                url: getTtydProxyUrl(status.ttydProcess.port, baseUrl),
                pid: status.ttydProcess.pid,
                warnings: status.warnings.length > 0 ? status.warnings : undefined,
              },
            };
          }

          // Stale ttyd - stop it and start fresh
          console.log(`[ttyd.routes] Stale ttyd for session ${sessionId}: ${health.reason}. Restarting.`);
          await ttydManager.stopTtyd(sessionId);
          // Re-check status without the stale ttyd
          status = await ttydManager.getSessionStatus(sessionId, decodedPath);
        }

        // Start ttyd
        // directMode: true = direct TTY access with --chrome (no tmux, exits on disconnect)
        // directMode: false/undefined = tmux mode (shared session, persists)
        const result = await ttydManager.startTtyd(sessionId, decodedPath, {
          port: port ? parseInt(port, 10) : undefined,
          resume: resume !== false,
          directMode: directMode === true,
          force: effectiveForce,
          precomputedStatus: status,  // Pass pre-computed status to avoid redundant getSessionStatus() call
          existingTmuxSession: resolvedTmuxSession,
          existingTmuxPane: resolvedTmuxPane,
          forkSession: forkSession === true,
        });

        if (!result.success) {
          return {
            success: false,
            error: result.error,
          };
        }

        // Collect all warnings (from status + from ttyd start result)
        const allWarnings = [...status.warnings];
        if (result.warning) {
          allWarnings.push(result.warning);
        }

        return {
          success: true,
          data: {
            port: result.port,
            url: getTtydProxyUrl(result.port!, baseUrl),
            pid: result.pid,
            sessionId,
            projectPath: decodedPath,
            warnings: allWarnings.length > 0 ? allWarnings : undefined,
            forcedStart: effectiveForce && (hasUnmanagedProcesses || !!status.activeInstance),
          },
        };
      },
    },

    // POST /ttyd/start-all - Start ttyd for all running Claude sessions
    {
      method: 'POST',
      pattern: /^\/ttyd\/start-all$/,
      handler: async (req, api) => {
        const { getProcessStatusStore } = await import('../../process-status-store');
        const processStore = getProcessStatusStore();

        // Force a fresh scan
        await processStore.refresh();
        const cached = processStore.getCachedResponse();
        if (!cached) {
          return {
            success: true,
            data: {
              results: [],
              summary: { total: 0, started: 0, alreadyRunning: 0, failed: 0 },
            },
          };
        }

        // Collect all running Claude processes and filter out subagents and chrome sessions
        const allProcesses = cached.allClaudeProcesses || [];
        const sessionsToStart: Array<{ sessionId: string; projectPath?: string; tmuxSessionName?: string; pid?: number }> = [];
        const seenSessionIds = new Set<string>();

        for (const proc of allProcesses) {
          if (!proc.sessionId) continue;
          // Skip subagents
          if (proc.sessionId.startsWith('agent-')) continue;
          // Deduplicate
          if (seenSessionIds.has(proc.sessionId)) continue;
          seenSessionIds.add(proc.sessionId);

          sessionsToStart.push({
            sessionId: proc.sessionId,
            projectPath: proc.projectPath || undefined,
            tmuxSessionName: proc.tmuxSessionName,
            pid: proc.pid,
          });
        }

        const baseUrl = getProxyBaseUrl(req);
        const results: Array<{
          sessionId: string;
          port?: number;
          url?: string;
          alreadyRunning?: boolean;
          error?: string;
        }> = [];
        let started = 0;
        let alreadyRunning = 0;
        let failed = 0;

        // Process sequentially to avoid port contention
        for (const session of sessionsToStart) {
          try {
            // Resolve project path
            let actualProjectPath: string | undefined = session.projectPath;
            if (!actualProjectPath) {
              actualProjectPath = (await findProjectPathForSession(session.sessionId)) || undefined;
            }
            if (!actualProjectPath) {
              actualProjectPath = ctx.projectPath;
            }

            if (!actualProjectPath) {
              results.push({ sessionId: session.sessionId, error: 'Could not resolve projectPath' });
              failed++;
              continue;
            }

            const decodedPath = decodeProjectPath(actualProjectPath);

            // Check if already running
            let status = await ttydManager.getSessionStatus(session.sessionId, decodedPath);

            if (status.ttydProcess) {
              // Verify health before returning alreadyRunning (same pattern as /ttyd/start)
              const health = ttydManager.checkTtydSessionHealth(session.sessionId);
              if (health.healthy) {
                results.push({
                  sessionId: session.sessionId,
                  port: status.ttydProcess.port,
                  url: getTtydProxyUrl(status.ttydProcess.port, baseUrl),
                  alreadyRunning: true,
                });
                alreadyRunning++;
                continue;
              }
              // Stale ttyd — stop it and fall through to start fresh
              console.log(`[ttyd.routes] start-all: Stale ttyd for session ${session.sessionId}: ${health.reason}. Restarting.`);
              await ttydManager.stopTtyd(session.sessionId);
              status = await ttydManager.getSessionStatus(session.sessionId, decodedPath);
            }

            // Start ttyd
            const result = await ttydManager.startTtyd(session.sessionId, decodedPath, {
              resume: true,
              directMode: false,
              force: true,
              precomputedStatus: status,
              existingTmuxSession: session.tmuxSessionName,
            });

            if (result.success && result.port) {
              results.push({
                sessionId: session.sessionId,
                port: result.port,
                url: getTtydProxyUrl(result.port, baseUrl),
              });
              started++;
            } else {
              results.push({ sessionId: session.sessionId, error: result.error || 'Unknown error' });
              failed++;
            }
          } catch (err) {
            results.push({
              sessionId: session.sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
            failed++;
          }
        }

        return {
          success: true,
          data: {
            results,
            summary: {
              total: sessionsToStart.length,
              started,
              alreadyRunning,
              failed,
            },
          },
        };
      },
    },

    // POST /ttyd/session/:sessionId/stop - Stop ttyd for session
    {
      method: 'POST',
      pattern: /^\/ttyd\/session\/(?<sessionId>[^/]+)\/stop$/,
      handler: async (req, api) => {
        const { sessionId } = req.params;

        const result = await ttydManager.stopTtyd(sessionId);

        if (!result.success) {
          return {
            success: false,
            error: result.error,
          };
        }

        return {
          success: true,
          data: {
            message: `ttyd stopped for session ${sessionId}`,
          },
        };
      },
    },

    // POST /ttyd/session/:sessionId/kill - Kill all processes for a session (ttyd, wrapper, etc.)
    {
      method: 'POST',
      pattern: /^\/ttyd\/session\/(?<sessionId>[^/]+)\/kill$/,
      handler: async (req, api) => {
        const { sessionId } = req.params;

        const result = await ttydManager.killSessionProcesses(sessionId);

        return {
          success: result.success,
          data: {
            message: result.killed.length > 0
              ? `Killed ${result.killed.length} process(es) for session ${sessionId}`
              : 'No processes found for this session',
            killed: result.killed,
            errors: result.errors,
          },
          error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
        };
      },
    },

    // POST /ttyd/process/:pid/kill - Kill a specific process by PID
    {
      method: 'POST',
      pattern: /^\/ttyd\/process\/(?<pid>\d+)\/kill$/,
      handler: async (req, api) => {
        const { pid } = req.params;
        const pidNum = parseInt(pid, 10);

        if (isNaN(pidNum)) {
          return {
            success: false,
            error: 'Invalid PID',
          };
        }

        const result = await ttydManager.killProcess(pidNum);

        if (!result.success) {
          return {
            success: false,
            error: result.error,
          };
        }

        return {
          success: true,
          data: {
            message: `Process ${pidNum} killed`,
            pid: pidNum,
          },
        };
      },
    },

    // GET /ttyd/instances - Query ttyd instance history
    {
      method: 'GET',
      pattern: /^\/ttyd\/instances$/,
      handler: async (req, api) => {
        const store = ttydManager.getInstanceStore();
        const { status, sessionId, limit } = req.query || {};

        let records = store.getAll();

        if (status) {
          records = records.filter(r => r.status === status);
        }

        if (sessionId) {
          records = records.filter(r => r.sessionId === sessionId);
        }

        // Sort by startedAt desc
        records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

        // Apply limit (default 50)
        const maxResults = limit ? parseInt(limit, 10) : 50;
        records = records.slice(0, maxResults);

        return {
          success: true,
          data: {
            instances: records,
            total: records.length,
          },
        };
      },
    },

    // POST /ttyd/cleanup - Clean up dead processes
    {
      method: 'POST',
      pattern: /^\/ttyd\/cleanup$/,
      handler: async (req, api) => {
        const result = ttydManager.cleanup();

        return {
          success: true,
          data: result,
        };
      },
    },

    // POST /ttyd/shell/start - Start a plain shell terminal (no Claude session)
    {
      method: 'POST',
      pattern: /^\/ttyd\/shell\/start$/,
      handler: async (req, api) => {
        const { projectPath, shell, port: requestedPort } = req.body || {};

        const actualProjectPath = projectPath || ctx.projectPath;
        if (!actualProjectPath) {
          return {
            success: false,
            error: 'projectPath is required',
          };
        }

        const decodedPath = decodeProjectPath(actualProjectPath);

        // Determine shell to use: request body > shell-config > env SHELL > /bin/bash
        let shellPath = shell;
        if (!shellPath) {
          const { readShellConfig } = await import('./shell-config.routes');
          shellPath = readShellConfig().shell;
        }

        // Generate synthetic session ID for tracking
        const shellSessionId = `shell-${Date.now()}`;

        // Start ttyd with a plain shell (direct mode, no Claude)
        const result = await ttydManager.startShell(shellSessionId, decodedPath, shellPath, {
          port: requestedPort ? parseInt(requestedPort, 10) : undefined,
        });

        if (!result.success) {
          return {
            success: false,
            error: result.error,
          };
        }

        const baseUrl = getProxyBaseUrl(req);

        return {
          success: true,
          data: {
            port: result.port,
            url: getTtydProxyUrl(result.port!, baseUrl),
            pid: result.pid,
            sessionId: shellSessionId,
            projectPath: decodedPath,
            shell: shellPath,
          },
        };
      },
    },

    // POST /ttyd/process/identify - PID-based session identification with screen-to-turn matching
    {
      method: 'POST',
      pattern: /^\/ttyd\/process\/identify$/,
      handler: async (req, api) => {
        const { pids, forceReidentify, includeScreen } = req.body || {};

        if (!Array.isArray(pids) || pids.length === 0) {
          return {
            success: false,
            error: 'pids array is required',
          };
        }

        if (pids.length > 20) {
          return {
            success: false,
            error: 'Maximum 20 PIDs per request',
          };
        }

        const { getProcessStatusStore } = await import('../../process-status-store');
        const { getSessionIdentifier, matchScreenToTurn, normalizeTerminalText, extractFingerprints } = await import('../../session-identifier');
        const { getSessionCache } = await import('../../session-cache');

        const processStore = getProcessStatusStore();
        const identifier = getSessionIdentifier();
        const sessionCache = getSessionCache();
        const cachedProcesses = processStore.getCachedProcesses();

        // Resolve actual session file path by scanning project dirs (handles both base64 and legacy dash encoding)
        const resolveSessionFile = (sessionId: string): string | null => {
          try {
            const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR);
            for (const projectDir of projects) {
              const filePath = path.join(CLAUDE_PROJECTS_DIR, projectDir, `${sessionId}.jsonl`);
              if (fs.existsSync(filePath)) return filePath;
            }
          } catch {}
          return null;
        };

        const results: Array<any> = [];

        for (const pid of pids) {
          const pidNum = typeof pid === 'string' ? parseInt(pid, 10) : pid;
          if (isNaN(pidNum)) {
            results.push({ pid, error: 'Invalid PID' });
            continue;
          }

          // Find in cached processes
          const proc = cachedProcesses.find(p => p.pid === pidNum);
          if (!proc) {
            results.push({ pid: pidNum, error: 'Process not found' });
            continue;
          }

          const entry: any = {
            pid: pidNum,
            sessionId: proc.sessionId || null,
            managedBy: proc.managedBy,
            tmuxSessionName: proc.tmuxSessionName || null,
            role: null,
            processStartedAt: proc.startedAt ? proc.startedAt.toISOString() : null,
            sessionBirthtime: null,
            timeDeltaMs: null,
            identification: null,
            screenTurn: null,
            sessionStats: null,
          };

          // Session identification: if has tmux session
          if (proc.tmuxSessionName) {
            if (forceReidentify) {
              // Force re-run identification regardless of existing sessionId
              const projectPath = proc.projectPath || ctx.projectPath;
              if (projectPath) {
                const result = await identifier.identify(
                  proc.tmuxSessionName,
                  projectPath,
                  proc.startedAt || new Date(),
                  includeScreen, // pass debug flag
                );
                if (result) {
                  entry.sessionId = result.sessionId;
                  entry.identification = {
                    confidence: result.confidence,
                    matchDetails: result.matchDetails,
                  };
                  if (includeScreen && (result as any)._debug) {
                    entry.identificationDebug = (result as any)._debug;
                  }
                }
              }
            } else if (!entry.sessionId) {
              const cached = identifier.getCachedIdentification(pidNum);
              if (cached) {
                entry.sessionId = cached.sessionId;
                entry.identification = {
                  confidence: cached.confidence,
                  matchDetails: cached.matchDetails,
                };
              }
            }
          }

          // Screen-to-turn matching: if has tmux session (POSIX only)
          if (IS_POSIX && proc.tmuxSessionName) {
            try {
              const rawContent = execFileSync('tmux', ['capture-pane', '-t', proc.tmuxSessionName, '-p', '-S', '-'], {
                encoding: 'utf-8',
                timeout: 5000,
              });

              // Include raw screen content when requested (for debugging)
              if (includeScreen && rawContent) {
                entry.screenContent = rawContent;
                // Also include fingerprints extracted from screen for debugging
                const normalized = normalizeTerminalText(rawContent);
                const fingerprints = extractFingerprints(normalized);
                entry.fingerprints = {
                  userPrompts: fingerprints.userPrompts,
                  filePaths: fingerprints.filePaths,
                  commitHashes: fingerprints.commitHashes,
                  ngramCount: fingerprints.wordNgrams.length,
                  ngramSample: fingerprints.wordNgrams.slice(0, 10),
                };
              }

              if (entry.sessionId) {
                const sessionFilePath = resolveSessionFile(entry.sessionId);
                if (sessionFilePath) {
                  let cacheData = sessionCache.getSessionDataFromMemory(sessionFilePath);
                  if (!cacheData) {
                    cacheData = await sessionCache.getSessionData(sessionFilePath);
                  }
                  if (cacheData) {
                    const turnMatch = matchScreenToTurn(rawContent, cacheData);
                    entry.screenTurn = turnMatch ? {
                      lastReadTurnIndex: turnMatch.lastReadTurnIndex,
                      lastReadTimestamp: turnMatch.lastReadTimestamp,
                      matchedVia: turnMatch.matchedVia,
                      matchedText: turnMatch.matchedText,
                      contentLength: turnMatch.contentLength,
                      capturedAt: turnMatch.capturedAt,
                    } : {
                      lastReadTurnIndex: null,
                      lastReadTimestamp: null,
                      matchedVia: null,
                      matchedText: null,
                      contentLength: rawContent.length,
                      capturedAt: new Date().toISOString(),
                    };

                    // Session stats
                    entry.sessionStats = {
                      numTurns: cacheData.numTurns,
                      lastTurnIndex: cacheData.lastTurnIndex,
                      lastTimestamp: cacheData.lastTimestamp || null,
                    };
                  }
                }
              } else {
                // No sessionId — still report content length
                entry.screenTurn = {
                  lastReadTurnIndex: null,
                  lastReadTimestamp: null,
                  matchedVia: null,
                  matchedText: null,
                  contentLength: rawContent.length,
                  capturedAt: new Date().toISOString(),
                };
              }
            } catch {
              // tmux capture failed (session gone, alternate screen, etc.)
              entry.screenTurn = null;
            }
          }

          // Process role classification
          if (entry.sessionId && proc.startedAt) {
            try {
              const roleFilePath = resolveSessionFile(entry.sessionId);
              if (roleFilePath) {
                const stat = await fs.promises.stat(roleFilePath);
                const birthtime = stat.birthtime;
                entry.sessionBirthtime = birthtime.toISOString();
                const timeDeltaMs = proc.startedAt.getTime() - birthtime.getTime();
                entry.timeDeltaMs = timeDeltaMs;

                const FIVE_MINUTES = 5 * 60 * 1000;
                const THIRTY_MINUTES = 30 * 60 * 1000;
                if (Math.abs(timeDeltaMs) < FIVE_MINUTES) {
                  // Process and session started within 5min of each other
                  entry.role = 'original';
                } else if (timeDeltaMs < 0 && Math.abs(timeDeltaMs) < THIRTY_MINUTES) {
                  // Process started BEFORE session (negative delta) — session was created
                  // by this process after user's first interaction (up to 30min delay)
                  entry.role = 'original';
                } else if (timeDeltaMs > FIVE_MINUTES && proc.managedBy.includes('ttyd')) {
                  entry.role = 'console-tab';
                } else {
                  entry.role = 'resumed';
                }
              } else {
                entry.role = 'unknown';
              }
            } catch {
              // Session file not found or stat failed
              entry.role = 'unknown';
            }
          }

          results.push(entry);
        }

        return {
          success: true,
          data: {
            processes: results,
          },
        };
      },
    },

    // POST /ttyd/session/identify - Identify session for an unmanaged tmux process
    {
      method: 'POST',
      pattern: /^\/ttyd\/session\/identify$/,
      handler: async (req, api) => {
        const { tmuxSessionName, projectPath } = req.body || {};

        if (!tmuxSessionName) {
          return {
            success: false,
            error: 'tmuxSessionName is required',
          };
        }

        const actualProjectPath = projectPath || ctx.projectPath;
        if (!actualProjectPath) {
          return {
            success: false,
            error: 'projectPath is required',
          };
        }

        const { getSessionIdentifier } = await import('../../session-identifier');
        const identifier = getSessionIdentifier();

        const result = await identifier.identify(
          tmuxSessionName,
          decodeProjectPath(actualProjectPath),
          new Date(), // Use current time as approximate start
        );

        if (!result) {
          return {
            success: true,
            data: {
              sessionId: null,
              message: 'Could not identify session from terminal content',
            },
          };
        }

        return {
          success: true,
          data: {
            sessionId: result.sessionId,
            confidence: result.confidence,
            matchDetails: result.matchDetails,
          },
        };
      },
    },
  ];
}
