export interface Milestone {
  id: string;                   // ${sessionId}:${index}
  sessionId: string;
  index: number;
  startTurn: number;
  endTurn: number;
  startTimestamp: string;       // ISO timestamp
  endTimestamp: string;         // ISO timestamp
  userPrompts: string[];
  filesModified: string[];
  filesRead: string[];
  toolUseSummary: Record<string, number>;
  taskCompletions: string[];
  subagentCount: number;
  title: string | null;
  description: string | null;
  type: MilestoneType | null;
  outcome: string | null;
  facts: string[] | null;
  concepts: string[] | null;
  architectureRelevant: boolean | null;  // Phase 2: LLM classifies if milestone affects architecture
  phase: 1 | 2;
  status: 'complete' | 'in_progress';
  generatedAt: number | null;
  modelUsed: string | null;
  mergedFrom: string[] | null;  // IDs of milestones merged into this one during Phase 2
}

export type MilestoneType = 'discovery' | 'implementation' | 'bugfix' | 'refactor' | 'decision' | 'configuration';

export interface MilestoneIndex {
  sessions: Record<string, {
    phase: 1 | 2;
    milestoneCount: number;
    phase1Count?: number;
    phase2Count?: number;
    lastTurnCount?: number;
    lastUpdated: number;
    sessionTimestamp?: number;  // latest milestone endTimestamp (epoch ms) — for scan range filtering
  }>;
  lastUpdated: number;
}
