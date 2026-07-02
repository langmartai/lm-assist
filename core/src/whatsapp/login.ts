/**
 * WhatsApp Web login (linked-device QR pairing) — "launch-and-drive".
 *
 * The analogue of claude.ai's launch-and-capture, but instead of harvesting a
 * cookie it brings UP a driveable, logged-in WhatsApp Web session:
 *
 *   1. launch a controlled Chrome (persistent profile + remote-debug port) at
 *      web.whatsapp.com  →  the SAME browser the CDP connector (cdp-client.ts)
 *      will later drive.
 *   2. return the login QR (a PNG) so the user scans it with their phone
 *      (WhatsApp → Linked devices → Link a device).
 *   3. poll `/whatsapp/login/status` until `loggedIn` flips true (WhatsApp
 *      rotates the QR ~every 20s, so status refreshes it each call).
 *
 * WhatsApp Web login is NOT a cookie — it's a per-device pairing bound to the
 * profile's IndexedDB/Local Storage. Keeping the persistent profile dir keeps
 * the linked device; the connector then talks to that same debug port.
 *
 * Mainly for Linux (no native WhatsApp app) and for re-pairing. On Windows the
 * native WhatsApp app already owns debug port 9222 — pass a different `port`.
 *
 * The browser stays alive after this returns (so the user can scan). Close it
 * later with the returned `pid` via POST /browser/close.
 */

import * as fs from 'fs';
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
import { WA_DATA_DIR } from './config';

const DEFAULT_LOGIN_PORT = 9222;
const WHATSAPP_URL = 'https://web.whatsapp.com/';
/** How long whatsappLogin waits for EITHER logged-in OR a rendered QR. */
const READY_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── types ───────────────────────────────────────────────────────────────────

export interface LoginQr {
  /** `data:image/png;base64,...` — large; prefer surfacing `savedPath` to users. */
  dataUrl: string;
  /** Absolute path to the saved PNG (overwritten each call). */
  savedPath: string;
  /** ISO timestamp the QR was captured. */
  capturedAt: string;
}

export interface WhatsappLoginResult {
  ok: true;
  /** PID of the launched browser — close later via POST /browser/close {pid}. */
  pid: number;
  /** Debug port the browser listens on — the connector's CDP endpoint. */
  port: number;
  /** CDP base URL for the connector (WHATSAPP_CDP_URL). */
  cdpUrl: string;
  /** Persistent user-data-dir; relaunch the same to keep the linked device. */
  profileDir: string;
  /** True once the user has scanned (or the profile was already paired). */
  loggedIn: boolean;
  /** The login QR — present only when NOT logged in and a QR was rendered. */
  qr?: LoginQr;
  /** Set when neither login nor a QR could be observed within the timeout. */
  note?: string;
}

export interface WhatsappLoginStatusResult {
  loggedIn: boolean;
  qr?: LoginQr;
  /** Set when the login browser / whatsapp page could not be found. */
  note?: string;
}

/** Structured failure — either a browser-launch error or a CDP-connect error. */
export interface WhatsappLoginError {
  ok: false;
  code: string;
  message: string;
  hint?: string;
  /** What browsers ARE installed, when the failure is a missing browser. */
  installedBrowsers?: string[];
}

// ─── persistent profile dir ──────────────────────────────────────────────────

/**
 * Stable, per-name persistent user-data-dir under WA_DATA_DIR. Relaunching the
 * same name keeps the WhatsApp linked-device session (it lives in the profile's
 * storage, not a cookie).
 */
function profileDirFor(profile: string): string {
  const safe = String(profile || 'whatsapp').replace(/[^\w.-]+/g, '_') || 'whatsapp';
  return path.join(WA_DATA_DIR, 'login-profile', safe);
}

// ─── page-side snippets ──────────────────────────────────────────────────────

/** Logged-in iff the chat pane is present. */
const JS_LOGGED_IN = `!!document.querySelector('#pane-side')`;

/**
 * Extract the login QR as a PNG data URL from the same-origin <canvas>.
 * WhatsApp renders the QR into a <canvas> inside div[data-ref]; toDataURL works
 * because the canvas is same-origin. Returns null if not rendered / not ready.
 */
const JS_QR_CANVAS = `(() => {
  try {
    const c = document.querySelector('div[data-ref] canvas')
           || document.querySelector('canvas[aria-label]')
           || document.querySelector('canvas');
    if (!c) return null;
    const url = c.toDataURL('image/png');
    return (typeof url === 'string' && url.indexOf('data:image/png') === 0) ? url : null;
  } catch (e) { return null; }
})()`;

/** Bounding rect (JSON) of the QR container, for the screenshot fallback. */
const JS_QR_RECT = `(() => {
  const el = document.querySelector('div[data-ref]') || document.querySelector('canvas');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
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
 * preferring an existing web.whatsapp.com tab. Returns null if none shows up.
 */
async function waitForPage(
  port: number,
  opts: { preferWhatsapp?: boolean; timeoutMs?: number } = {},
): Promise<CDPTarget | null> {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(port);
      const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      const wa = opts.preferWhatsapp ? pages.find((p) => /web\.whatsapp\.com/.test(p.url)) : undefined;
      const page = wa || pages[0];
      if (page) return page;
    } catch {
      /* debug port not ready yet — retry */
    }
    await sleep(250);
  }
  return null;
}

/**
 * Capture the QR: same-origin canvas.toDataURL PRIMARY; CDP clipped screenshot
 * FALLBACK (when the canvas isn't there or toDataURL returns null).
 */
async function captureQr(session: CDPSession): Promise<string | null> {
  const primary = await evalValue<string | null>(session, JS_QR_CANVAS);
  if (primary && primary.indexOf('data:image/png') === 0) return primary;

  const rectJson = await evalValue<string | null>(session, JS_QR_RECT);
  if (!rectJson) return null;
  let rect: { x: number; y: number; width: number; height: number };
  try {
    rect = JSON.parse(rectJson);
  } catch {
    return null;
  }
  try {
    const shot = await session.send<{ data?: string }>(
      'Page.captureScreenshot',
      { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 } },
      15000,
    );
    return shot?.data ? `data:image/png;base64,${shot.data}` : null;
  } catch {
    return null;
  }
}

/** Persist a PNG data URL under WA_DATA_DIR (overwrites each call). */
function saveQrPng(dataUrl: string): { savedPath: string; bytes: number } {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  fs.mkdirSync(WA_DATA_DIR, { recursive: true });
  const savedPath = path.join(WA_DATA_DIR, 'login-qr.png');
  fs.writeFileSync(savedPath, buf);
  return { savedPath, bytes: buf.length };
}

function qrFromDataUrl(dataUrl: string): LoginQr {
  const { savedPath } = saveQrPng(dataUrl);
  return { dataUrl, savedPath, capturedAt: new Date().toISOString() };
}

// ─── public API ──────────────────────────────────────────────────────────────

export interface WhatsappLoginOptions {
  /** Debug port for the launched browser (default 9222). */
  port?: number;
  /** Headed (default) is required to render/scan the QR. */
  headless?: boolean;
  /** Stable persistent-profile name (default 'whatsapp'). */
  profile?: string;
}

/**
 * Launch a controlled Chrome at web.whatsapp.com and return the login QR (or,
 * if the persistent profile is already paired, loggedIn:true with no QR). The
 * browser stays alive so the user can scan; poll whatsappLoginStatus after.
 */
export async function whatsappLogin(
  opts: WhatsappLoginOptions = {},
): Promise<WhatsappLoginResult | WhatsappLoginError> {
  const port = opts.port ?? DEFAULT_LOGIN_PORT;
  const headless = opts.headless ?? false;
  const profileDir = profileDirFor(opts.profile || 'whatsapp');

  const launch = await launchChrome({ userDataDir: profileDir, port, headless });
  if (!launch.ok) {
    return toLoginError(launch);
  }

  const cdpUrl = `http://localhost:${port}`;
  try {
    // launchChrome opens claude.ai on the command line; navigate the first page
    // (or a fresh tab) to web.whatsapp.com and drive that.
    let page = await waitForPage(port);
    if (!page) {
      const created = await createTab(port, WHATSAPP_URL);
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
      if (!/web\.whatsapp\.com/.test(currentUrl)) {
        await session.send('Page.navigate', { url: WHATSAPP_URL }).catch(() => undefined);
      }
      await sleep(600); // let the navigation commit before polling

      // Poll for EITHER logged-in OR a rendered QR (WhatsApp Web takes a few
      // seconds to boot its service worker + draw the QR canvas).
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let loggedIn = false;
      let qrDataUrl: string | null = null;
      while (Date.now() < deadline) {
        loggedIn = !!(await evalValue<boolean>(session, JS_LOGGED_IN));
        if (loggedIn) break;
        qrDataUrl = await captureQr(session);
        if (qrDataUrl) break;
        await sleep(1000);
      }

      const base: WhatsappLoginResult = { ok: true, pid: launch.pid, port, cdpUrl, profileDir, loggedIn };
      if (loggedIn) return base;
      if (qrDataUrl) return { ...base, qr: qrFromDataUrl(qrDataUrl) };
      return {
        ...base,
        note: `Neither a logged-in pane nor a QR rendered within ${Math.floor(READY_TIMEOUT_MS / 1000)}s. ` +
          `The browser is still open (pid ${launch.pid}); call /whatsapp/login/status to retry, or check network/DISPLAY.`,
      };
    } finally {
      session.close();
    }
  } catch (e) {
    return { ok: false, code: 'CDP_ERROR', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Poll the login browser: returns loggedIn (flips true after the user scans)
 * and, while still pending, a FRESH QR (WhatsApp rotates it ~every 20s). Used
 * for polling; connects to an already-launched browser on `port`.
 */
export async function whatsappLoginStatus(
  opts: { port?: number } = {},
): Promise<WhatsappLoginStatusResult | WhatsappLoginError> {
  const port = opts.port ?? DEFAULT_LOGIN_PORT;
  const page = await waitForPage(port, { preferWhatsapp: true, timeoutMs: 4000 });
  if (!page) {
    return {
      ok: false,
      code: 'CDP_NO_PAGE',
      message: `No page found on debug port ${port} — is the login browser still running? Run /whatsapp/login first.`,
    };
  }
  const session = new CDPSession(page.webSocketDebuggerUrl);
  try {
    await session.ready();
    await session.send('Runtime.enable').catch(() => undefined);
    const loggedIn = !!(await evalValue<boolean>(session, JS_LOGGED_IN));
    if (loggedIn) return { loggedIn: true };
    const qrDataUrl = await captureQr(session);
    if (qrDataUrl) return { loggedIn: false, qr: qrFromDataUrl(qrDataUrl) };
    return { loggedIn: false, note: 'Not logged in yet and no QR is currently rendered (it may be mid-refresh — retry).' };
  } catch (e) {
    return { ok: false, code: 'CDP_ERROR', message: e instanceof Error ? e.message : String(e) };
  } finally {
    session.close();
  }
}

/** Map a browser LaunchError to the login error envelope (adds installed list). */
function toLoginError(launch: LaunchError): WhatsappLoginError {
  const out: WhatsappLoginError = {
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
