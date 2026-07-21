// Mirrors the core backlog registry shapes (the web cannot import core).
export const BACKLOG_TYPES = ['idea', 'feature', 'issue', 'bug', 'task'] as const;
export type BacklogType = (typeof BACKLOG_TYPES)[number];
export const BACKLOG_STATUSES = ['open', 'discussing', 'accepted', 'deferred', 'rejected', 'planned', 'implemented'] as const;
export type BacklogStatus = (typeof BACKLOG_STATUSES)[number];
export const BACKLOG_PRIORITIES = ['low', 'med', 'high', 'critical'] as const;
export type BacklogPriority = (typeof BACKLOG_PRIORITIES)[number];
export const BACKLOG_EDGE_KINDS = ['depends-on', 'blocks', 'relates-to', 'parent-of', 'duplicate-of', 'spawned-mission'] as const;
export type BacklogEdgeKind = (typeof BACKLOG_EDGE_KINDS)[number];

export interface BacklogGraphNode {
  id: string;
  title: string;
  type: BacklogType;
  status: BacklogStatus;
  priority: BacklogPriority;
  tags: string[];
  removed: boolean;
  counts: { discussion: number; reviews: number };
  updatedAt: number;
}
export interface BacklogGraphEdge { from: string; to: string; kind: BacklogEdgeKind }

export interface BacklogActor { kind: string; channel: string; id?: string | null; label?: string; at?: number }
export interface BacklogChange { rev: number; at: number; actor: BacklogActor; changes: Record<string, { from: unknown; to: unknown }>; state?: Record<string, unknown> }
export interface BacklogDiscussionEntry { sessionId: string; sessionKind: string; note: string; at: number; label?: string }
export interface BacklogReview { by: string; verdict: 'approve' | 'reject' | 'concerns'; note?: string; at: number }

export interface BacklogItemFull {
  id: string;
  title: string;
  description: string;
  type: BacklogType;
  status: BacklogStatus;
  priority: BacklogPriority;
  tags: string[];
  edges: { to: string; kind: BacklogEdgeKind }[];
  discussion: BacklogDiscussionEntry[];
  reviews: BacklogReview[];
  removed: boolean;
  version: number;
  rev: number;
  createdBy?: BacklogActor;
  lastUpdatedBy?: BacklogActor;
  createdAt: number;
  updatedAt: number;
  history?: BacklogChange[];
}

/** Card accent by item TYPE. */
export const TYPE_COLOR: Record<string, string> = {
  idea: '#eab308', feature: '#3b82f6', issue: '#f97316', bug: '#ef4444', task: '#8b5cf6',
};
/** Status pill colors. */
export const STATUS_COLOR: Record<string, string> = {
  open: '#9ca3af', discussing: '#fbbf24', accepted: '#34d399', deferred: '#6b7280',
  rejected: '#ef4444', planned: '#60a5fa', implemented: '#10b981',
};
/** Typed-edge stroke colors (legend mirrors this map). */
export const EDGE_COLOR: Record<string, string> = {
  'depends-on': '#f59e0b', blocks: '#ef4444', 'relates-to': '#64748b',
  'parent-of': '#3b82f6', 'duplicate-of': '#a855f7', 'spawned-mission': '#10b981',
};
export const PRIORITY_LABEL: Record<string, string> = { low: 'P3', med: 'P2', high: 'P1', critical: 'P0' };
