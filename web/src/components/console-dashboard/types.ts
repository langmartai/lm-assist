// ============================================================================
// Console Dashboard Types
// ============================================================================

export type LayoutStrategy = 1 | 2 | 3 | 4;

export interface ConsoleInstance {
  id: string;              // unique panel id (usually sessionId)
  sessionId: string;
  projectPath: string;
  title: string;
  ttydUrl: string | null;
  isRunning: boolean;
  isTmux: boolean;         // external tmux vs ttyd-managed
  tmuxSessionName?: string; // tmux session name for direct attach
  pid?: number;            // process PID for tmux pane resolution
  lastActivity: string;
  model?: string;
  costUsd?: number;
  taskCount?: number;
  groupId?: string | null;
}

export interface ConsoleGroup {
  id: string;
  name: string;
  color: string;         // tailwind color class accent
  consoleIds: string[];
  collapsed: boolean;
  createdAt: string;
}

export interface PinnedPosition {
  consoleId: string;
  index: number;
  pinnedAt: number;       // timestamp ms
}

export interface SmartSuggestion {
  suggestedLayout: LayoutStrategy;
  suggestedGroups: Array<{
    name: string;
    consoleIds: string[];
  }>;
  reason: string;
}

// Colors for groups
export const GROUP_COLORS = [
  'emerald',
  'blue',
  'amber',
  'violet',
  'rose',
  'cyan',
  'orange',
  'fuchsia',
] as const;

export type GroupColor = typeof GROUP_COLORS[number];

// Map group colors to CSS classes
export const GROUP_COLOR_MAP: Record<GroupColor, { border: string; bg: string; text: string; badge: string }> = {
  emerald: { border: 'border-emerald-500/40', bg: 'bg-emerald-500/8', text: 'text-emerald-400', badge: 'bg-emerald-500/20 text-emerald-300' },
  blue:    { border: 'border-blue-500/40',    bg: 'bg-blue-500/8',    text: 'text-blue-400',    badge: 'bg-blue-500/20 text-blue-300' },
  amber:   { border: 'border-amber-500/40',   bg: 'bg-amber-500/8',   text: 'text-amber-400',   badge: 'bg-amber-500/20 text-amber-300' },
  violet:  { border: 'border-violet-500/40',  bg: 'bg-violet-500/8',  text: 'text-violet-400',  badge: 'bg-violet-500/20 text-violet-300' },
  rose:    { border: 'border-rose-500/40',    bg: 'bg-rose-500/8',    text: 'text-rose-400',    badge: 'bg-rose-500/20 text-rose-300' },
  cyan:    { border: 'border-cyan-500/40',    bg: 'bg-cyan-500/8',    text: 'text-cyan-400',    badge: 'bg-cyan-500/20 text-cyan-300' },
  orange:  { border: 'border-orange-500/40',  bg: 'bg-orange-500/8',  text: 'text-orange-400',  badge: 'bg-orange-500/20 text-orange-300' },
  fuchsia: { border: 'border-fuchsia-500/40', bg: 'bg-fuchsia-500/8', text: 'text-fuchsia-400', badge: 'bg-fuchsia-500/20 text-fuchsia-300' },
};
