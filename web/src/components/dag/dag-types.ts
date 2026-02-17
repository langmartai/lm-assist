// DAG Types — mirrors backend types from tier-agent-core/src/session-dag.ts
// Portable: no langmart-assistant or external dependencies

export interface DagNode {
  id: string;
  type: string;
  label: string;
  metadata: Record<string, unknown>;
}

export interface DagEdge {
  from: string;
  to: string;
  type: string;
}

export interface DagGraph {
  nodes: DagNode[];
  edges: DagEdge[];
  rootId: string | null;
  stats: {
    nodeCount: number;
    edgeCount: number;
    maxDepth: number;
    branchCount: number;
  };
}

export interface BranchInfo {
  slug?: string;
  rootUuid: string;
  messageCount: number;
}

export interface RelatedSessions {
  session: { sessionId: string; type: string };
  parent: { sessionId: string; type: string } | null;
  children: Array<{ sessionId: string; type: string; agentId?: string }>;
  siblings: Array<{ sessionId: string; type: string; agentId?: string }>;
  team: { name: string; members: Array<{ sessionId?: string; name: string }> } | null;
  forkedFrom?: { sessionId: string } | null;
  forkChildren?: Array<{ sessionId: string; userPromptCount: number }>;
}

export interface UnifiedDag {
  sessions: { nodes: DagNode[]; edges: DagEdge[] };
  tasks: { nodes: DagNode[]; edges: DagEdge[] };
  crossLinks: Array<{ sessionId: string; taskListId: string; taskCount: number }>;
}

export type DagViewMode = 'session' | 'message' | 'unified';

// Layout types

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  node: DagNode;
}

export interface LayoutEdge {
  from: { x: number; y: number };
  to: { x: number; y: number };
  fromId: string;
  toId: string;
  type: string;
}

export interface DagLayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
  nodeW: number;
  nodeH: number;
}

export interface DagLayoutOptions {
  nodeW?: number;
  nodeH?: number;
  layerGap?: number;
  nodeGap?: number;
  direction?: 'LR' | 'TB';
}
