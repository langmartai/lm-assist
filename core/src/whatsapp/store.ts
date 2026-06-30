/**
 * WhatsApp message store.
 *
 * The Cloud API has NO "fetch conversation history" endpoint — you SEND via
 * the Graph API and RECEIVE inbound messages + delivery receipts via webhook
 * callbacks. So "read" is served from what this node has ingested over time:
 * an append-only JSONL log (`messages.jsonl`) under WA_DATA_DIR, mirrored in
 * memory for query.
 *
 * Records are one of:
 *   - a message       (`__kind` absent) — inbound or outbound
 *   - a status patch  (`__kind:'status'`) — updates an existing message's
 *                      delivery status (sent → delivered → read → failed)
 *
 * Chats are derived on demand (keyed by the counterparty wa_id). Read-state
 * (how far the operator has caught up per chat) lives in a tiny sibling JSON.
 */

import * as fs from 'fs';
import * as path from 'path';
import { WA_DATA_DIR } from './config';

export interface WaMessage {
  /** wamid (Meta's id) for real messages; a synthetic `out-…` id if send returned none. */
  id: string;
  /** Counterparty wa_id (digits-only phone) — the "chat" this message belongs to. */
  chatId: string;
  direction: 'in' | 'out';
  /** wa_id of the sender ("me" for outbound). */
  from: string;
  /** wa_id of the recipient (set for outbound). */
  to?: string;
  /** Message type: text, image, document, audio, video, sticker, location, interactive, button, … */
  type: string;
  /** Body for text; caption for media; a short marker for non-text payloads. */
  text?: string;
  /** Unix seconds. */
  timestamp: number;
  /** Outbound delivery status: sent | delivered | read | failed. */
  status?: string;
  /** Profile name of the counterparty, when WhatsApp includes it. */
  contactName?: string;
  /** Media id (for image/document/etc.) — resolve to a URL via the Graph API if needed. */
  mediaId?: string;
}

export interface WaChat {
  chatId: string;
  name?: string;
  lastMessageAt: number;
  lastText?: string;
  lastDirection?: 'in' | 'out';
  messageCount: number;
  unreadCount: number;
}

interface StatusPatch {
  __kind: 'status';
  id: string;
  status: string;
  timestamp?: number;
}

const messagesFile = () => path.join(WA_DATA_DIR, 'messages.jsonl');
const readStateFile = () => path.join(WA_DATA_DIR, 'read-state.json');

let loaded = false;
let messages: WaMessage[] = [];
const byId = new Map<string, WaMessage>();
/** chatId -> unix seconds the operator has read up to. */
let readState: Record<string, number> = {};

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(messagesFile(), 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec: WaMessage | StatusPatch;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if ((rec as StatusPatch).__kind === 'status') {
        applyStatus(rec as StatusPatch);
      } else {
        upsertMessage(rec as WaMessage, false);
      }
    }
  } catch {
    /* no log yet */
  }
  try {
    readState = JSON.parse(fs.readFileSync(readStateFile(), 'utf-8'));
  } catch {
    readState = {};
  }
  messages.sort((a, b) => a.timestamp - b.timestamp);
}

function upsertMessage(m: WaMessage, persist: boolean): boolean {
  const existing = byId.get(m.id);
  if (existing) {
    // Keep the stored copy authoritative but fill in any newly-known fields.
    Object.assign(existing, { ...m, status: m.status ?? existing.status });
    return false;
  }
  byId.set(m.id, m);
  messages.push(m);
  if (persist) {
    appendLine(m);
    // Keep the in-memory array ordered for cheap range queries.
    messages.sort((a, b) => a.timestamp - b.timestamp);
  }
  return true;
}

function applyStatus(p: StatusPatch): void {
  const m = byId.get(p.id);
  if (m) m.status = p.status;
}

function appendLine(rec: WaMessage | StatusPatch): void {
  fs.mkdirSync(WA_DATA_DIR, { recursive: true });
  fs.appendFileSync(messagesFile(), JSON.stringify(rec) + '\n');
}

function persistReadState(): void {
  fs.mkdirSync(WA_DATA_DIR, { recursive: true });
  fs.writeFileSync(readStateFile(), JSON.stringify(readState));
}

/** Record an inbound (received) message. Idempotent on `id`. */
export function addInbound(m: WaMessage): void {
  ensureLoaded();
  upsertMessage({ ...m, direction: 'in' }, true);
}

/** Record an outbound (sent) message. Idempotent on `id`. */
export function addOutbound(m: WaMessage): void {
  ensureLoaded();
  upsertMessage({ ...m, direction: 'out' }, true);
}

/** Update an outbound message's delivery status (sent/delivered/read/failed). */
export function recordStatus(id: string, status: string, timestamp?: number): void {
  ensureLoaded();
  const patch: StatusPatch = { __kind: 'status', id, status, timestamp };
  applyStatus(patch);
  appendLine(patch);
}

/** Counterparties sorted by most-recent activity. */
export function listChats(limit = 30): WaChat[] {
  ensureLoaded();
  const chats = new Map<string, WaChat>();
  for (const m of messages) {
    let c = chats.get(m.chatId);
    if (!c) {
      c = { chatId: m.chatId, lastMessageAt: 0, messageCount: 0, unreadCount: 0 };
      chats.set(m.chatId, c);
    }
    c.messageCount++;
    if (m.contactName) c.name = m.contactName;
    if (m.timestamp >= c.lastMessageAt) {
      c.lastMessageAt = m.timestamp;
      c.lastText = m.text;
      c.lastDirection = m.direction;
    }
    if (m.direction === 'in' && m.timestamp > (readState[m.chatId] || 0)) c.unreadCount++;
  }
  return [...chats.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt).slice(0, limit);
}

/** Most-recent `limit` messages for a chat, returned in chronological order. */
export function getMessages(chatId: string, limit = 30): WaMessage[] {
  ensureLoaded();
  const all = messages.filter((m) => m.chatId === chatId);
  return all.slice(Math.max(0, all.length - limit));
}

/** Case-insensitive substring search across message text, most-recent first. */
export function search(query: string, limit = 20): WaMessage[] {
  ensureLoaded();
  const q = query.toLowerCase();
  const hits = messages.filter((m) => (m.text || '').toLowerCase().includes(q));
  return hits.slice(Math.max(0, hits.length - limit)).reverse();
}

/** Mark a chat read up to now, so its unreadCount resets to 0. */
export function markChatRead(chatId: string): void {
  ensureLoaded();
  readState[chatId] = Math.floor(Date.now() / 1000);
  persistReadState();
}

/** Aggregate counts for the status endpoint. */
export function stats(): { totalMessages: number; chats: number; unread: number } {
  ensureLoaded();
  const chats = listChats(Number.MAX_SAFE_INTEGER);
  return {
    totalMessages: messages.length,
    chats: chats.length,
    unread: chats.reduce((n, c) => n + c.unreadCount, 0),
  };
}

/** Test-only: drop the in-memory cache so the next call re-reads from disk. */
export function _resetForTest(): void {
  loaded = false;
  messages = [];
  byId.clear();
  readState = {};
}
