/**
 * WeChat (WeCom 微信客服) message store.
 *
 * The 微信客服 API has no "fetch full history" endpoint — you pull new messages
 * incrementally with `kf/sync_msg` (cursor-based) after a callback wakes you, and
 * you SEND with `kf/send_msg`. So "read" is served from what this node has
 * ingested over time: an append-only JSONL log (`messages.jsonl`) under
 * WECHAT_DATA_DIR, mirrored in memory for query. Schema + behaviour mirror the
 * WhatsApp store so the MCP surface is identical.
 *
 * Records are one of:
 *   - a message      (`__kind` absent) — inbound (from a WeChat user) or outbound
 *   - a status patch (`__kind:'status'`) — updates a message's send status
 *
 * Chats are derived on demand, keyed by the counterparty `external_userid`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { WECHAT_DATA_DIR } from './config';

export interface WeMessage {
  /** WeCom `msgid` for real messages; a synthetic `out-…` id if send returned none. */
  id: string;
  /** Counterparty external_userid — the "chat" this message belongs to. */
  chatId: string;
  direction: 'in' | 'out';
  /** external_userid of the sender ("me" for outbound). */
  from: string;
  /** external_userid of the recipient (set for outbound). */
  to?: string;
  /** Message type: text, image, voice, video, file, location, link, miniprogram, event, … */
  type: string;
  /** Body for text; a short marker for non-text payloads. */
  text?: string;
  /** Unix seconds. */
  timestamp: number;
  /** Outbound send status: sent | failed. */
  status?: string;
  /** Display name of the counterparty, when resolved via kf/customer/batchget. */
  contactName?: string;
  /** The 客服账号 (open_kfid) this conversation is served by. */
  openKfid?: string;
  /** Media id (image/voice/video/file) — resolve to bytes via kf media/get. */
  mediaId?: string;
}

export interface WeChat {
  chatId: string;
  name?: string;
  lastMessageAt: number;
  lastText?: string;
  lastDirection?: 'in' | 'out';
  messageCount: number;
  unreadCount: number;
  openKfid?: string;
}

interface StatusPatch {
  __kind: 'status';
  id: string;
  status: string;
  timestamp?: number;
}

const messagesFile = () => path.join(WECHAT_DATA_DIR, 'messages.jsonl');
const readStateFile = () => path.join(WECHAT_DATA_DIR, 'read-state.json');

let loaded = false;
let messages: WeMessage[] = [];
const byId = new Map<string, WeMessage>();
/** chatId -> unix seconds the operator has read up to. */
let readState: Record<string, number> = {};

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(messagesFile(), 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec: WeMessage | StatusPatch;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if ((rec as StatusPatch).__kind === 'status') {
        applyStatus(rec as StatusPatch);
      } else {
        upsertMessage(rec as WeMessage, false);
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

function upsertMessage(m: WeMessage, persist: boolean): boolean {
  const existing = byId.get(m.id);
  if (existing) {
    Object.assign(existing, { ...m, status: m.status ?? existing.status });
    return false;
  }
  byId.set(m.id, m);
  messages.push(m);
  if (persist) {
    appendLine(m);
    messages.sort((a, b) => a.timestamp - b.timestamp);
  }
  return true;
}

function applyStatus(p: StatusPatch): void {
  const m = byId.get(p.id);
  if (m) m.status = p.status;
}

function appendLine(rec: WeMessage | StatusPatch): void {
  fs.mkdirSync(WECHAT_DATA_DIR, { recursive: true });
  fs.appendFileSync(messagesFile(), JSON.stringify(rec) + '\n');
}

function persistReadState(): void {
  fs.mkdirSync(WECHAT_DATA_DIR, { recursive: true });
  fs.writeFileSync(readStateFile(), JSON.stringify(readState));
}

/** Record an inbound (received) message. Idempotent on `id`. Returns true if new. */
export function addInbound(m: WeMessage): boolean {
  ensureLoaded();
  return upsertMessage({ ...m, direction: 'in' }, true);
}

/** Record an outbound (sent) message. Idempotent on `id`. */
export function addOutbound(m: WeMessage): void {
  ensureLoaded();
  upsertMessage({ ...m, direction: 'out' }, true);
}

/** Update an outbound message's send status (sent/failed). */
export function recordStatus(id: string, status: string, timestamp?: number): void {
  ensureLoaded();
  const patch: StatusPatch = { __kind: 'status', id, status, timestamp };
  applyStatus(patch);
  appendLine(patch);
}

/** Set/refresh the display name for a counterparty across their messages. */
export function setContactName(chatId: string, name: string): void {
  ensureLoaded();
  if (!name) return;
  for (const m of messages) if (m.chatId === chatId) m.contactName = name;
}

/** Counterparties sorted by most-recent activity. */
export function listChats(limit = 30): WeChat[] {
  ensureLoaded();
  const chats = new Map<string, WeChat>();
  for (const m of messages) {
    let c = chats.get(m.chatId);
    if (!c) {
      c = { chatId: m.chatId, lastMessageAt: 0, messageCount: 0, unreadCount: 0 };
      chats.set(m.chatId, c);
    }
    c.messageCount++;
    if (m.contactName) c.name = m.contactName;
    if (m.openKfid) c.openKfid = m.openKfid;
    if (m.timestamp >= c.lastMessageAt) {
      c.lastMessageAt = m.timestamp;
      c.lastText = m.text;
      c.lastDirection = m.direction;
    }
    if (m.direction === 'in' && m.timestamp > (readState[m.chatId] || 0)) c.unreadCount++;
  }
  return [...chats.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt).slice(0, limit);
}

/** Resolve a user-supplied chat handle (external_userid or contact name) to a chatId. */
export function resolveChatId(handle: string): string {
  ensureLoaded();
  const h = handle.trim();
  if (byChatId(h)) return h;
  const lc = h.toLowerCase();
  const named = messages.find((m) => (m.contactName || '').toLowerCase() === lc);
  return named ? named.chatId : h;
}

function byChatId(chatId: string): boolean {
  return messages.some((m) => m.chatId === chatId);
}

/** Most-recent `limit` messages for a chat, returned in chronological order. */
export function getMessages(chatId: string, limit = 30): WeMessage[] {
  ensureLoaded();
  const all = messages.filter((m) => m.chatId === chatId);
  return all.slice(Math.max(0, all.length - limit));
}

/** Case-insensitive substring search across message text, most-recent first. */
export function search(query: string, limit = 20): WeMessage[] {
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
