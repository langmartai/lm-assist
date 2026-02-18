/**
 * Agent API Implementation
 *
 * Extracted from control-api.ts - direct Claude Agent SDK access with full options.
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

  // Map for tracking background executions with results
  const backgroundExecutions = new Map<string, BackgroundExecution>();

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

  return {
    execute: async (request: AgentExecuteRequest) => {
      const start = Date.now();
      const executionId = request.executionId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      try {
        // Convert request to SDK options
        const sdkOptions = convertToSdkOptions(request, executionId, projectPath);

        // Handle background execution
        if (request.background) {
          const handle = sdkRunner.executeAsync(request.prompt, sdkOptions);
          const startedAt = new Date();

          backgroundExecutions.set(executionId, {
            handle,
            request,
            startedAt,
          });

          const response: AgentBackgroundResponse = {
            executionId,
            status: 'started',
            statusUrl: `/agent/execution/${executionId}`,
            resultUrl: `/agent/execution/${executionId}/result`,
          };

          // Track session ID once available
          handle.sessionReady.then(sessionId => {
            const entry = backgroundExecutions.get(executionId);
            if (entry) {
              backgroundExecutions.set(executionId, {
                ...entry,
                handle: { ...handle, sessionId },
              });
            }
          }).catch(() => {});

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
        // Build SDK options with resume
        const sdkOptions = convertToSdkOptions(request, executionId, projectPath);
        sdkOptions.resume = true;
        sdkOptions.sessionId = request.sessionId;

        // Handle background execution
        if (request.background) {
          const handle = sdkRunner.executeAsync(request.prompt, sdkOptions);
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
