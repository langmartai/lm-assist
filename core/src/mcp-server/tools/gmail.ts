/**
 * Gmail connector MCP tools.
 *
 * ONE CDP-backed surface: this node drives a logged-in mail.google.com session
 * (the operator's OWN account) over the Chrome DevTools Protocol. Reads are LIVE
 * reads of the mail app; writes drive the real UI (compose/send, reply, save
 * draft).
 *
 * TWO read paths, deliberately: Gmail itself (gmail_search — whole mailbox, any
 * age, but a browser round-trip) and a LOCAL WINDOW CACHE (gmail_sync →
 * gmail_search_local — instant, offline, but only the days that were synced).
 * The cache is a convenience index, never the source of truth: Gmail still owns
 * history and read-state, which is why it is bounded to a window instead of
 * mirroring the mailbox. gmail_sync_status is what says how far back it reaches
 * — an empty local hit usually means "out of window", not "no such mail".
 *
 * Message bodies are read from Gmail's RAW RFC822 source by default: the
 * rendered view clips long messages ("[Message clipped]") and hides trimmed
 * quotes, so DOM scraping is lossy. `gmail_read_thread full:false` opts back
 * into the rendered view.
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
// trigger words — they drive tool selection — and cut everything else. Say the
// one thing a caller could get wrong; nothing else earns its bytes.

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
    'gmail_search.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      threadId: { type: 'string', description: 'Thread id from a list/search result.' },
      full: {
        type: 'boolean',
        description:
          'Default true: read the raw RFC822 source, which is COMPLETE. false scrapes the rendered view, ' +
          'which clips long bodies ("[Message clipped]") and drops trimmed quotes.',
      },
    },
    required: ['threadId'],
  },
};

export const gmailSearchToolDef = {
  name: 'gmail_search',
  description:
    "Search Gmail SERVER-SIDE with its OWN query syntax — `from:a@b.com`, `is:unread`, " +
    '`has:attachment`, `subject:x`, `after:2026/01/01`, `label:work`, or plain words. Trigger words: ' +
    '"find the email from …", "search my mail for …", "unread email". Reaches the WHOLE mailbox at any ' +
    'age, but needs the browser — gmail_search_local is instant and covers only synced days.',
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

export const gmailSearchLocalToolDef = {
  name: 'gmail_search_local',
  description:
    'Search the LOCAL cache of synced mail — instant, no browser. Plain words over sender/subject/' +
    'body; Gmail operators (`from:`, `is:unread`) are NOT parsed. Covers only the synced WINDOW, so ' +
    'no hits can mean out-of-window rather than absent (see gmail_sync_status) — for older mail or ' +
    'operator syntax use gmail_search.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      q: { type: 'string', description: 'Words to match.' },
      limit: { type: 'number', description: 'Default 25, max 100.' },
    },
    required: ['q'],
  },
};

export const gmailSyncToolDef = {
  name: 'gmail_sync',
  description:
    'Pull recent Gmail into this node\'s local cache so gmail_search_local answers instantly. Trigger ' +
    'words: "sync my mail", "refresh the Gmail cache". Drives the browser and is SLOW — a wide `days` ' +
    'can outlast the call budget, so widen in steps. Fetches only; sends nothing.',
  annotations: { readOnlyHint: false, destructiveHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      days: { type: 'number', description: 'Window to pull (default 10, max 60).' },
      label: { type: 'string', description: "Mailbox to sync (default 'inbox')." },
    },
  },
};

export const gmailSyncStatusToolDef = {
  name: 'gmail_sync_status',
  description:
    'What this node\'s local Gmail cache holds: thread + message counts, oldest/newest dates, last ' +
    'sync, window size, data dir. The cache is a WINDOW (default 10 days), NOT the mailbox — older ' +
    'mail was never fetched, so check here before trusting an empty gmail_search_local. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const gmailAttachmentsToolDef = {
  name: 'gmail_attachments',
  description:
    'List the attachments on ONE Gmail thread — filename, MIME type, size, which message, downloadable ' +
    'or not. Trigger words: "what\'s attached", "any attachments on that email". Pass `threadId` from ' +
    'a list/search. Metadata only — it does not download.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      threadId: { type: 'string', description: 'Thread id from a list/search result.' },
      limit: { type: 'number', description: 'Default 50, max 200.' },
    },
    required: ['threadId'],
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

export const gmailAliasesToolDef = {
  name: 'gmail_aliases',
  description:
    'List this Gmail account\'s "Send mail as" identities and which one is the DEFAULT. Trigger words: "which ' +
    'address do I send from", "my Gmail aliases". The default is NOT necessarily the signed-in address, so check ' +
    'here before sending, then pass `from` to gmail_send/gmail_reply/gmail_draft. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      refresh: { type: 'boolean', description: 'Re-read from Gmail settings instead of the cache (default false).' },
    },
  },
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
      body: { type: 'string', description: 'Message body (markdown by default).' },
      from: {
        type: 'string',
        description: 'Send-as identity (see gmail_aliases). Defaults to the account default, which is NOT always the primary address.',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'html'],
        description:
          "Default 'markdown' — rendered as real rich mail: bold, italics, links, bullet/numbered " +
          'lists, blockquotes.',
      },
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
      body: { type: 'string', description: 'Reply body (markdown by default).' },
      from: {
        type: 'string',
        description: 'Send-as identity (see gmail_aliases). Defaults to the account default, which is NOT always the primary address.',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'html'],
        description: "Default 'markdown' (rich-rendered, as in gmail_send).",
      },
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
      body: { type: 'string', description: 'Draft body (markdown by default).' },
      from: {
        type: 'string',
        description: 'Send-as identity (see gmail_aliases). Defaults to the account default, which is NOT always the primary address.',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'html'],
        description: "Default 'markdown' (rich-rendered, as in gmail_send).",
      },
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
  gmailSearchLocalToolDef,
  gmailSyncToolDef,
  gmailSyncStatusToolDef,
  gmailAttachmentsToolDef,
  gmailLabelsToolDef,
  gmailAliasesToolDef,
  gmailSendToolDef,
  gmailReplyToolDef,
  gmailDraftToolDef,
];

// ─── argument coercion ───────────────────────────────────────────────────────

/**
 * Connector-relayed MCP args do not always keep their JSON type — a number can
 * arrive as "25" and a boolean as "false". The pre-existing handlers below use
 * `typeof args.x === 'number'` and silently fall back to the default in that
 * case; that behavior is left untouched on purpose (it is the shipped contract
 * for those tools). New arguments use these tolerant readers instead.
 */
function numArg(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function boolArg(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
  }
  return undefined;
}

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

/** A local-cache hit is a thread row that may also name the matching message. */
interface LocalHit extends Omit<ThreadRow, 'unread'> {
  unread?: boolean;
  messageId?: string | null;
}

interface AttachmentRow {
  name: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  messageId: string | null;
  downloadable: boolean;
}

interface SyncStatusOut {
  threads: number;
  messages: number;
  oldestMs: number | null;
  newestMs: number | null;
  /** Epoch ms or an ISO string, depending on how the store persists it. */
  lastSyncAt: number | string | null;
  windowDays: number;
  dataDir: string;
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

/** Epoch-ms / ISO / null → a short, sortable stamp. */
function fmtWhen(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '(never)';
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

function fmtSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '? size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtAttachmentList(rows: AttachmentRow[], header: string): string {
  if (!rows.length) return `${header}\n(no attachments)`;
  const lines = rows.map((a) => {
    const bits = [fmtSize(a.sizeBytes), a.mimeType || 'unknown type'];
    if (!a.downloadable) bits.push('NOT downloadable');
    const msg = a.messageId ? `  msg=${a.messageId}` : '';
    return `  ${a.name || '(unnamed)'}  [${bits.join(' · ')}]${msg}`;
  });
  return `${header}\n${lines.join('\n')}`;
}

function fmtSyncStatus(d: SyncStatusOut): string {
  const span =
    d.oldestMs || d.newestMs ? `${fmtWhen(d.oldestMs)} → ${fmtWhen(d.newestMs)}` : '(empty cache)';
  return [
    `Local Gmail cache — a ${d.windowDays}-day WINDOW, not the whole mailbox.`,
    `  threads:   ${d.threads}`,
    `  messages:  ${d.messages}`,
    `  covers:    ${span}`,
    `  last sync: ${fmtWhen(d.lastSyncAt)}`,
    `  dataDir:   ${d.dataDir}`,
    '',
    'Mail older than the window was never fetched — widen it with gmail_sync, or query Gmail itself with gmail_search.',
  ].join('\n');
}

// ─── handlers ────────────────────────────────────────────────────────────────

async function handleStatus(): Promise<McpToolResult> {
  try {
    const d = await workerGet<{
      provider: string; host: string; self: string | null; loggedIn: boolean; backend: string;
      defaultSendAs?: string | null; sendAsCount?: number; ui?: string;
    }>('/gmail/status');
    // `sendAs` is reported separately from `account` on purpose: MEASURED, the
    // compose opens as an ALIAS, not as the signed-in address, so collapsing the
    // two would tell the caller the wrong thing about every message they send.
    const lines = [
      `Gmail connector on ${d.host}`,
      `  provider:  ${d.provider} (${d.backend})`,
      `  loggedIn:  ${d.loggedIn}`,
      `  account:   ${d.self || '(unknown)'}`,
      `  sends as:  ${d.defaultSendAs || '(unknown)'}${d.sendAsCount ? ` (${d.sendAsCount} identities — gmail_aliases)` : ''}`,
    ];
    if (d.ui && d.ui !== 'desktop') lines.push(`  UI:        ${d.ui} — reads/writes will refuse (MOBILE_UI)`);
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
  // `full` defaults to true at the route; only send it when the caller opted out.
  const full = boolArg(args.full);
  try {
    const q = new URLSearchParams({ id: threadId });
    if (full === false) q.set('full', 'false');
    const d = await workerGet<{
      threadId: string;
      subject: string | null;
      source?: string;
      messages: Array<{
        messageId: string | null;
        fromName: string | null;
        fromEmail: string | null;
        date: string | null;
        body: string;
        truncated?: boolean;
      }>;
    }>(`/gmail/thread?${q}`);
    const src = d.source ? ` · read from ${d.source}` : '';
    const head = `Subject: ${d.subject || '(no subject)'}\nThread:  ${d.threadId}\n${d.messages.length} message(s)${src}`;
    const body = d.messages
      .map((m, i) => {
        const who = m.fromName ? `${m.fromName}${m.fromEmail ? ` <${m.fromEmail}>` : ''}` : m.fromEmail || '(unknown)';
        const clip = m.truncated ? '\n[body truncated by the connector — re-read with full:true for the raw source]' : '';
        return `\n─── [${i + 1}] ${who}${m.date ? `  ${m.date}` : ''} ───\n${m.body || '(empty body)'}${clip}`;
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

async function handleSearchLocal(args: Record<string, unknown>): Promise<McpToolResult> {
  const query = String(args.q ?? '').trim();
  if (!query) return err('q is required — the words to look for in the local cache.');
  try {
    const q = new URLSearchParams({ q: query });
    const limit = numArg(args.limit);
    if (limit !== undefined) q.set('limit', String(limit));
    const d = await workerGet<{
      query: string;
      count: number;
      limit: number;
      windowDays: number;
      results: LocalHit[];
    }>(`/gmail/search-local?${q}`);
    const rows: ThreadRow[] = (d.results || []).map((h) => ({ ...h, unread: h.unread === true }));
    const more = d.count >= d.limit ? ` (capped at limit=${d.limit}; narrow the words or raise limit)` : '';
    const scope = ` in the local ${d.windowDays}-day cache`;
    const head = `${d.count} match(es) for "${d.query}"${scope}${more}`;
    if (!rows.length) {
      return ok(
        `${head}\n(no threads)\n\nThe cache only holds the synced window — run gmail_sync_status to see how far back it reaches, or gmail_search to ask Gmail itself.`,
      );
    }
    return ok(fmtThreadList(rows, head));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleSync(args: Record<string, unknown>): Promise<McpToolResult> {
  const body: Record<string, unknown> = {};
  const days = numArg(args.days);
  if (days !== undefined) body.days = days;
  if (typeof args.label === 'string' && args.label.trim()) body.label = args.label.trim();
  try {
    // workerPostRaw, not workerPost: a sync drives the browser for far longer
    // than workerPost's 30s ceiling. 120s is still a ceiling — a wide window can
    // exceed it, which is why the tool tells callers to widen `days` in steps.
    const resp = await workerPostRaw('/gmail/sync', body);
    if (resp.success === false) {
      const bits = [`Gmail sync failed: ${String(resp.error || 'unknown error')}`];
      if (resp.code) bits.push(`code: ${String(resp.code)}`);
      return err(bits.join('\n'));
    }
    const d = (resp.data || {}) as { threadsSynced?: number; messagesSynced?: number; windowDays?: number; label?: string };
    const where = d.label ? ` from ${d.label}` : '';
    return ok(
      [
        `Synced ${d.threadsSynced ?? 0} thread(s) / ${d.messagesSynced ?? 0} message(s)${where} into the local cache.`,
        `Window: last ${d.windowDays ?? days ?? 10} day(s). Older mail was not fetched — gmail_search still reaches it.`,
        'gmail_search_local can now answer from this cache without a browser.',
      ].join('\n'),
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleSyncStatus(): Promise<McpToolResult> {
  try {
    return ok(fmtSyncStatus(await workerGet<SyncStatusOut>('/gmail/sync-status')));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleAttachments(args: Record<string, unknown>): Promise<McpToolResult> {
  const threadId = String(args.threadId ?? '').trim();
  if (!threadId) return err('threadId is required (get one from gmail_list_threads or gmail_search).');
  try {
    const q = new URLSearchParams({ threadId });
    const limit = numArg(args.limit);
    if (limit !== undefined) q.set('limit', String(limit));
    const d = await workerGet<{
      threadId: string;
      count: number;
      limit: number;
      total?: number;
      attachments: AttachmentRow[];
    }>(`/gmail/attachments?${q}`);
    // `total` is the PRE-cap count, so a truncated list never reads as complete.
    // Without it, fall back to the weaker count>=limit signal.
    const total = typeof d.total === 'number' ? d.total : d.count;
    const capped = typeof d.total === 'number' ? d.total > d.count : d.count >= d.limit;
    const more = capped ? ` (capped at limit=${d.limit}, showing ${d.count} of ${total}; raise limit for the rest)` : '';
    return ok(fmtAttachmentList(d.attachments, `${d.count} attachment(s) on thread ${d.threadId}${more}`));
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


interface AliasRow {
  email: string;
  name: string | null;
  isDefault: boolean;
  alias: boolean;
}

async function handleAliases(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const q = boolArg(args.refresh) === true ? '?refresh=true' : '';
    const d = await workerGet<{ count: number; defaultSendAs: string | null; checkedAt: number | null; identities: AliasRow[] }>(
      `/gmail/aliases${q}`,
    );
    if (!d.identities.length) {
      return ok('No "Send mail as" identities could be read from Gmail settings — the account may have only its primary address.');
    }
    const rows = d.identities.map((a) => {
      const who = a.name ? `${a.name} <${a.email}>` : a.email;
      const flags = [a.isDefault ? 'DEFAULT' : '', a.alias ? '' : 'not an alias'].filter(Boolean).join(', ');
      return `  ${who}${flags ? `  [${flags}]` : ''}`;
    });
    return ok(
      [
        `${d.count} send-as identity(ies); default = ${d.defaultSendAs || '(unknown)'}`,
        ...rows,
        '',
        'Pass `from` to gmail_send / gmail_reply / gmail_draft to send as a specific one.',
      ].join('\n'),
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/** `format` is validated at the route (which refuses an unknown value loudly);
 *  the tool only forwards what the caller asked for. */
function fmtArg(args: Record<string, unknown>): string | undefined {
  return typeof args.format === 'string' && args.format.trim() ? args.format.trim() : undefined;
}

function fmtNote(requested: string | undefined, applied: string | undefined): string {
  const f = applied || requested || 'markdown';
  return f === 'markdown' ? ' (markdown rendered as rich text)' : ` (${f})`;
}

async function handleSend(args: Record<string, unknown>): Promise<McpToolResult> {
  const to = String(args.to ?? '').trim();
  const body = String(args.body ?? '');
  if (!to) return err('to is required.');
  if (!body.trim()) return err('body is required.');
  const format = fmtArg(args);
  try {
    const payload: Record<string, unknown> = { to, subject: String(args.subject ?? ''), body };
    if (format) payload.format = format;
    if (typeof args.from === 'string' && args.from.trim()) payload.from = args.from.trim();
    const d = await workerPost<{ to: string; subject: string; format?: string; from?: string | null; note?: string }>(
      '/gmail/send',
      payload,
    );
    // `from` is READ BACK from the compose, never assumed — say which identity
    // actually sent, because the account default is not the primary address.
    const who = d.from ? ` as ${d.from}` : ' (sending identity UNVERIFIED)';
    return ok(`Sent to ${d.to}${d.subject ? ` — "${d.subject}"` : ''}${who}${fmtNote(format, d.format)}.${d.note ? `\nNote: ${d.note}` : ''}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleReply(args: Record<string, unknown>): Promise<McpToolResult> {
  const threadId = String(args.threadId ?? '').trim();
  const body = String(args.body ?? '');
  if (!threadId) return err('threadId is required (get one from gmail_list_threads or gmail_search).');
  if (!body.trim()) return err('body is required.');
  const format = fmtArg(args);
  try {
    const payload: Record<string, unknown> = { threadId, body };
    if (format) payload.format = format;
    if (typeof args.from === 'string' && args.from.trim()) payload.from = args.from.trim();
    const d = await workerPost<{ threadId: string; mode?: string; format?: string; from?: string | null; note?: string }>(
      '/gmail/reply',
      payload,
    );
    const who = d.from ? ` as ${d.from}` : ' (sending identity UNVERIFIED)';
    return ok(
      `Replied to thread ${d.threadId}${d.mode === 'reply_all' ? ' (reply-all)' : ''}${who}${fmtNote(format, d.format)}.` +
        (d.note ? `\nNote: ${d.note}` : ''),
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleDraft(args: Record<string, unknown>): Promise<McpToolResult> {
  const body = String(args.body ?? '');
  if (!body.trim()) return err('body is required.');
  const format = fmtArg(args);
  try {
    const payload: Record<string, unknown> = {
      to: String(args.to ?? ''),
      subject: String(args.subject ?? ''),
      body,
    };
    if (format) payload.format = format;
    if (typeof args.from === 'string' && args.from.trim()) payload.from = args.from.trim();
    const d = await workerPost<{ to: string; subject: string; format?: string }>('/gmail/draft', payload);
    return ok(
      `Draft saved${d.to ? ` for ${d.to}` : ''}${d.subject ? ` — "${d.subject}"` : ''}${fmtNote(format, d.format)}. ` +
        "It is in Gmail's Drafts, not sent.",
    );
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
  gmail_search_local: handleSearchLocal,
  gmail_sync: handleSync,
  gmail_sync_status: () => handleSyncStatus(),
  gmail_attachments: handleAttachments,
  gmail_labels: () => handleLabels(),
  gmail_aliases: handleAliases,
  gmail_send: handleSend,
  gmail_reply: handleReply,
  gmail_draft: handleDraft,
};
