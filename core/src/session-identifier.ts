/**
 * Session Identifier
 *
 * Identifies which Claude Code session an unmanaged tmux process belongs to
 * by capturing terminal output via `tmux capture-pane` and matching it
 * against session JSONL file content (via SessionCache).
 *
 * Used when a Claude process was started without `--resume` (no sessionId
 * in cmdline) and the 60-second matchSessionByProcessTime window has passed.
 *
 * @packageDocumentation
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { legacyEncodeProjectPath } from './utils/path-utils';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// ─── Types ──────────────────────────────────────────────────

export interface IdentificationResult {
  sessionId: string;
  confidence: number;
  matchDetails: {
    userPromptMatches: number;
    filePathMatches: number;
    commitHashMatches: number;
    ngramMatches: number;
    score: number;
    maxScore: number;
  };
}

interface Fingerprints {
  userPrompts: string[];
  filePaths: string[];
  commitHashes: string[];
  wordNgrams: string[];
}

interface ScoreResult {
  score: number;
  maxScore: number;
  confidence: number;
  userPromptMatches: number;
  filePathMatches: number;
  commitHashMatches: number;
  ngramMatches: number;
}

export interface ScreenTurnMatch {
  sessionId: string;
  lastReadTurnIndex: number;          // highest turnIndex matched on screen
  lastReadTimestamp: string | null;    // timestamp of the matched turn's user prompt
  matchedVia: 'userPrompt' | 'response';  // what type of content matched
  matchedText: string;                // the text snippet that matched (first 120 chars)
  contentLength: number;              // raw tmux capture length (0 = blank/alternate screen)
  capturedAt: string;                 // ISO timestamp of capture
}

// ─── Helper Functions ──────────────────────────────────────────────────

/**
 * Strip ANSI escape codes and normalize whitespace
 */
export function normalizeTerminalText(raw: string): string {
  return raw
    // Strip ANSI escape sequences
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // Strip carriage returns
    .replace(/\r/g, '')
    // Strip TUI box-drawing and decoration characters (─│╭╮╯╰┌┐└┘├┤┬┴┼▐▛▜▝▘▚▞█▌▀▄░▒▓●✻◇◆▸▹⎿⏵)
    .replace(/[─│╭╮╯╰┌┐└┘├┤┬┴┼▐▛▜▝▘▚▞█▌▀▄░▒▓●✻◇◆▸▹⎿⏵╵╶╷╴╋━┃┅┇┈┉┊┋╌╍╎╏═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬]/g, '')
    // Collapse multiple spaces
    .replace(/[ \t]+/g, ' ')
    // Normalize line endings
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .toLowerCase();
}

/**
 * Extract fingerprints from normalized terminal text
 */
export function extractFingerprints(text: string): Fingerprints {
  const lines = text.split('\n');

  // User prompts: lines after ❯ or > prompt markers (highest signal)
  const userPrompts: string[] = [];
  for (const line of lines) {
    // Match Claude Code prompt markers: "❯ " only
    // Note: "> " lines are from the optional status bar, not reliable for identification
    const promptMatch = line.match(/^\s*❯\s+(.{5,})$/);
    if (promptMatch) {
      userPrompts.push(promptMatch[1].trim());
    }
  }

  // File paths: /path/to/file.ext patterns
  const filePathSet = new Set<string>();
  const filePathRegex = /(?:\/[\w.-]+){2,}\.[\w]+/g;
  let match;
  while ((match = filePathRegex.exec(text)) !== null) {
    filePathSet.add(match[0]);
  }

  // Commit hashes: 7-40 char hex strings (standalone words)
  const commitHashSet = new Set<string>();
  const hashRegex = /\b[a-f0-9]{7,40}\b/g;
  while ((match = hashRegex.exec(text)) !== null) {
    // Filter out common false positives (pure numeric strings)
    const h = match[0];
    if (h.length >= 7 && h.length <= 40 && !/^[0-9]+$/.test(h)) {
      commitHashSet.add(h);
    }
  }

  // Word n-grams: sliding 4-word windows from visible text
  // Sample from the END of the text (most recent output) rather than the beginning
  // because the start of tmux scrollback contains TUI headers and old content
  const ngramSet = new Set<string>();
  const words = text.split(/\s+/).filter(w => w.length > 2);
  const ngramLimit = 200;
  // Build n-grams from the end of the text first
  for (let i = Math.max(0, words.length - 4 - ngramLimit * 4); i <= words.length - 4; i++) {
    ngramSet.add(words.slice(i, i + 4).join(' '));
  }
  const wordNgrams = Array.from(ngramSet).slice(-ngramLimit);

  return {
    userPrompts,
    filePaths: Array.from(filePathSet),
    commitHashes: Array.from(commitHashSet),
    wordNgrams,
  };
}

// ─── Screen-to-Turn Matching ──────────────────────────────────────────────────

/**
 * Normalize text for screen-to-turn matching (preserves case, unlike normalizeTerminalText)
 */
function normalizeForMatching(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // strip ANSI
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Strip Claude Code TUI line prefixes (prompt markers, bullet points, etc.)
 */
function stripScreenPrefix(line: string): string {
  return line
    .replace(/^[●✻◇◆▸▹⎿❯>]\s*/, '')  // strip bullet/prompt prefixes
    .replace(/^\s+/, '')                  // strip leading whitespace
    .trim();
}

/**
 * Match captured tmux screen content against session cache to find the last visible turn.
 *
 * Scans bottom-to-top through captured terminal text and matches lines against
 * userPrompts[].text and responses[].text from the session cache.
 * The highest turnIndex that matches = lastReadTurnIndex for that console.
 */
export function matchScreenToTurn(
  rawTerminalContent: string,
  sessionCache: { sessionId: string; userPrompts: Array<{ turnIndex: number; text: string; timestamp?: string }>; responses: Array<{ turnIndex: number; text: string }> },
): ScreenTurnMatch | null {
  const contentLength = rawTerminalContent.length;

  // Alternate screen / no content
  if (!rawTerminalContent || rawTerminalContent.trim().length < 20) {
    return null;
  }

  const normalized = normalizeForMatching(rawTerminalContent);
  const lines = normalized.split('\n').reverse(); // bottom-to-top

  // Build lookup: normalized prompt text → { turnIndex, timestamp }
  const promptMap = new Map<string, { turnIndex: number; timestamp: string | undefined }>();
  for (const p of sessionCache.userPrompts) {
    if (p.text && p.text.trim().length >= 3) {
      const key = normalizeForMatching(p.text);
      // Keep the highest turnIndex for duplicate prompts
      const existing = promptMap.get(key);
      if (!existing || p.turnIndex > existing.turnIndex) {
        promptMap.set(key, { turnIndex: p.turnIndex, timestamp: p.timestamp });
      }
    }
  }

  // Build response lookup: first 200 chars normalized → { turnIndex }
  const responseEntries: Array<{ prefix: string; turnIndex: number }> = [];
  for (const r of sessionCache.responses) {
    if (r.text && r.text.trim().length >= 10) {
      const prefix = normalizeForMatching(r.text.slice(0, 200));
      responseEntries.push({ prefix, turnIndex: r.turnIndex });
    }
  }

  for (const rawLine of lines) {
    const stripped = stripScreenPrefix(rawLine);
    if (stripped.length < 3) continue;
    const cleanLine = normalizeForMatching(stripped);
    if (cleanLine.length < 3) continue;

    // Try exact match against user prompts
    const promptHit = promptMap.get(cleanLine);
    if (promptHit) {
      return {
        sessionId: sessionCache.sessionId,
        lastReadTurnIndex: promptHit.turnIndex,
        lastReadTimestamp: promptHit.timestamp || null,
        matchedVia: 'userPrompt',
        matchedText: cleanLine.slice(0, 120),
        contentLength,
        capturedAt: new Date().toISOString(),
      };
    }

    // Try substring match against response prefixes (screen line is prefix of cached response)
    if (cleanLine.length >= 10) {
      for (const entry of responseEntries) {
        if (entry.prefix.startsWith(cleanLine) || cleanLine.startsWith(entry.prefix.slice(0, cleanLine.length))) {
          // Find the corresponding user prompt timestamp for this turn
          const correspondingPrompt = sessionCache.userPrompts.find(p => p.turnIndex === entry.turnIndex);
          return {
            sessionId: sessionCache.sessionId,
            lastReadTurnIndex: entry.turnIndex,
            lastReadTimestamp: correspondingPrompt?.timestamp || null,
            matchedVia: 'response',
            matchedText: cleanLine.slice(0, 120),
            contentLength,
            capturedAt: new Date().toISOString(),
          };
        }
      }
    }
  }

  return null;
}

// ─── Fingerprint-based Scoring ──────────────────────────────────────────────────

/**
 * Score how well fingerprints match a session's cached data
 */
export function scoreSessionMatch(
  fingerprints: Fingerprints,
  sessionData: { userPrompts: Array<{ text: string }>; responses: Array<{ text: string }>; toolUses: Array<{ input: any }> },
): ScoreResult {
  const WEIGHT_USER_PROMPT = 10;
  const WEIGHT_FILE_PATH = 5;
  const WEIGHT_COMMIT_HASH = 8;
  const WEIGHT_NGRAM = 2;

  let score = 0;
  let maxScore = 0;
  let userPromptMatches = 0;
  let filePathMatches = 0;
  let commitHashMatches = 0;
  let ngramMatches = 0;

  // Build searchable text from session data
  const sessionUserPrompts = sessionData.userPrompts.map(p => p.text.toLowerCase());
  const sessionResponseText = sessionData.responses.map(r => r.text.toLowerCase()).join('\n');
  const sessionToolInputText = sessionData.toolUses
    .map(t => {
      if (!t.input) return '';
      if (typeof t.input === 'string') return t.input.toLowerCase();
      try { return JSON.stringify(t.input).toLowerCase(); } catch { return ''; }
    })
    .join('\n');
  const sessionFullText = sessionResponseText + '\n' + sessionToolInputText;

  // Match user prompts (weight: 10 each)
  if (fingerprints.userPrompts.length > 0) {
    maxScore += fingerprints.userPrompts.length * WEIGHT_USER_PROMPT;
    for (const prompt of fingerprints.userPrompts) {
      const matched = sessionUserPrompts.some(sp =>
        sp.includes(prompt) || prompt.includes(sp)
      );
      if (matched) {
        score += WEIGHT_USER_PROMPT;
        userPromptMatches++;
      }
    }
  }

  // Match file paths (weight: 5 each)
  if (fingerprints.filePaths.length > 0) {
    maxScore += fingerprints.filePaths.length * WEIGHT_FILE_PATH;
    for (const fp of fingerprints.filePaths) {
      if (sessionFullText.includes(fp)) {
        score += WEIGHT_FILE_PATH;
        filePathMatches++;
      }
    }
  }

  // Match commit hashes (weight: 8 each)
  if (fingerprints.commitHashes.length > 0) {
    maxScore += fingerprints.commitHashes.length * WEIGHT_COMMIT_HASH;
    for (const hash of fingerprints.commitHashes) {
      if (sessionResponseText.includes(hash)) {
        score += WEIGHT_COMMIT_HASH;
        commitHashMatches++;
      }
    }
  }

  // Match word n-grams (weight: 2 each, capped to reduce dilution)
  if (fingerprints.wordNgrams.length > 0) {
    const ngramCap = 20;
    const ngrams = fingerprints.wordNgrams.slice(0, ngramCap);
    maxScore += ngrams.length * WEIGHT_NGRAM;
    for (const ng of ngrams) {
      if (sessionResponseText.includes(ng)) {
        score += WEIGHT_NGRAM;
        ngramMatches++;
      }
    }
  }

  const confidence = maxScore > 0 ? score / maxScore : 0;

  return { score, maxScore, confidence, userPromptMatches, filePathMatches, commitHashMatches, ngramMatches };
}

// ─── Two-Stage Identification Helpers ──────────────────────────────────────────

/** TUI box-drawing and decoration character pattern */
const TUI_CHARS_RE = /[─│╭╮╯╰┌┐└┘├┤┬┴┼▐▛▜▝▘▚▞█▌▀▄░▒▓●✻◇◆▸▹⎿⏵╵╶╷╴╋━┃┅┇┈┉┊┋╌╍╎╏═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬]/g;

/**
 * Extract clean text lines from raw tmux capture.
 * Strips ANSI codes, TUI decoration, prompt markers, collapses whitespace.
 * Returns lowercased lines (bottom = most recent).
 */
function extractScreenLines(raw: string): string[] {
  const lines = raw.split('\n');
  const result: string[] = [];
  for (const line of lines) {
    let clean = line
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // strip ANSI
      .replace(/\r/g, '')
      .replace(TUI_CHARS_RE, '')                 // strip TUI chars
      .replace(/^[❯>]\s*/, '')                   // strip prompt markers at line start
      .replace(/^\s*\d{1,6}\s*[+\-]?\s/, '')    // strip line number prefixes (e.g. "713 + ")
      .replace(/^[+\-]\s+/, '')                  // strip standalone diff markers (e.g. "+ interface Foo {")
      .replace(/[ \t]+/g, ' ')                   // collapse whitespace
      .trim()
      .toLowerCase();
    // Skip empty / too-short lines
    if (clean.length >= 5) {
      result.push(clean);
    }
  }
  return result;
}

/**
 * Extract 4-word n-grams from screen lines for fuzzy matching.
 * Strips punctuation from word boundaries for better matching across
 * TUI formatting differences (e.g. "bash(curl" → "curl").
 */
function extractScreenNgrams(screenLines: string[], maxNgrams: number = 500): string[] {
  const ngrams = new Set<string>();
  for (const line of screenLines) {
    // Clean words: remove leading/trailing punctuation, skip very short/common words
    const words = line.split(/\s+/)
      .map(w => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
      .filter(w => w.length > 2);
    if (words.length < 4) continue;
    for (let i = 0; i <= words.length - 4 && ngrams.size < maxNgrams; i++) {
      ngrams.add(words.slice(i, i + 4).join(' '));
    }
  }
  return Array.from(ngrams);
}

/**
 * Build searchable text from session cache data.
 * Includes responses, tool inputs/outputs, and user prompts.
 */
function buildSessionText(sessionData: {
  userPrompts: Array<{ text: string }>;
  responses: Array<{ text: string }>;
  toolUses: Array<{ input: any }>;
}): string {
  const parts: string[] = [];

  // User prompts
  for (const p of sessionData.userPrompts) {
    if (p.text) parts.push(p.text);
  }

  // Responses
  for (const r of sessionData.responses) {
    if (r.text) parts.push(r.text);
  }

  // Tool uses (stringify input)
  for (const t of sessionData.toolUses) {
    if (!t.input) continue;
    if (typeof t.input === 'string') {
      parts.push(t.input);
    } else {
      try { parts.push(JSON.stringify(t.input)); } catch {}
    }
  }

  return parts.join('\n');
}

/**
 * Fallback: Build session text directly from raw JSONL when cache returns empty.
 * Slower than cache-based buildSessionText, but handles compacted/rewritten
 * sessions where the cache's byte offsets are stale.
 *
 * For large files (>maxBytes), only reads the tail portion to keep
 * performance acceptable when many candidates need the fallback.
 */
function buildSessionTextFromJSONL(filePath: string, maxBytes: number = 200_000): string {
  try {
    let raw: string;
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) {
      // Read only the tail of large files (most recent content)
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
      fs.closeSync(fd);
      raw = buf.toString('utf-8');
      // Skip first partial line (cut off by the seek)
      const firstNewline = raw.indexOf('\n');
      if (firstNewline > 0) raw = raw.slice(firstNewline + 1);
    } else {
      raw = fs.readFileSync(filePath, 'utf-8');
    }
    const parts: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              parts.push(block.text);
            }
            if (block.type === 'tool_use' && block.input) {
              if (typeof block.input === 'string') {
                parts.push(block.input);
              } else {
                try { parts.push(JSON.stringify(block.input)); } catch {}
              }
            }
            if (block.type === 'tool_result') {
              if (typeof block.content === 'string') {
                parts.push(block.content);
              } else if (Array.isArray(block.content)) {
                for (const c of block.content) {
                  if (c.type === 'text' && c.text) parts.push(c.text);
                }
              }
            }
          }
        }
        // Standalone result messages (e.g. tool results at top level)
        if (msg.result && typeof msg.result === 'string') {
          parts.push(msg.result);
        }
      } catch {}  // skip unparseable lines
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

/**
 * Extract significant text chunks from session text for Stage 2 reverse matching.
 * Splits into segments of 20+ characters, skipping very short fragments.
 */
function extractSessionChunks(sessionText: string): string[] {
  // Split on newlines and take chunks ≥20 chars
  const chunks: string[] = [];
  for (const line of sessionText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length >= 20) {
      chunks.push(trimmed);
    }
  }
  return chunks;
}

// ─── SessionIdentifier Class ──────────────────────────────────────────────────

export class SessionIdentifier {
  /** PID → identification result (persistent until process exits) */
  private identifiedSessions = new Map<number, IdentificationResult>();
  /** PID → timestamp of last attempt (30s retry cooldown) */
  private lastAttempt = new Map<number, number>();

  private readonly RETRY_INTERVAL_MS = 30_000;
  private readonly MIN_CONFIDENCE = 0.15;
  /** Absolute score threshold — if score >= this, accept even if confidence ratio is low */
  private readonly MIN_ABSOLUTE_SCORE = 25;
  /** Stop testing candidates once we find one above this confidence */
  private readonly HIGH_CONFIDENCE = 0.6;

  /**
   * Get cached identification for a PID (sync, O(1))
   */
  getCachedIdentification(pid: number): IdentificationResult | null {
    return this.identifiedSessions.get(pid) || null;
  }

  /**
   * Check if we should attempt identification for a PID
   */
  shouldAttempt(pid: number): boolean {
    if (this.identifiedSessions.has(pid)) return false;
    const last = this.lastAttempt.get(pid);
    if (last && Date.now() - last < this.RETRY_INTERVAL_MS) return false;
    return true;
  }

  /**
   * Cache an identification result
   */
  cacheResult(pid: number, result: IdentificationResult): void {
    this.identifiedSessions.set(pid, result);
  }

  /**
   * Remove entries for dead PIDs
   */
  cleanup(activePids: Set<number>): void {
    for (const pid of this.identifiedSessions.keys()) {
      if (!activePids.has(pid)) {
        this.identifiedSessions.delete(pid);
      }
    }
    for (const pid of this.lastAttempt.keys()) {
      if (!activePids.has(pid)) {
        this.lastAttempt.delete(pid);
      }
    }
  }

  /**
   * Main entry point: identify which session a tmux process belongs to
   */
  /**
   * Two-stage session identification:
   *
   * Stage 1 — Screen→Session: Extract clean lines from screen (bottom-up),
   *   find which candidate session's conversation text contains the most matches.
   *
   * Stage 2 — Session→Screen verification: Take the top candidate's conversation,
   *   reverse-match against screen content. Require >50% coverage to confirm.
   */
  async identify(
    tmuxSessionName: string,
    projectPath: string,
    processStartedAt: Date,
    debug?: boolean,
  ): Promise<(IdentificationResult & { _debug?: any }) | null> {
    try {
      // 1. Capture terminal content (full scrollback)
      let raw: string;
      try {
        raw = execFileSync('tmux', ['capture-pane', '-t', tmuxSessionName, '-p', '-S', '-'], {
          encoding: 'utf-8',
          timeout: 5000,
        });
      } catch {
        return null;
      }

      if (!raw || raw.trim().length < 50) {
        if (debug) console.error(`[SessionIdentifier] Bail: raw too short (${raw?.trim().length ?? 0})`);
        return null;
      }

      // 2. Extract clean screen lines (strip TUI decoration, empty lines, box-drawing-only lines)
      const screenLines = extractScreenLines(raw);
      if (debug) console.error(`[SessionIdentifier] Screen lines: ${screenLines.length}, raw: ${raw.length} chars`);
      if (screenLines.length < 3) return null;

      // 3. List candidate sessions
      const projectKey = legacyEncodeProjectPath(projectPath);
      const sessionDir = path.join(CLAUDE_PROJECTS_DIR, projectKey);
      if (!fs.existsSync(sessionDir)) return null;

      const processMs = processStartedAt.getTime();
      const allEntries = fs.readdirSync(sessionDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const fp = path.join(sessionDir, f);
          try {
            const stat = fs.statSync(fp);
            const birthtimeMs = (stat as any).birthtimeMs || stat.ctimeMs;
            return { file: f, filePath: fp, mtime: stat.mtime.getTime(), birthtime: birthtimeMs };
          } catch {
            return null;
          }
        })
        .filter((f): f is NonNullable<typeof f> => f !== null);

      // Pre-filter: include files that were active around the process lifetime.
      // - mtime within 2h before process start to now (covers idle-before-resume)
      // - OR birthtime within 30min of process start (covers new sessions)
      const allCandidates = allEntries.filter(f =>
        f.mtime > processMs - 2 * 60 * 60 * 1000 ||
        Math.abs(f.birthtime - processMs) < 30 * 60 * 1000
      );

      // Three candidate pools merged: birthtime proximity (highest signal) + mtime proximity + recent
      // Keep pools small to avoid slow JSONL parsing when cache is cold
      const byBirthProximity = [...allCandidates]
        .sort((a, b) => Math.abs(a.birthtime - processMs) - Math.abs(b.birthtime - processMs))
        .slice(0, 8);
      const byMtimeProximity = [...allCandidates]
        .sort((a, b) => Math.abs(a.mtime - processMs) - Math.abs(b.mtime - processMs))
        .slice(0, 8);
      const byRecent = [...allCandidates].sort((a, b) => b.mtime - a.mtime).slice(0, 8);
      const seen = new Set<string>();
      const files: typeof byRecent = [];
      for (const f of [...byBirthProximity, ...byMtimeProximity, ...byRecent]) {
        if (!seen.has(f.file)) {
          seen.add(f.file);
          files.push(f);
        }
      }
      if (files.length === 0) {
        if (debug) console.error(`[SessionIdentifier] Bail: no candidate files (allCandidates=${allCandidates.length})`);
        return null;
      }
      if (debug) console.error(`[SessionIdentifier] Candidates: ${files.length} (from ${allCandidates.length} eligible)`);

      // 4. STAGE 1 — Screen→Session: match screen lines against session text
      const { getSessionCache } = await import('./session-cache');
      const cache = getSessionCache();

      // Extract n-grams from screen for Stage 1 matching.
      // N-grams are 4-word windows from the bottom portion of the screen (most recent output).
      // Using n-grams instead of full lines handles TUI formatting (e.g. "bash(cmd)" wrappers,
      // diff markers, line numbers) that would prevent full-line substring matching.
      // Limit to 150 n-grams for fast matching (each checked via includes against session text).
      const bottomScreenLines = screenLines.slice(-100);
      const screenNgrams = extractScreenNgrams(bottomScreenLines, 150);
      if (debug) console.error(`[SessionIdentifier] Extracted ${screenNgrams.length} n-grams from ${bottomScreenLines.length} screen lines`);

      type Stage1Result = {
        sessionId: string;
        filePath: string;
        mtime: number;
        birthtime: number;
        matchedNgrams: number;
        totalNgrams: number;
        matchRatio: number;
        sessionText: string; // keep for Stage 2
      };

      const stage1Results: Stage1Result[] = [];

      for (const { file, filePath, mtime, birthtime } of files) {
        const sessionId = file.replace('.jsonl', '');

        let sessionData = cache.getSessionDataFromMemory(filePath);
        if (!sessionData) {
          sessionData = await cache.getSessionData(filePath);
        }

        // Build searchable text from session conversation
        let sessionText = sessionData ? buildSessionText(sessionData) : '';
        // Fallback: if cache returned no data or very little text, parse JSONL directly.
        // This handles: cache not warmed, compacted sessions with stale byte offsets,
        // or any other cache failure.
        if (sessionText.length < 100) {
          sessionText = buildSessionTextFromJSONL(filePath);
          if (debug && sessionText.length > 100) {
            console.error(`[SessionIdentifier] JSONL fallback for ${sessionId.slice(0, 12)}: ${sessionText.length} chars (cache ${sessionData ? 'had little data' : 'returned null'})`);
          }
        }
        if (sessionText.length < 50) continue;  // skip sessions with truly no content
        const sessionTextLower = sessionText.toLowerCase();

        // Count how many screen n-grams appear in session text
        let matchedNgrams = 0;
        for (const ng of screenNgrams) {
          if (sessionTextLower.includes(ng)) {
            matchedNgrams++;
          }
        }

        const matchRatio = screenNgrams.length > 0 ? matchedNgrams / screenNgrams.length : 0;

        stage1Results.push({
          sessionId,
          filePath,
          mtime,
          birthtime,
          matchedNgrams,
          totalNgrams: screenNgrams.length,
          matchRatio,
          sessionText,
        });
      }

      // Sort by matched n-grams descending, then by mtime proximity
      stage1Results.sort((a, b) => {
        if (b.matchedNgrams !== a.matchedNgrams) return b.matchedNgrams - a.matchedNgrams;
        const aDiff = Math.abs(a.mtime - processMs);
        const bDiff = Math.abs(b.mtime - processMs);
        return aDiff - bDiff;
      });

      if (debug) {
        console.error(`[SessionIdentifier] Stage 1: ${screenNgrams.length} n-grams, ${stage1Results.length} candidates`);
        for (const r of stage1Results.slice(0, 5)) {
          console.error(`  ${r.sessionId.slice(0, 12)} matched=${r.matchedNgrams}/${r.totalNgrams} (${(r.matchRatio * 100).toFixed(1)}%)`);
        }
      }

      // 5. STAGE 2 — Session→Screen verification + scoring
      // For each top Stage 1 candidate, compute reverse coverage.
      // Then combine: stage1 match ratio + stage2 coverage + birthtime proximity.
      // Sessions may be compacted (old content removed), so we don't require
      // high coverage — instead we use a composite score.
      const allScreenText = screenLines.join('\n').toLowerCase();
      const allScreenChars = allScreenText.length;

      let bestResult: {
        sessionId: string;
        stage1MatchRatio: number;
        stage2Coverage: number;
        birthtimeScore: number;
        finalScore: number;
      } | null = null;

      // Only verify top 5 candidates that had at least 1 match in Stage 1
      const topCandidates = stage1Results.filter(r => r.matchedNgrams > 0).slice(0, 5);

      const debugStages: Array<{
        sessionId: string;
        stage1: { matchedNgrams: number; totalNgrams: number; ratio: number };
        stage2: { coveredChars: number; totalChars: number; coverage: number };
        birthtimeScore: number;
        finalScore: number;
        mtimeDiff: number;
      }> = [];

      for (const candidate of topCandidates) {
        // Stage 2: Extract text chunks from session, check what % of screen they cover
        const sessionChunks = extractSessionChunks(candidate.sessionText);
        let coveredChars = 0;
        const covered = new Uint8Array(allScreenChars);

        for (const chunk of sessionChunks) {
          const chunkLower = chunk.toLowerCase();
          let searchFrom = 0;
          while (searchFrom < allScreenChars) {
            const idx = allScreenText.indexOf(chunkLower, searchFrom);
            if (idx === -1) break;
            for (let i = idx; i < idx + chunkLower.length && i < allScreenChars; i++) {
              covered[i] = 1;
            }
            searchFrom = idx + chunkLower.length;
          }
        }

        for (let i = 0; i < allScreenChars; i++) {
          if (covered[i]) coveredChars++;
        }

        const coverage = allScreenChars > 0 ? coveredChars / allScreenChars : 0;

        // Birthtime proximity score: 1.0 if birthtime within 10min of process start, decaying
        // Use stat birthtime (creation time) to find which session was created for this process
        let birthtimeScore = 0;
        const btDiff = Math.abs(candidate.birthtime - processMs);
        // Score: 1.0 within 10min, 0.5 within 30min, 0.2 within 1h, 0 beyond
        if (btDiff < 10 * 60 * 1000) birthtimeScore = 1.0;
        else if (btDiff < 30 * 60 * 1000) birthtimeScore = 0.5;
        else if (btDiff < 60 * 60 * 1000) birthtimeScore = 0.2;

        // Composite score: weighted combination
        // Stage 1 (screen→session): 40%, Stage 2 (session→screen): 30%, birthtime: 30%
        const finalScore = candidate.matchRatio * 0.4 + coverage * 0.3 + birthtimeScore * 0.3;

        const mtimeDiff = Math.abs(candidate.mtime - processMs);

        if (debug) {
          debugStages.push({
            sessionId: candidate.sessionId,
            stage1: { matchedNgrams: candidate.matchedNgrams, totalNgrams: candidate.totalNgrams, ratio: candidate.matchRatio },
            stage2: { coveredChars, totalChars: allScreenChars, coverage },
            birthtimeScore,
            finalScore,
            mtimeDiff,
          });
        }

        // Accept if composite score is high enough, OR if content match alone is strong.
        // Content-only acceptance handles compacted sessions where birthtime was reset,
        // making the birthtime score 0 despite the session being correct.
        const contentScore = candidate.matchRatio * 0.4 + coverage * 0.3;
        if (finalScore < 0.10 && contentScore < 0.08) continue;

        if (!bestResult || finalScore > bestResult.finalScore) {
          bestResult = {
            sessionId: candidate.sessionId,
            stage1MatchRatio: candidate.matchRatio,
            stage2Coverage: coverage,
            birthtimeScore,
            finalScore,
          };
        }
      }

      if (debug) {
        console.error(`[SessionIdentifier] Stage 2 results:`);
        for (const d of debugStages) {
          console.error(`  ${d.sessionId.slice(0, 12)} s1=${(d.stage1.ratio * 100).toFixed(1)}% s2=${(d.stage2.coverage * 100).toFixed(1)}% bt=${d.birthtimeScore.toFixed(2)} final=${(d.finalScore * 100).toFixed(1)}%`);
        }
      }

      if (!bestResult) {
        if (debug) {
          const topS1 = stage1Results.slice(0, 3);
          console.error(`[SessionIdentifier] No candidate accepted. Top stage1: ${topS1.map(r => `${r.sessionId.slice(0, 8)}=${r.matchedNgrams}/${r.totalNgrams}`).join(', ')}`);
        }
        return null;
      }

      const result: IdentificationResult & { _debug?: any } = {
        sessionId: bestResult.sessionId,
        confidence: bestResult.finalScore,
        matchDetails: {
          userPromptMatches: 0,
          filePathMatches: 0,
          commitHashMatches: 0,
          ngramMatches: 0,
          score: Math.round(bestResult.finalScore * 100),
          maxScore: 100,
        },
      };

      if (debug) {
        result._debug = {
          candidateCount: files.length,
          allCandidatesCount: allCandidates.length,
          screenNgramsUsed: screenNgrams.length,
          stage1Top: stage1Results.slice(0, 10).map(r => ({
            sessionId: r.sessionId,
            matchedNgrams: r.matchedNgrams,
            totalNgrams: r.totalNgrams,
            ratio: r.matchRatio,
          })),
          stage2: debugStages,
          bestResult,
        };
      }

      return result;
    } catch (err) {
      console.error('[SessionIdentifier] identify error:', err);
      return null;
    }
  }

  /**
   * Identify with PID tracking (convenience wrapper)
   * Records lastAttempt time and caches result automatically
   */
  async identifyForPid(
    pid: number,
    tmuxSessionName: string,
    projectPath: string,
    processStartedAt: Date,
  ): Promise<IdentificationResult | null> {
    this.lastAttempt.set(pid, Date.now());
    const result = await this.identify(tmuxSessionName, projectPath, processStartedAt);
    if (result) {
      this.cacheResult(pid, result);
    }
    return result;
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let instance: SessionIdentifier | null = null;

export function getSessionIdentifier(): SessionIdentifier {
  if (!instance) {
    instance = new SessionIdentifier();
  }
  return instance;
}
