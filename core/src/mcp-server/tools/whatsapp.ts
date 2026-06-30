/**
 * WhatsApp connector MCP tools.
 *
 * Surface the WhatsApp Cloud API connector over MCP. Like the other expanded
 * tools, each one wraps this node's own `/whatsapp/*` REST route on loopback
 * (single source of truth), so the same behavior is reachable from the stdio
 * MCP, the HTTP `/mcp` endpoint, and remotely through the hub relay.
 *
 * Backend reality the descriptions encode for the model:
 *   - Reads come from messages this node has INGESTED via webhook over time —
 *     there is no server-side history fetch in the Cloud API.
 *   - Free-form text only delivers inside a 24h window after the user last
 *     messaged the business; outside it, only approved templates send.
 *
 * Wiring: registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts)
 * and scoped in configure.ts TOOL_SCOPES.
 */

import { ok, err, workerGet, workerPost, type McpToolResult } from './_passthrough';

export const whatsappSendToolDef = {
  name: 'whatsapp_send',
  description:
    'Send a WhatsApp message via the user\'s WhatsApp Cloud API (Meta) business number. ' +
    'Trigger words: "WhatsApp X", "send a WhatsApp to …", "text … on WhatsApp", "whatsapp ' +
    'me when …". Pass `to` (recipient phone, international format — "+" and spaces are ' +
    'stripped) and either `text` (free-form; only delivers within 24h of the recipient\'s ' +
    'last inbound message) or `template` (a pre-approved template; the only way to start a ' +
    'new conversation). Returns the messageId. Write tool — confirm the recipient + content.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Recipient phone in international format, e.g. "+14155551234".' },
      text: { type: 'string', description: 'Message body (free-form text). Use this OR `template`.' },
      template: {
        type: 'object',
        description: 'Pre-approved template message (sends any time, unlike free-form text).',
        properties: {
          name: { type: 'string', description: 'Approved template name.' },
          languageCode: { type: 'string', description: 'BCP-47 language code, e.g. "en_US" (default).' },
          components: { type: 'array', description: 'Optional header/body/button parameter components.', items: { type: 'object' } },
        },
        required: ['name'],
      },
      previewUrl: { type: 'boolean', description: 'Render a link preview for URLs in `text` (default false).' },
    },
    required: ['to'],
  },
};

export const whatsappListChatsToolDef = {
  name: 'whatsapp_list_chats',
  description:
    'List the user\'s WhatsApp conversations (one per counterparty), most-recently-active ' +
    'first. Trigger words: "my WhatsApp chats", "who messaged me on WhatsApp", "recent ' +
    'WhatsApp conversations". Each chat shows the counterparty phone, profile name, last ' +
    'message preview, total + unread counts. Reads from messages this node has received ' +
    'via webhook (no live server-side history). Read-only.',
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
    'Read the messages of one WhatsApp conversation, in chronological order. Trigger words: ' +
    '"read my WhatsApp with …", "show the WhatsApp thread from …", "what did X say on ' +
    'WhatsApp". Pass `chat` (the counterparty phone from whatsapp_list_chats). Optionally ' +
    '`markRead:true` to reset that chat\'s unread count. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      chat: { type: 'string', description: 'Counterparty phone (international format) identifying the conversation.' },
      limit: { type: 'number', description: 'Max most-recent messages (default 30, max 500).' },
      markRead: { type: 'boolean', description: 'Mark the conversation read up to now (default false).' },
    },
    required: ['chat'],
  },
};

export const whatsappSearchToolDef = {
  name: 'whatsapp_search',
  description:
    'Search the text of the user\'s ingested WhatsApp messages (substring, case-insensitive), ' +
    'most-recent first. Trigger words: "find the WhatsApp where …", "search my WhatsApp for ' +
    '…". Returns matching messages with their chat + timestamp. Read-only.',
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
    'Show the WhatsApp connector\'s configuration + ingest status on this node: whether ' +
    'credentials are set, the business phone number id, Graph API version, whether the ' +
    'webhook verify token + app secret are set, and how many messages/chats/unread have ' +
    'been ingested. Use this to check setup before sending. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const WHATSAPP_TOOL_DEFS = [
  whatsappSendToolDef,
  whatsappListChatsToolDef,
  whatsappReadMessagesToolDef,
  whatsappSearchToolDef,
  whatsappStatusToolDef,
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
  return `  ${fmtTime(m.timestamp)} ${who} ${text}${status}`;
}

async function handleSend(args: Record<string, unknown>): Promise<McpToolResult> {
  const to = String(args.to || '').trim();
  if (!to) return err('`to` (recipient phone) is required.');
  if (!args.text && !args.template) return err('Provide `text` or `template`.');
  const body: Record<string, unknown> = { to };
  if (args.text !== undefined) body.text = String(args.text);
  if (args.template) body.template = args.template;
  if (args.previewUrl) body.previewUrl = true;
  try {
    const data = await workerPost<{ messageId: string; to: string }>('/whatsapp/send', body);
    return ok(`Sent WhatsApp message to ${data.to}${data.messageId ? ` (id ${data.messageId})` : ''}.`);
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
  if (!chat) return err('`chat` (counterparty phone) is required.');
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
      configured: boolean;
      phoneNumberId: string | null;
      displayPhoneNumber: string | null;
      businessAccountId: string | null;
      graphApiVersion: string;
      webhookVerifyTokenSet: boolean;
      appSecretSet: boolean;
      totalMessages: number;
      chats: number;
      unread: number;
    }>('/whatsapp/status');
    const lines = [
      `Configured: ${d.configured ? 'yes' : 'no (set phoneNumberId + accessToken via PUT /whatsapp/config)'}`,
      `Phone number id: ${d.phoneNumberId || '—'}${d.displayPhoneNumber ? ` (${d.displayPhoneNumber})` : ''}`,
      `Business account: ${d.businessAccountId || '—'}`,
      `Graph API: ${d.graphApiVersion}`,
      `Webhook verify token set: ${d.webhookVerifyTokenSet ? 'yes' : 'no'}`,
      `App secret set: ${d.appSecretSet ? 'yes' : 'no (inbound POSTs are not signature-verified)'}`,
      `Ingested: ${d.totalMessages} messages across ${d.chats} chats · ${d.unread} unread`,
    ];
    return ok(`WhatsApp connector status:\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const WHATSAPP_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  whatsapp_send: handleSend,
  whatsapp_list_chats: handleListChats,
  whatsapp_read_messages: handleReadMessages,
  whatsapp_search: handleSearch,
  whatsapp_status: () => handleStatus(),
};
