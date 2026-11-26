/**
 * Guided Gemini Web browser login ("launch-and-drive" with persistent profile).
 *
 * Mirrors `claudeai-browser-launch.ts` (in-page guidance overlay + CDP) and
 * `gmail/login.ts` (durable per-profile user-data-dir so Google sign-in +
 * App-Bound cookies survive across restarts):
 *
 *   1. Launches a visible Chrome on `port` (default 9225) with a persistent
 *      `user-data-dir` at `~/.lm-assist/gemini-web/login-profile/<profile>`,
 *      leaving the user's normal Chrome untouched.
 *   2. Installs the `lm-assist-gemini-login` guide banner on the page so the
 *      user sees why the window opened and that lm-assist never touches their
 *      credentials.
 *   3. `geminiWebLoginStatus(port)` runs `snippetHealthCheck()` + `snippetIdentify()`
 *      in the active tab, flips the banner green when sign-in completes, and
 *      reports `{ loggedIn, email, policyName, modelCount, reason, pageUrl }`.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import {
  launchChrome,
  type BrowserKind,
} from './claudeai-browser-launch';
import {
  listTabs,
  evalInTab,
  navigateTab,
  httpGetJSON,
  type CDPTarget,
} from './browser-control';
import { installBanner } from './claudeai-banner';
import { snippetHealthCheck, snippetIdentify } from './gemini-web-via-chrome';

export const DEFAULT_GEMINI_CDP_PORT = 9225;
export const GEMINI_DATA_DIR = path.join(os.homedir(), '.lm-assist', 'gemini-web');
export const GEMINI_LOGIN_URL =
  'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp&passive=false';

const BANNER_ID = 'lm-assist-gemini-login';
const BANNER_MATCH = { include: ['gemini.google.com', 'accounts.google.com', '*.google.com'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface GeminiWebLoginResult {
  ok: true;
  pid: number | null;
  port: number;
  cdpUrl: string;
  profileDir: string;
  loggedIn: boolean;
  email: string | null;
  policyName: string | null;
  modelCount: number;
  pageUrl: string | null;
  note: string;
}

export interface GeminiWebLoginError {
  ok: false;
  code: string;
  message: string;
  hint?: string;
}

export interface GeminiWebLoginStatusResult {
  ok: boolean;
  port: number;
  loggedIn: boolean;
  email: string | null;
  policyName: string | null;
  modelCount?: number;
  reason: string;
  pageUrl: string | null;
  hint?: string;
}

/**
 * Durable per-profile `user-data-dir` under `~/.lm-assist/gemini-web/login-profile/`.
 * Sanitizes profile names to safe filesystem segments.
 */
export function geminiProfileDir(profile = 'default'): string {
  const safe = String(profile || 'default').replace(/[^\w.-]+/g, '_') || 'default';
  return path.join(GEMINI_DATA_DIR, 'login-profile', safe);
}

/**
 * Pure check: when Gemini Web is signed out (which shows Gemini's signed-out
 * prompt box rather than a login form), redirect directly to Google ServiceLogin
 * unless the tab is already on `accounts.google.com`.
 */
export function shouldRedirectToLogin(status: { loggedIn: boolean; pageUrl: string | null }): boolean {
  return !status.loggedIn && !/accounts\.google\.com/i.test(status.pageUrl || '');
}

function pickGeminiTab(tabs: Array<Pick<CDPTarget, 'id' | 'type' | 'url' | 'title'>>) {
  const pages = tabs.filter((t) => t.type === 'page');
  return (
    pages.find((t) => /(^|\.)gemini\.google\.com/i.test(t.url || '')) ||
    pages.find((t) => /\.google\.com/i.test(t.url || '')) ||
    pages[0] ||
    null
  );
}

async function waitForPageTab(port: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tabsRes = await listTabs(port);
    if (tabsRes.ok) {
      const tab = pickGeminiTab(tabsRes.tabs);
      if (tab) return tab;
    }
    await sleep(300);
  }
  return null;
}

/**
 * Check whether the browser on `port` is logged in to Gemini Web.
 * When signed in, updates the `lm-assist-gemini-login` banner to green (`ok`)
 * and returns `{ ok: true, loggedIn: true, email, policyName, modelCount, ... }`.
 */
export async function geminiWebLoginStatus(
  port = DEFAULT_GEMINI_CDP_PORT,
): Promise<GeminiWebLoginStatusResult> {
  const tabsRes = await listTabs(port);
  if (!tabsRes.ok) {
    return {
      ok: false,
      port,
      loggedIn: false,
      email: null,
      policyName: null,
      reason: tabsRes.error.code,
      pageUrl: null,
      hint: `Browser on CDP port ${port} is not reachable (${tabsRes.error.message}). Call POST /gemini-web/browser/login first.`,
    };
  }

  const tab = pickGeminiTab(tabsRes.tabs);
  if (!tab) {
    return {
      ok: false,
      port,
      loggedIn: false,
      email: null,
      policyName: null,
      reason: 'no_tab',
      pageUrl: null,
      hint: `No open page tab found on CDP port ${port}.`,
    };
  }

  const healthEval = await evalInTab(port, tab.id, {
    expression: snippetHealthCheck().snippet,
    timeoutMs: 12_000,
  });

  if (!healthEval.ok || !healthEval.result || typeof healthEval.result !== 'object') {
    return {
      ok: true,
      port,
      loggedIn: false,
      email: null,
      policyName: null,
      reason: 'page_not_ready',
      pageUrl: tab.url || null,
      hint: 'Complete Google sign-in in the Chrome window.',
    };
  }

  const health = healthEval.result as {
    ok?: boolean;
    reason?: string;
    policyName?: string | null;
    modelCount?: number;
    pageUrl?: string;
    hint?: string;
  };

  if (health.ok) {
    let email: string | null = null;
    const idEval = await evalInTab(port, tab.id, {
      expression: snippetIdentify().snippet,
      timeoutMs: 10_000,
    });
    if (idEval.ok && idEval.result && typeof idEval.result === 'object') {
      const r = idEval.result as { email?: unknown };
      if (typeof r.email === 'string' && r.email) email = r.email;
    }

    await installBanner(port, {
      id: BANNER_ID,
      title: 'lm-assist · sign in to Gemini Web',
      status: `Signed in${email ? ` as ${email}` : ''} — Gemini Web bridge is ready.`,
      statusKind: 'ok',
      note: 'Why: lm-assist uses this dedicated Chrome profile for Gemini Web via-Chrome access. Your normal Chrome is untouched.',
      theme: 'dark',
      match: BANNER_MATCH,
      onMismatch: { action: 'hide' },
    }).catch(() => undefined);

    return {
      ok: true,
      port,
      loggedIn: true,
      email,
      policyName: health.policyName ?? null,
      modelCount: typeof health.modelCount === 'number' ? health.modelCount : 0,
      reason: 'ok',
      pageUrl: health.pageUrl || tab.url || null,
    };
  }

  return {
    ok: true,
    port,
    loggedIn: false,
    email: null,
    policyName: health.policyName ?? null,
    reason: health.reason || 'not_logged_in',
    pageUrl: health.pageUrl || tab.url || null,
    hint: health.hint || 'Complete Google sign-in in the Chrome window.',
  };
}

/**
 * Launch (or attach to) a visible Chrome with a persistent Gemini Web profile
 * and install the guided sign-in banner. Leaves the browser open for the user
 * to sign in manually if not already authenticated.
 */
export async function geminiWebLogin(opts: {
  profile?: string;
  port?: number;
  headless?: boolean;
  browser?: BrowserKind | 'any-chromium';
} = {}): Promise<GeminiWebLoginResult | GeminiWebLoginError> {
  const port = opts.port ?? DEFAULT_GEMINI_CDP_PORT;
  const profileDir = geminiProfileDir(opts.profile || 'default');
  const headless = opts.headless === true;

  let pid: number | null = null;
  let alreadyRunning = false;
  try {
    await httpGetJSON(`http://127.0.0.1:${port}/json/version`, 600);
    alreadyRunning = true;
  } catch {
    // Port free — launch a dedicated browser.
  }

  if (!alreadyRunning) {
    const launch = await launchChrome({
      port,
      userDataDir: profileDir,
      startUrl: 'https://gemini.google.com/app',
      browser: opts.browser || 'chrome',
      headless,
    });
    if (!launch.ok) {
      return {
        ok: false,
        code: launch.code,
        message: launch.message,
        hint: launch.hint,
      };
    }
    pid = launch.pid;
  }

  const tab = await waitForPageTab(port, 15_000);
  if (!tab) {
    return {
      ok: false,
      code: 'no_tab',
      message: `Chrome started on port ${port} but no page tab became ready within 15s.`,
    };
  }

  // Brief settle for initial navigation before probing / installing banner.
  await sleep(1500);

  await installBanner(port, {
    id: BANNER_ID,
    title: 'lm-assist · sign in to Gemini Web',
    status: 'Please sign in to your Google account at gemini.google.com — lm-assist will detect sign-in automatically.',
    statusKind: 'default',
    note: 'Why: lm-assist uses this dedicated Chrome profile for Gemini Web via-Chrome access. We never enter your password. Your normal Chrome is untouched.',
    theme: 'info',
    match: BANNER_MATCH,
    onMismatch: { action: 'hide' },
  }).catch(() => undefined);

  const status = await geminiWebLoginStatus(port);
  let pageUrl = status.pageUrl;
  let note = status.loggedIn
    ? `Already logged in${status.email ? ` as ${status.email}` : ''}; Gemini Web bridge is ready.`
    : 'Sign in to Google / Gemini in the opened Chrome window, then poll GET /gemini-web/browser/login/status.';

  if (shouldRedirectToLogin(status)) {
    const nav = await navigateTab(port, tab.id, { url: GEMINI_LOGIN_URL });
    if (nav.ok) {
      pageUrl = GEMINI_LOGIN_URL;
      note = 'Navigated directly to Google sign-in for Gemini. Complete sign-in in the Chrome window, then poll GET /gemini-web/browser/login/status.';
    }
  }

  return {
    ok: true,
    pid,
    port,
    cdpUrl: `http://127.0.0.1:${port}`,
    profileDir,
    loggedIn: status.loggedIn,
    email: status.email,
    policyName: status.policyName,
    modelCount: status.modelCount ?? 0,
    pageUrl,
    note,
  };
}
