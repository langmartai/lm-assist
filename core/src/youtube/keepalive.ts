/**
 * YouTube session keep-alive.
 *
 * The connector drives a youtube.com session in a persistent Chrome profile.
 * Unlike LinkedIn, YouTube does not aggressively idle-expire a session and the
 * connector's reads are public, so this is OFF by default (YOUTUBE_KEEPALIVE_MIN
 * defaults to 0). An operator who signs in for age-gated content can enable it to
 * keep that session warm.
 *
 * It is started ONCE from createYoutubeRoutes (Core boot). It is intentionally
 * quiet: when the driver browser is not running it skips silently; it only logs
 * when a previously-signed-in session has DROPPED. The warm-up is a single in-page
 * authenticated fetch (see cdp-client.keepSessionWarm) — it NEVER navigates the
 * shared tab, so it cannot steal the page from an in-flight read.
 */

import { keepSessionWarm } from './cdp-client';

type Logger = (...a: unknown[]) => void;

let started = false;
let timer: NodeJS.Timeout | null = null;

/** Start the keep-alive timer (idempotent). Default interval 0 = disabled. */
export function startYoutubeKeepAlive(log: Logger = (...a) => console.error('[yt-keepalive]', ...a)): void {
  if (started) return;
  const min = Number(process.env.YOUTUBE_KEEPALIVE_MIN ?? '0');
  if (!Number.isFinite(min) || min <= 0) {
    // Disabled by default — say nothing noisy; this is the expected state.
    return;
  }
  started = true;
  const intervalMs = Math.max(1, min) * 60_000;

  let lastLoggedIn: boolean | null = null;
  const tick = async () => {
    try {
      const r = await keepSessionWarm();
      if (!r.loggedIn && lastLoggedIn === true) {
        log('YouTube session dropped (signed out) — sign in again with youtube_login if you need age-gated content.');
      } else if (r.loggedIn && lastLoggedIn === false) {
        log('YouTube session restored (signed in again).');
      }
      lastLoggedIn = r.loggedIn;
    } catch {
      // Driver browser not reachable (not launched / closed). Nothing to keep
      // warm — stay quiet; youtube_status will report it if asked.
    }
  };

  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const first = setTimeout(tick, 30_000);
  first.unref?.();
  log(`started (every ${min} min)`);
}

/** Stop the keep-alive timer (for tests / shutdown). */
export function stopYoutubeKeepAlive(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
