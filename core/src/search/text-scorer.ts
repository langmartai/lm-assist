/**
 * Text Search Scoring
 *
 * Extracted from session-search.routes.ts for reuse by other search modules.
 */

import { type SessionCacheData, isRealUserPrompt } from '../session-cache';

export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s-_.]/g, ' ').split(/\s+/).filter(t => t.length > 1);
}

export function scoreSession(
  cacheData: SessionCacheData,
  queryTokens: string[],
  queryLower: string
): { score: number; matchedPrompts: string[] } {
  let score = 0;
  const matchedPrompts: string[] = [];

  // Helper: score text against query tokens with weight
  const scoreText = (text: string | undefined, weight: number): void => {
    if (!text) return;
    const lower = text.toLowerCase();

    // Full query substring match (strong signal)
    if (lower.includes(queryLower)) {
      score += 10 * weight;
    }

    // Token-level matching
    for (const token of queryTokens) {
      if (lower.includes(token)) {
        score += weight;
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
    if (queryTokens.some(t => lower.includes(t))) {
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

  return { score, matchedPrompts: matchedPrompts.slice(0, 5) };
}

export function getProjectPathForSession(cacheData: SessionCacheData, filePath: string): string {
  // Prefer cwd from session init (accurate, no encoding issues)
  if (cacheData.cwd) return cacheData.cwd;
  // Fallback: extract project key from file path (lossy for paths with hyphens)
  const match = filePath.match(/\/projects\/([^/]+)\//);
  if (!match) return '';
  return '/' + match[1].replace(/^-/, '').replace(/-/g, '/');
}
