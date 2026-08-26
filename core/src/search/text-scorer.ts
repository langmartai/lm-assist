/**
 * Text Search Scoring
 *
 * Extracted from session-search.routes.ts for reuse by other search modules.
 */

import { type SessionCacheData, isRealUserPrompt } from '../session-cache';
import { tokenizeFts } from '../data/backends/fts-query';

/**
 * General-purpose query tokenizer. **Shared with `api/memory-api.ts`** — do NOT change
 * its semantics to suit session search.
 *
 * It deliberately keeps `-`, `_` and `.` INSIDE tokens, so "lm-assist" stays one term.
 * Routing it through the FTS tokenizer instead split that into "lm" + "assist", and
 * memory scoring substring-matches, so a bare "lm" began matching realm/helm/film —
 * re-introducing, in memory search, the exact over-matching this change removed from
 * session search.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s-_.]/g, ' ').split(/\s+/).filter(t => t.length > 1);
}

/**
 * Query tokens for the SESSION fallback scan specifically: the FTS tokenizer, so the
 * fallback and the ranked path agree on what a term is (stopwords dropped, bounded).
 *
 * Note the match-all fix does not depend on this — `containsWord` (whole-word) plus the
 * majority-of-terms floor in scoreSession are what stop `and` matching inside
 * `command`/`understand`/`expands`. Dropping stopwords is precision on top.
 */
export function tokenizeSessionQuery(text: string): string[] {
  return tokenizeFts(text);
}

/** Whole-word test — `and` must not match inside `command`. */
export function containsWord(haystackLower: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${esc}(?:[^\\p{L}\\p{N}_]|$)`, 'u').test(haystackLower);
}

export function scoreSession(
  cacheData: SessionCacheData,
  queryTokens: string[],
  queryLower: string
): { score: number; matchedPrompts: string[] } {
  let score = 0;
  const matchedPrompts: string[] = [];
  // Which distinct query terms this session matched anywhere. Scoring on DISTINCT terms
  // rather than on occurrence count is what stops a 14k-turn transcript outranking a
  // 400-turn one purely by repeating a common word — the second half of the same defect.
  const termsSeen = new Set<string>();

  // Helper: score text against query tokens with weight
  const scoreText = (text: string | undefined, weight: number): void => {
    if (!text) return;
    const lower = text.toLowerCase();

    // Full query substring match (strong signal)
    if (lower.includes(queryLower)) {
      score += 10 * weight;
    }

    // Token-level matching, whole words only
    for (const token of queryTokens) {
      if (containsWord(lower, token)) {
        score += weight;
        termsSeen.add(token);
      }
    }
  };

  // User prompts (weight 3.0) — only score real user prompts, skip system-injected
  for (const prompt of cacheData.userPrompts) {
    if (!isRealUserPrompt(prompt)) continue;
    const promptText = prompt.text;
    scoreText(promptText, 3.0);
    // Track matched prompts for display
    const lower = promptText.toLowerCase();
    if (queryTokens.some(t => containsWord(lower, t))) {
      matchedPrompts.push(promptText.length > 150 ? promptText.slice(0, 150) + '...' : promptText);
    }
  }

  // Result (weight 2.0)
  scoreText(cacheData.result, 2.0);

  // File paths from Write/Edit tool uses (weight 1.0)
  for (const tu of cacheData.toolUses) {
    if ((tu.name === 'Write' || tu.name === 'Edit') && tu.input?.file_path) {
      scoreText(tu.input.file_path, 1.0);
    }
  }

  // Subagent prompts and results (weight 1.5)
  for (const sub of cacheData.subagents) {
    scoreText(sub.prompt, 1.5);
    scoreText(sub.result, 1.5);
  }

  // Require a MAJORITY of the query's terms before calling it a hit. A single shared
  // word is not a match; without this floor the fallback is once again a corpus dump.
  if (queryTokens.length > 1) {
    const needed = Math.ceil(queryTokens.length / 2);
    if (termsSeen.size < needed) return { score: 0, matchedPrompts: [] };
  }
  // Damp by transcript size so volume cannot substitute for relevance.
  const lengthPenalty = 1 + Math.log10(1 + Math.max(cacheData.userPrompts.length, 1));
  return { score: score / lengthPenalty, matchedPrompts: matchedPrompts.slice(0, 5) };
}

export function getProjectPathForSession(cacheData: SessionCacheData, filePath: string): string {
  // Prefer cwd from session init (accurate, no encoding issues)
  if (cacheData.cwd) return cacheData.cwd;
  // Fallback: extract project key from file path (lossy for paths with hyphens)
  const match = filePath.match(/\/projects\/([^/]+)\//);
  if (!match) return '';
  return '/' + match[1].replace(/^-/, '').replace(/-/g, '/');
}
