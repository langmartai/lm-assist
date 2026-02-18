/**
 * Context Routes
 *
 * Provides proactive context suggestions for Claude Code hook injection.
 * Called by the UserPromptSubmit hook to inject relevant context before
 * Claude processes a prompt.
 *
 * Endpoints:
 *   POST /context/suggest  # Get context suggestions for a prompt
 */

import type { RouteHandler, RouteContext } from '../index';
import type { ScoredResult } from '../../search/composite-scorer';

export function createContextRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // POST /context/suggest — Get relevant context for a prompt
    {
      method: 'POST',
      pattern: /^\/context\/suggest$/,
      handler: async (req) => {
        const { prompt, sessionId, project } = req.body || {};

        if (!prompt || typeof prompt !== 'string') {
          return { success: false, error: 'prompt is required' };
        }

        try {
          const result = await suggestContext(prompt, sessionId, project);
          return { success: true, ...result };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: msg, context: '', tokens: 0, sources: [] };
        }
      },
    },
  ];
}

// ─── Context Suggestion Logic ──────────────────────────────────────────────────

interface ContextSuggestion {
  context: string;
  tokens: number;
  sources: string[];
}

async function suggestContext(
  prompt: string,
  _sessionId?: string,
  _project?: string,
): Promise<ContextSuggestion> {
  // Read config to check which sources are enabled
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');
  const configFile = path.join(os.homedir(), '.claude-code-config.json');
  let includeKnowledge = true;
  let includeMilestones = false;
  let knowledgeCount = 3;
  let milestoneCount = 2;
  try {
    const raw = fs.readFileSync(configFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.contextInjectKnowledge === 'boolean') includeKnowledge = parsed.contextInjectKnowledge;
    if (typeof parsed.contextInjectMilestones === 'boolean') includeMilestones = parsed.contextInjectMilestones;
    if (typeof parsed.contextInjectKnowledgeCount === 'number' && parsed.contextInjectKnowledgeCount >= 0) knowledgeCount = parsed.contextInjectKnowledgeCount;
    if (typeof parsed.contextInjectMilestoneCount === 'number' && parsed.contextInjectMilestoneCount >= 0) milestoneCount = parsed.contextInjectMilestoneCount;
  } catch { /* use defaults */ }

  // If nothing enabled, return empty
  if (!includeKnowledge && !includeMilestones) {
    return { context: '', tokens: 0, sources: [] };
  }

  // Lazy-import to avoid startup dependency on vector/knowledge/milestone stores
  const { getVectorStore } = await import('../../vector/vector-store');
  const { getKnowledgeStore } = await import('../../knowledge/store');
  const { getMilestoneStore } = await import('../../milestone/store');

  const vectorStore = getVectorStore();

  // Initialize vector store (no-op if already initialized; loads index from disk)
  try {
    await vectorStore.init();
  } catch {
    return { context: '', tokens: 0, sources: [] };
  }

  const stats = await vectorStore.getStats();

  // If store has no vectors, return empty
  if (stats.totalVectors === 0) {
    return { context: '', tokens: 0, sources: [] };
  }

  const sections: string[] = [];
  const sources: string[] = [];

  // 1. Hybrid knowledge search: vector + FTS, RRF merge → top N (configurable)
  if (includeKnowledge && knowledgeCount > 0) try {
    const kFetch = Math.max(knowledgeCount * 2, 5);
    const hybridResults = await vectorStore.hybridSearch(prompt, kFetch, { type: 'knowledge' });

    // Convert to ScoredResult format for downstream processing
    const merged: ScoredResult[] = hybridResults.map(r => ({
      type: r.type as 'knowledge',
      id: r.partId || r.knowledgeId || '',
      sessionId: r.sessionId,
      score: r.score,
      finalScore: 0,
      timestamp: r.timestamp || '',
      knowledgeId: r.knowledgeId,
      partId: r.partId,
      projectPath: r.projectPath,
      phase: r.phase as 1 | 2 | undefined,
    }));

    // Filter out orphaned vectors (knowledge deleted but vectors remain)
    const knowledgeStore = getKnowledgeStore();
    const validKnowledge = merged
      .filter(r => {
        const kId = (r.knowledgeId || r.id || '').split('.')[0];
        return kId ? !!knowledgeStore.getKnowledge(kId) : false;
      });

    // Content-match: boost existing results AND inject missing content matches
    if (prompt.length > 15) {
      const qLower = prompt.toLowerCase().trim();
      const existingIds = new Set(validKnowledge.map(r => r.partId || r.id));
      let changed = false;

      // 1. Boost existing results that contain the query
      for (const r of validKnowledge) {
        const kId = (r.knowledgeId || r.id || '').split('.')[0];
        const knowledge = knowledgeStore.getKnowledge(kId);
        if (!knowledge) continue;
        const part = r.partId ? knowledge.parts.find(p => p.partId === r.partId) : null;
        const haystack = [part?.title || '', part?.summary || '', part?.content || ''].join(' ').toLowerCase();
        if (haystack.includes(qLower)) {
          r.score *= 2.0;
          changed = true;
        }
      }

      // 2. Scan knowledge store for content matches not in RRF pool.
      //    Compute injectionScore AFTER boost loop so it reflects boosted max.
      const injectionScore = Math.max(...validKnowledge.map(r => r.score), 0.03);
      const allKnowledge = knowledgeStore.getAllKnowledge();
      for (const k of allKnowledge) {
        for (const part of k.parts) {
          if (existingIds.has(part.partId)) continue;
          const haystack = [part.title, part.summary, part.content].join(' ').toLowerCase();
          if (haystack.includes(qLower)) {
            validKnowledge.push({
              type: 'knowledge' as const,
              id: part.partId,
              sessionId: k.sourceSessionId || '',
              score: injectionScore,
              finalScore: 0,
              timestamp: k.sourceTimestamp || k.createdAt || '',
              knowledgeId: k.id,
              partId: part.partId,
              projectPath: k.project,
            });
            existingIds.add(part.partId);
            changed = true;
          }
        }
      }

      if (changed) validKnowledge.sort((a, b) => {
        const diff = b.score - a.score;
        if (Math.abs(diff) > 0.0001) return diff;
        // Tiebreak by recency — newer entries first
        return new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime();
      });
    }

    const topKnowledge = validKnowledge.slice(0, knowledgeCount);

    if (topKnowledge.length > 0) {
      const knowledgeLines: string[] = [];

      for (const r of topKnowledge) {
        if (r.score <= 0) continue;
        const kId = r.knowledgeId || r.id;
        const partId = r.partId || '';
        const knowledge = kId ? knowledgeStore.getKnowledge(kId.split('.')[0] || kId) : null;

        if (knowledge && partId) {
          const part = knowledge.parts.find(p => p.partId === partId);
          if (part) {
            const timeAgo = formatTimeAgo(knowledge.sourceTimestamp || knowledge.createdAt);
            const summary = part.summary.length > 120 ? part.summary.slice(0, 120) + '...' : part.summary;
            knowledgeLines.push(`- [${partId}] (${timeAgo}) ${knowledge.title} → ${part.title}: ${summary}`);
            sources.push(partId);
          }
        } else if (knowledge) {
          const timeAgo = formatTimeAgo(knowledge.sourceTimestamp || knowledge.createdAt);
          knowledgeLines.push(`- [${kId}] (${timeAgo}) ${knowledge.title} [${knowledge.type}]`);
          sources.push(kId);
        }
      }

      if (knowledgeLines.length > 0) {
        sections.push('**Knowledge:**');
        sections.push(...knowledgeLines);
      }
    }
  } catch {
    // Non-fatal — continue without knowledge
  }

  // 2. Hybrid milestone search: vector + FTS, RRF merge → top N (configurable)
  if (includeMilestones && milestoneCount > 0) try {
    const mFetch = Math.max(milestoneCount * 2, 5);
    const hybridMilestones = await vectorStore.hybridSearch(prompt, mFetch, { type: 'milestone' });

    // Convert to ScoredResult format
    const milestoneScored: ScoredResult[] = hybridMilestones.map(r => ({
      type: r.type as 'milestone',
      id: `${r.sessionId}:${r.milestoneIndex}`,
      sessionId: r.sessionId,
      score: r.score,
      finalScore: 0,
      timestamp: r.timestamp || '',
      projectPath: r.projectPath,
      phase: r.phase as 1 | 2 | undefined,
    }));

    const topMilestones = milestoneScored.slice(0, milestoneCount);

    if (topMilestones.length > 0) {
      const milestoneStore = getMilestoneStore();
      const milestoneLines: string[] = [];

      for (const r of topMilestones) {
        if (r.score <= 0) continue;
        const milestoneId = r.id;
        const milestone = milestoneStore.getMilestoneById(milestoneId);

        if (milestone) {
          const rawTitle = milestone.title?.trim() || '';
          // For Phase 1 milestones (no LLM title), synthesize from first user prompt or files
          const displayTitle = (rawTitle && rawTitle.toLowerCase() !== 'untitled milestone')
            ? rawTitle
            : (() => {
                const firstPrompt = (milestone.userPrompts as string[] | undefined)
                  ?.find(p => p.trim().length > 15);
                if (firstPrompt) return firstPrompt.trim().slice(0, 80) + (firstPrompt.length > 80 ? '…' : '');
                const files = (milestone.filesModified as string[] | undefined)?.slice(0, 3)
                  .map((f: string) => f.split('/').pop()).filter(Boolean);
                if (files?.length) return 'Modified: ' + files.join(', ');
                return '';
              })();
          if (!displayTitle) continue;
          const phase1Label = !rawTitle ? ' ~p1' : '';
          const timeAgo = formatTimeAgo(milestone.endTimestamp || milestone.startTimestamp);
          milestoneLines.push(`- [${milestoneId}] ${timeAgo}${phase1Label}: ${displayTitle}`);
          sources.push(milestoneId);
        }
      }

      if (milestoneLines.length > 0) {
        sections.push('**Recent work:**');
        sections.push(...milestoneLines);
      }
    }
  } catch {
    // Non-fatal — continue without milestones
  }

  // 3. Build final context
  if (sections.length === 0) {
    return { context: '', tokens: 0, sources: [] };
  }

  const contextLines = [
    '## Relevant Context',
    '',
    ...sections,
    '',
    'Use the context above to inform your response. Knowledge entries (K###) contain verified facts extracted from past sessions.',
    'For deeper investigation, use MCP tools: search(query) to find more knowledge/milestones/architecture, detail(id) to expand any entry, feedback(id, type, content) to flag outdated or wrong context.',
  ];

  const context = contextLines.join('\n');

  // Rough token estimate: ~4 chars per token
  const tokens = Math.ceil(context.length / 4);

  return { context, tokens, sources };
}

// ─── Helpers ──────────────────────────────────────────────────

function formatTimeAgo(timestamp?: string): string {
  if (!timestamp) return 'unknown';
  const ts = new Date(timestamp).getTime();
  if (isNaN(ts)) return 'unknown';

  const diffMs = Date.now() - ts;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return `${Math.floor(diffDays / 7)}w ago`;
}
