/**
 * WhatsApp Connector Routes (provider-aware: Meta Cloud API ↔ local CDP).
 *
 * ONE local control + data surface that serves BOTH deployments, selected
 * per-node by `whatsappProvider()` (config.ts, default 'meta'):
 *
 *   - meta — the Meta WhatsApp Cloud API via the hub. The webhook pair receives
 *            inbound from Meta; send/media go through the hub relay. This is the
 *            SERVER deployment and the default.
 *   - cdp  — drive a logged-in WhatsApp Desktop / web.whatsapp.com session over
 *            the Chrome DevTools Protocol (cdp-client.ts) and mirror what it
 *            reads into the SHARED store. This is a LOCAL desktop node.
 *
 * Both providers back the SAME status / chats / messages / search / send / media
 * endpoints + the shared store (whatsapp/store.ts), so the MCP tools are
 * provider-agnostic (they just call `/whatsapp/*` on loopback).
 *
 *   GET    /whatsapp/webhook          Meta verification handshake (meta only)
 *   POST   /whatsapp/webhook          inbound messages + delivery receipts (meta only)
 *   GET    /whatsapp/status           provider + config/login state + ingested counts
 *   PUT    /whatsapp/config           set Cloud API credentials (never returns secrets)
 *   POST   /whatsapp/send             send a message (meta: text/template/media; cdp: text)
 *   GET    /whatsapp/media?id=        download an inbound media file (meta only)
 *   GET    /whatsapp/chats            list conversations
 *   GET    /whatsapp/messages?chat=   read a conversation's messages
 *   GET    /whatsapp/search?q=        substring search across message text
 *   POST   /whatsapp/login            launch WhatsApp Web + return login QR (cdp only)
 *   GET    /whatsapp/login/status     poll the login browser (cdp only)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RouteContext, RouteHandler, ParsedRequest } from '../index';
import {
  readWhatsappConfig,
  writeWhatsappConfig,
  graphVersion,
  whatsappProvider,
  WA_CONFIG_FILE,
  WA_DATA_DIR,
  CONFIG_FIELDS,
  type WhatsappConfig,
} from '../../whatsapp/config';
import * as store from '../../whatsapp/store';
import { hubConfigured, hubSend, hubGetMedia, type HubSendMedia } from '../../whatsapp/hub-api';
import { syncFromHub } from '../../whatsapp/sync';
import { verifyChallenge, verifySignature, ingestEvent } from '../../whatsapp/webhook';
import {
  cdpStatus,
  syncFromCdp,
  syncChat,
  sendText,
  getMedia as cdpGetMedia,
  canonicalChatId,
  WaError,
} from '../../whatsapp/cdp-client';
import { whatsappLogin, whatsappLoginStatus } from '../../whatsapp/login';

/** Best-effort MIME + WhatsApp media-type from a filename extension. */
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.amr': 'audio/amr', '.aac': 'audio/aac',
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
};
function mimeForFile(file: string): string {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream';
}
function mediaTypeForMime(mime: string): 'image' | 'audio' | 'video' | 'document' | 'sticker' {
  if (mime.startsWith('image/')) return mime === 'image/webp' ? 'sticker' : 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}
function extForMime(mime: string): string {
  const hit = Object.entries(MIME_BY_EXT).find(([, v]) => v === mime);
  return hit ? hit[0] : '';
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Digits-only phone (Cloud API rejects "+", spaces, dashes). */
function normalizePhone(v: unknown): string {
  return String(v ?? '').replace(/[^\d]/g, '');
}

/** Map a thrown CDP error to the structured { success:false, error } envelope. */
function fail(e: unknown): { success: false; error: string; code?: string } {
  if (e instanceof WaError) return { success: false, error: e.message, code: e.code };
  return { success: false, error: e instanceof Error ? e.message : String(e) };
}

/** Uniform "this endpoint needs the CDP provider" rejection under meta. */
function cdpOnly(what: string): { success: false; error: string; code: string } {
  return {
    success: false,
    error: `WhatsApp ${what} is for the CDP/local-desktop provider; set WHATSAPP_PROVIDER=cdp to use it.`,
    code: 'WRONG_PROVIDER',
  };
}

export function createWhatsappRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /whatsapp/webhook — Meta verification handshake. MUST echo the raw
    // challenge as text/plain, else Meta refuses to register the webhook.
    // (Meta-only; inert under cdp because Meta never calls it there.)
    {
      method: 'GET',
      pattern: /^\/whatsapp\/webhook$/,
      handler: async (req: ParsedRequest) => {
        const r = verifyChallenge((req.query as Record<string, string>) || {});
        if (r.ok) return { success: true, raw: true, data: r.challenge || '' };
        return { success: false, raw: true, data: 'forbidden' };
      },
    },

    // POST /whatsapp/webhook — inbound events, authenticated by HMAC signature.
    {
      method: 'POST',
      pattern: /^\/whatsapp\/webhook$/,
      handler: async (req: ParsedRequest) => {
        const sig = req.headers?.['x-hub-signature-256'];
        const sigStr = Array.isArray(sig) ? sig[0] : sig;
        if (!verifySignature(req.rawBody || '', sigStr)) {
          return { success: false, error: 'Invalid webhook signature' };
        }
        const result = ingestEvent(req.body || {});
        return { success: true, data: result };
      },
    },

    // GET /whatsapp/status — provider-aware view of config/login + store counts.
    {
      method: 'GET',
      pattern: /^\/whatsapp\/status$/,
      handler: async () => {
        if (whatsappProvider() === 'cdp') {
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
              provider: 'cdp',
              location: 'local',
              host: os.hostname(),
              backend: 'cdp-desktop',
              self,
              loggedIn,
              ...store.stats(),
            },
          };
        }
        // meta
        const cfg = readWhatsappConfig();
        // Best-effort catch-up so the reported counts reflect the hub's store.
        await syncFromHub();
        return {
          success: true,
          data: {
            provider: 'meta',
            location: 'server',
            backend: 'hub',
            // The hub owns the Meta credentials + send/receive; this connector is
            // "configured" as long as it can reach the hub.
            configured: hubConfigured(),
            hubConfigured: hubConfigured(),
            displayPhoneNumber: cfg.displayPhoneNumber || null,
            businessAccountId: cfg.businessAccountId || null,
            graphApiVersion: graphVersion(cfg),
            ...store.stats(),
          },
        };
      },
    },

    // PUT /whatsapp/config — set credentials. Echoes only which fields are set.
    // (Meta credentials; unused under cdp but harmless to store.)
    {
      method: 'PUT',
      pattern: /^\/whatsapp\/config$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const patch: Partial<WhatsappConfig> = {};
        for (const k of CONFIG_FIELDS) {
          if (body[k] !== undefined && body[k] !== null) {
            (patch as Record<string, string>)[k] = String(body[k]);
          }
        }
        if (Object.keys(patch).length === 0) {
          return { success: false, error: `No recognized fields. Allowed: ${CONFIG_FIELDS.join(', ')}` };
        }
        const next = writeWhatsappConfig(patch);
        return {
          success: true,
          data: {
            configured: Boolean(next.phoneNumberId && next.accessToken),
            savedTo: WA_CONFIG_FILE,
            set: {
              phoneNumberId: Boolean(next.phoneNumberId),
              accessToken: Boolean(next.accessToken),
              businessAccountId: Boolean(next.businessAccountId),
              verifyToken: Boolean(next.verifyToken),
              appSecret: Boolean(next.appSecret),
            },
          },
        };
      },
    },

    // POST /whatsapp/send — { to, text?, template?, media?, previewUrl? }
    //   meta: text (24h) / template / media via the hub.
    //   cdp:  text only (template/media UNSUPPORTED).
    {
      method: 'POST',
      pattern: /^\/whatsapp\/send$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, any>;

        if (whatsappProvider() === 'cdp') {
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
        }

        // meta
        const to = normalizePhone(body.to);
        if (!to) {
          return { success: false, error: '`to` (recipient phone, international format) is required' };
        }
        if (!body.text && !body.template && !body.media) {
          return { success: false, error: '`text`, `template`, or `media` is required' };
        }
        if (!hubConfigured()) {
          return { success: false, error: 'Hub not configured — WhatsApp send is performed by the hub (run `lm-assist setup`).' };
        }
        try {
          const template = body.template
            ? {
                name: String(body.template.name),
                languageCode: body.template.languageCode ? String(body.template.languageCode) : undefined,
                components: Array.isArray(body.template.components) ? body.template.components : undefined,
              }
            : undefined;
          const text = body.text !== undefined ? String(body.text) : undefined;

          // Media: a local file `path` on this node is read + base64-encoded so the
          // hub uploads it; a `link`/`id` is passed straight through.
          let media: HubSendMedia | undefined;
          let mediaMarker = '';
          if (body.media && typeof body.media === 'object') {
            const m = body.media as Record<string, any>;
            if (m.path) {
              const file = String(m.path);
              let buf: Buffer;
              try {
                buf = fs.readFileSync(file);
              } catch {
                return { success: false, error: `media file not readable: ${file}` };
              }
              const mime = m.mime ? String(m.mime) : mimeForFile(file);
              media = {
                type: m.type ? String(m.type) : mediaTypeForMime(mime),
                dataBase64: buf.toString('base64'),
                mime,
                filename: m.filename ? String(m.filename) : path.basename(file),
                caption: m.caption ? String(m.caption) : undefined,
                voice: m.voice === true,
              };
            } else {
              media = {
                type: String(m.type || ''),
                link: m.link ? String(m.link) : undefined,
                id: m.id ? String(m.id) : undefined,
                dataBase64: m.dataBase64 ? String(m.dataBase64) : undefined,
                mime: m.mime ? String(m.mime) : undefined,
                filename: m.filename ? String(m.filename) : undefined,
                caption: m.caption ? String(m.caption) : undefined,
                voice: m.voice === true,
              };
            }
            if (!media.type) return { success: false, error: '`media.type` is required (image|audio|video|document|sticker)' };
            mediaMarker = `[${media.type}${media.filename ? ' ' + media.filename : ''}]`;
          }

          // The hub owns the Meta credentials and performs the Graph API call +
          // durable persistence. We hold no token; we just call the hub.
          const { messageId } = await hubSend({ to, text, template, media, previewUrl: Boolean(body.previewUrl) });

          // Reflect the send in the local cache immediately (idempotent by id with
          // the copy we will later pull from the hub).
          const ts = Math.floor(Date.now() / 1000);
          store.addOutbound({
            id: messageId || `out-${ts}-${to}`,
            chatId: to,
            direction: 'out',
            from: 'me',
            to,
            type: media ? media.type : template ? 'template' : 'text',
            text: media ? (media.caption || mediaMarker) : text ?? (template ? `[template ${template!.name}]` : ''),
            timestamp: ts,
            status: 'sent',
          });
          return { success: true, data: { messageId, to } };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },

    // GET /whatsapp/media?id=<mediaId> — download an inbound media file's bytes.
    //   meta: the hub resolves the id against Meta and streams them; saved under
    //         WA_DATA_DIR/media, returns the local path.
    //   cdp:  UNSUPPORTED (WhatsApp Web serves media as blob: URLs — follow-up).
    {
      method: 'GET',
      pattern: /^\/whatsapp\/media$/,
      handler: async (req: ParsedRequest) => {
        const id = String(req.query?.id || '').trim();
        if (!id) return { success: false, error: '`id` query param (media id) is required' };
        if (whatsappProvider() === 'cdp') {
          try {
            await cdpGetMedia(id);
            return { success: true, data: {} };
          } catch (e) {
            return fail(e);
          }
        }
        // meta
        if (!hubConfigured()) {
          return { success: false, error: 'Hub not configured — media is fetched via the hub.' };
        }
        try {
          const { buffer, mime } = await hubGetMedia(id);
          const dir = path.join(WA_DATA_DIR, 'media');
          fs.mkdirSync(dir, { recursive: true });
          const safeId = id.replace(/[^A-Za-z0-9_.-]/g, '_');
          const file = path.join(dir, `${safeId}${extForMime(mime)}`);
          fs.writeFileSync(file, buffer);
          return { success: true, data: { id, mime, bytes: buffer.length, path: file } };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },

    // GET /whatsapp/chats?limit= — sync (provider), then list conversations.
    {
      method: 'GET',
      pattern: /^\/whatsapp\/chats$/,
      handler: async (req: ParsedRequest) => {
        const limit = clampInt(req.query?.limit, 30, 1, 200);
        if (whatsappProvider() === 'cdp') {
          try {
            await syncFromCdp();
          } catch (e) {
            return fail(e);
          }
          return { success: true, data: { chats: store.listChats(limit) } };
        }
        // meta — pull anything the hub stored while we were offline before answering.
        await syncFromHub();
        return { success: true, data: { chats: store.listChats(limit) } };
      },
    },

    // GET /whatsapp/messages?chat=&limit=&markRead= — sync the conversation
    //   (provider) then read it. meta keys by phone; cdp by canonical chat id
    //   (contact/group name or phone).
    {
      method: 'GET',
      pattern: /^\/whatsapp\/messages$/,
      handler: async (req: ParsedRequest) => {
        const limit = clampInt(req.query?.limit, 30, 1, 500);
        if (whatsappProvider() === 'cdp') {
          const rawChat = String(req.query?.chat || '').trim();
          if (!rawChat) return { success: false, error: '`chat` query param (contact/group or phone) is required' };
          const chatId = canonicalChatId(rawChat);
          try {
            await syncChat(rawChat);
          } catch (e) {
            return fail(e);
          }
          const messages = store.getMessages(chatId, limit);
          if (req.query?.markRead === 'true') store.markChatRead(chatId);
          return { success: true, data: { chatId, messages } };
        }
        // meta
        const chat = normalizePhone(req.query?.chat);
        if (!chat) {
          return { success: false, error: '`chat` query param (counterparty phone) is required' };
        }
        await syncFromHub();
        const messages = store.getMessages(chat, limit);
        if (req.query?.markRead === 'true') store.markChatRead(chat);
        return { success: true, data: { chatId: chat, messages } };
      },
    },

    // GET /whatsapp/search?q=&limit= — best-effort provider sync, then search
    // the ingested/cached store.
    {
      method: 'GET',
      pattern: /^\/whatsapp\/search$/,
      handler: async (req: ParsedRequest) => {
        const q = String(req.query?.q || '').trim();
        if (!q) return { success: false, error: '`q` query param is required' };
        const limit = clampInt(req.query?.limit, 20, 1, 100);
        if (whatsappProvider() === 'cdp') {
          // Best-effort catch-up; a down desktop must not block searching cache.
          try {
            await syncFromCdp();
          } catch {
            /* ignore — search over what is already ingested */
          }
        } else {
          await syncFromHub();
        }
        return { success: true, data: { query: q, results: store.search(q, limit) } };
      },
    },

    // POST /whatsapp/login — cdp only. Launch a controlled Chrome at
    //   web.whatsapp.com and return the login QR (linked-device pairing). Body:
    //   { port?, headless?, profile? }. On Windows the native WhatsApp app owns
    //   9222 — pass a different port. Returns { pid, port, cdpUrl, loggedIn,
    //   qr?: { dataUrl, savedPath, capturedAt } }.
    {
      method: 'POST',
      pattern: /^\/whatsapp\/login$/,
      handler: async (req: ParsedRequest) => {
        if (whatsappProvider() !== 'cdp') return cdpOnly('login');
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

    // GET /whatsapp/login/status?port= — cdp only. Poll the login browser.
    //   Returns { loggedIn, qr? } — `loggedIn` flips true after the user scans;
    //   while pending it refreshes the QR (WhatsApp rotates it ~every 20s).
    {
      method: 'GET',
      pattern: /^\/whatsapp\/login\/status$/,
      handler: async (req: ParsedRequest) => {
        if (whatsappProvider() !== 'cdp') return cdpOnly('login status');
        const port = req.query?.port ? clampInt(req.query.port, 9222, 1, 65535) : undefined;
        const res = await whatsappLoginStatus({ port });
        if ('ok' in res && res.ok === false) {
          return { success: false, error: res.message, code: res.code, hint: res.hint };
        }
        return { success: true, data: res };
      },
    },
  ];
}
