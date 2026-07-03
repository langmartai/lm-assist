/**
 * WhatsApp Connector Routes (local / CDP deployment).
 *
 * Converged data surface with the SERVER (Meta Cloud API) deployment: the same
 * status / chats / messages / search / send / media endpoints, backed here by a
 * CDP provider (cdp-client.ts) that drives a logged-in WhatsApp Desktop / web
 * session and mirrors what it reads into the SHARED store (whatsapp/store.ts).
 *
 *   GET  /whatsapp/status            provider + logged-in state + ingested counts
 *   GET  /whatsapp/chats?limit=      list conversations (syncs the rendered list first)
 *   GET  /whatsapp/messages?chat=    read a conversation (opens + ingests it first)
 *   GET  /whatsapp/search?q=         substring search over ingested messages
 *   POST /whatsapp/send              { to, text } — open the chat + send; records outbound
 *   GET  /whatsapp/media?id=         media download (not yet supported on CDP)
 *
 * Reads come from what this node has INGESTED over time (WhatsApp Web
 * virtualizes the message list — only near-viewport rows exist), the local
 * analogue of the Cloud API's "no server-side history" constraint.
 */

import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import * as os from 'os';
import { whatsappProvider } from '../../whatsapp/config';
import * as store from '../../whatsapp/store';
import { cdpStatus, syncFromCdp, syncChat, sendText, getMedia, canonicalChatId, readChatOrder, WaError } from '../../whatsapp/cdp-client';
import { whatsappLogin, whatsappLoginStatus } from '../../whatsapp/login';

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Map a thrown error to the structured { success:false, error } envelope. */
function fail(e: unknown): { success: false; error: string; code?: string } {
  if (e instanceof WaError) return { success: false, error: e.message, code: e.code };
  return { success: false, error: e instanceof Error ? e.message : String(e) };
}

export function createWhatsappRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /whatsapp/status — provider + logged-in state + ingested counts.
    {
      method: 'GET',
      pattern: /^\/whatsapp\/status$/,
      handler: async () => {
        let loggedIn = false;
        let self: string | null = null;
        try {
          const s = await cdpStatus();
          loggedIn = s.loggedIn;
          self = s.self;
        } catch {
          /* CDP unreachable — report loggedIn:false but still return store stats */
        }
        return {
          success: true,
          data: {
            provider: whatsappProvider(),
            location: 'local',
            host: os.hostname(),
            backend: 'cdp-desktop',
            self,
            loggedIn,
            ...store.stats(),
          },
        };
      },
    },

    // GET /whatsapp/chats?limit= — sync the rendered list, then return chats in
    // the APP's own order (chat-order sidecar), with its unread badge counts.
    {
      method: 'GET',
      pattern: /^\/whatsapp\/chats$/,
      handler: async (req: ParsedRequest) => {
        const limit = clampInt(req.query?.limit, 30, 1, 200);
        try {
          await syncFromCdp();
        } catch (e) {
          return fail(e);
        }
        const chats = store.listChats(1000);
        const order = readChatOrder();
        const pos = new Map(order.map((o, i) => [o.chatId, i]));
        const meta = new Map(order.map((o) => [o.chatId, o]));
        for (const c of chats) {
          const m = meta.get(c.chatId);
          if (!m) continue;
          // The app's badge is authoritative for unread; its row time beats a
          // synthesized preview timestamp when it is newer.
          c.unreadCount = m.unread;
          c.lastDirection = m.lastDirection;
          if (m.lastMessageAt > (c.lastMessageAt || 0)) c.lastMessageAt = m.lastMessageAt;
        }
        chats.sort((a, b) => {
          const pa = pos.has(a.chatId) ? (pos.get(a.chatId) as number) : Number.MAX_SAFE_INTEGER;
          const pb = pos.has(b.chatId) ? (pos.get(b.chatId) as number) : Number.MAX_SAFE_INTEGER;
          if (pa !== pb) return pa - pb;
          return (b.lastMessageAt || 0) - (a.lastMessageAt || 0);
        });
        return { success: true, data: { chats: chats.slice(0, limit) } };
      },
    },

    // GET /whatsapp/messages?chat=&limit=&markRead= — open + ingest, then read.
    {
      method: 'GET',
      pattern: /^\/whatsapp\/messages$/,
      handler: async (req: ParsedRequest) => {
        const rawChat = String(req.query?.chat || '').trim();
        if (!rawChat) return { success: false, error: '`chat` query param (contact/group or phone) is required' };
        const chatId = canonicalChatId(rawChat);
        const limit = clampInt(req.query?.limit, 30, 1, 500);
        try {
          await syncChat(rawChat);
        } catch (e) {
          return fail(e);
        }
        let messages = store.getMessages(chatId, limit);
        // A message sent through this node exists twice: the synthetic record
        // written at send time and the DOM-ingested copy (different ids).
        // Collapse near-identical neighbours at read time, preferring the
        // DOM-ingested copy (its timestamp comes from the app).
        // DOM text carries invisible bidi-control marks — strip before comparing.
        const cleanText = (t?: string) => String(t || '').replace(/[‎‏‪-‮⁦-⁩]/g, '').trim();
        messages = messages.filter((m, i) => {
          const dup = messages.find(
            (o, j) =>
              j !== i &&
              o.direction === m.direction &&
              cleanText(o.text) === cleanText(m.text) &&
              Math.abs((o.timestamp || 0) - (m.timestamp || 0)) <= 180 &&
              o.id !== m.id,
          );
          if (!dup) return true;
          const mIsCdp = m.id.startsWith('cdp-');
          const dupIsCdp = dup.id.startsWith('cdp-');
          if (mIsCdp !== dupIsCdp) return mIsCdp; // keep the cdp copy
          return m.id < dup.id; // both same kind: keep a stable single one
        });
        if (req.query?.markRead === 'true') store.markChatRead(chatId);
        return { success: true, data: { chatId, messages } };
      },
    },

    // GET /whatsapp/search?q=&limit= — over ingested/cached messages.
    {
      method: 'GET',
      pattern: /^\/whatsapp\/search$/,
      handler: async (req: ParsedRequest) => {
        const q = String(req.query?.q || '').trim();
        if (!q) return { success: false, error: '`q` query param is required' };
        const limit = clampInt(req.query?.limit, 20, 1, 100);
        return { success: true, data: { query: q, results: store.search(q, limit) } };
      },
    },

    // POST /whatsapp/send — { to, text }. (template/media unsupported on CDP.)
    {
      method: 'POST',
      pattern: /^\/whatsapp\/send$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const to = String(body.to || '').trim();
        if (!to) return { success: false, error: '`to` (recipient contact/group or phone) is required' };
        if (body.template || body.media) {
          return {
            success: false,
            error: 'template/media send is not supported on the local CDP WhatsApp provider (text only)',
            code: 'UNSUPPORTED',
          };
        }
        const text = body.text !== undefined ? String(body.text) : '';
        if (!text) return { success: false, error: '`text` is required' };
        try {
          const { messageId, chatId, contactName } = await sendText(to, text);
          const ts = Math.floor(Date.now() / 1000);
          store.addOutbound({
            id: messageId,
            chatId,
            direction: 'out',
            from: 'me',
            to: chatId,
            type: 'text',
            text,
            timestamp: ts,
            status: 'sent',
            contactName: contactName || undefined,
          });
          return { success: true, data: { messageId, to: chatId } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /whatsapp/login — launch a controlled Chrome at web.whatsapp.com and
    //   return the login QR (linked-device pairing). Body: { port?, headless?,
    //   profile? }. The browser stays alive so the user can scan; close it later
    //   via POST /browser/close {pid}. On Windows the native WhatsApp app owns
    //   9222 — pass a different port. Returns { pid, port, cdpUrl, loggedIn,
    //   qr?: { dataUrl, savedPath, capturedAt } }.
    {
      method: 'POST',
      pattern: /^\/whatsapp\/login$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const port = typeof body.port === 'number' ? body.port : undefined;
        const headless = typeof body.headless === 'boolean' ? body.headless : undefined;
        const profile = typeof body.profile === 'string' ? body.profile : undefined;
        const res = await whatsappLogin({ port, headless, profile });
        if (!res.ok) {
          return { success: false, error: res.message, code: res.code, hint: res.hint, installedBrowsers: res.installedBrowsers };
        }
        return { success: true, data: res };
      },
    },

    // GET /whatsapp/login/status?port= — poll the login browser. Returns
    //   { loggedIn, qr? } — `loggedIn` flips true after the user scans; while
    //   pending it refreshes the QR (WhatsApp rotates it ~every 20s).
    {
      method: 'GET',
      pattern: /^\/whatsapp\/login\/status$/,
      handler: async (req: ParsedRequest) => {
        const port = req.query?.port ? clampInt(req.query.port, 9222, 1, 65535) : undefined;
        const res = await whatsappLoginStatus({ port });
        if ('ok' in res && res.ok === false) {
          return { success: false, error: res.message, code: res.code, hint: res.hint };
        }
        return { success: true, data: res };
      },
    },

    // GET /whatsapp/media?id= — not yet supported on the local CDP provider.
    {
      method: 'GET',
      pattern: /^\/whatsapp\/media$/,
      handler: async (req: ParsedRequest) => {
        const id = String(req.query?.id || '').trim();
        if (!id) return { success: false, error: '`id` query param (media id) is required' };
        try {
          await getMedia(id);
          return { success: true, data: {} };
        } catch (e) {
          return fail(e);
        }
      },
    },
  ];
}
