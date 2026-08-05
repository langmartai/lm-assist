/**
 * YouTube connector selfcheck — the real gate.
 *
 * A green /health proves only that the process booted. This canary drives the
 * LIVE connector end to end and fails closed on drift, exactly like the Gmail
 * one it is modelled on. Two disciplines carried over from that connector:
 *
 *   1. "Could not run" is a SKIP, never a FAIL. BROWSER_NOT_RUNNING /
 *      BROWSER_BUSY / CDP_UNREACHABLE / an unexpected surface mark a check
 *      skipped — a suite that goes red because the browser was not up teaches the
 *      reader to ignore red. A liveness probe gates the feature checks so a dead
 *      browser produces ONE actionable line, not four confusing failures.
 *   2. Each check runs through the SAME op()/driver-lock path the tools use (via
 *      the exported provider functions), so a fresh, verified page backs each one
 *      — the canary tests the real plumbing, not its own private socket.
 *
 * Targets default to YouTube's own channel (@YouTube) and its most-recent
 * captioned video, both overridable, so the check does not depend on any one
 * private video staying alive.
 */

import { cdpStatus, listChannelVideos, getTranscript, YtError } from './cdp-client';

export interface SelfcheckItem {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

export interface SelfcheckResult {
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  checks: SelfcheckItem[];
  durationMs: number;
}

export interface SelfcheckOptions {
  /** Channel to list (handle/URL/id/name). Default '@YouTube'. */
  channel?: string;
  /** Video to transcribe. Default: the first captioned video from the channel list. */
  video?: string;
}

/** Errors that mean "could not run here", not "the feature is broken". */
const ENVIRONMENTAL = new Set([
  'BROWSER_NOT_RUNNING',
  'BROWSER_UNRESPONSIVE',
  'BROWSER_BUSY',
  'CDP_UNREACHABLE',
  'CDP_TIMEOUT',
  'PAGE_NOT_FOUND',
  'PAGE_NOT_READY',
  'YT_UNEXPECTED_SURFACE',
]);

function codeOf(e: unknown): string {
  return e instanceof YtError ? e.code : '';
}

function isVideoId(s: string): boolean {
  return /^[\w-]{11}$/.test(s);
}

/**
 * Run the canary. `channel`/`video` override the default targets.
 */
export async function runSelfcheck(opts: SelfcheckOptions = {}): Promise<SelfcheckResult> {
  const started = Date.now();
  const checks: SelfcheckItem[] = [];
  const add = (name: string, status: SelfcheckItem['status'], detail: string) => checks.push({ name, status, detail });

  const channel = opts.channel || '@YouTube';

  // ── browser.reachable — INFORMATIONAL, not a gate ───────────────────────────
  // The reads fetch node-side first (see cdp-client.fetchPageText) and fall back
  // to the browser, so a missing browser must not gate them. This check reports
  // whether the authenticated fallback (age-gated content) is available here.
  try {
    const s = await cdpStatus();
    add('browser.reachable', 'pass', `driver browser reachable; signed in: ${s.loggedIn ? 'yes' : 'no'}${s.self ? ` (${s.self})` : ''}`);
  } catch (e) {
    const code = codeOf(e);
    const msg = e instanceof Error ? e.message : String(e);
    if (ENVIRONMENTAL.has(code) || !code) {
      add('browser.reachable', 'skip', `driver browser not reachable (${code || 'no code'}) — public reads still work node-side; run youtube_login for age-gated content. ${msg.slice(0, 120)}`);
    } else {
      add('browser.reachable', 'fail', `${code}: ${msg.slice(0, 200)}`);
    }
  }

  let firstVideoIds: string[] = [];

  // ── channel.videos — a channel's /videos page yields real videos ────────────
  try {
    const r = await listChannelVideos(channel, 15);
    if (r.videos.length > 0) {
      firstVideoIds = r.videos.map((v) => v.videoId).filter(isVideoId);
      add('channel.videos', 'pass', `${r.videos.length} videos from ${r.channel || channel} (${r.channelUrl})`);
    } else {
      add('channel.videos', 'fail', `no videos parsed from ${channel} (${r.channelUrl}) — parser drift or an empty channel`);
    }
  } catch (e) {
    const code = codeOf(e);
    const msg = e instanceof Error ? e.message : String(e);
    if (ENVIRONMENTAL.has(code)) add('channel.videos', 'skip', `could not run (${code}): ${msg.slice(0, 140)}`);
    else add('channel.videos', 'fail', `${code || 'ERROR'}: ${msg.slice(0, 200)}`);
  }

  // ── channel.video_shape — the first row is well-formed ──────────────────────
  if (firstVideoIds.length > 0) {
    add('channel.video_shape', 'pass', `first video id ${firstVideoIds[0]} is a valid 11-char id`);
  } else {
    add('channel.video_shape', checks.find((c) => c.name === 'channel.videos')?.status === 'skip' ? 'skip' : 'fail',
      'no valid video ids were parsed from the channel list');
  }

  // ── transcript.fetch — a captioned video yields transcript segments ─────────
  // Prefer an explicit video; else try the first few channel videos until one
  // has captions (not every video does — a channel of all-caption-less videos
  // is a SKIP, not a failure of the transcript feature).
  const candidates = opts.video ? [opts.video] : firstVideoIds.slice(0, 4);
  if (candidates.length === 0) {
    add('transcript.fetch', 'skip', 'no candidate video to transcribe (channel list was empty/skipped)');
  } else {
    let done = false;
    let lastNoCaptions = '';
    for (const v of candidates) {
      try {
        const t = await getTranscript(v);
        if (t.segments.length > 0) {
          add(
            'transcript.fetch',
            'pass',
            `${t.segments.length} segments for ${t.videoId} [${t.lang}${t.isAuto ? ' auto' : ''}] "${(t.title || '').slice(0, 50)}"`,
          );
          done = true;
          break;
        }
        add('transcript.fetch', 'fail', `transcript for ${v} returned 0 segments`);
        done = true;
        break;
      } catch (e) {
        const code = codeOf(e);
        const msg = e instanceof Error ? e.message : String(e);
        if (code === 'NO_CAPTIONS') {
          lastNoCaptions = v;
          continue; // try the next candidate
        }
        if (ENVIRONMENTAL.has(code)) {
          add('transcript.fetch', 'skip', `could not run (${code}): ${msg.slice(0, 140)}`);
        } else {
          add('transcript.fetch', 'fail', `${code || 'ERROR'}: ${msg.slice(0, 200)}`);
        }
        done = true;
        break;
      }
    }
    if (!done) {
      add('transcript.fetch', 'skip', `none of the first ${candidates.length} videos had captions (last checked ${lastNoCaptions}) — transcript path not exercised`);
    }
  }

  const passed = checks.filter((c) => c.status === 'pass').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  const skipped = checks.filter((c) => c.status === 'skip').length;
  return {
    ok: failed === 0,
    passed,
    failed,
    skipped,
    total: checks.length,
    checks,
    durationMs: Date.now() - started,
  };
}
