'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Search,
  BookOpen,
  MessageSquareMore,
  ChevronRight,
  RefreshCw,
  Send,
  Check,
  Circle,
  Filter,
  X,
  Sparkles,
  ArrowLeft,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

// ============================================================================
// API helpers
// ============================================================================

function getApiBase(): string {
  if (typeof window === 'undefined') return 'http://localhost:3100';
  const port = process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100';
  return `http://${window.location.hostname}:${port}`;
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
    ...opts,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  const json = await res.json();
  if (json && typeof json === 'object' && json.success === false) {
    throw new Error(json.error || 'Request failed');
  }
  if (json && typeof json === 'object' && 'data' in json) return json.data as T;
  return json as T;
}

// ============================================================================
// Types
// ============================================================================

interface KnowledgeListItem {
  id: string;
  title: string;
  type: string;
  project: string;
  status: string;
  partCount: number;
  unaddressedComments: number;
  updatedAt: string;
  sourceSessionId?: string;
  sourceAgentId?: string;
  parts: Array<{ partId: string; title: string; summary: string }>;
}

interface KnowledgeFull {
  id: string;
  title: string;
  type: string;
  project: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  sourceSessionId?: string;
  sourceAgentId?: string;
  parts: Array<{ partId: string; title: string; summary: string; content: string }>;
}

interface ExploreCandidate {
  sessionId: string;
  agentId: string;
  type: string;
  prompt: string;
  resultPreview: string;
  description?: string;
  timestamp?: string;
}

interface KnowledgeComment {
  id: string;
  knowledgeId: string;
  partId?: string;
  type: string;
  content: string;
  source: string;
  state: 'not_addressed' | 'addressed';
  createdAt: string;
  addressedAt?: string;
  addressedBy?: string;
}

interface SearchResult {
  type: string;
  knowledgeId?: string;
  partId?: string;
  text: string;
  score: number;
  knowledgeTitle?: string;
  partTitle?: string;
  knowledgeType?: string;
}

const KNOWLEDGE_TYPES = ['algorithm', 'contract', 'schema', 'wiring', 'invariant', 'flow'] as const;
const COMMENT_TYPES = ['outdated', 'update', 'expand', 'remove', 'general'] as const;

const TYPE_COLORS: Record<string, string> = {
  algorithm: 'badge-blue',
  contract: 'badge-purple',
  schema: 'badge-green',
  wiring: 'badge-orange',
  invariant: 'badge-red',
  flow: 'badge-cyan',
};

const STATUS_COLORS: Record<string, string> = {
  active: 'badge-green',
  outdated: 'badge-orange',
  archived: 'badge-default',
};

// ============================================================================
// Main Component
// ============================================================================

export function KnowledgePage() {
  const searchParams = useSearchParams();
  const urlId = searchParams.get('id');
  const urlPart = searchParams.get('part');

  // ─── State ───────────────────────────────────────────────────
  const [list, setList] = useState<KnowledgeListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(urlId);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(urlPart);
  const [knowledge, setKnowledge] = useState<KnowledgeFull | null>(null);
  const [comments, setComments] = useState<KnowledgeComment[]>([]);
  const [showAddressed, setShowAddressed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [filterType, setFilterType] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('active');
  const [filterProject, setFilterProject] = useState<string>('');
  const [showFilters, setShowFilters] = useState(false);
  const [commentForm, setCommentForm] = useState<{
    partId?: string;
    type: string;
    content: string;
  } | null>(null);
  const [submittingComment, setSubmittingComment] = useState(false);
  const [highlightPartId, setHighlightPartId] = useState<string | null>(null);
  const [showGeneratePanel, setShowGeneratePanel] = useState(false);
  const [candidates, setCandidates] = useState<ExploreCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [generatingAgentId, setGeneratingAgentId] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<Record<string, string>>({});
  const [generateSuccess, setGenerateSuccess] = useState<string | null>(null);
  const [generateStats, setGenerateStats] = useState<{ candidates: number; generated: number } | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [processingAll, setProcessingAll] = useState(false);
  const [processAllProgress, setProcessAllProgress] = useState<{ processed: number; total: number; errors: number } | null>(null);

  const viewerRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Data fetching ───────────────────────────────────────────

  const fetchList = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filterType) params.set('type', filterType);
      if (filterStatus) params.set('status', filterStatus);
      if (filterProject) params.set('project', filterProject);
      const qs = params.toString();
      const data = await apiFetch<KnowledgeListItem[]>(`/knowledge${qs ? `?${qs}` : ''}`);
      setList(data);
    } catch (err) {
      console.error('Failed to fetch knowledge list:', err);
    } finally {
      setLoading(false);
    }
  }, [filterType, filterStatus, filterProject]);

  const fetchKnowledge = useCallback(async (id: string) => {
    try {
      const [data, commentsData] = await Promise.all([
        apiFetch<KnowledgeFull>(`/knowledge/${id}`),
        apiFetch<KnowledgeComment[]>(`/knowledge/${id}/comments?includeAddressed=true`),
      ]);
      setKnowledge(data);
      setComments(commentsData);
    } catch (err) {
      console.error('Failed to fetch knowledge:', err);
    }
  }, []);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  // Sync URL params → selection
  useEffect(() => {
    if (urlId && urlId !== selectedId) {
      setSelectedId(urlId);
      if (urlPart) {
        setSelectedPartId(urlPart);
        setHighlightPartId(urlPart);
        setTimeout(() => setHighlightPartId(null), 2000);
        requestAnimationFrame(() => {
          const el = document.getElementById(`part-${urlPart}`);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    }
  }, [urlId, urlPart]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedId) {
      fetchKnowledge(selectedId);
    } else {
      setKnowledge(null);
      setComments([]);
    }
  }, [selectedId, fetchKnowledge]);

  // Scroll selected knowledge into view in left panel after list loads
  const scrolledToUrlRef = useRef(false);
  useEffect(() => {
    if (scrolledToUrlRef.current || !urlId || list.length === 0) return;
    scrolledToUrlRef.current = true;
    const tryScroll = (delay: number) => {
      setTimeout(() => {
        const el = document.querySelector(`[data-knowledge-id="${urlId}"]`) as HTMLElement | null;
        if (!el) {
          if (delay < 2000) tryScroll(delay + 200);
          return;
        }
        // Find nearest scrollable parent and scroll element to center
        let parent = el.parentElement;
        while (parent) {
          const style = getComputedStyle(parent);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
            const containerRect = parent.getBoundingClientRect();
            const elRect = el.getBoundingClientRect();
            const offset = elRect.top - containerRect.top - (containerRect.height / 2) + (elRect.height / 2);
            // Use instant scroll first, then smooth if needed
            parent.scrollTop = parent.scrollTop + offset;
            break;
          }
          parent = parent.parentElement;
        }
      }, delay);
    };
    tryScroll(300);
  }, [urlId, list]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Search ──────────────────────────────────────────────────

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const data = await apiFetch<SearchResult[]>(`/knowledge/search?q=${encodeURIComponent(q)}`);
      setSearchResults(data);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => doSearch(value), 300);
  }, [doSearch]);

  // ─── Part selection + scroll ─────────────────────────────────

  const selectPart = useCallback((knowledgeId: string, partId: string) => {
    if (selectedId !== knowledgeId) {
      setSelectedId(knowledgeId);
    }
    setSelectedPartId(partId);
    setHighlightPartId(partId);

    // Scroll to part after render
    requestAnimationFrame(() => {
      const el = document.getElementById(`part-${partId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    // Clear highlight after animation
    setTimeout(() => setHighlightPartId(null), 2000);
  }, [selectedId]);

  // ─── Comment submission ──────────────────────────────────────

  const submitComment = useCallback(async () => {
    if (!commentForm || !selectedId || !commentForm.content.trim()) return;
    setSubmittingComment(true);
    try {
      await apiFetch(`/knowledge/${selectedId}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          partId: commentForm.partId,
          type: commentForm.type,
          content: commentForm.content,
        }),
      });
      setCommentForm(null);
      // Refresh comments
      const data = await apiFetch<KnowledgeComment[]>(
        `/knowledge/${selectedId}/comments?includeAddressed=true`,
      );
      setComments(data);
      // Refresh list (comment counts changed)
      fetchList();
    } catch (err) {
      console.error('Failed to submit comment:', err);
    } finally {
      setSubmittingComment(false);
    }
  }, [commentForm, selectedId, fetchList]);

  // ─── Generate from Explore ─────────────────────────────────

  // Extract unique projects from the full knowledge list for the project filter dropdown
  const availableProjects = useMemo(() => {
    const projects = new Set<string>();
    for (const k of list) {
      if (k.project) projects.add(k.project);
    }
    return Array.from(projects).sort();
  }, [list]);

  const fetchStats = useCallback(async () => {
    try {
      const url = filterProject
        ? `/knowledge/generate/stats?project=${encodeURIComponent(filterProject)}`
        : '/knowledge/generate/stats';
      const stats = await apiFetch<{ candidates: number; generated: number }>(url);
      setGenerateStats(stats);
    } catch {
      // stats fetch is best-effort
    }
  }, [filterProject]);

  // Fetch stats on mount and when project filter changes
  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const fetchCandidates = useCallback(async () => {
    setLoadingCandidates(true);
    try {
      const url = filterProject
        ? `/knowledge/generate/candidates?project=${encodeURIComponent(filterProject)}`
        : '/knowledge/generate/candidates';
      const data = await apiFetch<ExploreCandidate[]>(url);
      setCandidates(data);
      // Update candidates count from actual data; keep generated from existing stats
      setGenerateStats(prev => prev
        ? { ...prev, candidates: data.length }
        : { candidates: data.length, generated: 0 },
      );
    } catch (err) {
      console.error('Failed to fetch candidates:', err);
      setCandidates([]);
    } finally {
      setLoadingCandidates(false);
    }
  }, [filterProject]);

  const handleGenerate = useCallback(async (candidate: ExploreCandidate & { project?: string }) => {
    setGeneratingAgentId(candidate.agentId);
    setGenerateError(prev => { const n = { ...prev }; delete n[candidate.agentId]; return n; });
    setGenerateSuccess(null);
    // Use project from candidate (tagged by all-projects scan) or from filter
    const project = (candidate as any).project || filterProject;
    try {
      await apiFetch('/knowledge/generate', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: candidate.sessionId,
          agentId: candidate.agentId,
          project,
        }),
      });
      // Remove from candidates list and update stats inline
      setCandidates(prev => prev.filter(c => c.agentId !== candidate.agentId));
      setGenerateStats(prev => prev ? { candidates: prev.candidates - 1, generated: prev.generated + 1 } : prev);
      setGenerateSuccess(candidate.agentId);
      setTimeout(() => setGenerateSuccess(null), 3000);
      // Refresh knowledge list
      fetchList();
    } catch (err: any) {
      console.error('Failed to generate knowledge:', err);
      const raw = err?.message || 'Generation failed';
      const msg = raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
      setGenerateError(prev => ({ ...prev, [candidate.agentId]: msg }));
    } finally {
      setGeneratingAgentId(null);
    }
  }, [filterProject, fetchList]);

  const handleRegenerate = useCallback(async () => {
    if (!knowledge) return;
    setRegenerating(true);
    try {
      await apiFetch(`/knowledge/${knowledge.id}/regenerate`, { method: 'POST' });
      // Refresh the knowledge detail
      fetchKnowledge(knowledge.id);
      fetchList();
    } catch (err) {
      console.error('Failed to regenerate knowledge:', err);
    } finally {
      setRegenerating(false);
    }
  }, [knowledge, fetchKnowledge, fetchList]);

  const handleProcessAll = useCallback(async () => {
    if (processingAll || candidates.length === 0) return;
    setProcessingAll(true);
    setProcessAllProgress({ processed: 0, total: candidates.length, errors: 0 });
    try {
      const project = filterProject || undefined;
      const url = project
        ? `/knowledge/generate/all?project=${encodeURIComponent(project)}`
        : '/knowledge/generate/all';

      // Poll status while processing
      const pollInterval = setInterval(async () => {
        try {
          const status = await apiFetch<{ status: string; processed?: number; total?: number; errors?: number }>('/knowledge/generate/status');
          if (status.status === 'generating' && status.processed !== undefined) {
            setProcessAllProgress({ processed: status.processed, total: status.total || candidates.length, errors: status.errors || 0 });
          }
        } catch { /* ignore poll errors */ }
      }, 2000);

      await apiFetch(url, { method: 'POST' });
      clearInterval(pollInterval);

      // Refresh candidates and list
      await Promise.all([fetchCandidates(), fetchList(), fetchStats()]);
    } catch (err) {
      console.error('Failed to process all:', err);
    } finally {
      setProcessingAll(false);
      setProcessAllProgress(null);
    }
  }, [processingAll, candidates.length, filterProject, fetchCandidates, fetchList, fetchStats]);

  const openGeneratePanel = useCallback(() => {
    setShowGeneratePanel(true);
    fetchCandidates();
  }, [fetchCandidates]);

  // ─── Filtered comments ───────────────────────────────────────

  const visibleComments = useMemo(() => {
    if (showAddressed) return comments;
    return comments.filter(c => c.state === 'not_addressed');
  }, [comments, showAddressed]);

  const partComments = useCallback(
    (partId: string) => visibleComments.filter(c => c.partId === partId),
    [visibleComments],
  );

  const docComments = useMemo(
    () => visibleComments.filter(c => !c.partId),
    [visibleComments],
  );

  // ─── Render ──────────────────────────────────────────────────

  return (
    <div style={{
      display: 'flex',
      height: '100%',
      overflow: 'hidden',
      background: 'var(--color-bg-root)',
    }}>
      {/* Left panel — List */}
      <div style={{
        width: 340,
        minWidth: 340,
        borderRight: '1px solid var(--color-border-default)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Search bar */}
        <div style={{
          padding: '10px 12px',
          borderBottom: '1px solid var(--color-border-default)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
            <div style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: 'var(--color-bg-surface)',
              borderRadius: 'var(--radius-md)',
              padding: '6px 10px',
              border: '1px solid var(--color-border-default)',
            }}>
              <Search size={14} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Search knowledge..."
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--color-text-primary)',
                  fontSize: 13,
                  fontFamily: 'var(--font-sans)',
                }}
              />
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(''); setSearchResults(null); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}
                >
                  <X size={14} style={{ color: 'var(--color-text-tertiary)' }} />
                </button>
              )}
            </div>
            <button
              onClick={() => setShowFilters(!showFilters)}
              style={{
                background: showFilters ? 'var(--color-bg-active)' : 'transparent',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-md)',
                padding: '6px 8px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
              }}
              title="Filters"
            >
              <Filter size={14} style={{ color: 'var(--color-text-secondary)' }} />
            </button>
            <button
              onClick={() => { setLoading(true); fetchList(); }}
              style={{
                background: 'transparent',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-md)',
                padding: '6px 8px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
              }}
              title="Refresh"
            >
              <RefreshCw size={14} style={{ color: 'var(--color-text-secondary)' }} />
            </button>
            <button
              onClick={() => {
                if (showGeneratePanel) {
                  setShowGeneratePanel(false);
                } else {
                  openGeneratePanel();
                }
              }}
              style={{
                background: 'var(--color-accent)',
                border: '1px solid var(--color-accent)',
                borderRadius: 'var(--radius-md)',
                padding: '6px 8px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
                opacity: showGeneratePanel ? 1 : 0.8,
              }}
              title="Generate from Explore sessions"
            >
              <Sparkles size={14} style={{ color: '#fff' }} />
            </button>
          </div>

          {/* Filters */}
          {showFilters && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 6 }}>
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                style={{
                  flex: 1,
                  background: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border-default)',
                  borderRadius: 'var(--radius-md)',
                  padding: '4px 8px',
                  color: 'var(--color-text-secondary)',
                  fontSize: 12,
                  fontFamily: 'var(--font-sans)',
                }}
              >
                <option value="">All types</option>
                {KNOWLEDGE_TYPES.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                style={{
                  flex: 1,
                  background: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border-default)',
                  borderRadius: 'var(--radius-md)',
                  padding: '4px 8px',
                  color: 'var(--color-text-secondary)',
                  fontSize: 12,
                  fontFamily: 'var(--font-sans)',
                }}
              >
                <option value="">All statuses</option>
                <option value="active">active</option>
                <option value="outdated">outdated</option>
                <option value="archived">archived</option>
              </select>
              </div>
              <select
                value={filterProject}
                onChange={(e) => setFilterProject(e.target.value)}
                style={{
                  background: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border-default)',
                  borderRadius: 'var(--radius-md)',
                  padding: '4px 8px',
                  color: 'var(--color-text-secondary)',
                  fontSize: 12,
                  fontFamily: 'var(--font-sans)',
                }}
              >
                <option value="">All projects</option>
                {availableProjects.map(p => (
                  <option key={p} value={p}>{p.replace(/^\/home\/ubuntu\//, '~/')}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Stats bar — always visible */}
        {generateStats && (
          <div style={{
            padding: '5px 12px',
            borderBottom: '1px solid var(--color-border-default)',
            fontSize: 11,
            color: 'var(--color-text-tertiary)',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: 'var(--color-bg-surface)',
          }}>
            <Sparkles size={10} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
            <span style={{ fontWeight: 500, color: 'var(--color-text-secondary)' }}>{generateStats.candidates}</span>
            {' '}candidates
            <span style={{ margin: '0 2px' }}>&middot;</span>
            <span style={{ fontWeight: 500, color: 'var(--color-text-secondary)' }}>{generateStats.generated}</span>
            {' '}generated
          </div>
        )}

        {/* Generate candidates panel or Search results or list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {showGeneratePanel ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{
                padding: '8px 12px',
                borderBottom: '1px solid var(--color-border-default)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}>
                <button
                  onClick={() => setShowGeneratePanel(false)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}
                >
                  <ArrowLeft size={14} style={{ color: 'var(--color-text-secondary)' }} />
                </button>
                <Sparkles size={14} style={{ color: 'var(--color-accent)' }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  Generate Knowledge
                </span>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    onClick={fetchCandidates}
                    disabled={processingAll}
                    style={{ background: 'none', border: 'none', cursor: processingAll ? 'not-allowed' : 'pointer', padding: 0, display: 'flex', opacity: processingAll ? 0.4 : 1 }}
                    title="Refresh candidates"
                  >
                    <RefreshCw size={12} style={{ color: 'var(--color-text-tertiary)' }} />
                  </button>
                  {candidates.length > 0 && (
                    <button
                      onClick={handleProcessAll}
                      disabled={processingAll || generatingAgentId !== null}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '3px 10px',
                        background: processingAll ? 'var(--color-bg-surface)' : 'var(--color-accent)',
                        color: processingAll ? 'var(--color-text-secondary)' : '#fff',
                        border: `1px solid ${processingAll ? 'var(--color-border-default)' : 'var(--color-accent)'}`,
                        borderRadius: 'var(--radius-md)',
                        fontSize: 11,
                        fontWeight: 500,
                        cursor: processingAll || generatingAgentId !== null ? 'not-allowed' : 'pointer',
                        opacity: generatingAgentId !== null ? 0.5 : 1,
                      }}
                    >
                      {processingAll ? (
                        <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                      ) : (
                        <Sparkles size={11} />
                      )}
                      {processingAll ? 'Processing...' : 'Process All'}
                    </button>
                  )}
                </div>
              </div>
              {/* Process All progress bar */}
              {processAllProgress && (
                <div style={{
                  padding: '6px 12px',
                  borderBottom: '1px solid var(--color-border-default)',
                  background: 'var(--color-bg-surface)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                      {processAllProgress.processed} / {processAllProgress.total} processed
                    </span>
                    {processAllProgress.errors > 0 && (
                      <span style={{ fontSize: 11, color: 'var(--color-status-red, #e55)' }}>
                        {processAllProgress.errors} errors
                      </span>
                    )}
                  </div>
                  <div style={{
                    height: 4,
                    borderRadius: 2,
                    background: 'var(--color-border-default)',
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      height: '100%',
                      borderRadius: 2,
                      background: 'var(--color-accent)',
                      width: `${processAllProgress.total > 0 ? (processAllProgress.processed / processAllProgress.total) * 100 : 0}%`,
                      transition: 'width 0.3s',
                    }} />
                  </div>
                </div>
              )}
              {/* Success banner */}
              {generateSuccess && (
                <div style={{
                  padding: '6px 12px',
                  background: 'color-mix(in srgb, var(--color-status-green) 10%, transparent)',
                  borderBottom: '1px solid var(--color-border-default)',
                  fontSize: 12,
                  color: 'var(--color-status-green)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}>
                  <Check size={13} />
                  Knowledge generated successfully
                </div>
              )}

              {loadingCandidates ? (
                <div style={{ padding: 16, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
                  Scanning sessions...
                </div>
              ) : candidates.length === 0 ? (
                <div className="empty-state">
                  <Sparkles size={32} className="empty-state-icon" />
                  <div style={{ fontSize: 13 }}>No candidates found</div>
                  <div style={{ fontSize: 12 }}>All explore sessions have been converted or are too short</div>
                </div>
              ) : (
                <div style={{ flex: 1, overflowY: 'auto' }}>
                  {candidates.map(c => (
                    <div
                      key={c.agentId}
                      style={{
                        padding: '10px 12px',
                        borderBottom: '1px solid var(--color-border-default)',
                        cursor: 'default',
                      }}
                    >
                      <div style={{
                        fontSize: 13,
                        fontWeight: 500,
                        color: 'var(--color-text-primary)',
                        marginBottom: 4,
                        lineHeight: 1.3,
                      }}>
                        {c.prompt.length > 120 ? c.prompt.slice(0, 120) + '...' : c.prompt}
                      </div>
                      {c.description && (
                        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
                          {c.description}
                        </div>
                      )}
                      <div style={{
                        fontSize: 11,
                        color: 'var(--color-text-tertiary)',
                        marginBottom: 6,
                        lineHeight: 1.4,
                        maxHeight: 40,
                        overflow: 'hidden',
                      }}>
                        {c.resultPreview.slice(0, 150)}...
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {c.timestamp && (
                            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                              {new Date(c.timestamp).toLocaleDateString()}
                            </span>
                          )}
                          {generatingAgentId === c.agentId ? (
                            <span style={{
                              marginLeft: 'auto',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              fontSize: 11,
                              color: 'var(--color-text-tertiary)',
                            }}>
                              <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-accent)' }} />
                              Generating knowledge from explore session...
                            </span>
                          ) : (
                            <button
                              onClick={() => handleGenerate(c)}
                              disabled={generatingAgentId !== null}
                              style={{
                                marginLeft: 'auto',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                padding: '3px 10px',
                                background: 'var(--color-accent)',
                                color: '#fff',
                                border: 'none',
                                borderRadius: 'var(--radius-md)',
                                fontSize: 11,
                                fontWeight: 500,
                                cursor: generatingAgentId ? 'not-allowed' : 'pointer',
                                opacity: generatingAgentId ? 0.6 : 1,
                              }}
                            >
                              <Sparkles size={11} />
                              Generate
                            </button>
                          )}
                        </div>
                        {generateError[c.agentId] && (
                          <div style={{
                            fontSize: 11,
                            color: 'var(--color-status-red, #e55)',
                            lineHeight: 1.3,
                            padding: '4px 0',
                          }}>
                            {generateError[c.agentId]}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
          <>
          {searching && (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
              Searching...
            </div>
          )}

          {searchResults && !searching ? (
            searchResults.length === 0 ? (
              <div className="empty-state">
                <Search size={32} className="empty-state-icon" />
                <div>No results found</div>
              </div>
            ) : (
              searchResults.map((r, i) => (
                <SearchResultRow
                  key={i}
                  result={r}
                  onClick={() => {
                    if (r.knowledgeId) {
                      if (r.partId) {
                        selectPart(r.knowledgeId, r.partId);
                      } else {
                        setSelectedId(r.knowledgeId);
                        setSelectedPartId(null);
                      }
                    }
                  }}
                />
              ))
            )
          ) : loading ? (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
              Loading...
            </div>
          ) : list.length === 0 ? (
            <div className="empty-state">
              <BookOpen size={32} className="empty-state-icon" />
              <div>No knowledge documents</div>
              <div style={{ fontSize: 12 }}>Knowledge is created via MCP tools or REST API</div>
            </div>
          ) : (
            list.map((k, ki) => (
              <KnowledgeListGroup
                key={k.id}
                item={k}
                isFirst={ki === 0}
                selectedId={selectedId}
                selectedPartId={selectedPartId}
                onSelect={(id) => { setSelectedId(id); setSelectedPartId(null); }}
                onSelectPart={(kId, pId) => selectPart(kId, pId)}
              />
            ))
          )}
          </>
          )}
        </div>
      </div>

      {/* Right panel — Viewer */}
      <div
        ref={viewerRef}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {!knowledge ? (
          <div className="empty-state" style={{ flex: 1 }}>
            <BookOpen size={48} className="empty-state-icon" />
            <div style={{ fontSize: 15 }}>Select a knowledge document</div>
            <div style={{ fontSize: 12 }}>Choose from the list or search to get started</div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div style={{
              padding: '10px 16px',
              borderBottom: '1px solid var(--color-border-default)',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexShrink: 0,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: 'var(--color-text-primary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {knowledge.id}: {knowledge.title}
                </div>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginTop: 2,
                }}>
                  <span className={`badge ${TYPE_COLORS[knowledge.type] || 'badge-default'}`}>
                    {knowledge.type}
                  </span>
                  <span className={`badge ${STATUS_COLORS[knowledge.status] || 'badge-default'}`}>
                    {knowledge.status}
                  </span>
                  {knowledge.project && (
                    <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                      {knowledge.project}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 11,
                  color: 'var(--color-text-tertiary)',
                  cursor: 'pointer',
                }}>
                  <input
                    type="checkbox"
                    checked={showAddressed}
                    onChange={(e) => setShowAddressed(e.target.checked)}
                    style={{ accentColor: 'var(--color-accent)' }}
                  />
                  Show addressed
                </label>
                {knowledge.sourceSessionId && (
                  <>
                    <a
                      href={`/sessions?session=${knowledge.sourceSessionId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '4px 10px',
                        background: 'var(--color-bg-surface)',
                        color: 'var(--color-text-secondary)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-md)',
                        fontSize: 12,
                        cursor: 'pointer',
                        fontFamily: 'var(--font-sans)',
                        textDecoration: 'none',
                        opacity: 0.85,
                      }}
                      title="View original explore session"
                    >
                      <ExternalLink size={13} />
                      Source
                    </a>
                    <button
                      onClick={handleRegenerate}
                      disabled={regenerating}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '4px 10px',
                        background: 'var(--color-accent)',
                        color: '#fff',
                        border: '1px solid var(--color-accent)',
                        borderRadius: 'var(--radius-md)',
                        fontSize: 12,
                        cursor: regenerating ? 'not-allowed' : 'pointer',
                        fontFamily: 'var(--font-sans)',
                        opacity: regenerating ? 0.6 : 0.85,
                      }}
                      title="Regenerate from original explore session"
                    >
                      {regenerating ? (
                        <Loader2 size={13} style={{ color: '#fff', animation: 'spin 1s linear infinite' }} />
                      ) : (
                        <RefreshCw size={13} style={{ color: '#fff' }} />
                      )}
                      Regenerate
                    </button>
                  </>
                )}
                <button
                  onClick={() => setCommentForm(commentForm ? null : { type: 'general', content: '' })}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '4px 10px',
                    background: commentForm ? 'var(--color-accent-glow)' : 'var(--color-bg-surface)',
                    color: commentForm ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                    border: '1px solid var(--color-border-default)',
                    borderRadius: 'var(--radius-md)',
                    fontSize: 12,
                    cursor: 'pointer',
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  <MessageSquareMore size={13} />
                  Comment
                </button>
              </div>
            </div>

            {/* Comment form */}
            {commentForm && (
              <CommentForm
                partId={commentForm.partId}
                type={commentForm.type}
                content={commentForm.content}
                submitting={submittingComment}
                onChangeType={(t) => setCommentForm({ ...commentForm!, type: t })}
                onChangeContent={(c) => setCommentForm({ ...commentForm!, content: c })}
                onChangePartId={(p) => setCommentForm({ ...commentForm!, partId: p || undefined })}
                onSubmit={submitComment}
                onCancel={() => setCommentForm(null)}
                parts={knowledge.parts}
              />
            )}

            {/* Content */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px 24px' }}>
              {/* Document-level comments */}
              {docComments.length > 0 && (
                <CommentList comments={docComments} label="Document comments" />
              )}

              {/* Parts */}
              {knowledge.parts.map(part => (
                <PartSection
                  key={part.partId}
                  part={part}
                  comments={partComments(part.partId)}
                  isHighlighted={highlightPartId === part.partId}
                  onAddComment={(partId) =>
                    setCommentForm({ partId, type: 'general', content: '' })
                  }
                />
              ))}

              {knowledge.parts.length === 0 && (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
                  This document has no parts yet.
                </div>
              )}

              {/* Timestamps */}
              <div style={{
                marginTop: 24,
                paddingTop: 12,
                borderTop: '1px solid var(--color-border-default)',
                fontSize: 11,
                color: 'var(--color-text-tertiary)',
                display: 'flex',
                gap: 16,
              }}>
                <span>Created: {formatDate(knowledge.createdAt)}</span>
                <span>Updated: {formatDate(knowledge.updatedAt)}</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function KnowledgeListGroup({
  item,
  isFirst,
  selectedId,
  selectedPartId,
  onSelect,
  onSelectPart,
}: {
  item: KnowledgeListItem;
  isFirst: boolean;
  selectedId: string | null;
  selectedPartId: string | null;
  onSelect: (id: string) => void;
  onSelectPart: (knowledgeId: string, partId: string) => void;
}) {
  // Auto-expand when this knowledge doc is selected
  const hasSelectedPart = selectedId === item.id;
  const [expanded, setExpanded] = useState(hasSelectedPart);

  useEffect(() => {
    if (hasSelectedPart) setExpanded(true);
  }, [hasSelectedPart]);

  if (item.parts.length === 0) {
    const isActive = selectedId === item.id && !selectedPartId;
    return (
      <div data-knowledge-id={item.id} style={{ borderBottom: '1px solid var(--color-border-default)' }}>
        <div
          onClick={() => onSelect(item.id)}
          style={{
            padding: '8px 12px',
            cursor: 'pointer',
            background: isActive ? 'var(--color-bg-elevated)' : 'transparent',
          }}
          onMouseEnter={(e) => {
            if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-hover)';
          }}
          onMouseLeave={(e) => {
            if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent';
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--color-text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {item.title}
            </span>
            <span className={`badge ${TYPE_COLORS[item.type] || 'badge-default'}`} style={{ fontSize: 9, flexShrink: 0 }}>
              {item.type}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-knowledge-id={item.id} style={{
      borderBottom: '1px solid var(--color-border-default)',
      background: hasSelectedPart ? 'var(--color-bg-elevated)' : 'transparent',
    }}>
      {/* Collapsible knowledge title header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '7px 12px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
        onMouseEnter={(e) => {
          if (!hasSelectedPart) (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-hover)';
        }}
        onMouseLeave={(e) => {
          if (!hasSelectedPart) (e.currentTarget as HTMLElement).style.background = 'transparent';
        }}
      >
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '2px 0',
            display: 'flex',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
          }}
        >
          <ChevronRight size={13} style={{ color: 'var(--color-text-tertiary)' }} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--color-text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {item.title}
            </span>
            <span className={`badge ${TYPE_COLORS[item.type] || 'badge-default'}`} style={{ fontSize: 9, flexShrink: 0 }}>
              {item.type}
            </span>
            {item.unaddressedComments > 0 && (
              <span className="badge badge-orange" style={{ fontSize: 9, flexShrink: 0 }}>
                <Circle size={5} fill="currentColor" />
                {item.unaddressedComments}
              </span>
            )}
            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
              {item.parts.length}
            </span>
          </div>
        </div>
      </div>

      {/* Part items — shown when expanded */}
      {expanded && (
        <div style={{ paddingBottom: 4 }}>
          {item.parts.map(part => {
            const isActive = selectedId === item.id && selectedPartId === part.partId;
            return (
              <div
                key={part.partId}
                onClick={() => onSelectPart(item.id, part.partId)}
                style={{
                  padding: '6px 12px 6px 32px',
                  cursor: 'pointer',
                  background: isActive ? 'var(--color-accent-glow)' : 'transparent',
                  borderLeft: isActive ? '3px solid var(--color-accent)' : '3px solid transparent',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-hover)';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent';
                }}
              >
                <div style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: 'var(--color-text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {part.title}
                </div>
                <div style={{
                  fontSize: 11,
                  color: 'var(--color-text-tertiary)',
                  marginTop: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {part.summary}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SearchResultRow({
  result,
  onClick,
}: {
  result: SearchResult;
  onClick: () => void;
}) {
  const label = result.knowledgeTitle && result.partTitle
    ? `${result.knowledgeTitle} → ${result.partTitle}`
    : result.knowledgeTitle || `${result.partId || result.knowledgeId}: ${result.text}`;

  return (
    <div
      onClick={onClick}
      style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--color-border-default)',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-hover)'}
      onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.background = 'transparent'}
    >
      <div style={{
        fontSize: 12,
        color: 'var(--color-text-primary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        <BookOpen size={12} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
        <span>{label}</span>
        {result.knowledgeType && (
          <span className={`badge ${TYPE_COLORS[result.knowledgeType] || 'badge-default'}`} style={{ fontSize: 9, flexShrink: 0 }}>
            {result.knowledgeType}
          </span>
        )}
      </div>
      <div style={{
        fontSize: 11,
        color: 'var(--color-text-tertiary)',
        marginTop: 2,
        paddingLeft: 18,
      }}>
        {result.partId || result.knowledgeId} &middot; Score: {typeof result.score === 'number' ? result.score.toFixed(3) : result.score}
      </div>
    </div>
  );
}

function PartSection({
  part,
  comments,
  isHighlighted,
  onAddComment,
}: {
  part: { partId: string; title: string; summary: string; content: string };
  comments: KnowledgeComment[];
  isHighlighted: boolean;
  onAddComment: (partId: string) => void;
}) {
  // Combine summary + content into markdown
  const md = part.content ? `${part.summary}\n\n${part.content}` : part.summary;

  return (
    <div
      id={`part-${part.partId}`}
      style={{
        marginBottom: 16,
        padding: '12px 16px',
        borderRadius: 'var(--radius-lg)',
        background: isHighlighted ? 'var(--color-accent-glow)' : 'var(--color-bg-surface)',
        border: `1px solid ${isHighlighted ? 'var(--color-accent)' : 'var(--color-border-default)'}`,
        transition: 'background 0.6s, border-color 0.6s',
      }}
    >
      {/* Part heading */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 8,
      }}>
        <span style={{
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          color: 'var(--color-accent)',
          fontWeight: 600,
        }}>
          {part.partId}
        </span>
        <span style={{
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--color-text-primary)',
          flex: 1,
        }}>
          {part.title}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {comments.length > 0 && (
            <span className="badge badge-orange" style={{ fontSize: 10 }}>
              <Circle size={5} fill="currentColor" />
              {comments.length}
            </span>
          )}
          <button
            onClick={() => onAddComment(part.partId)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 2,
              display: 'flex',
              opacity: 0.5,
            }}
            title="Add comment"
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.opacity = '1')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.opacity = '0.5')}
          >
            <MessageSquareMore size={14} style={{ color: 'var(--color-text-tertiary)' }} />
          </button>
        </div>
      </div>

      {/* Markdown content */}
      <div className="prose">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {md}
        </ReactMarkdown>
      </div>

      {/* Part comments */}
      {comments.length > 0 && (
        <CommentList comments={comments} label={`Comments on ${part.partId}`} />
      )}
    </div>
  );
}

function CommentList({ comments, label }: { comments: KnowledgeComment[]; label: string }) {
  return (
    <div style={{
      marginTop: 10,
      paddingTop: 8,
      borderTop: '1px solid var(--color-border-default)',
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--color-text-tertiary)',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 6,
      }}>
        {label} ({comments.length})
      </div>
      {comments.map(c => (
        <div key={c.id} style={{
          display: 'flex',
          gap: 8,
          padding: '4px 0',
          fontSize: 12,
          alignItems: 'flex-start',
        }}>
          {c.state === 'addressed' ? (
            <Check size={13} style={{ color: 'var(--color-status-green)', flexShrink: 0, marginTop: 1 }} />
          ) : (
            <Circle size={13} fill="var(--color-status-orange)" style={{ color: 'var(--color-status-orange)', flexShrink: 0, marginTop: 1 }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <span className={`badge ${
              c.type === 'outdated' ? 'badge-red' :
              c.type === 'update' ? 'badge-blue' :
              c.type === 'expand' ? 'badge-green' :
              c.type === 'remove' ? 'badge-orange' : 'badge-default'
            }`} style={{ fontSize: 10, marginRight: 4 }}>
              {c.type}
            </span>
            <span style={{ color: 'var(--color-text-secondary)' }}>{c.content}</span>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 1 }}>
              {c.source} &middot; {formatDate(c.createdAt)}
              {c.state === 'addressed' && c.addressedBy && (
                <span> &middot; addressed by {c.addressedBy}</span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function CommentForm({
  partId,
  type,
  content,
  submitting,
  onChangeType,
  onChangeContent,
  onChangePartId,
  onSubmit,
  onCancel,
  parts,
}: {
  partId?: string;
  type: string;
  content: string;
  submitting: boolean;
  onChangeType: (t: string) => void;
  onChangeContent: (c: string) => void;
  onChangePartId: (p: string | undefined) => void;
  onSubmit: () => void;
  onCancel: () => void;
  parts: Array<{ partId: string; title: string }>;
}) {
  return (
    <div style={{
      padding: '10px 16px',
      borderBottom: '1px solid var(--color-border-default)',
      background: 'var(--color-bg-surface)',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select
          value={partId || ''}
          onChange={(e) => onChangePartId(e.target.value || undefined)}
          style={{
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border-default)',
            borderRadius: 'var(--radius-md)',
            padding: '4px 8px',
            color: 'var(--color-text-secondary)',
            fontSize: 12,
            fontFamily: 'var(--font-sans)',
          }}
        >
          <option value="">Document-level</option>
          {parts.map(p => (
            <option key={p.partId} value={p.partId}>{p.partId}: {p.title}</option>
          ))}
        </select>
        <select
          value={type}
          onChange={(e) => onChangeType(e.target.value)}
          style={{
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border-default)',
            borderRadius: 'var(--radius-md)',
            padding: '4px 8px',
            color: 'var(--color-text-secondary)',
            fontSize: 12,
            fontFamily: 'var(--font-sans)',
          }}
        >
          {COMMENT_TYPES.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={content}
          onChange={(e) => onChangeContent(e.target.value)}
          placeholder="Your feedback..."
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); } }}
          style={{
            flex: 1,
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border-default)',
            borderRadius: 'var(--radius-md)',
            padding: '6px 10px',
            color: 'var(--color-text-primary)',
            fontSize: 13,
            fontFamily: 'var(--font-sans)',
            outline: 'none',
          }}
          autoFocus
        />
        <button
          onClick={onSubmit}
          disabled={submitting || !content.trim()}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '6px 12px',
            background: 'var(--color-accent)',
            color: 'var(--color-bg-root)',
            border: 'none',
            borderRadius: 'var(--radius-md)',
            fontSize: 12,
            fontWeight: 600,
            cursor: submitting || !content.trim() ? 'not-allowed' : 'pointer',
            opacity: submitting || !content.trim() ? 0.5 : 1,
            fontFamily: 'var(--font-sans)',
          }}
        >
          <Send size={12} />
          Send
        </button>
        <button
          onClick={onCancel}
          style={{
            background: 'transparent',
            border: '1px solid var(--color-border-default)',
            borderRadius: 'var(--radius-md)',
            padding: '6px 8px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <X size={14} style={{ color: 'var(--color-text-tertiary)' }} />
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function formatDate(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  } catch {
    return iso;
  }
}
