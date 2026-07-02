/**
 * WhatsApp connector MCP tools (converged — account/location aware).
 *
 * ONE MCP surface across both deployments:
 *   - LOCAL  — this node drives a logged-in WhatsApp Desktop / web session over
 *              CDP (the operator's OWN account) and mirrors it into the store.
 *   - SERVER — a node backed by the Meta WhatsApp Cloud API business number.
 *
 * The six tools + their params are IDENTICAL on both; only the backing provider
 * differs (resolved per-node). Each tool wraps this node's own `/whatsapp/*`
 * REST route on loopback (single source of truth), so the same behavior is
 * reachable from the stdio MCP, the HTTP `/mcp` endpoint, and remotely via the
 * hub relay.
 *
 * Backend reality the descriptions encode for the model:
 *   - Reads come from what THIS node has ingested/cached (on the local CDP
 *     provider, WhatsApp Web virtualizes the list — the most-recent RENDERED
 *     messages; on the server, messages received via webhook over time).
 *   - Local send is free-form text to any of the account's chats. Server send
 *     is free-form only within 24h of the recipient's last inbound; otherwise
 *     an approved template (template/media are server-only).
 *
 * Wiring: registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts)
 * and scoped in configure.ts TOOL_SCOPES.
 */

import { ok, err, workerGet, workerPost, workerPostRaw, type McpToolResult } from './_passthrough';

export const whatsappSendToolDef = {
  name: 'whatsapp_send',
  description:
    'Send a WhatsApp message from this node\'s WhatsApp account (account/location aware — a local ' +
    'desktop account driven over CDP, OR a server business number via the Meta Cloud API). ' +
    'Trigger words: "WhatsApp X", "send a WhatsApp to …", "text … on WhatsApp". Pass `to` ' +
    '(recipient — a contact/group name or phone in international format) and ONE of: `text` ' +
    '(free-form message body — always works on the local account; on the server only delivers ' +
    'within 24h of the recipient\'s last inbound), `template` (server business account only — a ' +
    'pre-approved template), or `media` (server business account only — a file/image/voice note). ' +
    'Returns the messageId. Write tool — confirm the recipient + content.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Recipient — a contact/group name, or a phone in international format e.g. "+14155551234".' },
      text: { type: 'string', description: 'Message body (free-form text). Use this OR `template`/`media`.' },
      template: {
        type: 'object',
        description: 'Server business account only — a pre-approved template message (sends any time).',
        properties: {
          name: { type: 'string', description: 'Approved template name.' },
          languageCode: { type: 'string', description: 'BCP-47 language code, e.g. "en_US" (default).' },
          components: { type: 'array', description: 'Optional header/body/button parameter components.', items: { type: 'object' } },
        },
        required: ['name'],
      },
      media: {
        type: 'object',
        description: 'Server business account only — send an attachment (image, video, document, sticker, or audio/voice note).',
        properties: {
          path: { type: 'string', description: 'Local file path on the node to send (type + mime inferred from the extension).' },
          link: { type: 'string', description: 'Public URL Meta can fetch (alternative to `path`).' },
          type: { type: 'string', description: 'image | audio | video | document | sticker. Inferred from `path` if omitted.' },
          caption: { type: 'string', description: 'Caption (image/video/document only).' },
          filename: { type: 'string', description: 'Filename shown for documents (defaults to the file\'s basename).' },
          voice: { type: 'boolean', description: 'For audio: send as a voice note (default false).' },
        },
      },
      previewUrl: { type: 'boolean', description: 'Render a link preview for URLs in `text` (default false).' },
    },
    required: ['to'],
  },
};

export const whatsappGetMediaToolDef = {
  name: 'whatsapp_get_media',
  description:
    'Download an inbound WhatsApp attachment (voice note, image, document, video) by its ' +
    'media id — the id shown as "media <id>" next to a `[audio]`/`[document]` message in ' +
    'whatsapp_read_messages. Saves the file on the node and returns the local path so you can ' +
    'open/transcribe it. Supported on the server (Meta) account; on the local desktop (CDP) ' +
    'account media download is a known follow-up and returns an unsupported error. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'The media id from an inbound message (whatsapp_read_messages).' },
    },
    required: ['id'],
  },
};

export const whatsappListChatsToolDef = {
  name: 'whatsapp_list_chats',
  description:
    'List this WhatsApp account\'s conversations (one per counterparty/group), most-recently-active ' +
    'first. Account/location aware — the local desktop account (over CDP) or the server business ' +
    'account (Meta). Trigger words: "my WhatsApp chats", "who messaged me on WhatsApp", "recent ' +
    'WhatsApp conversations". Each chat shows the counterparty (name and/or phone), last message ' +
    'preview, total + unread counts. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: { type: 'number', description: 'Max chats to return (default 30, max 200).' },
    },
  },
};

export const whatsappReadMessagesToolDef = {
  name: 'whatsapp_read_messages',
  description:
    'Read the messages of one WhatsApp conversation, in chronological order. Account/location ' +
    'aware (local desktop over CDP, or server Meta account). Trigger words: "read my WhatsApp ' +
    'with …", "show the WhatsApp thread from …", "what did X say on WhatsApp". Pass `chat` (the ' +
    'contact/group name or phone from whatsapp_list_chats). Optionally `markRead:true` to reset ' +
    'that chat\'s unread count. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      chat: { type: 'string', description: 'Contact/group name or counterparty phone identifying the conversation.' },
      limit: { type: 'number', description: 'Max most-recent messages (default 30, max 500).' },
      markRead: { type: 'boolean', description: 'Mark the conversation read up to now (default false).' },
    },
    required: ['chat'],
  },
};

export const whatsappSearchToolDef = {
  name: 'whatsapp_search',
  description:
    'Search the text of this account\'s ingested/cached WhatsApp messages (substring, ' +
    'case-insensitive), most-recent first. Account/location aware. Trigger words: "find the ' +
    'WhatsApp where …", "search my WhatsApp for …". Returns matching messages with their chat + ' +
    'timestamp. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      q: { type: 'string', description: 'Text to search for within message bodies.' },
      limit: { type: 'number', description: 'Max results (default 20, max 100).' },
    },
    required: ['q'],
  },
};

export const whatsappStatusToolDef = {
  name: 'whatsapp_status',
  description:
    'Show this WhatsApp connector\'s provider + status on this node: the provider (cdp | meta), ' +
    'location (local desktop or server), host, whether the account is logged in / configured, ' +
    'the account identity if discoverable, and how many messages/chats/unread have been ingested. ' +
    'Use this to check setup before sending. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const whatsappLoginToolDef = {
  name: 'whatsapp_login',
  description:
    'Launch a controlled Chrome at web.whatsapp.com on THIS node and return the login QR so the ' +
    'user can pair a linked device (WhatsApp on phone → Linked devices → Link a device). This is ' +
    'how the LOCAL (CDP) WhatsApp connector gets a logged-in, driveable session — mainly for Linux ' +
    '(no native WhatsApp app) and for re-pairing. ADMIN — it launches a real browser process. ' +
    'Trigger words: "log in to WhatsApp", "pair WhatsApp Web", "show the WhatsApp QR", "re-link ' +
    'WhatsApp". The browser stays open so the user can scan; it returns `loggedIn` plus, when a QR ' +
    'is shown, the QR PNG\'s `savedPath` (surface that image FILE to the user — the base64 dataUrl ' +
    'is also available but is large, do not paste it inline). After the user scans, poll ' +
    'whatsapp_status (loggedIn:true) to confirm. On Windows the native WhatsApp app already owns ' +
    'debug port 9222 — pass a different `port`.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      port: { type: 'number', description: 'Debug port for the launched browser (default 9222). Use a free port if 9222 is taken (e.g. by the native WhatsApp app).' },
      headless: { type: 'boolean', description: 'Run without a window (default false). Headed is required to actually render/scan the QR.' },
    },
  },
};

export const WHATSAPP_TOOL_DEFS = [
  whatsappSendToolDef,
  whatsappGetMediaToolDef,
  whatsappListChatsToolDef,
  whatsappReadMessagesToolDef,
  whatsappSearchToolDef,
  whatsappStatusToolDef,
  whatsappLoginToolDef,
] as const;

// ─── Handlers ────────────────────────────────────────────────────

interface WaMessageOut {
  chatId: string;
  direction: 'in' | 'out';
  type: string;
  text?: string;
  timestamp: number;
  status?: string;
  contactName?: string;
  mediaId?: string;
}
interface WaChatOut {
  chatId: string;
  name?: string;
  lastMessageAt: number;
  lastText?: string;
  lastDirection?: 'in' | 'out';
  messageCount: number;
  unreadCount: number;
}

function fmtTime(unixSec: number): string {
  try {
    return new Date(unixSec * 1000).toISOString().replace('T', ' ').slice(0, 16);
  } catch {
    return String(unixSec);
  }
}

function fmtMessage(m: WaMessageOut): string {
  const who = m.direction === 'out' ? '→' : '←';
  const status = m.direction === 'out' && m.status ? ` [${m.status}]` : '';
  const text = m.text ?? `[${m.type}]`;
  // Surface the media id so the model can fetch it via whatsapp_get_media.
  const media = m.mediaId ? ` (media ${m.mediaId})` : '';
  return `  ${fmtTime(m.timestamp)} ${who} ${text}${media}${status}`;
}

async function handleSend(args: Record<string, unknown>): Promise<McpToolResult> {
  const to = String(args.to || '').trim();
  if (!to) return err('`to` (recipient) is required.');
  if (!args.text && !args.template && !args.media) return err('Provide `text`, `template`, or `media`.');
  const body: Record<string, unknown> = { to };
  if (args.text !== undefined) body.text = String(args.text);
  if (args.template) body.template = args.template;
  if (args.media) body.media = args.media;
  if (args.previewUrl) body.previewUrl = true;
  try {
    const data = await workerPost<{ messageId: string; to: string }>('/whatsapp/send', body);
    const what = args.media ? 'attachment' : 'message';
    return ok(`Sent WhatsApp ${what} to ${data.to}${data.messageId ? ` (id ${data.messageId})` : ''}.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleGetMedia(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.id || '').trim();
  if (!id) return err('`id` (media id from an inbound message) is required.');
  try {
    const d = await workerGet<{ id: string; mime: string; bytes: number; path: string }>(
      `/whatsapp/media?id=${encodeURIComponent(id)}`,
    );
    return ok(`Downloaded WhatsApp media ${d.id} (${d.mime}, ${d.bytes} bytes) → ${d.path}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleListChats(args: Record<string, unknown>): Promise<McpToolResult> {
  const limit = args.limit ? Number(args.limit) : 30;
  try {
    const data = await workerGet<{ chats: WaChatOut[] }>(`/whatsapp/chats?limit=${limit}`);
    const chats = data.chats || [];
    if (chats.length === 0) return ok('No WhatsApp conversations ingested yet.');
    const lines = chats.map((c) => {
      const name = c.name ? `${c.name} (${c.chatId})` : c.chatId;
      const unread = c.unreadCount > 0 ? ` · ${c.unreadCount} unread` : '';
      const preview = c.lastText ? ` — "${c.lastText.slice(0, 60)}"` : '';
      return `- ${name}${unread} · ${c.messageCount} msgs · last ${fmtTime(c.lastMessageAt)}${preview}`;
    });
    return ok(`WhatsApp conversations (${chats.length}):\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleReadMessages(args: Record<string, unknown>): Promise<McpToolResult> {
  const chat = String(args.chat || '').trim();
  if (!chat) return err('`chat` (contact/group or phone) is required.');
  const limit = args.limit ? Number(args.limit) : 30;
  const markRead = args.markRead ? '&markRead=true' : '';
  try {
    const data = await workerGet<{ chatId: string; messages: WaMessageOut[] }>(
      `/whatsapp/messages?chat=${encodeURIComponent(chat)}&limit=${limit}${markRead}`,
    );
    const messages = data.messages || [];
    if (messages.length === 0) return ok(`No messages stored for ${data.chatId}.`);
    const name = messages.find((m) => m.contactName)?.contactName;
    const header = name ? `WhatsApp with ${name} (${data.chatId})` : `WhatsApp with ${data.chatId}`;
    return ok(`${header} — last ${messages.length}:\n${messages.map(fmtMessage).join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleSearch(args: Record<string, unknown>): Promise<McpToolResult> {
  const q = String(args.q || '').trim();
  if (!q) return err('`q` is required.');
  const limit = args.limit ? Number(args.limit) : 20;
  try {
    const data = await workerGet<{ query: string; results: WaMessageOut[] }>(
      `/whatsapp/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    );
    const results = data.results || [];
    if (results.length === 0) return ok(`No WhatsApp messages match "${q}".`);
    const lines = results.map((m) => {
      const who = m.contactName || m.chatId;
      return `- ${fmtTime(m.timestamp)} ${m.direction === 'out' ? 'to' : 'from'} ${who}: "${(m.text || '').slice(0, 80)}"`;
    });
    return ok(`WhatsApp matches for "${q}" (${results.length}):\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleStatus(): Promise<McpToolResult> {
  try {
    const d = await workerGet<{
      provider: string;
      location: string;
      host: string;
      backend: string;
      self: string | null;
      loggedIn: boolean;
      totalMessages: number;
      chats: number;
      unread: number;
    }>('/whatsapp/status');
    const lines = [
      `Provider: ${d.provider} (${d.location} · ${d.backend})`,
      `Host: ${d.host}`,
      `Logged in: ${d.loggedIn ? 'yes' : 'no'}`,
      `Account: ${d.self || '—'}`,
      `Ingested: ${d.totalMessages} messages across ${d.chats} chats · ${d.unread} unread`,
    ];
    return ok(`WhatsApp connector status:\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface WaLoginOut {
  pid: number;
  port: number;
  cdpUrl: string;
  profileDir?: string;
  loggedIn: boolean;
  qr?: { savedPath: string; dataUrl: string; capturedAt: string };
  note?: string;
}

async function handleLogin(args: Record<string, unknown>): Promise<McpToolResult> {
  const body: Record<string, unknown> = {};
  if (args.port !== undefined) body.port = Number(args.port);
  if (typeof args.headless === 'boolean') body.headless = args.headless;
  try {
    // Use the raw helper so a launch failure surfaces its structured error
    // (code + hint + installedBrowsers) instead of just a thrown message.
    const resp = await workerPostRaw('/whatsapp/login', body);
    if (resp.success === false) {
      const parts = [String(resp.error || 'login failed')];
      if (resp.code) parts.push(`(${resp.code})`);
      if (resp.hint) parts.push(`Hint: ${resp.hint}`);
      if (Array.isArray(resp.installedBrowsers)) parts.push(`Installed browsers: ${resp.installedBrowsers.join(', ') || '(none)'}`);
      return err(parts.join(' '));
    }
    const d = (resp.data || {}) as WaLoginOut;
    if (d.loggedIn) {
      return ok(`WhatsApp is already logged in on this node (pid ${d.pid}, CDP ${d.cdpUrl}). No QR needed — the connector can drive it now.`);
    }
    const lines = [
      `Launched WhatsApp Web login browser (pid ${d.pid}, CDP ${d.cdpUrl}).`,
    ];
    if (d.qr?.savedPath) {
      lines.push(`Scan this QR with your phone (WhatsApp → Linked devices → Link a device):`);
      lines.push(`  QR image: ${d.qr.savedPath}`);
      lines.push(`(A base64 data URL of the QR is also available but is large — the saved PNG above is the one to surface.)`);
      lines.push(`After scanning, run whatsapp_status to confirm loggedIn:true. Close the browser later via /browser/close pid ${d.pid}.`);
    } else {
      lines.push(d.note || 'No QR rendered yet — retry whatsapp_login, or check that the browser has a display + network.');
    }
    return ok(lines.join('\n'));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const WHATSAPP_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  whatsapp_send: handleSend,
  whatsapp_get_media: handleGetMedia,
  whatsapp_list_chats: handleListChats,
  whatsapp_read_messages: handleReadMessages,
  whatsapp_search: handleSearch,
  whatsapp_status: () => handleStatus(),
  whatsapp_login: handleLogin,
};
