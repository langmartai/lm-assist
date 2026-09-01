/**
 * LinkedIn login — "launch-and-drive".
 *
 * Brings UP a driveable, logged-in linkedin.com session for the CDP connector
 * (cdp-client.ts) to drive:
 *
 *   1. launch a controlled Chrome (persistent profile + remote-debug port) at
 *      linkedin.com  →  the SAME browser the connector will later drive.
 *   2. if the persistent profile is already authenticated, report loggedIn:true.
 *   3. otherwise the browser stays open so the USER logs in by hand
 *      (email / password / 2FA). Poll `/linkedin/login/status` until loggedIn
 *      flips true; the profile then keeps the session across restarts.
 *
 * Unlike WhatsApp (a linked-device QR), LinkedIn login is an ordinary
 * cookie/password session persisted in the profile's storage — there is no QR
 * to render. Keeping the persistent profile dir keeps the login; the connector
 * then talks to that same debug port (default 9223, distinct from WhatsApp's
 * 9222 so both can run side by side).
 *
 * The browser stays alive after this returns. Close it later with the returned
 * `pid` via POST /browser/close.
 */

import * as path from 'path';
import {
  launchChrome,
  closeChrome,
  findInstalledBrowsers,
  type LaunchError,
} from '../utils/claudeai-browser-launch';
import {
  CDPSession,
  listTargets,
  createTab,
  type CDPTarget,
} from '../utils/browser-control';
import { LI_DATA_DIR, DEFAULT_LOGIN_PORT } from './config';

const LINKEDIN_URL = 'https://www.linkedin.com/feed/';
/** How long linkedinLogin waits for the logged-in nav to appear. */
const READY_TIMEOUT_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── types ───────────────────────────────────────────────────────────────────

export interface LinkedinLoginResult {
  ok: true;
  /** PID of the launched browser — close later via POST /browser/close {pid}. */
  pid: number;
  /** Debug port the browser listens on — the connector's CDP endpoint. */
  port: number;
  /** CDP base URL for the connector (LINKEDIN_CDP_URL). */
  cdpUrl: string;
  /** Persistent user-data-dir; relaunch the same to keep the session. */
  profileDir: string;
  /** True once the profile is authenticated (already logged in on launch). */
  loggedIn: boolean;
  /** The signed-in account name, when discoverable. */
  self?: string | null;
  /** Guidance shown when the user still needs to log in by hand. */
  note?: string;
}

export interface LinkedinLoginStatusResult {
  loggedIn: boolean;
  self?: string | null;
  /** Set when the login browser / linkedin page could not be found. */
  note?: string;
}

/** Structured failure — either a browser-launch error or a CDP-connect error. */
export interface LinkedinLoginError {
  ok: false;
  code: string;
  message: string;
  hint?: string;
  /** What browsers ARE installed, when the failure is a missing browser. */
  installedBrowsers?: string[];
}

// ─── persistent profile dir ──────────────────────────────────────────────────

/**
 * Stable, per-name persistent user-data-dir under LI_DATA_DIR. Relaunching the
 * same name keeps the LinkedIn session (it lives in the profile's storage).
 */
function profileDirFor(profile: string): string {
  const safe = String(profile || 'linkedin').replace(/[^\w.-]+/g, '_') || 'linkedin';
  return path.join(LI_DATA_DIR, 'login-profile', safe);
}

// ─── page-side snippets ──────────────────────────────────────────────────────

/**
 * Logged-in iff the app nav is present AND we are not on a login/checkpoint
 * page. LinkedIn's SDUI re-renders the nav class intermittently, so anchor on
 * the stable `data-testid="primary-nav"` (with the classic class + a feed link
 * as fallbacks) rather than the hashable `.global-nav` class.
 */
const JS_LOGGED_IN = `(() => {
  const onLogin = /\\/(login|uas|checkpoint|authwall|signup)/.test(location.pathname);
  return !onLogin && !!document.querySelector('[data-testid="primary-nav"], .global-nav__primary-items, a[href*="/feed/"]');
})()`;
/** Best-effort self name from the "Me" nav avatar's alt text. */
const JS_SELF = `(() => {
  const me = document.querySelector('.global-nav__me img, .global-nav__me-photo, img.global-nav__me-photo');
  return me ? (me.getAttribute('alt') || null) : null;
})()`;

// ─── CDP plumbing (reuses browser-control primitives) ────────────────────────

async function evalValue<T>(session: CDPSession, expression: string): Promise<T | undefined> {
  const r = await session.send<{ result?: { value?: T } }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return r.result?.value;
}

/**
 * Find a driveable page target on `port` (waiting briefly for one to appear),
 * preferring an existing linkedin.com tab. Returns null if none shows up.
 */
async function waitForPage(
  port: number,
  opts: { preferLinkedin?: boolean; timeoutMs?: number } = {},
): Promise<CDPTarget | null> {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(port);
      const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      const li = opts.preferLinkedin ? pages.find((p) => /linkedin\.com/.test(p.url)) : undefined;
      const page = li || pages[0];
      if (page) return page;
    } catch {
      /* debug port not ready yet — retry */
    }
    await sleep(250);
  }
  return null;
}

// ─── public API ──────────────────────────────────────────────────────────────

export interface LinkedinLoginOptions {
  /** Debug port for the launched browser (default 9223). */
  port?: number;
  /** Headed (default) is required for the user to log in / solve 2FA. */
  headless?: boolean;
  /** Stable persistent-profile name (default 'linkedin'). */
  profile?: string;
}

/**
 * Launch a controlled Chrome at linkedin.com. If the persistent profile is
 * already authenticated, returns loggedIn:true. Otherwise the browser stays
 * open for the user to log in; poll linkedinLoginStatus after.
 */
export async function linkedinLogin(
  opts: LinkedinLoginOptions = {},
): Promise<LinkedinLoginResult | LinkedinLoginError> {
  const port = opts.port ?? DEFAULT_LOGIN_PORT;
  const headless = opts.headless ?? false;
  const profileDir = profileDirFor(opts.profile || 'linkedin');

  const launch = await launchChrome({ userDataDir: profileDir, port, headless, startUrl: LINKEDIN_URL });
  if (!launch.ok) {
    return toLoginError(launch);
  }

  const cdpUrl = `http://localhost:${port}`;
  try {
    let page = await waitForPage(port);
    if (!page) {
      const created = await createTab(port, LINKEDIN_URL);
      if (!created.ok) {
        return { ok: false, code: 'CDP_NO_PAGE', message: `No page target on debug port ${port}: ${created.error.message}` };
      }
      page = created.tab;
    }

    const session = new CDPSession(page.webSocketDebuggerUrl);
    try {
      await session.ready();
      await session.send('Page.enable').catch(() => undefined);
      await session.send('Runtime.enable').catch(() => undefined);

      const currentUrl = (await evalValue<string>(session, 'location.href')) || '';
      if (!/linkedin\.com/.test(currentUrl)) {
        await session.send('Page.navigate', { url: LINKEDIN_URL }).catch(() => undefined);
      }
      await sleep(800);

      // Poll for the logged-in nav (a fresh profile lands on the login/guest page).
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let loggedIn = false;
      while (Date.now() < deadline) {
        loggedIn = !!(await evalValue<boolean>(session, JS_LOGGED_IN));
        if (loggedIn) break;
        await sleep(1000);
      }
      const self = loggedIn ? ((await evalValue<string | null>(session, JS_SELF)) ?? null) : null;

      const base: LinkedinLoginResult = { ok: true, pid: launch.pid, port, cdpUrl, profileDir, loggedIn, self };
      if (loggedIn) return base;
      return {
        ...base,
        note:
          `Not logged in yet. A browser window (pid ${launch.pid}) is open at linkedin.com — ` +
          `log in there with your email / password / 2FA. Then poll /linkedin/login/status ` +
          `(or run linkedin_status) until loggedIn:true. The session persists in the profile, ` +
          `so this is a one-time step. Close the browser later via /browser/close pid ${launch.pid}.`,
      };
    } finally {
      session.close();
    }
  } catch (e) {
    return { ok: false, code: 'CDP_ERROR', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Poll the login browser: returns loggedIn (flips true after the user logs in)
 * and the account name when available. Connects to an already-launched browser.
 */
export async function linkedinLoginStatus(
  opts: { port?: number } = {},
): Promise<LinkedinLoginStatusResult | LinkedinLoginError> {
  const port = opts.port ?? DEFAULT_LOGIN_PORT;
  const page = await waitForPage(port, { preferLinkedin: true, timeoutMs: 4000 });
  if (!page) {
    return {
      ok: false,
      code: 'CDP_NO_PAGE',
      message: `No page found on debug port ${port} — is the login browser still running? Run /linkedin/login first.`,
    };
  }
  const session = new CDPSession(page.webSocketDebuggerUrl);
  try {
    await session.ready();
    await session.send('Runtime.enable').catch(() => undefined);
    const loggedIn = !!(await evalValue<boolean>(session, JS_LOGGED_IN));
    const self = loggedIn ? ((await evalValue<string | null>(session, JS_SELF)) ?? null) : null;
    if (loggedIn) return { loggedIn: true, self };
    return { loggedIn: false, note: 'Not logged in yet — finish the email/password/2FA login in the open browser, then retry.' };
  } catch (e) {
    return { ok: false, code: 'CDP_ERROR', message: e instanceof Error ? e.message : String(e) };
  } finally {
    session.close();
  }
}

/** Map a browser LaunchError to the login error envelope (adds installed list). */
function toLoginError(launch: LaunchError): LinkedinLoginError {
  const out: LinkedinLoginError = {
    ok: false,
    code: launch.code.toUpperCase(),
    message: launch.message,
    hint: launch.hint,
  };
  if (launch.code === 'chrome_not_found') {
    out.installedBrowsers = findInstalledBrowsers().map((b) => `${b.kind} (${b.family})`);
  }
  return out;
}

// Re-export browser lifecycle helpers so a single import of this module has
// everything the login flow (and its smoke test) needs.
export { closeChrome, findInstalledBrowsers };
