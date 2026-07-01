/**
 * Hub → local pull-sync for WhatsApp.
 *
 * The hub is the durable source of truth. This connector keeps a LOCAL cache
 * (store.ts) that is fed two ways:
 *   1. live push — the hub relays inbound events to /whatsapp/webhook (fast path)
 *   2. pull      — this module fetches GET /api/whatsapp/history to catch up on
 *                  anything missed while the connector was offline (durable path)
 *
 * Both paths converge in store.ts, which dedups by message id, so pulling an
 * already-live-pushed message is a harmless no-op. A tiny cursor file records
 * how far we have pulled so each sync only fetches new records.
 *
 * Nothing here throws to the caller: a hub outage just leaves the local cache
 * as-is (reads still work against whatever was already cached).
 */

import * as fs from 'fs';
import * as path from 'path';
import { WA_DATA_DIR } from './config';
import { hubConfigured, hubHistory, type HubHistoryEvent } from './hub-api';
import { ingestEvent, extractText } from './webhook';
import * as store from './store';

const cursorFile = () => path.join(WA_DATA_DIR, 'hub-cursor.json');

function readCursor(): number {
  try {
    const j = JSON.parse(fs.readFileSync(cursorFile(), 'utf-8')) as { cursor?: number };
    return typeof j.cursor === 'number' ? j.cursor : 0;
  } catch {
    return 0;
  }
}

function writeCursor(cursor: number): void {
  try {
    fs.mkdirSync(WA_DATA_DIR, { recursive: true });
    fs.writeFileSync(cursorFile(), JSON.stringify({ cursor }));
  } catch {
    /* cursor is an optimization; losing it only re-pulls (dedup makes that safe) */
  }
}

/** Ingest ONE outbound stored event into the local cache with correct direction. */
function ingestOutbound(ev: HubHistoryEvent): void {
  const value = ev.payload?.entry?.[0]?.changes?.[0]?.value;
  const m = value?.messages?.[0];
  if (!m?.id) return;
  const ts = Number(m.timestamp) || Math.floor(ev.receivedAt / 1000);
  store.addOutbound({
    id: String(m.id),
    chatId: ev.chatId,
    direction: 'out',
    from: 'me',
    to: ev.chatId,
    type: String(m.type || 'text'),
    text: extractText(m),
    timestamp: ts,
    status: 'sent',
  });
}

let inFlight: Promise<{ pulled: number; cursor: number }> | null = null;

/**
 * Pull new records from the hub into the local cache. Coalesces concurrent
 * callers (one network round-trip serves a burst of reads). Never throws.
 */
export async function syncFromHub(opts: { chat?: string; force?: boolean } = {}): Promise<{ pulled: number; cursor: number }> {
  if (!hubConfigured()) return { pulled: 0, cursor: readCursor() };
  if (inFlight && !opts.force) return inFlight;

  inFlight = (async () => {
    const since = readCursor();
    try {
      const { events, cursor } = await hubHistory(since, opts.chat, 2000);
      let pulled = 0;
      for (const ev of events) {
        if (ev.direction === 'out') {
          ingestOutbound(ev);
        } else {
          // Inbound: reuse the webhook ingest (handles contacts/name/media/text).
          ingestEvent(ev.payload);
        }
        pulled++;
      }
      // Only advance the cursor on a full (unfiltered) sync — a chat-scoped pull
      // must not skip other chats' newer records.
      if (!opts.chat && cursor > since) writeCursor(cursor);
      return { pulled, cursor: opts.chat ? since : cursor };
    } catch {
      // Hub unreachable / transient — keep the cache and cursor as-is.
      return { pulled: 0, cursor: since };
    }
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
