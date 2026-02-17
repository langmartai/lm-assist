'use client';

import {
  User, Bot, Sparkles, Wrench, CheckCircle2, ListChecks, Cpu,
  XCircle, RefreshCw, ArrowDownToLine,
  Grid3x3, LayoutGrid, Columns3, Rows3
} from 'lucide-react';
import type { ConvType } from './CompactMessageFeed';

// ============================================================================
// Types
// ============================================================================

export type LayoutMode = 'grid' | '3x2' | '2col' | 'rows';

export interface TerminalFilterBarProps {
  showTypes: Record<ConvType, boolean>;
  onToggleType: (type: ConvType) => void;
  layoutMode: LayoutMode;
  onSetLayoutMode: (mode: LayoutMode) => void;
  showRunningOnly: boolean;
  onToggleRunningOnly: () => void;
  autoScroll: boolean;
  onToggleAutoScroll: () => void;
  runningCount: number;
  totalCount: number;
  onCloseAll: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
}

// ============================================================================
// Filter Button Configs
// ============================================================================

const TYPE_BUTTONS: Array<{
  type: ConvType;
  label: string;
  Icon: typeof User;
  activeColor: string;
  activeBg: string;
}> = [
  { type: 'user', label: 'User', Icon: User, activeColor: 'rgba(96, 165, 250, 0.9)', activeBg: 'rgba(59, 130, 246, 0.15)' },
  { type: 'assistant', label: 'Asst', Icon: Bot, activeColor: 'rgba(167, 139, 250, 0.9)', activeBg: 'rgba(139, 92, 246, 0.15)' },
  { type: 'thinking', label: 'Think', Icon: Sparkles, activeColor: 'rgba(148, 163, 184, 0.9)', activeBg: 'rgba(100, 116, 139, 0.15)' },
  { type: 'tools', label: 'Tools', Icon: Wrench, activeColor: 'rgba(156, 163, 175, 0.9)', activeBg: 'rgba(107, 114, 128, 0.15)' },
  { type: 'todos', label: 'Todos', Icon: CheckCircle2, activeColor: 'rgba(74, 222, 128, 0.9)', activeBg: 'rgba(34, 197, 94, 0.15)' },
  { type: 'tasks', label: 'Tasks', Icon: ListChecks, activeColor: 'rgba(129, 140, 248, 0.9)', activeBg: 'rgba(99, 102, 241, 0.15)' },
  { type: 'agents', label: 'Agents', Icon: Cpu, activeColor: 'rgba(34, 211, 238, 0.9)', activeBg: 'rgba(6, 182, 212, 0.15)' },
];

// ============================================================================
// Component
// ============================================================================

export function TerminalFilterBar({
  showTypes,
  onToggleType,
  layoutMode,
  onSetLayoutMode,
  showRunningOnly,
  onToggleRunningOnly,
  autoScroll,
  onToggleAutoScroll,
  runningCount,
  totalCount,
  onCloseAll,
  onRefresh,
  isRefreshing,
}: TerminalFilterBarProps) {
  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 8,
      padding: '6px 12px',
      borderBottom: '1px solid var(--color-border-default)',
      background: 'var(--color-bg-surface)',
    }}>
      {/* Message type filters */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        border: '1px solid var(--color-border-default)',
        borderRadius: 'var(--radius-md)',
        padding: '2px 4px',
        background: 'var(--color-bg-elevated)',
      }}>
        {TYPE_BUTTONS.map(({ type, label, Icon, activeColor, activeBg }) => {
          const isActive = showTypes[type];
          return (
            <button
              key={type}
              className="btn btn-sm btn-ghost"
              onClick={() => onToggleType(type)}
              title={`Show/hide ${label.toLowerCase()} messages`}
              style={{
                height: 20,
                padding: '0 4px',
                fontSize: 9,
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                color: isActive ? activeColor : 'var(--color-text-tertiary)',
                background: isActive ? activeBg : 'transparent',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <Icon size={12} />
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      {/* Running only filter */}
      <button
        className="btn btn-sm btn-ghost"
        onClick={onToggleRunningOnly}
        title="Show only running terminals"
        style={{
          height: 20,
          padding: '0 8px',
          fontSize: 9,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          color: showRunningOnly ? 'rgba(74, 222, 128, 0.9)' : 'var(--color-text-tertiary)',
          background: showRunningOnly ? 'rgba(34, 197, 94, 0.15)' : 'transparent',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        <span style={{ position: 'relative', display: 'flex', width: 8, height: 8 }}>
          {runningCount > 0 && (
            <span className="terminal-ping" style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              background: 'rgba(74, 222, 128, 0.6)',
            }} />
          )}
          <span style={{
            position: 'relative',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: runningCount > 0 ? '#4ade80' : '#6b7280',
          }} />
        </span>
        Running ({runningCount})
      </button>

      {/* Auto-scroll toggle */}
      <button
        className="btn btn-sm btn-ghost"
        onClick={onToggleAutoScroll}
        title="Auto-scroll to latest messages"
        style={{
          height: 20,
          padding: '0 8px',
          fontSize: 9,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          color: autoScroll ? 'rgba(251, 146, 60, 0.9)' : 'var(--color-text-tertiary)',
          background: autoScroll ? 'rgba(249, 115, 22, 0.15)' : 'transparent',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        <ArrowDownToLine size={12} />
        Auto-scroll
      </button>

      <div style={{ flex: 1 }} />

      {/* Session count */}
      <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
        {totalCount} session{totalCount !== 1 ? 's' : ''}
      </span>

      {/* Layout mode toggle */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        border: '1px solid var(--color-border-default)',
        borderRadius: 'var(--radius-sm)',
        padding: '2px',
        background: 'var(--color-bg-elevated)',
      }}>
        {([
          { mode: 'grid' as LayoutMode, Icon: Grid3x3, title: 'Auto-fill grid (4+ columns)' },
          { mode: '3x2' as LayoutMode, Icon: LayoutGrid, title: '3 columns × 2 rows' },
          { mode: '2col' as LayoutMode, Icon: Columns3, title: '2 columns' },
          { mode: 'rows' as LayoutMode, Icon: Rows3, title: 'Single column' },
        ]).map(({ mode, Icon, title }) => (
          <button
            key={mode}
            className="btn btn-sm btn-ghost"
            onClick={() => onSetLayoutMode(mode)}
            title={title}
            style={{
              height: 20,
              width: 24,
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: layoutMode === mode ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
              background: layoutMode === mode ? 'var(--color-bg-active)' : 'transparent',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <Icon size={13} />
          </button>
        ))}
      </div>

      {/* Refresh button */}
      <button
        className="btn btn-sm btn-ghost"
        onClick={onRefresh}
        disabled={isRefreshing}
        title="Refresh all sessions"
        style={{ height: 20, width: 24, padding: 0 }}
      >
        <RefreshCw size={12} style={isRefreshing ? { animation: 'spin 1s linear infinite' } : undefined} />
      </button>

      {/* Close All button */}
      {runningCount > 0 && (
        <button
          className="btn btn-sm btn-destructive"
          onClick={onCloseAll}
          title="Stop all running terminals"
          style={{
            height: 20,
            padding: '0 8px',
            fontSize: 9,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <XCircle size={12} />
          Close All ({runningCount})
        </button>
      )}
    </div>
  );
}

export default TerminalFilterBar;
