/**
 * Harness provider profiles — where a non-Claude harness gets its base URL,
 * credential and default model.
 *
 * WHY THIS IS NEW MACHINERY: lm-assist has never injected a credential into an
 * agent run. The Claude paths authenticate ambiently — the spawned binary finds
 * ~/.claude/.credentials.json by itself — so there was no existing plumbing to
 * redirect. A third-party harness talks to a gateway and must be handed a URL and
 * a key explicitly.
 *
 * Shape follows the house pattern for "a URL plus a key" (hub-client/hub-config.ts):
 * file-first with env fallback, a -dev suffix so a dev build and a prod build on
 * one host do not fight over one file, and merge-on-write. Because the file holds a
 * real secret it is written 0600 and atomically, and it is node-local — a
 * credential is never a fleet-synced decision.
 *
 * The MODEL LIVES HERE, IN CONFIG, ON PURPOSE. Which model a harness should use is
 * an open decision; keeping it in configuration means answering it later never
 * requires a code change.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir, isDevRepo } from '../utils/path-utils';

/**
 * Reuse path-utils' isDevRepo() rather than re-deriving the check. hub/gmail/linkedin
 * each re-implement `__dirname.includes('node_modules')` inline; a fourth copy is how
 * these drift apart.
 */
function devSuffix(): string {
  return isDevRepo() ? '-dev' : '';
}

/** Env vars are read by PREFIX so a new one cannot be silently dropped by a named forwarding list. */
export const HARNESS_ENV_PREFIX = 'LM_HARNESS_';

export interface ProviderProfile {
  /** Full base URL including the version segment, e.g. https://host/native/<provider>/v1 */
  baseUrl: string;
  /** Bearer credential. Empty string means "unset" and the profile is unusable. */
  apiKey: string;
  /** Default model id, in whatever form the endpoint expects. */
  model: string;
  /**
   * Wire protocol the endpoint speaks. Only openai-chat is implemented; the field
   * exists so a profile records what it is rather than leaving harnesses to assume.
   */
  wire?: 'openai-chat';
  /** Optional human note — which gateway door this points at, and why. */
  note?: string;
}

export interface HarnessProviderConfig {
  /** Profile used when a request names none. */
  defaultProfile?: string;
  profiles: Record<string, ProviderProfile>;
}

function configFile(): string {
  return path.join(getDataDir(), `harness-providers${devSuffix()}.json`);
}

const EMPTY: HarnessProviderConfig = { profiles: {} };

export function loadProviderConfig(): HarnessProviderConfig {
  let onDisk: HarnessProviderConfig = EMPTY;
  try {
    const raw = fs.readFileSync(configFile(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.profiles) onDisk = parsed as HarnessProviderConfig;
  } catch {
    // Absent or unreadable — fall through to env-only.
  }

  // Env fallback assembles an implicit "env" profile. File wins where both exist.
  const envUrl = process.env[`${HARNESS_ENV_PREFIX}BASE_URL`];
  const envKey = process.env[`${HARNESS_ENV_PREFIX}API_KEY`];
  const envModel = process.env[`${HARNESS_ENV_PREFIX}MODEL`];
  if (envUrl && envKey) {
    onDisk = {
      defaultProfile: onDisk.defaultProfile || 'env',
      profiles: {
        env: { baseUrl: envUrl, apiKey: envKey, model: envModel || '', wire: 'openai-chat', note: 'from environment' },
        ...onDisk.profiles,
      },
    };
  }
  return onDisk;
}

/**
 * Resolve a profile by name, or the configured default.
 * Returns null when nothing is configured — callers must refuse rather than
 * fall back to Anthropic, which would run a Claude agent on a request that
 * explicitly asked for a gateway model.
 */
export function resolveProfile(name?: string): (ProviderProfile & { name: string }) | null {
  const cfg = loadProviderConfig();
  const key = name || cfg.defaultProfile;
  if (!key) return null;
  const profile = cfg.profiles[key];
  if (!profile || !profile.baseUrl || !profile.apiKey) return null;
  return { ...profile, name: key };
}

/** Atomic 0600 write, merging into whatever is already there. */
export function saveProviderConfig(patch: Partial<HarnessProviderConfig>): HarnessProviderConfig {
  const dir = getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = configFile();

  let current: HarnessProviderConfig = EMPTY;
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    // fresh file
  }

  const merged: HarnessProviderConfig = {
    ...current,
    ...patch,
    profiles: { ...(current.profiles || {}), ...(patch.profiles || {}) },
  };

  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  // Enforce 0600 even if the file pre-existed with looser permissions.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort — a non-POSIX filesystem cannot honour this
  }
  return merged;
}

/** Redacted view, safe for status endpoints and logs. */
export function describeProviderConfig(): {
  defaultProfile?: string;
  profiles: Array<{ name: string; baseUrl: string; model: string; hasKey: boolean; note?: string }>;
} {
  const cfg = loadProviderConfig();
  return {
    defaultProfile: cfg.defaultProfile,
    profiles: Object.entries(cfg.profiles).map(([name, p]) => ({
      name,
      baseUrl: p.baseUrl,
      model: p.model,
      hasKey: Boolean(p.apiKey),
      note: p.note,
    })),
  };
}
