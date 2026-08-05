/**
 * YouTube Connector Routes (local / CDP deployment).
 *
 * Drives a youtube.com session over CDP (cdp-client.ts). Reads are PUBLIC — a
 * channel's video list and a video's transcript need only a RUNNING driver
 * browser on this node, not a sign-in. Every read is live (no local store).
 *
 *   GET  /youtube/status                    provider + browser/logged-in state
 *   GET  /youtube/channel-videos?channel=&limit=  list a channel's videos
 *   GET  /youtube/transcript?video=&lang=   fetch a video's transcript
 *   GET  /youtube/selfcheck?channel=&video= run the canary
 *   POST /youtube/login                     launch/drive a login browser
 *   GET  /youtube/login/status?port=        poll the login browser
 *   POST /youtube/keepalive                 warm the session (also runs on a timer)
 */

import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import * as os from 'os';
import { youtubeProvider, maxTranscriptChars } from '../../youtube/config';
import {
  cdpStatus,
  listChannelVideos,
  getVideoInfo,
  getTranscript,
  keepSessionWarm,
  YtError,
} from '../../youtube/cdp-client';
import { youtubeLogin, youtubeLoginStatus, youtubeProfileExists } from '../../youtube/login';
import { runSelfcheck } from '../../youtube/selfcheck';
import { startYoutubeKeepAlive } from '../../youtube/keepalive';

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Map a thrown error to the structured { success:false, error } envelope. */
function fail(e: unknown): { success: false; error: string; code?: string } {
  if (e instanceof YtError) return { success: false, error: e.message, code: e.code };
  return { success: false, error: e instanceof Error ? e.message : String(e) };
}

export function createYoutubeRoutes(_ctx: RouteContext): RouteHandler[] {
  // Start the (default-disabled) keep-alive once at Core boot. Idempotent, quiet.
  startYoutubeKeepAlive();
  return [
    // GET /youtube/status — provider + browser reachability + logged-in state.
    {
      method: 'GET',
      pattern: /^\/youtube\/status$/,
      handler: async () => {
        let loggedIn = false;
        let self: string | null = null;
        let browserRunning = false;
        try {
          const s = await cdpStatus();
          browserRunning = true;
          loggedIn = s.loggedIn;
          self = s.self;
        } catch {
          /* CDP unreachable — report browserRunning:false but still answer */
        }
        return {
          success: true,
          data: {
            provider: youtubeProvider(),
            location: 'local',
            host: os.hostname(),
            backend: 'cdp-browser',
            browserRunning,
            credentialOnDisk: youtubeProfileExists(),
            loggedIn,
            self,
          },
        };
      },
    },

    // GET /youtube/channel-videos?channel=&limit= — list a channel's videos.
    {
      method: 'GET',
      pattern: /^\/youtube\/channel-videos$/,
      handler: async (req: ParsedRequest) => {
        const channel = String(req.query?.channel || '').trim();
        if (!channel) return { success: false, error: '`channel` query param (handle, URL, id, or name) is required' };
        const limit = clampInt(req.query?.limit, 30, 1, 200);
        try {
          return { success: true, data: await listChannelVideos(channel, limit) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // GET /youtube/video?video= — fetch one video's metadata + description.
    {
      method: 'GET',
      pattern: /^\/youtube\/video$/,
      handler: async (req: ParsedRequest) => {
        const video = String(req.query?.video || '').trim();
        if (!video) return { success: false, error: '`video` query param (watch URL or video id) is required' };
        try {
          return { success: true, data: await getVideoInfo(video) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // GET /youtube/transcript?video=&lang= — fetch a video's transcript.
    {
      method: 'GET',
      pattern: /^\/youtube\/transcript$/,
      handler: async (req: ParsedRequest) => {
        const video = String(req.query?.video || '').trim();
        if (!video) return { success: false, error: '`video` query param (watch URL or video id) is required' };
        const lang = String(req.query?.lang || '').trim();
        try {
          const t = await getTranscript(video, lang);
          // Bound the flattened text on the way out; REPORT truncation, never drop it.
          const cap = maxTranscriptChars();
          const full = t.segments.map((s) => s.text).join(' ');
          const truncated = full.length > cap;
          const text = truncated ? full.slice(0, cap) : full;
          return {
            success: true,
            data: {
              videoId: t.videoId,
              title: t.title,
              lengthSeconds: t.lengthSeconds,
              lang: t.lang,
              trackName: t.trackName,
              isAuto: t.isAuto,
              availableLangs: t.availableLangs,
              segmentCount: t.segments.length,
              segments: t.segments,
              text,
              truncated,
              charCount: full.length,
            },
          };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // GET /youtube/selfcheck?channel=&video= — run the canary.
    {
      method: 'GET',
      pattern: /^\/youtube\/selfcheck$/,
      handler: async (req: ParsedRequest) => {
        const channel = req.query?.channel ? String(req.query.channel) : undefined;
        const video = req.query?.video ? String(req.query.video) : undefined;
        try {
          return { success: true, data: await runSelfcheck({ channel, video }) };
        } catch (e) {
          return fail(e);
        }
      },
    },

    // POST /youtube/login — launch a controlled Chrome at youtube.com. Body:
    //   { port?, headless?, profile? }. The browser stays alive; close it later
    //   via POST /browser/close {pid}.
    {
      method: 'POST',
      pattern: /^\/youtube\/login$/,
      handler: async (req: ParsedRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const port = typeof body.port === 'number' ? body.port : undefined;
        const headless = typeof body.headless === 'boolean' ? body.headless : undefined;
        const profile = typeof body.profile === 'string' ? body.profile : undefined;
        const res = await youtubeLogin({ port, headless, profile });
        if (!res.ok) {
          return { success: false, error: res.message, code: res.code, hint: res.hint, installedBrowsers: res.installedBrowsers };
        }
        return { success: true, data: res };
      },
    },

    // GET /youtube/login/status?port= — poll the login browser.
    {
      method: 'GET',
      pattern: /^\/youtube\/login\/status$/,
      handler: async (req: ParsedRequest) => {
        const port = req.query?.port ? clampInt(req.query.port, 9225, 1, 65535) : undefined;
        const res = await youtubeLoginStatus({ port });
        if ('ok' in res && res.ok === false) {
          return { success: false, error: res.message, code: res.code, hint: res.hint };
        }
        return { success: true, data: res };
      },
    },

    // POST /youtube/keepalive — one authenticated warm-up (also runs on a timer).
    {
      method: 'POST',
      pattern: /^\/youtube\/keepalive$/,
      handler: async () => {
        try {
          return { success: true, data: await keepSessionWarm() };
        } catch (e) {
          return fail(e);
        }
      },
    },
  ];
}
