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
 * A normal desktop-Chrome User-Agent, forced when the driver browser runs
 * headless. MEASURED: with the default `HeadlessChrome/...` UA, Google serves
 * the degraded `flowName=WebLiteSignIn` sign-in flow; with a normal UA it
 * serves the full `GlifWebSignIn`. Same class of problem the existing
 * /browser/switch-to-headless route already solves for Cloudflare.
 */
export const HEADLESS_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

export interface GmailConfig {
  /** Optional stable persistent-profile name (default 'gmail'). */
  profile?: string;
  /** The signed-in address, cached from the last status probe. */
  selfEmail?: string;
}

/** Fields a caller may set via PUT /gmail/config. */
export const CONFIG_FIELDS: ReadonlyArray<keyof GmailConfig> = ['profile', 'selfEmail'];

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
