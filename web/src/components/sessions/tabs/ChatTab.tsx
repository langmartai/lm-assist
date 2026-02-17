'use client';

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Search, X, List, AlignJustify, Sparkles, Pin, Copy, Check,
  ChevronRight, ChevronDown, ChevronUp, User, Bot, Settings,
  Play, RotateCcw, FileText, FolderOpen, Cpu, ListChecks, CheckCircle2,
  ChevronsUp, Wrench, AlertTriangle, Map as MapIcon, Flag,
} from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { formatToolCallString, formatToolCall, shouldHideInSmartDisplay, smartTransformContent, parseApiError } from '@/lib/smart-display';
import type { SessionMessage, MessageType, Milestone, MilestoneType } from '@/lib/types';

const LAST_N_KEY = 'chat-lastN-user-prompts';
const LAST_N_OPTIONS = [20, 50, 100, 200, 500, 1000];

export function getPersistedLastN(): number {
  if (typeof window === 'undefined') return 20;
  try { const v = localStorage.getItem(LAST_N_KEY); if (v) return Number(v); } catch {}
  return 20;
}

interface ChatTabProps {
  messages: SessionMessage[];
  isActive?: boolean;
  sessionId?: string;
  machineId?: string;
  projectPath?: string;
  isSubagent?: boolean;
  agentCount?: number;
  onLastNChange?: (n: number) => void;
  /** Deep-link: milestone ID to highlight, scroll to, and filter for */
  highlightMilestoneId?: string;
}

// Message type config
const msgTypeConfig: Record<string, { bg: string; icon: any; label: string; iconColor: string }> = {
  human: { bg: 'msg-user', icon: User, label: 'USER', iconColor: '#5eead4' },
  assistant: { bg: 'msg-assistant', icon: Bot, label: 'ASSISTANT', iconColor: '#93c5fd' },
  thinking: { bg: 'msg-thinking', icon: Sparkles, label: 'THINKING', iconColor: '#94a3b8' },
  system: { bg: 'msg-system', icon: Settings, label: 'SYSTEM', iconColor: '#67e8f9' },
  result: { bg: 'msg-result', icon: Play, label: 'RESULT', iconColor: '#86efac' },
  progress: { bg: 'msg-progress', icon: RotateCcw, label: 'PROGRESS', iconColor: '#fde047' },
  summary: { bg: 'msg-summary', icon: FileText, label: 'SUMMARY', iconColor: '#fdba74' },
  todo: { bg: 'msg-todo', icon: CheckCircle2, label: 'TODOS', iconColor: '#86efac' },
  task: { bg: 'msg-task', icon: ListChecks, label: 'TASK', iconColor: '#a5b4fc' },
  'file-history-snapshot': { bg: 'msg-file-history', icon: FolderOpen, label: 'FILE HISTORY', iconColor: '#d1d5db' },
  'queue-operation': { bg: 'msg-queue', icon: ListChecks, label: 'QUEUE OP', iconColor: '#cbd5e1' },
  error: { bg: 'msg-error', icon: AlertTriangle, label: 'API ERROR', iconColor: '#f87171' },
  agent_user: { bg: 'msg-agent-user', icon: Cpu, label: 'AGENT', iconColor: '#22d3ee' },
  agent_assistant: { bg: 'msg-agent-assistant', icon: Cpu, label: 'AGENT RESPONSE', iconColor: '#67e8f9' },
  plan: { bg: 'msg-plan', icon: MapIcon, label: 'PLAN', iconColor: '#fbbf24' },
  lastHumanMessage: { bg: 'msg-last-human', icon: User, label: 'LAST UPDATE', iconColor: '#5eead4' },
  compactMessage: { bg: 'msg-compact', icon: Sparkles, label: 'COMPACT', iconColor: '#94a3b8' },
};
// Tool icon color
const toolIconColor = '#d1d5db';

// Milestone type colors
const milestoneTypeColors: Record<string, string> = {
  discovery: '#60a5fa',
  implementation: '#4ade80',
  bugfix: '#f87171',
  refactor: '#c084fc',
  decision: '#fbbf24',
  configuration: '#22d3ee',
};

// Toggle types
type ConvType = 'user' | 'assistant' | 'thinking' | 'tools' | 'todos' | 'tasks' | 'plans' | 'agents' | 'milestones';
type RawType = 'system' | 'result' | 'progress' | 'summary' | 'fileHistory' | 'queueOp';

// Detect compact/continuation messages
function isCompactMessage(content: string | unknown): boolean {
  if (typeof content !== 'string') return false;
  return content.includes('Your task is to create a detailed summary') ||
    content.includes('session compacted') ||
    content.includes('context summarized');
}

export function ChatTab({ messages, isActive, sessionId, machineId, projectPath, isSubagent, agentCount: agentCountProp, onLastNChange, highlightMilestoneId }: ChatTabProps) {
  const { apiClient } = useAppMode();

  // Milestone data
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    apiClient.getMilestones(sessionId, machineId).then(result => {
      if (!cancelled) setMilestones(result.milestones);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId, machineId, apiClient]);

  const handleOpenAgent = useCallback((agentId: string) => {
    const params = new URLSearchParams();
    params.set('session', agentId);
    if (sessionId) params.set('parent', sessionId);
    if (machineId) params.set('machine', machineId);
    if (projectPath) params.set('project', projectPath);
    window.open(`/sessions?${params.toString()}`, '_blank');
  }, [sessionId, machineId, projectPath]);

  // Filter toggles (persisted, with milestones forced on when deep-linking)
  const [showTypes, setShowTypes] = useState<Record<ConvType, boolean>>(() => {
    const defaults = { user: true, assistant: true, thinking: true, tools: true, todos: true, tasks: true, plans: false, agents: true, milestones: true };
    let saved: Record<ConvType, boolean> | null = null;
    if (typeof window !== 'undefined') {
      try { const s = localStorage.getItem('chat-show-types'); if (s) saved = { ...defaults, ...JSON.parse(s) }; } catch {}
    }
    if (highlightMilestoneId) {
      // Has saved prefs: use them but ensure milestones is on
      if (saved) return { ...saved, milestones: true };
      // No saved prefs (first time): milestones only
      return { user: false, assistant: false, thinking: false, tools: false, todos: false, tasks: false, plans: false, agents: false, milestones: true };
    }
    return saved || defaults;
  });
  const isDeepLinked = !!highlightMilestoneId;
  const handleSetShowTypes = (update: Record<ConvType, boolean>) => {
    setShowTypes(update);
    // Don't persist deep-link filter override to localStorage
    if (!isDeepLinked) {
      localStorage.setItem('chat-show-types', JSON.stringify(update));
    }
  };
  const [showRawTypes, setShowRawTypes] = useState<Record<RawType, boolean>>(() => {
    const defaults = { system: false, result: false, progress: false, summary: false, fileHistory: false, queueOp: false };
    if (typeof window !== 'undefined') {
      try { const s = localStorage.getItem('chat-show-raw-types'); if (s) return { ...defaults, ...JSON.parse(s) }; } catch {}
    }
    return defaults;
  });
  const handleSetShowRawTypes = (update: Record<RawType, boolean>) => {
    setShowRawTypes(update);
    localStorage.setItem('chat-show-raw-types', JSON.stringify(update));
  };

  // View mode and smart display (persisted, default: detailed)
  const [viewMode, setViewMode] = useState<'compact' | 'detailed'>(() => {
    if (typeof window !== 'undefined') {
      const s = localStorage.getItem('chat-view-mode');
      if (s === 'compact' || s === 'detailed') return s;
    }
    return 'detailed';
  });
  const handleSetViewMode = (mode: 'compact' | 'detailed') => {
    setViewMode(mode);
    localStorage.setItem('chat-view-mode', mode);
  };
  const [smartDisplay, setSmartDisplay] = useState(() => {
    if (typeof window !== 'undefined') {
      const s = localStorage.getItem('chat-smart-display');
      if (s !== null) return s !== 'false';
    }
    return true;
  });
  const handleSetSmartDisplay = (v: boolean) => {
    setSmartDisplay(v);
    localStorage.setItem('chat-smart-display', String(v));
  };
  const [autoScroll, setAutoScroll] = useState(true);
  const [isPinned, setIsPinned] = useState(false);

  // Font size (persisted)
  const [fontSize, setFontSize] = useState<'sm' | 'md' | 'lg' | 'xl'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('chat-font-size');
      if (saved === 'sm' || saved === 'md' || saved === 'lg' || saved === 'xl') return saved;
    }
    return 'md';
  });
  const handleSetFontSize = (size: 'sm' | 'md' | 'lg' | 'xl') => {
    setFontSize(size);
    localStorage.setItem('chat-font-size', size);
  };

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [currentMatch, setCurrentMatch] = useState(0);
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);

  // Message count dropdown (persisted, or load all when deep-linking to milestone)
  const [lastNUserPrompts, setLastNUserPrompts] = useState(() =>
    highlightMilestoneId ? 1000 : getPersistedLastN()
  );
  const handleLastNChange = useCallback((n: number) => {
    setLastNUserPrompts(n);
    try { localStorage.setItem(LAST_N_KEY, String(n)); } catch {}
    onLastNChange?.(n);
  }, [onLastNChange]);

  // Expansion
  const [expanded, setExpanded] = useState<Record<number, 'expanded' | 'full'>>({});
  const [expandedMilestones, setExpandedMilestones] = useState<Set<string>>(() =>
    highlightMilestoneId ? new Set([highlightMilestoneId]) : new Set()
  );

  // Deep-link milestone highlight
  const [highlightedMilestoneId, setHighlightedMilestoneId] = useState<string | null>(highlightMilestoneId || null);
  const milestoneHighlightAppliedRef = useRef(false);

  // Active message
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);

  // Copy state
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Refs
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  // Track new messages by lineIndex threshold
  const maxLineIndex = useMemo(() => {
    let max = 0;
    for (const m of messages) {
      if (m.lineIndex !== undefined && m.lineIndex > max) max = m.lineIndex;
    }
    return max;
  }, [messages]);
  const prevMaxLineRef = useRef(maxLineIndex);
  const maxLineRef = useRef(maxLineIndex);
  maxLineRef.current = maxLineIndex; // always up-to-date
  const highlightTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [newThreshold, setNewThreshold] = useState<number | null>(null);

  useEffect(() => {
    if (maxLineIndex > prevMaxLineRef.current) {
      const threshold = prevMaxLineRef.current;
      setNewThreshold(threshold);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => {
        setNewThreshold(null);
        prevMaxLineRef.current = maxLineRef.current;
        highlightTimerRef.current = null;
      }, 5000);
    }
  }, [maxLineIndex]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  // Count user messages for slider max
  const userMessageCount = useMemo(() =>
    messages.filter(m => m.type === 'human').length,
    [messages]
  );

  // Message counts by type
  const messageCounts = useMemo(() => {
    const counts = {
      user: 0, assistant: 0, thinking: 0, tools: 0, todos: 0, tasks: 0, plans: 0, agents: 0,
      system: 0, result: 0, progress: 0, summary: 0, fileHistory: 0, queueOp: 0,
    };
    for (const msg of messages) {
      switch (msg.type) {
        case 'human': counts.user++; break;
        case 'assistant': counts.assistant++; break;
        case 'thinking': counts.thinking++; break;
        case 'todo': counts.todos++; break;
        case 'task': counts.tasks++; break;
        case 'plan': counts.plans++; break;
        case 'agent_user': case 'agent_assistant': counts.agents++; break;
        case 'system': counts.system++; break;
        case 'result': counts.result++; break;
        case 'progress': counts.progress++; break;
        case 'summary': counts.summary++; break;
        case 'file-history-snapshot': counts.fileHistory++; break;
        case 'queue-operation': counts.queueOp++; break;
      }
      if (msg.toolName) counts.tools++;
    }
    return counts;
  }, [messages]);

  // Find last human message ID
  const lastHumanMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'human' && messages[i].id) return messages[i].id;
    }
    return null;
  }, [messages]);

  // Whether messages are truncated by lastN
  const isTruncated = lastNUserPrompts > 0 && lastNUserPrompts < userMessageCount;

  // Filter messages
  const filteredMessages = useMemo(() => {
    // Determine starting turn index based on lastNUserPrompts
    let startingTurnIndex = 0;
    if (lastNUserPrompts > 0 && lastNUserPrompts < userMessageCount) {
      const userTurnIndices: number[] = [];
      for (const msg of messages) {
        if (msg.type === 'human' && msg.turnIndex !== undefined) {
          userTurnIndices.push(msg.turnIndex);
        }
      }
      if (userTurnIndices.length > lastNUserPrompts) {
        startingTurnIndex = userTurnIndices[userTurnIndices.length - lastNUserPrompts];
      }
    }

    return messages.filter(msg => {
      // Filter by turn index (lastN slider) — applies to all messages including agents
      if (lastNUserPrompts > 0 && lastNUserPrompts < userMessageCount
          && msg.turnIndex !== undefined && msg.turnIndex < startingTurnIndex) {
        return false;
      }

      // Smart display hide (skip for subagent sessions — their content IS the compact/suggestion data)
      if (smartDisplay && !isSubagent) {
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (shouldHideInSmartDisplay(content, msg.type, msg.subtype)) return false;
      }

      // Type filters
      const type = msg.type;
      if (type === 'human' && !showTypes.user) return false;
      if (type === 'assistant' && !showTypes.assistant) return false;
      if (type === 'thinking' && !showTypes.thinking) return false;
      if (type === 'todo' && !showTypes.todos) return false;
      if (type === 'task' && !showTypes.tasks) return false;
      if (type === 'plan' && !showTypes.plans) return false;
      if ((type === 'agent_user' || type === 'agent_assistant') && !showTypes.agents) return false;
      // Tools filter: only apply to generic tool calls, not task/agent/todo types
      if (msg.toolName && !showTypes.tools
          && type !== 'task' && type !== 'todo' && type !== 'plan'
          && type !== 'agent_user' && type !== 'agent_assistant') return false;
      if (type === 'result' && !showTypes.tools) return false;
      if (type === 'system' && !showRawTypes.system) return false;
      if (type === 'result' && !showRawTypes.result && !showTypes.tools) return false;
      if (type === 'progress' && !showRawTypes.progress) return false;
      if (type === 'summary' && !showRawTypes.summary) return false;
      if (type === 'file-history-snapshot' && !showRawTypes.fileHistory) return false;
      if (type === 'queue-operation' && !showRawTypes.queueOp) return false;

      return true;
    });
  }, [messages, showTypes, showRawTypes, smartDisplay, lastNUserPrompts, userMessageCount]);

  // Merged items: messages + milestone markers sorted by turn
  type MergedItem = { kind: 'message'; msg: SessionMessage; idx: number } | { kind: 'milestone'; milestone: Milestone };

  const mergedItems = useMemo((): MergedItem[] => {
    const items: MergedItem[] = filteredMessages.map((msg, idx) => ({ kind: 'message' as const, msg, idx }));

    if (showTypes.milestones && milestones.length > 0) {
      for (const m of milestones) {
        items.push({ kind: 'milestone' as const, milestone: m });
      }
    }

    // Sort: messages by turnIndex (then lineIndex), milestones by startTurn
    // Milestones appear before messages at the same turn
    items.sort((a, b) => {
      const aTurn = a.kind === 'message' ? (a.msg.turnIndex ?? 0) : a.milestone.startTurn;
      const bTurn = b.kind === 'message' ? (b.msg.turnIndex ?? 0) : b.milestone.startTurn;
      if (aTurn !== bTurn) return aTurn - bTurn;
      // Milestones before messages at the same turn
      if (a.kind === 'milestone' && b.kind === 'message') return -1;
      if (a.kind === 'message' && b.kind === 'milestone') return 1;
      // Both messages: preserve original order
      if (a.kind === 'message' && b.kind === 'message') {
        const aLine = a.msg.lineIndex ?? 0;
        const bLine = b.msg.lineIndex ?? 0;
        return aLine - bLine;
      }
      // Both milestones: sort by startTurn then index
      if (a.kind === 'milestone' && b.kind === 'milestone') return a.milestone.index - b.milestone.index;
      return 0;
    });

    return items;
  }, [filteredMessages, milestones, showTypes.milestones]);

  // Deep-link: scroll to + highlight target milestone after milestones load
  useEffect(() => {
    if (!highlightMilestoneId || milestoneHighlightAppliedRef.current) return;
    // Wait for milestones to be in the merged list
    const hasMilestone = mergedItems.some(
      item => item.kind === 'milestone' && item.milestone.id === highlightMilestoneId
    );
    if (!hasMilestone) return;

    milestoneHighlightAppliedRef.current = true;
    // Disable auto-scroll so it doesn't fight our scroll
    setAutoScroll(false);

    requestAnimationFrame(() => {
      const el = document.getElementById(`chat-milestone-${highlightMilestoneId}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    // Fade highlight after 3s
    const timer = setTimeout(() => setHighlightedMilestoneId(null), 3000);
    return () => clearTimeout(timer);
  }, [highlightMilestoneId, mergedItems]);

  // Search matches with preview data
  const searchMatchData = useMemo(() => {
    if (!searchQuery) return [];
    const q = searchQuery.toLowerCase();
    return filteredMessages.reduce<{ idx: number; preview: string; msg: SessionMessage }[]>((acc, msg, idx) => {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const lowerContent = content.toLowerCase();
      const matchPos = lowerContent.indexOf(q);
      if (matchPos >= 0) {
        const start = Math.max(0, matchPos - 20);
        const end = Math.min(content.length, matchPos + q.length + 40);
        const preview = (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
        acc.push({ idx, preview, msg });
      }
      return acc;
    }, []);
  }, [filteredMessages, searchQuery]);

  const searchMatches = useMemo(() => searchMatchData.map(m => m.idx), [searchMatchData]);

  // Auto-scroll — staggered to catch DOM updates (matches admin-web pattern)
  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    const el = scrollRef.current;
    const scroll = () => { el.scrollTop = el.scrollHeight; };
    const timers = [0, 50, 150].map(d => setTimeout(scroll, d));
    return () => timers.forEach(clearTimeout);
  }, [filteredMessages.length, autoScroll]);

  // Auto-expand last human message
  useEffect(() => {
    const lastHumanIdx = filteredMessages.findLastIndex(m => m.type === 'human');
    if (lastHumanIdx >= 0) {
      setExpanded(prev => ({ ...prev, [lastHumanIdx]: 'expanded' }));
    }
  }, [filteredMessages.length]); // eslint-disable-line

  // Close search dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSearchDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggleExpand = (idx: number) => {
    if (isPinned) return;
    setExpanded(prev => {
      const current = prev[idx];
      if (!current) return { ...prev, [idx]: 'expanded' };
      if (current === 'expanded') return { ...prev, [idx]: 'full' };
      const { [idx]: _, ...rest } = prev;
      return rest;
    });
  };

  const toggleConvType = (type: ConvType) => {
    const updated = { ...showTypes, [type]: !showTypes[type] };
    handleSetShowTypes(updated);
  };

  const toggleRawType = (type: RawType) => {
    const updated = { ...showRawTypes, [type]: !showRawTypes[type] };
    handleSetShowRawTypes(updated);
  };

  const handleCopyMessage = useCallback((msgId: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedId(msgId);
    setTimeout(() => setCopiedId(null), 1500);
  }, []);

  const handleLoadMore = useCallback(() => {
    setLastNUserPrompts(prev => Math.min(prev + 20, userMessageCount));
  }, [userMessageCount]);

  const handleLoadAll = useCallback(() => {
    setLastNUserPrompts(userMessageCount);
  }, [userMessageCount]);

  const navigateToSearchMatch = useCallback((matchIdx: number) => {
    setCurrentMatch(matchIdx);
    setShowSearchDropdown(false);
    // Expand the matched message
    const targetIdx = searchMatchData[matchIdx]?.idx;
    if (targetIdx !== undefined) {
      setExpanded(prev => ({ ...prev, [targetIdx]: 'expanded' }));
    }
  }, [searchMatchData]);

  // Get count label for type
  const countLabel = (count: number) => count > 0 ? ` (${count})` : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Filter Row 1: message type toggles */}
      <div style={{
        padding: '6px 12px',
        borderBottom: '1px solid var(--color-border-subtle)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 3,
        alignItems: 'center',
      }}>
        {/* Conversation types */}
        {([
          ['user', 'User', 'rgba(0,92,75,0.5)', '#5eead4', messageCounts.user, User],
          ['assistant', 'Asst', 'rgba(51,100,164,0.5)', '#93c5fd', messageCounts.assistant, Bot],
          ['thinking', 'Think', 'rgba(51,65,85,1)', '#cbd5e1', messageCounts.thinking, Sparkles],
          ['tools', 'Tools', 'rgba(55,65,81,1)', '#d1d5db', messageCounts.tools, Wrench],
          ['todos', 'Todos', 'rgba(20,83,45,0.5)', '#86efac', messageCounts.todos, CheckCircle2],
          ['tasks', 'Tasks', 'rgba(49,46,129,0.5)', '#a5b4fc', messageCounts.tasks, ListChecks],
          ['plans', 'Plans', 'rgba(120,53,15,0.5)', '#fbbf24', messageCounts.plans, MapIcon],
          ['milestones', 'Miles', 'rgba(120,53,15,0.5)', '#d97706', milestones.length, Flag],
          ['agents', 'Agents', 'rgba(22,78,99,0.5)', '#67e8f9', agentCountProp ?? messageCounts.agents, Cpu],
        ] as [ConvType, string, string, string, number, any][]).map(([key, label, bg, fg, count, Icon]) => (
          <button
            key={key}
            className="btn btn-sm"
            style={{
              background: showTypes[key] ? bg : 'transparent',
              color: showTypes[key] ? fg : 'var(--color-text-tertiary)',
              fontSize: 10,
              padding: '2px 6px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
            }}
            onClick={() => toggleConvType(key)}
          >
            <Icon size={10} />{label}{countLabel(count)}
          </button>
        ))}

        <div style={{ width: 1, height: 14, background: 'var(--color-border-default)', margin: '0 4px' }} />

        {/* Raw types */}
        {([
          ['system', 'Sys', 'rgba(22,78,99,0.5)', '#67e8f9', messageCounts.system, Settings],
          ['result', 'Res', 'rgba(20,83,45,0.5)', '#86efac', messageCounts.result, Play],
          ['progress', 'Prog', 'rgba(113,63,18,0.5)', '#fde047', messageCounts.progress, RotateCcw],
          ['summary', 'Sum', 'rgba(124,45,18,0.5)', '#fdba74', messageCounts.summary, FileText],
          ['fileHistory', 'Files', 'rgba(55,65,81,1)', '#d1d5db', messageCounts.fileHistory, FolderOpen],
          ['queueOp', 'Queue', 'rgba(51,65,85,1)', '#cbd5e1', messageCounts.queueOp, ListChecks],
        ] as [RawType, string, string, string, number, any][]).map(([key, label, bg, fg, count, Icon]) => (
          <button
            key={key}
            className="btn btn-sm"
            style={{
              background: showRawTypes[key] ? bg : 'transparent',
              color: showRawTypes[key] ? fg : 'var(--color-text-tertiary)',
              fontSize: 10,
              padding: '2px 6px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
            }}
            onClick={() => toggleRawType(key)}
          >
            <Icon size={10} />{label}{countLabel(count)}
          </button>
        ))}

        <div style={{ width: 1, height: 14, background: 'var(--color-border-default)', margin: '0 4px' }} />

        {/* View mode */}
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => handleSetViewMode(viewMode === 'compact' ? 'detailed' : 'compact')}
          title={viewMode === 'compact' ? 'Switch to Detail View' : 'Switch to List View'}
          style={{ padding: '2px 8px', gap: 4, display: 'inline-flex', alignItems: 'center' }}
        >
          {viewMode === 'compact' ? <List size={12} /> : <AlignJustify size={12} />}
          <span style={{ fontSize: 10 }}>{viewMode === 'compact' ? 'Detail View' : 'List View'}</span>
        </button>

        {/* Smart Display */}
        <button
          className="btn btn-sm"
          style={{
            padding: '2px 6px',
            fontSize: 10,
            background: smartDisplay ? 'rgba(6,78,59,0.5)' : 'transparent',
            color: smartDisplay ? '#6ee7b7' : 'var(--color-text-tertiary)',
          }}
          onClick={() => handleSetSmartDisplay(!smartDisplay)}
          title="Smart Display: friendly tool call formatting"
        >
          Smart Display
        </button>
      </div>

      {/* Filter Row 2: controls */}
      <div style={{
        padding: '4px 12px',
        borderBottom: '1px solid var(--color-border-subtle)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 11,
      }}>
        {/* Last N dropdown */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>Last</span>
          <select
            value={lastNUserPrompts}
            onChange={e => handleLastNChange(Number(e.target.value))}
            style={{
              fontSize: 10,
              padding: '1px 4px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--color-border-default)',
              background: 'var(--color-bg-primary)',
              color: 'var(--color-text-secondary)',
              cursor: 'pointer',
            }}
          >
            {LAST_N_OPTIONS.map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>

        <div style={{ width: 1, height: 14, background: 'var(--color-border-default)' }} />

        {/* Auto-scroll */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-text-tertiary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
          Auto-scroll
        </label>

        {/* Pin */}
        <button
          className="btn btn-sm btn-ghost"
          style={{ padding: '2px 4px', color: isPinned ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}
          onClick={() => setIsPinned(!isPinned)}
          title="Pin: enable text selection, disable collapse/expand"
        >
          <Pin size={11} />
        </button>

        <div style={{ width: 1, height: 14, background: 'var(--color-border-default)' }} />

        {/* Font size */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {(['sm', 'md', 'lg', 'xl'] as const).map(size => (
            <button
              key={size}
              className="btn btn-sm btn-ghost"
              style={{
                padding: '1px 5px',
                fontSize: size === 'sm' ? 9 : size === 'md' ? 11 : size === 'lg' ? 13 : 15,
                fontWeight: fontSize === size ? 700 : 400,
                color: fontSize === size ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
              }}
              onClick={() => handleSetFontSize(size)}
              title={`Font size: ${{ sm: 'Small', md: 'Medium', lg: 'Large', xl: 'Extra Large' }[size]}`}
            >
              {{ sm: 'S', md: 'M', lg: 'L', xl: 'XL' }[size]}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {/* Search */}
        <div ref={searchRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Search size={11} style={{ color: 'var(--color-text-tertiary)' }} />
          <input
            className="input"
            placeholder="Search messages..."
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setCurrentMatch(0); setShowSearchDropdown(true); }}
            onFocus={() => { if (searchQuery && searchMatchData.length > 1) setShowSearchDropdown(true); }}
            style={{ width: 140, fontSize: 11, padding: '2px 6px' }}
          />
          {searchQuery && (
            <>
              <span
                style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', cursor: 'pointer' }}
                onClick={() => setShowSearchDropdown(prev => !prev)}
              >
                {searchMatches.length > 0 ? `${currentMatch + 1}/${searchMatches.length}` : '0/0'}
              </span>
              <button
                className="btn btn-sm btn-ghost"
                style={{ padding: '1px 3px' }}
                onClick={() => { setCurrentMatch(prev => Math.max(0, prev - 1)); setShowSearchDropdown(false); }}
              >
                ↑
              </button>
              <button
                className="btn btn-sm btn-ghost"
                style={{ padding: '1px 3px' }}
                onClick={() => { setCurrentMatch(prev => Math.min(searchMatches.length - 1, prev + 1)); setShowSearchDropdown(false); }}
              >
                ↓
              </button>
              <button
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)' }}
                onClick={() => { setSearchQuery(''); setCurrentMatch(0); setShowSearchDropdown(false); }}
              >
                <X size={10} />
              </button>

              {/* Search dropdown */}
              {showSearchDropdown && searchMatchData.length > 1 && (
                <div className="search-dropdown scrollbar-thin">
                  {searchMatchData.slice(0, 20).map((match, idx) => {
                    const typeLabel = match.msg.type === 'human' ? 'User' :
                      match.msg.type === 'assistant' ? 'Claude' :
                      match.msg.toolName ? 'Tool' : match.msg.type;
                    return (
                      <div
                        key={idx}
                        className={`search-dropdown-item ${idx === currentMatch ? 'active' : ''}`}
                        onClick={() => navigateToSearchMatch(idx)}
                      >
                        <span className={`badge ${
                          match.msg.type === 'human' ? 'badge-blue' :
                          match.msg.type === 'assistant' ? 'badge-purple' :
                          match.msg.toolName ? 'badge-cyan' : 'badge-default'
                        }`} style={{ fontSize: 9, padding: '0px 4px' }}>
                          {typeLabel}
                        </span>
                        <span className="truncate" style={{ flex: 1, fontSize: 10, color: 'var(--color-text-secondary)' }}>
                          {match.preview}
                        </span>
                        {match.msg.turnIndex !== undefined && (
                          <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                            #{match.msg.turnIndex}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {searchMatchData.length > 20 && (
                    <div style={{ padding: '4px 8px', fontSize: 10, color: 'var(--color-text-tertiary)', textAlign: 'center' }}>
                      ...and {searchMatchData.length - 20} more matches
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Message count */}
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {filteredMessages.length}/{messages.length} msgs
        </span>
      </div>

      {/* Message list */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', fontSize: fontSize === 'sm' ? 11 : fontSize === 'lg' ? 15 : fontSize === 'xl' ? 17 : 13 }}
        className="scrollbar-thin"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {/* Load More bar when truncated */}
          {isTruncated && (
            <div className="load-more-bar">
              <ChevronsUp size={12} />
              <span>{userMessageCount - lastNUserPrompts} older prompts hidden</span>
              <button className="btn btn-sm btn-ghost" onClick={handleLoadMore} style={{ fontSize: 10 }}>
                Load 20 more
              </button>
              <button className="btn btn-sm btn-ghost" onClick={handleLoadAll} style={{ fontSize: 10 }}>
                Load all
              </button>
            </div>
          )}

          {mergedItems.map((item, i) => {
            if (item.kind === 'milestone') {
              const m = item.milestone;
              return (
                <MilestoneMarker
                  key={`milestone-${m.id}`}
                  milestone={m}
                  isExpanded={expandedMilestones.has(m.id)}
                  isHighlighted={highlightedMilestoneId === m.id}
                  onToggle={() => setExpandedMilestones(prev => {
                    const next = new Set(prev);
                    if (next.has(m.id)) next.delete(m.id);
                    else next.add(m.id);
                    return next;
                  })}
                />
              );
            }
            const { msg, idx } = item;
            return (
              <MessageBubble
                key={msg.id ? `${msg.id}-${idx}` : idx}
                msg={msg}
                idx={idx}
                viewMode={viewMode}
                smartDisplay={smartDisplay}
                expandState={expanded[idx]}
                onToggleExpand={() => toggleExpand(idx)}
                isSearchMatch={searchMatches.includes(idx)}
                isCurrentMatch={searchMatches[currentMatch] === idx}
                isLastHuman={msg.type === 'human' && msg.id === lastHumanMessageId}
                isCompact={msg.type === 'human' && isCompactMessage(msg.content)}
                isAgent={!!(msg.agentId && (msg.type === 'agent_user' || msg.type === 'agent_assistant'))}
                agentType={msg.subagentType || msg.agentId}
                isActive={msg.id === activeMessageId}
                isNew={newThreshold !== null && msg.lineIndex !== undefined && msg.lineIndex > newThreshold}
                onSetActive={() => msg.id && setActiveMessageId(prev => prev === msg.id ? null : msg.id!)}
                copiedId={copiedId}
                onCopy={handleCopyMessage}
                onOpenAgent={handleOpenAgent}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ============================================
// MilestoneMarker (inline in chat)
// ============================================

function MilestoneMarker({ milestone: m, isExpanded, isHighlighted, onToggle }: { milestone: Milestone; isExpanded: boolean; isHighlighted?: boolean; onToggle: () => void }) {
  const typeColor = milestoneTypeColors[m.type || ''] || '#94a3b8';
  const hasTitle = m.phase === 2 && m.title;
  const totalTools = Object.values(m.toolUseSummary).reduce((a, b) => a + b, 0);

  return (
    <div
      id={`chat-milestone-${m.id}`}
      onClick={onToggle}
      style={{
        borderLeft: `3px solid ${typeColor}`,
        background: isHighlighted ? `${typeColor}25` : `${typeColor}11`,
        borderRadius: 'var(--radius-sm)',
        padding: '4px 10px',
        margin: '2px 0',
        cursor: 'pointer',
        transition: 'box-shadow 0.5s ease, background 0.5s ease',
        ...(isHighlighted ? {
          boxShadow: `0 0 0 2px ${typeColor}88, 0 0 16px ${typeColor}44`,
        } : {}),
      }}
    >
      {/* Line 1 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Flag size={10} style={{ color: typeColor, flexShrink: 0 }} />
        {hasTitle ? (
          <span className="badge" style={{
            fontSize: 8, padding: '0 4px', flexShrink: 0,
            background: `${typeColor}22`, color: typeColor,
            border: `1px solid ${typeColor}44`,
          }}>
            {m.type}
          </span>
        ) : (
          <span className="badge" style={{
            fontSize: 8, padding: '0 4px', flexShrink: 0,
            background: 'rgba(148,163,184,0.15)', color: '#94a3b8',
            border: '1px solid rgba(148,163,184,0.3)',
          }}>
            P1
          </span>
        )}
        <span className="truncate" style={{
          flex: 1, fontSize: 11,
          fontWeight: hasTitle ? 600 : 400,
          color: hasTitle ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
        }}>
          {hasTitle ? m.title : (m.userPrompts[0] || `Milestone #${m.index}`)}
        </span>
        <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
          #{m.startTurn}{m.endTurn !== m.startTurn ? `\u2013#${m.endTurn}` : ''}
        </span>
        {isExpanded ? <ChevronDown size={9} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} /> : <ChevronRight size={9} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />}
      </div>

      {/* Line 2: stats */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 16, fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 1 }}>
        {hasTitle && m.description ? (
          <span className="truncate" style={{ flex: 1 }}>{m.description}</span>
        ) : (
          <>
            {m.filesModified.length > 0 && <span>{m.filesModified.length} files</span>}
            {totalTools > 0 && <span>{totalTools} tools</span>}
            {m.taskCompletions.length > 0 && <span>{m.taskCompletions.length} tasks</span>}
          </>
        )}
      </div>

      {/* Expanded */}
      {isExpanded && (
        <div style={{ marginTop: 6, paddingLeft: 16, paddingTop: 6, borderTop: '1px solid var(--color-border-subtle)', fontSize: 10 }}>
          {m.outcome && (
            <div style={{ marginBottom: 4 }}>
              <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)' }}>Outcome: </span>
              <span style={{ color: 'var(--color-text-secondary)' }}>{m.outcome}</span>
            </div>
          )}
          {m.facts && m.facts.length > 0 && (
            <div style={{ marginBottom: 4 }}>
              <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)' }}>Facts:</span>
              <ul style={{ margin: '2px 0 0 16px', padding: 0, listStyle: 'disc' }}>
                {m.facts.map((f, i) => <li key={i} style={{ color: 'var(--color-text-secondary)', marginBottom: 1 }}>{f}</li>)}
              </ul>
            </div>
          )}
          {m.concepts && m.concepts.length > 0 && (
            <div style={{ marginBottom: 4, display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
              <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)' }}>Concepts: </span>
              {m.concepts.map((c, i) => <span key={i} className="badge" style={{ fontSize: 9, padding: '1px 4px' }}>{c}</span>)}
            </div>
          )}
          {m.filesModified.length > 0 && (
            <div style={{ marginBottom: 4 }}>
              <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)' }}>Files: </span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
                {m.filesModified.join(', ')}
              </span>
            </div>
          )}
          {totalTools > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
              <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)' }}>Tools: </span>
              {Object.entries(m.toolUseSummary).map(([tool, count]) => (
                <span key={tool} className="badge" style={{ fontSize: 9, padding: '1px 4px', fontFamily: 'var(--font-mono)' }}>
                  {tool}: {count}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================
// MessageBubble
// ============================================

interface MessageBubbleProps {
  msg: SessionMessage;
  idx: number;
  viewMode: 'compact' | 'detailed';
  smartDisplay: boolean;
  expandState?: 'expanded' | 'full';
  onToggleExpand: () => void;
  isSearchMatch: boolean;
  isCurrentMatch: boolean;
  isLastHuman: boolean;
  isCompact: boolean;
  isAgent: boolean;
  agentType?: string;
  isActive: boolean;
  isNew: boolean;
  onSetActive: () => void;
  copiedId: string | null;
  onCopy: (id: string, content: string) => void;
  onOpenAgent?: (agentId: string) => void;
}

function MessageBubble({
  msg,
  idx,
  viewMode,
  smartDisplay,
  expandState,
  onToggleExpand,
  isSearchMatch,
  isCurrentMatch,
  isLastHuman,
  isCompact,
  isAgent,
  agentType,
  isActive,
  isNew,
  onSetActive,
  copiedId,
  onCopy,
  onOpenAgent,
}: MessageBubbleProps) {
  const baseConfig = msgTypeConfig[msg.type] || msgTypeConfig.system;
  const isToolCall = !!msg.toolName;
  const config = isToolCall && !['task', 'todo', 'plan', 'agent_user', 'agent_assistant'].includes(msg.type)
    ? { ...baseConfig, icon: Wrench, label: 'TOOL' }
    : baseConfig;
  const Icon = config.icon;
  const content = typeof msg.content === 'string' ? msg.content : '';

  // Smart display transform
  const transformed = smartDisplay ? smartTransformContent(content, msg.type, msg.subtype, msg.agentId) : null;
  const displayContent = transformed || content;

  // Tool call one-liner
  const toolCallStr = isToolCall && smartDisplay
    ? formatToolCallString(msg.toolName!, msg.toolInput)
    : null;

  // Parsed API error (for error type messages)
  const apiError = msg.type === 'error' ? parseApiError(content) : null;

  // Compact preview
  const getPreview = (): string => {
    // API error: show friendly summary
    if (apiError) {
      return `${apiError.statusCode} ${apiError.errorType}: ${apiError.errorMessage}`;
    }
    if (toolCallStr) return toolCallStr;
    // Tool call without smart display: show tool name + JSON snippet
    if (isToolCall && !smartDisplay) {
      const snippet = JSON.stringify(msg.toolInput || {});
      return `${msg.toolName}: ${snippet.length > 150 ? snippet.slice(0, 150) + '...' : snippet}`;
    }
    if (msg.type === 'todo' && msg.todos) {
      const preview = msg.todos.map(t => t.content).join(', ').slice(0, 100);
      return `${msg.todos.length} todos: ${preview}${preview.length >= 100 ? '...' : ''}`;
    }
    if (msg.type === 'task' && msg.toolInput) {
      const inp = msg.toolInput;
      const name = msg.subtype || msg.toolName || '';
      const subject = String(inp.subject || inp.resolvedSubject || '');
      if (name === 'TaskCreate' || name === 'TaskUpdate') {
        const parts = [name === 'TaskCreate' ? 'Created' : `#${inp.taskId || ''}`];
        if (subject) parts.push(subject);
        if (inp.status) parts.push(`-> ${inp.status}`);
        return parts.join(': ');
      }
      return subject || String(inp.taskId || 'task');
    }
    const maxLen = msg.type === 'human' ? 300 : 200;
    return displayContent.length > maxLen ? displayContent.slice(0, maxLen) + '...' : displayContent;
  };

  const chevron = !expandState ? ChevronRight : expandState === 'expanded' ? ChevronDown : ChevronUp;
  const ChevronIcon = chevron;

  const msgId = msg.id || `msg-${idx}`;

  // Get copyable content
  const getCopyContent = (): string => {
    if (msg.type === 'todo' && msg.todos) return JSON.stringify(msg.todos, null, 2);
    if (msg.type === 'task' && msg.toolInput) return JSON.stringify(msg.toolInput, null, 2);
    return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
  };

  // Determine outline style
  const getOutline = () => {
    if (isCurrentMatch) return '2px solid var(--color-accent)';
    if (isSearchMatch) return '1px solid var(--color-accent-dim)';
    return 'none';
  };

  // Badge row for expanded header
  const renderBadges = () => {
    const badges = [];
    if (isLastHuman) {
      badges.push(<span key="last" className="badge badge-green" style={{ fontSize: 9, padding: '0 5px' }}>Last Update</span>);
    }
    if (isCompact) {
      badges.push(<span key="compact" className="badge badge-amber" style={{ fontSize: 9, padding: '0 5px' }}>Compact</span>);
    }
    if (isAgent && agentType) {
      badges.push(
        <span
          key="agent"
          className="badge badge-cyan"
          style={{ fontSize: 9, padding: '0 5px', cursor: onOpenAgent && msg.agentId ? 'pointer' : undefined }}
          onClick={onOpenAgent && msg.agentId ? (e) => { e.stopPropagation(); onOpenAgent(msg.agentId!); } : undefined}
          title={onOpenAgent && msg.agentId ? 'Open agent session in new tab' : undefined}
        >
          {agentType}
        </span>
      );
    }
    return badges;
  };

  const badges = renderBadges();

  return (
    <div
      className={`${config.bg}${isToolCall && !['task', 'todo', 'plan', 'agent_user', 'agent_assistant'].includes(msg.type) ? ' msg-tool' : ''} animate-fade-in${isNew ? ' highlight-update' : ''}`}
      style={{
        cursor: 'pointer',
        outline: getOutline(),
        outlineOffset: isCurrentMatch ? 1 : 0,
        position: 'relative',
        marginLeft: isToolCall && !['task', 'todo', 'plan', 'agent_user', 'agent_assistant'].includes(msg.type) ? 16 : 0,
      }}
      onClick={(e) => {
        // If clicking the copy button, don't toggle
        if ((e.target as HTMLElement).closest('[data-copy-btn]')) return;
        onToggleExpand();
        onSetActive();
      }}
    >
      {/* Collapsed view */}
      {!expandState && viewMode === 'compact' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ChevronIcon size={10} style={{ color: config.iconColor, opacity: 0.6, flexShrink: 0 }} />
          <Icon size={12} style={{ color: config.iconColor, flexShrink: 0 }} />
          {isToolCall && toolCallStr ? (
            <span className="tool-call" style={{ flex: 1, border: 'none', background: 'none', padding: 0 }}>
              <span className="tool-call-name">{formatToolCall(msg.toolName!, msg.toolInput).name}</span>
              <span className="tool-call-args">{formatToolCall(msg.toolName!, msg.toolInput).args}</span>
            </span>
          ) : (
            <span className="truncate" style={{ flex: 1, color: 'var(--color-text-secondary)' }}>
              {getPreview()}
            </span>
          )}
          {badges.length > 0 && <span style={{ display: 'flex', gap: 3 }}>{badges}</span>}
          {msg.turnIndex !== undefined && (
            <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
              #{msg.turnIndex}
            </span>
          )}
          {/* Copy button */}
          <button
            data-copy-btn
            className="btn btn-sm btn-ghost"
            style={{ padding: '1px 3px', opacity: 0.4, flexShrink: 0 }}
            onClick={(e) => { e.stopPropagation(); onCopy(msgId, getCopyContent()); }}
            title="Copy to clipboard"
          >
            {copiedId === msgId ? <Check size={10} style={{ color: 'var(--color-status-green)' }} /> : <Copy size={10} />}
          </button>
        </div>
      )}

      {/* Expanded / full / detailed (detailed = auto-expanded) */}
      {(expandState || viewMode === 'detailed') && (
        <div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <ChevronIcon size={10} style={{ color: config.iconColor, opacity: 0.6, flexShrink: 0, marginTop: 4 }} />
            <Icon size={12} style={{ color: config.iconColor, flexShrink: 0, marginTop: 3 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  maxHeight: (expandState === 'expanded' || (!expandState && viewMode === 'detailed')) ? 240 : undefined,
                  overflow: (expandState === 'expanded' || (!expandState && viewMode === 'detailed')) ? 'auto' : undefined,
                }}
                className={(expandState === 'expanded' || (!expandState && viewMode === 'detailed')) ? 'scrollbar-thin' : ''}
          >
            {/* Tool call detail — smart display ON: structured view */}
            {isToolCall && smartDisplay && (
              <ToolCallDetail toolName={msg.toolName!} input={msg.toolInput} result={msg.toolResult} />
            )}

            {/* Tool call detail — smart display OFF: raw JSON */}
            {isToolCall && !smartDisplay && (
              <pre style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-secondary)',
                background: 'rgba(0,0,0,0.3)',
                padding: 8,
                borderRadius: 'var(--radius-sm)',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}>
                {JSON.stringify({ tool: msg.toolName, input: msg.toolInput, result: msg.toolResult }, null, 2)}
              </pre>
            )}

            {/* Todos */}
            {msg.type === 'todo' && msg.todos && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {msg.todos.map((todo, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    {todo.status === 'completed' ? (
                      <CheckCircle2 size={13} style={{ color: 'var(--color-status-green)', flexShrink: 0 }} />
                    ) : todo.status === 'in_progress' ? (
                      <RotateCcw size={13} style={{ color: 'var(--color-status-blue)', flexShrink: 0, animation: 'spin 2s linear infinite' }} />
                    ) : (
                      <span style={{ width: 13, height: 13, borderRadius: '50%', border: '1.5px solid var(--color-status-yellow)', flexShrink: 0 }} />
                    )}
                    <span style={{
                      flex: 1,
                      ...(todo.status === 'completed' ? { textDecoration: 'line-through', color: 'var(--color-text-tertiary)' } : {}),
                    }}>{todo.content}</span>
                    <span className={`badge badge-${todo.status === 'completed' ? 'green' : todo.status === 'in_progress' ? 'blue' : 'default'}`}
                      style={{ fontSize: 9 }}>
                      {todo.status}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* API Error — structured error display */}
            {msg.type === 'error' && apiError && (
              <div style={{
                padding: '8px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'rgba(153, 27, 27, 0.15)',
                border: '1px solid rgba(248, 113, 113, 0.3)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span className="badge" style={{ fontSize: 10, padding: '2px 8px', background: 'rgba(239,68,68,0.3)', color: '#fca5a5' }}>
                    {apiError.statusCode}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#fca5a5' }}>
                    {apiError.errorType}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                  {apiError.errorMessage}
                </div>
                {apiError.requestId && (
                  <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                    request_id: {apiError.requestId}
                  </div>
                )}
                <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
                  Anthropic server-side error. Usually resolves within minutes. Check status.anthropic.com for outages.
                </div>
              </div>
            )}

            {/* Non-tool content — smart display ON: render markdown */}
            {!isToolCall && msg.type !== 'todo' && msg.type !== 'error' && smartDisplay && (
              <div className="prose" style={msg.type === 'thinking' ? { fontStyle: 'italic', color: 'var(--color-text-tertiary)' } : undefined}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {displayContent}
                </ReactMarkdown>
              </div>
            )}

            {/* Non-tool content — smart display OFF: raw JSON for non-human/assistant, markdown for human/assistant */}
            {!isToolCall && msg.type !== 'todo' && msg.type !== 'error' && !smartDisplay && (
              (msg.type === 'human' || msg.type === 'assistant') ? (
                <div className="prose">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {displayContent}
                  </ReactMarkdown>
                </div>
              ) : (
                <pre style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--color-text-secondary)',
                  background: 'rgba(0,0,0,0.3)',
                  padding: 8,
                  borderRadius: 'var(--radius-sm)',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}>
                  {msg.rawData
                    ? JSON.stringify(msg.rawData, null, 2)
                    : typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2)}
                </pre>
              )
            )}
              </div>
            </div>
            {badges.length > 0 && <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>{badges}</span>}
            {msg.turnIndex !== undefined && (
              <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', flexShrink: 0, marginTop: 3 }}>
                #{msg.turnIndex}
              </span>
            )}
            <button
              data-copy-btn
              className="btn btn-sm btn-ghost"
              style={{ padding: '1px 3px', opacity: 0.4, flexShrink: 0, marginTop: 2 }}
              onClick={(e) => { e.stopPropagation(); onCopy(msgId, getCopyContent()); }}
              title="Copy to clipboard"
            >
              {copiedId === msgId ? <Check size={10} style={{ color: 'var(--color-status-green)' }} /> : <Copy size={10} />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================
// ToolCallDetail (expanded view)
// ============================================

function ToolCallDetail({
  toolName,
  input,
  result,
}: {
  toolName: string;
  input?: Record<string, unknown>;
  result?: string;
}) {
  const inp = input || {};

  const renderInput = () => {
    switch (toolName) {
      case 'Read':
        return (
          <div className="tool-detail tool-detail-read">
            <span className="tool-detail-file">├─ {String(inp.file_path || inp.path || '')}</span>
          </div>
        );

      case 'Edit':
        return (
          <div className="tool-detail tool-detail-edit">
            <span className="tool-detail-file">{String(inp.file_path || inp.path || '')}</span>
            {inp.old_string && (
              <div style={{ marginTop: 2 }}>
                {String(inp.old_string).split('\n').slice(0, 5).map((line, i) => (
                  <div key={i} className="diff-remove" style={{ fontSize: 10, fontFamily: 'var(--font-mono)', lineHeight: 1.3 }}>- {line}</div>
                ))}
              </div>
            )}
            {inp.new_string && (
              <div style={{ marginTop: 1 }}>
                {String(inp.new_string).split('\n').slice(0, 5).map((line, i) => (
                  <div key={i} className="diff-add" style={{ fontSize: 10, fontFamily: 'var(--font-mono)', lineHeight: 1.3 }}>+ {line}</div>
                ))}
              </div>
            )}
          </div>
        );

      case 'Write': {
        const content = String(inp.content || '');
        const lines = content.split('\n');
        return (
          <div className="tool-detail tool-detail-write">
            <span className="tool-detail-file">{String(inp.file_path || '')} ({lines.length} lines)</span>
            <div style={{ marginTop: 2, fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)', lineHeight: 1.3 }}>
              {lines.slice(0, 3).map((line, i) => <div key={i}>{line}</div>)}
              {lines.length > 3 && <div>...</div>}
            </div>
          </div>
        );
      }

      case 'Bash':
        return (
          <div className="tool-detail tool-detail-bash">
            <code style={{ fontSize: 10, color: 'var(--color-status-purple)' }}>
              {String(inp.command || '').slice(0, 150)}
            </code>
            {inp.description && (
              <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 1 }}>
                {String(inp.description)}
              </div>
            )}
          </div>
        );

      case 'Grep':
        return (
          <div className="tool-detail">
            <span style={{ color: 'var(--color-status-cyan)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
              pattern=&quot;{String(inp.pattern || '')}&quot;{inp.path ? ` path=${inp.path}` : ''}{inp.glob ? ` glob=${inp.glob}` : ''}
            </span>
          </div>
        );

      case 'Glob':
        return (
          <div className="tool-detail">
            <span style={{ color: 'var(--color-status-cyan)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
              {String(inp.pattern || '')}{inp.path ? ` in ${inp.path}` : ''}
            </span>
          </div>
        );

      case 'Task':
        return (
          <div className="tool-detail">
            <span className="badge badge-purple" style={{ marginRight: 6 }}>{String(inp.subagent_type || 'agent')}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
              {String(inp.description || '')}
            </span>
            {inp.prompt && (
              <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                {String(inp.prompt).slice(0, 300)}
              </div>
            )}
          </div>
        );

      case 'TaskCreate':
        return (
          <div className="tool-detail">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="badge badge-green" style={{ fontSize: 9 }}>CREATE</span>
              <span style={{ fontSize: 11, fontWeight: 600 }}>{String(inp.subject || '')}</span>
            </div>
            {inp.description && (
              <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 1 }}>
                {String(inp.description).slice(0, 200)}
              </div>
            )}
          </div>
        );

      case 'TaskUpdate':
        return (
          <div className="tool-detail">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="badge badge-blue" style={{ fontSize: 9 }}>UPDATE</span>
              <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>#{String(inp.taskId || '')}</span>
              {inp.status && (
                <span className={`badge badge-${inp.status === 'completed' ? 'green' : inp.status === 'in_progress' ? 'blue' : 'default'}`} style={{ fontSize: 9 }}>
                  {String(inp.status)}
                </span>
              )}
            </div>
            {inp.subject && <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{String(inp.subject)}</div>}
            {inp.description && <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 1 }}>{String(inp.description).slice(0, 200)}</div>}
          </div>
        );

      case 'TaskGet':
      case 'TaskList':
        return (
          <div className="tool-detail">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="badge badge-default" style={{ fontSize: 9 }}>{toolName === 'TaskGet' ? 'GET' : 'LIST'}</span>
              {inp.taskId && <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>#{String(inp.taskId)}</span>}
            </div>
          </div>
        );

      case 'WebFetch':
        return (
          <div className="tool-detail">
            <span className="badge badge-cyan" style={{ fontSize: 9, marginRight: 6 }}>FETCH</span>
            {inp.url && <span style={{ fontSize: 10, color: 'var(--color-status-blue)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{String(inp.url)}</span>}
            {inp.prompt && <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 1 }}>{String(inp.prompt).slice(0, 150)}</div>}
          </div>
        );

      case 'WebSearch':
        return (
          <div className="tool-detail">
            <span className="badge badge-cyan" style={{ fontSize: 9, marginRight: 6 }}>SEARCH</span>
            <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)' }}>
              &quot;{String(inp.query || '')}&quot;
            </span>
          </div>
        );

      case 'EnterPlanMode':
        return (
          <div className="tool-detail" style={{ background: 'rgba(217,119,6,0.08)', padding: '4px 8px', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="badge badge-yellow" style={{ fontSize: 9, fontFamily: 'var(--font-mono)' }}>ENTER</span>
              <span style={{ fontSize: 10, fontWeight: 500, color: '#d97706' }}>Entering Plan Mode</span>
            </div>
          </div>
        );

      case 'ExitPlanMode':
        return (
          <div className="tool-detail" style={{ background: 'rgba(22,163,106,0.08)', padding: '4px 8px', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="badge badge-green" style={{ fontSize: 9, fontFamily: 'var(--font-mono)' }}>APPROVED</span>
              {inp.planTitle && (
                <span style={{ fontSize: 10, fontWeight: 600 }}>{String(inp.planTitle)}</span>
              )}
            </div>
            {inp.planSummary && (
              <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 1 }}>
                {String(inp.planSummary).slice(0, 200)}
              </div>
            )}
            {inp.allowedPrompts && Array.isArray(inp.allowedPrompts) && (inp.allowedPrompts as any[]).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {(inp.allowedPrompts as any[]).map((ap: any, i: number) => (
                  <span key={i} className="badge badge-default" style={{ fontSize: 9 }}>
                    {ap.tool}: {ap.prompt}
                  </span>
                ))}
              </div>
            )}
          </div>
        );

      case 'Teammate':
        return (
          <div className="tool-detail" style={{ background: 'rgba(139,92,246,0.08)', padding: '4px 8px', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="badge" style={{ fontSize: 9, background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', border: '1px solid rgba(139,92,246,0.3)' }}>
                {String(inp.operation || 'spawnTeam').toUpperCase()}
              </span>
              {inp.team_name && <span style={{ fontSize: 11, fontWeight: 600 }}>{String(inp.team_name)}</span>}
            </div>
            {inp.description && (
              <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 1 }}>
                {String(inp.description)}
              </div>
            )}
          </div>
        );

      case 'SendMessage':
        return (
          <div className="tool-detail" style={{ background: 'rgba(139,92,246,0.08)', padding: '4px 8px', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="badge" style={{ fontSize: 9, background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', border: '1px solid rgba(139,92,246,0.3)' }}>
                {String(inp.type || 'message').toUpperCase()}
              </span>
              {inp.recipient && <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>{'\u2192'}{String(inp.recipient)}</span>}
            </div>
            {inp.summary && <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 1 }}>{String(inp.summary)}</div>}
            {inp.content && <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 1 }}>{String(inp.content).slice(0, 200)}</div>}
          </div>
        );

      default:
        // Browser tools
        if (toolName.includes('chrome') || toolName.includes('Browser')) {
          return (
            <div className="tool-detail">
              {inp.action && <span style={{ fontSize: 11 }}>Action: {String(inp.action)}</span>}
              {inp.coordinate && <span style={{ fontSize: 11 }}> at ({String(inp.coordinate)})</span>}
              {inp.text && <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>Text: {String(inp.text).slice(0, 50)}</div>}
              {inp.url && <div style={{ fontSize: 11, color: 'var(--color-status-blue)' }}>{String(inp.url).slice(0, 60)}</div>}
              {inp.query && <div style={{ fontSize: 11 }}>Query: &quot;{String(inp.query)}&quot;</div>}
            </div>
          );
        }

        // Fallback
        return (
          <div className="tool-detail">
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
              {formatToolCallString(toolName, input)}
            </span>
          </div>
        );
    }
  };

  return (
    <div>
      {renderInput()}
      {result && (
        <ToolResultBlock result={result} toolName={toolName} />
      )}
    </div>
  );
}

/** Render tool result with proper code formatting and indentation. */
function ToolResultBlock({ result, toolName }: { result: string; toolName: string }) {
  // Skip very short or empty results
  const trimmed = result.trim();
  if (!trimmed || trimmed === '{}' || trimmed === 'null' || trimmed === 'undefined') return null;

  // Determine if result looks like code/structured output
  const maxPreview = 500;
  const truncated = trimmed.length > maxPreview;
  const displayText = truncated ? trimmed.slice(0, maxPreview) : trimmed;

  // Check if the result is JSON
  let jsonFormatted: string | null = null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      jsonFormatted = JSON.stringify(JSON.parse(trimmed), null, 2);
      if (jsonFormatted.length > maxPreview) {
        jsonFormatted = jsonFormatted.slice(0, maxPreview);
      }
    } catch { /* not valid JSON */ }
  }

  // For Read tool results, show as numbered code lines
  const isFileContent = toolName === 'Read' && trimmed.includes('\n');
  // For Bash results, show as terminal output
  const isTerminalOutput = toolName === 'Bash';
  // For Grep/Glob results, show as file list or match output
  const isSearchResult = toolName === 'Grep' || toolName === 'Glob';

  const borderColor = isTerminalOutput ? 'var(--color-status-purple)'
    : isFileContent ? 'var(--color-status-blue)'
    : isSearchResult ? 'var(--color-status-cyan)'
    : 'var(--color-border-default)';

  return (
    <div style={{ marginTop: 2, marginLeft: 2 }}>
      <pre
        className="scrollbar-thin"
        style={{
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          lineHeight: 1.35,
          color: 'var(--color-text-secondary)',
          background: 'rgba(0, 0, 0, 0.25)',
          padding: '4px 8px',
          borderRadius: 4,
          borderLeft: `2px solid ${borderColor}`,
          overflow: 'auto',
          maxHeight: 200,
          whiteSpace: 'pre',
          tabSize: 2,
          margin: 0,
        }}
      >
        {jsonFormatted || displayText}
        {truncated && !jsonFormatted && <span style={{ color: 'var(--color-text-tertiary)' }}>{'\n'}... ({trimmed.length} chars total)</span>}
      </pre>
    </div>
  );
}
