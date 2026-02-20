'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, X, Clock, Loader2, ExternalLink, Copy, Check, Terminal, GitFork, SquareTerminal, BookOpen, Circle, MessageSquareMore } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useAppMode } from '@/contexts/AppModeContext';
import { useMachineContext } from '@/contexts/MachineContext';
import { ChatTab, getPersistedLastN } from '@/components/sessions/tabs/ChatTab';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Session, SessionDetail } from '@/lib/types';
import { useExperiment } from '@/hooks/useExperiment';

type Scope = 'smart' | '24h' | '3d' | '7d' | '30d' | 'all';

const SCOPE_ESCALATION: Record<string, Scope | null> = {
  '24h': '3d',
  '3d': '7d',
  '7d': '30d',
  '30d': 'all',
  'all': null,
};

interface MilestoneResult {
  milestoneId: string;
  sessionId: string;
  milestoneIndex: number;
  title: string | null;
  type: string | null;
  description: string | null;
  outcome: string | null;
  facts: string[];
  concepts: string[];
  startTurn: number;
  endTurn: number;
  score: number;
  phase: 1 | 2;
  timestamp: string;
  filesModified: string[];
  userPrompts: string[];
}

interface KnowledgeSearchResult {
  type: string;
  knowledgeId?: string;
  partId?: string;
  text: string;
  score: number;
  timestamp?: string;
  contentType?: string;
  knowledgeTitle?: string;
  partTitle?: string;
  knowledgeType?: string;
}

interface KnowledgeFull {
  id: string;
  title: string;
  type: string;
  project: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  parts: Array<{ partId: string; title: string; summary: string; content: string }>;
}

interface KnowledgeCommentItem {
  id: string;
  knowledgeId: string;
  partId?: string;
  type: string;
  content: string;
  source: string;
  state: 'not_addressed' | 'addressed';
  createdAt: string;
}

const KNOWLEDGE_TYPE_COLORS: Record<string, string> = {
  algorithm: 'badge-blue',
  contract: 'badge-purple',
  schema: 'badge-green',
  wiring: 'badge-orange',
  invariant: 'badge-red',
  flow: 'badge-cyan',
};

const KNOWLEDGE_STATUS_COLORS: Record<string, string> = {
  active: 'badge-green',
  outdated: 'badge-orange',
  archived: 'badge-default',
};

interface DisplayResult {
  sessionId: string;
  projectPath: string;
  score: number;
  // Milestone fields (null when showing recent sessions)
  milestoneId?: string;
  milestoneIndex?: number;
  title: string | null;
  type: string | null;
  description: string | null;
  startTurn?: number;
  endTurn?: number;
  phase?: 1 | 2;
  facts?: string[];
  // Fallback fields for recent sessions
  matchedPrompts?: string[];
  numTurns: number;
  lastTimestamp: string;
  model: string;
  subagentCount: number;
  fileSize?: number;
}

interface SessionSearchProps {
  mode: 'page' | 'popup';
  initialQuery?: string;
  directory?: string;
  projectPath?: string;
  onClose?: () => void;
}

const SCOPES: { value: Scope; label: string }[] = [
  { value: 'smart', label: 'Smart' },
  { value: '24h', label: '24h' },
  { value: '3d', label: '3d' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
];

const TYPE_COLORS: Record<string, string> = {
  bugfix: 'badge-red',
  implementation: 'badge-green',
  discovery: 'badge-blue',
  refactor: 'badge-purple',
  decision: 'badge-amber',
  configuration: 'badge-default',
};

function timeAgo(ts: string): string {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SessionSearch({ mode, initialQuery = '', directory: initialDirectory, projectPath: initialProjectPath, onClose }: SessionSearchProps) {
  const { apiClient } = useAppMode();
  const { selectedMachine } = useMachineContext();
  const machineId = selectedMachine?.id;
  const router = useRouter();
  const { isExperiment } = useExperiment();

  const [query, setQuery] = useState(initialQuery);
  const [directory, setDirectory] = useState(initialDirectory);
  const [scope, setScope] = useState<Scope>('smart');
  const [effectiveScope, setEffectiveScope] = useState<string>('');
  const [searchResults, setSearchResults] = useState<MilestoneResult[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedStartTurn, setSelectedStartTurn] = useState<number | undefined>();
  const [selectedMilestoneId, setSelectedMilestoneId] = useState<string | undefined>();
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [searching, setSearching] = useState(false);
  const [recentMilestones, setRecentMilestones] = useState<DisplayResult[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);
  const [previewLastN, setPreviewLastN] = useState(getPersistedLastN);
  const [copiedId, setCopiedId] = useState(false);
  const [knowledgeResults, setKnowledgeResults] = useState<KnowledgeSearchResult[]>([]);
  const [selectedKnowledgeId, setSelectedKnowledgeId] = useState<string | null>(null);
  const [selectedKnowledgePartId, setSelectedKnowledgePartId] = useState<string | null>(null);
  const [knowledgeDetail, setKnowledgeDetail] = useState<KnowledgeFull | null>(null);
  const [knowledgeComments, setKnowledgeComments] = useState<KnowledgeCommentItem[]>([]);
  const [loadingKnowledge, setLoadingKnowledge] = useState(false);
  const [highlightKnowledgePartId, setHighlightKnowledgePartId] = useState<string | null>(null);

  // Recent knowledge for default view (no query)
  const [recentKnowledge, setRecentKnowledge] = useState<Array<{
    id: string; title: string; type: string; updatedAt: string;
    sourceTimestamp?: string; sourceSessionId?: string;
    parts: Array<{ partId: string; title: string; summary: string }>;
  }>>([]);
  const [loadingRecentKnowledge, setLoadingRecentKnowledge] = useState(false);

  // Search config: which result types to include
  const [searchFilter, setSearchFilter] = useState<'knowledge' | 'milestones' | 'both'>('both');
  const searchIncludeKnowledge = searchFilter === 'knowledge' || searchFilter === 'both';
  const searchIncludeMilestones = searchFilter === 'milestones' || searchFilter === 'both';

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const inputRef = useRef<HTMLInputElement>(null);
  const userSelectedRef = useRef(false);

  // Focus input on mount + cleanup debounce on unmount
  useEffect(() => {
    inputRef.current?.focus();
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  // Load search config on mount
  useEffect(() => {
    const port = process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100';
    const base = typeof window !== 'undefined' ? `http://${window.location.hostname}:${port}` : 'http://localhost:3100';
    fetch(`${base}/claude-code/config`)
      .then(r => r.ok ? r.json() : null)
      .then(json => {
        if (json?.data) {
          const inclK = typeof json.data.searchIncludeKnowledge === 'boolean' ? json.data.searchIncludeKnowledge : true;
          const inclM = typeof json.data.searchIncludeMilestones === 'boolean' ? json.data.searchIncludeMilestones : true;
          if (inclK && inclM) setSearchFilter('both');
          else if (inclK) setSearchFilter('knowledge');
          else if (inclM) setSearchFilter('milestones');
          else setSearchFilter('both');
        }
      })
      .catch(() => {});
  }, []);

  // Load recent milestones on mount (gated by searchIncludeMilestones)
  useEffect(() => {
    if (!searchIncludeMilestones) {
      setRecentMilestones([]);
      setLoadingRecent(false);
      return;
    }
    let cancelled = false;
    setLoadingRecent(true);
    apiClient.getRecentMilestones(machineId, { projectPath: initialProjectPath, directory })
      .then((res: { results: MilestoneResult[] }) => {
        if (cancelled) return;
        setRecentMilestones((res.results || []).map(r => ({
          sessionId: r.sessionId,
          projectPath: '',
          score: 0,
          milestoneId: r.milestoneId,
          milestoneIndex: r.milestoneIndex,
          title: r.title,
          type: r.type,
          description: r.description,
          startTurn: r.startTurn,
          endTurn: r.endTurn,
          phase: r.phase,
          facts: r.facts,
          matchedPrompts: r.userPrompts,
          numTurns: r.endTurn - r.startTurn,
          lastTimestamp: r.timestamp,
          model: '',
          subagentCount: 0,
        })));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingRecent(false); });
    return () => { cancelled = true; };
  }, [apiClient, machineId, initialProjectPath, directory, searchIncludeMilestones]);

  // Load recent knowledge on mount (gated by searchIncludeKnowledge)
  useEffect(() => {
    if (!searchIncludeKnowledge) {
      setRecentKnowledge([]);
      setLoadingRecentKnowledge(false);
      return;
    }
    let cancelled = false;
    setLoadingRecentKnowledge(true);
    const port = process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100';
    const base = typeof window !== 'undefined' ? `http://${window.location.hostname}:${port}` : 'http://localhost:3100';
    fetch(`${base}/knowledge`)
      .then(r => r.ok ? r.json() : null)
      .then(json => {
        if (cancelled) return;
        const items = (json?.data || []) as Array<{
          id: string; title: string; type: string; updatedAt: string;
          sourceTimestamp?: string; sourceSessionId?: string;
          parts: Array<{ partId: string; title: string; summary: string }>;
        }>;
        // Sort by sourceTimestamp (original production time) descending, fallback to updatedAt
        items.sort((a, b) => new Date(b.sourceTimestamp || b.updatedAt).getTime() - new Date(a.sourceTimestamp || a.updatedAt).getTime());
        setRecentKnowledge(items);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingRecentKnowledge(false); });
    return () => { cancelled = true; };
  }, [searchIncludeKnowledge]);

  // Knowledge search (parallel, non-blocking) — gated by searchIncludeKnowledge
  const doKnowledgeSearch = useCallback(async (q: string) => {
    if (!searchIncludeKnowledge) { setKnowledgeResults([]); return; }
    if (!q.trim()) { setKnowledgeResults([]); return; }
    try {
      const port = process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100';
      const base = typeof window !== 'undefined' ? `http://${window.location.hostname}:${port}` : 'http://localhost:3100';
      const res = await fetch(`${base}/knowledge/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) { setKnowledgeResults([]); return; }
      const json = await res.json();
      setKnowledgeResults(json.data || []);
    } catch {
      setKnowledgeResults([]);
    }
  }, [searchIncludeKnowledge]);

  // Milestone search on keystroke (debounced) — smart scope auto-escalates
  const doSearch = useCallback(async (q: string, s: Scope) => {
    if (!q.trim()) {
      setSearchResults([]);
      setKnowledgeResults([]);
      setEffectiveScope('');
      return;
    }
    setSearching(true);
    doKnowledgeSearch(q); // fire in parallel

    // Skip milestone search if disabled
    if (!searchIncludeMilestones) {
      setSearchResults([]);
      setEffectiveScope('');
      setSearching(false);
      return;
    }

    const searchOpts: Record<string, any> = { limit: 50 };
    if (directory) searchOpts.directory = directory;
    if (initialProjectPath) searchOpts.projectPath = initialProjectPath;
    try {
      if (s === 'smart') {
        let currentScope: Scope | null = '24h';
        while (currentScope) {
          const res = await apiClient.searchSessions(q, { ...searchOpts, scope: currentScope }, machineId);
          if ((res.results || []).length > 0) {
            setSearchResults(res.results);
            setEffectiveScope(currentScope);
            return;
          }
          currentScope = SCOPE_ESCALATION[currentScope] || null;
        }
        setSearchResults([]);
        setEffectiveScope('all');
      } else {
        const res = await apiClient.searchSessions(q, { ...searchOpts, scope: s }, machineId);
        setSearchResults(res.results || []);
        setEffectiveScope(s);
      }
    } catch {
      // ignore
    } finally {
      setSearching(false);
    }
  }, [apiClient, machineId, directory, initialProjectPath, doKnowledgeSearch, searchIncludeMilestones]);

  // Debounced input handler
  const handleInputChange = useCallback((value: string) => {
    setQuery(value);
    userSelectedRef.current = false;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value, scope), 200);
  }, [doSearch, scope]);

  // Re-search when scope or directory changes
  useEffect(() => {
    if (query.trim()) {
      doSearch(query, scope);
    }
  }, [scope, directory, searchFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load session preview
  useEffect(() => {
    if (!selectedSessionId) {
      setSessionDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingPreview(true);
    apiClient.getSessionConversation(selectedSessionId, { lastN: previewLastN }, machineId)
      .then(detail => {
        if (!cancelled) setSessionDetail(detail);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingPreview(false);
      });
    return () => { cancelled = true; };
  }, [selectedSessionId, apiClient, machineId, previewLastN]);

  // Load knowledge preview
  useEffect(() => {
    if (!selectedKnowledgeId) {
      setKnowledgeDetail(null);
      setKnowledgeComments([]);
      return;
    }
    let cancelled = false;
    setLoadingKnowledge(true);
    const port = process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100';
    const base = typeof window !== 'undefined' ? `http://${window.location.hostname}:${port}` : 'http://localhost:3100';
    Promise.all([
      fetch(`${base}/knowledge/${selectedKnowledgeId}`).then(r => r.json()),
      fetch(`${base}/knowledge/${selectedKnowledgeId}/comments?includeAddressed=false`).then(r => r.json()),
    ]).then(([kJson, cJson]) => {
      if (cancelled) return;
      setKnowledgeDetail(kJson.data || null);
      setKnowledgeComments(cJson.data || []);
    }).catch(() => {
      if (!cancelled) {
        setKnowledgeDetail(null);
        setKnowledgeComments([]);
      }
    }).finally(() => {
      if (!cancelled) setLoadingKnowledge(false);
    });
    return () => { cancelled = true; };
  }, [selectedKnowledgeId]);

  // Scroll to knowledge part after detail loads
  useEffect(() => {
    if (selectedKnowledgePartId && knowledgeDetail) {
      setHighlightKnowledgePartId(selectedKnowledgePartId);
      requestAnimationFrame(() => {
        const el = document.getElementById(`search-kpart-${selectedKnowledgePartId}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      setTimeout(() => setHighlightKnowledgePartId(null), 2000);
    }
  }, [selectedKnowledgePartId, knowledgeDetail]);

  // Convert milestone results to display results
  const displaySearchResults: DisplayResult[] = useMemo(() => {
    return searchResults.map(r => ({
      sessionId: r.sessionId,
      projectPath: '', // milestones don't carry projectPath
      score: r.score,
      milestoneId: r.milestoneId,
      milestoneIndex: r.milestoneIndex,
      title: r.title,
      type: r.type,
      description: r.description,
      startTurn: r.startTurn,
      endTurn: r.endTurn,
      phase: r.phase,
      facts: r.facts,
      matchedPrompts: r.userPrompts,
      numTurns: r.endTurn - r.startTurn,
      lastTimestamp: r.timestamp,
      model: '',
      subagentCount: 0,
    }));
  }, [searchResults]);

  // Show search results when query present, recent milestones when empty
  const displayResults = query.trim() ? displaySearchResults : recentMilestones;

  // Auto-select first result unless user manually picked one
  useEffect(() => {
    if (userSelectedRef.current) return;
    // When searching: prefer first knowledge result, then first milestone
    if (query.trim()) {
      if (knowledgeResults.length > 0) {
        setSelectedSessionId(null);
        setSelectedStartTurn(undefined);
        setSelectedMilestoneId(undefined);
        setSelectedKnowledgeId(knowledgeResults[0].knowledgeId || null);
        setSelectedKnowledgePartId(knowledgeResults[0].partId || null);
      } else {
        const first = displayResults[0];
        if (first) {
          setSelectedKnowledgeId(null);
          setSelectedKnowledgePartId(null);
          setSelectedSessionId(first.sessionId);
          setSelectedStartTurn(first.startTurn);
          setSelectedMilestoneId(first.milestoneId);
        } else {
          setSelectedSessionId(null);
          setSelectedStartTurn(undefined);
          setSelectedMilestoneId(undefined);
          setSelectedKnowledgeId(null);
          setSelectedKnowledgePartId(null);
        }
      }
    } else {
      // Default view: prefer first recent knowledge, then first recent milestone
      if (recentKnowledge.length > 0) {
        setSelectedSessionId(null);
        setSelectedStartTurn(undefined);
        setSelectedMilestoneId(undefined);
        setSelectedKnowledgeId(recentKnowledge[0].id);
        setSelectedKnowledgePartId(null);
      } else {
        const first = displayResults[0];
        if (first) {
          setSelectedKnowledgeId(null);
          setSelectedKnowledgePartId(null);
          setSelectedSessionId(first.sessionId);
          setSelectedStartTurn(first.startTurn);
          setSelectedMilestoneId(first.milestoneId);
        } else {
          setSelectedSessionId(null);
          setSelectedStartTurn(undefined);
          setSelectedMilestoneId(undefined);
          setSelectedKnowledgeId(null);
          setSelectedKnowledgePartId(null);
        }
      }
    }
  }, [displayResults, recentKnowledge, knowledgeResults, query]);

  // Filter preview messages to user+assistant only
  const previewMessages = useMemo(() => {
    if (!sessionDetail?.messages) return [];
    return sessionDetail.messages.filter(m => m.type === 'human' || m.type === 'assistant');
  }, [sessionDetail]);

  const containerStyle: React.CSSProperties = mode === 'page'
    ? { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }
    : { display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' };

  return (
    <div style={containerStyle}>
      {/* Search header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--color-border-default)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search
            size={14}
            style={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--color-text-tertiary)',
            }}
          />
          <input
            ref={inputRef}
            className="input input-with-icon"
            placeholder={searchIncludeKnowledge && searchIncludeMilestones ? 'Search knowledge & milestones...' : searchIncludeKnowledge ? 'Search knowledge...' : searchIncludeMilestones ? 'Search milestones...' : 'Search...'}
            style={{ paddingLeft: 28, fontSize: 12 }}
            value={query}
            onChange={e => handleInputChange(e.target.value)}
          />
          {query && (
            <button
              onClick={() => { setQuery(''); setSearchResults([]); setKnowledgeResults([]); setSelectedKnowledgeId(null); setSelectedKnowledgePartId(null); userSelectedRef.current = false; }}
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'none',
                border: 'none',
                color: 'var(--color-text-tertiary)',
                cursor: 'pointer',
                padding: 2,
                display: 'flex',
              }}
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* Directory scope badge */}
        {directory && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '3px 8px', borderRadius: 'var(--radius-sm)',
            background: 'var(--color-accent-glow)',
            fontSize: 10, fontFamily: 'var(--font-mono)',
            color: 'var(--color-accent)', flexShrink: 0,
          }}>
            <span>{directory}/</span>
            <button
              onClick={() => setDirectory(undefined)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--color-accent)', padding: 0, display: 'flex',
              }}
              title="Clear directory filter"
            >
              <X size={10} />
            </button>
          </div>
        )}

        {/* Filter toggle: Knowledge / Milestones / Both — only shown in experiment mode */}
        {isExperiment && (
          <div style={{ display: 'flex', gap: 2, borderRight: '1px solid var(--color-border-subtle)', paddingRight: 6, marginRight: 2 }}>
            {(['both', 'knowledge', 'milestones'] as const).map(f => (
              <button
                key={f}
                onClick={() => setSearchFilter(f)}
                style={{
                  padding: '4px 8px',
                  fontSize: 10,
                  fontWeight: 500,
                  borderRadius: 'var(--radius-sm)',
                  border: 'none',
                  cursor: 'pointer',
                  background: searchFilter === f ? 'var(--color-accent-glow)' : 'transparent',
                  color: searchFilter === f ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
                  transition: 'all 100ms ease',
                  textTransform: 'capitalize',
                }}
              >
                {f === 'both' ? 'Both' : f === 'knowledge' ? 'Knowledge' : 'Milestones'}
              </button>
            ))}
          </div>
        )}

        {/* Scope selector */}
        <div style={{ display: 'flex', gap: 2 }}>
          {SCOPES.map(s => (
            <button
              key={s.value}
              onClick={() => setScope(s.value)}
              style={{
                padding: '4px 8px',
                fontSize: 10,
                fontWeight: 500,
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                cursor: 'pointer',
                background: scope === s.value ? 'var(--color-accent-glow)' : 'transparent',
                color: scope === s.value ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
                transition: 'all 100ms ease',
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        {mode === 'popup' && onClose && (
          <button
            onClick={onClose}
            className="btn btn-ghost btn-icon"
            style={{ flexShrink: 0 }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Search intro when empty */}
      {!query.trim() && (
        <div style={{
          padding: '6px 16px',
          fontSize: 11,
          color: 'var(--color-text-tertiary)',
          borderBottom: '1px solid var(--color-border-subtle)',
          lineHeight: 1.5,
        }}>
          <span><strong style={{ color: 'var(--color-text-secondary)' }}>Type</strong> to search {searchIncludeKnowledge && searchIncludeMilestones ? 'knowledge & milestones' : searchIncludeKnowledge ? 'knowledge' : searchIncludeMilestones ? 'milestones' : '...'}</span>
        </div>
      )}

      {/* Smart scope indicator */}
      {scope === 'smart' && effectiveScope && query.trim() && !searching && (
        <div style={{
          padding: '4px 16px',
          fontSize: 10,
          color: 'var(--color-text-tertiary)',
          borderBottom: '1px solid var(--color-border-subtle)',
        }}>
          Searched: {effectiveScope === 'all' ? 'all time' : `last ${effectiveScope}`}
          {displaySearchResults.length === 0 && ' — no results'}
        </div>
      )}

      {/* Main content area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Results list */}
        <div style={{
          width: (selectedSessionId || selectedKnowledgeId) ? '40%' : '100%',
          minWidth: 300,
          overflow: 'auto',
          borderRight: (selectedSessionId || selectedKnowledgeId) ? '1px solid var(--color-border-default)' : 'none',
          transition: 'width 200ms ease',
        }}>
          {displayResults.length === 0 && knowledgeResults.length === 0 && query && !searching ? (
            <div className="empty-state" style={{ padding: '32px 16px' }}>
              <Search size={32} className="empty-state-icon" />
              <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>No results found</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                Try broadening your search or changing the scope
              </div>
            </div>
          ) : displayResults.length === 0 && knowledgeResults.length === 0 && recentKnowledge.length === 0 && !query ? (
            <div className="empty-state" style={{ padding: '32px 16px' }}>
              {loadingRecent || loadingRecentKnowledge ? (
                <>
                  <Loader2 size={24} className="spin" style={{ color: 'var(--color-text-tertiary)' }} />
                  <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading recent entries...</div>
                </>
              ) : (
                <>
                  <Search size={32} className="empty-state-icon" />
                  <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>No recent entries found</div>
                </>
              )}
            </div>
          ) : (
            <div style={{ padding: 4 }}>
              {/* Knowledge results */}
              {knowledgeResults.length > 0 && query.trim() && (
                <>
                  <div style={{
                    padding: '4px 12px 6px',
                    fontSize: 10,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: 'var(--color-text-tertiary)',
                  }}>
                    Knowledge
                  </div>
                  {knowledgeResults.map((kr, ki) => (
                    <button
                      key={`k-${ki}`}
                      onClick={() => {
                        userSelectedRef.current = true;
                        setSelectedSessionId(null);
                        setSelectedStartTurn(undefined);
                        setSelectedMilestoneId(undefined);
                        setSelectedKnowledgeId(kr.knowledgeId || null);
                        setSelectedKnowledgePartId(kr.partId || null);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 12px',
                        background: selectedKnowledgeId === kr.knowledgeId && selectedKnowledgePartId === (kr.partId || null)
                          ? 'var(--color-accent-glow)' : 'transparent',
                        border: 'none',
                        borderLeft: selectedKnowledgeId === kr.knowledgeId && selectedKnowledgePartId === (kr.partId || null)
                          ? '3px solid var(--color-accent)' : '3px solid transparent',
                        borderRadius: 'var(--radius-md)',
                        cursor: 'pointer',
                        marginBottom: 2,
                      }}
                      onMouseEnter={e => {
                        if (!(selectedKnowledgeId === kr.knowledgeId && selectedKnowledgePartId === (kr.partId || null)))
                          e.currentTarget.style.background = 'var(--color-bg-hover)';
                      }}
                      onMouseLeave={e => {
                        if (!(selectedKnowledgeId === kr.knowledgeId && selectedKnowledgePartId === (kr.partId || null)))
                          e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <BookOpen size={12} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
                        <span style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: 'var(--color-text-primary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {kr.knowledgeTitle && kr.partTitle
                            ? <>{kr.knowledgeTitle} <span style={{ color: 'var(--color-text-tertiary)' }}>&rarr;</span> {kr.partTitle}</>
                            : kr.knowledgeTitle || `${kr.partId || kr.knowledgeId}: ${kr.text}`}
                        </span>
                        {kr.knowledgeType && (
                          <span className={`badge ${KNOWLEDGE_TYPE_COLORS[kr.knowledgeType] || 'badge-default'}`} style={{ fontSize: 9, flexShrink: 0 }}>
                            {kr.knowledgeType}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2, paddingLeft: 18 }}>
                        {kr.partId || kr.knowledgeId} &middot; Score: {typeof kr.score === 'number' ? kr.score.toFixed(3) : kr.score}
                        {kr.timestamp && <> &middot; {timeAgo(kr.timestamp)}</>}
                      </div>
                    </button>
                  ))}
                  {displayResults.length > 0 && (
                    <div style={{
                      padding: '6px 12px 4px',
                      fontSize: 10,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'var(--color-text-tertiary)',
                    }}>
                      Milestones
                    </div>
                  )}
                </>
              )}
              {/* Recent knowledge (default view, no query) */}
              {!query.trim() && recentKnowledge.length > 0 && (
                <>
                  <div style={{
                    padding: '4px 12px 6px',
                    fontSize: 10,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: 'var(--color-text-tertiary)',
                  }}>
                    Recent Knowledge
                  </div>
                  {recentKnowledge.map((k) => (
                    <button
                      key={`rk-${k.id}`}
                      onClick={() => {
                        userSelectedRef.current = true;
                        setSelectedSessionId(null);
                        setSelectedStartTurn(undefined);
                        setSelectedMilestoneId(undefined);
                        setSelectedKnowledgeId(k.id);
                        setSelectedKnowledgePartId(null);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 12px',
                        background: selectedKnowledgeId === k.id && !selectedKnowledgePartId
                          ? 'var(--color-accent-glow)' : 'transparent',
                        border: 'none',
                        borderLeft: selectedKnowledgeId === k.id && !selectedKnowledgePartId
                          ? '3px solid var(--color-accent)' : '3px solid transparent',
                        borderRadius: 'var(--radius-md)',
                        cursor: 'pointer',
                        marginBottom: 2,
                      }}
                      onMouseEnter={e => {
                        if (!(selectedKnowledgeId === k.id && !selectedKnowledgePartId))
                          e.currentTarget.style.background = 'var(--color-bg-hover)';
                      }}
                      onMouseLeave={e => {
                        if (!(selectedKnowledgeId === k.id && !selectedKnowledgePartId))
                          e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <BookOpen size={12} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
                        <span style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: 'var(--color-text-primary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                          minWidth: 0,
                        }}>
                          {k.title}
                        </span>
                        {k.type && (
                          <span className={`badge ${KNOWLEDGE_TYPE_COLORS[k.type] || 'badge-default'}`} style={{ fontSize: 9, flexShrink: 0 }}>
                            {k.type}
                          </span>
                        )}
                        {k.sourceSessionId && (
                          <span
                            onClick={(e) => {
                              e.stopPropagation();
                              window.open(`/sessions?session=${k.sourceSessionId}&tab=chat`, '_blank');
                              onClose?.();
                            }}
                            title="Open source session"
                            style={{
                              flexShrink: 0,
                              display: 'inline-flex',
                              alignItems: 'center',
                              padding: '2px 4px',
                              borderRadius: 'var(--radius-sm)',
                              color: 'var(--color-text-tertiary)',
                              cursor: 'pointer',
                              transition: 'color 100ms',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent)'; }}
                            onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}
                          >
                            <ExternalLink size={10} />
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2, paddingLeft: 18, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>{k.id}</span>
                        <span>&middot;</span>
                        <span>{k.parts.length} part{k.parts.length !== 1 ? 's' : ''}</span>
                        <span>&middot;</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                          <Clock size={10} />
                          {timeAgo(k.sourceTimestamp || k.updatedAt)}
                        </span>
                      </div>
                    </button>
                  ))}
                </>
              )}
              {!query.trim() && displayResults.length > 0 && (
                <div style={{
                  padding: '4px 12px 6px',
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: 'var(--color-text-tertiary)',
                }}>
                  Recent Milestones
                </div>
              )}
              {displayResults.map((r, i) => {
                const isSelected = selectedSessionId === r.sessionId
                  && (!r.milestoneId || selectedStartTurn === r.startTurn);
                const isMilestone = !!r.milestoneId;
                const typeBadge = r.type ? TYPE_COLORS[r.type] || 'badge-default' : 'badge-default';

                const navigateToMilestone = (e: React.MouseEvent) => {
                  e.stopPropagation();
                  const params = new URLSearchParams();
                  params.set('session', r.sessionId);
                  params.set('tab', 'chat');
                  if (r.milestoneId) params.set('milestone', r.milestoneId);
                  router.push(`/sessions?${params.toString()}`);
                  onClose?.();
                };

                return (
                  <button
                    key={r.milestoneId || r.sessionId + '-' + i}
                    onClick={() => {
                      userSelectedRef.current = true;
                      setSelectedKnowledgeId(null);
                      setSelectedKnowledgePartId(null);
                      if (isSelected) {
                        setSelectedSessionId(null);
                        setSelectedStartTurn(undefined);
                        setSelectedMilestoneId(undefined);
                      } else {
                        setSelectedSessionId(r.sessionId);
                        setSelectedStartTurn(r.startTurn);
                        setSelectedMilestoneId(r.milestoneId);
                      }
                    }}
                    onDoubleClick={navigateToMilestone}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 12px',
                      borderRadius: 'var(--radius-md)',
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                      transition: 'all 100ms ease',
                      background: isSelected
                        ? 'var(--color-accent-glow)'
                        : 'transparent',
                      borderLeft: isSelected
                        ? '3px solid var(--color-accent)'
                        : '3px solid transparent',
                    }}
                    onMouseEnter={e => {
                      if (!isSelected) {
                        e.currentTarget.style.background = 'var(--color-bg-hover)';
                      }
                    }}
                    onMouseLeave={e => {
                      if (!isSelected) {
                        e.currentTarget.style.background = 'transparent';
                      }
                    }}
                  >
                    {/* Row 1: type badge + title/prompt */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, overflow: 'hidden' }}>
                      {isMilestone && r.type && (
                        <span
                          className={`badge ${typeBadge}`}
                          style={{ fontSize: 9, padding: '1px 6px', flexShrink: 0 }}
                        >
                          {r.type}
                        </span>
                      )}
                      <span style={{
                        fontSize: 11,
                        color: 'var(--color-text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                        flex: 1,
                      }}>
                        {r.title || r.matchedPrompts?.[0] || 'No preview'}
                      </span>
                      {isMilestone && (
                        <span
                          onClick={navigateToMilestone}
                          title="Open in session detail"
                          style={{
                            flexShrink: 0,
                            display: 'inline-flex',
                            alignItems: 'center',
                            padding: '2px 4px',
                            borderRadius: 'var(--radius-sm)',
                            color: 'var(--color-text-tertiary)',
                            cursor: 'pointer',
                            transition: 'color 100ms',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent)'; }}
                          onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}
                        >
                          <ExternalLink size={10} />
                        </span>
                      )}
                    </div>

                    {/* Row 2: description (milestone) or meta */}
                    {isMilestone && r.description && (
                      <div style={{
                        fontSize: 10,
                        color: 'var(--color-text-secondary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        marginBottom: 2,
                      }}>
                        {r.description}
                      </div>
                    )}

                    {/* Row 3: meta */}
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 10,
                      color: 'var(--color-text-tertiary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                    }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                        <Clock size={10} />
                        {timeAgo(r.lastTimestamp)}
                      </span>
                      {isMilestone ? (
                        <>
                          <span style={{ flexShrink: 0 }}>turns {r.startTurn}-{r.endTurn}</span>
                          {r.phase === 2 && (
                            <span className="badge badge-green" style={{ fontSize: 8, padding: '0 4px' }}>P2</span>
                          )}
                          {r.facts && r.facts.length > 0 && (
                            <span style={{ flexShrink: 0 }}>{r.facts.length} facts</span>
                          )}
                        </>
                      ) : (
                        <>
                          <span style={{ flexShrink: 0 }}>{r.numTurns}t</span>
                          {r.model && <span style={{ flexShrink: 0 }}>{r.model}</span>}
                          {r.subagentCount > 0 && (
                            <span style={{ flexShrink: 0 }}>{r.subagentCount} sub</span>
                          )}
                        </>
                      )}
                      <span style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        direction: 'rtl',
                        textAlign: 'left',
                        minWidth: 0,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 9,
                      }}>
                        {r.sessionId.slice(0, 8)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Session preview */}
        {selectedSessionId && !selectedKnowledgeId && (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {loadingPreview ? (
              <div style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                color: 'var(--color-text-tertiary)',
                fontSize: 12,
              }}>
                <Loader2 size={14} className="spin" />
                Loading session...
              </div>
            ) : sessionDetail ? (
              <div style={{ flex: 1, overflow: 'hidden' }}>
                {/* Preview header */}
                <div style={{
                  padding: '6px 12px',
                  borderBottom: '1px solid var(--color-border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 11,
                  color: 'var(--color-text-secondary)',
                }}>
                  <span
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 10, cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'transparent' }}
                    title="Open in session viewer"
                    onClick={() => router.push(`/sessions?session=${selectedSessionId}`)}
                    onMouseEnter={(e) => (e.currentTarget.style.textDecorationColor = 'currentColor')}
                    onMouseLeave={(e) => (e.currentTarget.style.textDecorationColor = 'transparent')}
                  >
                    {selectedSessionId.slice(0, 12)}...
                  </span>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      navigator.clipboard.writeText(selectedSessionId);
                      setCopiedId(true);
                      setTimeout(() => setCopiedId(false), 1500);
                    }}
                    title="Copy Session ID"
                    style={{ padding: '1px 3px', flexShrink: 0 }}
                  >
                    {copiedId ? <Check size={10} style={{ color: 'var(--color-status-green)' }} /> : <Copy size={10} />}
                  </button>
                  {sessionDetail.model && (
                    <span className="badge badge-default" style={{ fontSize: 9 }}>
                      {sessionDetail.model}
                    </span>
                  )}
                  {sessionDetail.numTurns && (
                    <span>{sessionDetail.numTurns} turns</span>
                  )}
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => window.open(`/console?sessionId=${encodeURIComponent(selectedSessionId)}&projectPath=${encodeURIComponent(sessionDetail.projectPath || '')}`, '_blank')}
                      title="Open Console"
                      style={{ padding: '1px 3px' }}
                    >
                      <Terminal size={11} />
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => window.open(`/console?sessionId=${encodeURIComponent(selectedSessionId)}&projectPath=${encodeURIComponent(sessionDetail.projectPath || '')}&fork=true`, '_blank')}
                      title="Fork Session"
                      style={{ padding: '1px 3px' }}
                    >
                      <GitFork size={11} />
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => window.open(`/console?shell=true&projectPath=${encodeURIComponent(sessionDetail.projectPath || '')}`, '_blank')}
                      title="New Shell"
                      style={{ padding: '1px 3px' }}
                    >
                      <SquareTerminal size={11} />
                    </button>
                    <button
                      onClick={() => { setSelectedSessionId(null); setSelectedMilestoneId(undefined); }}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--color-text-tertiary)',
                        cursor: 'pointer',
                        padding: 2,
                        display: 'flex',
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>

                {/* Chat messages */}
                <div style={{ flex: 1, overflow: 'auto', height: 'calc(100% - 32px)' }}>
                  <ChatTab
                    key={selectedMilestoneId || selectedSessionId}
                    messages={previewMessages}
                    sessionId={selectedSessionId}
                    machineId={machineId}
                    projectPath={sessionDetail.projectPath}
                    onLastNChange={setPreviewLastN}
                    highlightMilestoneId={selectedMilestoneId}
                  />
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <div style={{ fontSize: 12 }}>Failed to load session</div>
              </div>
            )}
          </div>
        )}

        {/* Knowledge preview */}
        {selectedKnowledgeId && (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {loadingKnowledge ? (
              <div style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                color: 'var(--color-text-tertiary)',
                fontSize: 12,
              }}>
                <Loader2 size={14} className="spin" />
                Loading knowledge...
              </div>
            ) : knowledgeDetail ? (
              <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                {/* Knowledge header */}
                <div style={{
                  padding: '8px 12px',
                  borderBottom: '1px solid var(--color-border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexShrink: 0,
                }}>
                  <BookOpen size={14} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--color-text-primary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}>
                      {knowledgeDetail.id}: {knowledgeDetail.title}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                      <span className={`badge ${KNOWLEDGE_TYPE_COLORS[knowledgeDetail.type] || 'badge-default'}`} style={{ fontSize: 9 }}>
                        {knowledgeDetail.type}
                      </span>
                      <span className={`badge ${KNOWLEDGE_STATUS_COLORS[knowledgeDetail.status] || 'badge-default'}`} style={{ fontSize: 9 }}>
                        {knowledgeDetail.status}
                      </span>
                      {knowledgeComments.length > 0 && (
                        <span className="badge badge-orange" style={{ fontSize: 9, display: 'flex', alignItems: 'center', gap: 2 }}>
                          <Circle size={5} fill="currentColor" />
                          {knowledgeComments.length} unaddressed
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <span
                      onClick={() => {
                        router.push(`/knowledge?id=${knowledgeDetail.id}${selectedKnowledgePartId ? `&part=${selectedKnowledgePartId}` : ''}`);
                        onClose?.();
                      }}
                      title="Open in Knowledge Navigator"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '2px 4px',
                        borderRadius: 'var(--radius-sm)',
                        color: 'var(--color-text-tertiary)',
                        cursor: 'pointer',
                        transition: 'color 100ms',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent)'; }}
                      onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}
                    >
                      <ExternalLink size={11} />
                    </span>
                    <button
                      onClick={() => { setSelectedKnowledgeId(null); setSelectedKnowledgePartId(null); }}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--color-text-tertiary)',
                        cursor: 'pointer',
                        padding: 2,
                        display: 'flex',
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>

                {/* Knowledge content */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px 16px' }}>
                  {/* Document-level comments */}
                  {knowledgeComments.filter(c => !c.partId).length > 0 && (
                    <KnowledgeCommentBlock
                      comments={knowledgeComments.filter(c => !c.partId)}
                      label="Document comments"
                    />
                  )}

                  {/* Parts */}
                  {knowledgeDetail.parts.map(part => {
                    const partCmts = knowledgeComments.filter(c => c.partId === part.partId);
                    const md = part.content ? `${part.summary}\n\n${part.content}` : part.summary;
                    const isHighlighted = highlightKnowledgePartId === part.partId;

                    return (
                      <div
                        key={part.partId}
                        id={`search-kpart-${part.partId}`}
                        style={{
                          marginBottom: 12,
                          padding: '10px 12px',
                          borderRadius: 'var(--radius-md)',
                          background: isHighlighted ? 'var(--color-accent-glow)' : 'var(--color-bg-surface)',
                          border: `1px solid ${isHighlighted ? 'var(--color-accent)' : 'var(--color-border-default)'}`,
                          transition: 'background 0.6s, border-color 0.6s',
                        }}
                      >
                        {/* Part heading */}
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          marginBottom: 6,
                        }}>
                          <span style={{
                            fontSize: 10,
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--color-accent)',
                            fontWeight: 600,
                          }}>
                            {part.partId}
                          </span>
                          <span style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: 'var(--color-text-primary)',
                            flex: 1,
                          }}>
                            {part.title}
                          </span>
                          {partCmts.length > 0 && (
                            <span className="badge badge-orange" style={{ fontSize: 9 }}>
                              <Circle size={5} fill="currentColor" />
                              {partCmts.length}
                            </span>
                          )}
                        </div>

                        {/* Markdown content */}
                        <div className="prose" style={{ fontSize: 12 }}>
                          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                            {md}
                          </ReactMarkdown>
                        </div>

                        {/* Part comments */}
                        {partCmts.length > 0 && (
                          <KnowledgeCommentBlock
                            comments={partCmts}
                            label={`Comments on ${part.partId}`}
                          />
                        )}
                      </div>
                    );
                  })}

                  {knowledgeDetail.parts.length === 0 && (
                    <div style={{ padding: 16, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 12 }}>
                      This document has no parts yet.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <div style={{ fontSize: 12 }}>Failed to load knowledge</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function KnowledgeCommentBlock({ comments, label }: { comments: KnowledgeCommentItem[]; label: string }) {
  return (
    <div style={{
      marginTop: 8,
      paddingTop: 6,
      borderTop: '1px solid var(--color-border-default)',
    }}>
      <div style={{
        fontSize: 10,
        fontWeight: 600,
        color: 'var(--color-text-tertiary)',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 4,
      }}>
        {label} ({comments.length})
      </div>
      {comments.map(c => (
        <div key={c.id} style={{
          display: 'flex',
          gap: 6,
          padding: '3px 0',
          fontSize: 11,
          alignItems: 'flex-start',
        }}>
          <Circle size={10} fill="var(--color-status-orange)" style={{ color: 'var(--color-status-orange)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span className={`badge ${
              c.type === 'outdated' ? 'badge-red' :
              c.type === 'update' ? 'badge-blue' :
              c.type === 'expand' ? 'badge-green' :
              c.type === 'remove' ? 'badge-orange' : 'badge-default'
            }`} style={{ fontSize: 9, marginRight: 3 }}>
              {c.type}
            </span>
            <span style={{ color: 'var(--color-text-secondary)' }}>{c.content}</span>
            <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 1 }}>
              {c.source}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
