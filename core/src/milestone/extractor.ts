import { SessionCacheData, CachedToolUse, isRealUserPrompt } from '../session-cache';
import { Milestone } from './types';

// Tools that modify files
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
// Tools that read files
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);

// Short confirmations that shouldn't split milestones
const TRIVIAL_PROMPT_RE = /^(y(es)?|ok(ay)?|sure|go\s*ahead|continue|proceed|do\s*it|confirm(ed)?|correct|right|yep|yup|yeah|approved?|lgtm|looks?\s*good|thanks?|thx|please|np|no\s*problem|k|👍|✅)[\s.!]*$/i;
// Minimum prompt length to be considered substantive (after trimming)
const MIN_SUBSTANTIVE_PROMPT_LENGTH = 15;
// Time gap in ms that indicates a topic switch (5 minutes)
const TIME_GAP_BOUNDARY_MS = 5 * 60 * 1000;

interface Boundary {
  turnIndex: number;
  reason: string;
  strength: number;
}

interface Segment {
  startTurn: number;
  endTurn: number;
  userPrompts: string[];
  userPromptTimestamps: string[];
  filesModified: string[];
  filesRead: string[];
  toolUseSummary: Record<string, number>;
  taskCompletions: string[];
  subagentCount: number;
  hasToolCalls: boolean;
}

/**
 * Re-extract milestones from updated session data, preserving Phase 2 enrichment.
 * Performs a full re-extract then copies LLM fields from existing enriched milestones
 * that match by turn range.
 */
export function reextractMilestones(
  cacheData: SessionCacheData,
  existingMilestones: Milestone[]
): Milestone[] {
  const freshMilestones = extractMilestones(cacheData);

  // Preserve Phase 2 enrichment from existing milestones.
  // Uses overlap-based matching: if a fresh milestone's turn range is fully contained
  // within (or exactly matches) an existing Phase 2 milestone, carry over enrichment.
  // When boundaries shift (e.g. trivial prompts no longer split), multiple old milestones
  // may map to one fresh milestone — pick the one with the most overlapping turns.
  //
  // Claim tracking: each existing Phase 2 milestone can only be claimed by ONE fresh milestone.
  // This prevents merged milestones (wide turn ranges) from being duplicated across multiple
  // fresh milestones. The fresh milestone with the best overlap claims it first.
  const claimedExistingIds = new Set<string>();

  for (const fresh of freshMilestones) {
    let bestMatch: Milestone | null = null;
    let bestOverlap = 0;

    for (const existing of existingMilestones) {
      if (existing.phase !== 2) continue;
      if (existing.modelUsed === 'auto') continue; // Skip former auto-promoted placeholders
      if (claimedExistingIds.has(existing.id)) continue;

      // Calculate turn overlap
      const overlapStart = Math.max(fresh.startTurn, existing.startTurn);
      const overlapEnd = Math.min(fresh.endTurn, existing.endTurn);
      const overlap = Math.max(0, overlapEnd - overlapStart + 1);

      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestMatch = existing;
      }
    }

    // Require the best-matching existing milestone to overlap at least 50% of its own turns
    if (bestMatch && bestOverlap > 0) {
      const existingSpan = bestMatch.endTurn - bestMatch.startTurn + 1;
      if (bestOverlap / existingSpan >= 0.5) {
        fresh.title = bestMatch.title;
        fresh.description = bestMatch.description;
        fresh.type = bestMatch.type;
        fresh.outcome = bestMatch.outcome;
        fresh.facts = bestMatch.facts;
        fresh.concepts = bestMatch.concepts;
        fresh.phase = 2;
        fresh.generatedAt = bestMatch.generatedAt;
        fresh.modelUsed = bestMatch.modelUsed;
        fresh.mergedFrom = null; // Reset mergedFrom on re-extraction
        claimedExistingIds.add(bestMatch.id);
      }
    }
  }

  // Re-index: assign sequential indices
  return freshMilestones.map((m, i) => ({
    ...m,
    index: i,
    id: `${m.sessionId}:${i}`,
  }));
}

/**
 * Phase 1: Extract milestones from a session using heuristic segmentation.
 * All LLM fields (title, description, type, outcome, facts, concepts) are null.
 */
export function extractMilestones(cacheData: SessionCacheData): Milestone[] {
  if (cacheData.numTurns === 0) return [];

  const boundaries = detectBoundaries(cacheData);
  const segments = buildSegments(cacheData, boundaries);
  const merged = mergeSegments(segments);

  return merged.map((seg, index) => buildMilestone(cacheData.sessionId, index, seg, cacheData));
}

function detectBoundaries(cacheData: SessionCacheData): Boundary[] {
  // Accumulate strength per turn — multiple signals at the same turn reinforce each other
  const strengthMap = new Map<number, { reasons: string[]; strength: number }>();

  const addSignal = (turnIndex: number, reason: string, strength: number) => {
    const existing = strengthMap.get(turnIndex);
    if (existing) {
      existing.reasons.push(reason);
      existing.strength += strength;
    } else {
      strengthMap.set(turnIndex, { reasons: [reason], strength });
    }
  };

  // 1. User prompts — only substantive ones create boundaries (skip system-injected)
  for (const prompt of cacheData.userPrompts) {
    if (!isRealUserPrompt(prompt)) continue;
    const text = prompt.text.trim();
    if (isTrivialPrompt(text)) {
      // Trivial prompts get minimal strength — won't form boundaries alone
      addSignal(prompt.turnIndex, 'trivial_prompt', 1);
    } else {
      addSignal(prompt.turnIndex, 'user_prompt', 10);
    }
  }

  // 2. Time gaps between consecutive real user prompts
  const realPrompts = cacheData.userPrompts.filter(isRealUserPrompt);
  for (let i = 1; i < realPrompts.length; i++) {
    const prev = realPrompts[i - 1];
    const curr = realPrompts[i];
    if (prev.timestamp && curr.timestamp) {
      const gap = new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime();
      if (gap >= TIME_GAP_BOUNDARY_MS) {
        addSignal(curr.turnIndex, 'time_gap', 8);
      }
    }
  }

  // 3. Task completions
  for (const task of cacheData.tasks) {
    if (task.status === 'completed') {
      addSignal(task.turnIndex, 'task_completed', 8);
    }
  }

  // 4. Plan approvals
  for (const plan of cacheData.plans) {
    if (plan.status === 'approved') {
      addSignal(plan.turnIndex, 'plan_approved', 7);
    }
  }

  // 5. File context switches
  const fileContextBoundaries = detectFileContextSwitches(cacheData.toolUses);
  for (const b of fileContextBoundaries) {
    addSignal(b.turnIndex, 'file_context_switch', 5);
  }

  // 6. Subagent boundaries
  for (const sub of cacheData.subagents) {
    addSignal(sub.turnIndex, 'subagent', 6);
  }

  // Convert to boundaries — only turns with sufficient strength (>= 5) become boundaries
  const boundaries: Boundary[] = [];
  for (const [turnIndex, { reasons, strength }] of strengthMap) {
    if (strength >= 5) {
      boundaries.push({ turnIndex, reason: reasons.join('+'), strength });
    }
  }

  // Sort by turn index
  boundaries.sort((a, b) => a.turnIndex - b.turnIndex);
  return boundaries;
}

function isTrivialPrompt(text: string): boolean {
  if (text.length < MIN_SUBSTANTIVE_PROMPT_LENGTH && TRIVIAL_PROMPT_RE.test(text)) {
    return true;
  }
  return false;
}

function detectFileContextSwitches(toolUses: CachedToolUse[]): { turnIndex: number; reason: string }[] {
  const boundaries: { turnIndex: number; reason: string }[] = [];

  // Group tool uses by turn
  const turnFiles = new Map<number, Set<string>>();
  for (const tool of toolUses) {
    const filePath = extractFilePath(tool);
    if (!filePath) continue;
    let files = turnFiles.get(tool.turnIndex);
    if (!files) {
      files = new Set();
      turnFiles.set(tool.turnIndex, files);
    }
    files.add(filePath);
  }

  const turns = Array.from(turnFiles.keys()).sort((a, b) => a - b);
  if (turns.length < 4) return boundaries;

  // Sliding window: compare 3 consecutive turns' files with previous 3 turns
  for (let i = 3; i < turns.length; i++) {
    const prevFiles = new Set<string>();
    const currFiles = new Set<string>();

    for (let j = Math.max(0, i - 6); j < i - 3; j++) {
      const files = turnFiles.get(turns[j]);
      if (files) files.forEach(f => prevFiles.add(f));
    }
    for (let j = i - 3; j <= i; j++) {
      const files = turnFiles.get(turns[j]);
      if (files) files.forEach(f => currFiles.add(f));
    }

    if (prevFiles.size === 0 || currFiles.size === 0) continue;

    // Calculate overlap
    const currFilesArr = Array.from(currFiles);
    let overlap = 0;
    for (const f of currFilesArr) {
      if (prevFiles.has(f)) overlap++;
    }
    const overlapRatio = overlap / currFilesArr.length;

    // >70% different files = context switch
    if (overlapRatio < 0.3) {
      boundaries.push({ turnIndex: turns[i - 3], reason: 'file_context_switch' });
    }
  }

  return boundaries;
}

function extractFilePath(tool: CachedToolUse): string | null {
  if (!tool.input) return null;
  // Common path fields across tools
  return tool.input.file_path || tool.input.path || tool.input.notebook_path || null;
}

function buildSegments(cacheData: SessionCacheData, boundaries: Boundary[]): Segment[] {
  if (boundaries.length === 0) {
    // Single segment covering the whole session
    return [buildSegmentForRange(cacheData, 0, cacheData.numTurns - 1)];
  }

  const segments: Segment[] = [];

  // First segment: turn 0 to first boundary
  if (boundaries[0].turnIndex > 0) {
    segments.push(buildSegmentForRange(cacheData, 0, boundaries[0].turnIndex - 1));
  }

  // Segments between boundaries
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].turnIndex;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].turnIndex - 1 : cacheData.numTurns - 1;
    segments.push(buildSegmentForRange(cacheData, start, end));
  }

  return segments;
}

function buildSegmentForRange(cacheData: SessionCacheData, startTurn: number, endTurn: number): Segment {
  const userPrompts: string[] = [];
  const userPromptTimestamps: string[] = [];
  const filesModified = new Set<string>();
  const filesRead = new Set<string>();
  const toolUseSummary: Record<string, number> = {};
  const taskCompletions: string[] = [];
  let subagentCount = 0;
  let hasToolCalls = false;

  // Collect real user prompts in range (skip system-injected messages)
  for (const prompt of cacheData.userPrompts) {
    if (prompt.turnIndex >= startTurn && prompt.turnIndex <= endTurn && isRealUserPrompt(prompt)) {
      userPrompts.push(prompt.text);
      if (prompt.timestamp) userPromptTimestamps.push(prompt.timestamp);
    }
  }

  // Collect tool uses in range
  for (const tool of cacheData.toolUses) {
    if (tool.turnIndex >= startTurn && tool.turnIndex <= endTurn) {
      hasToolCalls = true;
      toolUseSummary[tool.name] = (toolUseSummary[tool.name] || 0) + 1;

      const filePath = extractFilePath(tool);
      if (filePath) {
        if (WRITE_TOOLS.has(tool.name)) {
          filesModified.add(filePath);
        }
        if (READ_TOOLS.has(tool.name)) {
          filesRead.add(filePath);
        }
      }
    }
  }

  // Collect task completions in range
  for (const task of cacheData.tasks) {
    if (task.turnIndex >= startTurn && task.turnIndex <= endTurn && task.status === 'completed') {
      taskCompletions.push(task.subject);
    }
  }

  // Count subagents in range
  for (const sub of cacheData.subagents) {
    if (sub.turnIndex >= startTurn && sub.turnIndex <= endTurn) {
      subagentCount++;
    }
  }

  return {
    startTurn,
    endTurn,
    userPrompts,
    userPromptTimestamps,
    filesModified: Array.from(filesModified),
    filesRead: Array.from(filesRead),
    toolUseSummary,
    taskCompletions,
    subagentCount,
    hasToolCalls,
  };
}

function mergeSegments(segments: Segment[]): Segment[] {
  if (segments.length === 0) return [];

  const result: Segment[] = [];

  for (const seg of segments) {
    const turnSpan = seg.endTurn - seg.startTurn + 1;

    // Skip segments with no tool calls and no user prompts
    if (!seg.hasToolCalls && seg.userPrompts.length === 0) {
      continue;
    }

    if (result.length > 0) {
      const prev = result[result.length - 1];

      // Never merge across a large time gap
      if (hasTimeGap(prev, seg)) {
        result.push(seg);
        continue;
      }

      // Segments < 2 turns → merge with previous
      if (turnSpan < 2) {
        mergeInto(prev, seg);
        continue;
      }

      // >50% file overlap with previous → merge
      if (hasHighFileOverlap(prev, seg)) {
        mergeInto(prev, seg);
        continue;
      }
    }

    result.push(seg);
  }

  // If everything got filtered, create one segment from the first valid one
  if (result.length === 0 && segments.length > 0) {
    result.push(segments[0]);
  }

  return result;
}

function hasTimeGap(prev: Segment, curr: Segment): boolean {
  if (prev.userPromptTimestamps.length === 0 || curr.userPromptTimestamps.length === 0) {
    return false;
  }
  const prevLast = prev.userPromptTimestamps[prev.userPromptTimestamps.length - 1];
  const currFirst = curr.userPromptTimestamps[0];
  const gap = new Date(currFirst).getTime() - new Date(prevLast).getTime();
  return gap >= TIME_GAP_BOUNDARY_MS;
}

function hasHighFileOverlap(prev: Segment, curr: Segment): boolean {
  const prevFiles = new Set([...prev.filesModified, ...prev.filesRead]);
  const currFiles = [...curr.filesModified, ...curr.filesRead];

  if (currFiles.length === 0 || prevFiles.size === 0) return false;

  let overlap = 0;
  for (const f of currFiles) {
    if (prevFiles.has(f)) overlap++;
  }

  return overlap / currFiles.length > 0.5;
}

function mergeInto(target: Segment, source: Segment): void {
  target.endTurn = Math.max(target.endTurn, source.endTurn);
  target.userPrompts.push(...source.userPrompts);
  target.userPromptTimestamps.push(...source.userPromptTimestamps);

  // Merge files (deduplicate)
  const modSet = new Set(target.filesModified);
  for (const f of source.filesModified) modSet.add(f);
  target.filesModified = Array.from(modSet);

  const readSet = new Set(target.filesRead);
  for (const f of source.filesRead) readSet.add(f);
  target.filesRead = Array.from(readSet);

  // Merge tool summary
  for (const [name, count] of Object.entries(source.toolUseSummary)) {
    target.toolUseSummary[name] = (target.toolUseSummary[name] || 0) + count;
  }

  target.taskCompletions.push(...source.taskCompletions);
  target.subagentCount += source.subagentCount;
  target.hasToolCalls = target.hasToolCalls || source.hasToolCalls;
}

function buildMilestone(
  sessionId: string,
  index: number,
  seg: Segment,
  cacheData: SessionCacheData
): Milestone {
  // Determine timestamps: prefer user prompt timestamps, then interpolate from
  // nearest known prompts (handles compacted sessions), then session-level timestamps.
  let startTimestamp = seg.userPromptTimestamps[0];
  let endTimestamp = seg.userPromptTimestamps[seg.userPromptTimestamps.length - 1];

  if (!startTimestamp || !endTimestamp) {
    // Interpolate from nearest user prompts outside this segment's turn range
    const allPrompts = cacheData.userPrompts;
    if (allPrompts && allPrompts.length > 0) {
      let closestBefore: string | undefined;
      let closestAfter: string | undefined;
      for (const p of allPrompts) {
        if (p.timestamp) {
          if (p.turnIndex <= seg.startTurn) closestBefore = p.timestamp;
          if (p.turnIndex >= seg.endTurn && !closestAfter) closestAfter = p.timestamp;
        }
      }
      if (!startTimestamp) startTimestamp = closestBefore || closestAfter || '';
      if (!endTimestamp) endTimestamp = closestAfter || closestBefore || '';
    }
  }

  // Final fallbacks: session-level timestamps, then extraction time
  startTimestamp = startTimestamp || cacheData.firstTimestamp || new Date().toISOString();
  endTimestamp = endTimestamp || cacheData.lastTimestamp || new Date().toISOString();

  const status = 'complete' as const;

  return {
    id: `${sessionId}:${index}`,
    sessionId,
    index,
    startTurn: seg.startTurn,
    endTurn: seg.endTurn,
    startTimestamp,
    endTimestamp,
    userPrompts: seg.userPrompts,
    filesModified: seg.filesModified,
    filesRead: seg.filesRead,
    toolUseSummary: seg.toolUseSummary,
    taskCompletions: seg.taskCompletions,
    subagentCount: seg.subagentCount,
    // Phase 1: LLM fields are null
    title: null,
    description: null,
    type: null,
    outcome: null,
    facts: null,
    concepts: null,
    architectureRelevant: null,
    phase: 1,
    status,
    generatedAt: null,
    modelUsed: null,
    mergedFrom: null,
  };
}
