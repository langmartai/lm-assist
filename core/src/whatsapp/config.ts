/**
 * WhatsApp connector — configuration (converged local + server).
 *
 * This node runs the LOCAL provider: it drives a logged-in WhatsApp Desktop
 * (or web.whatsapp.com) session over the Chrome DevTools Protocol (CDP) and
 * mirrors what it reads into the SHARED message store (see store.ts). The
 * schema, store, and MCP surface are identical to the SERVER (Meta Cloud API)
 * deployment — only the provider (`cdp` vs Meta/hub) differs.
 *
 * The Meta credential shape below is retained VERBATIM from the server config
 * so the two deployments share one WhatsappConfig type + WA_DATA_DIR layout.
 * On this node the Meta creds are unused (provider === 'cdp'); the CDP endpoint
 * is resolved from env instead (see resolveCdpBase / whatsappProvider).
 *
 * Files live under `~/.lm-assist/whatsapp[-dev].json` + `~/.lm-assist/whatsapp[-dev]/`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mirror the dev/prod split used by connectors.ts / hub config: a build that
// runs from the repo (not node_modules) talks to the dev hub + dev files.
const IS_DEV_REPO = process.env.LM_ASSIST_PROD === 'true' ? false : !__dirname.includes('node_modules');
const DEV_SUFFIX = IS_DEV_REPO ? '-dev' : '';

const LM_DIR = path.join(os.homedir(), '.lm-assist');
export const WA_CONFIG_FILE = path.join(LM_DIR, `whatsapp${DEV_SUFFIX}.json`);
/** Directory holding the message log + read-state for this env. */
export const WA_DATA_DIR = path.join(LM_DIR, `whatsapp${DEV_SUFFIX}`);

/** The default Graph API version used when the config doesn't pin one. */
export const DEFAULT_GRAPH_VERSION = 'v21.0';

export interface WhatsappConfig {
  /** Phone Number ID from the Meta app's WhatsApp > API setup (NOT the phone number). */
  phoneNumberId?: string;
  /** Permanent (or temporary) access token with `whatsapp_business_messaging`. */
  accessToken?: string;
  /** WhatsApp Business Account (WABA) ID — optional, for display/templates. */
  businessAccountId?: string;
  /** Token YOU choose; Meta echoes it on webhook verification (GET challenge). */
  verifyToken?: string;
  /** Meta App Secret — used to HMAC-verify inbound webhook POSTs. */
  appSecret?: string;
  /** Graph API version, e.g. "v21.0". Defaults to DEFAULT_GRAPH_VERSION. */
  graphApiVersion?: string;
  /** The business's own display phone number, for reference (e.g. "+1 555…"). */
  displayPhoneNumber?: string;
}

/** Fields a caller may set via PUT /whatsapp/config. */
export const CONFIG_FIELDS: ReadonlyArray<keyof WhatsappConfig> = [
  'phoneNumberId',
  'accessToken',
  'businessAccountId',
  'verifyToken',
  'appSecret',
  'graphApiVersion',
  'displayPhoneNumber',
];

export function readWhatsappConfig(): WhatsappConfig {
  try {
    return JSON.parse(fs.readFileSync(WA_CONFIG_FILE, 'utf-8')) as WhatsappConfig;
  } catch {
    return {};
  }
}

/** Merge `patch` into the saved config and persist (0600). Returns the merged config. */
export function writeWhatsappConfig(patch: Partial<WhatsappConfig>): WhatsappConfig {
  const next = { ...readWhatsappConfig(), ...patch };
  fs.mkdirSync(LM_DIR, { recursive: true });
  fs.writeFileSync(WA_CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export function graphVersion(cfg: WhatsappConfig = readWhatsappConfig()): string {
  return cfg.graphApiVersion || DEFAULT_GRAPH_VERSION;
}

/** Sending requires a phone number id + access token; reads work regardless. */
export function isConfigured(cfg: WhatsappConfig = readWhatsappConfig()): boolean {
  return Boolean(cfg.phoneNumberId && cfg.accessToken);
}

// ─── CDP provider config (local deployment only) ─────────────────────────────

/**
 * Which backend this node's WhatsApp connector uses:
 *   - 'cdp'  — drive a logged-in WhatsApp Desktop / web.whatsapp.com over CDP
 *              (this Windows node's default).
 *   - 'meta' — the Meta Cloud API / hub (the server deployment).
 * Overridable via WHATSAPP_PROVIDER.
 */
export function whatsappProvider(): string {
  return process.env.WHATSAPP_PROVIDER || 'cdp';
}

/**
 * The CDP base URL for the local provider. Honors an explicit WHATSAPP_CDP_URL,
 * else builds `http://localhost:<WHATSAPP_CDP_PORT|9222>` (the debug port the
 * WhatsApp Desktop WebView2 / debug Chrome exposes).
 */
export function resolveCdpBase(): string {
  if (process.env.WHATSAPP_CDP_URL) return String(process.env.WHATSAPP_CDP_URL).replace(/\/+$/, '');
  const port = process.env.WHATSAPP_CDP_PORT || '9222';
  return `http://localhost:${port}`;
}
