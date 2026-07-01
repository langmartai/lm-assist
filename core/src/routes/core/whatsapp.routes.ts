/**
 * WhatsApp Cloud API Connector Routes
 *
 * The local control + data surface for the WhatsApp connector. The webhook
 * pair receives from Meta (no lm-assist token — see the auth-exempt carve-out
 * in rest-server.ts); everything else is reached on loopback by the WhatsApp
 * MCP tools (and remotely through the hub relay, which adds `/whatsapp` to its
 * allow-list).
 *
 *   GET    /whatsapp/webhook          Meta verification handshake (echoes challenge)
 *   POST   /whatsapp/webhook          inbound messages + delivery receipts
 *   GET    /whatsapp/status           config presence + ingested counts
 *   PUT    /whatsapp/config           set Cloud API credentials (never returns secrets)
 *   POST   /whatsapp/send             send a text or template message
 *   GET    /whatsapp/chats            list conversations (by counterparty)
 *   GET    /whatsapp/messages?chat=   read a conversation's messages
 *   GET    /whatsapp/search?q=        substring search across message text
 */

import type { RouteContext, RouteHandler, ParsedRequest } from '../index';
import {
  readWhatsappConfig,
  writeWhatsappConfig,
  graphVersion,
  WA_CONFIG_FILE,
  CONFIG_FIELDS,
  type WhatsappConfig,
} from '../../whatsapp/config';
import * as store from '../../whatsapp/store';
import { hubConfigured, hubSend } from '../../whatsapp/hub-api';
import { syncFromHub } from '../../whatsapp/sync';
import { verifyChallenge, verifySignature, ingestEvent } from '../../whatsapp/webhook';

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Digits-only phone (Cloud API rejects "+", spaces, dashes). */
function normalizePhone(v: unknown): string {
  return String(v ?? '').replace(/[^\d]/g, '');
}

export function createWhatsappRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /whatsapp/webhook — Meta verification handshake. MUST echo the raw
    // challenge as text/plain, else Meta refuses to register the webhook.
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

    // GET /whatsapp/status — non-secret view of config + store counts.
    {
      method: 'GET',
      pattern: /^\/whatsapp\/status$/,
      handler: async () => {
        const cfg = readWhatsappConfig();
        // Best-effort catch-up so the reported counts reflect the hub's store.
        await syncFromHub();
        return {
          success: true,
          data: {
            // The hub owns the Meta credentials + send/receive; this connector is
            // "configured" as long as it can reach the hub.
            configured: hubConfigured(),
            backend: 'hub',
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

    // POST /whatsapp/send — { to, text? , template?, previewUrl? }
    {
      method: 'POST',
      pattern: /^\/whatsapp\/send$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, any>;
        const to = normalizePhone(body.to);
        if (!to) {
          return { success: false, error: '`to` (recipient phone, international format) is required' };
        }
        if (!body.text && !body.template) {
          return { success: false, error: '`text` or `template` is required' };
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
          // The hub owns the Meta credentials and performs the Graph API call +
          // durable persistence. We hold no token; we just call the hub.
          const { messageId } = await hubSend({ to, text, template, previewUrl: Boolean(body.previewUrl) });

          // Reflect the send in the local cache immediately (idempotent by id with
          // the copy we will later pull from the hub).
          const ts = Math.floor(Date.now() / 1000);
          store.addOutbound({
            id: messageId || `out-${ts}-${to}`,
            chatId: to,
            direction: 'out',
            from: 'me',
            to,
            type: template ? 'template' : 'text',
            text: text ?? (template ? `[template ${template.name}]` : ''),
            timestamp: ts,
            status: 'sent',
          });
          return { success: true, data: { messageId, to } };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },

    // GET /whatsapp/chats?limit=
    {
      method: 'GET',
      pattern: /^\/whatsapp\/chats$/,
      handler: async (req: ParsedRequest) => {
        const limit = clampInt(req.query?.limit, 30, 1, 200);
        // Pull anything the hub stored while we were offline before answering.
        await syncFromHub();
        return { success: true, data: { chats: store.listChats(limit) } };
      },
    },

    // GET /whatsapp/messages?chat=<phone>&limit=&markRead=true
    {
      method: 'GET',
      pattern: /^\/whatsapp\/messages$/,
      handler: async (req: ParsedRequest) => {
        const chat = normalizePhone(req.query?.chat);
        if (!chat) {
          return { success: false, error: '`chat` query param (counterparty phone) is required' };
        }
        const limit = clampInt(req.query?.limit, 30, 1, 500);
        await syncFromHub();
        const messages = store.getMessages(chat, limit);
        if (req.query?.markRead === 'true') store.markChatRead(chat);
        return { success: true, data: { chatId: chat, messages } };
      },
    },

    // GET /whatsapp/search?q=<text>&limit=
    {
      method: 'GET',
      pattern: /^\/whatsapp\/search$/,
      handler: async (req: ParsedRequest) => {
        const q = String(req.query?.q || '').trim();
        if (!q) return { success: false, error: '`q` query param is required' };
        const limit = clampInt(req.query?.limit, 20, 1, 100);
        await syncFromHub();
        return { success: true, data: { query: q, results: store.search(q, limit) } };
      },
    },
  ];
}
