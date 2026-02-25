/**
 * Knowledge Validator
 *
 * Phase 2 LLM validation for knowledge candidates discovered by the heuristic
 * scoring system (Phase 1). Follows the same pattern as milestone/summarizer.ts:
 *
 * 1. Heuristic prefilter produces candidates with scores
 * 2. Candidates are batched (first N chars of each) and sent to LLM
 * 3. LLM validates: is this standalone, reusable knowledge?
 * 4. Valid candidates proceed to knowledge generation
 *
 * Uses /agent/execute with maxTurns=1, no tools, custom system prompt.
 */

import type { IdentificationResult } from './identifier-types';
import { getIdentificationStore } from './identification-store';
import { getDataDir } from '../utils/path-utils';

// ─── Constants ──────────────────────────────────────────────────

const MAX_INPUT_TOKENS = 100_000;       // Conservative budget for validation
const MAX_PREVIEW_CHARS = 800;          // First N chars of each candidate
const MAX_BATCH_SIZE = 30;              // Max candidates per batch
const DEFAULT_TIMEOUT = 120_000;        // 2 minutes
const TOKENS_PER_CHAR = 0.25;          // ~4 chars per token

const SYSTEM_PROMPT = `You validate whether assistant messages from coding sessions contain reusable knowledge.

Knowledge = standalone, reusable content that would help someone understand a system months later.
NOT knowledge = task coordination, tool narration, status updates, debugging-in-progress, deliverable handoffs.

## What IS knowledge:
- Architecture analysis with specific components and data flows
- Bug findings with root causes, file locations, and fixes
- Implementation summaries with what changed and why
- Comparison tables with specific features and gaps
- Pipeline/flow descriptions with phases and criteria

## What is NOT knowledge:
- "Let me check...", "Now let me read..." — tool coordination
- "Done. Website created." — task completion
- "Everything is working" + verification checklists — status reports
- Mid-investigation analysis with "Actually wait..." — unsettled thinking
- Directory listings, file manifests — raw output
- Compact/compaction summaries from context overflow

Output ONLY valid JSON, no markdown, no explanation.`;

// ─── Types ──────────────────────────────────────────────────

export interface ValidationResult {
  id: string;
  valid: boolean;
  reason: string;
  suggestedTitle?: string;
}

export interface ValidatorStatus {
  status: 'idle' | 'validating';
  queueSize: number;
  processed: number;
  validated: number;
  rejected: number;
  errors: number;
}

// ─── Validator Class ──────────────────────────────────────────────────

export class KnowledgeValidator {
  private apiBaseUrl: string;
  private timeout: number;
  private currentStatus: ValidatorStatus = {
    status: 'idle', queueSize: 0, processed: 0, validated: 0, rejected: 0, errors: 0,
  };

  constructor(apiBaseUrl?: string) {
    const port = process.env.API_PORT || '3200';
    this.apiBaseUrl = apiBaseUrl || `http://localhost:${port}`;
    this.timeout = DEFAULT_TIMEOUT;
  }

  getStatus(): ValidatorStatus {
    return { ...this.currentStatus };
  }

  /**
   * Validate a batch of identification candidates via LLM.
   * Loads the first MAX_PREVIEW_CHARS of each candidate's content,
   * batches them, and asks the LLM to validate.
   *
   * Returns validated results — caller decides what to do with them.
   */
  async validateCandidates(
    candidates: IdentificationResult[],
    project: string,
    model: string = 'haiku',
  ): Promise<ValidationResult[]> {
    if (candidates.length === 0) return [];

    this.currentStatus = {
      status: 'validating',
      queueSize: candidates.length,
      processed: 0, validated: 0, rejected: 0, errors: 0,
    };

    try {
      // Load content previews for each candidate
      const previews = await this.loadPreviews(candidates, project);
      if (previews.length === 0) return [];

      // Batch by token budget
      const batches = this.buildBatches(previews);
      const allResults: ValidationResult[] = [];

      for (const batch of batches) {
        try {
          const prompt = this.buildBatchPrompt(batch);
          const response = await this.callAgentApi(prompt, model);

          if (response) {
            const results = this.parseBatchResponse(response, batch);
            allResults.push(...results);

            for (const r of results) {
              if (r.valid) this.currentStatus.validated++;
              else this.currentStatus.rejected++;
            }
          } else {
            this.currentStatus.errors += batch.length;
          }

          this.currentStatus.processed += batch.length;
        } catch (err) {
          console.error('[KnowledgeValidator] Batch failed:', err);
          this.currentStatus.errors += batch.length;
          this.currentStatus.processed += batch.length;
        }
      }

      return allResults;
    } finally {
      this.currentStatus.status = 'idle';
    }
  }

  /**
   * Discover, validate, and update identifications in one step.
   * Runs discovery → picks up existing unvalidated candidates → LLM validation → marks invalid as 'skipped'.
   */
  async discoverAndValidate(
    project: string,
    model: string = 'haiku',
  ): Promise<{ discovered: number; candidates: number; validated: number; rejected: number; errors: number }> {
    // Run discovery first (finds new candidates)
    const { getKnowledgePipeline } = require('./pipeline');
    const pipeline = getKnowledgePipeline();
    const newlyDiscovered = await pipeline.discover(project, 'generic-content');

    // Also gather existing unvalidated candidates (status='candidate', identifierType='generic-content')
    const idStore = getIdentificationStore();
    const allCandidates = idStore.list({
      identifierType: 'generic-content',
      status: 'candidate',
    });

    if (allCandidates.length === 0) {
      return { discovered: newlyDiscovered.length, candidates: 0, validated: 0, rejected: 0, errors: 0 };
    }

    // Validate all candidates
    const results = await this.validateCandidates(allCandidates, project, model);

    // Update identifications based on validation results
    const now = new Date().toISOString();
    let rejected = 0;
    for (const result of results) {
      if (result.valid) {
        idStore.update(result.id, {
          status: 'validated',
          validatedAt: now,
          validationReason: result.reason,
          suggestedTitle: result.suggestedTitle,
        });
      } else {
        idStore.update(result.id, {
          status: 'skipped',
          validatedAt: now,
          validationReason: result.reason,
        });
        rejected++;
      }
    }

    return {
      discovered: newlyDiscovered.length,
      candidates: allCandidates.length,
      validated: results.filter(r => r.valid).length,
      rejected,
      errors: this.currentStatus.errors,
    };
  }

  // ─── Private Methods ──────────────────────────────────────────────────

  /**
   * Load content previews for candidates from session cache.
   */
  private async loadPreviews(
    candidates: IdentificationResult[],
    project: string,
  ): Promise<Array<{ id: string; score: number; text: string }>> {
    const { getSessionReader } = require('../session-reader');
    const { getSessionCache } = require('../session-cache');

    const reader = getSessionReader();
    const cache = getSessionCache();

    if (cache.isWarming()) {
      await cache.waitForWarming();
    }

    const previews: Array<{ id: string; score: number; text: string }> = [];

    // Group by session for efficient loading
    const bySession = new Map<string, IdentificationResult[]>();
    for (const c of candidates) {
      const arr = bySession.get(c.sessionId) || [];
      arr.push(c);
      bySession.set(c.sessionId, arr);
    }

    for (const [sessionId, items] of bySession) {
      try {
        const filePath = reader.getSessionFilePath(sessionId, project);
        const data = await cache.getSessionData(filePath);
        if (!data?.responses) continue;

        for (const item of items) {
          const response = data.responses.find((r: any) => r.lineIndex === item.lineIndex);
          if (response?.text) {
            previews.push({
              id: item.id,
              score: item.score || 0,
              text: response.text.slice(0, MAX_PREVIEW_CHARS),
            });
          }
        }
      } catch {
        // Skip sessions that fail
      }
    }

    return previews;
  }

  /**
   * Split previews into batches respecting token budget.
   */
  private buildBatches(
    previews: Array<{ id: string; score: number; text: string }>,
  ): Array<Array<{ id: string; score: number; text: string }>> {
    const batches: Array<Array<{ id: string; score: number; text: string }>> = [];
    let currentBatch: typeof previews = [];
    let currentTokens = Math.ceil(SYSTEM_PROMPT.length * TOKENS_PER_CHAR) + 500; // system + overhead

    for (const preview of previews) {
      const itemTokens = Math.ceil(preview.text.length * TOKENS_PER_CHAR) + 100; // + formatting overhead

      if (currentBatch.length >= MAX_BATCH_SIZE ||
          currentTokens + itemTokens > MAX_INPUT_TOKENS) {
        if (currentBatch.length > 0) {
          batches.push(currentBatch);
        }
        currentBatch = [];
        currentTokens = Math.ceil(SYSTEM_PROMPT.length * TOKENS_PER_CHAR) + 500;
      }

      currentBatch.push(preview);
      currentTokens += itemTokens;
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  /**
   * Build the batch validation prompt.
   */
  private buildBatchPrompt(
    batch: Array<{ id: string; score: number; text: string }>,
  ): string {
    const lines: string[] = [
      `Validate each message below. For each, decide: is this standalone, reusable knowledge?`,
      ``,
      `Respond with a JSON array. Each entry must have:`,
      `- "id": the identification ID (from the ## header)`,
      `- "valid": true if this is genuine knowledge, false if not`,
      `- "reason": one sentence explaining why (max 20 words)`,
      `- "suggestedTitle": if valid, a concise title (max 10 words, imperative form)`,
      ``,
    ];

    for (const item of batch) {
      lines.push(`## ${item.id} (score=${item.score})`);
      lines.push(item.text);
      lines.push(``);
    }

    lines.push(`Respond with JSON array only:`);
    lines.push(`[{"id": "${batch[0].id}", "valid": true/false, "reason": "...", "suggestedTitle": "..."}]`);

    return lines.join('\n');
  }

  /**
   * Parse LLM batch response into validation results.
   */
  private parseBatchResponse(
    text: string,
    batch: Array<{ id: string; score: number; text: string }>,
  ): ValidationResult[] {
    try {
      const cleaned = text
        .replace(/^```(?:json)?\n?/m, '')
        .replace(/\n?```$/m, '')
        .trim();
      const parsed = JSON.parse(cleaned);
      const arr = Array.isArray(parsed) ? parsed : [parsed];

      const results: ValidationResult[] = [];
      const respondedIds = new Set<string>();

      for (const entry of arr) {
        if (!entry.id) continue;
        respondedIds.add(entry.id);
        results.push({
          id: entry.id,
          valid: entry.valid === true,
          reason: String(entry.reason || ''),
          suggestedTitle: entry.valid && entry.suggestedTitle ? String(entry.suggestedTitle) : undefined,
        });
      }

      // Any candidates not in the response default to valid (conservative)
      for (const item of batch) {
        if (!respondedIds.has(item.id)) {
          results.push({
            id: item.id,
            valid: true,
            reason: 'Not evaluated by LLM (defaulting to valid)',
          });
        }
      }

      return results;
    } catch (err) {
      console.error('[KnowledgeValidator] Parse error:', err);
      // On parse failure, default all to valid (conservative)
      return batch.map(item => ({
        id: item.id,
        valid: true,
        reason: 'Parse error (defaulting to valid)',
      }));
    }
  }

  /**
   * Call agent execution API — same pattern as milestone/summarizer.ts
   */
  private async callAgentApi(prompt: string, model: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/agent/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          systemPrompt: SYSTEM_PROMPT,
          model,
          maxTurns: 1,
          permissionMode: 'bypassPermissions',
          cwd: getDataDir(),
          env: { CLAUDE_CODE_REMOTE: 'true' },
          disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'],
          settingSources: [],
        }),
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        console.error(`[KnowledgeValidator] Agent API error: ${response.status}`);
        return null;
      }

      const data = await response.json() as any;
      const result = data.data || data;
      if (!result.success) {
        console.error(`[KnowledgeValidator] Agent execution failed: ${result.error}`);
        return null;
      }

      return result.result || null;
    } catch (error: any) {
      console.error('[KnowledgeValidator] Agent API call failed:', error.message || error);
      return null;
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let instance: KnowledgeValidator | null = null;
export function getKnowledgeValidator(): KnowledgeValidator {
  if (!instance) instance = new KnowledgeValidator();
  return instance;
}
