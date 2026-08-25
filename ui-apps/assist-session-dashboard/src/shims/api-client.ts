/* Shim for '@/lib/api-client' (aliased in build.mjs).
 *
 * The real module is re-exported wholesale — hooks keep importing workerFetch,
 * getLastLocalSessionsTotal, transformSessionResponse, types… from "the api client"
 * and get the real implementations. Only the three environment probes are replaced,
 * because their auto-detection is meaningless inside a pane iframe:
 *
 *  - detectAppMode(): the real one keys off hostname (langmart.ai ⇒ hub mode ⇒
 *    gateway-auth'd /api/tier-agent paths that a pane cannot use). Pinned to
 *    local mode with baseUrl '/_coreapi'.
 *  - detectProxyInfo(): pinned to {isProxied:true, basePath:''} so every code path
 *    that composes `${basePath}/_coreapi/...` yields a plain '/_coreapi/...' path.
 *  - workerFetch(): rewrites that '/_coreapi' prefix to the pane data plane
 *    (`/data/<uiId>/node`), where the scoped fetch patch attaches the view token.
 *
 * Net effect: hook code (useSessionDetail's summary fetch, useSessionDag's four
 * fetches) runs UNMODIFIED and lands on the granted data-plane routes.
 */
export * from '../../../../web/src/lib/api-client';

import { workerFetch as realWorkerFetch } from '../../../../web/src/lib/api-client';
import type { ProxyInfo } from '../../../../web/src/lib/types';
import { dataBase } from '../data-plane';

export function detectAppMode(): { mode: 'local'; baseUrl: string } {
  return { mode: 'local', baseUrl: '/_coreapi' };
}

export function detectProxyInfo(): ProxyInfo {
  return { isProxied: true, basePath: '', machineId: 'local' } as ProxyInfo;
}

export function workerFetch(url: string, options?: RequestInit): Promise<Response> {
  if (url.startsWith('/_coreapi/')) {
    url = dataBase() + url.slice('/_coreapi'.length);
  }
  return realWorkerFetch(url, options);
}
