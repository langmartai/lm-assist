/**
 * Agent API Implementation
 *
 * Extracted from control-api.ts - direct Claude Agent SDK access with full options.
 *
 * Background executions use detached CLI processes that survive lm-assist restarts.
 * On startup, recoverExecutions() re-attaches to any still-running detached processes.
 */

import type {
  AgentApi,
  AgentExecuteRequest,
  AgentResumeRequest,
  AgentExecuteResponse,
  AgentBackgroundResponse,
  AgentSessionInfo,
  AgentSessionStatus,
  AgentExecutionStatusResponse,
  AgentExecutionResultResponse,
  AgentExecutionStatus,
  SystemPromptConfig as AgentSystemPromptConfig,
} from '../types/agent-api';
import type { PermissionResponse, UserQuestionResponse } from '../types/sdk-event-handlers';
import type { ClaudeSdkRunner, SdkExecuteOptions, SdkExecuteResult, SdkExecutionHandle } from '../sdk-runner';
import type { AgentSessionStore } from '../agent-session-store';
import { spawnDetached, recoverExecutions, cleanupOldExecutions } from '../detached-runner';
import { createTmuxRunner } from '../runners/tmux-runner';
import * as cc from '../terminal/cc';
import { getHarness } from '../harness/registry';
import { abortHarnessRun } from '../harness/abort';
import type { AgentHarness } from '../harness/types';

export interface AgentApiDeps {
  sdkRunner: ClaudeSdkRunner;
  sessionStore: AgentSessionStore;
  projectPath: string;
}

// Background execution tracking
interface BackgroundExecution {
  handle: SdkExecutionHandle;
  request: AgentExecuteRequest | AgentResumeRequest;
  startedAt: Date;
  completedAt?: Date;
  result?: AgentExecuteResponse;
  error?: string;
}

function convertResult(result: SdkExecuteResult, executionId: string): AgentExecuteResponse {
  return {
    success: result.success,
    result: result.result,
    sessionId: result.sessionId,
    executionId,
    durationMs: result.durationMs,
    durationApiMs: result.durationApiMs,
    numTurns: result.numTurns,
    totalCostUsd: result.totalCostUsd,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
      cacheReadInputTokens: result.usage.cacheReadInputTokens,
      totalTokens: result.usage.inputTokens + result.usage.outputTokens,
    },
    modelUsage: {},
    error: result.error,
    fileChanges: result.sessionChanges?.changes?.map(c => ({
      path: c.path,
      action: c.action as 'create' | 'modify' | 'delete',
      diff: c.diff,
    })),
  };
}

export function convertToSdkOptions(
  request: AgentExecuteRequest | AgentResumeRequest,
  executionId: string,
  projectPath: string,
): SdkExecuteOptions {
  const options: SdkExecuteOptions = {
    cwd: request.cwd || projectPath,
    executionId,
    tier: request.tier,
    timeout: request.timeout,
  };

  // Model selection
  if (request.model) {
    options.model = request.model;
  }

  // Permission mode
  if (request.permissionMode) {
    options.permissionMode = request.permissionMode;
  }

  // Browser control: drive the host Chrome via the CLI's --chrome flag.
  if (request.chrome) {
    options.chrome = true;
  }

  // Max turns
  if (request.maxTurns !== undefined) {
    options.maxTurns = request.maxTurns;
  }

  // Max budget
  if (request.maxBudgetUsd !== undefined) {
    options.maxBudgetUsd = request.maxBudgetUsd;
  }

  // Allowed tools
  if (request.allowedTools) {
    options.allowedTools = request.allowedTools;
  }

  // Disallowed tools
  if (request.disallowedTools) {
    options.disallowedTools = request.disallowedTools;
  }

  // MCP servers
  if (request.mcpServers && Object.keys(request.mcpServers).length > 0) {
    options.mcpServers = request.mcpServers;
  }

  // System prompt configuration (only for AgentExecuteRequest, not resume)
  if ('systemPrompt' in request && request.systemPrompt) {
    const sp = request.systemPrompt as AgentSystemPromptConfig;
    if (typeof sp === 'string') {
      options.systemPromptConfig = { type: 'custom', content: sp };
    } else if (sp.type === 'preset') {
      options.systemPromptConfig = {
        type: 'preset',
        preset: sp.preset,
        append: sp.append,
      };
    } else if (sp.type === 'custom') {
      options.systemPromptConfig = { type: 'custom', content: sp.content };
    }
  }

  // Setting sources (only for AgentExecuteRequest, not resume)
  if ('settingSources' in request && request.settingSources) {
    options.settingSources = request.settingSources;
  }

  // Hooks configuration
  if (request.hooks) {
    const hooks = request.hooks;
    options.eventHandlers = {
      autoApprovedTools: hooks.autoApprovedTools,
      deniedTools: hooks.deniedTools,
      defaultPermissionBehavior: hooks.defaultPermissionBehavior,
      defaultAnswerStrategy: hooks.defaultAnswerStrategy,
      handlerTimeout: hooks.handlerTimeout,
    };
  }

  // Additional context
  if (request.context) {
    // Append context to prompt via systemPromptAppend
    options.systemPromptAppend = request.context;
  }

  // Extended thinking configuration
  if (request.extendedThinking?.enabled) {
    options.extendedThinking = {
      enabled: true,
      type: request.extendedThinking.type || 'enabled',
      budgetTokens: request.extendedThinking.type === 'adaptive'
        ? undefined
        : Math.max(1024, request.extendedThinking.budgetTokens || 10000),
    };
  }

  // Output config (effort and format)
  if (request.outputConfig) {
    options.outputConfig = request.outputConfig;
  }

  // Inference geo (data residency)
  if (request.inferenceGeo) {
    options.inferenceGeo = request.inferenceGeo;
  }

  // Environment variables for the CLI subprocess
  if (request.env) {
    options.env = request.env;
  }

  return options;
}

export function createAgentApiImpl(deps: AgentApiDeps): AgentApi {
  const { sdkRunner, sessionStore, projectPath } = deps;

  // Tmux-CC runner — stateful, sessions kept warm for 2h between calls.
  // Created once per AgentApi instance so the in-memory session map +
  // reaper survive across requests.
  const tmuxRunner = createTmuxRunner();

  // Map for tracking background executions with results
  const backgroundExecutions = new Map<string, BackgroundExecution>();

  // Recover detached executions from previous lm-assist runs
  try {
    const recovered = recoverExecutions();
    for (const [execId, handle] of recovered) {
      backgroundExecutions.set(execId, {
        handle,
        request: { prompt: '', background: true } as AgentExecuteRequest,
        startedAt: new Date(),
      });

      // Track completion
      handle.result.then(result => {
        const entry = backgroundExecutions.get(execId);
        if (entry) {
          backgroundExecutions.set(execId, {
            ...entry,
            completedAt: new Date(),
            result: convertResult(result, execId),
          });
        }
      }).catch(err => {
        const entry = backgroundExecutions.get(execId);
        if (entry) {
          backgroundExecutions.set(execId, {
            ...entry,
            completedAt: new Date(),
            error: String(err),
          });
        }
      });
    }
    if (recovered.size > 0) {
      console.log(`[agent-api] Recovered ${recovered.size} detached execution(s) from previous run`);
    }

    // Clean up old logs on startup
    const cleaned = cleanupOldExecutions(7);
    if (cleaned > 0) {
      console.log(`[agent-api] Cleaned up ${cleaned} old detached execution log(s)`);
    }
  } catch (err) {
    console.error('[agent-api] Failed to recover detached executions:', err);
  }

  // Helper to find execution by executionId or sessionId
  const findExecution = (id: string): { executionId: string; entry: BackgroundExecution } | null => {
    // First try direct lookup by executionId
    const directEntry = backgroundExecutions.get(id);
    if (directEntry) {
      return { executionId: id, entry: directEntry };
    }

    // Then search by sessionId
    for (const [execId, entry] of backgroundExecutions) {
      if (entry.handle.sessionId === id) {
        return { executionId: execId, entry };
      }
    }

    return null;
  };

  /**
   * Background execution for the tmux runner.
   *
   * The tmux runner has no detached CLI process (it drives a long-lived
   * CC TUI in this process), so `spawnDetached` doesn't apply. Instead we
   * kick off `tmuxRunner.execute()` unawaited and wrap it in a synthetic
   * `SdkExecutionHandle` so the existing poll/list/abort/result machinery
   * works unchanged. The work runs in-process but returns to the caller
   * immediately (non-blocking), matching the SDK background contract.
   *
   * abort() is a cooperative cancel: Ctrl+C into the CC TUI. The runner's
   * stable-screen wait then settles and returns a (partial) response.
   */
  /**
   * Background wrapper for a registered harness.
   *
   * Generalises the tmux wrapper below for harnesses that own a whole child
   * process per run: the work is already a single promise, so backgrounding is
   * just "don't await it, and record the outcome when it lands".
   *
   * ⚠️ In-process, therefore NOT durable — a Core restart loses the record and
   * orphans the child. That matches the tmux runner's existing behaviour and is
   * declared honestly as `durableBackground: false` in the harness capabilities,
   * so callers are not misled. Making it durable needs a persisted record that
   * does not assume a pid, which the detached-CLI store does.
   *
   * abort() delegates to the harness, which owns the child. This wrapper cannot
   * kill anything itself — it holds a promise, and a promise has no pid.
   */
  const startHarnessBackground = (
    harness: AgentHarness,
    request: AgentExecuteRequest,
    executionId: string,
  ): AgentBackgroundResponse => {
    let running = true;
    const execP = harness.execute(request, executionId);

    const handle: SdkExecutionHandle = {
      executionId,
      sessionId: '',
      sessionReady: execP.then(r => r.sessionId).catch(() => ''),
      result: execP.then(r => r as unknown as SdkExecuteResult),
      // Ask the harness to end its own child. `running` is flipped only if it
      // says it actually signalled something: the previous version set the flag
      // unconditionally, so /abort reported a stop while qwen kept running and
      // kept spending tokens. The API-level abort() below re-checks this and is
      // what reports the truth to the caller.
      abort: () => {
        if (!harness.abort) return;
        try {
          const signalled = harness.abort(executionId);
          if (signalled === true) running = false;
        } catch (err) {
          console.error(`[agent-api] harness ${harness.id} abort threw:`, err);
        }
      },
      isRunning: () => running,
    };

    backgroundExecutions.set(executionId, { handle, request, startedAt: new Date() });

    execP.then(result => {
      running = false;
      const entry = backgroundExecutions.get(executionId);
      if (entry) {
        backgroundExecutions.set(executionId, {
          ...entry,
          completedAt: new Date(),
          result,
          handle: { ...entry.handle, sessionId: result.sessionId },
        });
      }
    }).catch(err => {
      running = false;
      const entry = backgroundExecutions.get(executionId);
      if (entry) {
        backgroundExecutions.set(executionId, { ...entry, completedAt: new Date(), error: String(err) });
      }
    });

    return {
      executionId,
      sessionId: undefined,
      status: 'started',
      statusUrl: `/agent/execution/${executionId}`,
      resultUrl: `/agent/execution/${executionId}/result`,
    };
  };

  const startTmuxBackground = (
    request: AgentExecuteRequest,
    executionId: string,
  ): AgentBackgroundResponse => {
    // Resolve the tmux session name up front (mirror tmux-runner's own
    // derivation) and pin it onto the request so abort() targets exactly
    // the session the runner uses.
    const sessionName = request.tmuxSession
      ?? `agent-${executionId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)}`;
    const pinned: AgentExecuteRequest = { ...request, tmuxSession: sessionName };

    let running = true;
    const execP = tmuxRunner.execute(pinned, executionId);

    const handle: SdkExecutionHandle = {
      executionId,
      sessionId: '',
      sessionReady: execP.then(r => r.sessionId).catch(() => ''),
      // Nothing on the tmux path awaits this (completion is tracked below
      // and getExecutionResult short-circuits on the stored result), but
      // the type contract requires a Promise<SdkExecuteResult>.
      result: execP.then(r => r as unknown as SdkExecuteResult),
      abort: () => {
        running = false;
        cc.interrupt(sessionName).catch(() => { /* best-effort */ });
      },
      isRunning: () => running,
    };

    backgroundExecutions.set(executionId, {
      handle,
      request: pinned,
      startedAt: new Date(),
    });

    execP.then(result => {
      const entry = backgroundExecutions.get(executionId);
      // Non-terminal: the tmux runner's synchronous watch window elapsed
      // but CC is alive and still working (a long autonomous job that
      // outran the watch). The runner killed nothing — the job is
      // genuinely still running headless. Keep the execution 'running'
      // (honest) instead of recording the historical false 'failed';
      // surface the live CC sessionId so the caller can observe it via
      // the terminal API / the job's own status file.
      if ((result as AgentExecuteResponse & { incomplete?: boolean }).incomplete) {
        if (entry) {
          backgroundExecutions.set(executionId, {
            ...entry,
            handle: { ...entry.handle, sessionId: result.sessionId },
          });
        }
        return; // running stays true → getExecution() reports 'running'
      }
      running = false;
      if (entry) {
        backgroundExecutions.set(executionId, {
          ...entry,
          completedAt: new Date(),
          result,
          handle: { ...entry.handle, sessionId: result.sessionId },
        });
      }
    }).catch(err => {
      running = false;
      const entry = backgroundExecutions.get(executionId);
      if (entry) {
        backgroundExecutions.set(executionId, {
          ...entry,
          completedAt: new Date(),
          error: String(err),
        });
      }
    });

    return {
      executionId,
      sessionId: undefined,
      status: 'started',
      statusUrl: `/agent/execution/${executionId}`,
      resultUrl: `/agent/execution/${executionId}/result`,
    };
  };

  return {
    execute: async (request: AgentExecuteRequest) => {
      const start = Date.now();
      const executionId = request.executionId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      try {
        // Convert request to SDK options
        const sdkOptions = convertToSdkOptions(request, executionId, projectPath);

        // Background + tmux runner — handled in-process via the warm-CC
        // runner (no detached CLI). Must intercept BEFORE the SDK
        // detached path below, which assumes an SDK CLI process.
        if (request.background && request.runner === 'tmux') {
          return startTmuxBackground(request, executionId);
        }

        // Registered non-Claude harness. Must intercept BEFORE the background
        // path below, which spawns a detached `claude` CLI child and would
        // therefore run Claude for a request that named another harness.
        // Background is not yet supported for these — say so rather than
        // silently serving a foreground run or a Claude one.
        const harness = request.runner ? getHarness(request.runner) : undefined;
        if (harness) {
          return request.background
            ? startHarnessBackground(harness, request, executionId)
            : await harness.execute(request, executionId);
        }

        // Handle background execution — use detached CLI process
        // so execution survives lm-assist restarts
        if (request.background) {
          const handle = spawnDetached(request.prompt, sdkOptions);
          const startedAt = new Date();

          backgroundExecutions.set(executionId, {
            handle,
            request,
            startedAt,
          });

          // Poll briefly for sessionId before returning (up to 5s)
          let sessionId: string | undefined;
          try {
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), 5000)
            );
            sessionId = await Promise.race([handle.sessionReady, timeoutPromise]);

            // Update the handle's sessionId in the map
            const entry = backgroundExecutions.get(executionId);
            if (entry) {
              backgroundExecutions.set(executionId, {
                ...entry,
                handle: { ...handle, sessionId },
              });
            }
          } catch {
            // Timeout or error — sessionId stays undefined, track it asynchronously
            handle.sessionReady.then(sid => {
              const entry = backgroundExecutions.get(executionId);
              if (entry) {
                backgroundExecutions.set(executionId, {
                  ...entry,
                  handle: { ...handle, sessionId: sid },
                });
              }
            }).catch(() => {});
          }

          const response: AgentBackgroundResponse = {
            executionId,
            sessionId,
            status: 'started',
            statusUrl: `/agent/execution/${executionId}`,
            resultUrl: `/agent/execution/${executionId}/result`,
          };

          // Track completion and store result
          handle.result.then(result => {
            const entry = backgroundExecutions.get(executionId);
            if (entry) {
              backgroundExecutions.set(executionId, {
                ...entry,
                completedAt: new Date(),
                result: convertResult(result, executionId),
              });
            }
          }).catch(err => {
            const entry = backgroundExecutions.get(executionId);
            if (entry) {
              backgroundExecutions.set(executionId, {
                ...entry,
                completedAt: new Date(),
                error: String(err),
              });
            }
          });

          return response;
        }

        // Tmux runner — long-lived CC TUI, session stays warm.
        if (request.runner === 'tmux') {
          return await tmuxRunner.execute(request, executionId);
        }

        // Synchronous execution (SDK)
        const result = await sdkRunner.execute(request.prompt, sdkOptions);
        return convertResult(result, executionId);
      } catch (e) {
        // Return error as AgentExecuteResponse
        const errorResponse: AgentExecuteResponse = {
          success: false,
          result: '',
          sessionId: '',
          executionId,
          durationMs: Date.now() - start,
          durationApiMs: 0,
          numTurns: 0,
          totalCostUsd: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            totalTokens: 0,
          },
          modelUsage: {},
          error: String(e),
        };
        return errorResponse;
      }
    },

    resume: async (request: AgentResumeRequest) => {
      const start = Date.now();
      const executionId = request.executionId || `agent-resume-${Date.now()}`;

      try {
        // A registered harness must handle its OWN resume or be refused. Falling
        // through would run the Claude SDK against a sessionId that belongs to a
        // different harness entirely — the silent-substitution failure again.
        const resumeRunner = (request as AgentExecuteRequest).runner;
        const resumeHarness = resumeRunner ? getHarness(resumeRunner) : undefined;
        if (resumeHarness) {
          if (!resumeHarness.resume) {
            return {
              success: false,
              result: '',
              sessionId: request.sessionId,
              executionId,
              durationMs: Date.now() - start,
              durationApiMs: 0,
              numTurns: 0,
              totalCostUsd: 0,
              usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalTokens: 0 },
              modelUsage: {},
              runner: resumeRunner,
              error: `Runner '${resumeRunner}' does not support resume. Start a new execution instead.`,
            } as AgentExecuteResponse;
          }
          return await resumeHarness.resume(request);
        }

        // Build SDK options with resume
        const sdkOptions = convertToSdkOptions(request, executionId, projectPath);
        sdkOptions.resume = true;
        sdkOptions.sessionId = request.sessionId;

        // Handle background resume — use detached CLI process
        if (request.background) {
          const handle = spawnDetached(request.prompt, sdkOptions);
          const startedAt = new Date();

          backgroundExecutions.set(executionId, {
            handle,
            request,
            startedAt,
          });

          const response: AgentBackgroundResponse = {
            executionId,
            sessionId: request.sessionId,
            status: 'started',
            statusUrl: `/agent/execution/${executionId}`,
            resultUrl: `/agent/execution/${executionId}/result`,
          };

          // Track completion and store result
          handle.result.then(result => {
            const entry = backgroundExecutions.get(executionId);
            if (entry) {
              backgroundExecutions.set(executionId, {
                ...entry,
                completedAt: new Date(),
                result: convertResult(result, executionId),
              });
            }
          }).catch(err => {
            const entry = backgroundExecutions.get(executionId);
            if (entry) {
              backgroundExecutions.set(executionId, {
                ...entry,
                completedAt: new Date(),
                error: String(err),
              });
            }
          });

          return response;
        }

        // Synchronous execution
        const result = await sdkRunner.execute(request.prompt, sdkOptions);
        return convertResult(result, executionId);
      } catch (e) {
        const errorResponse: AgentExecuteResponse = {
          success: false,
          result: '',
          sessionId: request.sessionId,
          executionId,
          durationMs: Date.now() - start,
          durationApiMs: 0,
          numTurns: 0,
          totalCostUsd: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            totalTokens: 0,
          },
          modelUsage: {},
          error: String(e),
        };
        return errorResponse;
      }
    },

    // Get execution status (for polling) - accepts executionId or sessionId
    getExecution: async (id: string): Promise<AgentExecutionStatusResponse | null> => {
      const found = findExecution(id);
      if (!found) {
        return null;
      }

      const { executionId, entry } = found;
      const isRunning = entry.handle.isRunning();
      let status: AgentExecutionStatus = 'running';
      if (!isRunning) {
        if (entry.error) {
          status = 'failed';
        } else if (entry.result) {
          status = entry.result.success ? 'completed' : 'failed';
        } else {
          status = 'completed';
        }
      }

      return {
        executionId,
        sessionId: entry.handle.sessionId || undefined,
        status,
        isRunning,
        tier: entry.request.tier,
        startedAt: entry.startedAt,
        endedAt: entry.completedAt,
        claudeSessionUrl: entry.handle.sessionId
          ? `/sessions/${entry.handle.sessionId}`
          : undefined,
        cwd: entry.request.cwd || undefined,
      };
    },

    // Get execution result (optionally waits for completion) - accepts executionId or sessionId
    getExecutionResult: async (
      id: string,
      wait: boolean = true,
      timeoutMs?: number
    ): Promise<AgentExecutionResultResponse> => {
      const found = findExecution(id);
      if (!found) {
        return {
          executionId: id,
          completed: false,
          error: 'Execution not found',
        };
      }

      const { executionId, entry } = found;

      // If not waiting, return current state immediately
      if (!wait) {
        if (entry.result) {
          return {
            executionId,
            completed: true,
            result: entry.result,
          };
        }
        if (entry.error) {
          return {
            executionId,
            completed: true,
            error: entry.error,
          };
        }
        // Still running
        return {
          executionId,
          completed: false,
        };
      }

      // Already finished — return the stored result/error verbatim.
      // tmux entries store the real AgentExecuteResponse (with the
      // additive tmuxSession/runner fields), so don't re-derive it.
      if (entry.result) {
        return { executionId, completed: true, result: entry.result };
      }
      if (entry.error) {
        return { executionId, completed: true, error: entry.error };
      }

      // Any non-SDK runner, still in flight: handle.result already resolves to
      // an AgentExecuteResponse — await it directly and skip convertResult so
      // the runner-specific fields (runner, tmuxSession, incomplete) aren't
      // stripped. Generalised from `=== 'tmux'`: with a registry of harnesses,
      // an id-by-id test silently flattens every runner someone forgets to add,
      // and the caller gets a valid-looking response with the fields missing.
      const entryRunner = (entry.request as AgentExecuteRequest).runner;
      if (entryRunner && entryRunner !== 'sdk') {
        try {
          let rp = entry.handle.result as unknown as Promise<AgentExecuteResponse>;
          if (timeoutMs) {
            const t = new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error('Timeout waiting for execution result')), timeoutMs);
            });
            rp = Promise.race([rp, t]);
          }
          const resp = await rp;
          backgroundExecutions.set(executionId, {
            ...entry,
            completedAt: new Date(),
            result: resp,
          });
          return { executionId, completed: true, result: resp };
        } catch (err) {
          const msg = String(err);
          if (!entry.completedAt) {
            backgroundExecutions.set(executionId, {
              ...entry,
              completedAt: new Date(),
              error: msg,
            });
          }
          return { executionId, completed: true, error: msg };
        }
      }

      // Wait for completion with optional timeout
      try {
        let resultPromise = entry.handle.result;

        if (timeoutMs) {
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Timeout waiting for execution result')), timeoutMs);
          });
          resultPromise = Promise.race([resultPromise, timeoutPromise]);
        }

        const result = await resultPromise;
        const response = convertResult(result, executionId);

        // Update stored result
        backgroundExecutions.set(executionId, {
          ...entry,
          completedAt: new Date(),
          result: response,
        });

        return {
          executionId,
          completed: true,
          result: response,
        };
      } catch (err) {
        const errorMsg = String(err);

        // Update stored error
        if (!entry.completedAt) {
          backgroundExecutions.set(executionId, {
            ...entry,
            completedAt: new Date(),
            error: errorMsg,
          });
        }

        return {
          executionId,
          completed: true,
          error: errorMsg,
        };
      }
    },

    // List all active executions
    listExecutions: async (): Promise<AgentExecutionStatusResponse[]> => {
      const executions: AgentExecutionStatusResponse[] = [];

      for (const [executionId, entry] of backgroundExecutions) {
        const isRunning = entry.handle.isRunning();
        let status: AgentExecutionStatus = 'running';
        if (!isRunning) {
          if (entry.error) {
            status = 'failed';
          } else if (entry.result) {
            status = entry.result.success ? 'completed' : 'failed';
          } else {
            status = 'completed';
          }
        }

        executions.push({
          executionId,
          sessionId: entry.handle.sessionId || undefined,
          status,
          isRunning,
          tier: entry.request.tier,
          startedAt: entry.startedAt,
          endedAt: entry.completedAt,
          claudeSessionUrl: entry.handle.sessionId
            ? `/sessions/${entry.handle.sessionId}`
            : undefined,
        });
      }

      return executions;
    },

    getSession: async (sessionId: string) => {
      // Check background executions first
      for (const [execId, entry] of backgroundExecutions) {
        if (entry.handle.sessionId === sessionId || execId === sessionId) {
          const isRunning = entry.handle.isRunning();
          const info: AgentSessionInfo = {
            sessionId: entry.handle.sessionId || sessionId,
            executionId: execId,
            status: isRunning ? 'running' : 'completed',
            tier: entry.request.tier,
            startedAt: new Date(),
            turnCount: 0,
            costUsd: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              totalTokens: 0,
            },
          };
          return info;
        }
      }

      // Check session store
      const session = sessionStore.getSession(sessionId);
      if (session) {
        const info: AgentSessionInfo = {
          sessionId: session.sessionId,
          executionId: session.executionId || '',
          status: session.status as AgentSessionStatus,
          tier: session.tier === 'orchestrator' ? undefined : session.tier,
          startedAt: session.startedAt || session.createdAt,
          endedAt: session.completedAt,
          turnCount: session.turnCount,
          costUsd: session.costUsd,
          usage: {
            inputTokens: session.usage.inputTokens,
            outputTokens: session.usage.outputTokens,
            cacheCreationInputTokens: session.usage.cacheWriteTokens,
            cacheReadInputTokens: session.usage.cacheReadTokens,
            totalTokens: session.usage.inputTokens + session.usage.outputTokens,
          },
        };
        return info;
      }

      return null;
    },

    listSessions: async (options) => {
      const agentSessions: AgentSessionInfo[] = [];

      // Include background executions
      for (const [execId, entry] of backgroundExecutions) {
        if (options?.tier && entry.request.tier !== options.tier) continue;

        const isRunning = entry.handle.isRunning();
        const status: AgentSessionStatus = isRunning ? 'running' : 'completed';

        if (options?.status && !options.status.includes(status)) continue;

        agentSessions.push({
          sessionId: entry.handle.sessionId || execId,
          executionId: execId,
          status,
          tier: entry.request.tier,
          startedAt: new Date(),
          turnCount: 0,
          costUsd: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            totalTokens: 0,
          },
        });
      }

      // Include sessions from store
      let storeSessions = options?.tier
        ? sessionStore.getTierSessions(options.tier)
        : sessionStore.getActiveSessions();

      if (options?.status) {
        storeSessions = storeSessions.filter(s =>
          options.status!.includes(s.status as AgentSessionStatus)
        );
      }

      for (const session of storeSessions) {
        // Avoid duplicates
        if (agentSessions.some(s => s.sessionId === session.sessionId)) continue;

        agentSessions.push({
          sessionId: session.sessionId,
          executionId: session.executionId || '',
          status: session.status as AgentSessionStatus,
          tier: session.tier === 'orchestrator' ? undefined : session.tier,
          startedAt: session.startedAt || session.createdAt,
          endedAt: session.completedAt,
          turnCount: session.turnCount,
          costUsd: session.costUsd,
          usage: {
            inputTokens: session.usage.inputTokens,
            outputTokens: session.usage.outputTokens,
            cacheCreationInputTokens: session.usage.cacheWriteTokens,
            cacheReadInputTokens: session.usage.cacheReadTokens,
            totalTokens: session.usage.inputTokens + session.usage.outputTokens,
          },
        });
      }

      return agentSessions;
    },

    abort: async (sessionId: string) => {
      // Check background executions
      for (const [execId, entry] of backgroundExecutions) {
        if (entry.handle.sessionId === sessionId || execId === sessionId) {
          // A registered harness owns the child process, so only it can end the
          // run — this map holds a promise, and a promise has no pid. Dropping
          // the entry without asking would report a stop that never happened:
          // the caller sees "aborted" while a gateway agent keeps running and
          // keeps spending tokens. So the harness's answer decides ours.
          const runner = (entry.request as AgentExecuteRequest).runner;
          const harness = runner ? getHarness(runner) : undefined;
          if (harness) {
            const outcome = await abortHarnessRun(harness, execId, Boolean(entry.completedAt));
            if (!outcome.success) return { success: false, sessionId, reason: outcome.reason };
            backgroundExecutions.delete(execId);
            return { success: true, sessionId };
          }

          entry.handle.abort();
          backgroundExecutions.delete(execId);
          return { success: true, sessionId };
        }
      }

      // Try to kill via SDK runner
      const killed = sdkRunner.kill(sessionId);
      return { success: killed, sessionId };
    },

    respondToPermission: async (sessionId: string, response: PermissionResponse) => {
      const success = sdkRunner.respondToBlockingEvent(sessionId, response);
      return {
        success,
        sessionId,
        toolName: '',
        action: response.behavior === 'allow' ? 'allowed' as const : 'denied' as const,
      };
    },

    answerQuestion: async (sessionId: string, requestId: string, answers: Record<string, string | string[]>) => {
      const response: UserQuestionResponse = { requestId, answers, timedOut: false };
      const success = sdkRunner.respondToBlockingEvent(sessionId, response);
      return { success, sessionId, answers };
    },
  };
}
