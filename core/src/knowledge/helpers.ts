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

// ─── Knowledge Candidate Scoring ──────────────────────────────────────

export interface CandidateSignal {
  rule: string;
  delta: number;
  match?: string;
}

export interface KnowledgeCandidateScore {
  score: number;
  classification: 'auto-accept' | 'candidate' | 'low-confidence' | 'reject';
  hardRule: 'hard-accept' | 'hard-reject' | null;
  reason: string;
  signals: CandidateSignal[];
}

const NARRATION_OPENER_RE = /^(?:Now (?:let me|I(?:'ll| need to| will| also| add)|also )|Let me (?:read|check|verify|search|review|look|also|do|now)|I(?:'ll| need to| see| will) (?:update|add|check|search|find|now))/i;
const BOILERPLATE_RE = /^(?:Done\.|Cloned successfully|Website created|Archive complete|Repository created|Created the|Good, branch created|All working\.)/i;
const INCOMPLETE_RE = /(?:Let me (?:check|verify|also|now)|Actually wait|Actually,\s+looking at|I need to (?:also|check|verify))/gi;
const DELIVERABLE_RE = /^(?:I've (?:completed|finished|created|set up|updated)|The (?:website|project|repository|implementation) (?:is|has been)|Here(?:'s| is) (?:the|what|a summary of what))/i;
const SELF_CORRECTION_RE = /^Actually (?:wait|no|I (?:realize|see|notice))/im;
const CANCEL_RE = /\b(?:never mind|scratch that|ignore (?:that|this))\b/i;
const ANALYSIS_PATTERNS = [
  /\bkey findings?\b/i,
  /\broot cause\b/i,
  /\bissues?\s+(?:found|identified|discovered)\b/i,
  /\bbugs?\s+(?:found|identified|discovered)\b/i,
  /\banalysis\b/i,
  /\bcomparison\b/i,
  /\binvestigation\b/i,
  /\bsummary of (?:changes|findings|implementation)\b/i,
  /\bimplementation (?:summary|details|overview)\b/i,
  /\barchitectur(?:e|al)\s+(?:overview|analysis|review)\b/i,
];

/**
 * Score an assistant message for knowledge candidacy.
 *
 * Applies hard rules first (instant accept/reject), then soft scoring
 * from structural, semantic, and negative signals.
 *
 * Score range: -11 to +12
 * Thresholds: >= 8 auto-accept, 5-7 candidate, 1-4 low-confidence, <= 0 reject
 * Only significant, standalone content should pass — reject tool narration,
 * task delivery, debugging-in-progress, and short messages.
 */
export function scoreKnowledgeCandidate(text: string): KnowledgeCandidateScore {
  const trimmed = text.trim();
  const len = trimmed.length;

  // ─── HARD REJECT RULES ───────────────────────────────────────

  // HR1: Minimum length — messages under 500 chars are almost never knowledge
  if (len < 500) {
    return {
      score: -10, classification: 'reject', hardRule: 'hard-reject',
      reason: `Too short (${len} chars, minimum 500)`,
      signals: [{ rule: 'HR1-min-length', delta: -10 }],
    };
  }

  // HR2: Execution narration opener (hard reject only if < 800 chars)
  if (NARRATION_OPENER_RE.test(trimmed) && len < 800) {
    return {
      score: -10, classification: 'reject', hardRule: 'hard-reject',
      reason: 'Execution narration opener under 800 chars',
      signals: [{ rule: 'HR2-narration-opener', delta: -10 }],
    };
  }

  // HR3: Few lines with little content
  const nonEmptyLines = trimmed.split('\n').filter(l => l.trim().length > 0);
  if (nonEmptyLines.length <= 3 && len < 600) {
    return {
      score: -10, classification: 'reject', hardRule: 'hard-reject',
      reason: `Too few lines (${nonEmptyLines.length} lines, ${len} chars)`,
      signals: [{ rule: 'HR3-few-lines', delta: -10 }],
    };
  }

  // HR4: Completion boilerplate
  if (BOILERPLATE_RE.test(trimmed)) {
    return {
      score: -10, classification: 'reject', hardRule: 'hard-reject',
      reason: 'Completion boilerplate',
      signals: [{ rule: 'HR4-boilerplate', delta: -10 }],
    };
  }

  // ─── HARD ACCEPT RULE ────────────────────────────────────────

  // HA1: Long structured document
  if (len >= 2000 && !isDirectoryListing(trimmed)) {
    const markers = countStructuralMarkers(trimmed);
    if (markers >= 2) {
      return {
        score: 12, classification: 'auto-accept', hardRule: 'hard-accept',
        reason: `Long structured document (${len} chars, ${markers} structural markers)`,
        signals: [{ rule: 'HA1-long-structured', delta: 12 }],
      };
    }
  }

  // ─── SOFT SCORING ────────────────────────────────────────────

  const signals: CandidateSignal[] = [];
  let score = 0;

  // SP1: Structural formatting (+1 to +4)
  const codeFence = buildCodeFenceMap(trimmed);
  const headings = findHeadingsOutsideCode(trimmed, /^#{2,3}\s+.+$/gm, codeFence);
  if (headings.length > 0) {
    const bonus = Math.min(headings.length * 2, 4);
    score += bonus;
    signals.push({ rule: 'SP1-headings', delta: bonus });
  }
  if (/^\|.+\|.+\|/m.test(trimmed)) {
    score += 2;
    signals.push({ rule: 'SP1-table', delta: 2 });
  }
  // Match both **Label**: and **Label:** (colon inside or outside bold)
  const boldLabels = (trimmed.match(/^\*\*[^*]+(?:\*\*:|:\*\*)/gm) || []).length;
  if (boldLabels > 0) {
    const bonus = Math.min(boldLabels, 3);
    score += bonus;
    signals.push({ rule: 'SP1-bold-labels', delta: bonus });
  }
  if (/(?:^|\n)\s*1\.\s.*\n\s*2\.\s.*\n\s*3\.\s/m.test(trimmed)) {
    score += 2;
    signals.push({ rule: 'SP1-numbered-list', delta: 2 });
  }
  const bulletCount = (trimmed.match(/^[-*]\s+\S/gm) || []).length;
  if (bulletCount >= 3) {
    score += 1;
    signals.push({ rule: 'SP1-bullets', delta: 1 });
  }

  // SP2: Code reference density (+1 to +3)
  const fileRefs = new Set(
    (trimmed.match(/`[\w./-]+\.\w{1,5}`/g) || []).map(m => m.replace(/`/g, '')),
  );
  if (fileRefs.size > 0) {
    const bonus = Math.min(fileRefs.size, 3);
    score += bonus;
    signals.push({ rule: 'SP2-file-refs', delta: bonus, match: `${fileRefs.size} files` });
  }
  if (/`[^`]+\.\w{1,5}:\d+`/.test(trimmed)) {
    score += 1;
    signals.push({ rule: 'SP2-line-refs', delta: 1 });
  }

  // SP3: Analysis/findings language (+1 to +2)
  let analysisMatches = 0;
  for (const p of ANALYSIS_PATTERNS) {
    if (p.test(trimmed)) analysisMatches++;
  }
  if (analysisMatches > 0) {
    const bonus = Math.min(analysisMatches, 2);
    score += bonus;
    signals.push({ rule: 'SP3-analysis-lang', delta: bonus, match: `${analysisMatches} patterns` });
  }

  // SP4: Length bonus (+1 to +4)
  if (len >= 2500) {
    score += 4;
    signals.push({ rule: 'SP4-length', delta: 4, match: `${len} chars` });
  } else if (len >= 1500) {
    score += 3;
    signals.push({ rule: 'SP4-length', delta: 3, match: `${len} chars` });
  } else if (len >= 1000) {
    score += 2;
    signals.push({ rule: 'SP4-length', delta: 2, match: `${len} chars` });
  } else if (len >= 700) {
    score += 1;
    signals.push({ rule: 'SP4-length', delta: 1, match: `${len} chars` });
  }

  // SN1: Incomplete analysis signal (-1 to -3, position-aware)
  const incompleteMatches = trimmed.match(INCOMPLETE_RE) || [];
  if (incompleteMatches.length > 0) {
    let penalty = 0;
    for (const m of incompleteMatches) {
      const pos = trimmed.indexOf(m);
      penalty -= (pos / len) > 0.8 ? 1 : 2;
    }
    penalty = Math.max(penalty, -3);
    score += penalty;
    signals.push({ rule: 'SN1-incomplete', delta: penalty, match: incompleteMatches[0] });
  }

  // SN2: Deliverable/task completion (-2)
  if (DELIVERABLE_RE.test(trimmed)) {
    score -= 2;
    signals.push({ rule: 'SN2-deliverable', delta: -2 });
  }

  // SN3: Directory listing (-3)
  if (isDirectoryListing(trimmed)) {
    score -= 3;
    signals.push({ rule: 'SN3-dir-listing', delta: -3 });
  }

  // SN4: Conversational / question (-1)
  const firstLine = nonEmptyLines[0] || '';
  if (firstLine.trim().endsWith('?') && len < 600) {
    score -= 1;
    signals.push({ rule: 'SN4-conversational', delta: -1 });
  }

  // SN5: Self-correction / reversal (-2)
  if (SELF_CORRECTION_RE.test(trimmed) || CANCEL_RE.test(trimmed)) {
    score -= 2;
    signals.push({ rule: 'SN5-self-correction', delta: -2 });
  }

  // HR2 soft variant: narration opener on longer messages (-3)
  if (NARRATION_OPENER_RE.test(trimmed) && len >= 500) {
    score -= 3;
    signals.push({ rule: 'HR2-narration-soft', delta: -3 });
  }

  // ─── CLASSIFY ────────────────────────────────────────────────

  let classification: KnowledgeCandidateScore['classification'];
  if (score >= 8) classification = 'auto-accept';
  else if (score >= 5) classification = 'candidate';
  else if (score >= 1) classification = 'low-confidence';
  else classification = 'reject';

  return {
    score,
    classification,
    hardRule: null,
    reason: `Score ${score}: ${signals.map(s => `${s.rule}(${s.delta > 0 ? '+' : ''}${s.delta})`).join(', ')}`,
    signals,
  };
}

/**
 * Count distinct structural markers in text (headings, tables, bold labels, numbered lists).
 */
function countStructuralMarkers(text: string): number {
  let count = 0;
  const codeFence = buildCodeFenceMap(text);
  if (findHeadingsOutsideCode(text, /^##\s+.+$/gm, codeFence).length > 0) count++;
  if (/^\|.+\|.+\|/m.test(text)) count++;
  if (/^\*\*[^*]+(?:\*\*:|:\*\*)/m.test(text)) count++;
  if (/(?:^|\n)\s*1\.\s.*\n\s*2\.\s.*\n\s*3\.\s/m.test(text)) count++;
  return count;
}

/**
 * Check if text is primarily a directory/file listing (tree output, file manifests).
 */
function isDirectoryListing(text: string): boolean {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 5) return false;
  const treeLines = lines.filter(l =>
    /^\s*[─│├└┌┐┘┤┬┴┼\-|]/.test(l) ||
    /^\s*[\w.-]+\/\s*$/.test(l) ||
    /^\s{2,}[\w.-]+\.\w{1,5}\s*$/.test(l),
  );
  return treeLines.length / lines.length > 0.4;
}
