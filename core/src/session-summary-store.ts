/**
 * Session Summary Store
 *
 * Persistent per-session summaries with delta tracking.
 * Summaries are LLM-generated (by Claude via the observe skill) and stored
 * with the turn index they were built up to, enabling incremental updates.
 *
 * Storage: ~/.lm-assist/session-summaries.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './utils/path-utils';

export interface SessionSummary {
  sessionId: string;
  /** Human-readable slug */
  slug?: string;
  /** Project path */
  projectPath?: string;
  /** The summary text */
  summary: string;
  /** Generated descriptive name (3 words, kebab-case, e.g. "auth-module-review") */
  displayName?: string;
  /** Turn index this summary was built up to */
  lastTurnIndex: number;
  /** Line index this summary was built up to */
  lastLineIndex: number;
  /** Total turns in session when summary was last checked */
  totalTurns: number;
  /** When the summary was last updated */
  updatedAt: string;
  /** Whether the summary needs delta update (new turns since lastTurnIndex) */
  needsUpdate?: boolean;
}

const STORE_FILE = path.join(getDataDir(), 'session-summaries.json');

// In-memory cache
let store: Map<string, SessionSummary> | null = null;
let storeMtime = 0;

function ensureLoaded(): Map<string, SessionSummary> {
  if (store) {
    // Check if file was modified externally
    try {
      const stat = fs.statSync(STORE_FILE);
      if (stat.mtimeMs !== storeMtime) {
        store = null; // Force reload
      }
    } catch {
      // File doesn't exist yet
    }
  }

  if (!store) {
    store = new Map();
    try {
      if (fs.existsSync(STORE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
        if (Array.isArray(data)) {
          for (const entry of data) {
            if (entry.sessionId) {
              store.set(entry.sessionId, entry);
            }
          }
        }
        storeMtime = fs.statSync(STORE_FILE).mtimeMs;
      }
    } catch {
      // Start fresh
    }
  }
  return store;
}

function persist(): void {
  const s = ensureLoaded();
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const entries = [...s.values()].sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  fs.writeFileSync(STORE_FILE, JSON.stringify(entries, null, 2));
  storeMtime = fs.statSync(STORE_FILE).mtimeMs;
}

/**
 * Get summary for a session. Returns null if not found.
 */
export function getSessionSummary(sessionId: string): SessionSummary | null {
  return ensureLoaded().get(sessionId) || null;
}

/**
 * Get all session summaries.
 */
export function getAllSessionSummaries(): SessionSummary[] {
  return [...ensureLoaded().values()];
}

/**
 * Save or update a session summary.
 */
export function saveSessionSummary(summary: SessionSummary): void {
  const s = ensureLoaded();
  summary.updatedAt = new Date().toISOString();
  s.set(summary.sessionId, summary);
  persist();
}

/**
 * Delete a session summary.
 */
export function deleteSessionSummary(sessionId: string): boolean {
  const s = ensureLoaded();
  const existed = s.delete(sessionId);
  if (existed) persist();
  return existed;
}

/**
 * Check which sessions need summary generation or update.
 * Returns sessions grouped by priority (most recent first).
 *
 * @param sessions - Session list from projects/sessions API
 * @param maxAgeDays - Only check sessions modified within this many days
 */
export function getSessionsNeedingSummaries(
  sessions: Array<{ sessionId: string; numTurns?: number; lastModified?: string | Date; slug?: string; projectPath?: string }>,
  maxAgeDays = 5
): Array<{ sessionId: string; slug?: string; projectPath?: string; status: 'missing' | 'stale'; currentTurns: number; summarizedTurns: number }> {
  const s = ensureLoaded();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const results: Array<{ sessionId: string; slug?: string; projectPath?: string; status: 'missing' | 'stale'; currentTurns: number; summarizedTurns: number }> = [];

  for (const session of sessions) {
    // Skip old sessions
    const modified = session.lastModified ? new Date(session.lastModified).getTime() : 0;
    if (modified < cutoff) continue;

    const currentTurns = session.numTurns || 0;
    if (currentTurns === 0) continue;

    const existing = s.get(session.sessionId);
    if (!existing) {
      results.push({
        sessionId: session.sessionId,
        slug: session.slug,
        projectPath: session.projectPath,
        status: 'missing',
        currentTurns,
        summarizedTurns: 0,
      });
    } else if (existing.lastTurnIndex < currentTurns) {
      results.push({
        sessionId: session.sessionId,
        slug: session.slug || existing.slug,
        projectPath: session.projectPath || existing.projectPath,
        status: 'stale',
        currentTurns,
        summarizedTurns: existing.lastTurnIndex,
      });
    }
  }

  return results;
}
