/**
 * WhatsApp MCP tools — surface the lm-assist `/whatsapp/*` action endpoint over MCP.
 *
 * Two tools, split along the capability-scope boundary (a tool maps to exactly
 * one scope in configure.ts TOOL_SCOPES):
 *
 *   whatsapp_query (read)  — status, chats, read
 *   whatsapp_send  (write) — open, type, send
 *
 * Both dispatch to `POST /whatsapp/<action>` on loopback (the same route a
 * direct HTTP caller hits), so the underlying service's guarantees hold:
 *   - host-agnostic: drives any logged-in WhatsApp Web behind a CDP debug port
 *     (WhatsApp Desktop WebView2 on Windows, or a debug Chrome anywhere).
 *     Endpoint configurable via `cdpUrl`/`port` or env WHATSAPP_CDP_URL/PORT.
 *   - structured errors: NOT_LOGGED_IN / CHAT_NOT_FOUND / NO_CHAT_OPEN / etc.
 *
 * Wiring: registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts) and
 * scoped in configure.ts TOOL_SCOPES, so both transports pick them up.
 *
 * SAFETY: `send` posts a real message to a real contact — it is irreversible.
 * It lives in the write-scoped tool (whatsapp_send), which prompts for approval.
 */

import { ok, err, workerPostRaw, type McpToolResult } from './_passthrough';

const READ_ACTIONS = ['status', 'chats', 'read'] as const;
const WRITE_ACTIONS = ['open', 'type', 'send'] as const;

function pretty(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined && args[k] !== null) p[k] = args[k];
  return p;
}

async function whatsappAction(action: string, params: Record<string, unknown>): Promise<McpToolResult> {
  let body: Record<string, unknown>;
  try {
    body = await workerPostRaw(`/whatsapp/${action}`, params);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
  if (body && body.ok) return ok(pretty(body.data));
  const e = (body && (body.error as Record<string, unknown>)) || {};
  return err(`${String(e.code || 'WHATSAPP_ERROR')}: ${String(e.message || 'whatsapp action failed')}`);
}

// ─── Tool definitions ────────────────────────────────────────────

export const whatsappQueryToolDef = {
  name: 'whatsapp_query',
  description:
    'Read a logged-in WhatsApp session (WhatsApp Desktop app on Windows, or a debug-port Chrome ' +
    'running web.whatsapp.com). Trigger words: "whatsapp", "read my whatsapp", "whatsapp chats", ' +
    '"latest whatsapp messages". `action`: `status` (CDP reachable + logged-in state), `chats` ' +
    '(list conversations in the side pane — name, last-message preview, unread badge), `read` ' +
    '(last N messages of a chat — pass `name` to open it first, else reads the currently-open chat; ' +
    '`n` defaults to 30). Optional `cdpUrl` or `port` overrides the CDP endpoint (default ' +
    'http://localhost:9222). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: [...READ_ACTIONS], description: 'Which read operation to run.' },
      name: { type: 'string', description: 'read: contact/group name to open before reading (optional).' },
      n: { type: 'number', description: 'read: number of recent messages (default 30, max 200).' },
      cdpUrl: { type: 'string', description: 'CDP base URL override (e.g. http://localhost:9222).' },
      port: { type: 'number', description: 'CDP port override (default 9222).' },
    },
    required: ['action'],
  },
};

export const whatsappSendToolDef = {
  name: 'whatsapp_send',
  description:
    'Act on a logged-in WhatsApp session. WRITE — prompts for approval. `action`: `open` ' +
    '(open a chat by contact/group `name`), `type` (open `name` if given, then stage `text` in the ' +
    'compose box WITHOUT sending — safe/reversible), `send` (type `text` and press Enter — this ' +
    'SENDS a real, irreversible message to the contact; always confirm the target with the user ' +
    'first). Optional `cdpUrl`/`port` overrides the CDP endpoint (default http://localhost:9222).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: [...WRITE_ACTIONS], description: 'Which operation: open | type | send.' },
      name: { type: 'string', description: 'Contact/group name (required for open; for type/send opens it first).' },
      text: { type: 'string', description: 'Message text (required for type and send).' },
      cdpUrl: { type: 'string', description: 'CDP base URL override.' },
      port: { type: 'number', description: 'CDP port override (default 9222).' },
    },
    required: ['action'],
  },
};

export const WHATSAPP_TOOL_DEFS = [whatsappQueryToolDef, whatsappSendToolDef] as const;

// ─── Handlers ────────────────────────────────────────────────────

async function handleWhatsappQuery(args: Record<string, unknown>): Promise<McpToolResult> {
  const action = String(args.action || '').trim();
  if (!(READ_ACTIONS as readonly string[]).includes(action)) {
    return err(`whatsapp_query action must be one of: ${READ_ACTIONS.join(', ')}`);
  }
  return whatsappAction(action, pick(args, ['name', 'n', 'cdpUrl', 'port']));
}

async function handleWhatsappSend(args: Record<string, unknown>): Promise<McpToolResult> {
  const action = String(args.action || '').trim();
  if (!(WRITE_ACTIONS as readonly string[]).includes(action)) {
    return err(`whatsapp_send action must be one of: ${WRITE_ACTIONS.join(', ')}`);
  }
  return whatsappAction(action, pick(args, ['name', 'text', 'cdpUrl', 'port']));
}

export const WHATSAPP_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  whatsapp_query: handleWhatsappQuery,
  whatsapp_send: handleWhatsappSend,
};
