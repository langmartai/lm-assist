'use client';

import { } from 'react';
import {
  Square, Columns2, Columns3, Columns4,
  Terminal, RefreshCw,
} from 'lucide-react';
import type { LayoutStrategy } from './types';
import { useConsoleDashboardStore } from '@/stores/consoleDashboardStore';

// ============================================================================
// Layout options config
// ============================================================================

const LAYOUT_OPTIONS: Array<{ value: LayoutStrategy; label: string; icon: typeof Square; desc: string }> = [
  { value: 1, label: '1 Col', icon: Square,   desc: 'Full width' },
  { value: 2, label: '2 Col', icon: Columns2, desc: '1/2 + 1/2 split' },
  { value: 3, label: '3 Col', icon: Columns3, desc: '1/3 + 1/3 + 1/3' },
  { value: 4, label: '4 Col', icon: Columns4, desc: '1/4 + 1/4 + 1/4 + 1/4' },
];

// ============================================================================
// Props
// ============================================================================

export interface DashboardToolbarProps {
  openCount: number;
  runningCount: number;
  totalAvailable: number;
  onRefresh: () => void;
  isRefreshing: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function DashboardToolbar({
  openCount,
  runningCount,
  totalAvailable,
  onRefresh,
  isRefreshing,
}: DashboardToolbarProps) {
  const {
    layout,
    setLayout,
  } = useConsoleDashboardStore();

  return (
    <>
      <div className="flex items-center gap-2 px-4 py-2 shrink-0"
        style={{ background: 'var(--color-bg-surface)', borderBottom: '1px solid var(--color-border-default)' }}>
        {/* Left: Title + stats */}
        <div className="flex items-center gap-3 mr-auto min-w-0">
          <div className="flex items-center gap-2 shrink-0">
            <Terminal className="h-4 w-4" style={{ color: 'var(--color-status-green)' }} />
            <h1 className="text-[14px] font-semibold tracking-tight" style={{ color: 'var(--color-text-primary)' }}>
              Terminal Dashboard
            </h1>
          </div>

          {/* Counts */}
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[9px] h-5 px-1.5 inline-flex items-center rounded-full font-mono"
              style={{ border: '1px solid var(--color-border-default)', color: 'var(--color-text-secondary)' }}>
              {openCount} open
            </span>
            {runningCount > 0 && (
              <span className="text-[9px] h-5 px-1.5 inline-flex items-center rounded-full bg-emerald-500/20 text-emerald-300">
                {runningCount} live
              </span>
            )}
            <span className="text-[9px]" style={{ color: 'var(--color-text-tertiary)', opacity: 0.5 }}>/</span>
            <span className="text-[9px]" style={{ color: 'var(--color-text-tertiary)' }}>{totalAvailable} available</span>
          </div>
        </div>

        {/* Center: Layout switcher */}
        <div className="flex items-center gap-1 px-2 py-1 rounded-md shrink-0"
          style={{ background: 'var(--color-bg-hover)', border: '1px solid var(--color-border-subtle)' }}>
          {LAYOUT_OPTIONS.map(opt => {
            const Icon = opt.icon;
            const isActive = layout === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setLayout(opt.value)}
                title={`${opt.label} — ${opt.desc}`}
                className="p-1.5 rounded transition-all duration-150"
                style={{
                  background: isActive ? 'var(--color-accent-glow)' : 'transparent',
                  color: isActive ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
                }}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            );
          })}
        </div>

        {/* Right: Refresh */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button title="Refresh processes"
            className="h-7 w-7 inline-flex items-center justify-center rounded"
            style={{ color: 'var(--color-text-tertiary)' }}
            onClick={onRefresh}>
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

    </>
  );
}
