/* Shim for '@/contexts/AppModeContext' (aliased in build.mjs).
 *
 * useAppMode() hands the search page a REAL ApiClient — the api-client's own
 * createLocalClient pinned at the pane data plane — with NO method overrides. The page
 * reaches the node through `apiClient.fetchPath(...)` only (four knowledge routes), and
 * every one of them is a plain GET the granted leaves cover, so the real client is
 * already correct here.
 *
 * (Its sibling assist-sessions DOES override two methods — a GET batch-check twin and a
 * compact getSessionConversation. Neither applies: this page's session-preview branch is
 * unreachable on the current web page — `setSelectedSessionId` is only ever called with
 * null — so the pane declares no `/sessions` grant at all. If that branch is revived,
 * the grant and the compact override come back together with it.)
 */
import type { ReactNode } from 'react';
import { createLocalClient, detectProxyInfo } from './api-client';
import { dataBase } from '../data-plane';

let cached: ReturnType<typeof createLocalClient> | null = null;
function apiClient() {
  if (!cached) cached = createLocalClient(dataBase(), detectProxyInfo());
  return cached;
}

const VALUE = {
  mode: 'local' as const,
  isLocal: true,
  isHub: false,
  isHybrid: false,
  get apiClient() { return apiClient(); },
  proxy: { isProxied: true, basePath: '', machineId: 'local' },
  hubUser: null,
  hubConnected: false,
  localGatewayId: 'local',
  hubUrl: null,
  proxySessionExpired: false,
  refreshHubConnection: async () => {},
};

export function useAppMode() {
  return VALUE as any;
}

export function AppModeProvider({ children }: { children: ReactNode }) {
  return children as any;
}
