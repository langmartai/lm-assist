/**
 * LinkedIn connector — configuration (local / CDP deployment).
 *
 * Unlike WhatsApp, LinkedIn has NO usable messaging/posting API for an
 * individual account — the only practical integration is to drive a
 * logged-in linkedin.com session in a real browser. So this connector has a
 * SINGLE provider: `cdp`. It drives a Chrome (persistent profile + remote-debug
 * port) that is logged into LinkedIn and mirrors what it reads into the shared
 * message store (see store.ts). The MCP surface, store, and data dir layout
 * follow the same shape as the WhatsApp connector.
 *
 * Files live under `~/.lm-assist/linkedin[-dev].json` + `~/.lm-assist/linkedin[-dev]/`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mirror the dev/prod split used by connectors.ts / hub config: a build that
// runs from the repo (not node_modules) talks to the dev files.
const IS_DEV_REPO = process.env.LM_ASSIST_PROD === 'true' ? false : !__dirname.includes('node_modules');
const DEV_SUFFIX = IS_DEV_REPO ? '-dev' : '';

const LM_DIR = path.join(os.homedir(), '.lm-assist');
export const LI_CONFIG_FILE = path.join(LM_DIR, `linkedin${DEV_SUFFIX}.json`);
/** Directory holding the message log + read-state for this env. */
export const LI_DATA_DIR = path.join(LM_DIR, `linkedin${DEV_SUFFIX}`);

/** Default remote-debug port for the LinkedIn login/driver browser. */
export const DEFAULT_LOGIN_PORT = 9223;

export interface LinkedinConfig {
  /** Optional stable persistent-profile name (default 'linkedin'). */
  profile?: string;
  /** The account's own display name, cached from the last status probe. */
  selfName?: string;
}

/** Fields a caller may set via PUT /linkedin/config. */
export const CONFIG_FIELDS: ReadonlyArray<keyof LinkedinConfig> = ['profile', 'selfName'];

export function readLinkedinConfig(): LinkedinConfig {
  try {
    return JSON.parse(fs.readFileSync(LI_CONFIG_FILE, 'utf-8')) as LinkedinConfig;
  } catch {
    return {};
  }
}

/** Merge `patch` into the saved config and persist (0600). Returns the merged config. */
export function writeLinkedinConfig(patch: Partial<LinkedinConfig>): LinkedinConfig {
  const next = { ...readLinkedinConfig(), ...patch };
  fs.mkdirSync(LM_DIR, { recursive: true });
  fs.writeFileSync(LI_CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

// ─── CDP provider config ─────────────────────────────────────────────────────

/**
 * Which backend this node's LinkedIn connector uses. Only `cdp` is supported
 * (drive a logged-in linkedin.com session over the Chrome DevTools Protocol).
 * Overridable via LINKEDIN_PROVIDER for forward-compat.
 */
export function linkedinProvider(): string {
  return process.env.LINKEDIN_PROVIDER || 'cdp';
}

/**
 * The CDP base URL for the provider. Honors an explicit LINKEDIN_CDP_URL, else
 * builds `http://localhost:<LINKEDIN_CDP_PORT|9223>` (the debug port the login
 * browser exposes). 9223 by default so it does not collide with the WhatsApp
 * connector's 9222.
 */
export function resolveCdpBase(): string {
  if (process.env.LINKEDIN_CDP_URL) return String(process.env.LINKEDIN_CDP_URL).replace(/\/+$/, '');
  const port = process.env.LINKEDIN_CDP_PORT || String(DEFAULT_LOGIN_PORT);
  return `http://localhost:${port}`;
}
