export type CallFn = <T = unknown>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

/** GET /memory/projects item */
export interface MemoryProjectSummary {
  projectId: string; projectPath: string;
  hasLive: boolean; hasRepo: boolean;
  hostCount: number; fileCount: number; maxMtimeMs: number;
}

/** GET /memory/map (level=brief) item; complete adds source/complete/contentHash */
export interface MapRecord {
  recordId: string; node: string; project: string; file: string;
  /** 'memory' = a memory-dir .md file; 'claude-section' = a CLAUDE.md heading (no memory-dir file); 'index-entry' = a MEMORY.md bullet */
  kind?: string;
  title: string; brief: string; type: string; category: string; validity: string;
  referencedProjects: string[]; recordedAtMs: number;
  source?: string; complete?: string; contentHash?: string;
}

/** GET /rules/list item */
export interface RuleListEntry {
  filename: string; source: string; size: number; mtimeMs: number;
  os: string[]; active: boolean; syncedFrom: string | null;
  editable: boolean; title: string | null;
}

/** GET /memory/by-project/:id/sync/import-candidates item */
export interface ImportCandidate {
  source: string; filename: string; body: string; bodyPreview?: string;
  mtimeMs: number; sizeBytes: number; shareability?: string; reason?: string;
  localMtimeMs?: number; localSizeBytes?: number; relevanceScore?: number;
}

/** Editor target passed between browse and edit states */
export interface EditTarget {
  kind: 'memory' | 'rule';
  projectId?: string;          // memory only
  filename: string;            // '' → create flow
  content: string;
  hash?: string;               // expectedHash for saves; undefined → create
}
