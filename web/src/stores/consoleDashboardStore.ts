'use client';

import { create } from 'zustand';
import type {
  LayoutStrategy,
  ConsoleInstance,
  ConsoleGroup,
  PinnedPosition,
  SmartSuggestion,
  GroupColor,
} from '@/components/console-dashboard/types';
import { GROUP_COLORS } from '@/components/console-dashboard/types';

// ============================================================================
// LocalStorage helpers
// ============================================================================

const STORAGE_PREFIX = 'cd-';

function loadStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveStorage<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch { /* quota */ }
}

// ============================================================================
// Constants
// ============================================================================

const POSITION_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
let _groupIdCounter = 0;

// ============================================================================
// Store
// ============================================================================

interface ConsoleDashboardStore {
  // State
  openConsoles: ConsoleInstance[];
  layout: LayoutStrategy;
  focusedConsoleId: string | null;
  groups: ConsoleGroup[];
  groupMode: boolean;
  pendingGroupSelections: string[];
  pinnedPositions: PinnedPosition[];
  lastPositionRefresh: number;
  positionRefreshInterval: number;
  minimizedConsoleIds: string[];
  pinnedConsoleIds: string[];
  smartMode: boolean;
  smartSuggestion: SmartSuggestion | null;

  // Console actions
  openConsole: (console: ConsoleInstance) => void;
  closeConsole: (id: string) => void;
  updateConsole: (id: string, updates: Partial<ConsoleInstance>) => void;
  setConsoles: (consoles: ConsoleInstance[]) => void;

  // Layout actions
  setLayout: (layout: LayoutStrategy) => void;
  setFocusedConsole: (id: string | null) => void;

  // Minimize actions
  minimizeConsole: (id: string) => void;
  restoreConsole: (id: string) => void;

  // Pin actions
  togglePinConsole: (id: string) => void;

  // Group actions
  toggleGroupMode: () => void;
  cancelGroupMode: () => void;
  toggleGroupSelection: (consoleId: string) => void;
  createGroup: (name: string) => void;
  deleteGroup: (groupId: string) => void;
  toggleGroupCollapse: (groupId: string) => void;
  removeFromGroup: (consoleId: string) => void;

  // Position actions
  refreshPositions: () => void;
  shouldRefreshPositions: () => boolean;

  // Smart actions
  toggleSmartMode: () => void;
  setSmartSuggestion: (suggestion: SmartSuggestion | null) => void;
  applySmartSuggestion: () => void;

  // Hydrate from localStorage
  hydrate: () => void;
}

export const useConsoleDashboardStore = create<ConsoleDashboardStore>((set, get) => ({
  // Initial state
  openConsoles: [],
  layout: 1,
  focusedConsoleId: null,
  groups: [],
  groupMode: false,
  pendingGroupSelections: [],
  pinnedPositions: [],
  lastPositionRefresh: Date.now(),
  positionRefreshInterval: POSITION_REFRESH_INTERVAL,
  minimizedConsoleIds: [],
  pinnedConsoleIds: [],
  smartMode: false,
  smartSuggestion: null,

  // ── Console actions ───────────────────────────────────────────────────

  openConsole: (console) => {
    set((state) => {
      const exists = state.openConsoles.find(c => c.id === console.id);
      if (exists) {
        return {
          openConsoles: state.openConsoles.map(c => c.id === console.id ? { ...c, ...console } : c),
        };
      }
      const next = [...state.openConsoles, console];
      const focusId = state.focusedConsoleId;
      return { openConsoles: next, focusedConsoleId: focusId };
    });
  },

  closeConsole: (id) => {
    set((state) => {
      const next = state.openConsoles.filter(c => c.id !== id);
      const minimized = state.minimizedConsoleIds.filter(mid => mid !== id);
      let focusId = state.focusedConsoleId;
      if (focusId === id) {
        focusId = next.length > 0 ? next[0].id : null;
      }
      const pending = state.pendingGroupSelections.filter(pid => pid !== id);
      const groups = state.groups.map(g => ({
        ...g,
        consoleIds: g.consoleIds.filter(cid => cid !== id),
      })).filter(g => g.consoleIds.length > 0);

      saveStorage('groups', groups);
      return {
        openConsoles: next,
        focusedConsoleId: focusId,
        minimizedConsoleIds: minimized,
        pendingGroupSelections: pending,
        groups,
      };
    });
  },

  updateConsole: (id, updates) => {
    set((state) => ({
      openConsoles: state.openConsoles.map(c => c.id === id ? { ...c, ...updates } : c),
    }));
  },

  setConsoles: (consoles) => {
    set((state) => {
      const merged = consoles.map(c => {
        const existing = state.openConsoles.find(e => e.id === c.id);
        if (existing) {
          // Preserve non-null ttydUrl from store — the sync effect may snapshot
          // stale state before updateConsole sets the URL, so {…existing, …c}
          // would overwrite the fresh URL with null.
          return { ...existing, ...c, ttydUrl: c.ttydUrl || existing.ttydUrl || null };
        }
        return c;
      });
      return { openConsoles: merged };
    });
  },

  // ── Layout actions ────────────────────────────────────────────────────

  setLayout: (layout) => {
    set({ layout });
    saveStorage('layout', layout);
  },

  setFocusedConsole: (id) => {
    set({ focusedConsoleId: id });
  },

  // ── Minimize actions ──────────────────────────────────────────────────

  minimizeConsole: (id) => {
    set((state) => ({
      minimizedConsoleIds: [...state.minimizedConsoleIds, id],
    }));
  },

  restoreConsole: (id) => {
    set((state) => ({
      minimizedConsoleIds: state.minimizedConsoleIds.filter(mid => mid !== id),
    }));
  },

  // ── Pin actions ─────────────────────────────────────────────────────

  togglePinConsole: (id) => {
    set((state) => {
      const isPinned = state.pinnedConsoleIds.includes(id);
      const next = isPinned
        ? state.pinnedConsoleIds.filter(pid => pid !== id)
        : [...state.pinnedConsoleIds, id];
      saveStorage('pinnedConsoleIds', next);
      return { pinnedConsoleIds: next };
    });
  },

  // ── Group actions ─────────────────────────────────────────────────────

  toggleGroupMode: () => {
    set((state) => ({
      groupMode: !state.groupMode,
      pendingGroupSelections: state.groupMode ? [] : state.pendingGroupSelections,
    }));
  },

  cancelGroupMode: () => {
    set({ groupMode: false, pendingGroupSelections: [] });
  },

  toggleGroupSelection: (consoleId) => {
    set((state) => {
      const has = state.pendingGroupSelections.includes(consoleId);
      return {
        pendingGroupSelections: has
          ? state.pendingGroupSelections.filter(id => id !== consoleId)
          : [...state.pendingGroupSelections, consoleId],
      };
    });
  },

  createGroup: (name) => {
    const state = get();
    if (state.pendingGroupSelections.length < 2) return;

    const usedColors = new Set(state.groups.map(g => g.color));
    const color = GROUP_COLORS.find(c => !usedColors.has(c)) || GROUP_COLORS[state.groups.length % GROUP_COLORS.length];

    const newGroup: ConsoleGroup = {
      id: `group-${Date.now()}-${_groupIdCounter++}`,
      name,
      color,
      consoleIds: [...state.pendingGroupSelections],
      collapsed: false,
      createdAt: new Date().toISOString(),
    };

    const updatedGroups = state.groups.map(g => ({
      ...g,
      consoleIds: g.consoleIds.filter(id => !state.pendingGroupSelections.includes(id)),
    })).filter(g => g.consoleIds.length > 0);

    const dissolvedGroupIds = new Set(
      state.groups
        .filter(g => !updatedGroups.find(ug => ug.id === g.id))
        .map(g => g.id)
    );

    const updatedConsoles = state.openConsoles.map(c => {
      if (state.pendingGroupSelections.includes(c.id)) return { ...c, groupId: newGroup.id };
      if (c.groupId && dissolvedGroupIds.has(c.groupId)) return { ...c, groupId: null };
      return c;
    });

    set({
      groups: [...updatedGroups, newGroup],
      openConsoles: updatedConsoles,
      groupMode: false,
      pendingGroupSelections: [],
    });
    saveStorage('groups', [...updatedGroups, newGroup]);
  },

  deleteGroup: (groupId) => {
    set((state) => {
      const groups = state.groups.filter(g => g.id !== groupId);
      const consoles = state.openConsoles.map(c =>
        c.groupId === groupId ? { ...c, groupId: null } : c
      );
      saveStorage('groups', groups);
      return { groups, openConsoles: consoles };
    });
  },

  toggleGroupCollapse: (groupId) => {
    set((state) => {
      const groups = state.groups.map(g =>
        g.id === groupId ? { ...g, collapsed: !g.collapsed } : g
      );
      saveStorage('groups', groups);
      return { groups };
    });
  },

  removeFromGroup: (consoleId) => {
    set((state) => {
      const groups = state.groups.map(g => ({
        ...g,
        consoleIds: g.consoleIds.filter(id => id !== consoleId),
      })).filter(g => g.consoleIds.length > 0);
      const consoles = state.openConsoles.map(c =>
        c.id === consoleId ? { ...c, groupId: null } : c
      );
      saveStorage('groups', groups);
      return { groups, openConsoles: consoles };
    });
  },

  // ── Position actions ──────────────────────────────────────────────────

  refreshPositions: () => {
    const state = get();
    const sorted = [...state.openConsoles].sort(
      (a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
    );
    const positions: PinnedPosition[] = sorted.map((c, i) => ({
      consoleId: c.id,
      index: i,
      pinnedAt: Date.now(),
    }));
    set({ pinnedPositions: positions, lastPositionRefresh: Date.now() });
  },

  shouldRefreshPositions: () => {
    const state = get();
    return Date.now() - state.lastPositionRefresh >= state.positionRefreshInterval;
  },

  // ── Smart actions ─────────────────────────────────────────────────────

  toggleSmartMode: () => {
    set((state) => ({ smartMode: !state.smartMode }));
  },

  setSmartSuggestion: (suggestion) => {
    set({ smartSuggestion: suggestion });
  },

  applySmartSuggestion: () => {
    const state = get();
    if (!state.smartSuggestion) return;

    const { suggestedLayout, suggestedGroups } = state.smartSuggestion;

    const updates: Partial<ConsoleDashboardStore> = {
      layout: suggestedLayout,
      smartSuggestion: null,
      smartMode: false,
    };

    if (suggestedGroups.length > 0) {
      const usedColors = new Set<string>();
      const newGroups: ConsoleGroup[] = suggestedGroups.map((sg, i) => {
        const color = GROUP_COLORS.find(c => !usedColors.has(c)) || GROUP_COLORS[i % GROUP_COLORS.length];
        usedColors.add(color);
        return {
          id: `group-smart-${Date.now()}-${i}`,
          name: sg.name,
          color,
          consoleIds: sg.consoleIds,
          collapsed: false,
          createdAt: new Date().toISOString(),
        };
      });
      (updates as any).groups = newGroups;

      const consoleToGroup = new Map<string, string>();
      for (const g of newGroups) {
        for (const cid of g.consoleIds) consoleToGroup.set(cid, g.id);
      }
      (updates as any).openConsoles = state.openConsoles.map(c => ({
        ...c,
        groupId: consoleToGroup.get(c.id) ?? null,
      }));

      saveStorage('groups', newGroups);
    }

    set(updates as any);
    saveStorage('layout', suggestedLayout);
  },

  // ── Hydrate ───────────────────────────────────────────────────────────

  hydrate: () => {
    set({
      layout: loadStorage<LayoutStrategy>('layout', 1),
      groups: loadStorage<ConsoleGroup[]>('groups', []),
      pinnedConsoleIds: loadStorage<string[]>('pinnedConsoleIds', []),
    });
  },
}));
