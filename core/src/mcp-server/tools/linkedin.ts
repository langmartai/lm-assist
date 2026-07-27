/**
 * LinkedIn connector MCP tools.
 *
 * ONE CDP-backed surface: this node drives a logged-in linkedin.com session
 * (the operator's OWN account) over the Chrome DevTools Protocol and mirrors
 * messaging into the shared store. Reads (conversations, thread messages, feed,
 * notifications) come from what the rendered page exposes — LinkedIn virtualizes
 * its lists, so reads capture the most-recent RENDERED items and accumulate in
 * the store across calls. Writes drive the real UI (send message, publish a feed
 * post, publish a long-form Article).
 *
 * Each tool wraps this node's own `/linkedin/*` REST route on loopback (single
 * source of truth), so the same behavior is reachable from the stdio MCP, the
 * HTTP `/mcp` endpoint, and remotely via the hub relay.
 *
 * Wiring: registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts) and
 * scoped in configure.ts TOOL_SCOPES.
 */

import { ok, err, workerGet, workerPost, workerPostRaw, type McpToolResult } from './_passthrough';

export const linkedinStatusToolDef = {
  name: 'linkedin_status',
  description:
    'Show this LinkedIn connector\'s status on this node: the provider (cdp), whether the driver ' +
    'browser is logged in, the signed-in account name if discoverable, and how many ' +
    'messages/conversations have been ingested. Use this to check setup before sending or posting. ' +
    'If loggedIn is false, run linkedin_login first. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const linkedinLoginToolDef = {
  name: 'linkedin_login',
  description:
    'Launch a controlled Chrome at linkedin.com on THIS node so the user can log in (email / ' +
    'password / 2FA), giving the connector a logged-in, driveable session. LinkedIn login is an ' +
    'ordinary password session persisted in a dedicated browser profile (no QR) — a one-time step; ' +
    'the profile keeps the session across restarts. ADMIN — it launches a real browser process. ' +
    'Trigger words: "log in to LinkedIn", "connect LinkedIn", "open the LinkedIn login". If the ' +
    'profile is already authenticated it returns loggedIn:true with no further action; otherwise a ' +
    'browser window opens for the user to log in — then poll linkedin_status until loggedIn:true. ' +
    'Default debug port 9223 (distinct from WhatsApp\'s 9222).',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      port: { type: 'number', description: 'Debug port for the launched browser (default 9223).' },
      headless: { type: 'boolean', description: 'Run without a window (default false). Headed is required for the user to log in / solve 2FA.' },
    },
  },
};

export const linkedinListConversationsToolDef = {
  name: 'linkedin_list_conversations',
  description:
    'List this LinkedIn account\'s messaging conversations (one per person/group), most-recently-' +
    'active first. Trigger words: "my LinkedIn messages", "who messaged me on LinkedIn", "recent ' +
    'LinkedIn conversations". Each conversation shows the participant name, last-message preview, ' +
    'total + unread counts. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: { type: 'number', description: 'Max conversations to return (default 30, max 200).' },
    },
  },
};

export const linkedinReadMessagesToolDef = {
  name: 'linkedin_read_messages',
  description:
    'Read the messages of one LinkedIn conversation, in chronological order. Trigger words: "read ' +
    'my LinkedIn chat with …", "show the LinkedIn thread from …", "what did X say on LinkedIn". Pass ' +
    '`chat` — the participant name (or thread id) from linkedin_list_conversations. Optionally ' +
    '`markRead:true` to reset that conversation\'s unread count. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      chat: { type: 'string', description: 'Participant name or thread id identifying the conversation.' },
      limit: { type: 'number', description: 'Max most-recent messages (default 30, max 500).' },
      markRead: { type: 'boolean', description: 'Mark the conversation read up to now (default false).' },
    },
    required: ['chat'],
  },
};

export const linkedinSearchToolDef = {
  name: 'linkedin_search',
  description:
    'Search the text of this account\'s ingested/cached LinkedIn messages (substring, case-' +
    'insensitive), most-recent first. Trigger words: "find the LinkedIn message where …", "search ' +
    'my LinkedIn for …". Returns matching messages with their conversation + timestamp. Read-only.',
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

export const linkedinSendMessageToolDef = {
  name: 'linkedin_send_message',
  description:
    'Send a direct message in a LinkedIn conversation from this node\'s account. Trigger words: ' +
    '"message … on LinkedIn", "send a LinkedIn message to …", "DM … on LinkedIn". Pass `to` (the ' +
    'participant name or thread id of an EXISTING conversation, from linkedin_list_conversations) ' +
    'and `text` (the message body). Opens the conversation and sends. Returns the messageId. Write ' +
    'tool — confirm the recipient + content.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Recipient — the participant name or thread id of an existing conversation.' },
      text: { type: 'string', description: 'Message body (free-form text).' },
    },
    required: ['to', 'text'],
  },
};

export const linkedinReadFeedToolDef = {
  name: 'linkedin_read_feed',
  description:
    'Read the most-recent posts from this account\'s LinkedIn home feed. Trigger words: "what\'s on ' +
    'my LinkedIn feed", "recent LinkedIn posts", "show my LinkedIn timeline". Each post shows the ' +
    'author, text, and reaction/comment counts. Live scrape of the rendered feed (most-recent ' +
    'posts). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: { type: 'number', description: 'Max posts to return (default 15, max 50).' },
    },
  },
};

export const linkedinReadNotificationsToolDef = {
  name: 'linkedin_read_notifications',
  description:
    'Read this account\'s recent LinkedIn notifications (who reacted, commented, connected, viewed ' +
    'your profile, etc). Trigger words: "my LinkedIn notifications", "who reacted on LinkedIn", ' +
    '"any new LinkedIn activity". Live scrape of the rendered notifications tab. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: { type: 'number', description: 'Max notifications to return (default 20, max 50).' },
    },
  },
};

export const linkedinPostToolDef = {
  name: 'linkedin_post',
  description:
    'Publish a post to this account\'s LinkedIn feed (a normal share — short/medium text shown on ' +
    'your timeline and to your network). Trigger words: "post on LinkedIn", "share this on ' +
    'LinkedIn", "make a LinkedIn post". Pass `text` (the post body; @mentions/hashtags as plain ' +
    'text). This publishes PUBLICLY to your network — confirm the content with the user first. ' +
    'Write tool. For long-form articles use linkedin_publish_article instead.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      text: { type: 'string', description: 'The post body (free-form text).' },
    },
    required: ['text'],
  },
};

export const linkedinPublishArticleToolDef = {
  name: 'linkedin_publish_article',
  description:
    'Publish a long-form ARTICLE to this account\'s LinkedIn (the article/publishing tool — a titled, ' +
    'long body shown under your profile\'s Articles, distinct from a feed post). Trigger words: ' +
    '"write a LinkedIn article", "publish an article on LinkedIn". Pass `title` (the headline) and ' +
    '`body` (the article text). This publishes PUBLICLY under your name — confirm title + body with ' +
    'the user first. Write tool. For a short timeline post use linkedin_post instead.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'The article headline.' },
      body: { type: 'string', description: 'The article body text.' },
    },
    required: ['title', 'body'],
  },
};

export const linkedinSearchPeopleToolDef = {
  name: 'linkedin_search_people',
  description:
    'Find people on LinkedIn by name or keywords. Trigger words: "find … on LinkedIn", "search ' +
    'LinkedIn for …", "look up … on LinkedIn". Pass `q` (e.g. "Yi Huang databunny"). Returns the top ' +
    'matching profiles with name, handle, and profile URL — use the handle/URL with linkedin_connect, ' +
    'linkedin_follow, or linkedin_message_profile. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      q: { type: 'string', description: 'Name or keywords to search for.' },
      limit: { type: 'number', description: 'Max results (default 8, max 20).' },
    },
    required: ['q'],
  },
};

export const linkedinFollowToolDef = {
  name: 'linkedin_follow',
  description:
    'Follow a person on LinkedIn. Trigger words: "follow … on LinkedIn". Pass `profile` — a profile ' +
    'handle (e.g. "yipub"), a full /in/ URL, or a person\'s name (resolved via people search). Write ' +
    'tool — confirm who to follow.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: { profile: { type: 'string', description: 'Handle, /in/ URL, or name.' } },
    required: ['profile'],
  },
};

export const linkedinConnectToolDef = {
  name: 'linkedin_connect',
  description:
    'Send a connection request on LinkedIn. Trigger words: "connect with … on LinkedIn", "send a ' +
    'LinkedIn invite to …". Pass `profile` (handle, /in/ URL, or name) and an optional `note` (a short ' +
    'personalized message). This sends a real invitation — confirm the recipient. Write tool. Note: ' +
    'LinkedIn restricts connecting to some out-of-network profiles.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      profile: { type: 'string', description: 'Handle, /in/ URL, or name.' },
      note: { type: 'string', description: 'Optional personalized note (max ~300 chars).' },
    },
    required: ['profile'],
  },
};

export const linkedinMessageProfileToolDef = {
  name: 'linkedin_message_profile',
  description:
    'Message a person by their profile on LinkedIn (opens the profile and sends via its Message ' +
    'button — for starting a NEW conversation with someone). Trigger words: "message … on LinkedIn ' +
    'profile". Pass `profile` (handle, /in/ URL, or name) and `text`. For an EXISTING conversation, ' +
    'prefer linkedin_send_message. Write tool. Note: LinkedIn only allows messaging connections (or ' +
    'open-profile / InMail-enabled members).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      profile: { type: 'string', description: 'Handle, /in/ URL, or name.' },
      text: { type: 'string', description: 'Message body.' },
    },
    required: ['profile', 'text'],
  },
};

export const linkedinCommentToolDef = {
  name: 'linkedin_comment',
  description:
    'Comment on a LinkedIn feed post. Trigger words: "comment on the LinkedIn post …". Pass `text` ' +
    '(the comment) and optionally `match` (a substring of the post author or text to pick which post; ' +
    'omit to comment on the top feed post). This posts a PUBLIC comment — confirm the content. Write tool.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      text: { type: 'string', description: 'The comment body.' },
      match: { type: 'string', description: 'Optional substring of the post author/text to target a specific post.' },
    },
    required: ['text'],
  },
};

export const linkedinDeletePostToolDef = {
  name: 'linkedin_delete_post',
  description:
    'Delete one of YOUR OWN LinkedIn posts. Trigger words: "delete my LinkedIn post", "remove the ' +
    'post I made". Optionally pass `match` (a substring of the post text to pick which own post; omit ' +
    'to delete your most-recent own post). This permanently removes the post — confirm with the user. ' +
    'Write tool.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      match: { type: 'string', description: 'Optional substring of your post text to target a specific post.' },
    },
  },
};

export const LINKEDIN_TOOL_DEFS = [
  linkedinStatusToolDef,
  linkedinLoginToolDef,
  linkedinListConversationsToolDef,
  linkedinReadMessagesToolDef,
  linkedinSearchToolDef,
  linkedinSendMessageToolDef,
  linkedinReadFeedToolDef,
  linkedinReadNotificationsToolDef,
  linkedinPostToolDef,
  linkedinPublishArticleToolDef,
  linkedinSearchPeopleToolDef,
  linkedinFollowToolDef,
  linkedinConnectToolDef,
  linkedinMessageProfileToolDef,
  linkedinCommentToolDef,
  linkedinDeletePostToolDef,
] as const;

// ─── Handlers ────────────────────────────────────────────────────

interface LiMessageOut {
  chatId: string;
  direction: 'in' | 'out';
  type: string;
  text?: string;
  timestamp: number;
  status?: string;
  contactName?: string;
}
interface LiChatOut {
  chatId: string;
  name?: string;
  lastMessageAt: number;
  lastText?: string;
  lastDirection?: 'in' | 'out';
  messageCount: number;
  unreadCount: number;
}
interface FeedPostOut {
  actor: string;
  text: string;
  reactions: string;
  comments: string;
  urn: string;
}
interface NotificationOut {
  text: string;
  timeLabel: string;
  unread: boolean;
}

function fmtTime(unixSec: number): string {
  try {
    return new Date(unixSec * 1000).toISOString().replace('T', ' ').slice(0, 16);
  } catch {
    return String(unixSec);
  }
}

function fmtMessage(m: LiMessageOut): string {
  const who = m.direction === 'out' ? '→' : '←';
  const status = m.direction === 'out' && m.status ? ` [${m.status}]` : '';
  const text = m.text ?? `[${m.type}]`;
  return `  ${fmtTime(m.timestamp)} ${who} ${text}${status}`;
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
    }>('/linkedin/status');
    const lines = [
      `Provider: ${d.provider} (${d.location} · ${d.backend})`,
      `Host: ${d.host}`,
      `Logged in: ${d.loggedIn ? 'yes' : 'no'}`,
      `Account: ${d.self || '—'}`,
      `Ingested: ${d.totalMessages} messages across ${d.chats} conversations · ${d.unread} unread`,
    ];
    if (!d.loggedIn) lines.push('Not logged in — run linkedin_login to open a browser and sign in.');
    return ok(`LinkedIn connector status:\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface LiLoginOut {
  pid: number;
  port: number;
  cdpUrl: string;
  profileDir?: string;
  loggedIn: boolean;
  self?: string | null;
  note?: string;
}

async function handleLogin(args: Record<string, unknown>): Promise<McpToolResult> {
  const body: Record<string, unknown> = {};
  if (args.port !== undefined) body.port = Number(args.port);
  if (typeof args.headless === 'boolean') body.headless = args.headless;
  try {
    const resp = await workerPostRaw('/linkedin/login', body);
    if (resp.success === false) {
      const parts = [String(resp.error || 'login failed')];
      if (resp.code) parts.push(`(${resp.code})`);
      if (resp.hint) parts.push(`Hint: ${resp.hint}`);
      if (Array.isArray(resp.installedBrowsers)) parts.push(`Installed browsers: ${resp.installedBrowsers.join(', ') || '(none)'}`);
      return err(parts.join(' '));
    }
    const d = (resp.data || {}) as LiLoginOut;
    if (d.loggedIn) {
      return ok(`LinkedIn is logged in on this node${d.self ? ` as ${d.self}` : ''} (pid ${d.pid}, CDP ${d.cdpUrl}). The connector can drive it now.`);
    }
    const lines = [
      `Launched a LinkedIn login browser (pid ${d.pid}, CDP ${d.cdpUrl}).`,
      d.note || 'Log in in the open browser window (email / password / 2FA), then run linkedin_status until loggedIn:true.',
    ];
    return ok(lines.join('\n'));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleListConversations(args: Record<string, unknown>): Promise<McpToolResult> {
  const limit = args.limit ? Number(args.limit) : 30;
  try {
    const data = await workerGet<{ chats: LiChatOut[] }>(`/linkedin/conversations?limit=${limit}`);
    const chats = data.chats || [];
    if (chats.length === 0) return ok('No LinkedIn conversations ingested yet.');
    const lines = chats.map((c) => {
      const name = c.name ? c.name : c.chatId;
      const unread = c.unreadCount > 0 ? ` · ${c.unreadCount} unread` : '';
      const preview = c.lastText ? ` — "${c.lastText.slice(0, 60)}"` : '';
      return `- ${name}${unread} · ${c.messageCount} msgs · last ${fmtTime(c.lastMessageAt)}${preview}`;
    });
    return ok(`LinkedIn conversations (${chats.length}):\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleReadMessages(args: Record<string, unknown>): Promise<McpToolResult> {
  const chat = String(args.chat || '').trim();
  if (!chat) return err('`chat` (participant name or thread id) is required.');
  const limit = args.limit ? Number(args.limit) : 30;
  const markRead = args.markRead ? '&markRead=true' : '';
  try {
    const data = await workerGet<{ chatId: string; messages: LiMessageOut[] }>(
      `/linkedin/messages?chat=${encodeURIComponent(chat)}&limit=${limit}${markRead}`,
    );
    const messages = data.messages || [];
    if (messages.length === 0) return ok(`No messages stored for ${data.chatId}.`);
    const name = messages.find((m) => m.contactName)?.contactName;
    const header = name ? `LinkedIn with ${name}` : `LinkedIn conversation ${data.chatId}`;
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
    const data = await workerGet<{ query: string; results: LiMessageOut[] }>(
      `/linkedin/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    );
    const results = data.results || [];
    if (results.length === 0) return ok(`No LinkedIn messages match "${q}".`);
    const lines = results.map((m) => {
      const who = m.contactName || m.chatId;
      return `- ${fmtTime(m.timestamp)} ${m.direction === 'out' ? 'to' : 'from'} ${who}: "${(m.text || '').slice(0, 80)}"`;
    });
    return ok(`LinkedIn matches for "${q}" (${results.length}):\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleSendMessage(args: Record<string, unknown>): Promise<McpToolResult> {
  const to = String(args.to || '').trim();
  const text = String(args.text || '').trim();
  if (!to) return err('`to` (recipient conversation) is required.');
  if (!text) return err('`text` (message body) is required.');
  try {
    const data = await workerPost<{ messageId: string; to: string }>('/linkedin/send', { to, text });
    return ok(`Sent LinkedIn message to ${data.to}${data.messageId ? ` (id ${data.messageId})` : ''}.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleReadFeed(args: Record<string, unknown>): Promise<McpToolResult> {
  const limit = args.limit ? Number(args.limit) : 15;
  try {
    const data = await workerGet<{ posts: FeedPostOut[] }>(`/linkedin/feed?limit=${limit}`);
    const posts = data.posts || [];
    if (posts.length === 0) return ok('No LinkedIn feed posts rendered.');
    const lines = posts.map((p, i) => {
      const meta = [p.reactions ? `${p.reactions} reactions` : '', p.comments ? `${p.comments} comments` : ''].filter(Boolean).join(' · ');
      const text = (p.text || '').replace(/\s+/g, ' ').slice(0, 200);
      return `${i + 1}. ${p.actor || '(unknown)'}${meta ? ` [${meta}]` : ''}\n   ${text}`;
    });
    return ok(`LinkedIn feed (${posts.length}):\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleReadNotifications(args: Record<string, unknown>): Promise<McpToolResult> {
  const limit = args.limit ? Number(args.limit) : 20;
  try {
    const data = await workerGet<{ notifications: NotificationOut[] }>(`/linkedin/notifications?limit=${limit}`);
    const items = data.notifications || [];
    if (items.length === 0) return ok('No LinkedIn notifications rendered.');
    const lines = items.map((n) => {
      const dot = n.unread ? '● ' : '  ';
      const when = n.timeLabel ? ` (${n.timeLabel})` : '';
      return `${dot}${(n.text || '').replace(/\s+/g, ' ').slice(0, 160)}${when}`;
    });
    return ok(`LinkedIn notifications (${items.length}):\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handlePost(args: Record<string, unknown>): Promise<McpToolResult> {
  const text = String(args.text || '').trim();
  if (!text) return err('`text` (post body) is required.');
  try {
    await workerPost('/linkedin/post', { text });
    return ok(`Published a LinkedIn feed post (${text.length} chars).`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handlePublishArticle(args: Record<string, unknown>): Promise<McpToolResult> {
  const title = String(args.title || '').trim();
  const body = String(args.body || '').trim();
  if (!title) return err('`title` (article headline) is required.');
  if (!body) return err('`body` (article text) is required.');
  try {
    await workerPost('/linkedin/article', { title, body });
    return ok(`Published a LinkedIn article: "${title}".`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface PersonOut { name: string; handle: string; url: string; headline: string }

async function handleSearchPeople(args: Record<string, unknown>): Promise<McpToolResult> {
  const q = String(args.q || '').trim();
  if (!q) return err('`q` is required.');
  const limit = args.limit ? Number(args.limit) : 8;
  try {
    const data = await workerGet<{ results: PersonOut[] }>(`/linkedin/people?q=${encodeURIComponent(q)}&limit=${limit}`);
    const r = data.results || [];
    if (r.length === 0) return ok(`No LinkedIn people match "${q}".`);
    const lines = r.map((p) => `- ${p.name} (${p.handle})${p.headline ? ` — ${p.headline}` : ''}\n  ${p.url}`);
    return ok(`LinkedIn people for "${q}" (${r.length}):\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleFollow(args: Record<string, unknown>): Promise<McpToolResult> {
  const profile = String(args.profile || '').trim();
  if (!profile) return err('`profile` is required.');
  try {
    const d = await workerPost<{ following: boolean; alreadyFollowing: boolean }>('/linkedin/follow', { profile });
    return ok(d.alreadyFollowing ? `Already following ${profile}.` : `Followed ${profile}${d.following ? '' : ' (state unconfirmed)'}.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleConnect(args: Record<string, unknown>): Promise<McpToolResult> {
  const profile = String(args.profile || '').trim();
  if (!profile) return err('`profile` is required.');
  const body: Record<string, unknown> = { profile };
  if (args.note) body.note = String(args.note);
  try {
    const d = await workerPost<{ state: string }>('/linkedin/connect', body);
    return ok(`Connection request to ${profile}: ${d.state}.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleMessageProfile(args: Record<string, unknown>): Promise<McpToolResult> {
  const profile = String(args.profile || '').trim();
  const text = String(args.text || '').trim();
  if (!profile) return err('`profile` is required.');
  if (!text) return err('`text` is required.');
  try {
    await workerPost('/linkedin/message-profile', { profile, text });
    return ok(`Messaged ${profile} on LinkedIn.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleComment(args: Record<string, unknown>): Promise<McpToolResult> {
  const text = String(args.text || '').trim();
  if (!text) return err('`text` is required.');
  const body: Record<string, unknown> = { text };
  if (args.match) body.match = String(args.match);
  try {
    const d = await workerPost<{ postActor: string }>('/linkedin/comment', body);
    return ok(`Commented on the LinkedIn post${d.postActor ? ` by ${d.postActor}` : ''}.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleDeletePost(args: Record<string, unknown>): Promise<McpToolResult> {
  const body: Record<string, unknown> = {};
  if (args.match) body.match = String(args.match);
  try {
    await workerPost('/linkedin/delete-post', body);
    return ok('Deleted the LinkedIn post.');
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const LINKEDIN_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  linkedin_search_people: handleSearchPeople,
  linkedin_follow: handleFollow,
  linkedin_connect: handleConnect,
  linkedin_message_profile: handleMessageProfile,
  linkedin_comment: handleComment,
  linkedin_delete_post: handleDeletePost,
  linkedin_status: () => handleStatus(),
  linkedin_login: handleLogin,
  linkedin_list_conversations: handleListConversations,
  linkedin_read_messages: handleReadMessages,
  linkedin_search: handleSearch,
  linkedin_send_message: handleSendMessage,
  linkedin_read_feed: handleReadFeed,
  linkedin_read_notifications: handleReadNotifications,
  linkedin_post: handlePost,
  linkedin_publish_article: handlePublishArticle,
};
