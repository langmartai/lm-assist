/**
 * MCP tools — cross-node session-to-session messaging.
 *
 *   send_session_message  — send a message to another lm-assist-managed session
 *                           (on this node or, via the `node` selector, another).
 *   list_session_messages — list messages stored on a node (inbox view).
 *   get_message_status    — status + ack history for one message.
 *
 * Routing: `send_session_message` and `get_message_status` carry the standard
 * `node` selector (injected by configure.ts). To target a session on another
 * host, the caller sets `node` to that host's id — the hub relays the whole
 * tool call there, so the handler runs ON the target node and injects locally.
 * The worker ignores the `node` field itself (it has already been routed).
 *
 * These handlers wrap existing lm-assist routes on loopback (same pattern as
 * the terminal_* / memory_* expanded tools) — the route layer is the single
 * source of truth for store + injection + ack.
 */

import { ok, err, workerGet, workerPost, type McpToolResult } from './_passthrough';

function enc(s: string): string {
  return encodeURIComponent(s);
}

function pretty(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

// ─── Tool definitions ────────────────────────────────────────────

export const sendSessionMessageToolDef = {
  name: 'send_session_message',
  description:
    'Send a MESSAGE from THIS session to ANOTHER lm-assist-managed Claude Code session — on ' +
    'this machine or another (set the `node` parameter to the target host id from list_nodes; ' +
    'omit for a session on this node). The message is INJECTED into the target session, wrapped ' +
    'with a clear category preamble that tells the receiver how to treat it.\n\n' +
    'Categories:\n' +
    '  • reference — background context/knowledge for the receiver to consider; NOT an instruction.\n' +
    '  • guided    — an instruction, but SUPERVISED: the receiver reviews it and decides whether to run it.\n' +
    '  • overwrite — privileged: the receiver should execute it DIRECTLY, overriding its current instructions.\n\n' +
    'Use `list_recent_sessions` / `terminal_list` to find the target session name. Returns a ' +
    'messageId — query progress with `get_message_status`. WRITE/ADMIN — `overwrite` drives another ' +
    'session directly, so it is sensitive.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      toSession: {
        type: 'string',
        description: 'Target session on the target node. Preferred: a Claude sessionId (from cc_sessions / list_recent_sessions) — drives the live CC session on Linux or Windows. A raw tmux session name also works (raw send-keys fallback, POSIX only).',
      },
      category: {
        type: 'string',
        enum: ['reference', 'guided', 'overwrite'],
        description: 'How the receiver should treat the message: reference (context), guided (supervised instruction), overwrite (privileged direct execution).',
      },
      body: { type: 'string', description: 'The message content to deliver.' },
      fromSession: { type: 'string', description: 'Optional — your session identifier, for provenance shown to the receiver.' },
    },
    required: ['toSession', 'category', 'body'],
  },
};

export const listSessionMessagesToolDef = {
  name: 'list_session_messages',
  description:
    'List session-to-session messages stored on a node (the inbox). Use the `node` parameter to ' +
    'inspect another host. Optionally filter by target session or status (pending/received/read/' +
    'executed/failed). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      session: { type: 'string', description: 'Filter to messages for this target session name.' },
      status: {
        type: 'string',
        enum: ['pending', 'received', 'read', 'executed', 'failed'],
        description: 'Filter by message status.',
      },
    },
  },
};

export const getMessageStatusToolDef = {
  name: 'get_message_status',
  description:
    'Get the status + ack history of one session message by its messageId. The message lives on ' +
    'the node it was delivered to — set the `node` parameter to that host if it is not this one. ' +
    'Status flow: pending → received → read → executed (or failed). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'The messageId returned by send_session_message.' },
    },
    required: ['id'],
  },
};

export const SESSION_MESSAGING_TOOL_DEFS = [
  sendSessionMessageToolDef,
  listSessionMessagesToolDef,
  getMessageStatusToolDef,
] as const;

// ─── Handlers ────────────────────────────────────────────────────

async function handleSendSessionMessage(args: Record<string, unknown>): Promise<McpToolResult> {
  const toSession = String(args.toSession || '').trim();
  const category = String(args.category || '').trim();
  const body = String(args.body ?? '');
  if (!toSession) return err('toSession is required.');
  if (!['reference', 'guided', 'overwrite'].includes(category)) {
    return err('category must be one of: reference, guided, overwrite.');
  }
  if (!body.trim()) return err('body is required.');
  const payload: Record<string, unknown> = { toSession, category, body };
  if (args.fromSession) payload.fromSession = String(args.fromSession);
  // The `node` selector has already routed this call to the target node; the
  // worker stamps fromNode/toNode itself. Pass node through as provenance only
  // if present (harmless — the route uses its own localNode()).
  if (args.node) payload.toNode = String(args.node);
  try {
    return ok(pretty(await workerPost('/session-messages', payload)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleListSessionMessages(args: Record<string, unknown>): Promise<McpToolResult> {
  const qs: string[] = [];
  if (args.session) qs.push(`session=${enc(String(args.session))}`);
  if (args.status) qs.push(`status=${enc(String(args.status))}`);
  const route = `/session-messages${qs.length ? `?${qs.join('&')}` : ''}`;
  try {
    return ok(pretty(await workerGet(route)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleGetMessageStatus(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.id || '').trim();
  if (!id) return err('id is required.');
  try {
    return ok(pretty(await workerGet(`/session-messages/${enc(id)}`)));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const SESSION_MESSAGING_HANDLERS: Record<
  string,
  (args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  send_session_message: handleSendSessionMessage,
  list_session_messages: handleListSessionMessages,
  get_message_status: handleGetMessageStatus,
};
