/**
 * Knowledge Helpers
 *
 * Shared functions extracted from KnowledgeGenerator for use by multiple
 * identifier and formatter implementations.
 */

import type { KnowledgePart, KnowledgeType } from './types';

export const MIN_RESULT_LENGTH = 200;

/**
 * Derive a knowledge title from an explore agent's prompt or description.
 * Cleans up the text to be a concise title.
 */
export function deriveTitle(prompt: string, description?: string): string {
  // If description is short and clean, prefer it
  if (description && description.length > 5 && description.length < 120) {
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
 * Split text into knowledge parts on ## or ### headings.
 *
 * Splits on ## headings. Each section becomes a part with:
 * - title from the heading
 * - summary from the first paragraph (up to first blank line)
 * - content from the rest
 *
 * If no ## headings found, tries ### headings.
 * If still none, treats the entire result as a single part.
 */
export function splitIntoParts(result: string): KnowledgePart[] {
  // Build a set of character offsets that are inside fenced code blocks
  const insideCodeFence = buildCodeFenceMap(result);

  // Find headings outside code blocks at ## and ### levels
  const h2Matches = findHeadingsOutsideCode(result, /^## (.+)$/gm, insideCodeFence);
  const h3Matches = findHeadingsOutsideCode(result, /^### (.+)$/gm, insideCodeFence);

  // Choose split level intelligently:
  // - If ### gives 3x more sections than ##, the real content is at ### level
  // - If ## gives 2+ sections and ### doesn't dominate, use ##
  // - Otherwise fall back to whatever has more matches
  let matches: typeof h2Matches;
  if (h3Matches.length >= 3 && h3Matches.length >= h2Matches.length * 2) {
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
    const { summary, content } = extractSummaryAndContent(result);
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
    const title = cleanHeadingTitle(match.title);
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
    const { summary, content } = extractSummaryAndContent(section.body);
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
export function buildCodeFenceMap(text: string): Set<number> {
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
export function findHeadingsOutsideCode(
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
export function extractSummaryAndContent(text: string): { summary: string; content: string } {
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
export function cleanHeadingTitle(title: string): string {
  return title
    .replace(/\*\*/g, '')       // Remove bold markers
    .replace(/`/g, '')          // Remove backticks
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // Convert links to text
    .trim();
}

/**
 * Check if an explore result is junk (failed agent, placeholder text, etc.)
 */
export function isJunkResult(result: string): boolean {
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
export function detectType(title: string, parts: KnowledgePart[]): KnowledgeType {
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
