/**
 * search tool — Unified search across knowledge, milestones, architecture, and file history
 *
 * Replaces: search, files_history, recent_activity, knowledge_list,
 *           project_architecture listing
 *
 * Auto-detects query type:
 *   /path/to/file or .ts/.tsx → file history search
 *   K\d+ or K\d+.\d+          → knowledge ID lookup
 *   UUID pattern               → session ID lookup
 *   sessionId:index            → milestone ID lookup
 *   Otherwise                  → vector semantic search + keyword fallback
 */

import { getVectorStore } from '../../vector/vector-store';
import { getSessionCache } from '../../session-cache';
import { getMilestoneStore } from '../../milestone/store';
import { getKnowledgeStore } from '../../knowledge/store';
import { compositeScore, type ScoredResult } from '../../search/composite-scorer';
import { tokenize, scoreSession, getProjectPathForSession } from '../../search/text-scorer';
import { isFileQuery } from '../../search/file-matcher';
import { getProjectArchitectureData } from './project-architecture';

// ─── Tool Definition ──────────────────────────────────────────────────

export const searchToolDef = {
  name: 'search',
  description: `Unified search across knowledge and file history. Auto-detects query type: file paths, IDs (K001, sessionId, sessionId:index), or natural language. Params: query, scope (24h|3d|7d|30d|all), project, type (knowledge|all), limit, offset`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Natural language, keywords, file paths, or IDs (K001, K001.2, sessionId, sessionId:index)',
      },
      scope: {
        type: 'string',
        enum: ['24h', '3d', '7d', '30d', 'all'],
        description: 'Time scope for search (default: 7d)',
      },
      project: {
        type: 'string',
        description: 'Filter to a specific project path',
      },
      type: {
        type: 'string',
        enum: ['knowledge', 'all'],
        description: 'Result type filter (default: all)',
      },
      limit: {
        type: 'number',
        description: 'Results per page (default: 5, max: 20)',
      },
      offset: {
        type: 'number',
        description: 'Pagination offset (default: 0)',
      },
    },
    required: ['query'],
  },
};

/** Full description used when experiment features (milestones/architecture) are enabled */
export const searchToolDefExperiment = {
  ...searchToolDef,
  description: `Unified search across knowledge, milestones, architecture, and file history. Auto-detects query type: file paths, IDs (K001, sessionId, sessionId:index), or natural language. Params: query, scope (24h|3d|7d|30d|all), project, type (knowledge|milestone|architecture|all), limit, offset`,
  inputSchema: {
    ...searchToolDef.inputSchema,
    properties: {
      ...searchToolDef.inputSchema.properties,
      type: {
        type: 'string',
        enum: ['knowledge', 'milestone', 'architecture', 'all'],
        description: 'Result type filter (default: all)',
      },
    },
  },
};

// ─── Scope filtering ──────────────────────────────────────────────────

type Scope = '24h' | '3d' | '7d' | '30d' | 'all';

const SCOPE_MS: Record<Scope, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  'all': Infinity,
};

function isWithinScope(timestamp: string | undefined, scope: Scope): boolean {
  if (scope === 'all') return true;
  if (!timestamp) return false;
  const ts = new Date(timestamp).getTime();
  if (isNaN(ts)) return false;
  return Date.now() - ts <= SCOPE_MS[scope];
}

// ─── Query Type Detection ──────────────────────────────────────────────────

type QueryType = 'file' | 'knowledge_id' | 'knowledge_part_id' | 'session_id' | 'milestone_id' | 'semantic';

function detectQueryType(query: string): QueryType {
  const trimmed = query.trim();

  // Knowledge part ID: K001.2
  if (/^K\d+\.\d+$/.test(trimmed)) return 'knowledge_part_id';

  // Knowledge doc ID: K001
  if (/^K\d+$/.test(trimmed)) return 'knowledge_id';

  // Milestone ID: hexId:number
  if (/^[0-9a-f-]{8,}:\d+$/i.test(trimmed)) return 'milestone_id';

  // Session ID: UUID-like
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return 'session_id';
  if (/^[0-9a-f-]{20,}$/i.test(trimmed)) return 'session_id';

  // File query: paths with slashes or file extensions
  if (isFileQuery(trimmed)) return 'file';

  return 'semantic';
}

// ─── Handler ──────────────────────────────────────────────────

export async function handleSearch(args: Record<string, unknown>): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const query = String(args.query || '');
  if (!query) {
    return { content: [{ type: 'text', text: 'Error: query is required' }] };
  }

  const rawScope = (args.scope as string) || '7d';
  const scope: Scope = rawScope in SCOPE_MS ? rawScope as Scope : '7d';
  const project = args.project as string | undefined;
  const typeFilter = (args.type as string) || 'all';
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
  const offset = Math.max(Number(args.offset) || 0, 0);

  // Architecture-only search
  if (typeFilter === 'architecture') {
    return handleArchitectureSearch(query, project);
  }

  // Detect query type (trim for ID matching)
  const queryType = detectQueryType(query);
  const trimmedQuery = query.trim();

  switch (queryType) {
    case 'knowledge_part_id':
    case 'knowledge_id':
      return handleIdLookup(trimmedQuery, 'knowledge');
    case 'session_id':
      return handleIdLookup(trimmedQuery, 'session');
    case 'milestone_id':
      return handleIdLookup(trimmedQuery, 'milestone');
    case 'file':
      return handleFileAndSemanticSearch(query, scope, project, typeFilter, limit, offset);
    default:
      return handleSemanticSearch(query, scope, project, typeFilter, limit, offset);
  }
}

// ─── ID Lookup (short pointer to detail) ──────────────────────────────────

function handleIdLookup(
  id: string,
  idType: 'knowledge' | 'session' | 'milestone',
): { content: Array<{ type: string; text: string }> } {
  const lines: string[] = [];

  if (idType === 'knowledge') {
    const store = getKnowledgeStore();
    const kId = id.includes('.') ? id.split('.')[0] : id;
    const knowledge = store.getKnowledge(kId);
    if (knowledge) {
      if (id.includes('.')) {
        const part = knowledge.parts.find(p => p.partId === id);
        lines.push(`Found: ${id}: ${knowledge.title} → ${part?.title || 'Unknown'} [${knowledge.type}]`);
      } else {
        lines.push(`Found: ${id}: ${knowledge.title} [${knowledge.type}] (${knowledge.parts.length} parts)`);
      }
    } else {
      lines.push(`Knowledge ${id} not found`);
    }
  } else if (idType === 'milestone') {
    const store = getMilestoneStore();
    const milestone = store.getMilestoneById(id);
    if (milestone) {
      lines.push(`Found: ${id}: ${milestone.title || 'Untitled'} [${milestone.type || 'unknown'}]`);
    } else {
      lines.push(`Milestone ${id} not found`);
    }
  } else {
    const cache = getSessionCache();
    const sessions = cache.getAllSessionsFromCache();
    const session = sessions.find(s => s.sessionId === id);
    if (session) {
      const cd = session.cacheData;
      lines.push(`Found session: ${id} (${cd.numTurns} turns, $${cd.totalCostUsd.toFixed(2)})`);
    } else {
      lines.push(`Session ${id} not found`);
    }
  }

  lines.push('');
  lines.push(`→ detail("${id}") for full content`);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─── Architecture Search ──────────────────────────────────────────────────

async function handleArchitectureSearch(
  query: string,
  project?: string,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const lines: string[] = [];

  try {
    const arch = await getProjectArchitectureData(project);
    if (!arch) {
      return { content: [{ type: 'text', text: 'No architecture data available. Run milestone indexing first.' }] };
    }

    const queryLower = query.toLowerCase();
    const isWildcard = query === '*' || query === '';

    // Filter components by query
    const matchingComponents = arch.components.filter(c => {
      if (isWildcard) return true;
      return c.directory.toLowerCase().includes(queryLower) ||
        c.purpose.toLowerCase().includes(queryLower) ||
        c.recentMilestones.some(m => m.toLowerCase().includes(queryLower));
    });

    if (matchingComponents.length === 0) {
      lines.push(`No architecture components matching "${query}"`);
    } else {
      lines.push(`Found ${matchingComponents.length} architecture component${matchingComponents.length !== 1 ? 's' : ''}`);
      lines.push('');

      for (let i = 0; i < matchingComponents.length; i++) {
        const c = matchingComponents[i];
        const componentId = c.directory.replace(/\//g, '-').replace(/^-|-$/g, '');
        lines.push(`${i + 1}. [architecture] arch:${componentId}: ${c.directory} [${c.temperature}]`);
        lines.push(`   ${c.purpose || 'No description'} (${c.fileCount} files, ${c.milestoneCount} milestones)`);
        lines.push(`   → detail("arch:${componentId}")`);
        lines.push('');
      }
    }
  } catch {
    lines.push('Architecture data not available');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─── Semantic Search (Vector + Text Fallback) ──────────────────────────────

async function handleSemanticSearch(
  query: string,
  scope: Scope,
  project: string | undefined,
  typeFilter: string,
  limit: number,
  offset: number,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const vectorStore = getVectorStore();
  const stats = await vectorStore.getStats();

  if (stats.isInitialized && stats.totalVectors > 0) {
    return handleHybridSearch(query, scope, project, typeFilter, limit, offset);
  }

  return handleTextSearch(query, scope, project, limit, offset);
}

// ─── Hybrid Search (Vector + FTS) ──────────────────────────────────────

async function handleHybridSearch(
  query: string,
  scope: Scope,
  project: string | undefined,
  typeFilter: string,
  limit: number,
  offset: number,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const vectorStore = getVectorStore();
  const milestoneStore = getMilestoneStore();

  // Build metadata filter for type-scoped search
  const metadataFilter = typeFilter !== 'all' ? { type: typeFilter } : undefined;

  // Search with extra results for filtering and pagination
  const fetchCount = (limit + offset) * 3;

  // Hybrid search: vector + FTS with RRF merge
  const rawResults = await vectorStore.hybridSearch(query, fetchCount, metadataFilter);

  // Filter by scope and project
  const filtered = rawResults
    .filter(r => isWithinScope(r.timestamp, scope))
    .filter(r => !project || r.projectPath === project);

  // Build ScoredResult[]
  const merged: ScoredResult[] = filtered.map(r => {
    let id: string;
    if (r.type === 'knowledge') {
      id = r.partId || r.knowledgeId || '';
    } else if (r.type === 'milestone') {
      id = `${r.sessionId}:${r.milestoneIndex}`;
    } else {
      id = r.sessionId;
    }
    return {
      type: r.type,
      id,
      sessionId: r.sessionId,
      score: r.score,
      finalScore: 0,
      timestamp: r.timestamp || '',
      phase: r.phase as 1 | 2 | undefined,
      projectPath: r.projectPath,
      knowledgeId: r.knowledgeId,
      partId: r.partId,
    };
  });

  // Apply composite scoring (also filters out session results when milestones exist)
  const ranked = compositeScore(merged, { currentProject: project });

  // Filter out orphaned results (vectors exist but source data was deleted)
  const knowledgeStore = getKnowledgeStore();
  const resolvable = ranked.filter(r => {
    if (r.type === 'knowledge') {
      const kId = (r.knowledgeId || r.id || '').split('.')[0];
      return kId ? !!knowledgeStore.getKnowledge(kId) : false;
    }
    if (r.type === 'milestone') {
      return !!milestoneStore.getMilestoneById(r.id);
    }
    return true;
  });

  // Content-match: for specific queries (>15 chars), boost existing results
  // AND inject knowledge entries whose text contains the exact query but
  // weren't found by Vectra/BM25 (e.g. rank #36 in BM25, outside fetch window).
  if (query.length > 15) {
    const qLower = query.toLowerCase().trim();
    const existingIds = new Set(resolvable.map(r => r.partId || r.id));
    let changed = false;

    // 1. Boost existing results that contain the query
    for (const r of resolvable) {
      if (r.type !== 'knowledge') continue;
      const kId = (r.knowledgeId || r.id || '').split('.')[0];
      const knowledge = knowledgeStore.getKnowledge(kId);
      if (!knowledge) continue;
      const part = r.partId ? knowledge.parts.find(p => p.partId === r.partId) : null;
      const haystack = [part?.title || '', part?.summary || '', part?.content || ''].join(' ').toLowerCase();
      if (haystack.includes(qLower)) {
        r.finalScore *= 2.0;
        changed = true;
      }
    }

    // 2. Supplementary: scan knowledge store for content matches not in results.
    //    ~5k parts, string.includes check is <5ms.
    //    Compute injectionScore AFTER boost loop so it reflects boosted max.
    const injectionScore = Math.max(...resolvable.map(r => r.finalScore), 0.05);
    const allKnowledge = knowledgeStore.getAllKnowledge();
    for (const k of allKnowledge) {
      if (!isWithinScope(k.sourceTimestamp || k.createdAt, scope)) continue;
      if (project && k.project !== project) continue;
      if (typeFilter !== 'all' && typeFilter !== 'knowledge') continue;
      for (const part of k.parts) {
        if (existingIds.has(part.partId)) continue;
        const haystack = [part.title, part.summary, part.content].join(' ').toLowerCase();
        if (haystack.includes(qLower)) {
          resolvable.push({
            type: 'knowledge',
            id: part.partId,
            sessionId: k.sourceSessionId || '',
            score: injectionScore,
            finalScore: injectionScore,
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

    if (changed) resolvable.sort((a, b) => {
      const diff = b.finalScore - a.finalScore;
      if (Math.abs(diff) > 0.0001) return diff;
      // Tiebreak by recency — newer entries first
      return new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime();
    });
  }

  // Apply pagination
  const totalMatches = resolvable.length;
  const pageResults = resolvable.slice(offset, offset + limit);

  // Format results
  return formatResults(pageResults, totalMatches, query, offset, limit, milestoneStore);
}

// ─── Text Search Fallback ──────────────────────────────────────────────────

async function handleTextSearch(
  query: string,
  scope: Scope,
  project: string | undefined,
  limit: number,
  offset: number,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const cache = getSessionCache();
  const milestoneStore = getMilestoneStore();
  const sessions = cache.getAllSessionsFromCache();

  const queryTokens = tokenize(query);
  const queryLower = query.toLowerCase();

  // Score sessions and extract milestone matches
  const milestoneResults: Array<{
    milestoneId: string;
    score: number;
    milestone: ReturnType<typeof milestoneStore.getMilestoneById>;
  }> = [];

  for (const { sessionId, filePath, cacheData } of sessions) {
    if (!isWithinScope(cacheData.lastTimestamp, scope)) continue;
    if (project) {
      const sessionProject = getProjectPathForSession(cacheData, filePath);
      if (sessionProject !== project) continue;
    }

    const { score } = scoreSession(cacheData, queryTokens, queryLower);
    if (score <= 0) continue;

    // Get milestones for this session
    const milestones = milestoneStore.getMilestones(sessionId);
    for (const m of milestones) {
      const titleMatch = m.title && m.title.toLowerCase().includes(queryLower) ? 2 : 0;
      const factMatch = m.facts?.some(f => f.toLowerCase().includes(queryLower)) ? 1 : 0;
      const mScore = score + titleMatch + factMatch;
      if (mScore > 0) {
        milestoneResults.push({
          milestoneId: m.id,
          score: mScore,
          milestone: m,
        });
      }
    }
  }

  milestoneResults.sort((a, b) => b.score - a.score);
  const totalMatches = milestoneResults.length;
  const pageResults = milestoneResults.slice(offset, offset + limit);

  if (pageResults.length === 0) {
    return { content: [{ type: 'text', text: `No results found for "${query}" (text search)` }] };
  }

  const lines: string[] = [];
  lines.push(`Found ${totalMatches} results (text search fallback, showing ${offset + 1}-${offset + pageResults.length})`);
  lines.push('');

  for (let i = 0; i < pageResults.length; i++) {
    const r = pageResults[i];
    const m = r.milestone;
    if (m) {
      lines.push(`${offset + i + 1}. [milestone] ${r.milestoneId}: ${m.title || 'Untitled'} [${m.type || 'unknown'}]`);
      if (m.description) {
        const desc = m.description.length > 100 ? m.description.slice(0, 100) + '...' : m.description;
        lines.push(`   ${desc}`);
      }
      lines.push(`   → detail("${r.milestoneId}")`);
    }
    lines.push('');
  }

  if (totalMatches > offset + limit) {
    lines.push(`More: search("${query}", offset=${offset + limit})`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─── File Search ──────────────────────────────────────────────────

async function handleFileSearch(
  query: string,
  scope: Scope,
  project: string | undefined,
  limit: number,
  offset: number,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const cache = getSessionCache();
  const milestoneStore = getMilestoneStore();
  const sessions = cache.getAllSessionsFromCache()
    .filter(s => isWithinScope(s.cacheData.lastTimestamp, scope))
    .filter(s => !project || s.cacheData.cwd === project);

  const queryPaths = query.split(/[,\s]+/).filter(p => p.length > 0);

  // Search through sessions for file matches with milestone context
  interface FileMatch {
    filePath: string;
    sessionId: string;
    action: string;
    turnIndex: number;
    timestamp?: string;
    milestoneId?: string;
    milestoneTitle?: string;
    milestoneType?: string;
  }

  const matches: FileMatch[] = [];

  for (const { sessionId, cacheData } of sessions) {
    let milestones: ReturnType<typeof milestoneStore.getMilestones> | null = null;

    for (const tu of cacheData.toolUses) {
      const fp = tu.input?.file_path || tu.input?.path;
      if (!fp) continue;

      // Check if any query path matches this file
      const matched = queryPaths.some(qp => fp.endsWith(qp) || fp.includes(qp));
      if (!matched) continue;

      let action = 'read';
      if (tu.name === 'Write') action = 'write';
      else if (tu.name === 'Edit') action = 'edit';

      // Find milestone context
      let milestoneId: string | undefined;
      let milestoneTitle: string | undefined;
      let milestoneType: string | undefined;
      if (!milestones) milestones = milestoneStore.getMilestones(sessionId);
      for (const m of milestones) {
        if (tu.turnIndex >= m.startTurn && tu.turnIndex <= m.endTurn && m.title) {
          milestoneId = m.id;
          milestoneTitle = m.title;
          milestoneType = m.type ?? undefined;
          break;
        }
      }

      const nearestPrompt = cacheData.userPrompts
        .filter(p => p.turnIndex <= tu.turnIndex)
        .pop();

      matches.push({
        filePath: fp,
        sessionId,
        action,
        turnIndex: tu.turnIndex,
        timestamp: nearestPrompt?.timestamp,
        milestoneId,
        milestoneTitle,
        milestoneType,
      });
    }
  }

  // Sort by timestamp descending
  matches.sort((a, b) => {
    if (!a.timestamp || !b.timestamp) return 0;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  // Deduplicate: one entry per session+action+filepath
  const seen = new Set<string>();
  const deduped = matches.filter(m => {
    const key = `${m.sessionId}:${m.action}:${m.filePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const totalMatches = deduped.length;
  const pageResults = deduped.slice(offset, offset + limit);

  if (pageResults.length === 0) {
    return { content: [{ type: 'text', text: `No file matches found for "${query}"` }] };
  }

  const lines: string[] = [];
  lines.push(`Found ${totalMatches} file match${totalMatches !== 1 ? 'es' : ''} (showing ${offset + 1}-${offset + pageResults.length})`);
  lines.push('');

  for (let i = 0; i < pageResults.length; i++) {
    const m = pageResults[i];
    if (m.milestoneId && m.milestoneTitle) {
      const typeTag = m.milestoneType ? ` [${m.milestoneType}]` : '';
      lines.push(`${offset + i + 1}. ${m.action.toUpperCase()} ${m.filePath}${typeTag}`);
      lines.push(`   "${m.milestoneTitle}"`);
      lines.push(`   → detail("${m.milestoneId}")`);
    } else {
      lines.push(`${offset + i + 1}. ${m.action.toUpperCase()} ${m.filePath}`);
      lines.push(`   Session: ${m.sessionId} | Turn ${m.turnIndex}`);
    }
    if (m.timestamp) {
      lines.push(`   ${m.timestamp}`);
    }
    lines.push('');
  }

  if (totalMatches > offset + limit) {
    lines.push(`More: search("${query}", offset=${offset + limit})`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─── Combined File + Semantic Search ──────────────────────────────────────

async function handleFileAndSemanticSearch(
  query: string,
  scope: Scope,
  project: string | undefined,
  typeFilter: string,
  limit: number,
  offset: number,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  // Run file history search AND semantic search in parallel
  const vectorStore = getVectorStore();
  const stats = await vectorStore.getStats();
  const hasVectra = stats.isInitialized && stats.totalVectors > 0;

  const [fileResult, semanticResult] = await Promise.all([
    handleFileSearch(query, scope, project, limit, offset),
    hasVectra
      ? handleHybridSearch(query, scope, project, typeFilter, limit, offset)
      : Promise.resolve(null),
  ]);

  // If no semantic results, return file results only
  if (!semanticResult) return fileResult;

  const fileText = fileResult.content[0]?.text || '';
  const semanticText = semanticResult.content[0]?.text || '';

  // If file search found nothing, return semantic only
  if (fileText.startsWith('No file matches')) return semanticResult;

  // Combine: file history first, then knowledge/milestone results
  const combined = [fileText, '', '--- Related knowledge & milestones ---', '', semanticText].join('\n');
  return { content: [{ type: 'text', text: combined }] };
}

// ─── Result Formatting ──────────────────────────────────────────────────

function formatResults(
  results: ScoredResult[],
  totalMatches: number,
  query: string,
  offset: number,
  limit: number,
  milestoneStore: ReturnType<typeof getMilestoneStore>,
): { content: Array<{ type: string; text: string }> } {
  const knowledgeStore = getKnowledgeStore();
  const lines: string[] = [];

  if (results.length === 0) {
    return { content: [{ type: 'text', text: `No results found for "${query}"` }] };
  }

  lines.push(`Found ${totalMatches} results (showing ${offset + 1}-${offset + results.length})`);
  lines.push('');

  for (let i = 0; i < results.length; i++) {
    const r = results[i];

    if (r.type === 'knowledge') {
      const kId = r.knowledgeId || r.id;
      const knowledge = knowledgeStore.getKnowledge(kId);

      if (knowledge && r.partId) {
        const part = knowledge.parts.find(p => p.partId === r.partId);
        lines.push(`${offset + i + 1}. [knowledge] ${r.partId}: ${knowledge.title} → ${part?.title || 'Unknown'} [${knowledge.type}]`);
        lines.push(`   ${part?.summary || ''}`);
        lines.push(`   → detail("${r.partId}")`);
      } else if (knowledge) {
        lines.push(`${offset + i + 1}. [knowledge] ${kId}: ${knowledge.title} [${knowledge.type}] (${knowledge.parts.length} parts)`);
        lines.push(`   → detail("${kId}")`);
      }
    } else if (r.type === 'milestone') {
      const milestone = milestoneStore.getMilestoneById(r.id);

      if (milestone) {
        lines.push(`${offset + i + 1}. [milestone] ${r.id}: ${milestone.title || 'Untitled'} [${milestone.type || 'unknown'}]`);
        if (milestone.description) {
          const desc = milestone.description.length > 100 ? milestone.description.slice(0, 100) + '...' : milestone.description;
          lines.push(`   ${desc}`);
        }
        lines.push(`   → detail("${r.id}")`);
      }
    } else {
      // Session results (should be rare with milestones taking precedence)
      lines.push(`${offset + i + 1}. [session] ${r.sessionId}`);
      lines.push(`   → detail("${r.sessionId}")`);
    }

    lines.push('');
  }

  if (totalMatches > offset + limit) {
    lines.push(`More: search("${query}", offset=${offset + limit})`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
