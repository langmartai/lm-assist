'use client';

import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  /** Hub WebSocket URL (e.g. wss://api.langmart.ai) — available when hub is connected */
  hubUrl: string | null;
  /** Whether the proxy session cookie has expired (proxy mode only) */
  proxySessionExpired: boolean;
  /** Refresh hub connection state + user info (call after connect/disconnect) */
  refreshHubConnection: () => Promise<void>;
}

const AppModeContext = createContext<AppModeContextValue | null>(null);

// ── Module-level persistent state ──
// Survives component remounts (React Strict Mode, concurrent mode, Next.js re-renders).
// Without this, every remount re-fetches hub status and recreates the hybrid client,
// causing an oscillation loop (local → hybrid → remount → local → hybrid → ...).
let _persistedHybridClient: ApiClient | null = null;
let _persistedHybridKey: string | null = null;
let _persistedHubState: {
  connected: boolean;
  gatewayId: string | null;
  hubUrl: string | null;
  apiKey: string | null;
  user: HubUserInfo | null;
} | null = null;
let _hubFetchInFlight = false;

export function AppModeProvider({ children }: { children: ReactNode }) {
  // Initialize state from persisted module-level cache when available
  const [hubUser, setHubUser] = useState<HubUserInfo | null>(_persistedHubState?.user ?? null);
  const [hubConnected, setHubConnected] = useState(_persistedHubState?.connected ?? false);
  const [localGatewayId, setLocalGatewayId] = useState<string | null>(_persistedHubState?.gatewayId ?? null);
  const [hubUrl, setHubUrl] = useState<string | null>(_persistedHubState?.hubUrl ?? null);
  const [proxySessionExpired, setProxySessionExpired] = useState(false);

  // Track the hybrid client and API key for hub authentication
  const [hybridClient, setHybridClient] = useState<ApiClient | null>(_persistedHybridClient);
  const [hubApiKey, setHubApiKey] = useState<string | null>(_persistedHubState?.apiKey ?? null);

  // Use useState lazy initializer — guaranteed to run exactly once per component instance.
  const [base] = useState(() => {
    const client = createApiClient();
    const proxy = detectProxyInfo();
    return {
      baseMode: client.mode as 'local' | 'hub',
      baseClient: client,
      proxy,
    };
  });

  // Log mode once on mount
  const loggedRef = useRef(false);
  useEffect(() => {
    if (loggedRef.current) return;
    loggedRef.current = true;
    if (base.proxy.isProxied) {
      console.log(`[AppMode] Proxy mode detected: basePath=${base.proxy.basePath} machineId=${base.proxy.machineId}`);
    } else {
      console.log(`[AppMode] ${base.baseMode} mode (direct access)`);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch local hub user from machine's /hub/status endpoint
  const fetchLocalHubUser = useCallback(async (force = false) => {
    if (base.proxy.isProxied) return;
    // Prevent concurrent calls (module-level lock survives remounts)
    if (_hubFetchInFlight && !force) return;
    // Skip fetch if we already have persisted hub state (from a previous mount).
    // Don't require _persistedHybridClient — it's set by a separate effect that runs
    // after this fetch completes. Checking only _persistedHubState avoids a timing gap
    // where the component remounts between fetch completion and hybrid client creation.
    if (!force && _persistedHubState) {
      return;
    }
    _hubFetchInFlight = true;
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
        _persistedHubState = null;
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

        let user: HubUserInfo | null = null;
        let apiKey: string | null = null;

        if (userRes?.ok) {
          const userJson = await userRes.json();
          if (userJson.success && userJson.data) {
            console.log(`[AppMode] Hub user: ${userJson.data.displayName || userJson.data.email} (${userJson.data.oauthProvider || 'api-key'})`);
            user = userJson.data;
            setHubUser(user);
          }
        }

        if (keyRes?.ok) {
          const keyJson = await keyRes.json();
          if (keyJson.success && keyJson.data?.apiKey) {
            apiKey = keyJson.data.apiKey;
            setHubApiKey(apiKey);
          }
        }

        // Persist hub state at module level
        _persistedHubState = {
          connected,
          gatewayId: status.gatewayId || null,
          hubUrl: status.hubUrl || null,
          apiKey,
          user,
        };
        return;
      }
      setHubUser(null);
      setHubApiKey(null);
      _persistedHubState = null;
    } catch {
      setHubConnected(false);
      setHubUser(null);
      setHubApiKey(null);
      setLocalGatewayId(null);
      setHubUrl(null);
      _persistedHubState = null;
    } finally {
      _hubFetchInFlight = false;
    }
  }, [base.proxy.isProxied]);

  // Public refresh function — forces a re-fetch (e.g., after connect/disconnect)
  const refreshHubConnection = useCallback(async () => {
    _persistedHubState = null;
    _persistedHybridClient = null;
    _persistedHybridKey = null;
    await fetchLocalHubUser(true);
  }, [fetchLocalHubUser]);

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
      if (_persistedHybridKey !== null) {
        _persistedHybridKey = null;
        _persistedHybridClient = null;
        setHybridClient(null);
      }
      return;
    }

    if (hubConnected && localGatewayId && hubApiKey) {
      // Check if hybrid client already exists with same params (module-level check)
      const key = `${localGatewayId}|${hubApiKey}|${hubUrl || ''}`;
      if (_persistedHybridKey === key && _persistedHybridClient) {
        // Reuse existing hybrid client — just ensure React state is in sync
        if (!hybridClient) setHybridClient(_persistedHybridClient);
        return;
      }
      _persistedHybridKey = key;

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
      _persistedHybridClient = client;
      setHybridClient(client);
    } else {
      // Hub disconnected -- fall back to local-only
      if (_persistedHybridKey !== null) {
        console.log('[AppMode] Hub disconnected, falling back to local mode');
        _persistedHybridKey = null;
        _persistedHybridClient = null;
        setHybridClient(null);
      }
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
      hubUrl,
      proxySessionExpired,
      refreshHubConnection,
    }),
    [effectiveMode, effectiveClient, base.proxy, hubUser, hubConnected, localGatewayId, hubUrl, proxySessionExpired, refreshHubConnection],
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
