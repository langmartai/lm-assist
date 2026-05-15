/**
 * CC transcript reader — authoritative output source for the tmux runner.
 *
 * Claude Code's interactive TUI persists the SAME structured message
 * stream the Agent SDK consumes to a JSONL file at
 *   ~/.claude/projects/{cwd→key}/{sessionId}.jsonl
 *
 * Reading the last assistant turn from that file gives the EXACT model
 * output — complete, no terminal width-wrapping, no blank-line
 * truncation, no ANSI artifacts — and is directly comparable to the SDK
 * runner's `result` (which is built from the same assistant text blocks).
 * This replaces fragile screen-scraping as the primary extraction path.
 */

import * as fs from 'fs';
import { SessionReader } from '../session-reader';

export interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface TranscriptTurn {
  /** Concatenated user-visible text of the last assistant turn. */
  text: string;
  /** Summed token usage across that turn's assistant records, if present. */
  usage: TranscriptUsage | null;
}

interface JsonlRecord {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

/**
 * A `user` record is a real typed prompt only when its content is a
 * non-empty string. Tool results and synthetic continuations carry array
 * content (`[{type:'tool_result'|'text'...}]`) and must NOT be treated as
 * turn boundaries.
 */
function isUserPrompt(rec: JsonlRecord): boolean {
  if (rec.type !== 'user' || !rec.message) return false;
  return typeof rec.message.content === 'string' && rec.message.content.length > 0;
}

/**
 * Pure extraction: from the transcript's JSONL lines, return the LAST
 * assistant turn's user-visible text — every `text` content block across
 * the trailing assistant records that follow the last real user prompt.
 * `thinking` and `tool_use` blocks are excluded (same semantics the SDK
 * runner uses to assemble its `result` string). Returns '' if there is no
 * assistant text after the last prompt.
 */
export function extractLastTurnFromJsonl(lines: string[]): TranscriptTurn {
  const recs: JsonlRecord[] = [];
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    try { recs.push(JSON.parse(s) as JsonlRecord); } catch { /* skip non-JSON line */ }
  }

  // Index of the last real (string-content) user prompt.
  let lastPrompt = -1;
  for (let i = recs.length - 1; i >= 0; i--) {
    if (isUserPrompt(recs[i])) { lastPrompt = i; break; }
  }

  const parts: string[] = [];
  let inTok = 0, outTok = 0, ccTok = 0, crTok = 0;
  let sawUsage = false;
  for (let i = lastPrompt + 1; i < recs.length; i++) {
    const r = recs[i];
    if (r.type !== 'assistant' || !r.message) continue;
    const content = r.message.content;
    if (Array.isArray(content)) {
      for (const b of content as Array<{ type?: string; text?: string }>) {
        if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
    const u = r.message.usage;
    if (u) {
      sawUsage = true;
      inTok += u.input_tokens ?? 0;
      outTok += u.output_tokens ?? 0;
      ccTok += u.cache_creation_input_tokens ?? 0;
      crTok += u.cache_read_input_tokens ?? 0;
    }
  }

  return {
    text: parts.join('').trim(),
    usage: sawUsage
      ? { inputTokens: inTok, outputTokens: outTok, cacheCreationInputTokens: ccTok, cacheReadInputTokens: crTok }
      : null,
  };
}

/**
 * Pure: count the real (string-content) user prompts in the transcript.
 * This is the freshness yardstick — the number grows by exactly one each
 * time CC records a typed prompt, so a caller that knows the pre-prompt
 * count can tell whether THEIR prompt has been written yet (vs. seeing a
 * stale previous turn).
 */
export function countUserPrompts(lines: string[]): number {
  let n = 0;
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    let rec: JsonlRecord;
    try { rec = JSON.parse(s) as JsonlRecord; } catch { continue; }
    if (isUserPrompt(rec)) n++;
  }
  return n;
}

/**
 * IO helper: how many user prompts the on-disk transcript for `sessionId`
 * (project keyed by `cwd`) currently has. Returns 0 if the file can't be
 * located/read (e.g. cold session — no transcript yet), which makes the
 * freshness gate degrade safely to "require at least one prompt".
 */
export function countUserPromptsInTranscript(sessionId: string, cwd: string): number {
  try {
    const file = new SessionReader().getSessionFilePath(sessionId, cwd);
    return countUserPrompts(fs.readFileSync(file, 'utf-8').split('\n'));
  } catch {
    return 0;
  }
}

/**
 * Locate and read CC's transcript for `sessionId` (project keyed by
 * `cwd`) and return its last assistant turn. Retries briefly to absorb
 * the small lag between the TUI finishing a turn on screen and the JSONL
 * flush hitting disk.
 *
 * FRESHNESS GATE: a turn is only accepted once the transcript holds at
 * least `minUserPrompts` real user prompts AND has assistant text after
 * the last one. The caller passes (pre-prompt prompt count + 1), so a
 * warm session can never return the PREVIOUS turn's answer just because
 * the new turn hasn't flushed yet.
 *
 * Returns null when the transcript can't be located/read, or has no fresh
 * assistant text after the retry budget — the caller should fall back to
 * screen extraction (or blocked-state surfacing) in that case.
 */
export async function readLastAssistantTurn(
  sessionId: string,
  cwd: string,
  opts: { retries?: number; retryDelayMs?: number; minUserPrompts?: number } = {},
): Promise<TranscriptTurn | null> {
  const retries = opts.retries ?? 16;
  const delay = opts.retryDelayMs ?? 250;
  const minUserPrompts = opts.minUserPrompts ?? 1;

  let file: string;
  try {
    file = new SessionReader().getSessionFilePath(sessionId, cwd);
  } catch {
    return null;
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      // Freshness: OUR prompt must be on disk before we trust a turn.
      if (countUserPrompts(lines) >= minUserPrompts) {
        const turn = extractLastTurnFromJsonl(lines);
        if (turn.text.length > 0) return turn;
      }
    } catch { /* not flushed yet / mid-write — retry */ }
    if (attempt < retries) await new Promise((r) => setTimeout(r, delay));
  }
  return null;
}
