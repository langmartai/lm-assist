/**
 * Sessions API Implementation
 *
 * Manages session file access (reads from ~/.claude/projects/).
 */

import type {
  SessionsApi,
  MonitoredExecutionsResponse,
  MonitorSummaryResponse,
  AbortExecutionResponse,
  AbortAllResponse,
  BatchCheckRequest,
  BatchCheckResponse,
} from '../types/control-api';
import type { AgentSessionStore } from '../agent-session-store';
import { summarizeFileChanges } from '../agent-session-store';
import type { AgentSessionMonitor } from '../agent-session-monitor';
import { decodePath } from '../utils/path-utils';
import { wrapResponse, wrapError } from './helpers';

export interface SessionsApiDeps {
  sessionStore: AgentSessionStore;
  sessionMonitor: AgentSessionMonitor;
}

export function createSessionsApiImpl(deps: SessionsApiDeps): SessionsApi {
  const { sessionStore, sessionMonitor } = deps;

  return {
    // ========================================================================
    // Monitor API
    // ========================================================================

    getMonitoredExecutions: async () => {
      const start = Date.now();
      try {
        const executions = sessionMonitor.getMonitoredExecutions();
        return wrapResponse<MonitoredExecutionsResponse>({
          executions: executions.map(exec => {
            const session = sessionStore.getSession(exec.session.sessionId);
            return {
              executionId: exec.handle.executionId,
              sessionId: exec.session.sessionId,
              tier: exec.tier,
              status: session?.status || 'unknown',
              isRunning: exec.handle.isRunning(),
              startTime: exec.startTime.toISOString(),
              elapsedMs: Date.now() - exec.startTime.getTime(),
              turnCount: session?.turnCount || 0,
              costUsd: session?.costUsd || 0,
            };
          }),
          total: executions.length,
        }, start);
      } catch (e) {
        return wrapError('MONITOR_EXECUTIONS_ERROR', String(e), start);
      }
    },

    getMonitorSummary: async () => {
      const start = Date.now();
      try {
        const summary = sessionMonitor.getSummary();
        return wrapResponse<MonitorSummaryResponse>(summary, start);
      } catch (e) {
        return wrapError('MONITOR_SUMMARY_ERROR', String(e), start);
      }
    },

    abortExecution: async (executionId: string) => {
      const start = Date.now();
      try {
        const aborted = sessionMonitor.abortExecution(executionId);
        return wrapResponse<AbortExecutionResponse>({
          executionId,
          aborted,
        }, start);
      } catch (e) {
        return wrapError('ABORT_EXECUTION_ERROR', String(e), start);
      }
    },

    abortAll: async () => {
      const start = Date.now();
      try {
        const abortedCount = sessionMonitor.abortAll();
        return wrapResponse<AbortAllResponse>({ abortedCount }, start);
      } catch (e) {
        return wrapError('ABORT_ALL_ERROR', String(e), start);
      }
    },

    // ========================================================================
    // Sessions API (reads from ~/.claude/projects/)
    // ========================================================================

    getSession: async (sessionId: string, options?: {
      cwd?: string;
      includeRawMessages?: boolean;
      /** Include read-only file operations in fileChanges (excluded by default) */
      includeReads?: boolean;
      // ─── Line Index Filters (JSONL file line number) ───
      /** Filter to include only items from this line index onwards */
      fromLineIndex?: number;
      /** Filter to include only items up to this line index */
      toLineIndex?: number;
      // ─── Turn Index Filters (conversation turn number) ───
      /** Filter to include only items from this turn index onwards */
      fromTurnIndex?: number;
      /** Filter to include only items up to this turn index */
      toTurnIndex?: number;
      // ─── User Prompt Index Filters (user message number) ───
      /** Filter to include only items from this user prompt index onwards (0-based) */
      fromUserPromptIndex?: number;
      /** Filter to include only items up to this user prompt index (0-based) */
      toUserPromptIndex?: number;
      /** @deprecated Use fromUserPromptIndex/toUserPromptIndex instead. Limit to last N user prompts */
      lastNUserPrompts?: number;
      /** Set to true to return all data without default limits */
      unlimited?: boolean;
      /** ISO timestamp — return notModified if session file unchanged since this time */
      ifModifiedSince?: string;
    }) => {
      const start = Date.now();
      try {
        // ─── Fast Not-Modified Check ───
        // When ifModifiedSince is provided, stat the session file and short-circuit
        // if the file hasn't been modified since the client's known timestamp.
        if (options?.ifModifiedSince) {
          const clientTime = new Date(options.ifModifiedSince).getTime();
          if (!isNaN(clientTime)) {
            const sessionPath = sessionStore.getSessionPath(sessionId, options?.cwd);
            try {
              const stats = require('fs').statSync(sessionPath);
              if (stats.mtime.getTime() <= clientTime) {
                return wrapResponse({
                  notModified: true,
                  sessionId,
                  lastModified: stats.mtime.toISOString(),
                } as any, start);
              }
            } catch {
              // File not found — fall through to normal path which handles errors
            }
          }
        }

        // ─── Fast Delta Path ───
        // When fromLineIndex is specified with no other complex filters,
        // skip the expensive full session parse and use cached data directly.
        const hasDeltaOnly = options?.fromLineIndex !== undefined &&
          options.toLineIndex === undefined &&
          options.fromTurnIndex === undefined &&
          options.toTurnIndex === undefined &&
          options.fromUserPromptIndex === undefined &&
          options.toUserPromptIndex === undefined &&
          options.lastNUserPrompts === undefined;

        if (hasDeltaOnly) {
          const { getSessionCache } = await import('../session-cache');
          const cache = getSessionCache();
          const sessionPath = sessionStore.getSessionPath(sessionId, options?.cwd);
          const fs = require('fs');
          if (!sessionPath || !fs.existsSync(sessionPath)) {
            return wrapError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, start);
          }

          const fromLine = options.fromLineIndex!;
          const stats = fs.statSync(sessionPath);
          const msSinceModified = Date.now() - stats.mtime.getTime();
          const isActive = msSinceModified < 60000;

          // For delta: get session data with incremental parsing (fast for append-only files)
          // and raw messages (has its own cache with byte-offset seeking)
          const [allRaw, cacheData] = await Promise.all([
            cache.getRawMessages(sessionPath),
            cache.getSessionData(sessionPath),
          ]);
          const rawMessages = allRaw?.filter((m: any) => m.lineIndex >= fromLine);

          const rawLastLine = allRaw && allRaw.length > 0
            ? allRaw[allRaw.length - 1].lineIndex
            : 0;
          const cacheLastLine = cacheData?.lastLineIndex || 0;
          const lastLineIndex = Math.max(rawLastLine, cacheLastLine);

          const { getProcessStatusStore } = await import('../process-status-store');
          const processRunning = getProcessStatusStore().getSessionProcess(cacheData?.sessionId || sessionId);

          return wrapResponse({
            sessionId: cacheData?.sessionId || sessionId,
            cwd: cacheData?.cwd || '',
            projectPath: cacheData?.cwd || '',
            model: cacheData?.model || '',
            claudeCodeVersion: cacheData?.claudeCodeVersion || '',
            permissionMode: cacheData?.permissionMode || '',
            tools: cacheData?.tools || [],
            mcpServers: cacheData?.mcpServers || [],
            numTurns: cacheData?.numTurns || 0,
            durationMs: cacheData?.durationMs || 0,
            durationApiMs: cacheData?.durationApiMs || 0,
            totalCostUsd: cacheData?.totalCostUsd || 0,
            usage: cacheData?.usage || { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            success: cacheData?.success ?? true,
            isActive,
            running: processRunning,
            status: isActive ? 'running' : 'completed',
            lastModified: stats.mtime.toISOString(),
            // For delta, return filtered pre-parsed arrays from memory cache (if available)
            userPrompts: cacheData?.userPrompts.filter(p => p.lineIndex >= fromLine) || [],
            toolUses: cacheData?.toolUses.filter(t => t.lineIndex >= fromLine) || [],
            responses: cacheData?.responses.filter(r => r.lineIndex >= fromLine) || [],
            thinkingBlocks: cacheData?.thinkingBlocks.filter(t => t.lineIndex >= fromLine) || [],
            rawMessages: options?.includeRawMessages ? rawMessages : undefined,
            // Tasks, todos, plans, subagents (not filtered by lineIndex — always return all for context)
            tasks: cacheData?.tasks || [],
            todos: cacheData?.todos || [],
            plans: cacheData?.plans || [],
            subagents: cacheData?.subagents || [],
            // ─── Team data ───
            teamName: cacheData?.teamName,
            allTeams: cacheData?.allTeams && cacheData.allTeams.length > 0 ? cacheData.allTeams : undefined,
            teamOperations: cacheData?.teamOperations && cacheData.teamOperations.length > 0 ? cacheData.teamOperations : undefined,
            teamMessages: cacheData?.teamMessages && cacheData.teamMessages.length > 0 ? cacheData.teamMessages : undefined,
            forkedFromSessionId: cacheData?.forkedFromSessionId,
            // Task ID -> subject map for resolving TaskUpdate references
            taskSubjects: cacheData?.tasks && cacheData.tasks.length > 0
              ? Object.fromEntries(cacheData.tasks.filter((t: any) => t.subject).map((t: any) => [t.id, t.subject]))
              : undefined,
            totalUserPrompts: cacheData?.userPrompts.length || 0,
            totalTurns: cacheData?.numTurns || 0,
            lastLineIndex,
            hasMore: false,
          }, start);
        }

        const data = await sessionStore.readSession(sessionId, {
          cwd: options?.cwd,
          includeRawMessages: options?.includeRawMessages,
        });

        if (!data) {
          return wrapError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, start);
        }

        const { getProcessStatusStore } = await import('../process-status-store');

        // Get file mtime for lastModified (enables ifModifiedSince on subsequent requests)
        let lastModified: string | undefined;
        let forkedFromSessionId: string | undefined;
        try {
          const sessionPath = sessionStore.getSessionPath(sessionId, options?.cwd);
          const fs = require('fs');
          lastModified = fs.statSync(sessionPath).mtime.toISOString();
          // Get forkedFromSessionId from cache (not available in full-parse data)
          const { getSessionCache } = await import('../session-cache');
          const cacheData = await getSessionCache().getSessionData(sessionPath);
          forkedFromSessionId = cacheData?.forkedFromSessionId;
        } catch {
          // Non-critical — skip if stat fails
        }

        let rawMessages = data.rawMessages;
        let userPrompts = data.userPrompts;
        let toolUses = data.toolUses;
        let responses = data.responses;
        let thinkingBlocks = data.thinkingBlocks;
        let subagents = data.subagents;
        const totalUserPrompts = userPrompts?.length || 0;
        const totalTurns = data.numTurns || 0;
        const totalSubagents = subagents?.length || 0;
        let hasMore = false;

        // ─── Default Limit (when no filters specified) ───
        // Apply default limit of last 50 user prompts to avoid returning huge sessions
        const DEFAULT_LAST_N_USER_PROMPTS = 50;
        const hasAnyFilter = options?.fromLineIndex !== undefined ||
          options?.toLineIndex !== undefined ||
          options?.fromTurnIndex !== undefined ||
          options?.toTurnIndex !== undefined ||
          options?.fromUserPromptIndex !== undefined ||
          options?.toUserPromptIndex !== undefined ||
          options?.lastNUserPrompts !== undefined;

        let effectiveLastN = options?.lastNUserPrompts;
        if (!hasAnyFilter && !options?.unlimited && totalUserPrompts > DEFAULT_LAST_N_USER_PROMPTS) {
          effectiveLastN = DEFAULT_LAST_N_USER_PROMPTS;
        }

        // ─── Apply Line Index Filter ───
        const fromLine = options?.fromLineIndex;
        const toLine = options?.toLineIndex;
        if (fromLine !== undefined || toLine !== undefined) {
          const minLine = fromLine ?? 0;
          const maxLine = toLine ?? Number.MAX_SAFE_INTEGER;
          const lineFilter = (item: any) => item.lineIndex >= minLine && item.lineIndex <= maxLine;

          if (rawMessages) rawMessages = rawMessages.filter(lineFilter);
          if (userPrompts) userPrompts = userPrompts.filter(lineFilter);
          if (toolUses) toolUses = toolUses.filter(lineFilter);
          if (responses) responses = responses.filter(lineFilter);
          if (thinkingBlocks) thinkingBlocks = thinkingBlocks.filter(lineFilter);
          if (subagents) subagents = subagents.filter(lineFilter);
        }

        // ─── Apply Turn Index Filter ───
        const fromTurn = options?.fromTurnIndex;
        const toTurn = options?.toTurnIndex;
        if (fromTurn !== undefined || toTurn !== undefined) {
          const minTurn = fromTurn ?? 0;
          const maxTurn = toTurn ?? Number.MAX_SAFE_INTEGER;
          const turnFilter = (item: any) => item.turnIndex >= minTurn && item.turnIndex <= maxTurn;

          // rawMessages don't have turnIndex, filter by associated turn
          if (rawMessages) {
            // Find lineIndex range for the turn range
            const turnsInRange = [...(userPrompts || []), ...(responses || [])]
              .filter(turnFilter);
            if (turnsInRange.length > 0) {
              const minLineInTurn = Math.min(...turnsInRange.map((t: any) => t.lineIndex));
              const maxLineInTurn = Math.max(...turnsInRange.map((t: any) => t.lineIndex));
              rawMessages = rawMessages.filter((m: any) =>
                m.lineIndex >= minLineInTurn && m.lineIndex <= maxLineInTurn
              );
            }
          }
          if (userPrompts) userPrompts = userPrompts.filter(turnFilter);
          if (toolUses) toolUses = toolUses.filter(turnFilter);
          if (responses) responses = responses.filter(turnFilter);
          if (thinkingBlocks) thinkingBlocks = thinkingBlocks.filter(turnFilter);
          if (subagents) subagents = subagents.filter(turnFilter);
        }

        // ─── Apply User Prompt Index Filter ───
        const fromPrompt = options?.fromUserPromptIndex;
        const toPrompt = options?.toUserPromptIndex;
        if ((fromPrompt !== undefined || toPrompt !== undefined) && userPrompts && userPrompts.length > 0) {
          const minPromptIdx = Math.max(0, Math.min(fromPrompt ?? 0, userPrompts.length - 1));
          const maxPromptIdx = Math.max(0, Math.min(toPrompt ?? userPrompts.length - 1, userPrompts.length - 1));

          // Get the lineIndex range for the selected prompts
          const startLineIndex = userPrompts[minPromptIdx]?.lineIndex || 0;

          // End at the next prompt's lineIndex - 1, or end of session if this is the last prompt
          let endLineIndex: number;
          if (maxPromptIdx >= userPrompts.length - 1) {
            // Last prompt or beyond - include everything to the end
            endLineIndex = Number.MAX_SAFE_INTEGER;
          } else {
            // End before the next prompt starts
            endLineIndex = (userPrompts[maxPromptIdx + 1]?.lineIndex || 1) - 1;
          }

          const promptRangeFilter = (item: any) =>
            item.lineIndex >= startLineIndex && item.lineIndex <= endLineIndex;

          // Subagents have userPromptIndex, filter directly
          const subagentPromptFilter = (item: any) =>
            item.userPromptIndex >= minPromptIdx && item.userPromptIndex <= maxPromptIdx;

          if (rawMessages) rawMessages = rawMessages.filter(promptRangeFilter);
          userPrompts = userPrompts.slice(minPromptIdx, maxPromptIdx + 1);
          if (toolUses) toolUses = toolUses.filter(promptRangeFilter);
          if (responses) responses = responses.filter(promptRangeFilter);
          if (thinkingBlocks) thinkingBlocks = thinkingBlocks.filter(promptRangeFilter);
          if (subagents) subagents = subagents.filter(subagentPromptFilter);

          hasMore = minPromptIdx > 0 || maxPromptIdx < totalUserPrompts - 1;
        }

        // ─── Apply lastNUserPrompts (or default limit) ───
        const lastN = effectiveLastN;
        if (lastN && lastN > 0 && userPrompts && userPrompts.length > lastN) {
          hasMore = true;
          const cutoffPromptIndex = userPrompts.length - lastN;
          const cutoffLineIndex = userPrompts[cutoffPromptIndex]?.lineIndex || 0;

          if (rawMessages) rawMessages = rawMessages.filter((m: any) => m.lineIndex >= cutoffLineIndex);
          userPrompts = userPrompts.slice(-lastN);
          if (toolUses) toolUses = toolUses.filter((t: any) => t.lineIndex >= cutoffLineIndex);
          if (responses) responses = responses.filter((r: any) => r.lineIndex >= cutoffLineIndex);
          if (thinkingBlocks) thinkingBlocks = thinkingBlocks.filter((t: any) => t.lineIndex >= cutoffLineIndex);
          if (subagents) subagents = subagents.filter((s: any) => s.userPromptIndex >= cutoffPromptIndex);
        }

        return wrapResponse({
          sessionId: data.sessionId,
          cwd: data.cwd,
          projectPath: data.cwd,
          model: data.model,
          claudeCodeVersion: data.claudeCodeVersion,
          permissionMode: data.permissionMode,
          tools: data.tools,
          mcpServers: data.mcpServers,
          numTurns: data.numTurns,
          durationMs: data.durationMs,
          durationApiMs: data.durationApiMs,
          totalCostUsd: data.totalCostUsd,
          usage: data.usage,
          result: data.result,
          errors: data.errors,
          success: data.success,
          isActive: data.isActive,
          running: getProcessStatusStore().getSessionProcess(data.sessionId),
          status: data.status,
          lastModified,
          lastActivityAt: data.lastActivityAt?.toISOString(),
          userPrompts,
          toolUses,
          responses,
          systemPrompt: data.systemPrompt,
          fileChanges: options?.includeReads
            ? data.fileChanges
            : data.fileChanges?.filter(f => f.category !== 'read'),
          fileSummary: (() => {
            const { read, ...rest } = summarizeFileChanges(data.fileChanges || []);
            return options?.includeReads ? { ...rest, read } : rest;
          })(),
          dbOperations: data.dbOperations,
          gitOperations: data.gitOperations,
          todos: data.todos,
          tasks: data.tasks,
          thinkingBlocks,
          rawMessages,
          // ─── Subagents (with parent session indices) ───
          subagents,
          totalSubagents,
          // ─── Plans (EnterPlanMode/ExitPlanMode) ───
          plans: data.plans,
          // ─── Team data ───
          teamName: data.teamName,
          allTeams: data.allTeams,
          teamOperations: data.teamOperations,
          teamMessages: data.teamMessages,
          forkedFromSessionId,
          // Task ID -> subject map for resolving TaskUpdate references
          taskSubjects: data.taskSubjects,
          // ─── Index Totals (for pagination/delta queries) ───
          totalUserPrompts,
          totalTurns,
          lastLineIndex: Math.max(
            ...[
              ...(data.userPrompts?.map((p: any) => p.lineIndex) || [0]),
              ...(data.toolUses?.map((t: any) => t.lineIndex) || [0]),
              ...(data.responses?.map((r: any) => r.lineIndex) || [0]),
            ]
          ),
          lastTurnIndex: Math.max(
            ...[
              ...(data.userPrompts?.map((p: any) => p.turnIndex) || [0]),
              ...(data.toolUses?.map((t: any) => t.turnIndex) || [0]),
              ...(data.responses?.map((r: any) => r.turnIndex) || [0]),
            ]
          ),
          hasMore,
        }, start);
      } catch (e) {
        return wrapError('SESSION_READ_ERROR', String(e), start);
      }
    },

    listSessions: async (cwd?: string, options?: { limit?: number }) => {
      const start = Date.now();
      try {
        let sessions = sessionStore.listSessionsWithDetails(cwd);

        // Read running process status from cached store (O(1) lookups)
        const { getProcessStatusStore } = await import('../process-status-store');
        const runningSessions = getProcessStatusStore().getRunningSessionMap();

        // Add running info to sessions
        let sessionsWithRunning = sessions.map(session => ({
          ...session,
          running: runningSessions.has(session.sessionId)
            ? runningSessions.get(session.sessionId)
            : undefined,
        }));

        // Apply limit if specified
        const total = sessionsWithRunning.length;
        if (options?.limit && options.limit > 0) {
          sessionsWithRunning = sessionsWithRunning.slice(0, options.limit);
        }

        return wrapResponse({
          sessions: sessionsWithRunning,
          total,
          returned: sessionsWithRunning.length,
          runningCount: runningSessions.size,
        }, start);
      } catch (e) {
        return wrapError('SESSIONS_LIST_ERROR', String(e), start);
      }
    },

    listProjects: async () => {
      const start = Date.now();
      try {
        const projects = sessionStore.listProjects();
        return wrapResponse({
          projects,
          total: projects.length,
        }, start);
      } catch (e) {
        return wrapError('PROJECTS_LIST_ERROR', String(e), start);
      }
    },

    sessionExists: async (sessionId: string, cwd?: string) => {
      const start = Date.now();
      try {
        const exists = sessionStore.sessionExists(sessionId, cwd);
        return wrapResponse({ exists }, start);
      } catch (e) {
        return wrapError('SESSION_EXISTS_ERROR', String(e), start);
      }
    },

    // ========================================================================
    // Conversation API (Session Messages)
    // ========================================================================

    getConversation: async (options: {
      sessionId: string;
      cwd?: string;
      toolDetail?: 'none' | 'summary' | 'full';
      lastN?: number;
      beforeLine?: number;
      includeSystemPrompt?: boolean;
      fromTurnIndex?: number;
      toTurnIndex?: number;
    }) => {
      const start = Date.now();
      try {
        const result = await sessionStore.getConversation({
          sessionId: options.sessionId,
          cwd: options.cwd,
          toolDetail: options.toolDetail,
          lastN: options.lastN,
          beforeLine: options.beforeLine,
          includeSystemPrompt: options.includeSystemPrompt,
          fromTurnIndex: options.fromTurnIndex,
          toTurnIndex: options.toTurnIndex,
        });

        if (!result) {
          return wrapError('SESSION_NOT_FOUND', `Session not found: ${options.sessionId}`, start);
        }

        // Get session file info for sessionInfo
        const sessionPath = sessionStore.getSessionPath(options.sessionId, options.cwd);
        let sessionInfo: {
          sessionId: string;
          projectPath: string;
          createdAt: string;
          lastModified: string;
        } | undefined;

        try {
          const fs = await import('fs');
          const path = await import('path');
          const stats = fs.statSync(sessionPath);
          // Extract project path from session path (e.g., /home/user/.claude/projects/-home-user-myproject/session.jsonl)
          const projectDir = path.dirname(sessionPath);
          const projectKey = path.basename(projectDir); // e.g., -home-user-myproject
          const projectPath = options.cwd || decodePath(projectKey);
          sessionInfo = {
            sessionId: options.sessionId,
            projectPath,
            createdAt: stats.birthtime.toISOString(),
            lastModified: stats.mtime.toISOString(),
          };
        } catch {
          // Ignore file stat errors
        }

        return wrapResponse({
          sessionId: result.sessionId,
          totalMessages: result.totalMessages,
          returnedMessages: result.returnedMessages,
          lastLineIndex: result.lastLineIndex,
          numTurns: result.numTurns,
          messages: result.messages,
          systemPrompt: result.systemPrompt,
          model: result.model,
          totalCostUsd: result.totalCostUsd,
          todos: result.todos,
          tasks: result.tasks,
          thinkingBlocks: result.thinkingBlocks,
          teamName: result.teamName,
          allTeams: result.allTeams,
          teamOperations: result.teamOperations,
          teamMessages: result.teamMessages,
          sessionInfo,
        }, start);
      } catch (e) {
        return wrapError('CONVERSATION_READ_ERROR', String(e), start);
      }
    },

    getLastMessages: async (sessionId: string, count: number, options?: {
      cwd?: string;
      toolDetail?: 'none' | 'summary' | 'full';
    }) => {
      const start = Date.now();
      try {
        const result = await sessionStore.getLastMessages(sessionId, count, {
          cwd: options?.cwd,
          toolDetail: options?.toolDetail,
        });

        if (!result) {
          return wrapError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, start);
        }

        // Get session file info for sessionInfo
        const sessionPath = sessionStore.getSessionPath(sessionId, options?.cwd);
        let sessionInfo: {
          sessionId: string;
          projectPath: string;
          createdAt: string;
          lastModified: string;
        } | undefined;

        try {
          const fs = await import('fs');
          const path = await import('path');
          const stats = fs.statSync(sessionPath);
          // Extract project path from session path
          const projectDir = path.dirname(sessionPath);
          const projectKey = path.basename(projectDir);
          const projectPath = options?.cwd || decodePath(projectKey);
          sessionInfo = {
            sessionId,
            projectPath,
            createdAt: stats.birthtime.toISOString(),
            lastModified: stats.mtime.toISOString(),
          };
        } catch {
          // Ignore file stat errors
        }

        return wrapResponse({
          sessionId: result.sessionId,
          totalMessages: result.totalMessages,
          returnedMessages: result.returnedMessages,
          lastLineIndex: result.lastLineIndex,
          numTurns: result.numTurns,
          messages: result.messages,
          systemPrompt: result.systemPrompt,
          model: result.model,
          totalCostUsd: result.totalCostUsd,
          todos: result.todos,
          tasks: result.tasks,
          thinkingBlocks: result.thinkingBlocks,
          teamName: result.teamName,
          allTeams: result.allTeams,
          teamOperations: result.teamOperations,
          teamMessages: result.teamMessages,
          sessionInfo,
        }, start);
      } catch (e) {
        return wrapError('CONVERSATION_READ_ERROR', String(e), start);
      }
    },

    getCompactMessages: async (sessionId: string, cwd?: string) => {
      const start = Date.now();
      try {
        const compactMessages = await sessionStore.getCompactMessages(sessionId, { cwd });

        if (compactMessages === null) {
          return wrapError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, start);
        }

        return wrapResponse({
          sessionId,
          compactMessages,
          total: compactMessages.length,
        }, start);
      } catch (e) {
        return wrapError('COMPACT_MESSAGES_ERROR', String(e), start);
      }
    },

    getMessagesFromPosition: async (sessionId: string, fromLineIndex: number, options?: {
      cwd?: string;
      includeRawMessages?: boolean;
      limit?: number;
    }) => {
      const start = Date.now();
      try {
        const sessionData = await sessionStore.getMessagesFromPosition(sessionId, fromLineIndex, {
          cwd: options?.cwd,
          includeRawMessages: options?.includeRawMessages,
          limit: options?.limit,
        });

        if (!sessionData) {
          return wrapError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, start);
        }

        return wrapResponse({
          ...sessionData,
          sessionId,
          fromLineIndex,
        }, start);
      } catch (e) {
        return wrapError('SESSION_READ_ERROR', String(e), start);
      }
    },

    checkSessionUpdate: async (sessionId: string, cwd?: string) => {
      const start = Date.now();
      try {
        const result = sessionStore.checkSessionUpdate(sessionId, { cwd });

        if (!result) {
          return wrapError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, start);
        }

        return wrapResponse({
          sessionId,
          ...result,
        }, start);
      } catch (e) {
        return wrapError('SESSION_CHECK_ERROR', String(e), start);
      }
    },

    batchCheckSessions: async (request: BatchCheckRequest) => {
      const start = Date.now();
      try {
        const result = sessionStore.batchCheckSessionUpdate(
          request.sessions || [],
          request.listCheck,
        );
        return wrapResponse<BatchCheckResponse>(result, start);
      } catch (e) {
        return wrapError('BATCH_CHECK_ERROR', String(e), start);
      }
    },

    // ========================================================================
    // Subagent API
    // ========================================================================

    getSessionSubagents: async (sessionId: string, cwd?: string) => {
      const start = Date.now();
      try {
        const result = await sessionStore.getSessionSubagents(sessionId, cwd);

        const sessions = result.sessions.map(s => ({
          ...s,
          lastActivityAt: s.lastActivityAt?.toISOString(),
        }));

        return wrapResponse({
          sessionId,
          invocations: result.invocations,
          sessions,
          totalInvocations: result.invocations.length,
          totalSessions: result.sessions.length,
        }, start);
      } catch (e) {
        return wrapError('SUBAGENT_READ_ERROR', String(e), start);
      }
    },

    getSubagentSession: async (sessionId: string, agentId: string, cwd?: string) => {
      const start = Date.now();
      try {
        const subagentData = await sessionStore.readSubagentSession(agentId, cwd);

        if (!subagentData) {
          return wrapError('SUBAGENT_NOT_FOUND', `Subagent not found: ${agentId}`, start);
        }

        return wrapResponse({
          ...subagentData,
          lastActivityAt: subagentData.lastActivityAt?.toISOString(),
        }, start);
      } catch (e) {
        return wrapError('SUBAGENT_READ_ERROR', String(e), start);
      }
    },

    listSubagentFiles: async (sessionId?: string, cwd?: string) => {
      const start = Date.now();
      try {
        const files = sessionStore.listSubagentFiles(sessionId || '', cwd);

        const filesResponse = files.map(f => ({
          ...f,
          lastModified: f.lastModified.toISOString(),
        }));

        return wrapResponse({
          files: filesResponse,
          total: files.length,
        }, start);
      } catch (e) {
        return wrapError('SUBAGENT_LIST_ERROR', String(e), start);
      }
    },

    // ========================================================================
    // Session Cache API
    // ========================================================================

    getCacheStats: async () => {
      const start = Date.now();
      try {
        const { getSessionCache } = await import('../session-cache');
        const cache = getSessionCache();
        const watcherStats = cache.getCacheStats();
        const diskStats = cache.getStats();

        return wrapResponse({
          ...watcherStats,
          diskCacheCount: diskStats.diskCacheCount,
          diskCacheSize: diskStats.diskCacheSize,
        }, start);
      } catch (e) {
        return wrapError('CACHE_STATS_ERROR', String(e), start);
      }
    },

    warmProjectCache: async (projectPath: string) => {
      const start = Date.now();
      try {
        const { getSessionCache } = await import('../session-cache');
        const cache = getSessionCache();
        const result = await cache.warmProjectCache(projectPath);
        const watcherStats = cache.getCacheStats();
        const diskStats = cache.getStats();

        return wrapResponse({
          projectPath,
          ...result,
          stats: {
            ...watcherStats,
            diskCacheCount: diskStats.diskCacheCount,
            diskCacheSize: diskStats.diskCacheSize,
          },
        }, start);
      } catch (e) {
        return wrapError('CACHE_WARM_ERROR', String(e), start);
      }
    },

    clearCache: async (sessionPath?: string) => {
      const start = Date.now();
      try {
        const { getSessionCache } = await import('../session-cache');
        const cache = getSessionCache();

        if (sessionPath) {
          cache.clearCache(sessionPath);
        } else {
          cache.clearAllCaches();
        }

        const watcherStats = cache.getCacheStats();
        const diskStats = cache.getStats();

        return wrapResponse({
          message: sessionPath ? `Cache cleared for ${sessionPath}` : 'All caches cleared',
          stats: {
            ...watcherStats,
            diskCacheCount: diskStats.diskCacheCount,
            diskCacheSize: diskStats.diskCacheSize,
          },
        }, start);
      } catch (e) {
        return wrapError('CACHE_CLEAR_ERROR', String(e), start);
      }
    },

    startCacheWatcher: async (projectPaths?: string[]) => {
      const start = Date.now();
      try {
        const { getSessionCache } = await import('../session-cache');
        const cache = getSessionCache();
        cache.startWatching(projectPaths);

        const watcherStats = cache.getCacheStats();
        const diskStats = cache.getStats();

        return wrapResponse({
          message: 'Cache watcher started',
          stats: {
            ...watcherStats,
            diskCacheCount: diskStats.diskCacheCount,
            diskCacheSize: diskStats.diskCacheSize,
          },
        }, start);
      } catch (e) {
        return wrapError('CACHE_WATCHER_ERROR', String(e), start);
      }
    },

    stopCacheWatcher: async () => {
      const start = Date.now();
      try {
        const { getSessionCache } = await import('../session-cache');
        const cache = getSessionCache();
        cache.stopWatching();

        const watcherStats = cache.getCacheStats();
        const diskStats = cache.getStats();

        return wrapResponse({
          message: 'Cache watcher stopped',
          stats: {
            ...watcherStats,
            diskCacheCount: diskStats.diskCacheCount,
            diskCacheSize: diskStats.diskCacheSize,
          },
        }, start);
      } catch (e) {
        return wrapError('CACHE_WATCHER_ERROR', String(e), start);
      }
    },

    startBackgroundWarming: async (options?: {
      concurrency?: number;
      batchSize?: number;
      delayBetweenBatches?: number;
    }) => {
      const start = Date.now();
      try {
        const { getSessionCache } = await import('../session-cache');
        const cache = getSessionCache();
        cache.startBackgroundWarming(options);

        const watcherStats = cache.getCacheStats();
        const diskStats = cache.getStats();

        return wrapResponse({
          message: 'Background warming started',
          stats: {
            ...watcherStats,
            diskCacheCount: diskStats.diskCacheCount,
            diskCacheSize: diskStats.diskCacheSize,
          },
        }, start);
      } catch (e) {
        return wrapError('BACKGROUND_WARMING_ERROR', String(e), start);
      }
    },

    stopBackgroundWarming: async () => {
      const start = Date.now();
      try {
        const { getSessionCache } = await import('../session-cache');
        const cache = getSessionCache();
        cache.stopBackgroundWarming();

        const watcherStats = cache.getCacheStats();
        const diskStats = cache.getStats();

        return wrapResponse({
          message: 'Background warming stopped',
          stats: {
            ...watcherStats,
            diskCacheCount: diskStats.diskCacheCount,
            diskCacheSize: diskStats.diskCacheSize,
          },
        }, start);
      } catch (e) {
        return wrapError('BACKGROUND_WARMING_ERROR', String(e), start);
      }
    },
  };
}
