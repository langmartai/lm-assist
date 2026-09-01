/**
 * Launch a Chrome instance with `--remote-debugging-port` and capture its
 * claude.ai cookies via CDP. Pairs with `claudeai-browser-profile.ts` —
 * that file discovers Chrome profiles, this one drives one of them.
 *
 * Lifecycle:
 *
 *   1. POST /browser/launch          → spawn chrome.exe (or equivalent)
 *   2. user (or test) logs into claude.ai in the spawned window
 *   3. POST /claude-ai/browser/capture-session → CDP dump cookies → session file
 *   4. POST /browser/close           → tree-kill the spawned pid
 *
 * Why CDP instead of reading Chrome's Cookies SQLite db directly: the db is
 * (a) locked while Chrome is running, (b) encrypted with DPAPI on Windows /
 * libsecret on Linux, decrypted lazily by the browser. CDP gives us decoded
 * cookies — including HttpOnly ones — through a single supported API.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import treeKill from 'tree-kill';
import {
  DEFAULT_DEBUG_PORT,
  ISOLATED_PROFILE_DIR,
  resolveProfile,
  sessionPathForProfile,
  type ChromeProfile,
} from './claudeai-browser-profile';
import {
  CDPSession,
  sendCDP,
  httpGetJSON,
  type CDPVersionInfo,
} from './browser-control';

export interface LaunchOptions {
  /** Profile id ('Default', 'Profile 1', …) or 'isolated' for a fresh data dir. */
  profile?: string;
  /**
   * Explicit persistent user-data-dir. Takes precedence over `profile` when set:
   * the browser runs against exactly this dir (created recursively if missing),
   * with `profileSource: 'isolated'`. Use this when a connector needs its OWN
   * durable profile — e.g. the LinkedIn connector's `~/.lm-assist/linkedin[-dev]/`
   * on port 9223, so a one-time password/2FA login survives restarts rather than
   * colliding with 'isolated' (single shared dir) or 'Default' (the user's Chrome).
   */
  userDataDir?: string;
  /** Debug port; defaults to 9222. */
  port?: number;
  /** Run hidden (no window). Useful for CI; humans want headless=false. */
  headless?: boolean;
  /**
   * URL the browser opens on. Defaults to claude.ai (this launcher's original
   * job). Connectors launching their own persistent-profile browsers pass
   * their own — a LinkedIn/Gmail login window that first paints claude.ai
   * reads as the wrong browser to the operator standing at the machine.
   */
  startUrl?: string;
  /** Extra browser flags. */
  extraArgs?: string[];
  /**
   * Which browser to launch. 'chrome' / 'edge' / 'brave' / 'chromium' /
   * 'vivaldi' / 'opera' are Chromium-based — same CDP feature set.
   * 'firefox' launches Firefox with --remote-debugging-port, which uses
   * WebDriver-BiDi internally; only a subset of CDP methods works.
   * Defaults to the first available Chromium browser.
   */
  browser?: BrowserKind | 'any-chromium';
}

/**
 * Pure arg builder — exported for tests. Ordering is load-bearing and matches
 * the historical behavior exactly: chromium puts the URL after the flags with
 * `--headless=new` appended after it, `--profile-directory` unshifted to the
 * front, and extraArgs always last; firefox pushes `--headless` before the URL.
 */
export function buildBrowserArgs(
  family: 'firefox' | 'chromium',
  cfg: {
    port: number;
    userDataDir: string;
    profileDirectory?: string;
    headless?: boolean;
    startUrl?: string;
    extraArgs?: string[];
  },
): string[] {
  const startUrl = cfg.startUrl || 'https://claude.ai/';
  let args: string[];
  if (family === 'firefox') {
    // Firefox: --remote-debugging-port is supported but only exposes
    // WebDriver-BiDi by default. CDP support is partial and varies by
    // version; many endpoints (Storage.getCookies, Page.addScriptToEvalu-
    // ateOnNewDocument) are not implemented. Caller should treat this
    // as best-effort.
    args = [
      '--remote-debugging-port', String(cfg.port),
      '--profile', cfg.userDataDir,
      '--no-remote',
    ];
    if (cfg.headless) args.push('--headless');
    args.push(startUrl);
  } else {
    args = [
      `--remote-debugging-port=${cfg.port}`,
      `--user-data-dir=${cfg.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=ChromeWhatsNewUI,PrivacySandboxSettings4',
      startUrl,
    ];
    if (cfg.profileDirectory) args.unshift(`--profile-directory=${cfg.profileDirectory}`);
    if (cfg.headless) args.push('--headless=new');
  }
  if (cfg.extraArgs) args.push(...cfg.extraArgs);
  return args;
}

export interface LaunchResult {
  ok: true;
  pid: number;
  port: number;
  userDataDir: string;
  profileDirectory: string | null;
  profileSource: 'isolated' | 'existing';
  chromeBinary: string;
  /** Which browser was launched. */
  browser: BrowserKind;
  /** chromium = full CDP. firefox = WebDriver-BiDi + partial CDP shim. */
  browserFamily: 'chromium' | 'firefox';
  /** chrome://inspect URL the user can paste to inspect targets. */
  devtoolsUrl: string;
  /** Where the captured session file would land. */
  expectedSessionPath: string;
}

export interface LaunchError {
  ok: false;
  code:
    | 'unsupported_platform'
    | 'chrome_not_found'
    | 'profile_not_found'
    | 'profile_locked'
    | 'already_running'
    | 'spawn_failed';
  message: string;
  hint?: string;
}

export type BrowserKind = 'chrome' | 'edge' | 'brave' | 'vivaldi' | 'chromium' | 'firefox' | 'opera';

export interface BrowserInfo {
  kind: BrowserKind;
  /** Family: 'chromium' (CDP-compatible) or 'firefox' (WebDriver-BiDi, partial CDP shim). */
  family: 'chromium' | 'firefox';
  binary: string;
  /** Optional human label. */
  label: string;
}

/** Find ALL installed CDP-capable + Firefox browsers on this host. */
export function findInstalledBrowsers(): BrowserInfo[] {
  const out: BrowserInfo[] = [];
  const add = (kind: BrowserKind, family: 'chromium' | 'firefox', binary: string, label: string) => {
    if (fs.existsSync(binary)) out.push({ kind, family, binary, label });
  };

  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pfx86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const lad = process.env['LOCALAPPDATA'] || '';
    add('chrome',  'chromium', path.join(pf,    'Google', 'Chrome', 'Application', 'chrome.exe'), 'Google Chrome');
    add('chrome',  'chromium', path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Google Chrome (x86)');
    if (lad) add('chrome', 'chromium', path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Google Chrome (user)');
    add('edge',    'chromium', path.join(pf,    'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Microsoft Edge');
    add('edge',    'chromium', path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Microsoft Edge (x86)');
    add('brave',   'chromium', path.join(pf,    'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), 'Brave');
    add('brave',   'chromium', path.join(pfx86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), 'Brave (x86)');
    add('vivaldi', 'chromium', path.join(pf,    'Vivaldi', 'Application', 'vivaldi.exe'), 'Vivaldi');
    add('opera',   'chromium', path.join(pf,    'Opera', 'launcher.exe'), 'Opera');
    add('firefox', 'firefox',  path.join(pf,    'Mozilla Firefox', 'firefox.exe'), 'Mozilla Firefox');
    add('firefox', 'firefox',  path.join(pfx86, 'Mozilla Firefox', 'firefox.exe'), 'Mozilla Firefox (x86)');
  } else if (process.platform === 'darwin') {
    add('chrome',   'chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Google Chrome');
    add('edge',     'chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Microsoft Edge');
    add('brave',    'chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'Brave');
    add('chromium', 'chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium', 'Chromium');
    add('firefox',  'firefox',  '/Applications/Firefox.app/Contents/MacOS/firefox', 'Firefox');
  } else {
    // Linux: PATH discovery.
    const dirs = (process.env.PATH || '').split(path.delimiter);
    const tryPath = (kind: BrowserKind, family: 'chromium' | 'firefox', name: string, label: string) => {
      for (const d of dirs) {
        const p = path.join(d, name);
        if (fs.existsSync(p)) { out.push({ kind, family, binary: p, label }); return true; }
      }
      return false;
    };
    tryPath('chrome',   'chromium', 'google-chrome', 'Google Chrome') ||
      tryPath('chrome', 'chromium', 'google-chrome-stable', 'Google Chrome');
    tryPath('chromium', 'chromium', 'chromium-browser', 'Chromium') ||
      tryPath('chromium', 'chromium', 'chromium', 'Chromium');
    tryPath('edge',     'chromium', 'microsoft-edge', 'Microsoft Edge') ||
      tryPath('edge',  'chromium', 'microsoft-edge-stable', 'Microsoft Edge');
    tryPath('brave',    'chromium', 'brave-browser', 'Brave');
    tryPath('vivaldi',  'chromium', 'vivaldi', 'Vivaldi');
    tryPath('opera',    'chromium', 'opera', 'Opera');
    tryPath('firefox',  'firefox',  'firefox', 'Firefox') ||
      tryPath('firefox', 'firefox', 'firefox-esr', 'Firefox ESR');
  }
  return out;
}

/** Back-compat: legacy single-binary Chrome finder. */
export function findChromeBinary(): string | null {
  const chrome = findInstalledBrowsers().find((b) => b.kind === 'chrome');
  return chrome?.binary || null;
}

/** Find a browser by kind/family. */
export function findBrowser(kind: BrowserKind | 'any-chromium'): BrowserInfo | null {
  const list = findInstalledBrowsers();
  if (kind === 'any-chromium') return list.find((b) => b.family === 'chromium') || null;
  return list.find((b) => b.kind === kind) || null;
}

/**
 * Detect if a usable X display is available on Linux for GUI Chrome.
 * On Windows/macOS this returns true unconditionally.
 */
function hasUsableDisplay(): { ok: boolean; display?: string; reason?: string } {
  if (process.platform !== 'linux') return { ok: true };
  if (process.env.DISPLAY) return { ok: true, display: process.env.DISPLAY };
  if (process.env.WAYLAND_DISPLAY) return { ok: true, display: process.env.WAYLAND_DISPLAY };
  // Common fallback: X server at :0 with a Unix socket. We can auto-set
  // DISPLAY=:0 if /tmp/.X11-unix/X0 exists. Chrome inherits it via env.
  try {
    if (fs.existsSync('/tmp/.X11-unix/X0')) return { ok: true, display: ':0' };
  } catch { /* ignore */ }
  return { ok: false, reason: 'no DISPLAY env and no /tmp/.X11-unix/X0 socket; pass {"headless": true} or set DISPLAY before starting lm-assist' };
}

/**
 * Detect whether the User Data dir is already in use by another Chrome
 * instance. Best-effort: looks for the "SingletonLock" / "lockfile" Chrome
 * writes when it starts. Not 100% reliable across Chrome versions but
 * correct often enough to give the caller a meaningful error instead of
 * "spawn worked, debug port never came up".
 */
function isUserDataDirLocked(userDataDir: string): boolean {
  const candidates = [
    path.join(userDataDir, 'SingletonLock'),    // Linux/macOS symlink target
    path.join(userDataDir, 'SingletonCookie'),  // Linux/macOS
    path.join(userDataDir, 'lockfile'),         // legacy
  ];
  for (const c of candidates) {
    try {
      // lstat: detect even a dangling symlink (Chrome on Linux/macOS).
      fs.lstatSync(c);
      return true;
    } catch {
      // not present
    }
  }
  return false;
}

// httpGetJSON now imported from ./browser-control

/** Poll `/json/version` until the debug port responds or timeout. */
async function waitForDebugPort(port: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      await httpGetJSON(`http://127.0.0.1:${port}/json/version`, 1500);
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`Debug port ${port} did not respond within ${timeoutMs}ms (last: ${(lastErr as Error)?.message})`);
}

export async function launchChrome(opts: LaunchOptions = {}): Promise<LaunchResult | LaunchError> {
  const port = opts.port ?? DEFAULT_DEBUG_PORT;
  const profileChoice = opts.profile || 'isolated';
  const browserChoice: BrowserKind | 'any-chromium' = opts.browser || 'any-chromium';

  // Pick the actual binary.
  const browser = findBrowser(browserChoice);
  if (!browser) {
    const installed = findInstalledBrowsers().map((b) => b.kind).join(', ') || '(none)';
    return {
      ok: false,
      code: 'chrome_not_found',
      message: `Browser '${browserChoice}' not found. Installed on this host: ${installed}.`,
      hint: 'Pass {"browser": "<one-of-installed>"} or install the requested browser.',
    };
  }
  const chromeBinary = browser.binary;

  // Resolve user-data-dir and profile-directory.
  let userDataDir: string;
  let profileDirectory: string | null = null;
  let profileSource: 'isolated' | 'existing';

  if (opts.userDataDir) {
    // Explicit persistent dir wins over `profile` — a connector-owned profile.
    userDataDir = opts.userDataDir;
    profileSource = 'isolated';
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
    } catch (e) {
      return {
        ok: false,
        code: 'spawn_failed',
        message: `Cannot create user-data-dir '${userDataDir}': ${(e as Error).message}`,
      };
    }
  } else if (profileChoice === 'isolated') {
    userDataDir = ISOLATED_PROFILE_DIR;
    profileSource = 'isolated';
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
    } catch (e) {
      return {
        ok: false,
        code: 'spawn_failed',
        message: `Cannot create isolated profile dir: ${(e as Error).message}`,
      };
    }
  } else {
    const profile = resolveProfile(profileChoice);
    if (!profile) {
      return {
        ok: false,
        code: 'profile_not_found',
        message: `No Chrome profile matches '${profileChoice}'. See GET /browser/profiles.`,
      };
    }
    // Use the existing User Data dir + --profile-directory to select inside it.
    // This is the only way to inherit the existing login.
    userDataDir = path.dirname(profile.profileDir);
    profileDirectory = profile.id;
    profileSource = 'existing';

    if (isUserDataDirLocked(userDataDir)) {
      return {
        ok: false,
        code: 'profile_locked',
        message: `Chrome's User Data dir is locked — another Chrome instance is running against it.`,
        hint: 'Close all Chrome windows, then retry. Or use { "profile": "isolated" } for a separate browser instance.',
      };
    }
  }

  // Check the debug port isn't already in use. We don't have get-port-please
  // here to keep dep surface tight; a quick GET is enough.
  try {
    await httpGetJSON(`http://127.0.0.1:${port}/json/version`, 500);
    return {
      ok: false,
      code: 'already_running',
      message: `Debug port ${port} already has a Chrome instance attached. Use a different port or call /close first.`,
    };
  } catch {
    // expected — port is free
  }

  // Build args. Chromium and Firefox use different syntaxes.
  const args = buildBrowserArgs(browser.family === 'firefox' ? 'firefox' : 'chromium', {
    port,
    userDataDir,
    profileDirectory: profileDirectory ?? undefined,
    headless: opts.headless,
    startUrl: opts.startUrl,
    extraArgs: opts.extraArgs,
  });

  // GUI mode on Linux needs DISPLAY. lm-assist's daemon process often has
  // no DISPLAY (started before X server / from systemd). If we're going
  // GUI on Linux and lack DISPLAY, try /tmp/.X11-unix/X0 → DISPLAY=:0.
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
  if (!opts.headless && process.platform === 'linux') {
    const disp = hasUsableDisplay();
    if (!disp.ok) {
      return {
        ok: false,
        code: 'spawn_failed',
        message: `Cannot launch GUI browser: ${disp.reason}.`,
        hint: 'Pass {"headless": true} for headless mode, or set DISPLAY in lm-assist\'s environment before starting it.',
      };
    }
    if (!spawnEnv.DISPLAY && disp.display) spawnEnv.DISPLAY = disp.display;
  }

  let child: ChildProcess;
  try {
    child = spawn(chromeBinary, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: spawnEnv,
    });
    child.unref();
  } catch (e) {
    return {
      ok: false,
      code: 'spawn_failed',
      message: `Failed to spawn browser: ${(e as Error).message}`,
    };
  }

  if (!child.pid) {
    return { ok: false, code: 'spawn_failed', message: 'Chrome spawned but no PID was returned.' };
  }

  try {
    await waitForDebugPort(port);
  } catch (e) {
    try { treeKill(child.pid!, 'SIGKILL', () => undefined); } catch { /* ignore */ }
    const isFirefox = browser.family === 'firefox';
    return {
      ok: false,
      code: 'spawn_failed',
      message: (e as Error).message,
      hint: isFirefox
        ? 'Firefox exposes WebDriver-BiDi (not CDP) on --remote-debugging-port by default. CDP requires `about:config remote.active-protocols=2`, and snap-packaged Firefox often can\'t bind custom profile dirs. Use Chrome/Edge/Brave for full support.'
        : `${browser.label} started but didn't bring up the debug port. Common causes: enterprise policy disables remote debugging; sandboxed install (snap, App Store) blocks custom user-data-dir; arg quoting issues on Windows with spaces in path.`,
    };
  }

  // Post-spawn verification. A dead child.pid does NOT by itself mean the launch
  // failed: Chrome on Windows routinely relaunches itself (the process we spawned
  // exits while the real browser keeps running on the debug port), so failing on
  // `!isPidAlive(child.pid)` false-negatives every launch on that platform. The
  // risk this guard exists for — a *foreign* Chrome owning the port — is already
  // excluded by the pre-spawn port-free check above (we refused with
  // 'already_running' if anything answered on `port`). So treat the launch as
  // good while the debug port is still live; only fail if the spawned PID is gone
  // AND the port has stopped responding.
  if (!isPidAlive(child.pid)) {
    let portAlive = false;
    try {
      await httpGetJSON(`http://127.0.0.1:${port}/json/version`, 1500);
      portAlive = true;
    } catch {
      /* port no longer answering — the browser really did go away */
    }
    if (!portAlive) {
      return {
        ok: false,
        code: 'spawn_failed',
        message: `Spawned Chrome (PID ${child.pid}) exited and debug port ${port} stopped responding.`,
      };
    }
    // else: the spawned PID re-parented but the browser is up on the port we
    // verified was free before spawn — normal on Windows; accept it.
  }

  // The capture endpoint uses this name when no profile is named at capture time.
  const expectedSessionPath = sessionPathForProfile(
    profileSource === 'isolated' ? 'isolated' : profileDirectory || 'isolated'
  );

  return {
    ok: true,
    pid: child.pid,
    port,
    userDataDir,
    profileDirectory,
    profileSource,
    chromeBinary,
    browser: browser.kind,
    browserFamily: browser.family,
    devtoolsUrl: `http://127.0.0.1:${port}/`,
    expectedSessionPath,
  };
}

/** Check if a PID is alive without sending a signal. */
function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 sends no signal but throws if the process doesn't exist.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CDP cookie capture — primitives (CDPSession, sendCDP, httpGetJSON,
// CDPVersionInfo) now imported from ./browser-control.
// ─────────────────────────────────────────────────────────────────────────────

interface CDPCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
}

/**
 * Convert a CDP cookie's `expires` field (epoch SECONDS) to a millisecond
 * timestamp, or return null for session cookies / cookies with no fixed expiry.
 *
 * CDP semantics:
 *   - `session: true`   → session cookie (lives until logout); no fixed expiry.
 *   - `expires <= 0`    → no fixed expiry (e.g. -1 from Chrome for session cookies).
 *   - `expires > 0`     → epoch seconds; multiply by 1000 for ms.
 */
export function cdpExpiresToMs(c: { expires: number; session: boolean } | undefined): number | null {
  if (!c || c.session || !(c.expires > 0)) return null;
  return Math.round(c.expires * 1000);
}

export interface CaptureResult {
  ok: true;
  /** Per-profile session file actually written. */
  sessionFile: string;
  /** Also wrote/updated the canonical ~/.claude/claudeai-session.json. */
  canonicalUpdated: boolean;
  /** Subset of cookies relevant to claude.ai (count + names). */
  cookieCount: number;
  cookieNames: string[];
  /** Whether the captured set contains the auth-critical sessionKey. */
  hasSessionKey: boolean;
  /** Whether a fresh cf_clearance is present (~30 min lifetime). */
  hasCfClearance: boolean;
  /** Logged-in claude.ai email if the running session can resolve it. */
  accountEmail?: string;
  /** orgUuid derived from lastActiveOrg cookie. */
  orgUuid?: string;
  /**
   * Expiry of the sessionKey cookie in epoch ms, or null if it is a session
   * cookie (no fixed expiry). Undefined if the cookie was not captured.
   */
  sessionKeyExpiresAt?: number | null;
}

export interface CaptureError {
  ok: false;
  code:
    | 'debug_port_unreachable'
    | 'no_claude_target'
    | 'capture_failed'
    | 'no_session_cookies'
    | 'write_failed';
  message: string;
  hint?: string;
}

/**
 * Low-level: get all cookies from the running Chrome's browser target.
 * Returns version info + raw CDP cookie array. Used by both captureSession
 * (writes a session file) and pollForLogin (just inspects).
 */
async function fetchCDPCookies(port: number): Promise<
  | { ok: true; version: CDPVersionInfo; cookies: CDPCookie[] }
  | { ok: false; code: 'debug_port_unreachable' | 'capture_failed'; message: string }
> {
  let version: CDPVersionInfo;
  try {
    version = await httpGetJSON<CDPVersionInfo>(`http://127.0.0.1:${port}/json/version`);
  } catch (e) {
    return { ok: false, code: 'debug_port_unreachable', message: `Debug port ${port}: ${(e as Error).message}` };
  }
  if (!version.webSocketDebuggerUrl) {
    return { ok: false, code: 'debug_port_unreachable', message: 'CDP /json/version had no webSocketDebuggerUrl.' };
  }
  let cookieResp: { cookies: CDPCookie[] };
  try {
    cookieResp = await sendCDP<{ cookies: CDPCookie[] }>(version.webSocketDebuggerUrl, 'Storage.getCookies');
  } catch (e1) {
    try {
      cookieResp = await sendCDP<{ cookies: CDPCookie[] }>(version.webSocketDebuggerUrl, 'Network.getAllCookies');
    } catch (e2) {
      return {
        ok: false,
        code: 'capture_failed',
        message: `CDP cookie dump failed — Storage.getCookies (${(e1 as Error).message}); Network.getAllCookies (${(e2 as Error).message})`,
      };
    }
  }
  return { ok: true, version, cookies: cookieResp.cookies };
}

/** Filter to claude.ai-relevant cookies + flag the auth-critical ones. */
function analyzeClaudeCookies(all: CDPCookie[]): {
  byName: Map<string, CDPCookie>;
  cookieNames: string[];
  hasSessionKey: boolean;
  hasCfClearance: boolean;
  orgUuid?: string;
  cookieHeader: string;
} {
  const isClaudeDomain = (d: string): boolean => {
    const lower = d.toLowerCase().replace(/^\./, '');
    return lower === 'claude.ai' || lower.endsWith('.claude.ai') || lower === 'anthropic.com' || lower.endsWith('.anthropic.com');
  };
  const relevant = all.filter((c) => isClaudeDomain(c.domain));
  const byName = new Map<string, CDPCookie>();
  for (const c of relevant) byName.set(c.name, c);
  return {
    byName,
    cookieNames: Array.from(byName.keys()).sort(),
    hasSessionKey: (byName.get('sessionKey')?.value || '').startsWith('sk-ant-sid'),
    hasCfClearance: !!byName.get('cf_clearance')?.value,
    orgUuid: byName.get('lastActiveOrg')?.value,
    cookieHeader: Array.from(byName.values())
      .map((c) => `${c.name}=${c.value}`)
      .join('; '),
  };
}

/** Capture cookies from the spawned Chrome instance and write a session file. */
export async function captureSession(opts: {
  port?: number;
  profileId?: string;
  /** Also overwrite ~/.claude/claudeai-session.json so existing cookie-file routes pick it up. */
  setCanonical?: boolean;
}): Promise<CaptureResult | CaptureError> {
  const port = opts.port ?? DEFAULT_DEBUG_PORT;
  const setCanonical = opts.setCanonical !== false; // default true

  const fetched = await fetchCDPCookies(port);
  if (!fetched.ok) {
    return {
      ok: false,
      code: fetched.code,
      message: fetched.message,
      hint: fetched.code === 'debug_port_unreachable'
        ? 'Call POST /browser/launch first, or check that Chrome is still running.'
        : undefined,
    };
  }
  const { version, cookies } = fetched;

  const analyzed = analyzeClaudeCookies(cookies);
  if (analyzed.byName.size === 0) {
    return {
      ok: false,
      code: 'no_session_cookies',
      message: 'No claude.ai cookies found in the captured Chrome session.',
      hint: 'Log in to https://claude.ai/ in the launched Chrome window first, then retry capture-session.',
    };
  }

  const profileId = opts.profileId || 'isolated';
  const sessionFile = sessionPathForProfile(profileId);
  const canonicalFile = path.join(os.homedir(), '.claude', 'claudeai-session.json');

  const payload = {
    cookie: analyzed.cookieHeader,
    capturedAt: new Date().toISOString(),
    capturedFromProfile: profileId,
    capturedFromPort: port,
    chromeUserAgent: version['User-Agent'] || null,
    chromeBrowser: version['Browser'] || null,
    cookieNames: analyzed.cookieNames,
    cookieExpiries: {
      sessionKey: cdpExpiresToMs(analyzed.byName.get('sessionKey')),
      cf_clearance: cdpExpiresToMs(analyzed.byName.get('cf_clearance')),
      __cf_bm: cdpExpiresToMs(analyzed.byName.get('__cf_bm')),
    },
  };

  try {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  } catch (e) {
    return { ok: false, code: 'write_failed', message: `Failed to write ${sessionFile}: ${(e as Error).message}` };
  }

  let canonicalUpdated = false;
  if (setCanonical) {
    try {
      fs.writeFileSync(canonicalFile, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
      canonicalUpdated = true;
    } catch {
      // soft-fail — per-profile file is what really matters for forwards.
    }
  }

  return {
    ok: true,
    sessionFile,
    canonicalUpdated,
    cookieCount: analyzed.byName.size,
    cookieNames: analyzed.cookieNames,
    hasSessionKey: analyzed.hasSessionKey,
    hasCfClearance: analyzed.hasCfClearance,
    orgUuid: analyzed.orgUuid,
    sessionKeyExpiresAt: cdpExpiresToMs(analyzed.byName.get('sessionKey')),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Login polling — auto-detect when sessionKey appears
// ─────────────────────────────────────────────────────────────────────────────

export interface PollLoginResult {
  ok: true;
  detectedAfterMs: number;
  orgUuid?: string;
}

export interface PollLoginError {
  ok: false;
  code: 'login_timeout' | 'chrome_exited' | 'debug_port_unreachable';
  message: string;
  lastObservedCookieCount?: number;
}

/** Classify the user's current login stage from the active page URL. */
function classifyLoginStage(url: string | undefined): {
  stage: 'opening' | 'claude_login' | 'google_signin' | 'oauth_consent' | 'redirecting_back' | 'in_app' | 'other';
  message: string;
} {
  if (!url) return { stage: 'opening', message: '⏳ Opening claude.ai…' };
  const u = url.toLowerCase();
  if (u === 'about:blank' || u.startsWith('chrome://')) return { stage: 'opening', message: '⏳ Opening claude.ai…' };
  if (u.includes('claude.ai/login')) {
    return { stage: 'claude_login', message: '⏳ Sign in below — pick the Google account you want lm-assist to use.' };
  }
  if (u.includes('accounts.google.com/signin/oauth') || u.includes('accounts.google.com/o/oauth')) {
    return { stage: 'oauth_consent', message: '⏳ Approve the OAuth request to grant claude.ai access — we\'ll capture as soon as the redirect completes.' };
  }
  if (u.includes('accounts.google.com')) {
    return { stage: 'google_signin', message: '⏳ Signing in with Google — pick your account / enter your password to continue.' };
  }
  // claude.ai or anthropic.com but NOT /login — could be loading dashboard, redirect chain mid-flight, etc.
  if (u.includes('claude.ai') || u.includes('anthropic.com')) {
    return { stage: 'redirecting_back', message: '⏳ Returning to claude.ai — almost there.' };
  }
  return { stage: 'other', message: `⏳ Waiting (unexpected URL: ${url}).` };
}

interface CDPTargetForUrl { type: string; url: string }

async function getActiveClaudeOrGoogleUrl(port: number): Promise<string | undefined> {
  try {
    const targets = await httpGetJSON<CDPTargetForUrl[]>(`http://127.0.0.1:${port}/json/list`);
    const pages = targets.filter((t) => t.type === 'page');
    // Prefer a claude.ai or google sign-in page over chrome://newtab.
    const interesting = pages.find((p) =>
      /claude\.ai|accounts\.google\.com|anthropic\.com/i.test(p.url)
    );
    return (interesting || pages[0])?.url;
  } catch {
    return undefined;
  }
}

/**
 * Poll Chrome's cookie store until the auth-critical `sessionKey` cookie
 * appears. As we wait, classify the user's stage from the active page URL
 * and push that into the overlay so they always know what's happening.
 */
export async function pollForLogin(opts: {
  port: number;
  pid?: number;
  timeoutMs?: number;
  intervalMs?: number;
  /** When provided, called every poll tick with a fresh status message + ok flag. */
  onProgress?: (message: string, ok: boolean, stage: string) => void | Promise<void>;
}): Promise<PollLoginResult | PollLoginError> {
  const port = opts.port;
  const timeoutMs = opts.timeoutMs ?? 300_000; // 5 min default (was 3) — SSO takes time
  const intervalMs = opts.intervalMs ?? 1000;
  const start = Date.now();
  let lastCookieCount = 0;
  let lastStage = '';
  while (Date.now() - start < timeoutMs) {
    if (opts.pid && !isPidAlive(opts.pid)) {
      return { ok: false, code: 'chrome_exited', message: `Chrome (PID ${opts.pid}) exited before login completed.`, lastObservedCookieCount: lastCookieCount };
    }
    const fetched = await fetchCDPCookies(port);
    if (!fetched.ok) {
      // Transient errors are OK — Chrome may be mid-navigation. Retry.
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    const analyzed = analyzeClaudeCookies(fetched.cookies);
    lastCookieCount = analyzed.byName.size;
    if (analyzed.hasSessionKey) {
      return { ok: true, detectedAfterMs: Date.now() - start, orgUuid: analyzed.orgUuid };
    }

    // Not logged in yet — classify the stage and push a message into the
    // overlay so the user knows where they are in the flow. Only when the
    // stage actually changes (avoid spamming the same Runtime.evaluate).
    const url = await getActiveClaudeOrGoogleUrl(port);
    const { stage, message } = classifyLoginStage(url);
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const annotated = elapsed > 30 ? `${message} (${elapsed}s elapsed, will wait up to ${Math.floor(timeoutMs/1000)}s)` : message;
    if (stage !== lastStage && opts.onProgress) {
      lastStage = stage;
      try { await opts.onProgress(annotated, false, stage); } catch { /* ignore overlay update failures */ }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, code: 'login_timeout', message: `sessionKey did not appear within ${timeoutMs}ms.`, lastObservedCookieCount: lastCookieCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay injection — tell the user what to do in the spawned browser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the overlay script with a specified initial status. We re-register
 * the script on every status change so any subsequent hard navigation lands
 * on the freshest text (otherwise the new doc would reset to "waiting").
 */
function buildOverlayScript(initialStatus: string, initialOk: boolean): string {
  return `
(function() {
  // ALWAYS update the desired-status global so the most recent Page.addScript
  // wins on next navigation, even if a prior install was already done.
  window.__lmAssistDesiredStatus = ${JSON.stringify({ text: initialStatus, ok: initialOk })};

  // If a previous registration already installed the machinery, just push
  // the new status through it and bail.
  if (window.__lmAssistOverlayInstalled && window.__lmAssistSetStatus) {
    window.__lmAssistSetStatus(window.__lmAssistDesiredStatus.text, window.__lmAssistDesiredStatus.ok);
    return;
  }
  window.__lmAssistOverlayInstalled = true;

  function render() {
    if (document.getElementById('__lm-assist-overlay')) return;
    var el = document.createElement('div');
    el.id = '__lm-assist-overlay';
    var d = window.__lmAssistDesiredStatus || { text: 'Working…', ok: false };
    el.innerHTML = [
      '<style>',
      '  #__lm-assist-overlay { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;',
      '    background: #1a1d29; color: #f8f9fb; padding: 12px 48px 12px 20px;',
      '    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; font-size: 13px;',
      '    line-height: 1.55; border-bottom: 2px solid #d97757; box-shadow: 0 4px 14px rgba(0,0,0,.35); }',
      '  #__lm-assist-overlay strong { color: #d97757; font-size: 14px; }',
      '  #__lm-assist-overlay p { margin: 2px 0; }',
      '  #__lm-assist-overlay .lm-small { color: #b8bcc7; font-size: 11.5px; }',
      '  #__lm-assist-overlay .lm-close { position: absolute; top: 8px; right: 12px;',
      '    background: none; border: none; color: #f8f9fb; cursor: pointer; font-size: 18px; opacity: .7; }',
      '  #__lm-assist-overlay .lm-close:hover { opacity: 1; }',
      '  #__lm-assist-overlay .lm-status-ok { color: #4ade80; }',
      '</style>',
      '<button class="lm-close" onclick="document.getElementById(\\'__lm-assist-overlay\\').style.display=\\'none\\'">×</button>',
      '<strong>lm-assist · capturing claude.ai session</strong>',
      '<p id="__lm-assist-status" class="' + (d.ok ? 'lm-status-ok' : '') + '">' + (d.text || '') + '</p>',
      '<p class="lm-small">Why: lm-assist makes headless /api/* calls (list conversations, projects, etc.) — those need your session cookies. We auto-detect when you finish login (no further action). This is an isolated browser owned by lm-assist; your normal Chrome is untouched.</p>'
    ].join('');
    (document.body || document.documentElement).appendChild(el);
  }

  function setStatus(text, ok) {
    window.__lmAssistDesiredStatus = { text: text, ok: !!ok };
    var p = document.getElementById('__lm-assist-status');
    if (p) {
      p.textContent = text;
      p.className = ok ? 'lm-status-ok' : '';
    }
  }
  window.__lmAssistSetStatus = setStatus;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
  // Re-render if claude.ai's SPA wipes our node during route changes.
  new MutationObserver(function() {
    if (!document.getElementById('__lm-assist-overlay')) render();
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
`;
}

const INITIAL_OVERLAY_STATUS = 'Checking sign-in status…';

// CDPSession class is now imported from ./browser-control

/**
 * Per-target tracker: keeps a CDP session open against each page target
 * so addScriptToEvaluateOnNewDocument registrations survive hard
 * navigations. Polls /json/list to attach to new pages as they appear.
 *
 * `currentStatus` is the desired overlay status — every new session inherits
 * it on attach, and `setStatus` re-registers the script across all sessions
 * so future hard navigations land on the freshest text instead of resetting
 * to the original "Waiting for sign-in" message.
 */
interface SessionSlot {
  session: CDPSession;
  /** Most recent Page.addScriptToEvaluateOnNewDocument identifier. */
  lastScriptId: string | null;
}

interface OverlayHandle {
  sessions: Map<string, SessionSlot>;
  poller: NodeJS.Timeout | null;
  currentStatus: { text: string; ok: boolean };
  setStatus: (text: string, ok: boolean) => Promise<void>;
  close: () => void;
}

interface CDPTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function attachOverlayToTarget(
  target: CDPTarget,
  status: { text: string; ok: boolean },
): Promise<SessionSlot | null> {
  try {
    const session = new CDPSession(target.webSocketDebuggerUrl);
    await session.ready();
    await session.send('Page.enable');
    const source = buildOverlayScript(status.text, status.ok);
    const reg = await session.send<{ identifier: string }>(
      'Page.addScriptToEvaluateOnNewDocument',
      { source },
    );
    await session.send('Runtime.evaluate', { expression: source, awaitPromise: false });
    return { session, lastScriptId: reg?.identifier || null };
  } catch {
    return null;
  }
}

async function rewriteOverlayOnSlot(slot: SessionSlot, status: { text: string; ok: boolean }): Promise<void> {
  // 1. DOM update in the current document.
  try {
    const expr = `window.__lmAssistSetStatus && window.__lmAssistSetStatus(${JSON.stringify(status.text)}, ${status.ok ? 'true' : 'false'})`;
    await slot.session.send('Runtime.evaluate', { expression: expr, awaitPromise: false });
  } catch { /* best-effort */ }
  // 2. Drop the previous Page.addScript so we don't accumulate registrations.
  if (slot.lastScriptId) {
    try { await slot.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: slot.lastScriptId }); } catch { /* ignore */ }
    slot.lastScriptId = null;
  }
  // 3. Register the script again with the new initial status.
  try {
    const reg = await slot.session.send<{ identifier: string }>(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: buildOverlayScript(status.text, status.ok) },
    );
    slot.lastScriptId = reg?.identifier || null;
  } catch { /* ignore */ }
}

/**
 * Attach overlay to all current page targets, return a handle that keeps
 * the registrations alive. The poller picks up any new tabs the user
 * opens during the flow.
 */
export async function installOverlay(port: number): Promise<{ ok: boolean; injectedTargets: number; handle: OverlayHandle }> {
  const sessions = new Map<string, SessionSlot>();
  const status = { text: INITIAL_OVERLAY_STATUS, ok: false };

  async function reconcile() {
    let targets: CDPTarget[];
    try {
      targets = await httpGetJSON<CDPTarget[]>(`http://127.0.0.1:${port}/json/list`);
    } catch {
      return;
    }
    const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    for (const t of pages) {
      if (sessions.has(t.id)) continue;
      const slot = await attachOverlayToTarget(t, status);
      if (slot) sessions.set(t.id, slot);
    }
    const liveIds = new Set(pages.map((p) => p.id));
    for (const [id, slot] of sessions) {
      if (!liveIds.has(id)) { slot.session.close(); sessions.delete(id); }
    }
  }

  // Chrome may not have created the claude.ai page target yet (the URL on
  // cmdline takes a moment to open after debug port comes up). Wait up to
  // 5s for at least one page to appear before returning.
  const waitDeadline = Date.now() + 5000;
  while (sessions.size === 0 && Date.now() < waitDeadline) {
    await reconcile();
    if (sessions.size === 0) await new Promise((r) => setTimeout(r, 250));
  }

  const poller = setInterval(() => { void reconcile(); }, 2000);

  const handle: OverlayHandle = {
    sessions,
    poller,
    currentStatus: status,
    setStatus: async (text: string, ok: boolean) => {
      status.text = text;
      status.ok = ok;
      await reconcile(); // pick up new tabs first so they get the right initial status
      await Promise.all(Array.from(sessions.values()).map((slot) => rewriteOverlayOnSlot(slot, { text, ok })));
    },
    close: () => {
      if (handle.poller) clearInterval(handle.poller);
      handle.poller = null;
      for (const slot of sessions.values()) slot.session.close();
      sessions.clear();
    },
  };

  return { ok: sessions.size > 0, injectedTargets: sessions.size, handle };
}

/** Back-compat: one-shot inject without keeping sessions open (overlay won't survive hard navigations). */
export async function injectOverlay(port: number): Promise<{ ok: boolean; injectedTargets: number; message?: string }> {
  const { ok, injectedTargets, handle } = await installOverlay(port);
  // Caller doesn't get the handle; close shortly. Overlay may disappear on next nav.
  setTimeout(() => handle.close(), 30_000);
  return { ok, injectedTargets };
}

/** Update the overlay status across all open page targets via CDP. */
export async function updateOverlayStatus(port: number, message: string, ok: boolean): Promise<void> {
  interface CDPTarget { type: string; webSocketDebuggerUrl: string }
  let targets: CDPTarget[];
  try {
    targets = await httpGetJSON<CDPTarget[]>(`http://127.0.0.1:${port}/json/list`);
  } catch {
    return;
  }
  const safeMsg = JSON.stringify(message);
  for (const t of targets.filter((x) => x.type === 'page' && x.webSocketDebuggerUrl)) {
    try {
      await sendCDP(t.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: `window.__lmAssistSetStatus && window.__lmAssistSetStatus(${safeMsg}, ${ok ? 'true' : 'false'})`,
        awaitPromise: false,
      });
    } catch {
      // ignore — target may have closed
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite: launch → verify → inject overlay → poll login → capture
// ─────────────────────────────────────────────────────────────────────────────

export interface LaunchAndCaptureResult {
  ok: true;
  launch: LaunchResult;
  overlay: { injectedTargets: number };
  login: { detectedAfterMs: number; alreadyLoggedIn: boolean; orgUuid?: string };
  capture: CaptureResult;
  totalMs: number;
}

export interface LaunchAndCaptureError {
  ok: false;
  code:
    | 'launch_failed'
    | 'login_timeout'
    | 'chrome_exited'
    | 'capture_failed';
  message: string;
  /** Whatever sub-step failed will be present here so the caller can see partial state. */
  launch?: LaunchResult;
  loginPolledMs?: number;
}

export async function launchAndCapture(opts: LaunchOptions & {
  loginTimeoutMs?: number;
  pollIntervalMs?: number;
  setCanonical?: boolean;
}): Promise<LaunchAndCaptureResult | LaunchAndCaptureError | LaunchError> {
  const t0 = Date.now();

  const launch = await launchChrome(opts);
  if (!launch.ok) return launch;

  // Open overlay sessions and KEEP them open for the whole flow so the
  // addScriptToEvaluateOnNewDocument registrations survive hard navigations
  // (claude.ai often redirects e.g. / → /new on load).
  const { injectedTargets, handle: overlayHandle } = await installOverlay(launch.port);

  try {
    // Probe once — if sessionKey is already there (persisted from a prior
    // session in the same profile dir), we can skip login polling entirely.
    const probe = await fetchCDPCookies(launch.port);
    let alreadyLoggedIn = false;
    let probedOrgUuid: string | undefined;
    if (probe.ok) {
      const analyzed = analyzeClaudeCookies(probe.cookies);
      if (analyzed.hasSessionKey) {
        alreadyLoggedIn = true;
        probedOrgUuid = analyzed.orgUuid;
      }
    }

    let loginResult: PollLoginResult;
    if (alreadyLoggedIn) {
      loginResult = { ok: true, detectedAfterMs: 0, orgUuid: probedOrgUuid };
      await overlayHandle.setStatus('✓ Already signed in — capturing session…', true);
    } else {
      const pollResult = await pollForLogin({
        port: launch.port,
        pid: launch.pid,
        timeoutMs: opts.loginTimeoutMs ?? 300_000,
        intervalMs: opts.pollIntervalMs ?? 1000,
        onProgress: async (msg) => { await overlayHandle.setStatus(msg, false); },
      });
      if (!pollResult.ok) {
        await overlayHandle.setStatus(`Login wait failed: ${pollResult.message}`, false);
        return {
          ok: false,
          code: pollResult.code === 'chrome_exited' ? 'chrome_exited' : 'login_timeout',
          message: pollResult.message,
          launch,
        };
      }
      loginResult = pollResult;
      await overlayHandle.setStatus('✓ Login detected — capturing session…', true);
    }

    const capture = await captureSession({
      port: launch.port,
      profileId: opts.profile || 'isolated',
      setCanonical: opts.setCanonical,
    });
    if (!capture.ok) {
      await overlayHandle.setStatus(`Capture failed: ${capture.message}`, false);
      return { ok: false, code: 'capture_failed', message: capture.message, launch };
    }

    await overlayHandle.setStatus(
      `✓ Session captured (${capture.cookieCount} cookies). Safe to close this window.`, true);

    return {
      ok: true,
      launch,
      overlay: { injectedTargets },
      login: { detectedAfterMs: loginResult.detectedAfterMs, alreadyLoggedIn, orgUuid: loginResult.orgUuid },
      capture,
      totalMs: Date.now() - t0,
    };
  } finally {
    // Keep the overlay alive for a bit so the user can read the final
    // status, then drop the sessions. The CDP registration is removed
    // when we close, but the rendered DOM stays until the user navigates.
    setTimeout(() => overlayHandle.close(), 60_000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Close
// ─────────────────────────────────────────────────────────────────────────────

export interface CloseResult {
  ok: boolean;
  killedPid?: number;
  message: string;
}

export async function closeChrome(pid: number): Promise<CloseResult> {
  if (!pid || pid <= 0) {
    return { ok: false, message: 'Invalid pid.' };
  }
  return new Promise((resolve) => {
    treeKill(pid, 'SIGKILL', (err) => {
      if (err) resolve({ ok: false, message: `tree-kill failed: ${err.message}` });
      else resolve({ ok: true, killedPid: pid, message: `Killed pid tree for ${pid}.` });
    });
  });
}
