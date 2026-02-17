/**
 * HubClient - Connects tier-agent worker to LangMart Hub
 *
 * This client establishes a WebSocket connection to the LangMart Gateway Type 1,
 * registering as a Type 4 gateway (tier-agent worker). It handles:
 * - Registration with API key authentication
 * - Heartbeat to maintain connection
 * - API relay (hub requests local API, returns response)
 * - Console relay for remote terminal access
 */

import { EventEmitter } from 'events';
import { WebSocketClient } from './websocket-client';
import { ApiRelayHandler, ApiRelayRequest, ServiceRoute } from './api-relay-handler';
import { ConsoleRelayHandler } from './console-relay-handler';
import { SessionCacheSync } from './session-cache-sync';
import { getHubConfig, HubConfig, saveGatewayId } from './hub-config';

export interface HubClientOptions {
  /** Hub WebSocket URL (defaults from env TIER_AGENT_HUB_URL) */
  hubUrl?: string;
  /** API key for authentication (defaults from env TIER_AGENT_API_KEY) */
  apiKey?: string;
  /** Local API port (defaults to 3100) */
  localApiPort?: number;
  /** Admin web (Next.js) port - enables /admin/* route */
  adminWebPort?: number;
  /** LangMart Assistant web port - enables /assist/* route */
  assistWebPort?: number;
  /** Vibe Coder web (Vite) port - enables /vibe/* route */
  vibeCoderPort?: number;
  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;
  /** Reconnect delay in ms (doubles on each retry, max 30s) */
  reconnectDelay?: number;
  /** Max reconnect attempts (0 = infinite) */
  maxReconnectAttempts?: number;
}

export interface HubClientStatus {
  connected: boolean;
  authenticated: boolean;
  gatewayId: string | null;
  sessionId: string | null;
  lastHeartbeat: Date | null;
  lastConnected: Date | null;
  reconnectAttempts: number;
  hubUrl: string | null;
}

export interface HubClientEvents {
  connected: () => void;
  authenticated: (data: { gatewayId: string; sessionId: string }) => void;
  disconnected: (reason?: string) => void;
  error: (error: Error) => void;
  max_reconnects: () => void;
  gateway_conflict: () => void;
}

export class HubClient extends EventEmitter {
  private wsClient: WebSocketClient | null = null;
  private apiRelayHandler: ApiRelayHandler | null = null;
  private consoleRelayHandler: ConsoleRelayHandler | null = null;
  private sessionCacheSync: SessionCacheSync | null = null;
  private config: HubConfig;
  private options: Required<Pick<HubClientOptions, 'hubUrl' | 'apiKey' | 'localApiPort' | 'autoReconnect' | 'reconnectDelay' | 'maxReconnectAttempts'>> & Pick<HubClientOptions, 'adminWebPort' | 'assistWebPort' | 'vibeCoderPort'>;
  private status: HubClientStatus = {
    connected: false,
    authenticated: false,
    gatewayId: null,
    sessionId: null,
    lastHeartbeat: null,
    lastConnected: null,
    reconnectAttempts: 0,
    hubUrl: null,
  };
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  constructor(options: HubClientOptions = {}) {
    super();
    // Prevent unhandled 'error' event from crashing the process
    this.on('error', () => {});
    this.config = getHubConfig();
    this.options = {
      hubUrl: options.hubUrl || this.config.hubUrl || '',
      apiKey: options.apiKey || this.config.apiKey || '',
      localApiPort: options.localApiPort || 3100,
      adminWebPort: options.adminWebPort || (process.env.ADMIN_WEB_PORT ? parseInt(process.env.ADMIN_WEB_PORT, 10) : undefined),
      assistWebPort: options.assistWebPort || (process.env.ASSIST_WEB_PORT ? parseInt(process.env.ASSIST_WEB_PORT, 10) : undefined),
      vibeCoderPort: options.vibeCoderPort || (process.env.VIBE_CODER_PORT ? parseInt(process.env.VIBE_CODER_PORT, 10) : undefined),
      autoReconnect: options.autoReconnect ?? true,
      reconnectDelay: options.reconnectDelay || 1000,
      maxReconnectAttempts: options.maxReconnectAttempts || 0, // 0 = infinite
    };
    this.status.hubUrl = this.options.hubUrl;
  }

  /**
   * Check if hub connection is configured
   */
  isConfigured(): boolean {
    return !!this.options.hubUrl && !!this.options.apiKey;
  }

  /**
   * Connect to the LangMart Hub
   */
  async connect(): Promise<void> {
    if (!this.isConfigured()) {
      console.log('[HubClient] Not configured - skipping connection');
      return;
    }

    if (this.status.connected) {
      console.log('[HubClient] Already connected');
      return;
    }

    this.isShuttingDown = false;

    try {
      console.log(`[HubClient] Connecting to ${this.options.hubUrl}...`);

      // Create WebSocket client
      this.wsClient = new WebSocketClient({
        url: this.options.hubUrl,
        apiKey: this.options.apiKey,
        machineId: this.config.machineId,
        gatewayId: this.config.gatewayId,
        localApiPort: this.options.localApiPort,
      });

      // Build service routes from options
      const serviceRoutes: ServiceRoute[] = [];
      if (this.options.adminWebPort) {
        serviceRoutes.push({
          pathPrefix: '/admin',
          port: this.options.adminWebPort,
          stripPrefix: true,
          description: 'Admin Web UI (Next.js)',
        });
      }
      if (this.options.assistWebPort) {
        serviceRoutes.push({
          pathPrefix: '/assist',
          port: this.options.assistWebPort,
          stripPrefix: true,
          description: 'LangMart Assistant',
        });
      }
      if (this.options.vibeCoderPort) {
        serviceRoutes.push({
          pathPrefix: '/vibe',
          port: this.options.vibeCoderPort,
          stripPrefix: true,
          description: 'Vibe Coder (Vite)',
        });
      }

      // Create API relay handler
      this.apiRelayHandler = new ApiRelayHandler({
        localApiPort: this.options.localApiPort,
        wsClient: this.wsClient,
        serviceRoutes,
      });

      // Create console relay handler
      this.consoleRelayHandler = new ConsoleRelayHandler({
        localApiPort: this.options.localApiPort,
      });

      // Create session cache sync
      this.sessionCacheSync = new SessionCacheSync({
        localApiPort: this.options.localApiPort,
      });

      // Set up event handlers
      this.setupEventHandlers();

      // Connect
      await this.wsClient.connect();

      // Status will be updated in event handlers
    } catch (error) {
      console.error('[HubClient] Connection failed:', error);
      this.scheduleReconnect();
      throw error;
    }
  }

  /**
   * Disconnect from the Hub
   */
  async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    this.clearTimers();

    if (this.wsClient) {
      await this.wsClient.disconnect();
      this.wsClient = null;
    }

    if (this.apiRelayHandler) {
      this.apiRelayHandler.cleanup();
      this.apiRelayHandler = null;
    }

    if (this.consoleRelayHandler) {
      await this.consoleRelayHandler.cleanup();
      this.consoleRelayHandler = null;
    }

    if (this.sessionCacheSync) {
      this.sessionCacheSync.stop();
      this.sessionCacheSync = null;
    }

    this.status.connected = false;
    this.status.authenticated = false;
    this.emit('disconnected');
  }

  /**
   * Get current connection status
   */
  getStatus(): HubClientStatus {
    return { ...this.status };
  }

  /**
   * Get the assigned gateway ID (after authentication)
   */
  getGatewayId(): string | null {
    return this.status.gatewayId;
  }

  /**
   * Get active console sessions (direct mode)
   */
  getConsoleSessions(): Array<{ sessionId: string; ttydPort: number; projectPath?: string; startedAt: Date }> {
    return this.consoleRelayHandler?.getActiveSessions() || [];
  }

  /**
   * Get active console relays (relay mode)
   */
  getConsoleRelays(): Array<{ relayId: string; sessionId: string; ttydPort: number; status: string; startedAt: Date }> {
    return this.consoleRelayHandler?.getActiveRelays() || [];
  }

  private setupEventHandlers(): void {
    if (!this.wsClient) return;

    this.wsClient.on('connected', () => {
      console.log('[HubClient] WebSocket connected');
      this.status.connected = true;
      this.status.lastConnected = new Date();
      this.status.reconnectAttempts = 0;
      this.emit('connected');
    });

    this.wsClient.on('authenticated', (data: { gatewayId: string; sessionId: string }) => {
      console.log(`[HubClient] Authenticated as ${data.gatewayId}`);
      this.status.authenticated = true;
      this.status.gatewayId = data.gatewayId;
      this.status.sessionId = data.sessionId;

      // Save gateway ID to config for reconnection
      if (data.gatewayId !== this.config.gatewayId) {
        this.config.gatewayId = data.gatewayId;
        // Persist the gateway ID
        saveGatewayId(data.gatewayId);
      }

      // Start heartbeat
      this.startHeartbeat();

      // Start session cache sync
      if (this.sessionCacheSync && this.wsClient) {
        // WebSocketClient implements WebSocketSender interface
        this.sessionCacheSync.setWebSocket(this.wsClient);
        this.sessionCacheSync.start();
      }

      this.emit('authenticated', data);
    });

    this.wsClient.on('disconnected', (reason?: string) => {
      console.log(`[HubClient] Disconnected: ${reason || 'Unknown'}`);
      this.status.connected = false;
      this.status.authenticated = false;
      this.clearTimers();

      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }

      this.emit('disconnected', reason);
    });

    this.wsClient.on('error', (error: Error) => {
      console.error('[HubClient] WebSocket error:', error.message);
      this.emit('error', error);
    });

    this.wsClient.on('gateway_conflict', () => {
      console.warn('[HubClient] Gateway ID conflict detected - will reconnect with new ID');
      // Clear local gateway ID from config
      this.config.gatewayId = null;
      this.status.gatewayId = null;
      // Emit event so consumers can handle it
      this.emit('gateway_conflict');
    });

    this.wsClient.on('heartbeat_ack', () => {
      this.status.lastHeartbeat = new Date();
    });

    // Handle API relay requests from Hub
    this.wsClient.on('api_relay', async (request: ApiRelayRequest) => {
      if (this.apiRelayHandler) {
        await this.apiRelayHandler.handleRequest(request);
      }
    });

    // Handle console relay requests from Hub
    this.wsClient.on('console_start', async (message: { requestId: string; sessionId: string; projectPath?: string; force?: boolean }) => {
      if (this.consoleRelayHandler && this.wsClient) {
        // WebSocketClient implements WebSocketSender interface
        this.consoleRelayHandler.setWebSocket(this.wsClient);
        await this.consoleRelayHandler.handleConsoleStart(message);
      }
    });

    this.wsClient.on('console_start_all', async (message: { requestId: string }) => {
      if (this.consoleRelayHandler && this.wsClient) {
        this.consoleRelayHandler.setWebSocket(this.wsClient);
        await this.consoleRelayHandler.handleConsoleStartAll(message);
      }
    });

    this.wsClient.on('console_stop', async (message: { sessionId: string }) => {
      if (this.consoleRelayHandler) {
        await this.consoleRelayHandler.handleConsoleStop(message);
      }
    });

    // Handle console relay requests from Hub (binary relay mode)
    this.wsClient.on('console_start_relay', async (message: { relayId: string; sessionId: string; projectPath?: string }) => {
      if (this.consoleRelayHandler && this.wsClient) {
        this.consoleRelayHandler.setWebSocket(this.wsClient);
        await this.consoleRelayHandler.handleConsoleStartRelay(message);
      }
    });

    // Handle connect to existing ttyd (for iframe proxy mode)
    this.wsClient.on('console_connect_ttyd', async (message: { relayId: string; ttydPort: number }) => {
      if (this.consoleRelayHandler && this.wsClient) {
        this.consoleRelayHandler.setWebSocket(this.wsClient);
        await this.consoleRelayHandler.handleConsoleConnectTtyd(message);
      }
    });

    this.wsClient.on('console_stop_relay', async (message: { relayId: string }) => {
      if (this.consoleRelayHandler) {
        await this.consoleRelayHandler.handleConsoleStopRelay(message);
      }
    });

    this.wsClient.on('console_relay_data', (message: { relayId: string; data: string }) => {
      if (this.consoleRelayHandler) {
        this.consoleRelayHandler.handleConsoleRelayData(message);
      }
    });

    // Handle binary console data (efficient binary framing)
    this.wsClient.on('console_binary_data', (message: { relayIdHash: Buffer; payload: Buffer }) => {
      if (this.consoleRelayHandler) {
        this.consoleRelayHandler.handleBinaryData(message.relayIdHash, message.payload);
      }
    });
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();

    // Send heartbeat every 30 seconds
    this.heartbeatTimer = setInterval(() => {
      if (this.wsClient && this.status.connected) {
        this.wsClient.sendHeartbeat();
      }
    }, 30000);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.options.autoReconnect || this.isShuttingDown) {
      return;
    }

    if (this.options.maxReconnectAttempts > 0 &&
        this.status.reconnectAttempts >= this.options.maxReconnectAttempts) {
      console.log('[HubClient] Max reconnect attempts reached');
      this.emit('max_reconnects');
      return;
    }

    // Exponential backoff with max 30 seconds
    const baseDelay = Math.min(
      this.options.reconnectDelay * Math.pow(2, this.status.reconnectAttempts),
      30000
    );

    // Add jitter (±25% of base delay) to prevent thundering herd
    const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
    const delay = Math.round(baseDelay + jitter);

    this.status.reconnectAttempts++;
    console.log(`[HubClient] Reconnecting in ${delay}ms (attempt ${this.status.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        // Error already logged in connect(), but log reconnect failure for visibility
        console.error('[HubClient] Reconnect attempt failed:', error instanceof Error ? error.message : error);
      }
    }, delay);
  }
}

// Singleton instance
let hubClientInstance: HubClient | null = null;

/**
 * Get the singleton HubClient instance
 */
export function getHubClient(options?: HubClientOptions): HubClient {
  if (!hubClientInstance) {
    hubClientInstance = new HubClient(options);
  }
  return hubClientInstance;
}

/**
 * Create a new HubClient instance (for testing or multiple connections)
 */
export function createHubClient(options?: HubClientOptions): HubClient {
  return new HubClient(options);
}

/**
 * Reconnect the hub client (disconnect and reconnect)
 * Useful after code changes or connection issues
 */
export async function reconnectHubClient(): Promise<{ success: boolean; error?: string }> {
  if (!hubClientInstance) {
    return { success: false, error: 'Hub client not initialized' };
  }

  try {
    console.log('[HubClient] Reconnecting...');
    await hubClientInstance.disconnect();
    await hubClientInstance.connect();
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[HubClient] Reconnect failed:', message);
    return { success: false, error: message };
  }
}

/**
 * Reset the hub client singleton (creates new instance on next getHubClient call)
 */
export async function resetHubClient(): Promise<void> {
  if (hubClientInstance) {
    await hubClientInstance.disconnect();
    hubClientInstance = null;
  }
}

// Re-export types and utilities
export { HubConfig, getHubConfig, saveGatewayId, clearGatewayId, isHubConfigured } from './hub-config';
export { WebSocketClient, WebSocketClientOptions } from './websocket-client';
export { ApiRelayHandler, ApiRelayHandlerOptions, ApiRelayRequest, ApiRelayResponse } from './api-relay-handler';
export { ConsoleRelayHandler, ConsoleSession, ConsoleRelayOptions, getConsoleRelayHandler } from './console-relay-handler';
export { SessionCacheSync, SessionSummary as SessionCacheSummary, SessionCacheSyncOptions, getSessionCacheSync } from './session-cache-sync';
