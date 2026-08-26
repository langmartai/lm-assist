/**
 * search tool — find the user's past CODE SESSIONS.
 *
 * Auto-detects query type:
 *   /path/to/file or .ts/.tsx → file history + session search
 *   K\d+ or K\d+.\d+          → knowledge ID lookup (a pointer jump, not a search)
 *   UUID pattern               → session ID lookup
 *   Otherwise                  → bm25 over the indexed USER PROMPTS of every session
 *
 * Results are SESSIONS. Knowledge is served by data_search({dataset:"knowledge"}) and
 * search_memory; the vector/knowledge hybrid that used to run here has been removed.
 *
 * Every response states which path answered it. The text scan is a fallback only, and
 * says so along with why the index could not answer — an unranked pile presented as a
 * ranked result is the defect this tool is recovering from.
 */

import { getSessionCache } from '../../session-cache';
import { getKnowledgeStore } from '../../knowledge/store';
import { tokenizeSessionQuery, scoreSession, getProjectPathForSession } from '../../search/text-scorer';
import { isFileQuery } from '../../search/file-matcher';
import { getPromptIndex, type PromptSearchResult } from '../../search/prompt-index';
import { promptIndexProgress } from '../../search/prompt-index-service';
import { tokenizeFts } from '../../data/backends/fts-query';

// ─── Tool Definition (canonical source: definitions.ts) ─────────────

export { searchToolDef } from './definitions';

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

type QueryType = 'file' | 'knowledge_id' | 'knowledge_part_id' | 'session_id' | 'semantic';

function detectQueryType(query: string): QueryType {
  const trimmed = query.trim();

  // Knowledge part ID: K001.2
  if (/^K\d+\.\d+$/.test(trimmed)) return 'knowledge_part_id';

  // Knowledge doc ID: K001
  if (/^K\d+$/.test(trimmed)) return 'knowledge_id';

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
  const includeSynthetic = args.includeSynthetic === true;
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
  const offset = Math.max(Number(args.offset) || 0, 0);

  // Detect query type (trim for ID matching)
  const queryType = detectQueryType(query);
  const trimmedQuery = query.trim();

  switch (queryType) {
    case 'knowledge_part_id':
    case 'knowledge_id':
      return handleIdLookup(trimmedQuery, 'knowledge');
    case 'session_id':
      return handleIdLookup(trimmedQuery, 'session');
    case 'file':
      return handleFileAndSemanticSearch(query, scope, project, includeSynthetic, limit, offset);
    default:
      return handleSemanticSearch(query, scope, project, includeSynthetic, limit, offset);
  }
}

// ─── ID Lookup (short pointer to detail) ──────────────────────────────────

function handleIdLookup(
  id: string,
  idType: 'knowledge' | 'session',
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

// ─── Session Search (Prompt FTS, with an explicit text fallback) ───────────

/**
 * Preferred path: bm25 over the SQLite FTS index of real user prompts.
 *
 * The fallback below is a whole-transcript substring scan. It is kept because a node
 * may not have indexed yet (or may lack better-sqlite3), but it is NEVER entered
 * silently — a caller who cannot tell which path answered cannot tell a ranked result
 * from an unranked one, and that is precisely how a match-everything response got
 * trusted as a search result.
 */
async function handleSemanticSearch(
  query: string,
  scope: Scope,
  project: string | undefined,
  includeSynthetic: boolean,
  limit: number,
  offset: number,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  // The index is asked for enough SESSIONS to fill this page; without it the row budget
  // is fixed and deep pages simply never reach the later sessions.
  const attempt = await tryPromptIndex(query, scope, project, includeSynthetic, offset + limit);
  if (attempt.ok) {
    return formatSessionResults(attempt.result, query, limit, offset, attempt.label);
  }
  return handleTextSearch(query, scope, project, limit, offset, attempt.why);
}

type IndexAttempt =
  | { ok: true; result: PromptSearchResult; label: string }
  | { ok: false; why: string };

/** Run the FTS path, or say precisely why it could not answer. */
async function tryPromptIndex(
  query: string,
  scope: Scope,
  project: string | undefined,
  includeSynthetic: boolean,
  need: number,
): Promise<IndexAttempt> {
  if (tokenizeFts(query).length === 0) {
    return { ok: false, why: 'query has no indexable terms (all stopwords or punctuation)' };
  }
  const index = getPromptIndex();
  try {
    // init() BEFORE the emptiness check, so a store that cannot open at all is reported
    // as unavailable rather than as "empty". Those have different fixes — a missing
    // native binding is an install problem, an empty index is just a pending backfill —
    // and naming the wrong one sends the reader after the wrong thing. (Observed live:
    // a worktree npm install shadowed better-sqlite3 with an unbuilt copy, and the
    // fallback blamed the backfill.)
    await index.init();
    if (!index.hasContent()) {
      return { ok: false, why: 'prompt index is empty — the backfill has not run on this node yet' };
    }
    const since = scope === 'all' ? undefined : new Date(Date.now() - SCOPE_MS[scope]).toISOString();
    let result = await index.search(query, { project, since, includeSynthetic, need });
    if (!result) return { ok: false, why: 'query has no indexable terms' };

    // Widen past the time window rather than report a false no-match.
    //
    // `scope` defaults to 7d, and that default was calibrated for a scan that read whole
    // transcripts. Ranking only real user prompts makes the corpus far smaller: measured
    // on this node, 7d covers 35 prompts across 10 sessions, against 2,300 across 532 for
    // all time. So the default window misses almost everything — and the miss used to be
    // announced as "a real no-match". Same contract as the AND→OR widening: try what the
    // caller asked for, widen only when it finds nothing, and always say which happened.
    let widenedScope = false;
    if (since && result.sessions.length === 0) {
      const all = await index.search(query, { project, includeSynthetic, need });
      if (all && all.sessions.length > 0) { result = all; widenedScope = true; }
    }
    const { files, prompts } = index.status();
    // A backfill in flight means the corpus is a PREFIX of this node's history. Searching
    // it is fine; presenting it as complete is not — and the no-match text below asserts
    // "this is a real no-match", which is simply false while indexing is still running.
    const bf = promptIndexProgress();
    const building = bf.running
      ? ` — INDEX STILL BUILDING (${bf.done}/${bf.total} files); results are incomplete`
      : '';
    const label = `prompt index: bm25 over ${prompts} user prompts from ${files} sessions, ` +
      (result.mode === 'and'
        ? 'every term matched within a single prompt'
        : 'ANY term matched — no single prompt contained all terms (a session may still cover them across prompts)') +
      // The window is always stated. Widening only fires on ZERO results, so a query that
      // finds a FEW recent sessions silently hides the rest — measured, 7d reached 1
      // session where all-time had 38. A caller who cannot see the window cannot tell a
      // complete answer from a recent slice of one.
      (widenedScope
        ? ` — WIDENED past scope="${scope}" to all time, which had no match`
        : scope === 'all' ? '' : ` — LIMITED to scope="${scope}"; older matches are excluded (retry with scope="all")`) +
      building;
    return { ok: true, result, label };
  } catch (e) {
    // better-sqlite3 missing / db unreadable. Report it rather than quietly degrading.
    return { ok: false, why: `prompt index unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Render ranked sessions, with the matching prompt as the evidence for each hit. */
function formatSessionResults(
  result: PromptSearchResult,
  query: string,
  limit: number,
  offset: number,
  label: string,
): { content: Array<{ type: string; text: string }> } {
  const total = result.sessions.length;
  const page = result.sessions.slice(offset, offset + limit);
  // A capped scan yields a FLOOR, not a total. Reporting it as a total is exactly the
  // failure this feature replaced, one layer down: measured here, a broad query showed
  // 114 sessions at the old fixed budget and 171 with a larger one.
  const countText = result.truncated ? `at least ${total}` : `${total}`;
  if (page.length === 0) {
    const bf = promptIndexProgress();
    // Only claim a definitive no-match when the corpus is actually complete. Paging past
    // the end is also not a no-match — it contradicts the page the caller just read.
    const why = bf.running
      ? `The index is STILL BUILDING (${bf.done}/${bf.total} files) — this is NOT a definitive no-match; retry once it finishes.`
      : offset > 0
        ? `You paged past the end of the results — go back to offset=0.`
        : `This is a real no-match, not an empty index — widen with scope="all", or drop a term.`;
    return { content: [{ type: 'text', text: `No sessions matched "${query}".\n(${label})\n${why}` }] };
  }

  const cache = getSessionCache();
  const byId = new Map(cache.getAllSessionsFromCache().map((s) => [s.sessionId, s] as const));
  const lines: string[] = [];
  lines.push(`Found ${countText} session${total !== 1 ? 's' : ''} (showing ${offset + 1}-${offset + page.length})`);
  lines.push(`(${label})`);
  if (result.truncated) {
    lines.push(`(scan capped at ${result.scannedRows} matching prompts — more sessions exist; narrow the query for an exact count)`);
  }
  lines.push('');

  for (let i = 0; i < page.length; i++) {
    const s = page[i];
    const entry = byId.get(s.sessionId);
    const cd = entry?.cacheData;
    const projPath = s.project || (cd ? getProjectPathForSession(cd, entry!.filePath) : '');
    const projName = projPath ? projPath.split('/').filter(Boolean).pop() : '?';
    const turns = cd?.numTurns ?? '?';
    // Term coverage is shown for a widened query: it is the reason this session outranks
    // the next one, and without it an OR result looks like an undifferentiated pile.
    const cov = result.mode === 'or' && result.queryTerms > 1
      ? `, matched ${s.terms}/${result.queryTerms} terms`
      : '';
    lines.push(`${offset + i + 1}. [session] ${s.sessionId}  (${projName}, ${turns} turns${cov}${s.matches > 1 ? `, ${s.matches} matching prompts` : ''})`);
    const snippet = s.best.text.replace(/\s+/g, ' ').slice(0, 220);
    lines.push(`   matched prompt (line ${s.best.lineIndex}): "${snippet}${s.best.text.length > 220 ? '…' : ''}"`);
    lines.push(`   → detail("${s.sessionId}")`);
    lines.push('');
  }

  if (total > offset + limit) {
    lines.push(`More: search("${query}", offset=${offset + limit})`);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ─── Text Search Fallback ──────────────────────────────────────────────────

async function handleTextSearch(
  query: string,
  scope: Scope,
  project: string | undefined,
  limit: number,
  offset: number,
  fallbackReason: string,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const cache = getSessionCache();
  const sessions = cache.getAllSessionsFromCache();

  const queryTokens = tokenizeSessionQuery(query);
  const queryLower = query.toLowerCase();

  // Score sessions
  const sessionResults: Array<{
    sessionId: string;
    score: number;
  }> = [];

  for (const { sessionId, filePath, cacheData } of sessions) {
    if (!isWithinScope(cacheData.lastTimestamp, scope)) continue;
    if (project) {
      const sessionProject = getProjectPathForSession(cacheData, filePath);
      if (sessionProject !== project) continue;
    }

    const { score } = scoreSession(cacheData, queryTokens, queryLower);
    if (score <= 0) continue;

    sessionResults.push({ sessionId, score });
  }

  sessionResults.sort((a, b) => b.score - a.score);
  const totalMatches = sessionResults.length;
  const pageResults = sessionResults.slice(offset, offset + limit);

  if (pageResults.length === 0) {
    return { content: [{ type: 'text', text:
      `No results found for "${query}"\n(text scan fallback — ${fallbackReason})` }] };
  }

  // Index the in-scope sessions so each result can carry a topic + project +
  // turn count — without this the LLM only gets bare UUIDs and can't judge
  // relevance. (Text-only by design: the vector store is intentionally off to
  // cap memory, so the text path must itself be informative.)
  const byId = new Map(sessions.map((s) => [s.sessionId, s] as const));
  const lines: string[] = [];
  lines.push(`Found ${totalMatches} results (showing ${offset + 1}-${offset + pageResults.length})`);
  // The caller must be able to tell this apart from a ranked answer. A whole-transcript
  // substring scan is coarse: it is reported as such, with the reason the good path was
  // unavailable, so nobody mistakes a broad result set for a precise one.
  lines.push(`(TEXT SCAN FALLBACK, not the ranked prompt index — ${fallbackReason})`);
  if (totalMatches >= sessions.length && sessions.length > 0) {
    lines.push(`(warning: this matched ${totalMatches} of ${sessions.length} sessions in scope — treat as unfiltered)`);
  }
  lines.push('');

  for (let i = 0; i < pageResults.length; i++) {
    const r = pageResults[i];
    const entry = byId.get(r.sessionId);
    const cd = entry?.cacheData;
    const projPath = cd ? getProjectPathForSession(cd, entry!.filePath) : '';
    const projName = projPath ? projPath.split('/').filter(Boolean).pop() : '?';
    const firstReal = (cd?.userPrompts || [])
      .map((p) => (p?.text || '').trim())
      .find((t) => t && !t.startsWith('<') && !t.startsWith('/') && t.length > 3);
    const topic = (firstReal || '').replace(/\s+/g, ' ').slice(0, 120);
    lines.push(`${offset + i + 1}. [session] ${r.sessionId}  (${projName}, ${cd?.numTurns ?? '?'} turns)`);
    if (topic) lines.push(`   "${topic}"`);
    lines.push(`   → detail("${r.sessionId}")`);
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
  const sessions = cache.getAllSessionsFromCache()
    .filter(s => isWithinScope(s.cacheData.lastTimestamp, scope))
    .filter(s => !project || s.cacheData.cwd === project);

  const queryPaths = query.split(/[,\s]+/).filter(p => p.length > 0);

  // Search through sessions for file matches
  interface FileMatch {
    filePath: string;
    sessionId: string;
    action: string;
    turnIndex: number;
    timestamp?: string;
  }

  const matches: FileMatch[] = [];

  for (const { sessionId, cacheData } of sessions) {
    for (const tu of cacheData.toolUses) {
      const fp = tu.input?.file_path || tu.input?.path;
      if (!fp) continue;

      // Check if any query path matches this file
      const matched = queryPaths.some(qp => fp.endsWith(qp) || fp.includes(qp));
      if (!matched) continue;

      let action = 'read';
      if (tu.name === 'Write') action = 'write';
      else if (tu.name === 'Edit') action = 'edit';

      const nearestPrompt = cacheData.userPrompts
        .filter(p => p.turnIndex <= tu.turnIndex)
        .pop();

      matches.push({
        filePath: fp,
        sessionId,
        action,
        turnIndex: tu.turnIndex,
        timestamp: nearestPrompt?.timestamp,
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
    lines.push(`${offset + i + 1}. ${m.action.toUpperCase()} ${m.filePath}`);
    lines.push(`   Session: ${m.sessionId} | Turn ${m.turnIndex}`);
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

// ─── Combined File + Session Search ──────────────────────────────────────

/**
 * A path-shaped query wants the file history first, but the sessions that DISCUSSED
 * the file are usually the reason someone is asking, so both run.
 */
async function handleFileAndSemanticSearch(
  query: string,
  scope: Scope,
  project: string | undefined,
  includeSynthetic: boolean,
  limit: number,
  offset: number,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const [fileResult, sessionResult] = await Promise.all([
    handleFileSearch(query, scope, project, limit, offset),
    handleSemanticSearch(query, scope, project, includeSynthetic, limit, offset),
  ]);

  const fileText = fileResult.content[0]?.text || '';
  const sessionText = sessionResult.content[0]?.text || '';
  if (fileText.startsWith('No file matches')) return sessionResult;
  if (sessionText.startsWith('No sessions matched') || sessionText.startsWith('No results found')) return fileResult;

  return { content: [{ type: 'text', text: [fileText, '', '--- Sessions mentioning it ---', '', sessionText].join('\n') }] };
}
