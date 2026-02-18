/**
 * Phase 1 Enricher
 *
 * Derives title, description, type, and facts from raw Phase 1 milestone data
 * WITHOUT calling an LLM. Results are saved to disk and remain at phase=1 so
 * the Phase 2 LLM pipeline can still overwrite with higher-quality output later.
 *
 * Data sources used:
 *   - userPrompts     → title (first meaningful prompt) + type hints
 *   - filesModified   → facts + type hints
 *   - filesRead       → facts
 *   - toolUseSummary  → facts
 *   - taskCompletions → facts (highest value — user-visible task descriptions)
 *   - turn range      → description scope
 */

import * as path from 'path';
import type { Milestone, MilestoneType } from './types';

// ─── Noise filtering (mirrors indexer.ts) ────────────────────────────────────

const NOISY_LINE_RE = /^(p[12]|milestone\s*#?\d*|#\d+[\s–\-]*#?\d*|\d+\s+tools?)$/i;

function isNoisyPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < 15) return true;
  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 0 && lines.every(l => NOISY_LINE_RE.test(l))) return true;
  return false;
}

// ─── Field derivation ─────────────────────────────────────────────────────────

/**
 * Derive a title from the first meaningful user prompt.
 * Falls back to file basenames, then generic label.
 */
function deriveTitle(m: Milestone): string {
  const firstPrompt = m.userPrompts.find(p => !isNoisyPrompt(p));

  if (firstPrompt) {
    // Take first line only (avoid multi-line noise), trim to ~80 chars at word boundary
    const firstLine = firstPrompt.trim().split('\n')[0].trim();
    if (firstLine.length <= 80) return firstLine;
    const truncated = firstLine.slice(0, 80);
    const lastSpace = truncated.lastIndexOf(' ');
    return (lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated) + '…';
  }

  // No meaningful prompt — fall back to file basenames
  if (m.filesModified.length > 0) {
    const files = m.filesModified.slice(0, 3).map(f => path.basename(f));
    return `Modify ${files.join(', ')}`;
  }

  if (m.filesRead.length > 0) {
    const files = m.filesRead.slice(0, 3).map(f => path.basename(f));
    return `Explore ${files.join(', ')}`;
  }

  return 'Work session';
}

/**
 * Derive a content-rich description complementary to the title.
 *
 * Rules:
 *   - NEVER repeat the user prompt (that is the title's content)
 *   - Priority: task completions → files modified → files read → tool highlights → scope
 *   - title = "what was asked"  →  description = "what was done + artifacts + scope"
 */
function deriveDescription(m: Milestone): string {
  const segments: string[] = [];
  const turnCount = m.endTurn - m.startTurn + 1;

  // 1. Task completions — highest signal, complementary to title (user-visible outcomes)
  const meaningfulTasks = m.taskCompletions.filter(t => t.trim().length > 5 && !/^\d+$/.test(t.trim()));
  if (meaningfulTasks.length > 0) {
    const taskText = meaningfulTasks.slice(0, 2).map(t => t.trim().slice(0, 80)).join('; ');
    segments.push(taskText);
  }

  // 2. Files modified — what artifacts were produced
  if (m.filesModified.length > 0) {
    const files = m.filesModified.slice(0, 4).map(f => path.basename(f));
    const extra = m.filesModified.length > 4 ? ` +${m.filesModified.length - 4}` : '';
    segments.push(`Modified: ${files.join(', ')}${extra}`);
  } else if (m.filesRead.length > 0) {
    // 3. Files read (only if nothing modified — exploration sessions)
    const files = m.filesRead.slice(0, 4).map(f => path.basename(f));
    const extra = m.filesRead.length > 4 ? ` +${m.filesRead.length - 4}` : '';
    segments.push(`Read: ${files.join(', ')}${extra}`);
  }

  // 4. Highlight top tools (if ≥3 uses and nothing else to say — adds signal for thin milestones)
  if (segments.length === 0) {
    const topTools = Object.entries(m.toolUseSummary)
      .filter(([, c]) => c >= 3)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([t, c]) => `${t}×${c}`);
    if (topTools.length > 0) segments.push(`Used: ${topTools.join(', ')}`);
  }

  // 5. Scope: turns + subagents (always appended — gives temporal context)
  const scopeParts: string[] = [`${turnCount} turn${turnCount !== 1 ? 's' : ''}`];
  if (m.subagentCount > 0) scopeParts.push(`${m.subagentCount} subagent${m.subagentCount !== 1 ? 's' : ''}`);
  segments.push(scopeParts.join(', '));

  return segments.join('; ') + '.';
}

/**
 * Derive facts from all available raw data.
 * Priority: task completions (highest signal) → files → tools → turn range.
 */
function deriveFacts(m: Milestone): string[] {
  const facts: string[] = [];

  // Task completions are high-value — user-visible outcomes
  for (const task of m.taskCompletions) {
    const t = task.trim();
    if (t.length > 5 && !/^\d+$/.test(t)) {
      facts.push(t);
    }
    if (facts.length >= 4) break; // Cap task facts at 4
  }

  // Files modified
  if (m.filesModified.length > 0) {
    const files = m.filesModified.slice(0, 6).map(f => path.basename(f));
    facts.push(`Modified: ${files.join(', ')}`);
  }

  // Files read (only if substantial — avoids noise from routine reads)
  if (m.filesRead.length > 3) {
    const files = m.filesRead.slice(0, 5).map(f => path.basename(f));
    facts.push(`Read: ${files.join(', ')}`);
  }

  // Top tool usage (≥2 uses to filter incidental use)
  const topTools = Object.entries(m.toolUseSummary)
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([tool, count]) => `${tool}: ${count}×`);
  if (topTools.length > 0) {
    facts.push(`Tools: ${topTools.join(', ')}`);
  }

  // Turn range + message count
  const turnCount = m.endTurn - m.startTurn + 1;
  facts.push(`Turns ${m.startTurn}–${m.endTurn} (${turnCount} turns, ${m.userPrompts.length} user message${m.userPrompts.length !== 1 ? 's' : ''})`);

  return facts.slice(0, 8);
}

/**
 * Heuristically classify milestone type from prompts, files, and task completions.
 */
function deriveType(m: Milestone): MilestoneType {
  // No files modified = probably exploration/discovery
  if (m.filesModified.length === 0 && m.filesRead.length > 0 && m.taskCompletions.length === 0) {
    return 'discovery';
  }

  const allText = [...m.userPrompts, ...m.taskCompletions].join(' ').toLowerCase();

  if (/\b(fix|bug|error|broken|crash|regression|exception|failure|fail)\b/.test(allText)) {
    return 'bugfix';
  }
  if (/\b(refactor|rename|restructure|reorganize|cleanup|clean up|extract|move)\b/.test(allText)) {
    return 'refactor';
  }
  if (/\b(config|setting|install|setup|environment|env|deploy|ci|cd|pipeline|dependency|package)\b/.test(allText)) {
    return 'configuration';
  }
  if (/\b(investigate|explore|understand|learn|research|read|look into|discover|analyze|why|how)\b/.test(allText)) {
    return 'discovery';
  }
  if (/\b(decide|decision|trade.?off|choose|option|approach|strategy|plan|design)\b/.test(allText)) {
    return 'decision';
  }

  return 'implementation';
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface Phase1EnrichmentResult {
  title: string;
  description: string;
  type: MilestoneType;
  facts: string[];
}

/**
 * Derive enrichment fields from a Phase 1 milestone's raw data.
 * Pure function — no I/O, no LLM. Caller is responsible for saving.
 */
export function enrichPhase1(m: Milestone): Phase1EnrichmentResult {
  return {
    title: deriveTitle(m),
    description: deriveDescription(m),
    type: deriveType(m),
    facts: deriveFacts(m),
  };
}

/**
 * Return true if a milestone needs Phase 1 enrichment
 * (Phase 1, no title yet — not yet touched by LLM either).
 */
export function needsPhase1Enrichment(m: Milestone): boolean {
  return m.phase === 1 && (m.title === null || m.title === '');
}
