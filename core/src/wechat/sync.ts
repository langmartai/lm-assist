/**
 * WeChat (WeCom 微信客服) ingest orchestration.
 *
 * The callback tells us "new messages exist" (+ a short-lived pull token); this
 * module does the actual pull: it walks `kf/sync_msg` from the persisted cursor
 * until `has_more` is 0, normalizes each WeCom message into the shared store
 * schema, and resolves counterparty display names. The cursor is persisted to
 * `sync-state.json` so restarts resume where they left off.
 */

import * as fs from 'fs';
import * as path from 'path';
import { WECHAT_DATA_DIR, readWechatConfig } from './config';
import * as store from './store';
import { syncMsg, batchGetCustomers, type KfMsgItem } from './client';

const syncStateFile = () => path.join(WECHAT_DATA_DIR, 'sync-state.json');

interface SyncState {
  cursor?: string;
}

function readSyncState(): SyncState {
  try {
    return JSON.parse(fs.readFileSync(syncStateFile(), 'utf-8')) as SyncState;
  } catch {
    return {};
  }
}

function writeSyncState(s: SyncState): void {
  fs.mkdirSync(WECHAT_DATA_DIR, { recursive: true });
  fs.writeFileSync(syncStateFile(), JSON.stringify(s));
}

/** Short human marker for a non-text payload so listings/search stay useful. */
function payloadText(item: KfMsgItem): { type: string; text?: string; mediaId?: string } {
  switch (item.msgtype) {
    case 'text':
      return { type: 'text', text: item.text?.content || '' };
    case 'image':
      return { type: 'image', text: '[image]', mediaId: item.image?.media_id };
    case 'voice':
      return { type: 'voice', text: '[voice]', mediaId: item.voice?.media_id };
    case 'video':
      return { type: 'video', text: '[video]', mediaId: item.video?.media_id };
    case 'file':
      return { type: 'file', text: '[file]', mediaId: item.file?.media_id };
    case 'location':
      return { type: 'location', text: `[location] ${item.location?.name || ''}`.trim() };
    case 'link':
      return { type: 'link', text: `[link] ${item.link?.title || item.link?.url || ''}`.trim() };
    case 'miniprogram':
      return { type: 'miniprogram', text: '[mini program]' };
    case 'event':
      return { type: 'event', text: `[event] ${item.event?.event_type || ''}`.trim() };
    default:
      return { type: item.msgtype || 'unknown', text: `[${item.msgtype || 'unknown'}]` };
  }
}

/** Normalize a WeCom 微信客服 message into the store's WeMessage, or null to skip. */
function normalize(item: KfMsgItem): store.WeMessage | null {
  const chatId = item.external_userid;
  if (!chatId) return null; // no counterparty to attribute (rare system events)
  const isInbound = (item.origin ?? 3) === 3; // 3=user; 4=system, 5=servicer are outbound-side
  const { type, text, mediaId } = payloadText(item);
  return {
    id: item.msgid,
    chatId,
    direction: isInbound ? 'in' : 'out',
    from: isInbound ? chatId : item.servicer_userid || 'me',
    to: isInbound ? undefined : chatId,
    type,
    text,
    timestamp: item.send_time || Math.floor(Date.now() / 1000),
    openKfid: item.open_kfid,
    mediaId,
  };
}

/**
 * Pull all pending 微信客服 messages, normalize + persist them, and resolve any
 * new counterparties' names. `token` is the callback push token (recommended).
 * Returns the number of newly-ingested inbound messages.
 */
export async function ingest(token?: string): Promise<{ ingested: number; newContacts: number }> {
  const state = readSyncState();
  let cursor = state.cursor;
  let ingested = 0;
  const freshUsers = new Set<string>();

  // Bound the loop so a runaway has_more can't spin forever.
  for (let page = 0; page < 100; page++) {
    const res = await syncMsg({ cursor, token: page === 0 ? token : undefined });
    const list = res.msg_list || [];
    for (const item of list) {
      const m = normalize(item);
      if (!m) continue;
      if (m.direction === 'in') {
        const isNew = store.addInbound(m);
        if (isNew) {
          ingested++;
          if (!store.listChats(Number.MAX_SAFE_INTEGER).find((c) => c.chatId === m.chatId && c.name)) {
            freshUsers.add(m.chatId);
          }
        }
      } else {
        store.addOutbound(m);
      }
    }
    if (res.next_cursor) {
      cursor = res.next_cursor;
      writeSyncState({ cursor });
    }
    if (!res.has_more) break;
  }

  // Resolve display names for counterparties we don't have a name for yet.
  let newContacts = 0;
  const toResolve = [...freshUsers];
  for (let i = 0; i < toResolve.length; i += 100) {
    try {
      const customers = await batchGetCustomers(toResolve.slice(i, i + 100));
      for (const c of customers) {
        if (c.nickname) {
          store.setContactName(c.external_userid, c.nickname);
          newContacts++;
        }
      }
    } catch {
      /* name resolution is best-effort; ingest already succeeded */
    }
  }

  return { ingested, newContacts };
}

/** Resolve the effective default 客服账号 for sending, if one is pinned in config. */
export function defaultOpenKfid(): string | undefined {
  return readWechatConfig().openKfid;
}
