/**
 * Knowledge Generator
 *
 * Discovers Explore-type subagent sessions and converts their research output
 * into structured knowledge documents via direct extraction (no LLM needed).
 *
 * Two-Phase Process:
 * 1. Use explore agent's prompt as knowledge title/summary
 * 2. Split the agent's last assistant message (result) on ## headings into parts
 *
 * Each ## heading in the result becomes a knowledge part. Content under each
 * heading is preserved as-is with all its original markdown formatting.
 */

import { getKnowledgeStore } from './store';
import type { Knowledge, KnowledgePart, KnowledgeType } from './types';
import { KNOWLEDGE_TYPES } from './types';

const MIN_RESULT_LENGTH = 200;
const MAX_SESSIONS_TO_SCAN = Infinity;

// ─── Types ──────────────────────────────────────────────────

export interface ExploreCandidate {
  sessionId: string;
  agentId: string;
  type: string;
  prompt: string;
  resultPreview: string;
  description?: string;
  timestamp?: string;
}

export interface GenerateStatus {
  status: 'idle' | 'generating';
  currentSessionId?: string;
  currentAgentId?: string;
  processed?: number;
  total?: number;
  errors?: number;
}

// ─── Generator Class ──────────────────────────────────────────────────

export class KnowledgeGenerator {
  private currentStatus: GenerateStatus = { status: 'idle' };
  private stopRequested = false;

  getStatus(): GenerateStatus {
    return { ...this.currentStatus };
  }

  /**
   * Discover explore agent sessions that can be converted to knowledge.
   * Filters out already-generated agents via sourceAgentId dedup.
   */
  async discoverExploreSessions(project: string): Promise<ExploreCandidate[]> {
    const { getSessionReader } = require('../session-reader');
    const { getSessionCache } = require('../session-cache');

    const reader = getSessionReader();
    const cache = getSessionCache();
    const store = getKnowledgeStore();

    // Wait for background warming to finish so all sessions are available
    if (cache.isWarming()) {
      console.error('[KnowledgeGenerator] Waiting for session cache warming to complete...');
      await cache.waitForWarming();
      console.error('[KnowledgeGenerator] Warming complete, proceeding with discovery');
    }

    // Get sessions for this project (already sorted by most recent first)
    const allSessions = reader.listSessions(project);
    if (allSessions.length === 0) return [];

    // Limit scan to most recent sessions for performance
    const sessions = allSessions.slice(0, MAX_SESSIONS_TO_SCAN);

    // Get already-generated agent IDs
    const generatedIds = store.getGeneratedAgentIds();

    const candidates: ExploreCandidate[] = [];

    for (const session of sessions) {
      try {
        const filePath = reader.getSessionFilePath(session.sessionId, project);
        const data = await cache.getSessionData(filePath);
        if (!data?.subagents?.length) continue;

        for (const agent of data.subagents) {
          // Must have a valid agentId
          if (!agent.agentId) continue;

          // Must be Explore type (case-insensitive) and completed
          if (!agent.type || agent.type.toLowerCase() !== 'explore') continue;
          if (agent.status !== 'completed') continue;

          // Must have substantial result that isn't junk
          if (!agent.result || agent.result.length < MIN_RESULT_LENGTH) continue;
          if (this.isJunkResult(agent.result.trim())) continue;

          // Skip if already generated
          if (generatedIds.has(agent.agentId)) continue;

          candidates.push({
            sessionId: session.sessionId,
            agentId: agent.agentId,
            type: agent.type,
            prompt: agent.prompt,
            resultPreview: agent.result.slice(0, 300) + (agent.result.length > 300 ? '...' : ''),
            description: agent.description,
            timestamp: agent.completedAt || agent.startedAt,
          });
        }
      } catch {
        // Skip sessions that fail to load
      }
    }

    // Sort by timestamp descending (most recent first)
    candidates.sort((a, b) => {
      if (!a.timestamp && !b.timestamp) return 0;
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return b.timestamp.localeCompare(a.timestamp);
    });

    return candidates;
  }

  /**
   * Generate a knowledge document by directly extracting from explore agent output.
   *
   * Phase 1: Agent prompt → knowledge title
   * Phase 2: Agent result → split on ## headings into knowledge parts
   *
   * No LLM call needed — instant extraction.
   */
  async generateFromExplore(sessionId: string, agentId: string, project: string): Promise<Knowledge> {
    this.currentStatus = { status: 'generating', currentSessionId: sessionId, currentAgentId: agentId };

    try {
      // Dedup check: reject if this agentId was already generated
      const store = getKnowledgeStore();
      const generatedIds = store.getGeneratedAgentIds();
      if (generatedIds.has(agentId)) {
        const existingId = store.findByAgentId(agentId);
        throw new Error(`Agent ${agentId} already generated as ${existingId || 'unknown'} — skipping duplicate`);
      }

      // Load the subagent data (waits for warming if needed)
      const agentData = await this.loadSubagentData(sessionId, agentId, project);
      if (!agentData) {
        throw new Error(`Explore agent ${agentId} not found in session ${sessionId}`);
      }

      // Quality check: reject empty/failed explore results
      const trimmedResult = agentData.result.trim();
      if (trimmedResult.length < MIN_RESULT_LENGTH || this.isJunkResult(trimmedResult)) {
        throw new Error(`Explore agent ${agentId} has insufficient or junk content — skipping`);
      }

      // Phase 1: Derive title from prompt
      const title = this.deriveTitle(agentData.prompt, agentData.description);

      // Phase 2: Split result into parts
      const rawParts = this.splitIntoParts(agentData.result);
      if (rawParts.length === 0) {
        throw new Error('No sections found in explore agent output (expected ## headings)');
      }

      // Detect knowledge type from content
      const type = this.detectType(title, rawParts);

      // Create knowledge document
      const knowledge = store.createKnowledge({
        title,
        type,
        project,
        parts: rawParts,
        status: 'active',
        sourceSessionId: sessionId,
        sourceAgentId: agentId,
        sourceTimestamp: agentData.completedAt,
      });

      return knowledge;
    } finally {
      this.currentStatus = { status: 'idle' };
    }
  }

  /**
   * Regenerate knowledge by re-extracting from its original explore source.
   */
  async regenerateKnowledge(knowledgeId: string): Promise<Knowledge> {
    const store = getKnowledgeStore();
    const existing = store.getKnowledge(knowledgeId);
    if (!existing) {
      throw new Error(`Knowledge ${knowledgeId} not found`);
    }
    if (!existing.sourceSessionId || !existing.sourceAgentId) {
      throw new Error(`Knowledge ${knowledgeId} has no source tracking (not generated from explore)`);
    }

    this.currentStatus = {
      status: 'generating',
      currentSessionId: existing.sourceSessionId,
      currentAgentId: existing.sourceAgentId,
    };

    try {
      // Re-fetch the explore agent data (waits for warming if needed)
      const agentData = await this.loadSubagentData(
        existing.sourceSessionId,
        existing.sourceAgentId,
        existing.project,
      );
      if (!agentData) {
        throw new Error(`Original explore agent ${existing.sourceAgentId} no longer available`);
      }

      // Phase 1: Derive title
      const title = this.deriveTitle(agentData.prompt, agentData.description);

      // Phase 2: Split result into parts
      const rawParts = this.splitIntoParts(agentData.result);
      if (rawParts.length === 0) {
        throw new Error('No sections found in explore agent output (expected ## headings)');
      }

      // Detect type
      const type = this.detectType(title, rawParts);

      // Re-number parts with existing knowledge ID
      const parts = rawParts.map((p, i) => ({
        ...p,
        partId: `${knowledgeId}.${i + 1}`,
      }));

      const updated = store.updateKnowledge(knowledgeId, {
        title,
        type,
        parts,
        sourceTimestamp: agentData.completedAt,
      });

      if (!updated) {
        throw new Error('Failed to update knowledge document');
      }

      return updated;
    } finally {
      this.currentStatus = { status: 'idle' };
    }
  }

  /**
   * Stop batch generation after current item finishes.
   */
  stop(): void {
    if (this.currentStatus.status === 'generating') {
      this.stopRequested = true;
    }
  }

  /**
   * Generate knowledge from all candidates for a project.
   * Processes sequentially, respects stop requests.
   */
  async generateAll(project: string): Promise<{ generated: number; errors: number; stopped: boolean }> {
    if (this.currentStatus.status === 'generating') {
      throw new Error('Generation already in progress');
    }

    this.stopRequested = false;
    const candidates = await this.discoverExploreSessions(project);
    const total = candidates.length;
    let generated = 0;
    let errors = 0;

    this.currentStatus = { status: 'generating', processed: 0, total, errors: 0 };

    try {
      for (const candidate of candidates) {
        if (this.stopRequested) break;

        try {
          await this.generateFromExplore(candidate.sessionId, candidate.agentId, project);
          generated++;
        } catch (err) {
          errors++;
          console.error(`[KnowledgeGenerator] Failed to generate from ${candidate.agentId}:`, err);
        }

        this.currentStatus = { status: 'generating', processed: generated + errors, total, errors };
      }
    } finally {
      const stopped = this.stopRequested;
      this.stopRequested = false;
      this.currentStatus = { status: 'idle' };
      return { generated, errors, stopped };
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  /**
   * Derive a knowledge title from the explore agent's prompt.
   * Cleans up the prompt to be a concise title.
   */
  private deriveTitle(prompt: string, description?: string): string {
    // If description is short and clean, prefer it
    if (description && description.length > 5 && description.length < 120) {
      // Capitalize first letter, remove trailing period
      let title = description.trim();
      title = title.charAt(0).toUpperCase() + title.slice(1);
      if (title.endsWith('.')) title = title.slice(0, -1);
      return title;
    }

    // Extract title from first line of prompt (before any newline)
    let title = prompt.split('\n')[0].trim();

    // Remove common prefixes like "Research...", "Find...", "Look at...", "I need to..."
    title = title
      .replace(/^(?:I need to |Please |Can you |Help me )/i, '')
      .replace(/^(?:research|investigate|explore|find|look at|understand|analyze|search for)\s+/i, '');

    // Capitalize first letter
    title = title.charAt(0).toUpperCase() + title.slice(1);

    // Truncate if too long
    if (title.length > 120) {
      title = title.slice(0, 117) + '...';
    }

    // Remove trailing period
    if (title.endsWith('.')) title = title.slice(0, -1);

    return title;
  }

  /**
   * Split the explore agent's result into knowledge parts.
   *
   * Splits on ## headings. Each section becomes a part with:
   * - title from the heading
   * - summary from the first paragraph (up to first blank line)
   * - content from the rest
   *
   * If no ## headings found, tries ### headings.
   * If still none, treats the entire result as a single part.
   */
  private splitIntoParts(result: string): KnowledgePart[] {
    // Build a set of character offsets that are inside fenced code blocks
    const insideCodeFence = this.buildCodeFenceMap(result);

    // Find headings outside code blocks at ## and ### levels
    const h2Matches = this.findHeadingsOutsideCode(result, /^## (.+)$/gm, insideCodeFence);
    const h3Matches = this.findHeadingsOutsideCode(result, /^### (.+)$/gm, insideCodeFence);

    // Choose split level intelligently:
    // - If ### gives 3x more sections than ##, the real content is at ### level
    // - If ## gives 2+ sections and ### doesn't dominate, use ##
    // - Otherwise fall back to whatever has more matches
    let matches: typeof h2Matches;
    if (h3Matches.length >= 3 && h3Matches.length >= h2Matches.length * 2) {
      // ### clearly has the real content sections (e.g. ### 1. System Overview, ### 2. ...)
      matches = h3Matches;
    } else if (h2Matches.length >= 2) {
      matches = h2Matches;
    } else if (h3Matches.length >= 2) {
      matches = h3Matches;
    } else if (h2Matches.length === 1) {
      matches = h3Matches.length >= 2 ? h3Matches : h2Matches;
    } else {
      matches = h3Matches.length > 0 ? h3Matches : h2Matches;
    }

    if (matches.length === 0) {
      // No headings — treat entire result as a single part
      const { summary, content } = this.extractSummaryAndContent(result);
      return [{
        partId: 'TEMP.1',
        title: 'Overview',
        summary: summary || result.slice(0, 200).trim(),
        content,
      }];
    }

    // Split on heading positions into raw sections
    const rawSections: Array<{ title: string; body: string }> = [];

    // Content before the first heading
    const preContent = result.slice(0, matches[0].index).trim();
    if (preContent.length > 100) {
      rawSections.push({ title: 'Overview', body: preContent });
    }

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const title = this.cleanHeadingTitle(match.title);
      const startIdx = match.index + match.fullMatch.length;
      const endIdx = i + 1 < matches.length ? matches[i + 1].index : result.length;
      rawSections.push({ title, body: result.slice(startIdx, endIdx).trim() });
    }

    // Merge empty/tiny sections into the next section (they're standalone sub-headings)
    const MIN_SECTION_SIZE = 50;
    const merged: typeof rawSections = [];
    for (let i = 0; i < rawSections.length; i++) {
      const section = rawSections[i];
      if (section.body.length < MIN_SECTION_SIZE && i + 1 < rawSections.length) {
        // Prepend this heading + body to the next section
        const prefix = section.body
          ? `**${section.title}**\n${section.body}\n\n`
          : `**${section.title}**\n\n`;
        rawSections[i + 1].body = prefix + rawSections[i + 1].body;
      } else {
        merged.push(section);
      }
    }

    // Build parts
    const parts: KnowledgePart[] = [];
    for (const section of merged) {
      const { summary, content } = this.extractSummaryAndContent(section.body);
      parts.push({
        partId: `TEMP.${parts.length + 1}`,
        title: section.title,
        summary: summary || section.body.slice(0, 200).trim(),
        content,
      });
    }

    return parts;
  }

  /**
   * Build a Set of line-start offsets that are inside fenced code blocks.
   */
  private buildCodeFenceMap(text: string): Set<number> {
    const insideFence = new Set<number>();
    const lines = text.split('\n');
    let inFence = false;
    let offset = 0;

    for (const line of lines) {
      if (line.trimStart().startsWith('```')) {
        inFence = !inFence;
      } else if (inFence) {
        insideFence.add(offset);
      }
      offset += line.length + 1; // +1 for \n
    }

    return insideFence;
  }

  /**
   * Find regex heading matches that are NOT inside code fences.
   */
  private findHeadingsOutsideCode(
    text: string,
    re: RegExp,
    insideCodeFence: Set<number>,
  ): Array<{ index: number; fullMatch: string; title: string }> {
    const results: Array<{ index: number; fullMatch: string; title: string }> = [];
    for (const match of text.matchAll(re)) {
      if (!insideCodeFence.has(match.index!)) {
        results.push({
          index: match.index!,
          fullMatch: match[0],
          title: match[1],
        });
      }
    }
    return results;
  }

  /**
   * Extract summary (first paragraph) and remaining content from a section.
   */
  private extractSummaryAndContent(text: string): { summary: string; content: string } {
    const lines = text.split('\n');

    // Skip leading empty lines
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();

    if (lines.length === 0) {
      return { summary: '', content: '' };
    }

    // Find first blank line to split summary from content
    let blankIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '') {
        blankIdx = i;
        break;
      }
    }

    if (blankIdx === -1) {
      // No blank line — everything is summary
      return { summary: lines.join('\n').trim(), content: '' };
    }

    const summary = lines.slice(0, blankIdx).join('\n').trim();
    const content = lines.slice(blankIdx + 1).join('\n').trim();
    return { summary, content };
  }

  /**
   * Clean up a heading title — remove markdown formatting artifacts.
   */
  private cleanHeadingTitle(title: string): string {
    return title
      .replace(/\*\*/g, '')       // Remove bold markers
      .replace(/`/g, '')          // Remove backticks
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // Convert links to text
      .trim();
  }

  /**
   * Check if an explore result is junk (failed agent, placeholder text, etc.)
   */
  private isJunkResult(result: string): boolean {
    const junkPatterns = [
      /^async agent launched/i,
      /^agent launched/i,
      /^spawned successfully/i,
      /^task completed/i,
      /^no results/i,
      /^error:/i,
      /^failed to/i,
      /^the user doesn't want to proceed/i,
      /^tool use was rejected/i,
    ];
    const firstLine = result.split('\n')[0].trim();
    return junkPatterns.some(p => p.test(firstLine));
  }

  /**
   * Detect the most appropriate knowledge type based on title and content.
   */
  private detectType(title: string, parts: KnowledgePart[]): KnowledgeType {
    const text = (title + ' ' + parts.map(p => p.title + ' ' + p.summary).join(' ')).toLowerCase();

    const typeSignals: Array<{ type: KnowledgeType; patterns: string[] }> = [
      { type: 'algorithm', patterns: ['algorithm', 'scoring', 'formula', 'heuristic', 'detection', 'threshold', 'weight', 'calculate'] },
      { type: 'contract', patterns: ['contract', 'concurrency', 'lock', 'mutex', 'guarantee', 'invariant', 'serializ', 'atomic'] },
      { type: 'schema', patterns: ['schema', 'interface', 'type definition', 'data model', 'field', 'struct', 'typedef'] },
      { type: 'wiring', patterns: ['wiring', 'integration', 'callback', 'event', 'hook', 'registration', 'pipeline', 'chain', 'architecture'] },
      { type: 'invariant', patterns: ['constant', 'limit', 'budget', 'timeout', 'batch size', 'threshold', 'config', 'parameter'] },
      { type: 'flow', patterns: ['flow', 'pipeline', 'phase', 'stage', 'state machine', 'transition', 'sequence', 'process', 'workflow'] },
    ];

    let bestType: KnowledgeType = 'wiring';
    let bestScore = 0;

    for (const { type, patterns } of typeSignals) {
      let score = 0;
      for (const pattern of patterns) {
        if (text.includes(pattern)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestType = type;
      }
    }

    return bestType;
  }

  /**
   * Load subagent data from session cache.
   * Waits for warming to complete if still running.
   */
  private async loadSubagentData(
    sessionId: string,
    agentId: string,
    project: string,
  ): Promise<{ prompt: string; result: string; description?: string; completedAt?: string } | null> {
    const { getSessionReader } = require('../session-reader');
    const { getSessionCache } = require('../session-cache');

    const reader = getSessionReader();
    const cache = getSessionCache();

    // Wait for warming if still running
    if (cache.isWarming()) {
      console.error('[KnowledgeGenerator] Waiting for session cache warming...');
      await cache.waitForWarming();
    }

    const filePath = reader.getSessionFilePath(sessionId, project);

    const data = await cache.getSessionData(filePath);

    if (data?.subagents?.length) {
      const agent = data.subagents.find((a: any) => a.agentId === agentId);
      if (agent?.result) {
        return { prompt: agent.prompt, result: agent.result, description: agent.description, completedAt: agent.completedAt || agent.startedAt };
      }
    }

    return null;
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let instance: KnowledgeGenerator | null = null;
export function getKnowledgeGenerator(): KnowledgeGenerator {
  if (!instance) instance = new KnowledgeGenerator();
  return instance;
}
