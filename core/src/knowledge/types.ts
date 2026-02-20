/**
 * Knowledge Management Types
 *
 * Knowledge captures IMPLEMENTATION TRUTH — algorithms, design contracts,
 * data schemas, integration wiring, invariants, and multi-stage flows
 * that milestones and architecture don't capture.
 */

export interface Knowledge {
  id: string;                    // K001
  title: string;
  type: KnowledgeType;
  project: string;
  status: 'active' | 'outdated' | 'archived';
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp
  parts: KnowledgePart[];
  sourceSessionId?: string;      // Parent session ID (for generated knowledge)
  sourceAgentId?: string;        // Explore agent ID (for generated knowledge)
  sourceTimestamp?: string;      // When the source agent completed (ISO timestamp)
  origin?: 'local' | 'remote';  // Source origin (default: 'local')
  machineId?: string;            // Source machine ID (for remote knowledge)
  machineHostname?: string;      // Source hostname (for remote knowledge)
  machineOS?: string;            // Source OS platform (for remote knowledge)
}

export interface KnowledgePart {
  partId: string;                // K001.1
  title: string;
  summary: string;               // One-liner (first paragraph after heading)
  content: string;               // Full MD content (everything after summary)
}

export type KnowledgeType = 'algorithm' | 'contract' | 'schema' | 'wiring' | 'invariant' | 'flow';

export const KNOWLEDGE_TYPES: KnowledgeType[] = ['algorithm', 'contract', 'schema', 'wiring', 'invariant', 'flow'];

export interface KnowledgeComment {
  id: string;                    // C001, C002, ...
  knowledgeId: string;
  partId?: string;               // Optional, targets specific part
  type: KnowledgeCommentType;
  content: string;
  source: 'llm' | 'user' | 'reviewer';
  state: 'not_addressed' | 'addressed';
  createdAt: string;             // ISO timestamp
  addressedAt?: string;          // ISO timestamp
  addressedBy?: string;          // 'reviewer' or user identifier
}

export type KnowledgeCommentType = 'remove' | 'update' | 'outdated' | 'expand' | 'general';

export const COMMENT_TYPES: KnowledgeCommentType[] = ['remove', 'update', 'outdated', 'expand', 'general'];

export interface KnowledgeIndex {
  knowledges: Record<string, {  // key: "K001" (local) or "machineId:K001" (remote)
    title: string;
    type: KnowledgeType;
    project: string;
    status: string;
    partCount: number;
    unaddressedComments: number;
    updatedAt: string;
    sourceSessionId?: string;
    sourceAgentId?: string;
    sourceTimestamp?: string;
    origin?: 'local' | 'remote';
    machineId?: string;
    machineHostname?: string;
    machineOS?: string;
  }>;
  nextId: number;
  lastUpdated: number;
}

export interface KnowledgeCommentFile {
  comments: KnowledgeComment[];
  nextCommentId: number;
}
