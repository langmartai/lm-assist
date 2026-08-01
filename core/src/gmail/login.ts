/**
 * Gmail login — "launch-and-drive".
 *
 * Brings UP a driveable, logged-in mail.google.com session for the CDP
 * connector (cdp-client.ts) to drive:
 *
 *   1. launch a controlled Chrome (persistent profile + remote-debug port) at
 *      mail.google.com  →  the SAME browser the connector will later drive.
 *   2. if the persistent profile is already authenticated, report loggedIn:true.
 *   3. otherwise the browser stays open so the USER logs in by hand
 *      (Google account + 2FA). Poll `/gmail/login/status` until loggedIn flips
 *      true; the profile then keeps the session across restarts.
 *
 * VERIFIED 2026-07-29 on a real Workspace account, on both a Windows and a
 * Linux host: Google does NOT refuse a sign-in in a Chrome launched with a
 * custom `--user-data-dir` and an open `--remote-debugging-port`, and the
 * session survives a restart — a headed one-time login followed by HEADLESS
 * operation against the same profile lands straight back in the inbox.
 *
 * Two gotchas this file exists to absorb:
 *   - the shared launcher hardcodes a `https://claude.ai/` start URL, so we
 *     always issue our own Page.navigate (same workaround LinkedIn uses);
 *   - headless MUST force a normal UA (see headlessUa() in config.ts) or Google
 *     serves a degraded sign-in flow.
 *
 * The browser stays alive after this returns. Close it later with the returned
 * `pid` via POST /browser/close — but note that on Windows Chrome re-parents
 * itself, so the launched pid may not be the surviving browser process.
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
import { GM_DATA_DIR, DEFAULT_LOGIN_PORT, headlessUa } from './config';

const GMAIL_URL = 'https://mail.google.com/mail/u/0/';
/** How long gmailLogin waits for the mail UI to appear. */
const READY_TIMEOUT_MS = 25_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── types ───────────────────────────────────────────────────────────────────

export interface GmailLoginResult {
  ok: true;
  /** PID of the launched browser — close later via POST /browser/close {pid}. */
  pid: number;
  /** Debug port the browser listens on — the connector's CDP endpoint. */
  port: number;
  /** CDP base URL for the connector (GMAIL_CDP_URL). */
  cdpUrl: string;
  /** Persistent user-data-dir; relaunch the same to keep the session. */
  profileDir: string;
  /** True once the profile is authenticated (already logged in on launch). */
  loggedIn: boolean;
  /** The signed-in address, when discoverable. */
  self?: string | null;
  /** Guidance shown when the user still needs to log in by hand. */
  note?: string;
}

export interface GmailLoginStatusResult {
  loggedIn: boolean;
  self?: string | null;
  /** Set when the login browser / gmail page could not be found. */
  note?: string;
}

/** Structured failure — either a browser-launch error or a CDP-connect error. */
export interface GmailLoginError {
  ok: false;
  code: string;
  message: string;
  hint?: string;
  /** What browsers ARE installed, when the failure is a missing browser. */
  installedBrowsers?: string[];
}

// ─── persistent profile dir ──────────────────────────────────────────────────

/**
 * Stable, per-name persistent user-data-dir under GM_DATA_DIR. Relaunching the
 * same name keeps the Google session (it lives in the profile's storage).
 */
function profileDirFor(profile: string): string {
  const safe = String(profile || 'gmail').replace(/[^\w.-]+/g, '_') || 'gmail';
  return path.join(GM_DATA_DIR, 'login-profile', safe);
}

// ─── page-side snippets ──────────────────────────────────────────────────────

/**
 * Logged-in iff we are on mail.google.com (NOT bounced to the accounts.google.com
 * sign-in flow) AND the mail UI has rendered. A signed-out profile lands on
 * `accounts.google.com/v3/signin/identifier?...`, so the host check alone is a
 * strong signal; the UI check confirms the app actually came up.
 */
const JS_LOGGED_IN = `(() => {
  if (!/(^|\\.)mail\\.google\\.com$/.test(location.hostname)) return false;
  if (/signin|ServiceLogin|AccountChooser/i.test(location.href)) return false;
  return !!document.querySelector('input[name="q"], div[role="main"], tr.zA, [gh="tm"]');
})()`;

/**
 * The signed-in address. GLOBALS[10] carries it on the loaded mail app; fall
 * back to the account-switcher button's aria-label, which embeds the address.
 */
const JS_SELF = `(() => {
  try { const g = window.GLOBALS && window.GLOBALS[10]; if (g && /@/.test(String(g))) return String(g); } catch (e) {}
  const a = document.querySelector('a[aria-label*="@"], [aria-label*="Google Account"]');
  if (a) { const m = (a.getAttribute('aria-label') || '').match(/[\\w.+-]+@[\\w.-]+\\.\\w+/); if (m) return m[0]; }
  return null;
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
 * preferring an existing google tab. Returns null if none shows up.
 */
async function waitForPage(
  port: number,
  opts: { preferGmail?: boolean; timeoutMs?: number } = {},
): Promise<CDPTarget | null> {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(port);
      const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      // A signed-out profile sits on accounts.google.com, so match google.com
      // broadly rather than mail.google.com only — otherwise the login browser
      // is invisible to us exactly when the user still needs to log in.
      const gm = opts.preferGmail ? pages.find((p) => /\.google\.com/.test(p.url)) : undefined;
      const page = gm || pages[0];
      if (page) return page;
    } catch {
      /* debug port not ready yet — retry */
    }
    await sleep(250);
  }
  return null;
}

// ─── public API ──────────────────────────────────────────────────────────────

export interface GmailLoginOptions {
  /** Debug port for the launched browser (default 9224). */
  port?: number;
  /** Headed (default) is required for the user to log in / solve 2FA. */
  headless?: boolean;
  /** Stable persistent-profile name (default 'gmail'). */
  profile?: string;
}

/**
 * Launch a controlled Chrome at mail.google.com. If the persistent profile is
 * already authenticated, returns loggedIn:true. Otherwise the browser stays
 * open for the user to log in; poll gmailLoginStatus after.
 */
export async function gmailLogin(
  opts: GmailLoginOptions = {},
): Promise<GmailLoginResult | GmailLoginError> {
  const port = opts.port ?? DEFAULT_LOGIN_PORT;
  const headless = opts.headless ?? false;
  const profileDir = profileDirFor(opts.profile || 'gmail');

  // Headless MUST carry a normal UA or Google degrades the sign-in flow.
  const extraArgs = headless ? [`--user-agent=${headlessUa()}`] : undefined;
  const launch = await launchChrome({ userDataDir: profileDir, port, headless, extraArgs });
  if (!launch.ok) {
    return toLoginError(launch);
  }

  const cdpUrl = `http://localhost:${port}`;
  try {
    let page = await waitForPage(port);
    if (!page) {
      const created = await createTab(port, GMAIL_URL);
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

      // The shared launcher always starts at claude.ai — navigate ourselves.
      const currentUrl = (await evalValue<string>(session, 'location.href')) || '';
      if (!/\.google\.com/.test(currentUrl)) {
        await session.send('Page.navigate', { url: GMAIL_URL }).catch(() => undefined);
      }
      await sleep(1200);

      // Poll for the mail UI (a fresh profile lands on the Google sign-in page).
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let loggedIn = false;
      while (Date.now() < deadline) {
        loggedIn = !!(await evalValue<boolean>(session, JS_LOGGED_IN));
        if (loggedIn) break;
        await sleep(1000);
      }
      const self = loggedIn ? ((await evalValue<string | null>(session, JS_SELF)) ?? null) : null;

      const base: GmailLoginResult = { ok: true, pid: launch.pid, port, cdpUrl, profileDir, loggedIn, self };
      if (loggedIn) return base;
      return {
        ...base,
        note:
          `Not logged in yet. A browser window (pid ${launch.pid}) is open at the Google sign-in page — ` +
          `log in there with the Google account and 2FA. Then poll /gmail/login/status (or run gmail_status) ` +
          `until loggedIn:true. The session persists in the profile, so this is a one-time step. ` +
          `NOTE: on Windows Chrome re-parents itself, so pid ${launch.pid} may already be gone while the ` +
          `browser is still running — trust /gmail/login/status, not the pid.`,
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
 * and the account address when available. Connects to an already-launched browser.
 */
export async function gmailLoginStatus(
  opts: { port?: number } = {},
): Promise<GmailLoginStatusResult | GmailLoginError> {
  const port = opts.port ?? DEFAULT_LOGIN_PORT;
  const page = await waitForPage(port, { preferGmail: true, timeoutMs: 4000 });
  if (!page) {
    return {
      ok: false,
      code: 'CDP_NO_PAGE',
      message: `No page found on debug port ${port} — is the login browser still running? Run /gmail/login first.`,
    };
  }
  const session = new CDPSession(page.webSocketDebuggerUrl);
  try {
    await session.ready();
    await session.send('Runtime.enable').catch(() => undefined);
    const loggedIn = !!(await evalValue<boolean>(session, JS_LOGGED_IN));
    const self = loggedIn ? ((await evalValue<string | null>(session, JS_SELF)) ?? null) : null;
    if (loggedIn) return { loggedIn: true, self };
    return { loggedIn: false, note: 'Not logged in yet — finish the Google account + 2FA login in the open browser, then retry.' };
  } catch (e) {
    return { ok: false, code: 'CDP_ERROR', message: e instanceof Error ? e.message : String(e) };
  } finally {
    session.close();
  }
}

/** Map a browser LaunchError to the login error envelope (adds installed list). */
function toLoginError(launch: LaunchError): GmailLoginError {
  const out: GmailLoginError = {
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
