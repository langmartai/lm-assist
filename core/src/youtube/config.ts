/**
 * YouTube connector — configuration (local / CDP deployment).
 *
 * Like the Gmail and LinkedIn connectors, this drives a real youtube.com session
 * in a controlled Chrome over the Chrome DevTools Protocol rather than calling the
 * YouTube Data API. That is a deliberate, house-standard choice:
 *   - the Data API needs an API key + OAuth project and enforces a daily quota;
 *   - a channel's video list and a video's transcript are BOTH readable from the
 *     rendered watch/channel pages the operator's own browser already loads, and
 *     the transcript is served by the SAME in-page caption endpoint the player
 *     uses (fetched from inside the page, cookies attached — see cdp-client).
 *
 * Unlike Gmail/LinkedIn, YouTube reads here are PUBLIC: the connector does not
 * REQUIRE a signed-in account to list a channel's videos or fetch a transcript.
 * A login is still SUPPORTED (it persists a consent choice, unlocks age-gated
 * content, and personalises nothing we read) — but the hard precondition is only
 * that the driver browser is RUNNING on this node, not that it is signed in.
 *
 * ── What lives HERE vs in cdp-client.ts ──────────────────────────────────────
 * This file owns DEPLOYMENT facts (paths, ports, the debug endpoint, the
 * viewport, limits). cdp-client.ts owns DOM facts (selectors, page snippets). A
 * selector must never appear in this file, and a file path must never appear in
 * that one.
 *
 * Files live under `~/.lm-assist/youtube[-dev].json` + `~/.lm-assist/youtube[-dev]/`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mirror the dev/prod split used by connectors.ts / hub config: a build that
// runs from the repo (not node_modules) talks to the dev files.
const IS_DEV_REPO = process.env.LM_ASSIST_PROD === 'true' ? false : !__dirname.includes('node_modules');
const DEV_SUFFIX = IS_DEV_REPO ? '-dev' : '';

const LM_DIR = path.join(os.homedir(), '.lm-assist');
export const YT_CONFIG_FILE = path.join(LM_DIR, `youtube${DEV_SUFFIX}.json`);
/** Directory holding the login profile for this env. */
export const YT_DATA_DIR = path.join(LM_DIR, `youtube${DEV_SUFFIX}`);

/**
 * Default remote-debug port for the YouTube login/driver browser. 9225 so it does
 * not collide with WhatsApp's 9222, LinkedIn's 9223 or Gmail's 9224 — all four
 * can run side by side on one host.
 */
export const DEFAULT_LOGIN_PORT = 9225;

/**
 * The viewport the driver page is forced to at connect
 * (`Emulation.setDeviceMetricsOverride`). A desktop width so YouTube renders the
 * grid channel/videos layout and the description + transcript affordances rather
 * than a narrow/mobile fallback. 1280x900 is comfortably in desktop range for
 * YouTube and cheap to raster.
 */
export const VIEWPORT = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false } as const;

export interface YoutubeConfig {
  /** Optional stable persistent-profile name (default 'youtube'). */
  profile?: string;
  /** The signed-in account name, cached from the last status probe (best-effort). */
  selfName?: string;
}

/** Fields a caller may set via PUT /youtube/config. */
export const CONFIG_FIELDS: ReadonlyArray<keyof YoutubeConfig> = ['profile', 'selfName'];

export function readYoutubeConfig(): YoutubeConfig {
  try {
    return JSON.parse(fs.readFileSync(YT_CONFIG_FILE, 'utf-8')) as YoutubeConfig;
  } catch {
    return {};
  }
}

/** Merge `patch` into the saved config and persist (0600). Returns the merged config. */
export function writeYoutubeConfig(patch: Partial<YoutubeConfig>): YoutubeConfig {
  const next = { ...readYoutubeConfig(), ...patch };
  fs.mkdirSync(LM_DIR, { recursive: true });
  fs.writeFileSync(YT_CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/**
 * Per-transcript character ceiling. A long talk's transcript can run to tens of
 * thousands of characters; unbounded, one `youtube_transcript` could exceed an
 * MCP result ceiling. The full text is bounded on the way out and the truncation
 * is REPORTED, never silently dropped.
 */
export function maxTranscriptChars(): number {
  const raw = process.env.YOUTUBE_MAX_TRANSCRIPT_CHARS;
  const n = Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return 100_000;
  return Math.max(1_000, Math.min(Math.floor(n), 500_000));
}

// ─── CDP provider config ─────────────────────────────────────────────────────

/**
 * Which backend this node's YouTube connector uses. Only `cdp` is supported
 * (drive a youtube.com session over the Chrome DevTools Protocol). Overridable
 * via YOUTUBE_PROVIDER for forward-compat.
 */
export function youtubeProvider(): string {
  return process.env.YOUTUBE_PROVIDER || 'cdp';
}

/**
 * The CDP base URL for the provider. Honors an explicit YOUTUBE_CDP_URL, else
 * builds `http://localhost:<YOUTUBE_CDP_PORT|9225>` (the debug port the login
 * browser exposes).
 */
export function resolveCdpBase(): string {
  if (process.env.YOUTUBE_CDP_URL) return String(process.env.YOUTUBE_CDP_URL).replace(/\/+$/, '');
  const port = process.env.YOUTUBE_CDP_PORT || String(DEFAULT_LOGIN_PORT);
  return `http://localhost:${port}`;
}
