/**
 * Prompt Queue Store
 *
 * Queues structured prompts for sessions that are currently busy.
 * When a running session finishes its current work, queued prompts
 * can be dispatched to it via --resume.
 *
 * Prompts are "understood" — not raw text but structured with:
 * - original user intent
 * - formatted actionable prompt
 * - context about why this session was chosen
 * - priority and dependencies
 *
 * Storage: ~/.lm-assist/prompt-queue.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './utils/path-utils';

export interface QueuedPrompt {
  /** Unique queue item ID */
  queueId: string;
  /** Target session ID */
  sessionId: string;
  /** Session display name for quick reference */
  sessionDisplayName?: string;
  /** Original user intent (what the user said) */
  originalIntent: string;
  /** Formatted actionable prompt (expanded, clear instructions) */
  formattedPrompt: string;
  /** Why this session was chosen (routing reasoning) */
  routingReason: string;
  /** What the session needs to know about its current state before processing this */
  contextHint?: string;
  /** Priority: high (blocking other work), normal, low (nice to have) */
  priority: 'high' | 'normal' | 'low';
  /** Project path */
  projectPath?: string;
  /** When the prompt was queued */
  queuedAt: string;
  /** Status */
  status: 'pending' | 'dispatched' | 'completed' | 'cancelled';
  /** When dispatched (sent to session) */
  dispatchedAt?: string;
  /** Who queued it (session ID of the requester, or 'user') */
  queuedBy?: string;
}

const STORE_FILE = path.join(getDataDir(), 'prompt-queue.json');

let queue: QueuedPrompt[] | null = null;
let storeMtime = 0;

function ensureLoaded(): QueuedPrompt[] {
  if (queue) {
    try {
      const stat = fs.statSync(STORE_FILE);
      if (stat.mtimeMs !== storeMtime) queue = null;
    } catch {}
  }

  if (!queue) {
    queue = [];
    try {
      if (fs.existsSync(STORE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
        if (Array.isArray(data)) queue = data;
        storeMtime = fs.statSync(STORE_FILE).mtimeMs;
      }
    } catch {}
  }
  return queue;
}

function persist(): void {
  const q = ensureLoaded();
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(q, null, 2));
  storeMtime = fs.statSync(STORE_FILE).mtimeMs;
}

function generateId(): string {
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Add a prompt to a session's queue.
 */
export function enqueuePrompt(prompt: Omit<QueuedPrompt, 'queueId' | 'queuedAt' | 'status'>): QueuedPrompt {
  const q = ensureLoaded();
  const entry: QueuedPrompt = {
    ...prompt,
    queueId: generateId(),
    queuedAt: new Date().toISOString(),
    status: 'pending',
  };
  q.push(entry);
  persist();
  return entry;
}

/**
 * Get all queued prompts for a session (pending only by default).
 */
export function getSessionQueue(sessionId: string, includeAll = false): QueuedPrompt[] {
  const q = ensureLoaded();
  return q
    .filter(p => p.sessionId === sessionId && (includeAll || p.status === 'pending'))
    .sort((a, b) => {
      const pri = { high: 0, normal: 1, low: 2 };
      return (pri[a.priority] - pri[b.priority]) || (new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime());
    });
}

/**
 * Get all pending prompts across all sessions.
 */
export function getAllPendingPrompts(): QueuedPrompt[] {
  const q = ensureLoaded();
  return q
    .filter(p => p.status === 'pending')
    .sort((a, b) => new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime());
}

/**
 * Get the next pending prompt for a session (highest priority, oldest first).
 */
export function getNextPrompt(sessionId: string): QueuedPrompt | null {
  const pending = getSessionQueue(sessionId);
  return pending.length > 0 ? pending[0] : null;
}

/**
 * Mark a prompt as dispatched (sent to session for execution).
 */
export function markDispatched(queueId: string): boolean {
  const q = ensureLoaded();
  const item = q.find(p => p.queueId === queueId);
  if (!item || item.status !== 'pending') return false;
  item.status = 'dispatched';
  item.dispatchedAt = new Date().toISOString();
  persist();
  return true;
}

/**
 * Mark a prompt as completed.
 */
export function markCompleted(queueId: string): boolean {
  const q = ensureLoaded();
  const item = q.find(p => p.queueId === queueId);
  if (!item) return false;
  item.status = 'completed';
  persist();
  return true;
}

/**
 * Cancel a queued prompt.
 */
export function cancelPrompt(queueId: string): boolean {
  const q = ensureLoaded();
  const item = q.find(p => p.queueId === queueId);
  if (!item || item.status !== 'pending') return false;
  item.status = 'cancelled';
  persist();
  return true;
}

/**
 * Clean up old completed/cancelled entries (older than 7 days).
 */
export function cleanupQueue(): number {
  const q = ensureLoaded();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const before = q.length;
  const filtered = q.filter(p =>
    p.status === 'pending' || p.status === 'dispatched' ||
    new Date(p.queuedAt).getTime() > cutoff
  );
  if (filtered.length < before) {
    queue = filtered;
    persist();
  }
  return before - filtered.length;
}
