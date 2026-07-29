/**
 * Gmail session keep-alive.
 *
 * The connector drives a logged-in mail.google.com session that lives in a
 * persistent Chrome profile. Google can idle-expire a session that sees no
 * activity, which would silently break every tool until the user re-runs
 * gmail_login. This module runs a low-frequency timer that issues one
 * lightweight authenticated request (see cdp-client.keepSessionWarm) so Google
 * registers recent activity.
 *
 * It is started ONCE from createGmailRoutes (Core boot). It is intentionally
 * quiet: when the driver browser is not running it skips silently (nothing to
 * keep warm); it only logs when the session has DROPPED (logged out) so the
 * signal is actionable. Interval is configurable via GMAIL_KEEPALIVE_MIN
 * (minutes; default 15; set 0 to disable).
 */

import { keepSessionWarm } from './cdp-client';

type Logger = (...a: unknown[]) => void;

let started = false;
let timer: NodeJS.Timeout | null = null;

/** Start the keep-alive timer (idempotent). */
export function startGmailKeepAlive(log: Logger = (...a) => console.error('[gm-keepalive]', ...a)): void {
  if (started) return;
  const min = Number(process.env.GMAIL_KEEPALIVE_MIN ?? '15');
  if (!Number.isFinite(min) || min <= 0) {
    log('disabled (GMAIL_KEEPALIVE_MIN <= 0)');
    return;
  }
  started = true;
  const intervalMs = Math.max(1, min) * 60_000;

  let lastLoggedIn: boolean | null = null;
  const tick = async () => {
    try {
      const r = await keepSessionWarm();
      if (!r.loggedIn && lastLoggedIn !== false) {
        log('WARNING: Gmail session is NOT logged in — re-run gmail_login to restore the connector.');
      } else if (r.loggedIn && lastLoggedIn === false) {
        log('Gmail session restored (logged in again).');
      }
      lastLoggedIn = r.loggedIn;
    } catch {
      // Driver browser not reachable (not launched yet / closed). Nothing to
      // keep warm — stay quiet; gmail_status will report it if asked.
    }
  };

  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  // First warm-up shortly after boot (let the browser settle), non-blocking.
  const first = setTimeout(tick, 30_000);
  first.unref?.();
  log(`started (every ${min} min)`);
}

/** Stop the keep-alive timer (for tests / shutdown). */
export function stopGmailKeepAlive(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
