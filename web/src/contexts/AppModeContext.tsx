'use client';

import { createContext, useContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  createApiClient,
  createHybridClient,
  detectAppMode,
  detectProxyInfo,
  fetchHubUserInfo,
  getHubHttpUrl,
  setProxySessionExpiredCallback,
  type ApiClient,
} from '@/lib/api-client';
import type { AppMode, ProxyInfo, HubUserInfo } from '@/lib/types';

interface AppModeContextValue {
  mode: AppMode;
  isLocal: boolean;
  isHub: boolean;
  isHybrid: boolean;
  apiClient: ApiClient;
  /** Proxy info -- whether the app is accessed through hub web proxy */
  proxy: ProxyInfo;
  /** Hub user info -- populated when proxied OR when local + hub authenticated */
  hubUser: HubUserInfo | null;
  /** Whether the local machine is connected to the hub (local mode only) */
  hubConnected: boolean;
  /** The local machine's gateway ID when connected to hub */
  localGatewayId: string | null;
  /** Whether the proxy session cookie has expired (proxy mode only) */
  proxySessionExpired: boolean;
  /** Refresh hub connection state + user info (call after connect/disconnect) */
  refreshHubConnection: () => Promise<void>;
}

const AppModeContext = createContext<AppModeContextValue | null>(null);

export function AppModeProvider({ children }: { children: ReactNode }) {
  const [hubUser, setHubUser] = useState<HubUserInfo | null>(null);
  const [hubConnected, setHubConnected] = useState(false);
  const [localGatewayId, setLocalGatewayId] = useState<string | null>(null);
  const [hubUrl, setHubUrl] = useState<string | null>(null);
  const [proxySessionExpired, setProxySessionExpired] = useState(false);

  // Track the hybrid client and API key for hub authentication
  const [hybridClient, setHybridClient] = useState<ApiClient | null>(null);
  const [hubApiKey, setHubApiKey] = useState<string | null>(null);

  const base = useMemo(() => {
    const client = createApiClient();
    const proxy = detectProxyInfo();

    if (proxy.isProxied) {
      console.log(`[AppMode] Proxy mode detected: basePath=${proxy.basePath} machineId=${proxy.machineId}`);
    } else {
      console.log(`[AppMode] ${client.mode} mode (direct access)`);
    }

    return {
      baseMode: client.mode as 'local' | 'hub',
      baseClient: client,
      proxy,
    };
  }, []);

  // Fetch local hub user from machine's /hub/status endpoint
  const fetchLocalHubUser = useCallback(async () => {
    if (base.proxy.isProxied) return; // proxy mode uses its own path
    try {
      const { baseUrl } = detectAppMode();
      const tierAgentUrl = baseUrl || 'http://localhost:3100';

      // Check hub status first
      const statusRes = await fetch(tierAgentUrl + '/hub/status');
      if (!statusRes.ok) {
        setHubConnected(false);
        setHubUser(null);
        setLocalGatewayId(null);
        setHubUrl(null);
        return;
      }
      const statusJson = await statusRes.json();
      const status = statusJson.data || statusJson;
      const authenticated = status.authenticated ?? false;
      const connected = status.connected ?? false;
      setHubConnected(connected);

      if (connected && status.gatewayId) {
        setLocalGatewayId(status.gatewayId);
        setHubUrl(status.hubUrl || null);
        console.log(`[AppMode] Hub connected, local gatewayId=${status.gatewayId}`);
      } else {
        setLocalGatewayId(null);
        setHubUrl(null);
      }

      if (authenticated) {
        // Fetch user info and API key in parallel
        const [userRes, keyRes] = await Promise.all([
          fetch(tierAgentUrl + '/hub/user').catch(() => null),
          fetch(tierAgentUrl + '/hub/api-key').catch(() => null),
        ]);

        if (userRes?.ok) {
          const userJson = await userRes.json();
          if (userJson.success && userJson.data) {
            console.log(`[AppMode] Hub user: ${userJson.data.displayName || userJson.data.email} (${userJson.data.oauthProvider || 'api-key'})`);
            setHubUser(userJson.data);
          }
        }

        if (keyRes?.ok) {
          const keyJson = await keyRes.json();
          if (keyJson.success && keyJson.data?.apiKey) {
            setHubApiKey(keyJson.data.apiKey);
          }
        }
        return;
      }
      setHubUser(null);
      setHubApiKey(null);
    } catch {
      setHubConnected(false);
      setHubUser(null);
      setHubApiKey(null);
      setLocalGatewayId(null);
      setHubUrl(null);
    }
  }, [base.proxy.isProxied]);

  // Fetch hub user info when proxied + register proxy session expiry callback
  useEffect(() => {
    if (base.proxy.isProxied) {
      fetchHubUserInfo().then((user) => {
        if (user) {
          console.log(`[AppMode] Hub user: ${user.displayName || user.email} (${user.oauthProvider || 'api-key'})`);
          setHubUser(user);
          setHubConnected(true);
        }
      });

      // Register callback so fetch helpers can notify us of proxy token expiry
      setProxySessionExpiredCallback(() => setProxySessionExpired(true));
      return () => setProxySessionExpiredCallback(null);
    } else {
      // Local mode -- check hub connection on mount
      fetchLocalHubUser();
    }
  }, [base.proxy.isProxied, fetchLocalHubUser]);

  // Create/update hybrid client when hub connection state changes
  useEffect(() => {
    if (base.baseMode !== 'local' || base.proxy.isProxied) {
      // Not in local mode or proxied -- no hybrid upgrade
      setHybridClient(null);
      return;
    }

    if (hubConnected && localGatewayId && hubApiKey) {
      // Upgrade to hybrid mode
      const { baseUrl } = detectAppMode();
      const localBaseUrl = baseUrl || 'http://localhost:3100';
      const hubHttpUrl = getHubHttpUrl(hubUrl || undefined);

      console.log(`[AppMode] Upgrading to hybrid mode: local=${localBaseUrl}, hub=${hubHttpUrl}, gatewayId=${localGatewayId}`);

      const client = createHybridClient({
        localBaseUrl,
        hubBaseUrl: hubHttpUrl,
        localGatewayId,
        apiKey: hubApiKey,
      });
      setHybridClient(client);
    } else {
      // Hub disconnected -- fall back to local-only
      if (hybridClient) {
        console.log('[AppMode] Hub disconnected, falling back to local mode');
      }
      setHybridClient(null);
    }
  }, [base.baseMode, base.proxy.isProxied, hubConnected, localGatewayId, hubUrl, hubApiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Determine the effective mode and client
  const effectiveMode: AppMode = hybridClient ? 'hybrid' : base.baseMode;
  const effectiveClient: ApiClient = hybridClient || base.baseClient;

  const value = useMemo<AppModeContextValue>(
    () => ({
      mode: effectiveMode,
      isLocal: effectiveMode === 'local',
      isHub: effectiveMode === 'hub',
      isHybrid: effectiveMode === 'hybrid',
      apiClient: effectiveClient,
      proxy: base.proxy,
      hubUser,
      hubConnected,
      localGatewayId,
      proxySessionExpired,
      refreshHubConnection: fetchLocalHubUser,
    }),
    [effectiveMode, effectiveClient, base.proxy, hubUser, hubConnected, localGatewayId, proxySessionExpired, fetchLocalHubUser],
  );

  return (
    <AppModeContext.Provider value={value}>
      {children}
    </AppModeContext.Provider>
  );
}

export function useAppMode(): AppModeContextValue {
  const ctx = useContext(AppModeContext);
  if (!ctx) {
    throw new Error('useAppMode must be used within AppModeProvider');
  }
  return ctx;
}
