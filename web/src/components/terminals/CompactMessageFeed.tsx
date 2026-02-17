'use client';

import { useEffect, useRef, useMemo, useState, useCallback, memo, type ReactNode } from 'react';
import {
  User, Bot, Wrench, Sparkles, CheckCircle2, ListChecks, Cpu,
  Pin, PinOff, Copy, Check, X
} from 'lucide-react';
import type { SessionMessage } from '@/lib/types';

// ============================================================================
// Types
// ============================================================================

export type ConvType = 'user' | 'assistant' | 'thinking' | 'tools' | 'todos' | 'tasks' | 'agents';

export interface CompactMessageFeedProps {
  messages: SessionMessage[];
  showTypes: Record<ConvType, boolean>;
  isExpanded: boolean;
  autoScroll?: boolean;
  className?: string;
  /** Max messages to display (expanded). Collapsed shows 30% of this. Default: 50 */
  messageLimit?: number;
}

// ============================================================================
// Smart Display Helpers
// ============================================================================

function shouldHideInSmartDisplay(msg: SessionMessage): boolean {
  const content = typeof msg.content === 'string' ? msg.content : '';

  if (content.includes('[SUGGESTION MODE:') || content.includes('SUGGESTION MODE:')) {
    return true;
  }

  if (msg.type === 'system' && msg.subtype === 'stop_hook_summary') {
    return true;
  }

  if (msg.type === 'progress') {
    return true;
  }

  if (msg.type === 'file-history-snapshot') {
    return true;
  }

  if (msg.type === 'system' && msg.subtype === 'init') {
    return true;
  }

  return false;
}

function formatToolCall(toolName: string, input: any): { name: string; args: string } {
  const inputObj = typeof input === 'object' && input ? input : {};

  switch (toolName) {
    case 'Read':
      return { name: 'Read', args: inputObj.file_path || '' };
    case 'Edit':
      return { name: 'Update', args: inputObj.file_path || '' };
    case 'Write':
      return { name: 'Write', args: inputObj.file_path || '' };
    case 'Bash': {
      const cmd = inputObj.command || '';
      return { name: 'Bash', args: cmd.length > 60 ? cmd.slice(0, 60) + '...' : cmd };
    }
    case 'Grep':
      return { name: 'Grep', args: `"${inputObj.pattern || ''}"` };
    case 'Glob':
      return { name: 'Glob', args: inputObj.pattern || '' };
    case 'Task': {
      const taskType = inputObj.subagent_type || 'agent';
      const taskDesc = inputObj.description || '';
      return { name: `Task[${taskType}]`, args: taskDesc.length > 40 ? taskDesc.slice(0, 40) + '...' : taskDesc };
    }
    case 'TaskCreate':
      return { name: 'TaskCreate', args: inputObj.subject || '' };
    case 'TaskUpdate':
      return { name: 'TaskUpdate', args: `#${inputObj.taskId}${inputObj.status ? ' -> ' + inputObj.status : ''}` };
    case 'TaskList':
      return { name: 'TaskList', args: '' };
    case 'WebFetch': {
      const url = inputObj.url || '';
      return { name: 'WebFetch', args: url.length > 50 ? url.slice(0, 50) + '...' : url };
    }
    case 'WebSearch':
      return { name: 'WebSearch', args: `"${inputObj.query || ''}"` };
    default:
      if (toolName.startsWith('mcp__claude-in-chrome__')) {
        const shortName = toolName.replace('mcp__claude-in-chrome__', '');
        return { name: `Browser.${shortName}`, args: '' };
      }
      if (toolName.startsWith('mcp__')) {
        return { name: toolName.replace('mcp__', ''), args: '' };
      }
      return { name: toolName, args: '' };
  }
}

function getContentPreview(content: any, maxLength: number): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') {
    const cleaned = content.replace(/\n+/g, ' ').trim();
    return cleaned.length > maxLength ? cleaned.slice(0, maxLength) + '...' : cleaned;
  }
  if (Array.isArray(content)) {
    const text = content.map((b: any) => b.text || '').join(' ');
    return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
  }
  return JSON.stringify(content).slice(0, maxLength);
}

/** Extract raw text content, preserving newlines (for tooltips). */
function getContentFullText(content: any, maxLength: number): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) + '...' : trimmed;
  }
  if (Array.isArray(content)) {
    const text = content.map((b: any) => b.text || '').join('\n');
    return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
  }
  return JSON.stringify(content).slice(0, maxLength);
}

/** Get full text for a message (used in tooltips). */
function getMessageFullText(msg: SessionMessage): string {
  // Tool calls
  if (msg.type === 'assistant' && msg.subtype === 'tool_use' && msg.toolName) {
    const { name, args } = formatToolCall(msg.toolName, msg.toolInput);
    return args ? `${name}(${args})` : name;
  }
  // Todos
  if (msg.type === 'todo' && msg.todos) {
    const completed = msg.todos.filter(t => t.status === 'completed').length;
    return `${completed}/${msg.todos.length} todos:\n${msg.todos.map(t => `${t.status === 'completed' ? '✓' : '○'} ${t.content}`).join('\n')}`;
  }
  // Tasks
  if (msg.type === 'task' && msg.toolInput?.subject) {
    return `${msg.toolName === 'TaskCreate' ? 'Created' : 'Updated'}: ${String(msg.toolInput.subject)}`;
  }
  // Agent messages
  if (msg.type === 'agent_user' || msg.type === 'agent_assistant') {
    return `[${msg.subagentType || 'agent'}] ${getContentFullText(msg.content, 500)}`;
  }
  // Default: full content text preserving newlines
  return getContentFullText(msg.content, 500);
}

export function inlineMarkdown(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(\*\*(.+?)\*\*|`(.+?)`|\[(.+?)\]\((.+?)\))/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push(<span key={key++} style={{ color: '#94a3b8' }}>{text.slice(lastIndex, m.index)}</span>);
    }
    if (m[2]) {
      parts.push(<strong key={key++} style={{ color: '#f1f5f9', fontWeight: 600 }}>{m[2]}</strong>);
    } else if (m[3]) {
      parts.push(
        <code key={key++} style={{
          fontSize: '0.9em',
          background: 'rgba(56, 189, 248, 0.12)',
          color: '#7dd3fc',
          padding: '1px 4px',
          borderRadius: 3,
          border: '1px solid rgba(56, 189, 248, 0.15)',
        }}>
          {m[3]}
        </code>
      );
    } else if (m[4] && m[5]) {
      parts.push(<span key={key++} style={{ color: '#60a5fa', textDecoration: 'underline' }}>{m[4]}</span>);
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(<span key={key++} style={{ color: '#94a3b8' }}>{text.slice(lastIndex)}</span>);
  }
  return parts.length > 0 ? parts : [<span key={0} style={{ color: '#94a3b8' }}>{text}</span>];
}

/**
 * Map message type to ConvType for filtering.
 * In langmart-assistant, tool uses are type:'assistant' with subtype:'tool_use'.
 */
function getConvType(msg: SessionMessage): ConvType | null {
  switch (msg.type) {
    case 'human':
      return 'user';
    case 'assistant':
      if (msg.subtype === 'tool_use') return 'tools';
      return 'assistant';
    case 'thinking':
      return 'thinking';
    case 'todo':
      return 'todos';
    case 'task':
      return 'tasks';
    case 'agent_user':
    case 'agent_assistant':
      return 'agents';
    default:
      return null;
  }
}

// Border-left colors per message type (dark mode)
const BORDER_COLORS: Record<string, string> = {
  human: 'rgba(96, 165, 250, 0.7)',
  assistant: 'rgba(167, 139, 250, 0.5)',
  thinking: 'rgba(148, 163, 184, 0.4)',
  tool_use: 'rgba(156, 163, 175, 0.4)',
  todo: 'rgba(74, 222, 128, 0.5)',
  task: 'rgba(129, 140, 248, 0.5)',
  agent_user: 'rgba(34, 211, 238, 0.5)',
  agent_assistant: 'rgba(34, 211, 238, 0.5)',
};

const BG_COLORS: Record<string, string> = {
  human: 'rgba(59, 130, 246, 0.08)',
  assistant: 'rgba(139, 92, 246, 0.06)',
  thinking: 'rgba(100, 116, 139, 0.06)',
  tool_use: 'rgba(107, 114, 128, 0.06)',
  todo: 'rgba(34, 197, 94, 0.06)',
  task: 'rgba(99, 102, 241, 0.06)',
  agent_user: 'rgba(6, 182, 212, 0.06)',
  agent_assistant: 'rgba(6, 182, 212, 0.06)',
};

// ============================================================================
// Component
// ============================================================================

export function CompactMessageFeed({ messages, showTypes, isExpanded, autoScroll = true, className = '', messageLimit = 50 }: CompactMessageFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevMessageCountRef = useRef(0);
  const [newMessageThreshold, setNewMessageThreshold] = useState(0);
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number; rowTop: number; pinned?: boolean } | null>(null);
  const [tooltipCopied, setTooltipCopied] = useState(false);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const displayedMessages = useMemo(() => {
    let filtered = messages.filter(msg => !shouldHideInSmartDisplay(msg));

    filtered = filtered.filter(msg => {
      const convType = getConvType(msg);
      if (convType === null) return false;
      return showTypes[convType];
    });

    const limit = isExpanded ? messageLimit : Math.max(10, Math.round(messageLimit * 0.3));
    return filtered.slice(-limit);
  }, [messages, showTypes, isExpanded]);

  const lastMessageKey = displayedMessages.length > 0
    ? (displayedMessages[displayedMessages.length - 1].id || `${displayedMessages[displayedMessages.length - 1].lineIndex}`)
    : '';

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }

    if (displayedMessages.length > prevMessageCountRef.current && prevMessageCountRef.current > 0) {
      setNewMessageThreshold(prevMessageCountRef.current);
      const timer = setTimeout(() => setNewMessageThreshold(0), 2000);
      return () => clearTimeout(timer);
    }
    prevMessageCountRef.current = displayedMessages.length;
  }, [displayedMessages.length, lastMessageKey, autoScroll]);

  const getIcon = (msg: SessionMessage) => {
    if (msg.type === 'assistant' && msg.subtype === 'tool_use') {
      return <Wrench size={12} style={{ color: 'rgba(156, 163, 175, 0.8)', flexShrink: 0 }} />;
    }
    switch (msg.type) {
      case 'human':
        return <User size={12} style={{ color: 'rgba(96, 165, 250, 0.9)', flexShrink: 0 }} />;
      case 'assistant':
        return <Bot size={12} style={{ color: 'rgba(167, 139, 250, 0.8)', flexShrink: 0 }} />;
      case 'thinking':
        return <Sparkles size={12} style={{ color: 'rgba(148, 163, 184, 0.7)', flexShrink: 0 }} />;
      case 'todo':
        return <CheckCircle2 size={12} style={{ color: 'rgba(74, 222, 128, 0.8)', flexShrink: 0 }} />;
      case 'task':
        return <ListChecks size={12} style={{ color: 'rgba(129, 140, 248, 0.8)', flexShrink: 0 }} />;
      case 'agent_user':
      case 'agent_assistant':
        return <Cpu size={12} style={{ color: 'rgba(34, 211, 238, 0.8)', flexShrink: 0 }} />;
      default:
        return <Wrench size={12} style={{ color: 'rgba(156, 163, 175, 0.5)', flexShrink: 0 }} />;
    }
  };

  const renderContent = (msg: SessionMessage) => {
    // Tool calls
    if (msg.type === 'assistant' && msg.subtype === 'tool_use' && msg.toolName) {
      const { name, args } = formatToolCall(msg.toolName, msg.toolInput);
      return (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-tertiary)' }}>
          <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)' }}>{name}</span>
          {args && <span>({args})</span>}
        </span>
      );
    }

    // Todos
    if (msg.type === 'todo' && msg.todos) {
      const completed = msg.todos.filter(t => t.status === 'completed').length;
      return (
        <span style={{ color: 'rgba(134, 239, 172, 0.9)' }}>
          {completed}/{msg.todos.length} todos: {msg.todos.map(t => t.content).join(', ').slice(0, 60)}
          {msg.todos.map(t => t.content).join(', ').length > 60 ? '...' : ''}
        </span>
      );
    }

    // Tasks
    if (msg.type === 'task') {
      const taskInput = msg.toolInput;
      if (taskInput?.subject) {
        return (
          <span style={{ color: 'rgba(165, 180, 252, 0.9)' }}>
            {msg.toolName === 'TaskCreate' ? 'Created: ' : 'Updated: '}
            {String(taskInput.subject)}
          </span>
        );
      }
    }

    // Agent messages
    if (msg.type === 'agent_user' || msg.type === 'agent_assistant') {
      return (
        <span style={{ color: 'rgba(103, 232, 249, 0.9)' }}>
          [{msg.subagentType || 'agent'}] {getContentPreview(msg.content, 80)}
        </span>
      );
    }

    // Thinking
    if (msg.type === 'thinking') {
      return (
        <span style={{ fontStyle: 'italic', color: 'rgba(148, 163, 184, 0.7)' }}>
          {getContentPreview(msg.content, 80)}
        </span>
      );
    }

    // Human
    if (msg.type === 'human') {
      return (
        <span style={{ color: 'var(--color-text-primary)' }}>
          {getContentPreview(msg.content, 150)}
        </span>
      );
    }

    // Assistant
    if (msg.type === 'assistant') {
      const preview = getContentPreview(msg.content, 150);
      return (
        <span style={{ color: 'var(--color-text-secondary)' }}>
          {inlineMarkdown(preview)}
        </span>
      );
    }

    return (
      <span style={{ color: 'var(--color-text-secondary)' }}>
        {getContentPreview(msg.content, 80)}
      </span>
    );
  };

  // Tooltip: event delegation on the scroll container
  const handleMouseOver = useCallback((e: React.MouseEvent) => {
    if (tooltip?.pinned) return;
    const row = (e.target as HTMLElement).closest('[data-msg-idx]') as HTMLElement | null;
    if (!row) { if (!tooltip?.pinned) setTooltip(null); return; }
    // If a tooltip is already showing and fading out, don't replace it — let user reach it
    if (tooltip && tooltipTimerRef.current) return;
    const idx = Number(row.dataset.msgIdx);
    const msg = displayedMessages[idx];
    if (!msg) return;
    const text = getMessageFullText(msg);
    if (!text) return;
    const rect = row.getBoundingClientRect();
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    setTooltip({ text, x: rect.left, y: rect.bottom + 4, rowTop: rect.top });
    setTooltipCopied(false);
  }, [displayedMessages, tooltip?.pinned, tooltip]);

  const handleMouseOut = useCallback((e: React.MouseEvent) => {
    if (tooltip?.pinned) return;
    const related = e.relatedTarget as HTMLElement | null;
    if (related?.closest('[data-msg-idx]')) return;
    if (related?.closest('[data-tooltip]')) return;
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    tooltipTimerRef.current = setTimeout(() => setTooltip(null), 1000);
  }, [tooltip?.pinned]);

  const handleTooltipEnter = useCallback(() => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
  }, []);

  const handleTooltipLeave = useCallback(() => {
    if (tooltip?.pinned) return;
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    tooltipTimerRef.current = setTimeout(() => setTooltip(null), 1000);
  }, [tooltip?.pinned]);

  const handleTooltipPin = useCallback(() => {
    setTooltip(prev => prev ? { ...prev, pinned: !prev.pinned } : null);
  }, []);

  const handleTooltipCopy = useCallback(() => {
    if (!tooltip) return;
    navigator.clipboard.writeText(tooltip.text);
    setTooltipCopied(true);
    setTimeout(() => setTooltipCopied(false), 1500);
  }, [tooltip]);

  const handleTooltipClose = useCallback(() => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    setTooltip(null);
    setTooltipCopied(false);
  }, []);

  if (displayedMessages.length === 0) {
    return (
      <div className={className} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
        No messages to display
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className={`scrollbar-thin ${className}`}
      style={{ overflow: 'auto', position: 'relative' }}
      onMouseOver={handleMouseOver}
      onMouseOut={handleMouseOut}
    >
      <div style={{ padding: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {displayedMessages.map((msg, idx) => {
          const msgTypeKey = msg.type === 'assistant' && msg.subtype === 'tool_use' ? 'tool_use' : msg.type;
          return (
            <MessageRow
              key={msg.id || `${msg.turnIndex}-${msg.lineIndex}-${idx}`}
              msg={msg}
              idx={idx}
              isNew={newMessageThreshold > 0 && idx >= newMessageThreshold}
              icon={getIcon(msg)}
              borderColor={BORDER_COLORS[msgTypeKey] || 'transparent'}
              bgColor={BG_COLORS[msgTypeKey] || 'transparent'}
              content={renderContent(msg)}
            />
          );
        })}
      </div>
      {tooltip && (() => {
        const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
        const spaceBelow = vh - tooltip.y;
        const flipUp = spaceBelow < 200;
        const left = Math.max(8, Math.min(tooltip.x, vw - 24));
        const top = flipUp ? undefined : Math.max(8, tooltip.y);
        const bottom = flipUp ? Math.max(8, vh - tooltip.rowTop + 4) : undefined;
        const maxH = flipUp
          ? `calc(100vh - ${Math.max(8, vh - tooltip.rowTop + 4) + 16}px)`
          : `calc(100vh - ${Math.max(8, tooltip.y) + 16}px)`;
        return (
        <div
          data-tooltip
          onMouseEnter={handleTooltipEnter}
          onMouseLeave={handleTooltipLeave}
          className="terminal-grid-scroll"
          style={{
            position: 'fixed',
            left,
            top,
            bottom,
            maxWidth: `calc(100vw - ${left + 16}px)`,
            maxHeight: maxH,
            zIndex: 9999,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '8px 12px',
            paddingTop: 4,
            fontSize: 11,
            lineHeight: 1.5,
            color: '#e2e8f0',
            background: 'rgba(15, 23, 42, 0.96)',
            border: `1px solid ${tooltip.pinned ? 'rgba(250, 204, 21, 0.4)' : 'rgba(148, 163, 184, 0.2)'}`,
            borderRadius: 6,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            wordBreak: 'break-word',
          }}
        >
          {/* Toolbar */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 2, marginBottom: 4, position: 'sticky', top: 0 }}>
            <button
              onClick={handleTooltipCopy}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 4, padding: '2px 6px', cursor: 'pointer',
                color: tooltipCopied ? '#4ade80' : '#94a3b8', fontSize: 10,
              }}
            >
              {tooltipCopied ? <><Check size={10} /> Copied</> : <><Copy size={10} /> Copy</>}
            </button>
            <button
              onClick={handleTooltipPin}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                background: tooltip.pinned ? 'rgba(250, 204, 21, 0.15)' : 'rgba(255,255,255,0.06)',
                border: `1px solid ${tooltip.pinned ? 'rgba(250, 204, 21, 0.3)' : 'rgba(255,255,255,0.1)'}`,
                borderRadius: 4, padding: '2px 6px', cursor: 'pointer',
                color: tooltip.pinned ? '#facc15' : '#94a3b8', fontSize: 10,
              }}
            >
              {tooltip.pinned ? <><PinOff size={10} /> Unpin</> : <><Pin size={10} /> Pin</>}
            </button>
            {tooltip.pinned && (
              <button
                onClick={handleTooltipClose}
                style={{
                  display: 'inline-flex', alignItems: 'center',
                  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 4, padding: '2px 4px', cursor: 'pointer',
                  color: '#94a3b8', fontSize: 10,
                }}
              >
                <X size={10} />
              </button>
            )}
          </div>
          {/* Content */}
          {tooltip.text.split('\n').map((line, i) => (
            <div key={i} style={{ minHeight: 16 }}>{inlineMarkdown(line)}</div>
          ))}
        </div>
        );
      })()}
    </div>
  );
}

const MessageRow = memo(function MessageRow({
  msg, idx, isNew, icon, borderColor, bgColor, content,
}: {
  msg: SessionMessage;
  idx: number;
  isNew: boolean;
  icon: ReactNode;
  borderColor: string;
  bgColor: string;
  content: ReactNode;
}) {
  return (
    <div
      data-msg-idx={idx}
      className={isNew ? 'compact-msg-new' : ''}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '1px 6px',
        borderRadius: 3,
        fontSize: 10,
        borderLeft: `2px solid ${borderColor}`,
        background: bgColor,
      }}
    >
      {icon}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {content}
      </span>
      {msg.turnIndex !== undefined && (
        <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', flexShrink: 0, opacity: 0.6 }}>
          #{msg.turnIndex}
        </span>
      )}
    </div>
  );
});

export default CompactMessageFeed;
