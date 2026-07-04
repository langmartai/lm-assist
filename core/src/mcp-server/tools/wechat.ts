/**
 * WeChat connector MCP tools (WeCom 微信客服 backend).
 *
 * The official, business-verified path to read + respond to real WeChat users.
 * Personal WeChat has no automation API and the new Weixin 4.x desktop app has
 * no accessible message DOM, so there is no local provider — this connector is
 * always the WeCom 微信客服 server backend. The tool surface + store schema
 * mirror the WhatsApp connector (minus login/QR, which don't apply server-side).
 *
 * Each tool wraps this node's own `/wechat/*` REST route on loopback, so the same
 * behavior is reachable from stdio MCP, the HTTP `/mcp` endpoint, and remotely
 * via the hub relay.
 *
 * Wiring: registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts) and
 * scoped in configure.ts TOOL_SCOPES.
 */

import { ok, err, workerGet, workerPost, type McpToolResult } from './_passthrough';

export const wechatSendToolDef = {
  name: 'wechat_send',
  description:
    'Reply to a WeChat user through the business\'s WeCom 微信客服 (WeChat Customer Service) account. ' +
    'Trigger words: "WeChat X", "reply to … on WeChat", "message … on WeChat". Pass `to` (the ' +
    'counterparty — their external_userid or the contact name shown by wechat_list_chats) and `text` ' +
    '(the message body). NOTE: 微信客服 only allows replies within the 48-hour service window after ' +
    'the user\'s last message (like a customer-service session) — you cannot cold-message arbitrary ' +
    'WeChat users. Optionally pass `openKfid` to pick which 客服账号 sends when a chat could be served ' +
    'by several. Returns the messageId. Write tool — confirm the recipient + content.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Counterparty — the external_userid or contact name from wechat_list_chats.' },
      text: { type: 'string', description: 'Message body (free-form text).' },
      openKfid: { type: 'string', description: 'Optional 客服账号 (open_kfid) to send from; defaults to the chat\'s account or the configured default.' },
    },
    required: ['to', 'text'],
  },
};

export const wechatGetMediaToolDef = {
  name: 'wechat_get_media',
  description:
    'Download an inbound WeChat attachment (image, voice, video, file) by its media id — the id shown ' +
    'as "media <id>" next to an [image]/[voice]/[file] message in wechat_read_messages. Saves nothing ' +
    'itself; returns the mime + size (the bytes come back base64 to the caller). Media ids from ' +
    '微信客服 are short-lived (~3 days) — fetch soon after receipt. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'The media id from an inbound message (wechat_read_messages).' },
    },
    required: ['id'],
  },
};

export const wechatListChatsToolDef = {
  name: 'wechat_list_chats',
  description:
    'List the WeChat conversations this 微信客服 account has received, most-recently-active first. ' +
    'Trigger words: "my WeChat chats", "who messaged us on WeChat", "recent WeChat conversations". ' +
    'Each chat shows the counterparty (nickname and/or external_userid), last message preview, and ' +
    'total + unread counts. Reads come from what the connector has ingested via the callback over ' +
    'time (there is no server-side full-history fetch). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: { type: 'number', description: 'Max chats to return (default 30, max 200).' },
    },
  },
};

export const wechatReadMessagesToolDef = {
  name: 'wechat_read_messages',
  description:
    'Read one WeChat conversation in chronological order. Trigger words: "read my WeChat with …", ' +
    '"show the WeChat thread from …", "what did X say on WeChat". Pass `chat` (the nickname or ' +
    'external_userid from wechat_list_chats). Optionally `markRead:true` to reset that chat\'s unread ' +
    'count. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      chat: { type: 'string', description: 'Contact nickname or external_userid identifying the conversation.' },
      limit: { type: 'number', description: 'Max most-recent messages (default 30, max 500).' },
      markRead: { type: 'boolean', description: 'Mark the conversation read up to now (default false).' },
    },
    required: ['chat'],
  },
};

export const wechatSearchToolDef = {
  name: 'wechat_search',
  description:
    'Search the text of this account\'s ingested WeChat messages (substring, case-insensitive), ' +
    'most-recent first. Trigger words: "find the WeChat where …", "search my WeChat for …". Returns ' +
    'matching messages with their chat + timestamp. Read-only.',
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

export const wechatStatusToolDef = {
  name: 'wechat_status',
  description:
    'Show this WeChat connector\'s status on this node: the provider (WeCom 微信客服), host, whether ' +
    'credentials + the callback are configured, the 客服账号 (customer-service accounts) discovered, ' +
    'and how many messages/chats/unread have been ingested. Use this to check setup before sending. ' +
    'Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const WECHAT_TOOL_DEFS = [
  wechatSendToolDef,
  wechatGetMediaToolDef,
  wechatListChatsToolDef,
  wechatReadMessagesToolDef,
  wechatSearchToolDef,
  wechatStatusToolDef,
] as const;

// ─── Handlers ────────────────────────────────────────────────────

interface WeMessageOut {
  chatId: string;
  direction: 'in' | 'out';
  type: string;
  text?: string;
  timestamp: number;
  status?: string;
  contactName?: string;
  mediaId?: string;
}
interface WeChatOut {
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

function fmtMessage(m: WeMessageOut): string {
  const who = m.direction === 'out' ? '→' : '←';
  const status = m.direction === 'out' && m.status ? ` [${m.status}]` : '';
  const text = m.text ?? `[${m.type}]`;
  const media = m.mediaId ? ` (media ${m.mediaId})` : '';
  return `  ${fmtTime(m.timestamp)} ${who} ${text}${media}${status}`;
}

async function handleSend(args: Record<string, unknown>): Promise<McpToolResult> {
  const to = String(args.to || '').trim();
  if (!to) return err('`to` (recipient) is required.');
  const text = String(args.text || '');
  if (!text) return err('`text` (message body) is required.');
  const body: Record<string, unknown> = { to, text };
  if (args.openKfid) body.openKfid = String(args.openKfid);
  try {
    const data = await workerPost<{ messageId: string; to: string }>('/wechat/send', body);
    return ok(`Sent WeChat message to ${data.to}${data.messageId ? ` (id ${data.messageId})` : ''}.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleGetMedia(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.id || '').trim();
  if (!id) return err('`id` (media id from an inbound message) is required.');
  try {
    const d = await workerGet<{ id: string; mime: string; bytes: number }>(
      `/wechat/media?id=${encodeURIComponent(id)}`,
    );
    return ok(`Downloaded WeChat media ${d.id} (${d.mime}, ${d.bytes} bytes).`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleListChats(args: Record<string, unknown>): Promise<McpToolResult> {
  const limit = args.limit ? Number(args.limit) : 30;
  try {
    const data = await workerGet<{ chats: WeChatOut[] }>(`/wechat/chats?limit=${limit}`);
    const chats = data.chats || [];
    if (chats.length === 0) return ok('No WeChat conversations ingested yet.');
    const lines = chats.map((c) => {
      const name = c.name ? `${c.name} (${c.chatId})` : c.chatId;
      const unread = c.unreadCount > 0 ? ` · ${c.unreadCount} unread` : '';
      const preview = c.lastText ? ` — "${c.lastText.slice(0, 60)}"` : '';
      return `- ${name}${unread} · ${c.messageCount} msgs · last ${fmtTime(c.lastMessageAt)}${preview}`;
    });
    return ok(`WeChat conversations (${chats.length}):\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleReadMessages(args: Record<string, unknown>): Promise<McpToolResult> {
  const chat = String(args.chat || '').trim();
  if (!chat) return err('`chat` (contact nickname or external_userid) is required.');
  const limit = args.limit ? Number(args.limit) : 30;
  const markRead = args.markRead ? '&markRead=true' : '';
  try {
    const data = await workerGet<{ chatId: string; messages: WeMessageOut[] }>(
      `/wechat/messages?chat=${encodeURIComponent(chat)}&limit=${limit}${markRead}`,
    );
    const messages = data.messages || [];
    if (messages.length === 0) return ok(`No messages stored for ${data.chatId}.`);
    const name = messages.find((m) => m.contactName)?.contactName;
    const header = name ? `WeChat with ${name} (${data.chatId})` : `WeChat with ${data.chatId}`;
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
    const data = await workerGet<{ query: string; results: WeMessageOut[] }>(
      `/wechat/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    );
    const results = data.results || [];
    if (results.length === 0) return ok(`No WeChat messages match "${q}".`);
    const lines = results.map((m) => {
      const who = m.contactName || m.chatId;
      return `- ${fmtTime(m.timestamp)} ${m.direction === 'out' ? 'to' : 'from'} ${who}: "${(m.text || '').slice(0, 80)}"`;
    });
    return ok(`WeChat matches for "${q}" (${results.length}):\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleStatus(): Promise<McpToolResult> {
  try {
    const d = await workerGet<{
      provider: string;
      host: string;
      configured: boolean;
      webhookConfigured: boolean;
      corpId: string | null;
      self: string | null;
      accounts: Array<{ openKfid: string; name?: string }>;
      accountsError?: string;
      totalMessages: number;
      chats: number;
      unread: number;
    }>('/wechat/status');
    const accts = d.accounts && d.accounts.length
      ? d.accounts.map((a) => `${a.name || '—'} (${a.openKfid})`).join(', ')
      : d.accountsError
        ? `(error listing: ${d.accountsError})`
        : '—';
    const lines = [
      `Provider: ${d.provider} (WeChat Customer Service)`,
      `Host: ${d.host}`,
      `Credentials: ${d.configured ? 'configured' : 'NOT configured'}`,
      `Callback webhook: ${d.webhookConfigured ? 'configured' : 'NOT configured'}`,
      `Corp: ${d.corpId || '—'}`,
      `客服账号: ${accts}`,
      `Ingested: ${d.totalMessages} messages across ${d.chats} chats · ${d.unread} unread`,
    ];
    return ok(`WeChat connector status:\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const WECHAT_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  wechat_send: handleSend,
  wechat_get_media: handleGetMedia,
  wechat_list_chats: handleListChats,
  wechat_read_messages: handleReadMessages,
  wechat_search: handleSearch,
  wechat_status: () => handleStatus(),
};
