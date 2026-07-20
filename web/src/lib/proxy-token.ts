/**
 * Cross-node /w/ proxy-token minting.
 *
 * The hub's /w/<machineId>/ web proxy authenticates with a PER-MACHINE cookie
 * (`_wprxy_<machineId>`, 30-day server TTL). There is NO cross-machine session:
 * navigating to another node's /w/ path with a missing or expired cookie gets
 * a hard 401 ("invalid token") — the hub never falls back to any other auth.
 * So every cross-node link must carry a freshly minted `?token=`.
 *
 * Two mint paths depending on where this page runs:
 * - Served through the hub proxy: mint via the hub's own tier-agent API through
 *   the CURRENT machine's /w path (`<basePath>/api/tier-agent/...`) — the
 *   browser attaches the current machine's valid cookie automatically, and the
 *   hub forwards the call internally (isHubApiPath). Response: `{ token }`.
 * - Local/hybrid: mint via this node's core (`/hub/machines/:id/proxy-token`),
 *   which calls the hub with the node's API key. Response: `{ data: { token } }`.
 */
import { detectAppMode, workerFetch } from './api-client';

export interface ProxyMintContext {
  isProxied: boolean;
  basePath?: string | null;
}

export async function mintRemoteProxyToken(
  remoteGatewayId: string,
  proxy: ProxyMintContext,
): Promise<string | null> {
  try {
    if (proxy.isProxied && proxy.basePath) {
      const res = await fetch(
        `${proxy.basePath}/api/tier-agent/machines/${remoteGatewayId}/proxy-token`,
        { method: 'POST' },
      );
      if (!res.ok) return null;
      const json = await res.json().catch(() => null);
      return json?.token || json?.data?.token || null;
    }
    const { baseUrl } = detectAppMode();
    const res = await workerFetch(`${baseUrl}/hub/machines/${remoteGatewayId}/proxy-token`, {
      method: 'POST',
    });
    const json = await res.json().catch(() => null);
    return json?.data?.token || json?.token || null;
  } catch {
    return null;
  }
}

/** Open a remote node's /w/ URL with a freshly minted token (falls back to the
 * bare URL if minting fails — same behavior as before, just no longer the
 * default path). */
export async function openRemoteMachineUrl(
  baseUrl: string,
  remoteGatewayId: string,
  proxy: ProxyMintContext,
): Promise<void> {
  const token = await mintRemoteProxyToken(remoteGatewayId, proxy);
  window.open(token ? `${baseUrl}?token=${token}` : baseUrl, '_blank');
}
