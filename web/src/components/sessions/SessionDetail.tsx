'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useSessionDetail } from '@/hooks/useSessionDetail';
import { useExperiment } from '@/hooks/useExperiment';
import { usePlatform } from '@/hooks/usePlatform';
import { useHighlightValue } from '@/hooks/useHighlight';
import { useMachineContext } from '@/contexts/MachineContext';
import { useAppMode } from '@/contexts/AppModeContext';
import { MachineBadge } from '@/components/shared/MachineBadge';
import { ChatTab } from './tabs/ChatTab';
import { TasksTab } from './tabs/TasksTab';
import { FilesTab } from './tabs/FilesTab';
import { ThinkingTab } from './tabs/ThinkingTab';
import { GitTab } from './tabs/GitTab';
import { MetaTab } from './tabs/MetaTab';
import { ConsoleTab } from './tabs/ConsoleTab';
import { AgentsTab } from './tabs/AgentsTab';
import { PlansTab } from './tabs/PlansTab';
import { DbTab } from './tabs/DbTab';
import { JsonTab } from './tabs/JsonTab';
import { TeamTab } from './tabs/TeamTab';
import { DagTab } from './tabs/DagTab';
import { MilestonesTab } from './tabs/MilestonesTab';
import {
  RefreshCw,
  Copy,
  Check,
  Terminal as TerminalIcon,
  Loader2,
  Maximize2,
  Minimize2,
  ArrowLeft,
  ExternalLink,
  GitFork,
  SquareTerminal,
  ChevronDown,
} from 'lucide-react';
import { formatCost } from '@/lib/utils';
import { useDeviceInfo } from '@/hooks/useDeviceInfo';
import { extractFileChanges, extractThinkingBlocks, extractGitOperations, extractTasks, extractDbOperations, enrichSubagentStatus } from '@/lib/session-extractors';
import type { SessionDetail as SessionDetailType } from '@/lib/types';
import { isProcessManaged, managedByLabel } from '@/lib/types';

interface SessionDetailProps {
  sessionId: string;
  machineId?: string;
  onLastSuggestion?: (suggestion: { text: string; updatedAt?: string } | null) => void;
  onSubagents?: (subagents: import('@/lib/types').SubagentSession[]) => void;
  onDetailMeta?: (meta: { numTurns: number; lineCount: number; refetch: () => void }) => void;
  /** Callback to expose batch poll controls to parent */
  onPollControls?: (controls: {
    applyBatchCheck: (check: {
      exists: boolean;
      fileSize: number;
      agentIds: string[];
      lastModified: string;
      changed: boolean;
      agentsChanged: boolean;
    }) => void;
    pollState: { knownFileSize: number; knownAgentCount: number };
  }) => void;
  /** When true, disables internal polling — parent manages via onPollControls */
  externalPolling?: boolean;
  listNumTurns?: number;
  listLastModified?: string;
  /** Initial tab to select (from URL deep-link) */
  initialTab?: TabId;
  /** Milestone ID to highlight + scroll to (from URL deep-link) */
  highlightMilestoneId?: string;
  /** Navigate to a different session (used by parent link) */
  onSelectSession?: (sessionId: string, machineId?: string) => void;
}

type TabId = 'chat' | 'console' | 'tasks' | 'plans' | 'milestones' | 'files' | 'thinking' | 'git' | 'agents' | 'team' | 'dag' | 'db' | 'json' | 'meta';

// Session status badge config
function getStatusBadge(detail: SessionDetailType | null): { label: string; className: string } | null {
  if (!detail) return null;
  if (detail.isActive) return { label: 'Running', className: 'badge-green' };
  if (detail.status === 'error') return { label: 'Error', className: 'badge-red' };
  if (detail.status === 'interrupted') return { label: 'Interrupted', className: 'badge-yellow' };
  if (detail.status === 'completed') return { label: 'Completed', className: 'badge-blue' };
  // Default for non-active sessions with messages
  if (detail.messages?.length > 0) return { label: 'Completed', className: 'badge-blue' };
  return null;
}

// Truncate project path for display
function truncateProjectPath(path: string, maxLen = 40): string {
  if (!path || path.length <= maxLen) return path;
  const parts = path.split('/');
  // Show last 2-3 segments
  if (parts.length > 3) {
    return '.../' + parts.slice(-3).join('/');
  }
  return path;
}

export function SessionDetail({ sessionId, machineId, onLastSuggestion, onSubagents, onDetailMeta, onPollControls, externalPolling, listNumTurns, listLastModified, initialTab, highlightMilestoneId, onSelectSession }: SessionDetailProps) {
  const { viewMode: deviceViewMode } = useDeviceInfo();
  const isMobile = deviceViewMode === 'mobile';
  const [chatLastN, setChatLastN] = useState(() => {
    if (typeof window === 'undefined') return 200;
    try { const v = localStorage.getItem('chat-lastN-user-prompts'); if (v) return Number(v); } catch {}
    return 200;
  });
  const { detail, isLoading, error, refetch, applyBatchCheck, pollState } = useSessionDetail({ sessionId, machineId, externalPolling, lastN: chatLastN });
  const { isExperiment } = useExperiment();
  const { isWindows } = usePlatform();
  const { isSingleMachine, machines } = useMachineContext();
  const { apiClient } = useAppMode();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    if (initialTab) return initialTab;
    // Mobile: always default to chat (ignore saved preference)
    if (isMobile) return 'chat';
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('session-detail-tab');
      if (saved) return saved as TabId;
    }
    return isWindows ? 'chat' : 'console';
  });
  const handleSetActiveTab = (tab: TabId) => {
    setActiveTab(tab);
    try { localStorage.setItem('session-detail-tab', tab); } catch { /* ignore */ }
  };
  // Redirect away from console tab on Windows (e.g. restored from localStorage)
  useEffect(() => {
    if (isWindows && activeTab === 'console') {
      setActiveTab('chat');
    }
  }, [isWindows, activeTab]);
  const [copied, setCopied] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [milestoneCount, setMilestoneCount] = useState<number | undefined>(undefined);

  // Mobile: auto-hide header on scroll down (with cooldown to prevent layout-shift loop)
  const [headerHidden, setHeaderHidden] = useState(false);
  const lastScrollY = useRef(0);
  const headerHiddenRef = useRef(false);
  const scrollCooldownRef = useRef(false);
  const handleContentScroll = useCallback((scrollTop: number) => {
    if (!isMobile || scrollCooldownRef.current) return;
    const diff = scrollTop - lastScrollY.current;
    if (diff > 10 && scrollTop > 50 && !headerHiddenRef.current) {
      headerHiddenRef.current = true;
      setHeaderHidden(true);
      scrollCooldownRef.current = true;
      setTimeout(() => { scrollCooldownRef.current = false; }, 400);
    } else if (diff < -10 && headerHiddenRef.current) {
      headerHiddenRef.current = false;
      setHeaderHidden(false);
      scrollCooldownRef.current = true;
      setTimeout(() => { scrollCooldownRef.current = false; }, 400);
    }
    lastScrollY.current = scrollTop;
  }, [isMobile]);

  // Mobile: tab dropdown
  const [tabDropdownOpen, setTabDropdownOpen] = useState(false);
  const tabDropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tabDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (tabDropdownRef.current && !tabDropdownRef.current.contains(e.target as Node)) setTabDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [tabDropdownOpen]);

  // Milestone count is set by MilestonesTab's onMilestoneCount callback
  // when the milestones tab is opened (lazy-loaded, no eager fetch).

  // Highlight stats when they change
  const hlTurns = useHighlightValue(detail?.numTurns);
  const hlCost = useHighlightValue(detail?.totalCostUsd);
  const hlMsgs = useHighlightValue(detail?.messages?.length);

  const parentSessionId = searchParams.get('parent');
  const projectPath = searchParams.get('project') || detail?.projectPath;

  // Find machine info
  const machine = machines.find(m => m.id === machineId);

  // Use pre-extracted data from API response when available,
  // fall back to client-side extraction from messages
  const fileChanges = useMemo(() =>
    detail?.fileChanges?.length ? detail.fileChanges : (detail ? extractFileChanges(detail.messages) : []),
    [detail]
  );

  const thinkingBlocks = useMemo(() =>
    detail?.thinkingBlocks?.length ? detail.thinkingBlocks : (detail ? extractThinkingBlocks(detail.messages) : []),
    [detail]
  );

  const gitOperations = useMemo(() =>
    detail?.gitOperations?.length ? detail.gitOperations : (detail ? extractGitOperations(detail.messages) : []),
    [detail]
  );

  const tasks = useMemo(() =>
    detail?.tasks?.length ? detail.tasks : (detail ? extractTasks(detail.messages) : []),
    [detail]
  );

  const dbOperations = useMemo(() =>
    detail?.dbOperations?.length ? detail.dbOperations : (detail ? extractDbOperations(detail.messages) : []),
    [detail]
  );

  const plans = useMemo(() => detail?.plans || [], [detail]);

  // Count team-related tool calls for tab badge
  const teamEntryCount = useMemo(() => {
    if (!detail?.messages) return 0;
    const teamTools = new Set(['Teammate', 'SendMessage', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
    return detail.messages.filter(m => m.toolName && teamTools.has(m.toolName)).length;
  }, [detail]);

  // Use server-provided subagent data (correct IDs, type, prompt)
  // but enrich status since server often reports "running" for completed agents
  const subagents = useMemo(() =>
    detail?.subagents
      ? enrichSubagentStatus(detail.subagents, detail.messages)
      : [],
    [detail]
  );

  // Report last suggestion agent to parent for sidebar display
  useEffect(() => {
    if (!onLastSuggestion) return;
    if (!subagents || subagents.length === 0) {
      onLastSuggestion(null);
      return;
    }
    // Find the last prompt_suggestion agent by looking at conversation content
    const suggestions = subagents.filter(a =>
      a.agentId?.startsWith('aprompt_suggestion') && a.conversation?.length
    );
    if (suggestions.length === 0) {
      onLastSuggestion(null);
      return;
    }
    // Sort by lastActivityAt descending, pick last
    const sorted = [...suggestions].sort((a, b) => {
      const aTime = a.lastActivityAt || '';
      const bTime = b.lastActivityAt || '';
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    });
    // Extract assistant response (the suggestion text)
    const last = sorted[0];
    const assistantMsg = last.conversation?.find(c => c.type === 'assistant');
    const text = assistantMsg?.content?.trim();
    onLastSuggestion(text ? { text, updatedAt: last.lastActivityAt } : null);
  }, [subagents, onLastSuggestion]);

  // Report all subagents to parent for sidebar display
  useEffect(() => {
    if (!onSubagents) return;
    onSubagents(subagents);
  }, [subagents, onSubagents]);

  // Report detail meta (turns, lineCount, refetch) for watchdog comparison
  useEffect(() => {
    if (!onDetailMeta || !detail) return;
    onDetailMeta({
      numTurns: detail.numTurns || 0,
      lineCount: detail.lineCount || 0,
      refetch,
    });
  }, [detail?.numTurns, detail?.lineCount, onDetailMeta, refetch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Expose batch poll controls to parent (for merged batch polling)
  useEffect(() => {
    if (!onPollControls) return;
    onPollControls({ applyBatchCheck, pollState });
  }, [onPollControls, applyBatchCheck, pollState]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCopyId = () => {
    navigator.clipboard.writeText(sessionId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const statusBadge = getStatusBadge(detail);

  const tabs: { id: TabId; label: string; count?: number }[] = [
    ...(!isWindows ? [{ id: 'console' as TabId, label: 'Console' }] : []),
    { id: 'chat', label: 'Chat', count: detail?.messages?.length },
    { id: 'tasks', label: 'Tasks', count: tasks.length || undefined },
    { id: 'plans', label: 'Plans', count: plans.length || undefined },
    ...(isExperiment ? [{ id: 'milestones' as TabId, label: 'Milestones', count: milestoneCount || undefined }] : []),
    { id: 'agents', label: 'Agents', count: subagents.length || undefined },
    { id: 'team', label: 'Team', count: teamEntryCount || undefined },
    ...(isExperiment ? [{ id: 'dag' as TabId, label: 'FlowGraph' }] : []),
    { id: 'files', label: 'Files', count: fileChanges.length || undefined },
    { id: 'thinking', label: 'Thinking', count: thinkingBlocks.length || undefined },
    { id: 'git', label: 'Git', count: gitOperations.length || undefined },
    { id: 'db', label: 'DB', count: dbOperations.length || undefined },
    { id: 'json', label: 'JSON' },
    { id: 'meta', label: 'Meta' },
  ];

  if (isLoading && !detail) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} />
        <span style={{ fontSize: 12 }}>Loading session...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <span style={{ fontSize: 13, color: 'var(--color-status-red)' }}>Error: {error}</span>
        <button className="btn btn-sm btn-secondary" onClick={refetch}>Retry</button>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      ...(isFullscreen ? {
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'var(--color-bg-root)',
      } : {}),
    }}>
      {/* Session Header */}
      <div className="session-detail-header" style={isMobile && headerHidden ? { display: 'none' } : undefined}>
        {/* Row 1: Identity + Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }} className={isMobile ? 'session-detail-header-row1' : undefined}>
          {!isMobile && parentSessionId && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                fontSize: 11,
                color: 'var(--color-accent)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
              onClick={() => {
                if (onSelectSession) {
                  onSelectSession(parentSessionId, machineId);
                  const params = new URLSearchParams();
                  params.set('session', parentSessionId);
                  if (machineId) params.set('machine', machineId);
                  if (projectPath) params.set('project', projectPath);
                  router.replace(`/sessions?${params.toString()}`);
                } else {
                  const params = new URLSearchParams();
                  params.set('session', parentSessionId);
                  if (machineId) params.set('machine', machineId);
                  if (projectPath) params.set('project', projectPath);
                  router.push(`/sessions?${params.toString()}`);
                }
              }}
              title={`Go to parent session ${parentSessionId}`}
            >
              <ArrowLeft size={11} />
              <span style={{ fontFamily: 'var(--font-mono)' }}>{parentSessionId.slice(0, 8)}</span>
            </span>
          )}
          {!isMobile && detail?.forkedFromSessionId && detail.forkedFromSessionId !== sessionId && !parentSessionId && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                fontSize: 11,
                color: '#06b6d4',
                cursor: 'pointer',
                flexShrink: 0,
              }}
              onClick={() => {
                if (onSelectSession) {
                  onSelectSession(detail.forkedFromSessionId!, machineId);
                  const params = new URLSearchParams();
                  params.set('session', detail.forkedFromSessionId!);
                  if (machineId) params.set('machine', machineId);
                  if (projectPath) params.set('project', projectPath);
                  router.replace(`/sessions?${params.toString()}`);
                } else {
                  const params = new URLSearchParams();
                  params.set('session', detail.forkedFromSessionId!);
                  if (machineId) params.set('machine', machineId);
                  if (projectPath) params.set('project', projectPath);
                  router.push(`/sessions?${params.toString()}`);
                }
              }}
              title={`Forked from session ${detail.forkedFromSessionId}`}
            >
              <GitFork size={11} />
              <span style={{ fontFamily: 'var(--font-mono)' }}>{detail.forkedFromSessionId.slice(0, 8)}</span>
            </span>
          )}
          {detail?.isActive && <span className="status-dot running" />}
          {!isMobile && detail?.running && (
            <span className="badge" style={{
              fontSize: 8, padding: '0 4px',
              background: isProcessManaged(detail.running.managedBy) ? 'rgba(34,197,94,0.15)' : 'rgba(251,146,60,0.15)',
              color: isProcessManaged(detail.running.managedBy) ? 'var(--color-status-green)' : 'var(--color-status-orange)',
              border: `1px solid ${isProcessManaged(detail.running.managedBy) ? 'rgba(34,197,94,0.3)' : 'rgba(251,146,60,0.3)'}`,
            }}>
              PID {detail.running.pid} · {managedByLabel(detail.running.managedBy)}
            </span>
          )}
          <span style={{ fontSize: isMobile ? 13 : 14, fontWeight: 600 }}>
            {detail?.projectPath ? detail.projectPath.split('/').pop() : 'Session'}
          </span>
          {!isMobile && detail?.projectPath && (
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }} title={detail.projectPath}>
              {truncateProjectPath(detail.projectPath)}
            </span>
          )}
          {!isMobile && !isSingleMachine && machine && (
            <MachineBadge
              hostname={machine.hostname}
              platform={machine.platform}
              status={machine.status}
            />
          )}
          {!isMobile && detail?.model && (
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
              {detail.model}
            </span>
          )}
          {!isMobile && (
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-quaternary, var(--color-text-tertiary))' }}>
              {sessionId.slice(0, 8)}
            </span>
          )}
          {!isMobile && (
            <button className="btn btn-sm btn-ghost" onClick={handleCopyId} title="Copy Session ID" style={{ padding: '1px 3px', flexShrink: 0 }}>
              {copied ? <Check size={10} style={{ color: 'var(--color-status-green)' }} /> : <Copy size={10} />}
            </button>
          )}

          {/* Mobile: inline action buttons */}
          {isMobile && (
            <div className="session-detail-header-actions">
              {!isWindows && (
                <button className="btn btn-sm btn-secondary" title="Open Terminal" onClick={() => handleSetActiveTab('console')}>
                  <TerminalIcon size={12} />
                </button>
              )}
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => setIsFullscreen(prev => !prev)}
                title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                style={isFullscreen ? { color: 'var(--color-accent)' } : undefined}
              >
                {isFullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
              <button className="btn btn-sm btn-ghost" onClick={refetch} title="Refresh">
                <RefreshCw size={12} />
              </button>
            </div>
          )}
        </div>

        {/* Row 2 (or inline on desktop): Stats */}
        {detail && (
          <div className={isMobile ? 'session-detail-header-stats' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
            {statusBadge && (
              <span className={`badge ${statusBadge.className}`} style={{ fontSize: 9, padding: '1px 6px' }}>
                {statusBadge.label}
              </span>
            )}
            {detail.allTeams && detail.allTeams.length > 0 ? (
              detail.allTeams.map(t => (
                <span key={t} className="badge" style={{ fontSize: 9, padding: '1px 6px', background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', border: '1px solid rgba(139,92,246,0.3)' }}>
                  {t}
                </span>
              ))
            ) : detail.teamName ? (
              <span className="badge" style={{ fontSize: 9, padding: '1px 6px', background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', border: '1px solid rgba(139,92,246,0.3)' }}>
                {detail.teamName}
              </span>
            ) : null}
            <span className={hlTurns}>T:{detail.numTurns || 0}</span>
            {detail.totalCostUsd ? <span className={hlCost}>{formatCost(detail.totalCostUsd)}</span> : null}
            {detail.messages && <span className={hlMsgs}>{detail.messages.length} msgs</span>}
            {/* Watchdog: show session list vs chat freshness */}
            {!isMobile && listNumTurns !== undefined && (
              <span style={{
                color: listNumTurns > (detail.numTurns || 0) + 2
                  ? '#f59e0b'
                  : 'var(--color-text-tertiary)',
                fontWeight: listNumTurns > (detail.numTurns || 0) + 2 ? 600 : 400,
              }}>
                list:T{listNumTurns} chat:T{detail.numTurns || 0}
                {listNumTurns > (detail.numTurns || 0) + 2 ? ' STALE' : ''}
              </span>
            )}
          </div>
        )}

        {/* Desktop-only Actions */}
        {!isMobile && (
          <>
            {!isWindows && (
              <>
                <button className="btn btn-sm btn-secondary" title="Open Terminal" onClick={() => handleSetActiveTab('console')}>
                  <TerminalIcon size={12} />
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  title="Open Console in new tab"
                  onClick={() => window.open(`/console?sessionId=${encodeURIComponent(sessionId)}&projectPath=${encodeURIComponent(projectPath || detail?.projectPath || '')}`, '_blank')}
                >
                  <ExternalLink size={12} />
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  title="Fork Session"
                  onClick={() => window.open(`/console?sessionId=${encodeURIComponent(sessionId)}&projectPath=${encodeURIComponent(projectPath || detail?.projectPath || '')}&fork=true`, '_blank')}
                >
                  <GitFork size={12} />
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  title="New Shell"
                  onClick={() => window.open(`/console?shell=true&projectPath=${encodeURIComponent(projectPath || detail?.projectPath || '')}`, '_blank')}
                >
                  <SquareTerminal size={12} />
                </button>
              </>
            )}
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => setIsFullscreen(prev => !prev)}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              style={isFullscreen ? { color: 'var(--color-accent)' } : undefined}
            >
              {isFullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={refetch} title="Refresh">
              <RefreshCw size={12} />
            </button>
          </>
        )}
      </div>

      {/* Tab bar */}
      {isMobile ? (
        // On mobile + chat tab: hide standalone dropdown (merged into ChatTab's bar)
        // On mobile + other tabs: show dropdown as full-width row
        activeTab !== 'chat' ? (
          <div className="mobile-tab-dropdown" ref={tabDropdownRef}>
            <button className="mobile-tab-trigger" onClick={() => setTabDropdownOpen(!tabDropdownOpen)}>
              <span>{tabs.find(t => t.id === activeTab)?.label || activeTab}</span>
              {(() => { const t = tabs.find(t => t.id === activeTab); return t?.count !== undefined && t.count > 0 ? <span className="tab-badge">{t.count}</span> : null; })()}
              <ChevronDown size={12} style={{ marginLeft: 'auto', transform: tabDropdownOpen ? 'rotate(180deg)' : undefined, transition: 'transform 200ms' }} />
            </button>
            {tabDropdownOpen && (
              <>
                <div className="mobile-tab-panel-backdrop" onClick={() => setTabDropdownOpen(false)} />
                <div className="mobile-tab-panel">
                  {tabs.map(tab => (
                    <button
                      key={tab.id}
                      className={`mobile-tab-option ${activeTab === tab.id ? 'active' : ''}`}
                      onClick={() => { handleSetActiveTab(tab.id); setTabDropdownOpen(false); }}
                    >
                      <span>{tab.label}</span>
                      {tab.count !== undefined && tab.count > 0 && (
                        <span className="tab-badge">{tab.count}</span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : null
      ) : (
        <div className="tab-bar">
          {tabs.map(tab => (
            <div
              key={tab.id}
              className={`tab-item ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => handleSetActiveTab(tab.id)}
            >
              {tab.label}
              {tab.count !== undefined && tab.count > 0 && (
                <span className="tab-badge">{tab.count}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {activeTab === 'chat' && detail && (
          <ChatTab
            messages={detail.messages}
            isActive={detail.isActive}
            sessionId={sessionId}
            machineId={machineId}
            projectPath={projectPath || detail.projectPath}
            isSubagent={!!parentSessionId}
            agentCount={subagents.length}
            onLastNChange={setChatLastN}
            highlightMilestoneId={highlightMilestoneId}
            onContentScroll={handleContentScroll}
            tabSelector={isMobile ? (
              <div className="mobile-tab-dropdown" ref={tabDropdownRef} style={{ position: 'relative', flexShrink: 0 }}>
                <button
                  className="mobile-tab-inline-trigger"
                  onClick={() => setTabDropdownOpen(!tabDropdownOpen)}
                >
                  <span>{tabs.find(t => t.id === activeTab)?.label || activeTab}</span>
                  <ChevronDown size={10} style={{ transform: tabDropdownOpen ? 'rotate(180deg)' : undefined, transition: 'transform 200ms' }} />
                </button>
                {tabDropdownOpen && (
                  <>
                    <div className="mobile-tab-panel-backdrop" onClick={() => setTabDropdownOpen(false)} />
                    <div className="mobile-tab-panel">
                      {tabs.map(tab => (
                        <button
                          key={tab.id}
                          className={`mobile-tab-option ${activeTab === tab.id ? 'active' : ''}`}
                          onClick={() => { handleSetActiveTab(tab.id); setTabDropdownOpen(false); }}
                        >
                          <span>{tab.label}</span>
                          {tab.count !== undefined && tab.count > 0 && (
                            <span className="tab-badge">{tab.count}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ) : undefined}
          />
        )}
        {/* Console tab: always mounted to preserve terminal connection */}
        {!isWindows && (
          <div style={{
            display: activeTab === 'console' ? 'flex' : 'none',
            flexDirection: 'column',
            position: 'absolute',
            inset: 0,
          }}>
            <ConsoleTab key={sessionId} sessionId={sessionId} machineId={machineId} projectPath={projectPath || detail?.projectPath} running={detail?.running} />
          </div>
        )}
{activeTab === 'tasks' && (
          <TasksTab tasks={tasks} />
        )}
        {activeTab === 'plans' && (
          <PlansTab plans={plans} toolUses={detail?.toolUses} machineId={machineId} />
        )}
        {activeTab === 'milestones' && (
          <MilestonesTab sessionId={sessionId} machineId={machineId} onMilestoneCount={setMilestoneCount} highlightMilestoneId={highlightMilestoneId} />
        )}
        {activeTab === 'agents' && (
          <AgentsTab subagents={subagents} sessionId={sessionId} machineId={machineId} projectPath={projectPath || detail?.projectPath} />
        )}
        {activeTab === 'team' && detail && (
          <TeamTab messages={detail.messages} teamName={detail.teamName} allTeams={detail.allTeams} taskSubjects={detail.taskSubjects} />
        )}
        {activeTab === 'dag' && (
          <DagTab sessionId={sessionId} machineId={machineId} />
        )}
        {activeTab === 'files' && (
          <FilesTab fileChanges={fileChanges} />
        )}
        {activeTab === 'thinking' && (
          <ThinkingTab blocks={thinkingBlocks} />
        )}
        {activeTab === 'git' && (
          <GitTab operations={gitOperations} />
        )}
        {activeTab === 'db' && (
          <DbTab operations={dbOperations} />
        )}
        {activeTab === 'json' && detail && (
          <JsonTab detail={detail} />
        )}
        {activeTab === 'meta' && detail && (
          <MetaTab detail={detail} machineId={machineId} />
        )}
      </div>
    </div>
  );
}
