/**
 * Knowledge LLM Reviewer
 *
 * Singleton class that runs LLM quality review on knowledge entries.
 * Adds concurrency guard, cost tracking, and review history.
 *
 * Pattern follows KnowledgeReviewer (reviewer.ts) and KnowledgeGenerator (generator.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import { getKnowledgeStore } from './store';
import { getKnowledgeSettings } from './settings';
import { getDataDir } from '../utils/path-utils';

const DEFAULT_API_BASE_URL = `http://localhost:${__dirname.includes('node_modules') ? 3100 : 3200}`;
const MAX_HISTORY = 100;

// ── Types ──────────────────────────────────────────

export interface ReviewHistoryEntry {
  id: string;                    // "R001", "R002", ...
  startedAt: string;
  completedAt: string;
  model: string;
  trigger: 'manual' | 'auto';
  entriesSubmitted: number;
  entriesReviewed: number;
  ratings: { good: number; borderline: number; bad: number };
  cost: { totalCostUsd: number; inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs: number;
  error?: string;
}

export interface LlmReviewStatus {
  status: 'idle' | 'processing';
  trigger?: 'manual' | 'auto';
  model?: string;
  entriesTotal: number;
  entriesReviewed: number;
  ratings: { good: number; borderline: number; bad: number };
  startedAt?: string;
  lastCompletedAt?: string;
}

export interface LlmReviewOptions {
  model?: 'haiku' | 'sonnet' | 'opus';
  limit?: number;
  project?: string;
  forceReview?: boolean;
  trigger?: 'manual' | 'auto';
}

// ── History Persistence ──────────────────────────────────────────

function getHistoryPath(): string {
  return path.join(getDataDir(), 'knowledge', 'review-history.json');
}

function readHistory(): ReviewHistoryEntry[] {
  try {
    const p = getHistoryPath();
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return [];
  }
}

function writeHistory(entries: ReviewHistoryEntry[]): void {
  const dir = path.dirname(getHistoryPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getHistoryPath(), JSON.stringify(entries.slice(0, MAX_HISTORY), null, 2));
}

function nextHistoryId(entries: ReviewHistoryEntry[]): string {
  if (entries.length === 0) return 'R001';
  const maxNum = Math.max(...entries.map(e => {
    const m = e.id.match(/^R(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  }));
  return `R${String(maxNum + 1).padStart(3, '0')}`;
}

// ── LLM Review Prompt ──────────────────────────────────────────

const SYSTEM_PROMPT = `You are a knowledge quality reviewer. You evaluate whether knowledge documents extracted from coding sessions contain genuinely useful, standalone, reusable knowledge.

Rate each entry as:
- GOOD: Standalone reference material. Someone reading this 6 months later with no context would learn something useful about how a system works.
- BORDERLINE: Contains some useful info but mixed with task-specific context, or too shallow to be genuinely useful standalone.
- BAD: Not standalone knowledge. Task report, file listing without explanation, exploration log, debugging notes, or content that only makes sense in original conversation context.

Key criteria:
- Does it explain HOW something works, not just WHERE files are?
- Is there actual analysis/insight, or just a file/component inventory?
- Would this be useful reference material for a new developer?
- "Explore X" titles that just list file locations without explaining behavior = BAD
- Architecture analysis with data flows and component interactions = GOOD

Output ONLY valid JSON, no markdown.`;

// ── Class ──────────────────────────────────────────

export class KnowledgeLlmReviewer {
  private processing = false;
  private apiBaseUrl: string;
  private currentTrigger?: 'manual' | 'auto';
  private currentModel?: string;
  private currentStartedAt?: string;
  private lastCompletedAt?: string;

  constructor(apiBaseUrl?: string) {
    this.apiBaseUrl = apiBaseUrl || DEFAULT_API_BASE_URL;
  }

  getStatus(): LlmReviewStatus {
    const store = getKnowledgeStore();
    const all = store.getAllKnowledge(undefined, undefined, 'active', 'local');
    const reviewed = all.filter(k => k.reviewedAt);
    const ratings = { good: 0, borderline: 0, bad: 0 };
    for (const k of reviewed) {
      if (k.reviewRating && ratings.hasOwnProperty(k.reviewRating)) {
        ratings[k.reviewRating as keyof typeof ratings]++;
      }
    }

    return {
      status: this.processing ? 'processing' : 'idle',
      trigger: this.processing ? this.currentTrigger : undefined,
      model: this.processing ? this.currentModel : undefined,
      entriesTotal: all.length,
      entriesReviewed: reviewed.length,
      ratings,
      startedAt: this.processing ? this.currentStartedAt : undefined,
      lastCompletedAt: this.lastCompletedAt,
    };
  }

  getHistory(limit?: number): ReviewHistoryEntry[] {
    const all = readHistory();
    // Already stored newest-first
    return limit ? all.slice(0, limit) : all;
  }

  async review(options: LlmReviewOptions = {}): Promise<LlmReviewStatus> {
    if (this.processing) {
      return this.getStatus();
    }

    const settings = getKnowledgeSettings();
    const {
      model = settings.reviewModel || 'opus',
      limit = 50,
      project,
      forceReview = false,
      trigger = 'manual',
    } = options;

    const store = getKnowledgeStore();
    const all = store.getAllKnowledge(project, undefined, 'active', 'local');

    const toReview = forceReview
      ? all.slice(0, limit)
      : all.filter(k => !k.reviewedAt).slice(0, limit);

    if (toReview.length === 0) {
      return this.getStatus();
    }

    // Set processing state
    this.processing = true;
    this.currentTrigger = trigger;
    this.currentModel = model;
    this.currentStartedAt = new Date().toISOString();

    const startTime = Date.now();
    let historyEntry: ReviewHistoryEntry | null = null;

    try {
      // Build previews
      const previews = toReview.map(k => {
        const content = k.parts.map(p => {
          return (p.title ? `### ${p.title}\n` : '') + p.summary + (p.content ? '\n' + p.content : '');
        }).join('\n\n').slice(0, 1500);
        return { id: k.id, title: k.title, type: k.type, partsCount: k.parts.length, content };
      });

      // Build prompt
      const promptLines = [
        'Review each knowledge entry below. Rate GOOD, BORDERLINE, or BAD.',
        '',
        'Respond with JSON array: [{"id": "K001", "rating": "GOOD|BORDERLINE|BAD", "reason": "one sentence"}]',
        '',
      ];

      for (const p of previews) {
        promptLines.push(`## ${p.id}: ${p.title} (type=${p.type}, parts=${p.partsCount})`);
        promptLines.push(p.content);
        promptLines.push('');
      }
      promptLines.push('Respond with JSON array only:');

      const prompt = promptLines.join('\n');

      // Call agent API
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
        signal: AbortSignal.timeout(600_000),
      });

      if (!response.ok) {
        throw new Error(`Agent API error: ${response.status}`);
      }

      const data = await response.json() as any;
      const result = data.data || data;
      if (!result.success) {
        throw new Error(`Agent execution failed: ${result.error}`);
      }

      // Parse LLM response
      const text = result.result || '';
      const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
      const parsed = JSON.parse(cleaned);
      const arr = Array.isArray(parsed) ? parsed : [parsed];

      // Apply ratings
      const now = new Date().toISOString();
      const counts = { good: 0, borderline: 0, bad: 0 };

      for (const entry of arr) {
        if (!entry.id || !entry.rating) continue;
        const rating = entry.rating.toLowerCase() as 'good' | 'borderline' | 'bad';
        if (!['good', 'borderline', 'bad'].includes(rating)) continue;

        counts[rating]++;
        store.updateKnowledge(entry.id, {
          reviewedAt: now,
          reviewRating: rating,
          reviewReason: String(entry.reason || ''),
          reviewModel: model,
        });
      }

      // Extract cost from agent response
      const cost = {
        totalCostUsd: result.totalCostUsd || 0,
        inputTokens: result.usage?.inputTokens || 0,
        outputTokens: result.usage?.outputTokens || 0,
        totalTokens: (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0),
      };

      const durationMs = Date.now() - startTime;
      this.lastCompletedAt = new Date().toISOString();

      // Build history entry
      const history = readHistory();
      historyEntry = {
        id: nextHistoryId(history),
        startedAt: this.currentStartedAt!,
        completedAt: this.lastCompletedAt,
        model,
        trigger,
        entriesSubmitted: toReview.length,
        entriesReviewed: arr.length,
        ratings: counts,
        cost,
        durationMs,
      };
      history.unshift(historyEntry);
      writeHistory(history);

      return this.getStatus();
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      this.lastCompletedAt = new Date().toISOString();

      // Write error history entry
      const history = readHistory();
      historyEntry = {
        id: nextHistoryId(history),
        startedAt: this.currentStartedAt!,
        completedAt: this.lastCompletedAt,
        model,
        trigger,
        entriesSubmitted: toReview.length,
        entriesReviewed: 0,
        ratings: { good: 0, borderline: 0, bad: 0 },
        cost: { totalCostUsd: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        durationMs,
        error: err.message,
      };
      history.unshift(historyEntry);
      writeHistory(history);

      throw err;
    } finally {
      this.processing = false;
      this.currentTrigger = undefined;
      this.currentModel = undefined;
      this.currentStartedAt = undefined;
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────

let instance: KnowledgeLlmReviewer | null = null;
export function getKnowledgeLlmReviewer(): KnowledgeLlmReviewer {
  if (!instance) instance = new KnowledgeLlmReviewer();
  return instance;
}
