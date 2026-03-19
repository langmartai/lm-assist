/**
 * Skills Routes
 *
 * REST API for skill analytics, inventory, and session-level skill data.
 *
 * Endpoints:
 *   GET    /skills                                  # List installed skills with usage stats
 *   GET    /skills/analytics                        # Aggregated analytics
 *   GET    /skills/analytics/chains                 # Skill chain detection
 *   GET    /skills/detail/:skillName                # Detail for one skill (paginated sessions)
 *   GET    /sessions/:id/skills                     # Skill invocations for a session
 *   GET    /sessions/:id/skills/:index/trace        # Deep trace for Nth skill invocation
 *   POST   /skills/reindex                          # Force rebuild skill index
 *   POST   /skills/refresh-inventory                # Rescan plugin cache
 */

import type { RouteHandler, RouteContext } from '../index';
import { getSkillIndex } from '../../skill-index';
import { getSessionCache } from '../../session-cache';
import { getSessionFilePath } from '../../utils/path-utils';

export function createSkillRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // ========================================================================
    // Skills List & Analytics (register BEFORE detail to avoid collision)
    // ========================================================================

    // GET /skills - List all installed skills with usage stats
    {
      method: 'GET',
      pattern: /^\/skills$/,
      handler: async (req) => {
        const skillIndex = getSkillIndex();
        const installed = skillIndex.getInstalledSkills();
        const entries = skillIndex.getAllEntries();

        // Build lookup from usage entries keyed by skillName
        const usageMap = new Map(entries.map(e => [e.skillName, e]));

        const skills = installed.map(skill => {
          const usage = usageMap.get(skill.skillName);

          // directInvocations: total minus subagent-session invocations
          let directInvocations = 0;
          if (usage) {
            directInvocations = usage.sessions
              .filter(s => !s.isSubagentSession)
              .length;
          }

          return {
            skillName: skill.skillName,
            pluginName: skill.pluginName,
            shortName: skill.shortName,
            description: skill.description,
            pluginVersion: skill.pluginVersion,
            installPath: skill.installPath,
            totalInvocations: usage?.totalInvocations || 0,
            directInvocations,
            successCount: usage?.successCount || 0,
            failCount: usage?.failCount || 0,
            lastUsed: usage?.lastUsed || null,
            firstUsed: usage?.firstUsed || null,
          };
        });

        // Also include skills with usage but not currently installed
        for (const entry of entries) {
          if (!installed.find(s => s.skillName === entry.skillName)) {
            const directInvocations = entry.sessions
              .filter(s => !s.isSubagentSession)
              .length;

            skills.push({
              skillName: entry.skillName,
              pluginName: entry.pluginName,
              shortName: entry.shortName,
              description: '',
              pluginVersion: '',
              installPath: '',
              totalInvocations: entry.totalInvocations,
              directInvocations,
              successCount: entry.successCount,
              failCount: entry.failCount,
              lastUsed: entry.lastUsed || null,
              firstUsed: entry.firstUsed || null,
            });
          }
        }

        // Sort by totalInvocations descending
        skills.sort((a, b) => b.totalInvocations - a.totalInvocations);

        return { success: true, data: { skills, total: skills.length } };
      },
    },

    // GET /skills/analytics - Aggregated analytics
    {
      method: 'GET',
      pattern: /^\/skills\/analytics$/,
      handler: async (req) => {
        const skillIndex = getSkillIndex();
        const entries = skillIndex.getAllEntries();

        // Top 10 by totalInvocations
        const sorted = [...entries].sort((a, b) => b.totalInvocations - a.totalInvocations);
        const top10 = sorted.slice(0, 10).map(e => ({
          skillName: e.skillName,
          shortName: e.shortName,
          totalInvocations: e.totalInvocations,
          successCount: e.successCount,
          failCount: e.failCount,
        }));

        // By-plugin breakdown
        const pluginMap = new Map<string, { totalInvocations: number; skillCount: number; successCount: number; failCount: number }>();
        for (const entry of entries) {
          const existing = pluginMap.get(entry.pluginName) || { totalInvocations: 0, skillCount: 0, successCount: 0, failCount: 0 };
          existing.totalInvocations += entry.totalInvocations;
          existing.skillCount++;
          existing.successCount += entry.successCount;
          existing.failCount += entry.failCount;
          pluginMap.set(entry.pluginName, existing);
        }
        const byPlugin = Array.from(pluginMap.entries()).map(([pluginName, stats]) => ({
          pluginName,
          ...stats,
        }));

        // Overall success rate
        const totalSuccess = entries.reduce((sum, e) => sum + e.successCount, 0);
        const totalFail = entries.reduce((sum, e) => sum + e.failCount, 0);
        const totalInvocations = entries.reduce((sum, e) => sum + e.totalInvocations, 0);
        const successRate = totalInvocations > 0 ? totalSuccess / (totalSuccess + totalFail) : 0;

        return {
          success: true,
          data: {
            top10,
            byPlugin,
            overall: {
              totalSkills: entries.length,
              totalInvocations,
              successCount: totalSuccess,
              failCount: totalFail,
              successRate: Math.round(successRate * 10000) / 10000,
            },
          },
        };
      },
    },

    // GET /skills/analytics/chains - Skill chain detection
    {
      method: 'GET',
      pattern: /^\/skills\/analytics\/chains$/,
      handler: async (req) => {
        const skillIndex = getSkillIndex();
        const chains = skillIndex.detectChains();
        return { success: true, data: { chains } };
      },
    },

    // GET /skills/detail/:skillName - Detail for one skill with paginated session list
    {
      method: 'GET',
      pattern: /^\/skills\/detail\/(?<skillName>.+)$/,
      handler: async (req) => {
        const skillName = decodeURIComponent(req.params.skillName);
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
        const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;

        const skillIndex = getSkillIndex();
        const entry = skillIndex.getSkillEntry(skillName);

        if (!entry) {
          return { success: false, error: { code: 'NOT_FOUND', message: `Skill '${skillName}' not found in index` } };
        }

        // Find matching installed skill for metadata
        const installed = skillIndex.getInstalledSkills().find(s => s.skillName === skillName);

        // Paginate sessions (sorted by timestamp descending)
        const sortedSessions = [...entry.sessions].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        const paginatedSessions = sortedSessions.slice(offset, offset + limit);

        // Enrich paginated sessions with rich info from cache
        const cache = getSessionCache();
        const enrichedSessions = paginatedSessions.map(sess => {
          let lastMessage: string | undefined;
          let model: string | undefined;
          let totalCostUsd: number | undefined;
          let numTurns: number | undefined;
          let userPromptCount: number | undefined;
          let agentCount: number | undefined;
          let size: number | undefined;
          try {
            const filePath = getSessionFilePath(sess.project, sess.sessionId);
            const cacheData = cache.getSessionDataSync(filePath);
            if (cacheData) {
              if (cacheData.userPrompts.length > 0) {
                const lastPrompt = cacheData.userPrompts[cacheData.userPrompts.length - 1];
                const text = lastPrompt.text || '';
                lastMessage = text.length > 100 ? text.slice(0, 100) + '...' : text || undefined;
              }
              model = cacheData.model || undefined;
              totalCostUsd = cacheData.totalCostUsd || undefined;
              numTurns = cacheData.numTurns || undefined;
              userPromptCount = cacheData.userPrompts.length || undefined;
              agentCount = cacheData.subagents.length || undefined;
              size = cacheData.fileSize || undefined;
            }
          } catch {
            // Ignore cache lookup failures
          }
          return { ...sess, lastMessage, model, totalCostUsd, numTurns, userPromptCount, agentCount, size };
        });

        return {
          success: true,
          data: {
            skillName: entry.skillName,
            pluginName: entry.pluginName,
            shortName: entry.shortName,
            description: installed?.description || '',
            pluginVersion: installed?.pluginVersion || '',
            installPath: installed?.installPath || '',
            totalInvocations: entry.totalInvocations,
            successCount: entry.successCount,
            failCount: entry.failCount,
            lastUsed: entry.lastUsed,
            firstUsed: entry.firstUsed,
            sessions: enrichedSessions,
            totalSessions: entry.sessions.length,
            limit,
            offset,
            hasMore: offset + limit < entry.sessions.length,
          },
        };
      },
    },

    // ========================================================================
    // Session-level Skill Endpoints
    // ========================================================================

    // GET /sessions/:id/skills - Skill invocations for a session
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/skills$/,
      handler: async (req) => {
        const sessionId = req.params.sessionId;
        const cache = getSessionCache();

        // Find session across ALL cached sessions (including subagent sessions)
        let matchData: any = null;
        for (const { key: filePath, value: cacheData } of cache.allSessionsIncludingSubagents()) {
          const basename = require('path').basename(filePath, '.jsonl');
          const isAgent = basename.startsWith('agent-');
          const agentId = isAgent ? basename.slice(6) : null;
          // Match by: regular sessionId OR basename (without .jsonl) OR agentId
          if (cacheData.sessionId === sessionId || basename === sessionId || agentId === sessionId) {
            matchData = cacheData;
            break;
          }
        }

        if (!matchData) {
          return { success: false, error: { code: 'NOT_FOUND', message: `Session '${sessionId}' not found in cache` } };
        }

        return {
          success: true,
          data: {
            sessionId,
            skillInvocations: matchData.skillInvocations || [],
            total: (matchData.skillInvocations || []).length,
          },
        };
      },
    },

    // GET /sessions/:id/commands - Command invocations (slash commands) for a session
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/commands$/,
      handler: async (req) => {
        const sessionId = req.params.sessionId;
        const cache = getSessionCache();

        // Find session across ALL cached sessions (including subagent sessions)
        let matchData: any = null;
        for (const { key: filePath, value: cacheData } of cache.allSessionsIncludingSubagents()) {
          const basename = require('path').basename(filePath, '.jsonl');
          const isAgent = basename.startsWith('agent-');
          const agentId = isAgent ? basename.slice(6) : null;
          // Match by: regular sessionId OR basename (without .jsonl) OR agentId
          if (cacheData.sessionId === sessionId || basename === sessionId || agentId === sessionId) {
            matchData = cacheData;
            break;
          }
        }

        if (!matchData) {
          return { success: false, error: { code: 'NOT_FOUND', message: `Session '${sessionId}' not found in cache` } };
        }

        return {
          success: true,
          data: {
            sessionId,
            commandInvocations: matchData.commandInvocations || [],
            total: (matchData.commandInvocations || []).length,
          },
        };
      },
    },

    // GET /sessions/:id/skills/:index/trace - Deep trace for Nth skill invocation
    {
      method: 'GET',
      pattern: /^\/sessions\/(?<sessionId>[^/]+)\/skills\/(?<index>\d+)\/trace$/,
      handler: async (req) => {
        const sessionId = req.params.sessionId;
        const index = parseInt(req.params.index, 10);
        const maxDepth = req.query.maxDepth ? parseInt(req.query.maxDepth, 10) : 5;

        const cache = getSessionCache();

        // Find session across ALL cached sessions (including subagent sessions)
        let matchData: any = null;
        let matchFilePath = '';
        for (const { key: filePath, value: cacheData } of cache.allSessionsIncludingSubagents()) {
          const basename = require('path').basename(filePath, '.jsonl');
          const isAgent = basename.startsWith('agent-');
          const agentId = isAgent ? basename.slice(6) : null;
          // Match by: regular sessionId OR basename (without .jsonl) OR agentId
          if (cacheData.sessionId === sessionId || basename === sessionId || agentId === sessionId) {
            matchData = cacheData;
            matchFilePath = filePath;
            break;
          }
        }

        if (!matchData) {
          return { success: false, error: { code: 'NOT_FOUND', message: `Session '${sessionId}' not found in cache` } };
        }

        const skills = matchData.skillInvocations || [];
        if (index < 0 || index >= skills.length) {
          return {
            success: false,
            error: { code: 'OUT_OF_RANGE', message: `Skill index ${index} out of range (0-${skills.length - 1})` },
          };
        }

        const skill = skills[index];
        const project = matchData.cwd || '';

        // Build subagent path resolver using the session's project context
        // Key by agentId extracted from filename (agent-<agentId>.jsonl), not by sessionId
        const subagentSessions = project
          ? cache.getSubagentSessionsFromCache(project, sessionId)
          : [];
        const subagentMap = new Map(
          subagentSessions.map(s => {
            const basename = require('path').basename(s.filePath, '.jsonl');
            const agentId = basename.startsWith('agent-') ? basename.slice(6) : basename;
            return [agentId, s.filePath];
          })
        );

        const findSubagentPath = (agentId: string): string | null => {
          return subagentMap.get(agentId) || null;
        };

        const getSessionData = async (sessionPath: string) => {
          return cache.getSessionDataSync(sessionPath);
        };

        const skillIndex = getSkillIndex();
        const trace = await skillIndex.resolveTrace(
          sessionId,
          skill,
          project,
          getSessionData,
          findSubagentPath,
          0,
          maxDepth
        );

        return { success: true, data: { trace } };
      },
    },

    // ========================================================================
    // Skill Index Management
    // ========================================================================

    // POST /skills/reindex - Force rebuild skill index
    {
      method: 'POST',
      pattern: /^\/skills\/reindex$/,
      handler: async (req) => {
        const cache = getSessionCache();
        const skillIndex = getSkillIndex();

        // Gather all session paths from LMDB cache
        const allSessions = cache.getAllSessionsFromCache();
        const sessionPaths = allSessions.map(s => s.filePath);

        const result = await skillIndex.reindex(
          (sessionPath: string) => cache.getSessionDataSync(sessionPath),
          sessionPaths
        );

        return {
          success: true,
          data: {
            message: 'Skill index rebuilt',
            indexed: result.indexed,
            skills: result.skills,
          },
        };
      },
    },

    // POST /skills/refresh-inventory - Rescan plugin cache for installed skills
    {
      method: 'POST',
      pattern: /^\/skills\/refresh-inventory$/,
      handler: async (req) => {
        const skillIndex = getSkillIndex();
        skillIndex.refreshInventory();
        const installed = skillIndex.getInstalledSkills();

        return {
          success: true,
          data: {
            message: 'Skill inventory refreshed',
            installedCount: installed.length,
            skills: installed.map(s => ({
              skillName: s.skillName,
              pluginName: s.pluginName,
              shortName: s.shortName,
              description: s.description,
            })),
          },
        };
      },
    },
  ];
}
