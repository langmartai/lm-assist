/**
 * YouTube login — "launch-and-drive".
 *
 * Brings UP a driveable youtube.com session for the CDP connector
 * (cdp-client.ts) to drive:
 *
 *   1. launch a controlled Chrome (persistent profile + remote-debug port) at
 *      youtube.com  →  the SAME browser the connector will later drive.
 *   2. report whether the persistent profile is signed in (best-effort — the
 *      account avatar). Reads DO NOT require this; only the browser must run.
 *   3. if the user WANTS to sign in (for age-gated content / a persisted consent
 *      choice), the browser stays open so they log in by hand; poll
 *      `/youtube/login/status` until loggedIn flips true.
 *
 * Keeping the persistent profile dir keeps the login + consent choice across
 * restarts. The connector talks to that same debug port (default 9225, distinct
 * from WhatsApp's 9222, LinkedIn's 9223 and Gmail's 9224 — all four can run side
 * by side).
 *
 * The browser stays alive after this returns. Close it later with the returned
 * `pid` via POST /browser/close.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  launchChrome,
  findInstalledBrowsers,
  closeChrome,
  type LaunchError,
} from '../utils/claudeai-browser-launch';
import { CDPSession, listTargets, createTab, type CDPTarget } from '../utils/browser-control';
import { YT_DATA_DIR, DEFAULT_LOGIN_PORT } from './config';

const YOUTUBE_URL = 'https://www.youtube.com/';
/**
 * A DELIBERATELY LIGHT same-origin page (text/plain robots.txt).
 *
 * 🔴 MEASURED 2026-08-05: rendering the heavy youtube.com SPA under `headless=new`
 * WEDGES the renderer — it accepts the debugger socket then answers nothing, and
 * every later CDP command (including the connector's Page.navigate) times out. So
 * in HEADLESS mode login parks on this light page instead of the SPA; the browser
 * is up and driveable, and the connector reads everything via in-page fetch. HEADED
 * mode still opens the real youtube.com so a human can sign in.
 */
const LIGHT_URL = 'https://www.youtube.com/robots.txt';
/** How long youtubeLogin waits for the tab to become driveable. */
const READY_TIMEOUT_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── types ───────────────────────────────────────────────────────────────────

export interface YoutubeLoginResult {
  ok: true;
  /** PID of the launched browser — close later via POST /browser/close {pid}. */
  pid: number;
  /** Debug port the browser listens on — the connector's CDP endpoint. */
  port: number;
  /** CDP base URL for the connector (YOUTUBE_CDP_URL). */
  cdpUrl: string;
  /** Persistent user-data-dir; relaunch the same to keep the session. */
  profileDir: string;
  /** True once the profile is signed in (best-effort — reads do not need it). */
  loggedIn: boolean;
  /** The signed-in account name, when discoverable. */
  self?: string | null;
  /** Guidance shown when the user still needs to sign in by hand. */
  note?: string;
}

export interface YoutubeLoginStatusResult {
  loggedIn: boolean;
  self?: string | null;
  /** Set when the login browser / youtube page could not be found. */
  note?: string;
}

/** Structured failure — either a browser-launch error or a CDP-connect error. */
export interface YoutubeLoginError {
  ok: false;
  code: string;
  message: string;
  hint?: string;
  /** What browsers ARE installed, when the failure is a missing browser. */
  installedBrowsers?: string[];
}

// ─── persistent profile dir ──────────────────────────────────────────────────

/**
 * Stable, per-name persistent user-data-dir under YT_DATA_DIR. Relaunching the
 * same name keeps the YouTube session + consent choice (they live in the
 * profile's storage).
 */
export function profileDirFor(profile: string): string {
  const safe = String(profile || 'youtube').replace(/[^\w.-]+/g, '_') || 'youtube';
  return path.join(YT_DATA_DIR, 'login-profile', safe);
}

/**
 * Has a YouTube driver profile ever been created on this node?
 *
 * The relaunch rung of cdp-client's recovery ladder uses this: relaunching a
 * browser for a profile that has NEVER existed would park an unwanted Chrome on
 * youtube.com that nobody asked for. A profile dir on disk means the operator ran
 * youtube_login here at least once, so an automatic relaunch is restoring
 * something they set up — not conjuring it.
 */
export function youtubeProfileExists(profile = 'youtube'): boolean {
  try {
    return fs.existsSync(profileDirFor(profile));
  } catch {
    return false;
  }
}

// ─── page-side snippets ──────────────────────────────────────────────────────

/** We reached a youtube.com page (not a consent interstitial on another host). */
const JS_ON_YOUTUBE = `(() => /(^|\\.)youtube\\.com$/.test(location.hostname) && !location.hostname.startsWith('consent.'))()`;

/**
 * Signed-in state via an IN-PAGE fetch of the home HTML (no SPA render, so it does
 * not wedge the headless renderer). YouTube embeds `"LOGGED_IN":true` in the home
 * page config when a session is present.
 */
const JS_LOGGED_IN = `(async () => {
  try {
    const r = await fetch('https://www.youtube.com/', { credentials: 'include', headers: { accept: 'text/html' } });
    const t = await r.text();
    return /"LOGGED_IN"\\s*:\\s*true/.test(t);
  } catch (e) { return false; }
})()`;

// ─── CDP plumbing (reuses browser-control primitives) ────────────────────────

async function evalValue<T>(session: CDPSession, expression: string): Promise<T | undefined> {
  // 15s, not the CDPSession 5s default: a COLD headless youtube.com is heavy and
  // its first Runtime.evaluate legitimately answers slower than 5s, which used to
  // fail youtube_login with CDP_ERROR even though the browser had launched fine.
  const r = await session.send<{ result?: { value?: T } }>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    15000,
  );
  return r.result?.value;
}

/**
 * Find a driveable page target on `port` (waiting briefly for one to appear),
 * preferring an existing youtube.com tab. Returns null if none shows up.
 */
async function waitForPage(
  port: number,
  opts: { preferYoutube?: boolean; timeoutMs?: number } = {},
): Promise<CDPTarget | null> {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(port);
      const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      const yt = opts.preferYoutube ? pages.find((p) => /youtube\.com/.test(p.url)) : undefined;
      const page = yt || pages[0];
      if (page) return page;
    } catch {
      /* debug port not ready yet — retry */
    }
    await sleep(250);
  }
  return null;
}

// ─── public API ──────────────────────────────────────────────────────────────

export interface YoutubeLoginOptions {
  /** Debug port for the launched browser (default 9225). */
  port?: number;
  /** Headed (default) is required for the user to sign in / accept consent. */
  headless?: boolean;
  /** Stable persistent-profile name (default 'youtube'). */
  profile?: string;
}

/**
 * Launch a controlled Chrome at youtube.com. If the persistent profile is already
 * signed in, returns loggedIn:true. Either way the browser stays open and
 * driveable — reads do not need a login, but the browser must be running.
 */
export async function youtubeLogin(
  opts: YoutubeLoginOptions = {},
): Promise<YoutubeLoginResult | YoutubeLoginError> {
  const port = opts.port ?? DEFAULT_LOGIN_PORT;
  const headless = opts.headless ?? false;
  const profileDir = profileDirFor(opts.profile || 'youtube');

  // Headless parks on the LIGHT page (rendering the SPA headless wedges the
  // renderer — see LIGHT_URL); headed opens the real youtube.com so a human can
  // sign in.
  const startUrl = headless ? LIGHT_URL : YOUTUBE_URL;

  // 🔴 Headless-on-a-display-box wedge (MEASURED 2026-08-05, Azure host):
  // `--headless=new` Chrome here WEDGES the renderer when it has NO DISPLAY — even
  // Runtime.enable never answers, on a page as light as robots.txt. The working
  // Gmail connector on the same box runs headless too, but its Chrome carries
  // DISPLAY=:0, and that is the difference. The shared launcher only injects
  // DISPLAY for HEADED mode; it launches Chrome with `{...process.env}`, so the
  // one lever a connector has is process.env. When headless, no DISPLAY is set,
  // and an X socket exists, adopt :0 so the headless child inherits it. This is
  // exactly the launcher's own headed fallback, extended to headless.
  if (headless && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    try {
      if (fs.existsSync('/tmp/.X11-unix/X0')) process.env.DISPLAY = ':0';
    } catch {
      /* no X socket — headless stays displayless (fine on a box where that works) */
    }
  }

  // Standard headless hardening for cloud/container kernels. Harmless when headed.
  const extraArgs = headless
    ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-setuid-sandbox']
    : undefined;

  const launch = await launchChrome({ userDataDir: profileDir, port, headless, extraArgs });
  if (!launch.ok) {
    return toLoginError(launch);
  }

  const cdpUrl = `http://localhost:${port}`;
  try {
    // 🔴 In HEADLESS mode, ALWAYS drive a FRESH light tab and close whatever the
    // persistent profile restored. A restored heavy youtube.com home tab wedges
    // the headless renderer, and driving it makes even a trivial eval time out —
    // so we never touch it: open robots.txt, then close the old tabs. HEADED mode
    // keeps the real youtube tab so a human can sign in.
    let oldPageIds: string[] = [];
    let page: CDPTarget | null;
    if (headless) {
      const before = await listTargets(port).catch(() => []);
      oldPageIds = before.filter((t) => t.type === 'page').map((t) => t.id);
      const created = await createTab(port, startUrl);
      if (!created.ok) {
        return { ok: false, code: 'CDP_NO_PAGE', message: `No page target on debug port ${port}: ${created.error.message}` };
      }
      page = created.tab;
    } else {
      page = await waitForPage(port);
      if (!page) {
        const created = await createTab(port, startUrl);
        if (!created.ok) {
          return { ok: false, code: 'CDP_NO_PAGE', message: `No page target on debug port ${port}: ${created.error.message}` };
        }
        page = created.tab;
      }
    }

    // Close the restored/old tabs now that the fresh one exists (browser stays at
    // ≥1 tab, so it does not exit).
    for (const id of oldPageIds) {
      await fetch(`${cdpUrl}/json/close/${id}`).catch(() => undefined);
    }

    const session = new CDPSession(page.webSocketDebuggerUrl);
    try {
      await session.ready();
      await session.send('Page.enable').catch(() => undefined);
      await session.send('Runtime.enable').catch(() => undefined);

      const currentUrl = (await evalValue<string>(session, 'location.href')) || '';
      if (!/youtube\.com/.test(currentUrl)) {
        await session.send('Page.navigate', { url: startUrl }).catch(() => undefined);
      }
      await sleep(1000);

      // Wait for the tab to be DRIVEABLE (a trivial eval answers) — not for the
      // SPA to render (it deliberately never does in headless mode).
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let alive = false;
      while (Date.now() < deadline) {
        alive = (await evalValue<number>(session, '1')) === 1 && !!(await evalValue<boolean>(session, JS_ON_YOUTUBE));
        if (alive) break;
        await sleep(1000);
      }
      // Signed-in state via an in-page fetch (no render). Best-effort.
      const loggedIn = alive ? !!(await evalValue<boolean>(session, JS_LOGGED_IN)) : false;

      const base: YoutubeLoginResult = { ok: true, pid: launch.pid, port, cdpUrl, profileDir, loggedIn, self: null };
      if (loggedIn) return base;
      return {
        ...base,
        note:
          `A YouTube driver browser (pid ${launch.pid}) is up and driveable on this node — ` +
          `public reads (channel videos, video info, transcripts) work WITHOUT signing in. To sign in ` +
          `(for age-gated content or to persist a consent choice), run youtube_login headed and log in, ` +
          `then poll youtube_status until loggedIn:true. The session persists in the profile. ` +
          `Close the browser later via /browser/close pid ${launch.pid}.`,
      };
    } finally {
      session.close();
    }
  } catch (e) {
    return { ok: false, code: 'CDP_ERROR', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Poll the login browser: returns loggedIn (flips true after the user signs in)
 * and the account name when available. Connects to an already-launched browser.
 */
export async function youtubeLoginStatus(
  opts: { port?: number } = {},
): Promise<YoutubeLoginStatusResult | YoutubeLoginError> {
  const port = opts.port ?? DEFAULT_LOGIN_PORT;
  const page = await waitForPage(port, { preferYoutube: true, timeoutMs: 4000 });
  if (!page) {
    return {
      ok: false,
      code: 'CDP_NO_PAGE',
      message: `No page found on debug port ${port} — is the YouTube login browser still running? Run /youtube/login first.`,
    };
  }
  const session = new CDPSession(page.webSocketDebuggerUrl);
  try {
    await session.ready();
    await session.send('Runtime.enable').catch(() => undefined);
    const loggedIn = !!(await evalValue<boolean>(session, JS_LOGGED_IN));
    if (loggedIn) return { loggedIn: true, self: null };
    return { loggedIn: false, note: 'Not signed in — reads still work without a login; finish the sign-in in the open browser if you need age-gated content.' };
  } catch (e) {
    return { ok: false, code: 'CDP_ERROR', message: e instanceof Error ? e.message : String(e) };
  } finally {
    session.close();
  }
}

/** Map a browser LaunchError to the login error envelope (adds installed list). */
function toLoginError(launch: LaunchError): YoutubeLoginError {
  const out: YoutubeLoginError = {
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
