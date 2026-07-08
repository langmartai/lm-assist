// Canonical hub HTTP + machine-proxy helpers.
//
// Single source of truth for reaching the hub (assist-api) and, through it, another node's
// local Core via the machine-relay proxy endpoint. Previously duplicated verbatim in
// data/peer-client.ts and knowledge/remote-sync.ts (which drifted — the latter addressed
// peers machineId-first, an id the hub cannot route by). All server-side callers should import
// from here; the browser cannot (it has no hub Bearer token — see peer-relay.routes.ts for the
// browser→local-core→hub path).
//
// NODE ADDRESSING: always pass a **gatewayId** (`gw4-…`) as `node`. That is the identifier the
// hub routes by (workersByGatewayId / resolveNodeForUser). A bare machineId 404s at the hub.
import { getHubConfig } from './hub-config';

/** ws://→http://, wss://→https:// on the configured hub URL. */
export function getHubHttpUrl(): string {
  const cfg = getHubConfig();
  return (cfg.hubUrl || '')
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:');
}

/** GET a hub API path with the node's Bearer token. Throws on non-2xx. */
export async function hubFetch(urlPath: string): Promise<unknown> {
  const cfg = getHubConfig();
  const base = getHubHttpUrl();
  const res = await fetch(`${base}${urlPath}`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Hub returned ${res.status} for ${urlPath}`);
  }
  return res.json();
}

export interface ProxyGetOptions {
  extraHeaders?: Record<string, string>;
}

/** GET a remote node's local API path via the hub machine-relay. `node` must be a gatewayId. Throws on non-2xx. */
export async function proxyFetch(node: string, urlPath: string, opts?: ProxyGetOptions): Promise<unknown> {
  const cfg = getHubConfig();
  const base = getHubHttpUrl();
  const proxyUrl = `${base}/api/tier-agent/machines/${node}/proxy${urlPath}`;
  const res = await fetch(proxyUrl, {
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      ...(opts?.extraHeaders ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Proxy request to ${node}${urlPath} returned ${res.status}`);
  }
  return res.json();
}

/** POST a JSON body to a remote node's local API path via the hub machine-relay. `node` must be a gatewayId. Throws on non-2xx. */
export async function proxyPost(node: string, urlPath: string, body: unknown): Promise<unknown> {
  const cfg = getHubConfig();
  const base = getHubHttpUrl();
  const proxyUrl = `${base}/api/tier-agent/machines/${node}/proxy${urlPath}`;
  const res = await fetch(proxyUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Proxy POST to ${node}${urlPath} returned ${res.status}`);
  }
  return res.json();
}

/** Convenience GET proxy (no extra headers). `node` must be a gatewayId. */
export async function proxyGet(node: string, urlPath: string): Promise<unknown> {
  return proxyFetch(node, urlPath);
}
