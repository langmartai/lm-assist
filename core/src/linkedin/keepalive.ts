/**
 * LinkedIn session keep-alive.
 *
 * The connector drives a logged-in linkedin.com session that lives in a
 * persistent Chrome profile. LinkedIn can idle-expire a session that sees no
 * activity for a long time, which would silently break every write tool until
 * the user re-runs linkedin_login. This module runs a low-frequency timer that
 * issues one lightweight authenticated request (see cdp-client.keepSessionWarm)
 * so LinkedIn registers recent activity and keeps the session alive.
 *
 * It is started ONCE from createLinkedinRoutes (Core boot). It is intentionally
 * quiet: when the driver browser is not running it skips silently (nothing to
 * keep warm); it only logs when the session has DROPPED (logged out) so the
 * signal is actionable. Interval is configurable via LINKEDIN_KEEPALIVE_MIN
 * (minutes; default 15; set 0 to disable).
 */

import { keepSessionWarm } from './cdp-client';

type Logger = (...a: unknown[]) => void;

let started = false;
let timer: NodeJS.Timeout | null = null;

/** Start the keep-alive timer (idempotent). */
export function startLinkedinKeepAlive(log: Logger = (...a) => console.error('[li-keepalive]', ...a)): void {
  if (started) return;
  const min = Number(process.env.LINKEDIN_KEEPALIVE_MIN ?? '15');
  if (!Number.isFinite(min) || min <= 0) {
    log('disabled (LINKEDIN_KEEPALIVE_MIN <= 0)');
    return;
  }
  started = true;
  const intervalMs = Math.max(1, min) * 60_000;

  let lastLoggedIn: boolean | null = null;
  const tick = async () => {
    try {
      const r = await keepSessionWarm();
      if (!r.loggedIn && lastLoggedIn !== false) {
        log('WARNING: LinkedIn session is NOT logged in — re-run linkedin_login to restore write tools.');
      } else if (r.loggedIn && lastLoggedIn === false) {
        log('LinkedIn session restored (logged in again).');
      }
      lastLoggedIn = r.loggedIn;
    } catch {
      // Driver browser not reachable (not launched yet / closed). Nothing to
      // keep warm — stay quiet; linkedin_status will report it if asked.
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
export function stopLinkedinKeepAlive(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
