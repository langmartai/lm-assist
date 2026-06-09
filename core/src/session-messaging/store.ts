/**
 * Persistent store for inbound session messages.
 *
 * Mirrors the style of prompt-queue-store.ts / other lm-assist json stores:
 * a single JSON file under ~/.lm-assist/, atomic write (.tmp + rename),
 * mtime-aware reload so concurrent processes (the MCP StreamableHTTP path and
 * the stdio path both run in the SAME core process, but the sweeper + a
 * separate stdio subprocess may also touch it) see each other's writes.
 *
 * Messages live on the node where the TARGET session is — that is the node the
 * send tool was routed to. Status + acks are stored here so get_message_status
 * (also node-routed to the message's node) can answer.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/path-utils';
import type {
  SessionMessage,
  MessageStatus,
  InjectionDriverName,
} from './types';

const STORE_FILE = path.join(getDataDir(), 'session-messages.json');
const STORE_TMP = STORE_FILE + '.tmp';

interface StoreShape {
  messages: SessionMessage[];
}

let cache: { mtimeMs: number; data: StoreShape } | null = null;

function emptyStore(): StoreShape {
  return { messages: [] };
}

/** Read the store, reloading from disk if the file changed since last cached. */
function load(): StoreShape {
  try {
    const stat = fs.statSync(STORE_FILE);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.data;
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    const data: StoreShape = { messages: Array.isArray(parsed.messages) ? parsed.messages : [] };
    cache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch {
    // Missing or corrupt file → empty store (do not cache a fabricated mtime).
    return cache?.data ?? emptyStore();
  }
}

/** Atomically persist the store and refresh the cache mtime. */
function persist(data: StoreShape): void {
  const dir = path.dirname(STORE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STORE_TMP, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(STORE_TMP, STORE_FILE);
  try {
    const stat = fs.statSync(STORE_FILE);
    cache = { mtimeMs: stat.mtimeMs, data };
  } catch {
    cache = null;
  }
}

/** Insert a new message record. */
export function insert(msg: SessionMessage): void {
  const data = load();
  data.messages.push(msg);
  persist(data);
}

/** Fetch a single message by id. */
export function get(id: string): SessionMessage | undefined {
  return load().messages.find((m) => m.id === id);
}

/** List messages, optionally filtered by target session and/or status. */
export function list(filter?: { session?: string; status?: MessageStatus }): SessionMessage[] {
  let msgs = load().messages;
  if (filter?.session) msgs = msgs.filter((m) => m.toSession === filter.session);
  if (filter?.status) msgs = msgs.filter((m) => m.status === filter.status);
  // newest first
  return [...msgs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Messages still awaiting delivery (the sweeper retries these). */
export function listPending(): SessionMessage[] {
  return load().messages.filter((m) => m.status === 'pending');
}

/**
 * Apply a status transition to a message: set its status, append an ack record,
 * and optionally record which driver delivered it. Returns the updated message
 * or undefined if the id is unknown.
 */
export function transition(
  id: string,
  status: MessageStatus,
  detail?: string,
  driver?: InjectionDriverName,
): SessionMessage | undefined {
  const data = load();
  const msg = data.messages.find((m) => m.id === id);
  if (!msg) return undefined;
  msg.status = status;
  if (driver) msg.driver = driver;
  msg.acks.push({ state: status, at: new Date().toISOString(), detail });
  persist(data);
  return msg;
}

/** Test/maintenance helper — wipe the store (used by unit tests). */
export function _clearAll(): void {
  persist(emptyStore());
}

/** Test helper — the on-disk path (so tests can point LM_ASSIST_DATA_DIR). */
export function _storeFile(): string {
  return STORE_FILE;
}
