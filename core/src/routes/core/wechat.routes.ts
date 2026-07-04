/**
 * WeChat Connector Routes (WeCom 微信客服 backend).
 *
 * The official, business-verified way to read + respond to real WeChat users.
 * Data surface mirrors the WhatsApp connector (status/chats/messages/search/
 * send/media) plus a WeCom callback webhook and a config setter.
 *
 *   GET  /wechat/webhook             callback URL verification (echostr) — WeCom setup
 *   POST /wechat/webhook             encrypted message push → triggers an ingest pull
 *   GET  /wechat/status              configured/webhook state + 客服账号 + ingested counts
 *   GET  /wechat/chats?limit=        list conversations (by external_userid)
 *   GET  /wechat/messages?chat=      read a conversation (markRead optional)
 *   GET  /wechat/search?q=           substring search over ingested messages
 *   POST /wechat/send                { to, text } — reply within the 48h service window
 *   GET  /wechat/media?id=           download inbound media (base64)
 *   PUT  /wechat/config              set corpId / kfSecret / callbackToken / encodingAesKey
 *
 * The webhook GET/POST return RAW text (WeCom requires the plaintext echostr on
 * verify and a bare 200 on push), via the rest-server `{ raw:true }` envelope.
 */

import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import * as os from 'os';
import {
  readWechatConfig,
  writeWechatConfig,
  isConfigured,
  isWebhookConfigured,
  CONFIG_FIELDS,
  type WechatConfig,
} from '../../wechat/config';
import * as store from '../../wechat/store';
import { verifySignature, decrypt, extractEncrypt, xmlField, WechatCryptoError } from '../../wechat/crypto';
import { ingest, defaultOpenKfid } from '../../wechat/sync';
import { sendText, listKfAccounts, getMedia, WeError } from '../../wechat/client';

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function fail(e: unknown): { success: false; error: string; code?: string } {
  if (e instanceof WeError || e instanceof WechatCryptoError) return { success: false, error: e.message, code: e.code };
  return { success: false, error: e instanceof Error ? e.message : String(e) };
}

/** Raw text response envelope understood by rest-server. */
function rawText(text: string, success = true) {
  return { raw: true, success, data: text };
}

export function createWechatRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /wechat/webhook — WeCom callback URL verification. Verify the signature
    // over echostr, decrypt it, and echo back the plaintext. Query params:
    // msg_signature, timestamp, nonce, echostr.
    {
      method: 'GET',
      pattern: /^\/wechat\/webhook$/,
      handler: async (req: ParsedRequest) => {
        const cfg = readWechatConfig();
        const { msg_signature, timestamp, nonce, echostr } = (req.query || {}) as Record<string, string>;
        if (!isWebhookConfigured(cfg)) return rawText('', false);
        if (!msg_signature || !timestamp || !nonce || !echostr) return rawText('', false);
        try {
          if (!verifySignature(cfg.callbackToken!, timestamp, nonce, echostr, msg_signature)) {
            return rawText('', false);
          }
          const { message } = decrypt(cfg.encodingAesKey!, echostr, cfg.corpId);
          return rawText(message);
        } catch {
          return rawText('', false);
        }
      },
    },

    // POST /wechat/webhook — encrypted message push. Verify + decrypt the XML,
    // pull the callback Token, and kick an async ingest. Ack with bare "success".
    {
      method: 'POST',
      pattern: /^\/wechat\/webhook$/,
      handler: async (req: ParsedRequest) => {
        const cfg = readWechatConfig();
        if (!isWebhookConfigured(cfg)) return rawText('', false);
        const { msg_signature, timestamp, nonce } = (req.query || {}) as Record<string, string>;
        const xml = (req.body && (req.body as { _raw?: string })._raw) || '';
        const encrypt = extractEncrypt(xml);
        if (!msg_signature || !timestamp || !nonce || !encrypt) return rawText('', false);
        try {
          if (!verifySignature(cfg.callbackToken!, timestamp, nonce, encrypt, msg_signature)) {
            return rawText('', false);
          }
          const { message } = decrypt(cfg.encodingAesKey!, encrypt, cfg.corpId);
          // 微信客服 push carries a short-lived Token; sync_msg pulls the content.
          const token = xmlField(message, 'Token') || undefined;
          // Fire-and-forget: WeCom expects a fast ack; the pull happens async.
          void ingest(token).catch(() => {
            /* logged by the store; next callback or a manual read will retry */
          });
          return rawText('success');
        } catch {
          // Still ack so WeCom doesn't hammer retries on a transient decrypt hiccup.
          return rawText('success');
        }
      },
    },

    // GET /wechat/status — configured + webhook state, 客服账号, ingested counts.
    {
      method: 'GET',
      pattern: /^\/wechat\/status$/,
      handler: async () => {
        const cfg = readWechatConfig();
        let accounts: Array<{ open_kfid: string; name?: string }> = [];
        let accountsError: string | undefined;
        if (isConfigured(cfg)) {
          try {
            accounts = await listKfAccounts();
          } catch (e) {
            accountsError = e instanceof Error ? e.message : String(e);
          }
        }
        return {
          success: true,
          data: {
            provider: 'wecom-kf',
            location: 'server',
            host: os.hostname(),
            backend: 'wecom-kf',
            configured: isConfigured(cfg),
            webhookConfigured: isWebhookConfigured(cfg),
            corpId: cfg.corpId || null,
            self: cfg.openKfid || (accounts[0]?.open_kfid ?? null),
            accounts: accounts.map((a) => ({ openKfid: a.open_kfid, name: a.name })),
            accountsError,
            ...store.stats(),
          },
        };
      },
    },

    // GET /wechat/chats?limit=
    {
      method: 'GET',
      pattern: /^\/wechat\/chats$/,
      handler: async (req: ParsedRequest) => {
        const limit = clampInt(req.query?.limit, 30, 1, 200);
        return { success: true, data: { chats: store.listChats(limit) } };
      },
    },

    // GET /wechat/messages?chat=&limit=&markRead=
    {
      method: 'GET',
      pattern: /^\/wechat\/messages$/,
      handler: async (req: ParsedRequest) => {
        const rawChat = String(req.query?.chat || '').trim();
        if (!rawChat) return { success: false, error: '`chat` query param (external_userid or contact name) is required' };
        const chatId = store.resolveChatId(rawChat);
        const limit = clampInt(req.query?.limit, 30, 1, 500);
        const messages = store.getMessages(chatId, limit);
        if (req.query?.markRead === 'true') store.markChatRead(chatId);
        return { success: true, data: { chatId, messages } };
      },
    },

    // GET /wechat/search?q=&limit=
    {
      method: 'GET',
      pattern: /^\/wechat\/search$/,
      handler: async (req: ParsedRequest) => {
        const q = String(req.query?.q || '').trim();
        if (!q) return { success: false, error: '`q` query param is required' };
        const limit = clampInt(req.query?.limit, 20, 1, 100);
        return { success: true, data: { query: q, results: store.search(q, limit) } };
      },
    },

    // POST /wechat/send — { to, text, openKfid? }. Reply within the 48h window.
    {
      method: 'POST',
      pattern: /^\/wechat\/send$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const to = String(body.to || '').trim();
        if (!to) return { success: false, error: '`to` (external_userid or contact name) is required' };
        if (body.template || body.media) {
          return { success: false, error: 'template/media send is not supported on 微信客服 (text only)', code: 'UNSUPPORTED' };
        }
        const text = body.text !== undefined ? String(body.text) : '';
        if (!text) return { success: false, error: '`text` is required' };

        const chatId = store.resolveChatId(to);
        // Resolve the serving 客服账号: explicit → the chat's known kfid → config default.
        let openKfid = body.openKfid ? String(body.openKfid) : undefined;
        if (!openKfid) {
          const chat = store.listChats(Number.MAX_SAFE_INTEGER).find((c) => c.chatId === chatId);
          openKfid = chat?.openKfid || defaultOpenKfid();
        }
        if (!openKfid) {
          return {
            success: false,
            error: 'no 客服账号 (open_kfid) known for this chat — pass `openKfid`, or pin one via PUT /wechat/config { openKfid }',
            code: 'NO_OPEN_KFID',
          };
        }
        try {
          const messageId = await sendText(chatId, openKfid, text);
          const ts = Math.floor(Date.now() / 1000);
          store.addOutbound({
            id: messageId || `out-${ts}-${Math.floor(Math.random() * 1e6)}`,
            chatId,
            direction: 'out',
            from: 'me',
            to: chatId,
            type: 'text',
            text,
            timestamp: ts,
            status: 'sent',
            openKfid,
          });
          return { success: true, data: { messageId, to: chatId } };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // GET /wechat/media?id= — download inbound media, return base64.
    {
      method: 'GET',
      pattern: /^\/wechat\/media$/,
      handler: async (req: ParsedRequest) => {
        const id = String(req.query?.id || '').trim();
        if (!id) return { success: false, error: '`id` query param (media id) is required' };
        try {
          const m = await getMedia(id);
          return {
            success: true,
            data: { id, mime: m.contentType, filename: m.filename, bytes: m.buffer.length, base64: m.buffer.toString('base64') },
          };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // PUT /wechat/config — set/patch credentials (corpId, kfSecret, callbackToken,
    // encodingAesKey, openKfid). Persisted 0600. Returns the effective config
    // with secrets masked.
    {
      method: 'PUT',
      pattern: /^\/wechat\/config$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const patch: Partial<WechatConfig> = {};
        for (const field of CONFIG_FIELDS) {
          if (body[field] !== undefined) patch[field] = String(body[field]);
        }
        if (Object.keys(patch).length === 0) {
          return { success: false, error: `no config fields provided (expected any of: ${CONFIG_FIELDS.join(', ')})` };
        }
        const cfg = writeWechatConfig(patch);
        const mask = (v?: string) => (v ? `${v.slice(0, 3)}…(${v.length})` : null);
        return {
          success: true,
          data: {
            corpId: cfg.corpId || null,
            kfSecret: mask(cfg.kfSecret),
            callbackToken: mask(cfg.callbackToken),
            encodingAesKey: mask(cfg.encodingAesKey),
            openKfid: cfg.openKfid || null,
            configured: isConfigured(cfg),
            webhookConfigured: isWebhookConfigured(cfg),
          },
        };
      },
    },
  ];
}
