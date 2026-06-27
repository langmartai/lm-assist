// Mirrors the sub-project-2 backend shapes (the web cannot import core).
export interface MissionNode { id: string; title: string; status: string; tags: Record<string, string[]>; parentId: string | null; progressPercent?: number; }
export interface MissionEdge { from: string; to: string; type: 'parent' | 'dependsOn'; }
export interface MissionFilter { field: string; op: string; value: unknown; flags?: string; }
export interface MissionViewDisplay { groupBy?: string; highlight?: MissionFilter[]; layout?: 'tree' | 'dag'; nodeFields?: string[]; }
export interface MissionView {
  id: string; name: string;
  query: { filter?: MissionFilter[]; expand?: { direction?: string; depth?: number } };
  display: MissionViewDisplay;
  createdAt: number; updatedAt: number;
}
export interface MissionChange { rev: number; at: number; actor: { kind: string; channel: string; label?: string; id?: string | null }; changes: Record<string, { from: unknown; to: unknown }>; }
export interface MissionFull {
  id: string; title: string; status: string;
  objective?: string; plan?: string; nextSteps?: string[];
  tags?: Record<string, string[]>; parentId?: string | null; dependsOn?: string[];
  progress?: { percent?: number; summary?: string } | null;
  history?: MissionChange[];
}
