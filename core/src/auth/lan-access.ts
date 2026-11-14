/**
 * LAN access config — the web UI's LAN sign-in state, read by Core.
 *
 * `<dataDir>/assist-config.json` (0600) is owned by the web (settings page, OIDC
 * callback), which writes `lanAuthEnabled` and `lanAccessToken` there. Core reads it
 * for GET /auth/browser-token's LAN-key branch, and the operator can regenerate the key
 * with `cli.js token lan-key --regenerate`.
 *
 * `lanAuthEnabled === false` means LAN browsers get NO access (only this machine can use
 * the dashboard) — it no longer means "open LAN".
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { getDataDir } from '../utils/path-utils';

export function assistConfigPath(): string {
  return path.join(getDataDir(), 'assist-config.json');
}

export interface LanAccessConfig {
  lanAuthEnabled: boolean;
  lanAccessToken: string | null;
}

/** Read fresh on every call (the file is tiny and the web rewrites it at any time).
 *  Missing/corrupt → LAN auth on with NO key, which can never issue on the LAN branch. */
export function readLanAccessConfig(): LanAccessConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(assistConfigPath(), 'utf8'));
    return {
      lanAuthEnabled: raw?.lanAuthEnabled !== false,
      lanAccessToken: typeof raw?.lanAccessToken === 'string' && raw.lanAccessToken ? raw.lanAccessToken : null,
    };
  } catch {
    return { lanAuthEnabled: true, lanAccessToken: null };
  }
}

/** Replace the LAN access key with a fresh random one: every LAN browser must sign in
 *  again. Keeps every other field (lanEnabled, lanAuthEnabled, hub fields …) as-is and
 *  returns no secret. Throws when the file cannot be written. */
export function regenerateLanAccessToken(now: number = Date.now()): { regeneratedAt: number } {
  const f = assistConfigPath();
  let cfg: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) cfg = raw;
  } catch {
    /* missing/corrupt → start from an empty object */
  }
  cfg.lanAccessToken = randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f); // atomic replace
  try {
    fs.chmodSync(f, 0o600);
  } catch {
    /* best effort */
  }
  return { regeneratedAt: now };
}
