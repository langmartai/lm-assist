/**
 * Gmail connector — configuration (local / CDP deployment).
 *
 * Like the LinkedIn connector, this drives a logged-in mail.google.com session
 * in a real browser rather than calling an API. That is a deliberate choice and
 * it was MEASURED, not assumed (2026-07-29, against a live Workspace account):
 *
 *   - `/mail/u/0/h/` (the old "basic HTML" Gmail) is RETIRED — it 200s but
 *     redirects into the modern SPA.
 *   - The classic `?ui=2&ik=<ik>&view=tl&rt=j` XHR interface no longer returns
 *     JSON; it serves the SPA shell (`content-type: text/html`, ~1.4 MB).
 *   - `/sync/u/0/i/fd` is binary protobuf (`application/vnd.google.octet-
 *     stream-compressible`), an undocumented wire format.
 *
 * So the practical surface is the rendered DOM — same as LinkedIn. Unlike
 * LinkedIn, Gmail exposes REAL ids as data attributes (`data-legacy-thread-id`,
 * `data-legacy-message-id`), so this connector keys on stable server ids rather
 * than synthesizing them from display names.
 *
 * Files live under `~/.lm-assist/gmail[-dev].json` + `~/.lm-assist/gmail[-dev]/`.
 *
 * ── What lives HERE vs in cdp-client.ts ──────────────────────────────────────
 * This file owns DEPLOYMENT facts (paths, ports, the debug endpoint, the
 * viewport, cached account identity). cdp-client.ts owns DOM facts (selectors,
 * page snippets). A selector must never appear in this file, and a file path
 * must never appear in that one.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mirror the dev/prod split used by connectors.ts / hub config: a build that
// runs from the repo (not node_modules) talks to the dev files.
const IS_DEV_REPO = process.env.LM_ASSIST_PROD === 'true' ? false : !__dirname.includes('node_modules');
const DEV_SUFFIX = IS_DEV_REPO ? '-dev' : '';

const LM_DIR = path.join(os.homedir(), '.lm-assist');
export const GM_CONFIG_FILE = path.join(LM_DIR, `gmail${DEV_SUFFIX}.json`);
/** Directory holding the login profile for this env. */
export const GM_DATA_DIR = path.join(LM_DIR, `gmail${DEV_SUFFIX}`);

/**
 * Default remote-debug port for the Gmail login/driver browser. 9224 so it does
 * not collide with WhatsApp's 9222 or LinkedIn's 9223 — all three can run
 * side by side on one host.
 */
export const DEFAULT_LOGIN_PORT = 9224;

/**
 * Chrome major version used when the real browser has not been probed.
 *
 * Only a fallback - prefer the version reported by the live browser, since a UA
 * claiming a version the installed Chrome does not have is itself a mismatch
 * signal. Bump freely; nothing depends on the exact number.
 */
export const DEFAULT_CHROME_MAJOR = 146;

/**
 * A normal desktop-Chrome User-Agent FOR THIS HOST, forced when the driver
 * browser runs headless.
 *
 * MEASURED: with the default `HeadlessChrome/...` UA, Google serves the degraded
 * `flowName=WebLiteSignIn` sign-in flow; with a normal UA it serves the full
 * `GlifWebSignIn`. Same class of problem the /browser/switch-to-headless route
 * already solves for Cloudflare.
 *
 * MEASURED 2026-07-30 on Windows (107): this used to be a hardcoded
 * `X11; Linux x86_64` string with `Chrome/146`. So a Windows host launched Chrome
 * announcing itself as Linux, at a version the installed browser (149) did not
 * have. A UA that contradicts the platform it runs on is the SAME class of signal
 * as the headless UA it was introduced to hide - it just fails somewhere less
 * obvious than the sign-in flow, and only on the platform nobody tested on.
 *
 * So build it from the host, and pass the real major version whenever a browser
 * has already been probed.
 */
export function headlessUa(chromeMajor?: number): string {
  const major = Number.isFinite(chromeMajor) && Number(chromeMajor) > 0 ? Math.floor(Number(chromeMajor)) : DEFAULT_CHROME_MAJOR;
  const platform =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * Back-compat alias. Evaluated at module load, so it cannot carry a probed
 * version - call headlessUa() directly when one is available.
 */
export const HEADLESS_UA = headlessUa();

// ─── viewport (MEASURED — do not tune by feel) ───────────────────────────────

/**
 * The viewport the driver page is forced to at connect
 * (`Emulation.setDeviceMetricsOverride`).
 *
 * 🔴 MEASURED live 2026-07-29, and the reason this is a named constant rather
 * than an inline literal:
 *   - at **1280** wide Gmail COLLAPSES its action toolbar and exposes only
 *     "Move to" and "Labels" — every other verb (Delete, Mark as unread,
 *     Snooze, Add to Tasks, More) is simply not in the DOM, so an action that
 *     "cannot find the button" is a VIEWPORT bug wearing a selector bug's
 *     clothes;
 *   - at **1680** and **1920** the full action set appears.
 * 1920x1080 is therefore taken from the range that works, at its low end so the
 * page stays cheap to raster.
 *
 * 🔴 Do NOT go wider chasing more controls — nothing further appears above 1920.
 *
 * Also MEASURED: forcing a MOBILE viewport (390x844) does NOT flip Gmail to a
 * mobile UI — it clamps to 980px and the desktop selectors keep working. So no
 * code anywhere may branch on viewport to decide which UI it is talking to;
 * that is what cdp-client's MOBILE_UI landmark guard is for.
 */
export const VIEWPORT = { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false } as const;

// ─── send-as identities ──────────────────────────────────────────────────────

/**
 * One row of Gmail's "Send mail as" table (`#settings/accounts`).
 *
 * 🔴 MEASURED 2026-07-29 and the single most surprising fact about this
 * account: the compose dialog's hidden `input[name="from"]` was
 * `support@langmart.ai`, NOT the primary `yi.huang@databunny.sg`. The account
 * carries 8 send-as identities. So "who is this mail from" is NEVER inferable
 * from the signed-in address and must be READ.
 */
export interface SendAsIdentity {
  /** The address itself, lowercased. */
  email: string;
  /** The display name Gmail shows for it, when there is one. */
  name: string | null;
  /**
   * True for the row whose control reads a bare `default` rather than
   * `make default` — that is the identity a new compose starts with.
   */
  isDefault: boolean;
  /** False when the row says "Not an alias." */
  alias: boolean;
}

export interface GmailConfig {
  /** Optional stable persistent-profile name (default 'gmail'). */
  profile?: string;
  /** The signed-in address, cached from the last status probe. */
  selfEmail?: string;
  /**
   * Cached "Send mail as" table. Cached because reading it means NAVIGATING the
   * driver browser to `#settings/accounts`, which yanks the operator's view out
   * from under them; `gmail_status` must not pay that on every call.
   */
  sendAs?: SendAsIdentity[];
  /** The address Gmail will send as unless a compose overrides it. */
  defaultSendAs?: string | null;
  /** When `sendAs` was last read from the live settings page (epoch ms). */
  sendAsCheckedAt?: number;
}

/** Fields a caller may set via PUT /gmail/config. */
export const CONFIG_FIELDS: ReadonlyArray<keyof GmailConfig> = [
  'profile',
  'selfEmail',
  'sendAs',
  'defaultSendAs',
  'sendAsCheckedAt',
];

export function readGmailConfig(): GmailConfig {
  try {
    return JSON.parse(fs.readFileSync(GM_CONFIG_FILE, 'utf-8')) as GmailConfig;
  } catch {
    return {};
  }
}

/** Merge `patch` into the saved config and persist (0600). Returns the merged config. */
export function writeGmailConfig(patch: Partial<GmailConfig>): GmailConfig {
  const next = { ...readGmailConfig(), ...patch };
  fs.mkdirSync(LM_DIR, { recursive: true });
  fs.writeFileSync(GM_CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/**
 * How long a cached send-as table is trusted before `gmail_status` re-reads it.
 *
 * Read from the environment on EVERY call (like `gmailProvider()` and
 * `syncWindowDays()`) so it can be changed without a restart, and so a test can
 * set it per case. 12h by default: adding a send-as identity is a rare, manual
 * act in Google's settings UI, and the cost of being stale is a stale line in
 * `gmail_status` — whereas the cost of re-reading is navigating the operator's
 * browser away from whatever they were looking at.
 *
 * `0` means "never trust the cache" (always re-read); a negative or unparseable
 * value falls back to the default rather than disabling refresh entirely.
 */
export function sendAsTtlMs(): number {
  const DEF = 12 * 60 * 60 * 1000;
  const raw = process.env.GMAIL_SENDAS_TTL_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEF;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return DEF;
  return Math.min(Math.floor(n), 30 * 24 * 60 * 60 * 1000);
}

/**
 * Per-message body ceiling for a thread read, and the whole-thread ceiling.
 *
 * The RAW read path is COMPLETE by design (that is the entire reason it exists),
 * and "complete" on a 7-message thread MEASURED at 24k–66k chars per message.
 * Unbounded, one `gmail_read_thread` would exceed an MCP result ceiling — the
 * exact failure that killed a 110-message conversation with a 923 KB
 * `mission_list`. So the raw text is bounded on the way out and the truncation
 * is REPORTED per message; it is never silently dropped.
 */
export function maxBodyChars(): number {
  const raw = process.env.GMAIL_MAX_BODY_CHARS;
  const n = Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return 20_000;
  return Math.max(1_000, Math.min(Math.floor(n), 200_000));
}

/** Whole-thread ceiling. Six full messages' worth, then the rest is summarised out. */
export function maxThreadChars(): number {
  return maxBodyChars() * 6;
}

// ─── CDP provider config ─────────────────────────────────────────────────────

/**
 * Which backend this node's Gmail connector uses. Only `cdp` is supported
 * (drive a logged-in mail.google.com session over the Chrome DevTools Protocol).
 * Overridable via GMAIL_PROVIDER for forward-compat.
 */
export function gmailProvider(): string {
  return process.env.GMAIL_PROVIDER || 'cdp';
}

/**
 * The CDP base URL for the provider. Honors an explicit GMAIL_CDP_URL, else
 * builds `http://localhost:<GMAIL_CDP_PORT|9224>` (the debug port the login
 * browser exposes).
 */
export function resolveCdpBase(): string {
  if (process.env.GMAIL_CDP_URL) return String(process.env.GMAIL_CDP_URL).replace(/\/+$/, '');
  const port = process.env.GMAIL_CDP_PORT || String(DEFAULT_LOGIN_PORT);
  return `http://localhost:${port}`;
}
