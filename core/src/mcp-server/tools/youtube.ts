/**
 * YouTube connector MCP tools.
 *
 * ONE CDP-backed surface: this node drives a youtube.com session over the Chrome
 * DevTools Protocol. Reads are PUBLIC — a channel's video list, one video's
 * metadata, and a video's transcript need only a RUNNING driver browser on this
 * node, not a sign-in (a login is supported for age-gated content). No YouTube
 * Data API, no quota, no key — modelled on the Gmail connector's browser bridge.
 *
 * Each tool wraps this node's own `/youtube/*` REST route on loopback (single
 * source of truth), so identical behavior is reachable from the stdio MCP, the
 * HTTP `/mcp` endpoint, and remotely via the hub relay.
 *
 * Wiring: registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts),
 * scoped in configure.ts TOOL_SCOPES, and catalogued in registry/catalog.ts. A
 * missing TOOL_SCOPES entry CRASHES Core on every tools/list — keep all three in
 * sync.
 */

import { ok, err, workerGet, workerGetLong, workerPostRaw, type McpToolResult } from './_passthrough';

export const youtubeStatusToolDef = {
  name: 'youtube_status',
  description:
    'YouTube connector status on this node: provider, whether the driver browser is running, whether ' +
    'a login profile exists, and (best-effort) whether signed in. Public reads (channel videos, video ' +
    'info, transcripts) work even with NO browser — the browser is only the authenticated fallback ' +
    'for age-gated content (youtube_login). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const youtubeLoginToolDef = {
  name: 'youtube_login',
  description:
    'Launch a Chrome at youtube.com on THIS node so the connector has an authenticated fallback ' +
    '(age-gated content, a persisted consent choice). Trigger words: "open YouTube", "log in to ' +
    'YouTube". Public reads work WITHOUT this. ADMIN — launches a real browser. Default debug port ' +
    '9225 (distinct from WhatsApp 9222 / LinkedIn 9223 / Gmail 9224).',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      port: { type: 'number', description: 'Debug port for the launched browser (default 9225).' },
      headless: { type: 'boolean', description: 'Run without a window (default false). Headed is required to sign in.' },
    },
  },
};

export const youtubeChannelVideosToolDef = {
  name: 'youtube_channel_videos',
  description:
    'List a YouTube channel\'s videos, newest first. Trigger words: "list videos from the … channel", ' +
    '"what has … uploaded", "recent uploads from …". Pass `channel` — a handle (@Google), channel ' +
    'URL, id (UC…), or a name to search. Each video returns id, title, watch URL, views, published ' +
    'label, and duration. The grid is lazy-loaded: returns the newest up to `limit` (reports hitLimit). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      channel: { type: 'string', description: 'Channel handle (@name), URL, id (UC…), or a name to search.' },
      limit: { type: 'number', description: 'Max videos to return (default 30, max 200).' },
    },
    required: ['channel'],
  },
};

export const youtubeVideoToolDef = {
  name: 'youtube_video',
  description:
    'Get one YouTube video\'s details from its URL or id. Trigger words: "what is this YouTube video ' +
    'about", "who posted this video". Pass `video` — a watch/youtu.be/shorts URL or bare 11-char id. ' +
    'Returns title, channel, publish date, length, views, description, keywords, and whether captions ' +
    'exist (fetch them with youtube_transcript). Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      video: { type: 'string', description: 'Watch/youtu.be/shorts URL or bare 11-char id.' },
    },
    required: ['video'],
  },
};

export const youtubeTranscriptToolDef = {
  name: 'youtube_transcript',
  description:
    'Fetch a YouTube video\'s transcript (captions) as timestamped text. Trigger words: "transcript ' +
    'of this video", "what does … say in the video", "captions for youtu.be/…". Pass `video` (watch/' +
    'youtu.be/shorts URL or bare id) and optional `lang` (BCP-47, e.g. "en"; omit to auto-pick a human ' +
    'track, else auto-generated). Returns full text + per-segment start times. NO_CAPTIONS if none. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      video: { type: 'string', description: 'Watch/youtu.be/shorts URL or bare 11-char id.' },
      lang: { type: 'string', description: 'Optional BCP-47 language code (e.g. "en", "es"). Omit to auto-pick.' },
    },
    required: ['video'],
  },
};

export const youtubeSelfcheckToolDef = {
  name: 'youtube_selfcheck',
  description:
    'Run the YouTube connector self-check on this node: drives the live browser end to end (channel ' +
    'video list + a transcript) and reports pass/fail/skip per check. Use after a deploy or when a ' +
    'read looks wrong. Optional `channel`/`video` override the defaults. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      channel: { type: 'string', description: 'Channel to list in the check (default @YouTube).' },
      video: { type: 'string', description: 'Video to transcribe (default: first captioned channel video).' },
    },
  },
};

export const YOUTUBE_TOOL_DEFS = [
  youtubeStatusToolDef,
  youtubeLoginToolDef,
  youtubeChannelVideosToolDef,
  youtubeVideoToolDef,
  youtubeTranscriptToolDef,
  youtubeSelfcheckToolDef,
] as const;

// ─── Handlers ────────────────────────────────────────────────────

interface YtStatusOut {
  provider: string;
  location: string;
  host: string;
  backend: string;
  browserRunning: boolean;
  credentialOnDisk: boolean;
  loggedIn: boolean;
  self: string | null;
}

async function handleStatus(): Promise<McpToolResult> {
  try {
    const d = await workerGet<YtStatusOut>('/youtube/status');
    const lines = [
      `Provider: ${d.provider} (${d.location} · ${d.backend})`,
      `Host: ${d.host}`,
      `Browser running: ${d.browserRunning ? 'yes' : 'no'}`,
      `Login profile on disk: ${d.credentialOnDisk ? 'yes' : 'no'}`,
      `Signed in: ${d.loggedIn ? 'yes' : 'no'}${d.self ? ` (${d.self})` : ''}`,
    ];
    if (!d.browserRunning) lines.push('Driver browser not running — public reads still work; run youtube_login only for age-gated content.');
    return ok(`YouTube connector status:\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface YtLoginOut {
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
    const resp = await workerPostRaw('/youtube/login', body);
    if (resp.success === false) {
      const parts = [String(resp.error || 'login failed')];
      if (resp.code) parts.push(`(${resp.code})`);
      if (resp.hint) parts.push(`Hint: ${resp.hint}`);
      if (Array.isArray(resp.installedBrowsers)) parts.push(`Installed browsers: ${resp.installedBrowsers.join(', ') || '(none)'}`);
      return err(parts.join(' '));
    }
    const d = (resp.data || {}) as YtLoginOut;
    if (d.loggedIn) {
      return ok(`YouTube driver browser is up and SIGNED IN on this node${d.self ? ` as ${d.self}` : ''} (pid ${d.pid}, CDP ${d.cdpUrl}). Reads and age-gated content are available.`);
    }
    const lines = [
      `YouTube driver browser is up on this node (pid ${d.pid}, CDP ${d.cdpUrl}). Public reads work now.`,
      d.note || 'Sign in in the open window only if you need age-gated content, then run youtube_status.',
    ];
    return ok(lines.join('\n'));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface ChannelVideoOut {
  videoId: string;
  title: string;
  url: string;
  views: string;
  published: string;
  duration: string;
}

async function handleChannelVideos(args: Record<string, unknown>): Promise<McpToolResult> {
  const channel = String(args.channel || '').trim();
  if (!channel) return err('`channel` (handle, URL, id, or name) is required.');
  const limit = args.limit ? Number(args.limit) : 30;
  try {
    const d = await workerGetLong<{ channel: string | null; channelUrl: string; count: number; hitLimit: boolean; videos: ChannelVideoOut[] }>(
      `/youtube/channel-videos?channel=${encodeURIComponent(channel)}&limit=${limit}`,
      120000,
    );
    if (!d.videos.length) return ok(`No videos found for ${d.channel || channel}.`);
    const lines = d.videos.map((v, i) => {
      const meta = [v.duration, v.views, v.published].filter(Boolean).join(' · ');
      return `${i + 1}. ${v.title}${meta ? `  [${meta}]` : ''}\n   ${v.url}`;
    });
    const head = `${d.channel || channel} — ${d.videos.length} video${d.videos.length === 1 ? '' : 's'}${d.hitLimit ? ` (limit hit; older videos exist)` : ''}:`;
    return ok(`${head}\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface VideoInfoOut {
  videoId: string;
  url: string;
  title: string | null;
  channel: string | null;
  channelUrl: string | null;
  published: string | null;
  lengthSeconds: number | null;
  views: number | null;
  description: string;
  keywords: string[];
  isLive: boolean;
  hasCaptions: boolean;
}

function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

async function handleVideo(args: Record<string, unknown>): Promise<McpToolResult> {
  const video = String(args.video || '').trim();
  if (!video) return err('`video` (watch URL or video id) is required.');
  try {
    const d = await workerGetLong<VideoInfoOut>(`/youtube/video?video=${encodeURIComponent(video)}`, 90000);
    const meta = [
      d.channel ? `Channel: ${d.channel}` : '',
      d.published ? `Published: ${d.published}` : '',
      d.lengthSeconds ? `Length: ${fmtDuration(d.lengthSeconds)}` : '',
      d.views != null ? `Views: ${d.views.toLocaleString()}` : '',
      d.isLive ? 'LIVE' : '',
      `Captions: ${d.hasCaptions ? 'available (youtube_transcript)' : 'none'}`,
    ].filter(Boolean);
    const desc = (d.description || '').replace(/\s+\n/g, '\n').trim();
    const descBlock = desc ? `\n\nDescription:\n${desc.slice(0, 1500)}${desc.length > 1500 ? '…' : ''}` : '';
    return ok(`${d.title || '(untitled)'}\n${d.url}\n${meta.join('\n')}${descBlock}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface TranscriptOut {
  videoId: string;
  title: string | null;
  lengthSeconds: number | null;
  lang: string;
  trackName: string;
  isAuto: boolean;
  availableLangs: string[];
  segmentCount: number;
  segments: Array<{ start: number; text: string }>;
  text: string;
  truncated: boolean;
  charCount: number;
}

function fmtTs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function handleTranscript(args: Record<string, unknown>): Promise<McpToolResult> {
  const video = String(args.video || '').trim();
  if (!video) return err('`video` (watch URL or video id) is required.');
  const lang = args.lang ? `&lang=${encodeURIComponent(String(args.lang))}` : '';
  try {
    const d = await workerGetLong<TranscriptOut>(`/youtube/transcript?video=${encodeURIComponent(video)}${lang}`, 90000);
    const header =
      `Transcript for ${d.videoId}${d.title ? ` — "${d.title}"` : ''} ` +
      `[${d.lang}${d.isAuto ? ' auto-generated' : ''}, ${d.segmentCount} segments${d.truncated ? ', truncated' : ''}]` +
      (d.availableLangs.length > 1 ? `\nAvailable languages: ${d.availableLangs.join(', ')}` : '');
    // Include timestamped lines for the first stretch, then the flat text — keeps
    // the result useful for citation without exploding on a long talk.
    const previewCount = Math.min(d.segments.length, 60);
    const lines = d.segments.slice(0, previewCount).map((s) => `[${fmtTs(s.start)}] ${s.text}`);
    const more = d.segments.length > previewCount ? `\n… (${d.segments.length - previewCount} more segments; full text below)\n\n${d.text}` : '';
    return ok(`${header}\n\n${lines.join('\n')}${more}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface SelfcheckOut {
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  checks: Array<{ name: string; status: string; detail: string }>;
  durationMs: number;
}

async function handleSelfcheck(args: Record<string, unknown>): Promise<McpToolResult> {
  const qs: string[] = [];
  if (args.channel) qs.push(`channel=${encodeURIComponent(String(args.channel))}`);
  if (args.video) qs.push(`video=${encodeURIComponent(String(args.video))}`);
  const q = qs.length ? `?${qs.join('&')}` : '';
  try {
    const d = await workerGetLong<SelfcheckOut>(`/youtube/selfcheck${q}`, 180000);
    const icon = (s: string) => (s === 'pass' ? '✅' : s === 'fail' ? '❌' : '⏭️');
    const lines = d.checks.map((c) => `${icon(c.status)} ${c.name} — ${c.detail}`);
    const head = `YouTube selfcheck: ${d.ok ? 'OK' : 'FAILED'} — ${d.passed} passed, ${d.failed} failed, ${d.skipped} skipped (${Math.round(d.durationMs / 1000)}s)`;
    return ok(`${head}\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const YOUTUBE_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  youtube_status: () => handleStatus(),
  youtube_login: handleLogin,
  youtube_channel_videos: handleChannelVideos,
  youtube_video: handleVideo,
  youtube_transcript: handleTranscript,
  youtube_selfcheck: handleSelfcheck,
};
