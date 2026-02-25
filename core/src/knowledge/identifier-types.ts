/**
 * Knowledge V2 — Pluggable Identification & Formatting Types
 *
 * Defines the three-layer system:
 * 1. Identifiers — discover/resolve candidate content, produce IdentificationResult
 * 2. Formatters — transform identified content into Knowledge documents
 * 3. Storage — unchanged Knowledge store + vector indexing
 */

import type { KnowledgePart, KnowledgeType } from './types';

// ─── Identifier Types ──────────────────────────────────────────────────

export type IdentifierType = 'explore-agent' | 'generic-content';

/**
 * The identification result — bare minimum source metadata.
 * Stored at discovery time (candidate stage), before any knowledge is generated.
 */
export interface IdentificationResult {
  id: string;                     // Auto-increment: "I001", "I002", ...
  sessionId: string;              // Source session
  lineIndex: number;              // Line in JSONL file
  turnIndex: number;              // Turn number in session
  projectPath: string;            // Project path
  timestamp: string;              // Original source timestamp (when content was created)
  identifiedAt: string;           // When this was identified (discovery time)
  identifierType: IdentifierType; // 'explore-agent' | 'generic-content'

  // Type-specific fields (optional, only present for relevant types)
  agentId?: string;               // For explore-agent: the subagent ID

  // Lifecycle tracking
  knowledgeId?: string;           // Set after knowledge is generated from this identification
  status: 'candidate' | 'generated' | 'skipped'; // Lifecycle state
}

/**
 * The file structure for identifications.json
 */
export interface IdentificationsFile {
  identifications: IdentificationResult[];
  nextId: number;                 // Auto-increment counter
  lastUpdated: string;            // ISO timestamp
}

// ─── Identifier Interface ──────────────────────────────────────────────────

/**
 * A KnowledgeIdentifier discovers or resolves candidate content.
 * Each identifier type handles a specific source (explore agents, generic messages, etc.)
 */
export interface KnowledgeIdentifier {
  readonly type: IdentifierType;

  /**
   * Discover candidates from sessions for a project.
   * Returns identification results for newly discovered candidates.
   * Should skip already-identified content.
   */
  discover(project: string): Promise<IdentificationResult[]>;

  /**
   * Resolve a specific piece of content by session + line index.
   * Returns an identification result if the content is valid.
   */
  resolve(project: string, sessionId: string, lineIndex: number, extra?: Record<string, any>): Promise<IdentificationResult | null>;
}

// ─── Formatter Interface ──────────────────────────────────────────────────

/**
 * Result of formatting an identification into knowledge.
 */
export interface FormatResult {
  title: string;
  type: KnowledgeType;
  parts: KnowledgePart[];
  sourceTimestamp?: string;
  sourceLineIndex?: number;
  sourceTurnIndex?: number;
}

/**
 * A KnowledgeFormatter transforms identified content into Knowledge documents.
 * Each formatter handles a specific identifier type.
 */
export interface KnowledgeFormatter {
  readonly identifierType: IdentifierType;

  /**
   * Format an identification result into a knowledge document structure.
   * Loads the original content, derives title, splits into parts, detects type.
   */
  format(identification: IdentificationResult): Promise<FormatResult>;
}
