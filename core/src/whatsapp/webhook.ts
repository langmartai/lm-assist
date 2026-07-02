/**
 * WhatsApp Cloud API webhook — the inbound (receive) half of the connector.
 *
 * Meta drives two requests at the webhook URL:
 *   GET  — a one-time verification handshake. Meta sends `hub.mode=subscribe`,
 *          `hub.verify_token`, `hub.challenge`; we echo the challenge back as
 *          plain text IFF the verify token matches our configured one.
 *   POST — message + status events. Authenticated by an `X-Hub-Signature-256`
 *          HMAC-SHA256 of the RAW request body, keyed by the app secret.
 *
 * The webhook is reached WITHOUT lm-assist's API token (Meta can't carry it),
 * so these two checks ARE the auth boundary — see the auth-exempt carve-out in
 * rest-server.ts.
 */

import * as crypto from 'crypto';
import { readWhatsappConfig } from './config';
import * as store from './store';

/** GET handshake. Returns the challenge to echo (text/plain) when valid. */
export function verifyChallenge(query: Record<string, string>): { ok: boolean; challenge?: string } {
  const cfg = readWhatsappConfig();
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && cfg.verifyToken && token === cfg.verifyToken) {
    return { ok: true, challenge };
  }
  return { ok: false };
}

/**
 * Constant-time verification of the POST body signature. Fails closed: with
 * no app secret configured, or no signature header on the request, the event
 * is rejected — the status endpoint separately surfaces `appSecretSet:false`
 * to nudge the operator to set it.
 */
export function verifySignature(rawBody: string, signatureHeader?: string): boolean {
  const cfg = readWhatsappConfig();
  if (!cfg.appSecret) return false;
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', cfg.appSecret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Pull a human-readable body out of any message type (inbound or outbound). */
export function extractText(m: Record<string, any>): string | undefined {
  switch (m.type) {
    case 'text':
      return m.text?.body;
    case 'image':
    case 'video':
    case 'document':
    case 'audio':
    case 'sticker':
      return m[m.type]?.caption || `[${m.type}]`;
    case 'location':
      return `[location ${m.location?.latitude},${m.location?.longitude}]`;
    case 'button':
      return m.button?.text;
    case 'interactive':
      return (
        m.interactive?.button_reply?.title ||
        m.interactive?.list_reply?.title ||
        '[interactive]'
      );
    case 'reaction':
      return `[reaction ${m.reaction?.emoji || ''}]`;
    case 'contacts':
      return '[contacts]';
    default:
      return m.type ? `[${m.type}]` : undefined;
  }
}

/** Media id for media message types, for later Graph-API URL resolution. */
function extractMediaId(m: Record<string, any>): string | undefined {
  for (const t of ['image', 'video', 'document', 'audio', 'sticker']) {
    if (m[t]?.id) return m[t].id as string;
  }
  return undefined;
}

/** Parse a webhook POST payload, persisting messages + status updates. */
export function ingestEvent(payload: any): { messages: number; statuses: number } {
  let messageCount = 0;
  let statusCount = 0;

  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};

      // Map wa_id -> profile name from the `contacts` block.
      const nameByWaId = new Map<string, string>();
      for (const c of value.contacts || []) {
        if (c?.wa_id) nameByWaId.set(c.wa_id, c?.profile?.name || '');
      }

      // Inbound messages.
      for (const m of value.messages || []) {
        const from = String(m.from || '');
        store.addInbound({
          id: String(m.id),
          chatId: from,
          direction: 'in',
          from,
          type: String(m.type || 'unknown'),
          text: extractText(m),
          timestamp: Number(m.timestamp) || Math.floor(Date.now() / 1000),
          contactName: nameByWaId.get(from) || undefined,
          mediaId: extractMediaId(m),
        });
        messageCount++;
      }

      // Outbound delivery receipts.
      for (const s of value.statuses || []) {
        if (!s?.id || !s?.status) continue;
        store.recordStatus(String(s.id), String(s.status), Number(s.timestamp) || undefined);
        statusCount++;
      }
    }
  }

  return { messages: messageCount, statuses: statusCount };
}
