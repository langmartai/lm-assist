/**
 * Hub-backed WhatsApp API client — the connector's link to the LangMart hub.
 *
 * The hub (`assist-api`) OWNS the WhatsApp integration: it holds the Meta Cloud
 * API credentials, verifies + persists every inbound event, and performs every
 * outbound send via the Graph API. This connector holds NO Meta credentials; it
 * simply USES the hub's owner-scoped `/api/whatsapp/*` endpoints:
 *
 *   POST /api/whatsapp/send             — send (hub calls Graph API)
 *   GET  /api/whatsapp/history?since=…  — pull durably-stored messages
 *
 * Auth is the connector's own hub API key (from `hub.json` / `hub-dev.json`),
 * sent as a Bearer token — the hub maps it to the platform-admin owner and its
 * `requireWhatsappOwner` guard authorizes access.
 */

import { getHubConfig, isHubConfigured } from '../hub-client/hub-config';

/** Convert the hub WebSocket URL to its HTTPS API origin. */
function hubHttpBase(): string | null {
  const { hubUrl } = getHubConfig();
  if (!hubUrl) return null;
  return hubUrl
    .replace(/^wss:\/\//i, 'https://')
    .replace(/^ws:\/\//i, 'http://')
    .replace(/\/+$/, '');
}

/** True when we have both a hub URL and an API key to reach the hub with. */
export function hubConfigured(): boolean {
  return isHubConfigured() && Boolean(hubHttpBase());
}

async function hubFetch(pathname: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const base = hubHttpBase();
  const { apiKey } = getHubConfig();
  if (!base || !apiKey) {
    throw new Error('Hub not configured — set hub URL + API key (lm-assist setup) before using WhatsApp.');
  }
  const { timeoutMs = 30000, headers, ...rest } = init;
  return fetch(`${base}${pathname}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(headers || {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export interface HubSendTemplate {
  name: string;
  languageCode?: string;
  components?: unknown[];
}

export interface HubSendMedia {
  /** image | audio | video | document | sticker (audio + voice:true = a voice note). */
  type: string;
  /** A hosted URL Meta can fetch. */
  link?: string;
  /** A previously-uploaded Meta media id. */
  id?: string;
  /** Inline bytes (base64) the hub uploads to Meta before sending. */
  dataBase64?: string;
  /** MIME type for an inline upload (e.g. "application/pdf", "audio/ogg"). */
  mime?: string;
  /** Filename shown for documents. */
  filename?: string;
  /** Caption for image/video/document. */
  caption?: string;
  /** Mark an audio message as a voice note. */
  voice?: boolean;
}

export interface HubSendResult {
  messageId: string;
  raw: unknown;
}

/** Ask the hub to send a text, template, or media message. Throws on failure. */
export async function hubSend(opts: {
  to: string;
  text?: string;
  template?: HubSendTemplate;
  media?: HubSendMedia;
  previewUrl?: boolean;
}): Promise<HubSendResult> {
  const body: Record<string, unknown> = { to: opts.to };
  if (opts.media) {
    body.media = opts.media;
  } else if (opts.template) {
    body.template = {
      name: opts.template.name,
      languageCode: opts.template.languageCode,
      ...(opts.template.components ? { components: opts.template.components } : {}),
    };
  } else {
    body.text = opts.text;
  }

  const res = await hubFetch('/api/whatsapp/send', { method: 'POST', body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as {
    messageId?: string;
    error?: unknown;
    meta?: { error?: { message?: string } };
    status?: number;
  };
  if (!res.ok || (json as any).error) {
    const metaMsg = json?.meta?.error?.message;
    const errStr = typeof (json as any).error === 'string' ? (json as any).error : JSON.stringify((json as any).error ?? {});
    throw new Error(metaMsg || `Hub send failed (${res.status}): ${errStr}`);
  }
  return { messageId: json.messageId || '', raw: json };
}

/** One durably-stored message record as returned by GET /api/whatsapp/history. */
export interface HubHistoryEvent {
  id: string;
  chatId: string;
  receivedAt: number;
  direction?: 'in' | 'out';
  /** A minimal, self-contained Meta webhook body wrapping exactly one message. */
  payload: any;
}

/** Pull messages the hub has stored since `sinceMs` (optionally one chat). */
export async function hubHistory(
  sinceMs = 0,
  chat?: string,
  limit = 2000,
): Promise<{ events: HubHistoryEvent[]; cursor: number }> {
  const qs = new URLSearchParams();
  qs.set('since', String(sinceMs));
  if (chat) qs.set('chat', chat);
  qs.set('limit', String(limit));
  const res = await hubFetch(`/api/whatsapp/history?${qs.toString()}`, { method: 'GET' });
  const json = (await res.json().catch(() => ({ events: [], cursor: sinceMs }))) as {
    events?: HubHistoryEvent[];
    cursor?: number;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(`Hub history failed (${res.status})${json?.error ? ': ' + json.error : ''}`);
  }
  return {
    events: Array.isArray(json.events) ? json.events : [],
    cursor: typeof json.cursor === 'number' ? json.cursor : sinceMs,
  };
}

/** Download an inbound media file's bytes from the hub (which resolves the id
 *  against Meta and streams the bytes). Throws on hub/Meta failure. */
export async function hubGetMedia(id: string): Promise<{ buffer: Buffer; mime: string }> {
  const res = await hubFetch(`/api/whatsapp/media/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { Accept: '*/*' },
    timeoutMs: 60000,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ': ' + JSON.stringify(await res.json());
    } catch {
      /* body not JSON */
    }
    throw new Error(`Hub media fetch failed (${res.status})${detail}`);
  }
  const mime = res.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mime };
}
