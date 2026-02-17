'use client';

import { useMemo } from 'react';
import { ConsolePanel } from './ConsolePanel';
import type { ConsoleInstance, GroupColor } from './types';
import { useConsoleDashboardStore } from '@/stores/consoleDashboardStore';

// ============================================================================
// Props
// ============================================================================

export interface LayoutEngineProps {
  consoles: ConsoleInstance[];
}

// ============================================================================
// Component
// ============================================================================

export function LayoutEngine({ consoles }: LayoutEngineProps) {
  const {
    layout,
    focusedConsoleId,
    groups,
    groupMode,
    pendingGroupSelections,
    minimizedConsoleIds,
    pinnedConsoleIds,
  } = useConsoleDashboardStore();

  // Separate visible and minimized consoles
  const minimizedSet = useMemo(() => new Set(minimizedConsoleIds), [minimizedConsoleIds]);

  const visibleConsoles = useMemo(() =>
    consoles.filter(c => !minimizedSet.has(c.id)),
    [consoles, minimizedSet]
  );

  const minimizedConsoles = useMemo(() =>
    consoles.filter(c => minimizedSet.has(c.id)),
    [consoles, minimizedSet]
  );

  // Order consoles: pinned first (in their original order), then unpinned sorted by most recent activity
  const pinnedSet = useMemo(() => new Set(pinnedConsoleIds), [pinnedConsoleIds]);

  const orderedConsoles = useMemo(() => {
    const pinned = pinnedConsoleIds
      .map(id => visibleConsoles.find(c => c.id === id))
      .filter((c): c is ConsoleInstance => !!c);
    const unpinned = visibleConsoles
      .filter(c => !pinnedSet.has(c.id))
      .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
    return [...pinned, ...unpinned];
  }, [visibleConsoles, pinnedConsoleIds, pinnedSet]);

  // Helper to get group color for a console
  const getGroupColor = (con: ConsoleInstance): GroupColor | undefined => {
    if (!con.groupId) return undefined;
    const group = groups.find(g => g.id === con.groupId);
    return group?.color as GroupColor | undefined;
  };

  // ── Column layout: show up to `layout` columns side by side ────────

  const columnCount = layout; // 1, 2, 3, or 4
  const displayConsoles = orderedConsoles.slice(0, columnCount);

  if (displayConsoles.length === 0) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-1 min-h-0">
          <EmptyState />
        </div>
        <MinimizedTray consoles={minimizedConsoles} groupMode={groupMode} pendingGroupSelections={pendingGroupSelections} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex flex-1 min-h-0 gap-px p-1.5">
        {displayConsoles.map((con, i) => (
          <div
            key={con.id}
            className="flex-1 min-w-0"
            style={i > 0 ? { borderLeft: '1px solid var(--color-border-subtle)' } : undefined}
          >
            <ConsolePanel
              console={con}
              isFocused={focusedConsoleId === con.id || (displayConsoles.length === 1 && i === 0)}
              isMinimized={false}
              isGroupMode={groupMode}
              isSelectedForGroup={pendingGroupSelections.includes(con.id)}
              groupColor={getGroupColor(con)}
            />
          </div>
        ))}
      </div>
      <MinimizedTray consoles={minimizedConsoles} groupMode={groupMode} pendingGroupSelections={pendingGroupSelections} />
    </div>
  );
}

// ============================================================================
// Minimized Tray
// ============================================================================

function MinimizedTray({
  consoles,
  groupMode,
  pendingGroupSelections,
}: {
  consoles: ConsoleInstance[];
  groupMode: boolean;
  pendingGroupSelections: string[];
}) {
  if (consoles.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 shrink-0 overflow-x-auto"
      style={{ background: 'var(--color-bg-root)', borderTop: '1px solid var(--color-border-subtle)' }}>
      <span className="text-[9px] shrink-0 mr-1" style={{ color: 'var(--color-text-tertiary)', opacity: 0.7 }}>Minimized:</span>
      {consoles.map(con => (
        <ConsolePanel
          key={con.id}
          console={con}
          isFocused={false}
          isMinimized={true}
          isGroupMode={groupMode}
          isSelectedForGroup={pendingGroupSelections.includes(con.id)}
        />
      ))}
    </div>
  );
}

// ============================================================================
// Empty State
// ============================================================================

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <div className="relative">
        <div className="h-16 w-16 rounded-xl flex items-center justify-center"
          style={{ background: 'var(--color-bg-surface)', border: '1px solid var(--color-border-subtle)' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--color-border-default)' }}>
            <path d="M4 17l6-6-6-6M12 19h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
      <div className="text-center">
        <p className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>No consoles open</p>
        <p className="text-[10px] mt-1" style={{ color: 'var(--color-text-tertiary)' }}>Running sessions will appear here automatically</p>
      </div>
    </div>
  );
}
