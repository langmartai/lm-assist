/**
 * ui-gateway REST client — registration + grants for pluggable UIs, authenticated with
 * THIS node's stored platform API key (hub.json). The gateway accepts the key as an
 * alternate principal on its management surface (/registry/uis, /access/*) and applies
 * the same owner-only rules as a browser session — the key IS the user.
 *
 * Base URL: uiGatewayUrl in hub{,-dev}.json wins, then UI_GATEWAY_URL, then derived
 * from the hub URL (wss://assist-api.<domain> → https://ui.<domain>).
 */

import { getHubConfig } from '../hub-client/hub-config';

export function deriveGatewayUrl(hubUrl: string, override?: string): string | null {
  if (override) return override.replace(/\/$/, '');
  if (process.env.UI_GATEWAY_URL) return process.env.UI_GATEWAY_URL.replace(/\/$/, '');
  try {
    const u = new URL(hubUrl);
    const host = u.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return 'http://127.0.0.1:8087';
    // assist-api.<domain> → ui.<domain>; anything else: ui.<registrable-ish domain>
    const domain = host.startsWith('assist-api.') ? host.slice('assist-api.'.length) : host.split('.').slice(-2).join('.');
    if (!domain) return null;
    return `https://ui.${domain}`;
  } catch { return null; }
}

export interface GatewayCallResult { status: number; data: unknown }

export async function gatewayCall(
  method: string,
  pathName: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayCallResult> {
  const cfg = getHubConfig();
  if (!cfg.apiKey) throw new Error('no API key in hub config — this node is not registered to a hub');
  const base = deriveGatewayUrl(cfg.hubUrl, (loadUiGatewayOverride() ?? undefined));
  if (!base) throw new Error(`cannot derive ui-gateway URL from hub URL "${cfg.hubUrl}" — set uiGatewayUrl in hub.json or UI_GATEWAY_URL`);
  const r = await fetchImpl(`${base}${pathName}`, {
    method,
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
  });
  let data: unknown = null;
  try { data = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, data };
}

// uiGatewayUrl lives next to uiWebPort in hub{,-dev}.json; read it the same lazy way
// (loadServicePorts deliberately narrows its return type, so read the raw file here).
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function loadUiGatewayOverride(): string | null {
  try {
    const isDevRepo = process.env.LM_ASSIST_PROD === 'true' ? false : !__dirname.includes('node_modules');
    const f = path.join(os.homedir(), '.lm-assist', `hub${isDevRepo ? '-dev' : ''}.json`);
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return typeof j.uiGatewayUrl === 'string' && j.uiGatewayUrl ? j.uiGatewayUrl : null;
  } catch { return null; }
}

/** The gateway base URL after applying every override layer (hub.json → env → derived). */
export function resolvedGatewayUrl(): string | null {
  const cfg = getHubConfig();
  return deriveGatewayUrl(cfg.hubUrl, loadUiGatewayOverride() ?? undefined);
}

// A uiId is only unique within its OWNER; what appears in the hostname is the gateway's
// uiKey (<ownerSlug8>-<uiId>). The origin host therefore spends 'ui-' + 8 slug chars + '-'
// out of a 63-character DNS label, leaving this much for the id. The gateway rejects longer
// ids with a 400 — check it here so the author gets a sentence instead of a status code.
export const MAX_UI_ID_LENGTH = 51;

/** Why this uiId cannot be registered, or null when it is fine. */
export function uiIdError(uiId: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(uiId)) return 'uiId required: lowercase letters, digits, hyphens';
  if (uiId.length > MAX_UI_ID_LENGTH) {
    return `uiId "${uiId}" is ${uiId.length} characters — at most ${MAX_UI_ID_LENGTH} are available ` +
      `(the public host is ui-<ownerSlug>-<uiId>.<domain> and a DNS label holds 63)`;
  }
  return null;
}

/** The uiKey + public origin a gateway response carries for one UI.
 *
 *  Never rebuild the origin from the uiId. The URL shape is the gateway's to decide — it
 *  already changed once (the owner slug moved into the hostname when uiIds stopped being
 *  globally unique) and it can change again without a release on this side; the only
 *  trustworthy URL is the one the gateway just told us. */
export interface UiAddress { uiKey?: string; origin?: string }

export function readUiAddress(row: unknown): UiAddress {
  const r = row as { uiKey?: unknown; origin?: unknown } | null;
  return {
    uiKey: typeof r?.uiKey === 'string' ? r.uiKey : undefined,
    origin: typeof r?.origin === 'string' ? r.origin : undefined,
  };
}
