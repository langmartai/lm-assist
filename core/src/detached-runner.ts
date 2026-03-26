/**
 * Detached CLI Runner
 *
 * Spawns Claude CLI as a detached child process that survives parent death.
 * Used for background agent executions so they continue even if lm-assist restarts.
 *
 * Key design:
 * - Spawns `claude -p` with `detached: true` + `proc.unref()`
 * - Pipes stdout/stderr to log files in ~/.lm-assist/bg-logs/
 * - Persists execution metadata to ~/.lm-assist/background-executions.json
 * - Status polling reads log files to detect session ID and completion
 * - On startup, loads persisted state and checks which PIDs are still alive
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SdkExecuteOptions, SdkExecutionHandle, SdkExecuteResult } from './sdk-runner';
import type { TokenUsage } from './types';

// ── Paths ────────────────────────────────────────────────────────────────────

const LM_ASSIST_DIR = path.join(os.homedir(), '.lm-assist');
const BG_LOGS_DIR = path.join(LM_ASSIST_DIR, 'bg-logs');
const EXECUTIONS_FILE = path.join(LM_ASSIST_DIR, 'background-executions.json');

// ── Types ────────────────────────────────────────────────────────────────────

export interface DetachedExecution {
  executionId: string;
  pid: number;
  sessionId?: string;
  logFile: string;
  errFile: string;
  prompt: string;
  cwd: string;
  model?: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'completed' | 'failed';
  result?: SdkExecuteResult;
  error?: string;
}

interface PersistedState {
  executions: Record<string, DetachedExecution>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDirs(): void {
  if (!fs.existsSync(LM_ASSIST_DIR)) fs.mkdirSync(LM_ASSIST_DIR, { recursive: true });
  if (!fs.existsSync(BG_LOGS_DIR)) fs.mkdirSync(BG_LOGS_DIR, { recursive: true });
}

function loadState(): PersistedState {
  try {
    if (fs.existsSync(EXECUTIONS_FILE)) {
      return JSON.parse(fs.readFileSync(EXECUTIONS_FILE, 'utf-8'));
    }
  } catch {
    // Corrupted file — start fresh
  }
  return { executions: {} };
}

function saveState(state: PersistedState): void {
  ensureDirs();
  fs.writeFileSync(EXECUTIONS_FILE, JSON.stringify(state, null, 2));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

/**
 * Parse the stream-json log file to extract session ID and result.
 */
function parseLogFile(logFile: string): {
  sessionId?: string;
  result?: SdkExecuteResult;
  isComplete: boolean;
} {
  try {
    if (!fs.existsSync(logFile)) return { isComplete: false };

    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    let sessionId: string | undefined;
    let result: SdkExecuteResult | undefined;

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.type === 'system' && data.session_id) {
          sessionId = data.session_id;
        }
        if (data.type === 'result') {
          result = {
            success: data.subtype === 'success',
            result: data.result || '',
            sessionId: data.session_id || sessionId || '',
            durationMs: data.duration_ms || 0,
            durationApiMs: data.duration_api_ms || 0,
            numTurns: data.num_turns || 1,
            totalCostUsd: data.total_cost_usd || 0,
            usage: {
              inputTokens: data.usage?.input_tokens || 0,
              outputTokens: data.usage?.output_tokens || 0,
              cacheCreationInputTokens: data.usage?.cache_creation?.input_tokens || 0,
              cacheReadInputTokens: data.usage?.cache_read?.input_tokens || 0,
            },
            modelUsage: data.modelUsage || {},
            error: data.is_error ? data.result : undefined,
          };
        }
      } catch {
        // Not JSON, skip
      }
    }

    return { sessionId, result, isComplete: !!result };
  } catch {
    return { isComplete: false };
  }
}

// ── Main API ─────────────────────────────────────────────────────────────────

/**
 * Build CLI args from SDK options.
 */
function buildCliArgs(prompt: string, options: SdkExecuteOptions): string[] {
  const args: string[] = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

  // Permission mode
  if (options.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else if (options.permissionMode) {
    args.push('--permission-mode', options.permissionMode);
  }

  // Model
  if (options.model) {
    args.push('--model', options.model);
  }

  // Effort
  if (options.outputConfig?.effort) {
    args.push('--effort', options.outputConfig.effort);
  }

  // Max turns
  if (options.maxTurns) {
    args.push('--max-turns', String(options.maxTurns));
  }

  // Max budget
  if (options.maxBudgetUsd) {
    args.push('--max-budget-usd', String(options.maxBudgetUsd));
  }

  // Setting sources
  if (options.settingSources && options.settingSources.length > 0) {
    args.push('--setting-sources', options.settingSources.join(','));
  }

  // Allowed tools
  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push('--allowedTools', ...options.allowedTools);
  }

  // Disallowed tools
  if (options.disallowedTools && options.disallowedTools.length > 0) {
    args.push('--disallowedTools', ...options.disallowedTools);
  }

  // System prompt
  if (options.systemPromptConfig) {
    if (typeof options.systemPromptConfig === 'string') {
      args.push('--system-prompt', options.systemPromptConfig);
    } else if (options.systemPromptConfig.type === 'custom') {
      args.push('--system-prompt', options.systemPromptConfig.content);
    }
  }

  // Append system prompt
  if (options.systemPromptAppend) {
    args.push('--append-system-prompt', options.systemPromptAppend);
  }

  // Resume
  if (options.resume && options.sessionId) {
    args.push('--resume', options.sessionId);
  }

  return args;
}

/**
 * Shell-escape a string for use in a shell command.
 */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Spawn a detached Claude CLI process that survives parent death.
 *
 * Uses double-fork via shell: spawns `sh -c '... & echo $!'` which:
 * 1. The shell starts claude as a background process
 * 2. Writes claude's PID to a pidfile
 * 3. The shell exits immediately
 * 4. Claude gets reparented to init (PID 1)
 * 5. tree-kill can't find it because it's no longer in lm-assist's process tree
 *
 * Returns an SdkExecutionHandle-compatible object.
 */
export function spawnDetached(
  prompt: string,
  options: SdkExecuteOptions,
): SdkExecutionHandle {
  ensureDirs();

  const executionId = options.executionId || `detached-${Date.now()}`;
  const logFile = path.join(BG_LOGS_DIR, `${executionId}.log`);
  const errFile = path.join(BG_LOGS_DIR, `${executionId}.err`);
  const pidFile = path.join(BG_LOGS_DIR, `${executionId}.pid`);

  // Build CLI args
  const args = buildCliArgs(prompt, options);
  const cwd = options.cwd || process.cwd();

  // Resolve claude binary
  const claudeBin = process.env.CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');

  // Build the shell command that double-forks:
  // 1. setsid creates a new session (escapes process group)
  // 2. nohup prevents SIGHUP on parent exit
  // 3. & backgrounds the process
  // 4. echo $! writes the PID to pidfile
  // The wrapper shell exits immediately; claude is reparented to init.
  const escapedArgs = args.map(shellEscape).join(' ');
  const shellCmd = `cd ${shellEscape(cwd)} && setsid nohup ${shellEscape(claudeBin)} ${escapedArgs} > ${shellEscape(logFile)} 2> ${shellEscape(errFile)} & echo $! > ${shellEscape(pidFile)}`;

  // Spawn the wrapper shell — it exits immediately after backgrounding claude
  const proc = spawn('sh', ['-c', shellCmd], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      ...(options.env || {}),
    },
  });
  proc.unref();

  // Wait briefly for pidfile to appear, then read the real PID
  let pid = 0;
  const pidWaitStart = Date.now();
  const pidWaitTimeout = 3000; // 3 seconds

  // Synchronous wait for PID file (shell is very fast)
  while (Date.now() - pidWaitStart < pidWaitTimeout) {
    try {
      if (fs.existsSync(pidFile)) {
        const pidStr = fs.readFileSync(pidFile, 'utf-8').trim();
        pid = parseInt(pidStr, 10);
        if (pid > 0) break;
      }
    } catch {}
    // Busy-wait in small increments (shell completes in <100ms typically)
    const waitUntil = Date.now() + 50;
    while (Date.now() < waitUntil) { /* spin */ }
  }

  if (pid === 0) {
    // Fallback: try shell PID (less reliable but better than nothing)
    pid = proc.pid || 0;
  }
  let running = true;
  let cachedSessionId: string | undefined;
  let cachedResult: SdkExecuteResult | undefined;

  // Persist to disk
  const state = loadState();
  state.executions[executionId] = {
    executionId,
    pid,
    logFile,
    errFile,
    prompt,
    cwd,
    model: options.model,
    startedAt: new Date().toISOString(),
    status: 'running',
  };
  saveState(state);

  // Session ready: poll log file for session ID
  const sessionReady = new Promise<string>((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = 60; // 30 seconds
    const interval = setInterval(() => {
      attempts++;
      const parsed = parseLogFile(logFile);
      if (parsed.sessionId) {
        clearInterval(interval);
        cachedSessionId = parsed.sessionId;

        // Update persisted state with session ID
        const st = loadState();
        if (st.executions[executionId]) {
          st.executions[executionId].sessionId = parsed.sessionId;
          saveState(st);
        }

        resolve(parsed.sessionId);
      } else if (attempts >= maxAttempts || !isPidAlive(pid)) {
        clearInterval(interval);
        if (!isPidAlive(pid)) {
          reject(new Error('Claude process exited before producing session ID'));
        } else {
          reject(new Error('Timeout waiting for session ID'));
        }
      }
    }, 500);
  });

  // Result: poll log file for completion
  const resultPromise = new Promise<SdkExecuteResult>((resolve, reject) => {
    const interval = setInterval(() => {
      const parsed = parseLogFile(logFile);

      if (parsed.sessionId && !cachedSessionId) {
        cachedSessionId = parsed.sessionId;
      }

      if (parsed.isComplete && parsed.result) {
        clearInterval(interval);
        running = false;
        cachedResult = parsed.result;

        // Update persisted state
        const st = loadState();
        if (st.executions[executionId]) {
          st.executions[executionId].status = parsed.result.success ? 'completed' : 'failed';
          st.executions[executionId].completedAt = new Date().toISOString();
          st.executions[executionId].sessionId = parsed.sessionId || cachedSessionId;
          st.executions[executionId].result = parsed.result;
          if (parsed.result.error) {
            st.executions[executionId].error = parsed.result.error;
          }
          saveState(st);
        }

        resolve(parsed.result);
      } else if (!isPidAlive(pid)) {
        clearInterval(interval);
        running = false;

        // Process died without result — check log one more time
        const finalParsed = parseLogFile(logFile);
        if (finalParsed.isComplete && finalParsed.result) {
          cachedResult = finalParsed.result;

          const st = loadState();
          if (st.executions[executionId]) {
            st.executions[executionId].status = finalParsed.result.success ? 'completed' : 'failed';
            st.executions[executionId].completedAt = new Date().toISOString();
            st.executions[executionId].result = finalParsed.result;
            saveState(st);
          }

          resolve(finalParsed.result);
        } else {
          // Read error log
          let errContent = '';
          try { errContent = fs.readFileSync(errFile, 'utf-8').trim(); } catch {}

          const errorMsg = errContent || 'Claude process exited without producing a result';

          const st = loadState();
          if (st.executions[executionId]) {
            st.executions[executionId].status = 'failed';
            st.executions[executionId].completedAt = new Date().toISOString();
            st.executions[executionId].error = errorMsg;
            saveState(st);
          }

          reject(new Error(errorMsg));
        }
      }
    }, 2000); // Poll every 2 seconds
  });

  return {
    executionId,
    sessionId: cachedSessionId || `pending-${executionId}`,
    sessionReady,
    result: resultPromise,
    abort: () => {
      running = false;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already dead
      }
      const st = loadState();
      if (st.executions[executionId]) {
        st.executions[executionId].status = 'failed';
        st.executions[executionId].completedAt = new Date().toISOString();
        st.executions[executionId].error = 'Aborted';
        saveState(st);
      }
    },
    isRunning: () => {
      if (!running) return false;
      if (!isPidAlive(pid)) {
        running = false;
        return false;
      }
      return true;
    },
  };
}

/**
 * Recover executions from persisted state on startup.
 * Returns handles for executions that are still running (PID alive).
 * Marks dead executions as failed.
 */
export function recoverExecutions(): Map<string, SdkExecutionHandle> {
  const handles = new Map<string, SdkExecutionHandle>();
  const state = loadState();
  let changed = false;

  for (const [executionId, exec] of Object.entries(state.executions)) {
    if (exec.status !== 'running') continue;

    const alive = isPidAlive(exec.pid);
    const parsed = parseLogFile(exec.logFile);

    if (parsed.isComplete && parsed.result) {
      // Process finished while we were down
      exec.status = parsed.result.success ? 'completed' : 'failed';
      exec.completedAt = new Date().toISOString();
      exec.result = parsed.result;
      exec.sessionId = parsed.sessionId || exec.sessionId;
      changed = true;
      continue;
    }

    if (!alive) {
      // Process died without result
      exec.status = 'failed';
      exec.completedAt = new Date().toISOString();
      exec.error = 'Process died during lm-assist restart';
      changed = true;
      continue;
    }

    // Still alive — create a handle for monitoring
    let running = true;
    const pid = exec.pid;
    const logFile = exec.logFile;
    const errFile = exec.errFile;
    let cachedSessionId = exec.sessionId || parsed.sessionId;

    // Update sessionId if found
    if (parsed.sessionId && !exec.sessionId) {
      exec.sessionId = parsed.sessionId;
      changed = true;
    }

    const sessionReady = cachedSessionId
      ? Promise.resolve(cachedSessionId)
      : new Promise<string>((resolve, reject) => {
          let attempts = 0;
          const interval = setInterval(() => {
            attempts++;
            const p = parseLogFile(logFile);
            if (p.sessionId) {
              clearInterval(interval);
              cachedSessionId = p.sessionId;
              const st = loadState();
              if (st.executions[executionId]) {
                st.executions[executionId].sessionId = p.sessionId;
                saveState(st);
              }
              resolve(p.sessionId);
            } else if (attempts >= 60 || !isPidAlive(pid)) {
              clearInterval(interval);
              reject(new Error('Session ID not available'));
            }
          }, 500);
        });

    const resultPromise = new Promise<SdkExecuteResult>((resolve, reject) => {
      const interval = setInterval(() => {
        const p = parseLogFile(logFile);
        if (p.sessionId && !cachedSessionId) cachedSessionId = p.sessionId;

        if (p.isComplete && p.result) {
          clearInterval(interval);
          running = false;
          const st = loadState();
          if (st.executions[executionId]) {
            st.executions[executionId].status = p.result.success ? 'completed' : 'failed';
            st.executions[executionId].completedAt = new Date().toISOString();
            st.executions[executionId].result = p.result;
            saveState(st);
          }
          resolve(p.result);
        } else if (!isPidAlive(pid)) {
          clearInterval(interval);
          running = false;
          const finalP = parseLogFile(logFile);
          if (finalP.isComplete && finalP.result) {
            const st = loadState();
            if (st.executions[executionId]) {
              st.executions[executionId].status = finalP.result.success ? 'completed' : 'failed';
              st.executions[executionId].completedAt = new Date().toISOString();
              st.executions[executionId].result = finalP.result;
              saveState(st);
            }
            resolve(finalP.result);
          } else {
            let errContent = '';
            try { errContent = fs.readFileSync(errFile, 'utf-8').trim(); } catch {}
            const st = loadState();
            if (st.executions[executionId]) {
              st.executions[executionId].status = 'failed';
              st.executions[executionId].completedAt = new Date().toISOString();
              st.executions[executionId].error = errContent || 'Process exited without result';
              saveState(st);
            }
            reject(new Error(errContent || 'Process exited without result'));
          }
        }
      }, 2000);
    });

    const handle: SdkExecutionHandle = {
      executionId,
      sessionId: cachedSessionId || `pending-${executionId}`,
      sessionReady,
      result: resultPromise,
      abort: () => {
        running = false;
        try { process.kill(pid, 'SIGTERM'); } catch {}
        const st = loadState();
        if (st.executions[executionId]) {
          st.executions[executionId].status = 'failed';
          st.executions[executionId].completedAt = new Date().toISOString();
          st.executions[executionId].error = 'Aborted';
          saveState(st);
        }
      },
      isRunning: () => {
        if (!running) return false;
        if (!isPidAlive(pid)) { running = false; return false; }
        return true;
      },
    };

    handles.set(executionId, handle);
  }

  if (changed) saveState(state);
  return handles;
}

/**
 * Get status of a specific detached execution from persisted state.
 */
export function getDetachedStatus(executionId: string): DetachedExecution | null {
  const state = loadState();
  const exec = state.executions[executionId];
  if (!exec) return null;

  // Refresh status if still marked running
  if (exec.status === 'running') {
    const parsed = parseLogFile(exec.logFile);
    if (parsed.sessionId && !exec.sessionId) {
      exec.sessionId = parsed.sessionId;
    }
    if (parsed.isComplete && parsed.result) {
      exec.status = parsed.result.success ? 'completed' : 'failed';
      exec.completedAt = new Date().toISOString();
      exec.result = parsed.result;
      saveState(state);
    } else if (!isPidAlive(exec.pid)) {
      exec.status = 'failed';
      exec.completedAt = new Date().toISOString();
      exec.error = 'Process exited without result';
      saveState(state);
    }
  }

  return exec;
}

/**
 * Clean up old execution logs (older than 7 days).
 */
export function cleanupOldExecutions(maxAgeDays: number = 7): number {
  const state = loadState();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const [executionId, exec] of Object.entries(state.executions)) {
    if (exec.status === 'running') continue; // Don't clean running
    const ts = exec.completedAt || exec.startedAt;
    if (new Date(ts).getTime() < cutoff) {
      // Remove log files
      try { fs.unlinkSync(exec.logFile); } catch {}
      try { fs.unlinkSync(exec.errFile); } catch {}
      delete state.executions[executionId];
      cleaned++;
    }
  }

  if (cleaned > 0) saveState(state);
  return cleaned;
}
