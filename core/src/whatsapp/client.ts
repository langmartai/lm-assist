/**
 * WhatsApp Cloud API client — the outbound (send) half of the connector.
 *
 * Talks to the Meta Graph API `POST /{phoneNumberId}/messages`. Two message
 * shapes are supported:
 *   - text     — free-form; only deliverable INSIDE a 24h customer-service
 *                window (i.e. the user messaged the business in the last 24h).
 *   - template — a pre-approved template; deliverable ANY time, and the only
 *                way to open a new conversation.
 *
 * Outbound HTTPS goes through the environment's agent proxy automatically
 * (global fetch honors HTTPS_PROXY), so no special handling is needed here.
 */

import { readWhatsappConfig, graphVersion, isConfigured } from './config';

const GRAPH_BASE = 'https://graph.facebook.com';

export interface SendTemplate {
  name: string;
  /** BCP-47 language code Meta expects for the template, e.g. "en_US". */
  languageCode?: string;
  /** Optional template components (header/body/button parameters). */
  components?: unknown[];
}

export interface SendResult {
  messageId: string;
  raw: unknown;
}

/** Send a text or template message. Throws with the Graph API error on failure. */
export async function sendMessage(opts: {
  to: string;
  text?: string;
  template?: SendTemplate;
  previewUrl?: boolean;
}): Promise<SendResult> {
  const cfg = readWhatsappConfig();
  if (!isConfigured(cfg)) {
    throw new Error(
      'WhatsApp not configured — set phoneNumberId + accessToken via PUT /whatsapp/config first.',
    );
  }

  let payload: Record<string, unknown>;
  if (opts.template) {
    payload = {
      messaging_product: 'whatsapp',
      to: opts.to,
      type: 'template',
      template: {
        name: opts.template.name,
        language: { code: opts.template.languageCode || 'en_US' },
        ...(opts.template.components ? { components: opts.template.components } : {}),
      },
    };
  } else {
    if (!opts.text) throw new Error('Either `text` or `template` is required.');
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: opts.to,
      type: 'text',
      text: { body: opts.text, preview_url: opts.previewUrl ?? false },
    };
  }

  const url = `${GRAPH_BASE}/${graphVersion(cfg)}/${cfg.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });

  const json = (await res.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
    error?: { message?: string; code?: number; error_data?: { details?: string } };
  };

  if (!res.ok || json.error) {
    const e = json.error;
    const detail = e?.error_data?.details ? ` (${e.error_data.details})` : '';
    throw new Error(e?.message ? `${e.message}${detail}` : `Graph API returned ${res.status}`);
  }

  return { messageId: json.messages?.[0]?.id || '', raw: json };
}

/** Mark an inbound message as read (blue ticks) — best-effort, never throws. */
export async function markMessageRead(messageId: string): Promise<void> {
  const cfg = readWhatsappConfig();
  if (!isConfigured(cfg)) return;
  const url = `${GRAPH_BASE}/${graphVersion(cfg)}/${cfg.phoneNumberId}/messages`;
  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => {
    /* read receipts are non-critical */
  });
}
