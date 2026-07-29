/**
 * Gmail connector MCP tools.
 *
 * ONE CDP-backed surface: this node drives a logged-in mail.google.com session
 * (the operator's OWN account) over the Chrome DevTools Protocol. Reads are LIVE
 * reads of the rendered mail app; writes drive the real UI (compose/send, reply,
 * save draft). There is no local mirror store — Gmail backfills its own history
 * and owns read-state, so duplicating it would only go stale.
 *
 * Each tool wraps this node's own `/gmail/*` REST route on loopback (single
 * source of truth), so the same behavior is reachable from the stdio MCP, the
 * HTTP `/mcp` endpoint, and remotely via the hub relay.
 *
 * Wiring: registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts),
 * scoped in configure.ts TOOL_SCOPES, catalogued in registry/catalog.ts.
 */

import { ok, err, workerGet, workerPost, workerPostRaw, type McpToolResult } from './_passthrough';

// ─── tool defs ───────────────────────────────────────────────────────────────

// NOTE ON LENGTH: every byte here is multiplied by the whole advertised tool
// count at connect time (see __tests__/mcp-catalog-size.test.ts). Keep the
// trigger words — they drive tool selection — and cut everything else.

export const gmailStatusToolDef = {
  name: 'gmail_status',
  description:
    'Gmail connector status on this node: provider, driver-browser login state, signed-in address. ' +
    'If loggedIn is false, run gmail_login. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const gmailLoginToolDef = {
  name: 'gmail_login',
  description:
    'Launch a Chrome at mail.google.com on THIS node so the user can sign in (Google account + 2FA). ' +
    'Trigger words: "log in to Gmail", "connect Gmail". One-time — the session persists in a dedicated ' +
    'profile. ADMIN: launches a real browser. An already-authenticated profile returns loggedIn:true; ' +
    'otherwise a window opens, then poll gmail_status. Debug port 9224; headed is required to sign in.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      port: { type: 'number', description: 'Debug port (default 9224).' },
      headless: { type: 'boolean', description: 'No window (default false).' },
      profile: { type: 'string', description: "Persistent profile name (default 'gmail')." },
    },
  },
};

export const gmailListThreadsToolDef = {
  name: 'gmail_list_threads',
  description:
    'List email threads in a Gmail view, newest first. Trigger words: "my email", "check my inbox", ' +
    '"what mail did I get". Returns sender, subject, snippet, date, unread flag and a threadId for ' +
    'gmail_read_thread. Defaults to the inbox; pass `label` for other views. Virtualized: returns the ' +
    'most-recent RENDERED threads up to `limit`, not full history — use gmail_search for older mail.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: { type: 'number', description: 'Default 25, max 100.' },
      label: { type: 'string', description: "Mailbox/label (default 'inbox'), e.g. 'Sent', 'Starred'." },
    },
  },
};

export const gmailReadThreadToolDef = {
  name: 'gmail_read_thread',
  description:
    'Open ONE Gmail thread and read its messages in order — sender, address, timestamp, body. Trigger ' +
    'words: "read that email", "open the thread from …". Pass `threadId` from gmail_list_threads or ' +
    'gmail_search. Collapsed messages are expanded first.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      threadId: { type: 'string', description: 'Thread id from a list/search result.' },
    },
    required: ['threadId'],
  },
};

export const gmailSearchToolDef = {
  name: 'gmail_search',
  description:
    "Search Gmail with its OWN query syntax — `from:a@b.com`, `is:unread`, `has:attachment`, " +
    '`subject:x`, `after:2026/01/01`, `label:work`, or plain words. Trigger words: "find the email ' +
    'from …", "search my mail for …", "unread email", "do I have new mail" (use `is:unread`). The way ' +
    'to reach mail outside the current view.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Gmail query, e.g. "from:bob is:unread".' },
      limit: { type: 'number', description: 'Default 25, max 100.' },
    },
    required: ['query'],
  },
};

export const gmailLabelsToolDef = {
  name: 'gmail_labels',
  description:
    'List Gmail labels/mailboxes from the left nav with unread counts. Trigger words: "my Gmail ' +
    'labels", "what folders do I have". Pass a name as `label` to gmail_list_threads.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const gmailSendToolDef = {
  name: 'gmail_send',
  description:
    'Compose and SEND a new email. Trigger words: "email X", "send an email to …". WRITE — sends real ' +
    "mail from the operator's real account immediately; no undo. Confirm recipient, subject and body " +
    'with the user first. Use gmail_draft to save without sending.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Recipient address(es), comma-separated.' },
      subject: { type: 'string', description: 'Subject.' },
      body: { type: 'string', description: 'Plain text.' },
    },
    required: ['to', 'body'],
  },
};

export const gmailReplyToolDef = {
  name: 'gmail_reply',
  description:
    'Reply to an existing Gmail thread. Trigger words: "reply to that email", "respond to the thread". ' +
    "Pass `threadId` plus `body`. WRITE — sent immediately to the thread's participants; no undo. " +
    'Confirm the wording first.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      threadId: { type: 'string', description: 'Thread id to reply to.' },
      body: { type: 'string', description: 'Plain text.' },
    },
    required: ['threadId', 'body'],
  },
};

export const gmailDraftToolDef = {
  name: 'gmail_draft',
  description:
    'Compose an email and SAVE AS DRAFT without sending. Trigger words: "draft an email to …", "write ' +
    'but do not send". Safer than gmail_send — lands in Drafts for review; delivers nothing.',
  annotations: { readOnlyHint: false, destructiveHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Recipient address(es); may be empty.' },
      subject: { type: 'string', description: 'Subject.' },
      body: { type: 'string', description: 'Plain text.' },
    },
    required: ['body'],
  },
};

export const GMAIL_TOOL_DEFS = [
  gmailStatusToolDef,
  gmailLoginToolDef,
  gmailListThreadsToolDef,
  gmailReadThreadToolDef,
  gmailSearchToolDef,
  gmailLabelsToolDef,
  gmailSendToolDef,
  gmailReplyToolDef,
  gmailDraftToolDef,
];

// ─── formatting helpers ──────────────────────────────────────────────────────

interface ThreadRow {
  threadId: string | null;
  unread: boolean;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
  date: string | null;
}

function fmtThread(t: ThreadRow): string {
  const who = t.fromName || t.fromEmail || '(unknown sender)';
  const addr = t.fromEmail && t.fromName ? ` <${t.fromEmail}>` : '';
  const flag = t.unread ? '● ' : '  ';
  const when = t.date ? `  [${t.date}]` : '';
  const id = t.threadId ? `  id=${t.threadId}` : '';
  const snip = t.snippet ? `\n     ${t.snippet}` : '';
  return `${flag}${who}${addr}${when}\n     ${t.subject || '(no subject)'}${id}${snip}`;
}

function fmtThreadList(threads: ThreadRow[], header: string): string {
  if (!threads.length) return `${header}\n(no threads)`;
  return `${header}\n\n${threads.map(fmtThread).join('\n\n')}`;
}

// ─── handlers ────────────────────────────────────────────────────────────────

async function handleStatus(): Promise<McpToolResult> {
  try {
    const d = await workerGet<{ provider: string; host: string; self: string | null; loggedIn: boolean; backend: string }>(
      '/gmail/status',
    );
    const lines = [
      `Gmail connector on ${d.host}`,
      `  provider:  ${d.provider} (${d.backend})`,
      `  loggedIn:  ${d.loggedIn}`,
      `  account:   ${d.self || '(unknown)'}`,
    ];
    if (!d.loggedIn) lines.push('', 'Not logged in — run gmail_login and finish the Google sign-in in the browser window.');
    return ok(lines.join('\n'));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/** Shape of the `data` payload returned by POST /gmail/login. */
interface GmLoginOut {
  pid?: number;
  port?: number;
  profileDir?: string;
  loggedIn?: boolean;
  self?: string | null;
  note?: string;
}

async function handleLogin(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const body: Record<string, unknown> = {};
    if (args.port !== undefined) body.port = Number(args.port);
    if (typeof args.headless === 'boolean') body.headless = args.headless;
    if (typeof args.profile === 'string') body.profile = args.profile;
    const resp = await workerPostRaw('/gmail/login', body);
    if (resp.success === false) {
      const bits = [`Gmail login failed: ${String(resp.error || 'unknown error')}`];
      if (resp.code) bits.push(`code: ${String(resp.code)}`);
      if (resp.hint) bits.push(`hint: ${String(resp.hint)}`);
      if (Array.isArray(resp.installedBrowsers)) bits.push(`installed browsers: ${resp.installedBrowsers.join(', ') || '(none)'}`);
      return err(bits.join('\n'));
    }
    const d = (resp.data || {}) as GmLoginOut;
    const lines = [
      d.loggedIn ? 'Gmail is logged in and driveable.' : 'Browser launched — the user still needs to sign in.',
      `  pid:        ${d.pid ?? '(unknown)'}`,
      `  debug port: ${d.port ?? '(unknown)'}`,
      `  profile:    ${d.profileDir ?? '(unknown)'}`,
      `  account:    ${d.self || '(unknown)'}`,
    ];
    if (d.note) lines.push('', String(d.note));
    return ok(lines.join('\n'));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleListThreads(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const q = new URLSearchParams();
    if (typeof args.limit === 'number') q.set('limit', String(args.limit));
    if (typeof args.label === 'string' && args.label.trim()) q.set('label', args.label.trim());
    const d = await workerGet<{ label: string; count: number; limit: number; threads: ThreadRow[] }>(
      `/gmail/threads${q.toString() ? `?${q}` : ''}`,
    );
    const more = d.count >= d.limit ? ` (capped at limit=${d.limit}; ask for more or use gmail_search)` : '';
    return ok(fmtThreadList(d.threads, `${d.count} thread(s) in ${d.label}${more}`));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleReadThread(args: Record<string, unknown>): Promise<McpToolResult> {
  const threadId = String(args.threadId ?? '').trim();
  if (!threadId) return err('threadId is required (get one from gmail_list_threads or gmail_search).');
  try {
    const d = await workerGet<{
      threadId: string;
      subject: string | null;
      messages: Array<{ messageId: string | null; fromName: string | null; fromEmail: string | null; date: string | null; body: string }>;
    }>(`/gmail/thread?id=${encodeURIComponent(threadId)}`);
    const head = `Subject: ${d.subject || '(no subject)'}\nThread:  ${d.threadId}\n${d.messages.length} message(s)`;
    const body = d.messages
      .map((m, i) => {
        const who = m.fromName ? `${m.fromName}${m.fromEmail ? ` <${m.fromEmail}>` : ''}` : m.fromEmail || '(unknown)';
        return `\n─── [${i + 1}] ${who}${m.date ? `  ${m.date}` : ''} ───\n${m.body || '(empty body)'}`;
      })
      .join('\n');
    return ok(`${head}\n${body}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleSearch(args: Record<string, unknown>): Promise<McpToolResult> {
  const query = String(args.query ?? '').trim();
  if (!query) return err('query is required, e.g. "from:bob is:unread".');
  try {
    const q = new URLSearchParams({ q: query });
    if (typeof args.limit === 'number') q.set('limit', String(args.limit));
    const d = await workerGet<{ query: string; count: number; limit: number; threads: ThreadRow[] }>(`/gmail/search?${q}`);
    const more = d.count >= d.limit ? ` (capped at limit=${d.limit})` : '';
    return ok(fmtThreadList(d.threads, `${d.count} thread(s) matching "${d.query}"${more}`));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleLabels(): Promise<McpToolResult> {
  try {
    const d = await workerGet<{ labels: Array<{ name: string; unread: string | null }> }>('/gmail/labels');
    if (!d.labels.length) return ok('No labels found in the left nav.');
    return ok(`${d.labels.length} label(s):\n${d.labels.map((l) => `  ${l.name}${l.unread ? `  (${l.unread})` : ''}`).join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleSend(args: Record<string, unknown>): Promise<McpToolResult> {
  const to = String(args.to ?? '').trim();
  const body = String(args.body ?? '');
  if (!to) return err('to is required.');
  if (!body.trim()) return err('body is required.');
  try {
    const d = await workerPost<{ to: string; subject: string }>('/gmail/send', {
      to,
      subject: String(args.subject ?? ''),
      body,
    });
    return ok(`Sent to ${d.to}${d.subject ? ` — "${d.subject}"` : ''}.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleReply(args: Record<string, unknown>): Promise<McpToolResult> {
  const threadId = String(args.threadId ?? '').trim();
  const body = String(args.body ?? '');
  if (!threadId) return err('threadId is required (get one from gmail_list_threads or gmail_search).');
  if (!body.trim()) return err('body is required.');
  try {
    const d = await workerPost<{ threadId: string }>('/gmail/reply', { threadId, body });
    return ok(`Replied to thread ${d.threadId}.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleDraft(args: Record<string, unknown>): Promise<McpToolResult> {
  const body = String(args.body ?? '');
  if (!body.trim()) return err('body is required.');
  try {
    const d = await workerPost<{ to: string; subject: string }>('/gmail/draft', {
      to: String(args.to ?? ''),
      subject: String(args.subject ?? ''),
      body,
    });
    return ok(`Draft saved${d.to ? ` for ${d.to}` : ''}${d.subject ? ` — "${d.subject}"` : ''}. It is in Gmail's Drafts, not sent.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const GMAIL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  gmail_status: () => handleStatus(),
  gmail_login: handleLogin,
  gmail_list_threads: handleListThreads,
  gmail_read_thread: handleReadThread,
  gmail_search: handleSearch,
  gmail_labels: () => handleLabels(),
  gmail_send: handleSend,
  gmail_reply: handleReply,
  gmail_draft: handleDraft,
};
