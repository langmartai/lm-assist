/**
 * Knowledge Reviewer
 *
 * Batch-processes unaddressed comments on knowledge documents using an LLM.
 * Pattern: follows MilestoneSummarizer — singleton, debounced queue, LLM API calls.
 *
 * Process:
 * 1. Collect all knowledge documents with unaddressed comments
 * 2. For each document: build prompt with knowledge MD + comments
 * 3. Call /agent/execute with reviewer system prompt
 * 4. Parse response: updated MD + addressed comments
 * 5. Save updated knowledge, mark comments addressed, re-index vectors
 */

import { getKnowledgeStore } from './store';
import { renderKnowledgeMd } from './parser';
import { REVIEWER_SYSTEM_PROMPT } from './prompts';

const DEFAULT_API_BASE_URL = 'http://localhost:3100';
const DEFAULT_TIMEOUT = 180_000;

export interface ReviewStatus {
  status: 'idle' | 'processing';
  documentsToReview: number;
  documentsReviewed: number;
  commentsAddressed: number;
  errors: number;
  lastReviewedAt: string | null;
}

export class KnowledgeReviewer {
  private processing = false;
  private apiBaseUrl: string;
  private timeout: number;
  private lastStatus: ReviewStatus = {
    status: 'idle',
    documentsToReview: 0,
    documentsReviewed: 0,
    commentsAddressed: 0,
    errors: 0,
    lastReviewedAt: null,
  };

  constructor(apiBaseUrl?: string, timeout?: number) {
    this.apiBaseUrl = apiBaseUrl || DEFAULT_API_BASE_URL;
    this.timeout = timeout || DEFAULT_TIMEOUT;
  }

  getStatus(): ReviewStatus {
    return { ...this.lastStatus };
  }

  /**
   * Review all knowledge documents that have unaddressed comments.
   * Returns a summary of what was processed.
   */
  async review(): Promise<ReviewStatus> {
    if (this.processing) {
      return { ...this.lastStatus, status: 'processing' };
    }

    this.processing = true;
    const store = getKnowledgeStore();

    const idsWithComments = store.getKnowledgeWithUnaddressedComments();

    this.lastStatus = {
      status: 'processing',
      documentsToReview: idsWithComments.length,
      documentsReviewed: 0,
      commentsAddressed: 0,
      errors: 0,
      lastReviewedAt: null,
    };

    if (idsWithComments.length === 0) {
      this.lastStatus.status = 'idle';
      this.processing = false;
      return { ...this.lastStatus };
    }

    console.error(`[KnowledgeReviewer] Reviewing ${idsWithComments.length} documents with unaddressed comments`);

    for (const knowledgeId of idsWithComments) {
      try {
        const addressed = await this.reviewDocument(knowledgeId);
        this.lastStatus.documentsReviewed++;
        this.lastStatus.commentsAddressed += addressed;
        this.lastStatus.lastReviewedAt = new Date().toISOString();
      } catch (err: any) {
        this.lastStatus.errors++;
        console.error(`[KnowledgeReviewer] Error reviewing ${knowledgeId}:`, err.message || err);
      }
    }

    this.lastStatus.status = 'idle';
    this.processing = false;
    console.error(`[KnowledgeReviewer] Review complete: ${this.lastStatus.documentsReviewed} reviewed, ${this.lastStatus.commentsAddressed} comments addressed, ${this.lastStatus.errors} errors`);

    return { ...this.lastStatus };
  }

  /**
   * Review a single knowledge document with its unaddressed comments.
   * Returns the number of comments addressed.
   */
  private async reviewDocument(knowledgeId: string): Promise<number> {
    const store = getKnowledgeStore();

    const knowledge = store.getKnowledge(knowledgeId);
    if (!knowledge) return 0;

    const comments = store.getComments(knowledgeId, false); // unaddressed only
    if (comments.length === 0) return 0;

    // Build the prompt
    const knowledgeMd = renderKnowledgeMd(knowledge);
    const commentsJson = JSON.stringify(comments.map(c => ({
      commentId: c.id,
      partId: c.partId,
      type: c.type,
      content: c.content,
      source: c.source,
    })), null, 2);

    const prompt = [
      `Review and update this knowledge document based on the unaddressed comments below.`,
      ``,
      `## Knowledge Document`,
      `\`\`\`markdown`,
      knowledgeMd,
      `\`\`\``,
      ``,
      `## Unaddressed Comments`,
      `\`\`\`json`,
      commentsJson,
      `\`\`\``,
      ``,
      `Respond with JSON:`,
      `{`,
      `  "markdown": "... full updated document including frontmatter ...",`,
      `  "addressedComments": [`,
      `    { "commentId": "C001", "action": "updated", "note": "Updated section K001.2 with new API details" }`,
      `  ]`,
      `}`,
    ].join('\n');

    // Call LLM
    const result = await this.callAgentApi(prompt);
    if (!result) {
      console.error(`[KnowledgeReviewer] No response for ${knowledgeId}`);
      return 0;
    }

    // Parse response
    const parsed = this.parseResponse(result);
    if (!parsed) {
      console.error(`[KnowledgeReviewer] Failed to parse response for ${knowledgeId}`);
      return 0;
    }

    // Apply updated markdown
    let markdownApplied = true;
    if (parsed.markdown) {
      const updated = store.updateKnowledgeFromMd(knowledgeId, parsed.markdown);
      if (updated) {
        // Re-index vectors
        try {
          const { getVectraStore } = require('../vector/vectra-store');
          const { extractKnowledgeVectors } = require('../vector/indexer');
          const vectra = getVectraStore();
          await vectra.deleteKnowledge(knowledgeId);
          const vectors = extractKnowledgeVectors(updated);
          if (vectors.length > 0) {
            await vectra.addVectors(vectors);
          }
        } catch (err) {
          console.error(`[KnowledgeReviewer] Vector re-indexing error for ${knowledgeId}:`, err);
        }
      } else {
        // Markdown update failed — don't mark comments as addressed
        markdownApplied = false;
        console.error(`[KnowledgeReviewer] Markdown update failed for ${knowledgeId}, skipping comment addressing`);
      }
    }

    // Mark comments as addressed (only if markdown was not provided, or was successfully applied)
    let addressed = 0;
    if (markdownApplied && parsed.addressedComments) {
      for (const ac of parsed.addressedComments) {
        if (ac.commentId) {
          const updated = store.updateCommentState(knowledgeId, ac.commentId, 'addressed', 'reviewer');
          if (updated) addressed++;
        }
      }
    }

    return addressed;
  }

  private parseResponse(text: string): {
    markdown?: string;
    addressedComments?: Array<{ commentId: string; action: string; note?: string }>;
  } | null {
    try {
      const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
      const parsed = JSON.parse(cleaned);
      return {
        markdown: parsed.markdown || undefined,
        addressedComments: Array.isArray(parsed.addressedComments) ? parsed.addressedComments : undefined,
      };
    } catch {
      return null;
    }
  }

  private async callAgentApi(prompt: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/agent/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          systemPrompt: REVIEWER_SYSTEM_PROMPT,
          model: 'sonnet',
          maxTurns: 1,
          permissionMode: 'bypassPermissions',
          disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'],
          settingSources: [],
        }),
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        console.error(`[KnowledgeReviewer] Agent API error: ${response.status}`);
        return null;
      }

      const data = await response.json() as any;
      const result = data.data || data;
      if (!result.success) {
        console.error(`[KnowledgeReviewer] Agent execution failed: ${result.error}`);
        return null;
      }

      return result.result || null;
    } catch (error: any) {
      console.error('[KnowledgeReviewer] Agent API call failed:', error.message || error);
      return null;
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let instance: KnowledgeReviewer | null = null;
export function getKnowledgeReviewer(): KnowledgeReviewer {
  if (!instance) instance = new KnowledgeReviewer();
  return instance;
}
