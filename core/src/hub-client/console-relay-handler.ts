/**
 * Console Relay Handler
 *
 * Handles console relay messages from the Hub for remote terminal access.
 *
 * Flow (relay mode - used for remote access via hub):
 * 1. Hub sends console_start_relay with relayId
 * 2. Worker starts ttyd via local API
 * 3. Worker connects to local ttyd WebSocket
 * 4. Worker relays binary frames between local ttyd and hub via existing gateway WebSocket
 *
 * Binary frame format (hub <-> worker):
 *   [0xFF] [8-byte relayId hash] [ttyd payload]
 *
 * Flow (direct mode - used for local admin-web):
 * 1. Hub sends console_start with requestId
 * 2. Worker starts ttyd and returns URL
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as net from 'net';
import WebSocket from 'ws';

/** Interface for WebSocket-like objects that can send messages */
export interface WebSocketSender {
  send(data: unknown): void;
  sendBinary?(relayIdHash: Buffer, payload: Buffer): void;
  isConnected(): boolean;
}

export interface ConsoleSession {
  sessionId: string;
  requestId: string;
  ttydPort: number;
  projectPath?: string;
  startedAt: Date;
}

/** Active relay session (connected to local ttyd) */
export interface ConsoleRelaySession {
  relayId: string;
  relayIdHash: Buffer;  // 8-byte hash for binary framing
  sessionId: string;
  ttydPort: number;
  ttydWs: WebSocket | null;
  status: 'starting' | 'connecting' | 'active' | 'closed';
  startedAt: Date;
}

export interface ConsoleRelayOptions {
  /** Local API port */
  localApiPort?: number;
  /** Port range for ttyd instances */
  ttydPortRange?: {
    min: number;
    max: number;
  };
}

export class ConsoleRelayHandler extends EventEmitter {
  private ws: WebSocketSender | null = null;
  private activeSessions: Map<string, ConsoleSession> = new Map();
  private activeRelays: Map<string, ConsoleRelaySession> = new Map();
  private relayHashToId: Map<string, string> = new Map();  // hash hex -> relayId
  private localApiPort: number;

  // Port range for ttyd (configurable)
  private readonly minTtydPort: number;
  private readonly maxTtydPort: number;

  // UUID v4 validation regex
  private static readonly UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  // Default port range
  private static readonly DEFAULT_MIN_PORT = 7681;
  private static readonly DEFAULT_MAX_PORT = 8180;

  /**
   * Generate an 8-byte hash from relayId for binary framing
   * 8 bytes provides better collision resistance for concurrent sessions
   */
  private static hashRelayId(relayId: string): Buffer {
    const hash = crypto.createHash('md5').update(relayId).digest();
    return hash.subarray(0, 8);  // First 8 bytes
  }

  constructor(options: ConsoleRelayOptions = {}) {
    super();
    this.localApiPort = options.localApiPort || 3100;
    this.minTtydPort = options.ttydPortRange?.min || ConsoleRelayHandler.DEFAULT_MIN_PORT;
    this.maxTtydPort = options.ttydPortRange?.max || ConsoleRelayHandler.DEFAULT_MAX_PORT;
  }

  /**
   * Set the WebSocket connection to hub
   */
  public setWebSocket(ws: WebSocketSender): void {
    this.ws = ws;
  }

  /**
   * Validate session/relay ID format
   */
  private validateId(id: string): boolean {
    return typeof id === 'string' && ConsoleRelayHandler.UUID_REGEX.test(id);
  }

  // ==========================================================================
  // RELAY MODE - Used for remote access via hub
  // ==========================================================================

  /**
   * Handle console_start_relay message from Hub
   * This starts ttyd and connects to it, relaying frames via existing WebSocket
   */
  public async handleConsoleStartRelay(message: {
    relayId: string;
    sessionId: string;
    projectPath?: string;
  }): Promise<void> {
    const { relayId, sessionId, projectPath } = message;

    // Validate IDs
    if (!this.validateId(relayId)) {
      console.warn(`[ConsoleRelayHandler] Invalid relay ID format: ${relayId}`);
      this.sendRelayError(relayId, 'Invalid relay ID format');
      return;
    }

    if (!this.validateId(sessionId)) {
      console.warn(`[ConsoleRelayHandler] Invalid session ID format: ${sessionId}`);
      this.sendRelayError(relayId, 'Invalid session ID format');
      return;
    }

    console.log(`[ConsoleRelayHandler] Starting console relay: relay=${relayId}, session=${sessionId}`);

    // Check if relay already exists
    if (this.activeRelays.has(relayId)) {
      console.warn(`[ConsoleRelayHandler] Relay already exists: ${relayId}`);
      this.sendRelayReady(relayId);
      return;
    }

    // Create relay session with hash for binary framing
    const relayIdHash = ConsoleRelayHandler.hashRelayId(relayId);
    const relay: ConsoleRelaySession = {
      relayId,
      relayIdHash,
      sessionId,
      ttydPort: 0,
      ttydWs: null,
      status: 'starting',
      startedAt: new Date(),
    };
    this.activeRelays.set(relayId, relay);
    this.relayHashToId.set(relayIdHash.toString('hex'), relayId);

    try {
      // Always go through the local API for relay sessions.
      // The API performs health checks on existing ttyd instances (e.g., detecting
      // stale tmux sessions where Claude has exited and only bash remains).
      // Previously we cached ports here, but that bypassed health checks.
      {
        // If projectPath not provided, look it up from local sessions API
        let resolvedProjectPath: string | undefined = projectPath;
        if (!resolvedProjectPath) {
          resolvedProjectPath = (await this.lookupProjectPath(sessionId)) || undefined;
          if (resolvedProjectPath) {
            console.log(`[ConsoleRelayHandler] Resolved projectPath from sessions API: ${resolvedProjectPath}`);
          }
        }

        const port = await this.findAvailablePort();
        if (!port) {
          throw new Error('No available ports for console');
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const response = await fetch(`http://localhost:${this.localApiPort}/ttyd/session/${sessionId}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectPath: resolvedProjectPath,
            port,
            mode: 'shared',
            force: true,  // Allow starting even if session is active elsewhere
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const responseData = await response.json() as {
          success?: boolean;
          error?: string;
          data?: {
            port?: number;
            alreadyRunning?: boolean;
            pid?: number;
          };
        };

        if (!response.ok || !responseData.success) {
          throw new Error(responseData.error || `API returned ${response.status}`);
        }

        // Port is in the nested data object
        relay.ttydPort = responseData.data?.port || port;

        if (responseData.data?.alreadyRunning) {
          console.log(`[ConsoleRelayHandler] ttyd already running on port ${relay.ttydPort} for session ${sessionId}`);
        }
      }

      // Connect to local ttyd WebSocket
      relay.status = 'connecting';
      await this.connectToLocalTtyd(relay);

      console.log(`[ConsoleRelayHandler] Console relay active: relay=${relayId}, port=${relay.ttydPort}`);

    } catch (error) {
      const errorMessage = error instanceof Error
        ? (error.name === 'AbortError' ? 'Timeout starting console' : error.message)
        : String(error);
      console.error(`[ConsoleRelayHandler] Failed to start console relay:`, errorMessage);
      this.sendRelayError(relayId, errorMessage);
      this.cleanupRelay(relayId);
    }
  }

  /**
   * Handle console_connect_ttyd message from Hub
   * This connects to an already-running ttyd instance (for iframe proxy mode)
   * Unlike handleConsoleStartRelay, this does NOT start ttyd - it's already running
   */
  public async handleConsoleConnectTtyd(message: {
    relayId: string;
    ttydPort: number;
  }): Promise<void> {
    const { relayId, ttydPort } = message;

    // Validate relay ID
    if (!this.validateId(relayId)) {
      console.warn(`[ConsoleRelayHandler] Invalid relay ID format: ${relayId}`);
      this.sendRelayError(relayId, 'Invalid relay ID format');
      return;
    }

    if (!ttydPort || ttydPort < 1 || ttydPort > 65535) {
      console.warn(`[ConsoleRelayHandler] Invalid ttyd port: ${ttydPort}`);
      this.sendRelayError(relayId, 'Invalid ttyd port');
      return;
    }

    console.log(`[ConsoleRelayHandler] Connecting to existing ttyd: relay=${relayId}, port=${ttydPort}`);

    // Check if relay already exists
    if (this.activeRelays.has(relayId)) {
      console.warn(`[ConsoleRelayHandler] Relay already exists: ${relayId}`);
      this.sendRelayReady(relayId);
      return;
    }

    // Create relay session with hash for binary framing
    const relayIdHash = ConsoleRelayHandler.hashRelayId(relayId);
    const relay: ConsoleRelaySession = {
      relayId,
      relayIdHash,
      sessionId: `ttyd-${ttydPort}`,  // Use port as pseudo session ID
      ttydPort,
      ttydWs: null,
      status: 'connecting',
      startedAt: new Date(),
    };
    this.activeRelays.set(relayId, relay);
    this.relayHashToId.set(relayIdHash.toString('hex'), relayId);

    try {
      // Connect to local ttyd WebSocket (ttyd is already running)
      await this.connectToLocalTtyd(relay);
      console.log(`[ConsoleRelayHandler] Connected to existing ttyd: relay=${relayId}, port=${ttydPort}`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[ConsoleRelayHandler] Failed to connect to ttyd:`, errorMessage);
      this.sendRelayError(relayId, errorMessage);
      this.cleanupRelayWithoutStop(relayId);  // Don't try to stop ttyd since we didn't start it
    }
  }

  /**
   * Clean up a relay session without stopping ttyd (used for ttyd proxy connections)
   */
  private cleanupRelayWithoutStop(relayId: string): void {
    const relay = this.activeRelays.get(relayId);
    if (!relay) return;

    relay.status = 'closed';

    // Close ttyd WebSocket
    if (relay.ttydWs) {
      try {
        relay.ttydWs.close();
      } catch { }
      relay.ttydWs = null;
    }

    // Clean up hash mapping (don't stop ttyd)
    if (relay.relayIdHash) {
      this.relayHashToId.delete(relay.relayIdHash.toString('hex'));
    }
    this.activeRelays.delete(relayId);
    console.log(`[ConsoleRelayHandler] Relay cleaned up (ttyd kept running): ${relayId}`);
  }

  /**
   * Connect to local ttyd WebSocket via proxy and set up relay
   * Uses ttyd-proxy to handle CORS and provide consistent endpoint
   */
  private async connectToLocalTtyd(relay: ConsoleRelaySession): Promise<void> {
    return new Promise((resolve, reject) => {
      // Connect via ttyd-proxy instead of directly to ttyd
      // This handles CORS and provides a consistent endpoint
      const ttydWsUrl = `ws://localhost:${this.localApiPort}/ttyd-proxy/${relay.ttydPort}/ws`;

      console.log(`[ConsoleRelayHandler] Connecting to local ttyd: ${ttydWsUrl}`);

      // ttyd requires the 'tty' subprotocol - without it, it accepts the connection
      // but never sends any data
      const ttydWs = new WebSocket(ttydWsUrl, ['tty']);
      relay.ttydWs = ttydWs;

      const connectionTimeout = setTimeout(() => {
        if (relay.status === 'connecting') {
          ttydWs.close();
          reject(new Error('ttyd connection timeout'));
        }
      }, 10000);

      ttydWs.on('open', () => {
        clearTimeout(connectionTimeout);
        relay.status = 'active';
        console.log(`[ConsoleRelayHandler] Connected to local ttyd: relay=${relay.relayId}`);

        // ttyd protocol: The first message MUST be a JSON object starting with '{'
        // which triggers spawn_process() on the server side.
        // The JSON contains columns, rows, and optionally AuthToken.
        // See ttyd/src/protocol.c JSON_DATA case (command = '{').
        const initMsg = JSON.stringify({ columns: 120, rows: 40 });
        ttydWs.send(initMsg);
        console.log(`[ConsoleRelayHandler] Sent ttyd init message: relay=${relay.relayId}`);

        // Notify hub that relay is ready
        this.sendRelayReady(relay.relayId);
        resolve();
      });

      ttydWs.on('message', (data: WebSocket.Data) => {
        // Forward data from ttyd to hub as-is (including type byte)
        // The browser's ttyd client expects the full ttyd protocol:
        //   Type 0 = output data, Type 1 = window title, Type 2 = preferences
        if (relay.status === 'active') {
          const buffer = data as Buffer;
          if (buffer.length > 0) {
            this.sendRelayData(relay, buffer);
          }
        }
      });

      ttydWs.on('close', () => {
        console.log(`[ConsoleRelayHandler] ttyd connection closed: relay=${relay.relayId}`);
        if (relay.status === 'active') {
          this.sendRelayError(relay.relayId, 'ttyd connection closed');
        }
        this.cleanupRelay(relay.relayId);
      });

      ttydWs.on('error', (error) => {
        clearTimeout(connectionTimeout);
        console.error(`[ConsoleRelayHandler] ttyd WebSocket error: relay=${relay.relayId}`, error.message);
        if (relay.status === 'connecting') {
          reject(error);
        } else {
          this.sendRelayError(relay.relayId, error.message);
          this.cleanupRelay(relay.relayId);
        }
      });
    });
  }

  /**
   * Handle console_stop_relay message from Hub
   */
  public async handleConsoleStopRelay(message: { relayId: string }): Promise<void> {
    const { relayId } = message;
    console.log(`[ConsoleRelayHandler] Stopping console relay: ${relayId}`);
    this.cleanupRelay(relayId);
  }

  /**
   * Handle console_relay_data from Hub (browser -> ttyd) - JSON format (legacy)
   */
  public handleConsoleRelayData(message: { relayId: string; data: string }): void {
    const { relayId, data } = message;

    const relay = this.activeRelays.get(relayId);
    if (!relay || relay.status !== 'active' || !relay.ttydWs) {
      return;
    }

    // Forward data to local ttyd with type prefix
    // ttyd client->server protocol:
    // Type '0' (0x30) = input data
    // Type '1' (0x31) = resize (JSON with cols/rows)
    try {
      const inputData = Buffer.from(data, 'base64');
      // Prepend type byte for input
      const ttydMsg = Buffer.concat([Buffer.from([0x30]), inputData]);
      relay.ttydWs.send(ttydMsg);
    } catch (error) {
      console.error(`[ConsoleRelayHandler] Failed to send data to ttyd:`, error);
    }
  }

  /**
   * Handle binary console data from Hub (browser -> ttyd)
   * Frame format: [8-byte hash] already stripped by caller, just payload
   */
  public handleBinaryData(relayIdHash: Buffer, payload: Buffer): void {
    const hashHex = relayIdHash.toString('hex');
    const relayId = this.relayHashToId.get(hashHex);
    if (!relayId) {
      return;
    }

    const relay = this.activeRelays.get(relayId);
    if (!relay || relay.status !== 'active' || !relay.ttydWs) {
      return;
    }

    // The payload is raw ttyd client->server data
    // First byte determines type:
    // 0x30 ('0') = input data
    // 0x31 ('1') = resize JSON
    try {
      relay.ttydWs.send(payload);
    } catch (error) {
      console.error(`[ConsoleRelayHandler] Failed to send binary to ttyd:`, error);
    }
  }

  /**
   * Clean up a relay session
   */
  private async cleanupRelay(relayId: string): Promise<void> {
    const relay = this.activeRelays.get(relayId);
    if (!relay) return;

    relay.status = 'closed';

    // Close ttyd WebSocket
    if (relay.ttydWs) {
      try {
        relay.ttydWs.close();
      } catch { }
      relay.ttydWs = null;
    }

    // Stop ttyd via local API
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      await fetch(`http://localhost:${this.localApiPort}/ttyd/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: relay.sessionId }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch {
      // Ignore stop errors
    }

    // Clean up hash mapping
    if (relay.relayIdHash) {
      this.relayHashToId.delete(relay.relayIdHash.toString('hex'));
    }
    this.activeRelays.delete(relayId);
    console.log(`[ConsoleRelayHandler] Relay cleaned up: ${relayId}`);
  }

  /**
   * Send console_relay_ready to Hub
   */
  private sendRelayReady(relayId: string): void {
    if (!this.ws || !this.ws.isConnected()) {
      console.warn('[ConsoleRelayHandler] Cannot send relay ready: WebSocket not connected');
      return;
    }

    this.ws.send({
      type: 'console_relay_ready',
      relayId,
    });
  }

  /**
   * Send console_relay_error to Hub
   */
  private sendRelayError(relayId: string, error: string): void {
    if (!this.ws || !this.ws.isConnected()) {
      console.warn('[ConsoleRelayHandler] Cannot send relay error: WebSocket not connected');
      return;
    }

    this.ws.send({
      type: 'console_relay_error',
      relayId,
      error,
    });
  }

  /**
   * Send console relay data to Hub (ttyd -> browser)
   * Uses binary framing: [0xFF] [8-byte hash] [payload]
   */
  private sendRelayData(relay: ConsoleRelaySession, data: Buffer): void {
    if (!this.ws || !this.ws.isConnected()) {
      return;
    }

    // Use binary if available, fall back to JSON
    if (this.ws.sendBinary) {
      this.ws.sendBinary(relay.relayIdHash, data);
    } else {
      this.ws.send({
        type: 'console_relay_data',
        relayId: relay.relayId,
        data: data.toString('base64'),
      });
    }
  }

  // ==========================================================================
  // DIRECT MODE - Used for local admin-web access
  // ==========================================================================

  /**
   * Handle console_start message from Hub (direct mode)
   */
  public async handleConsoleStart(message: {
    requestId: string;
    sessionId: string;
    projectPath?: string;
    force?: boolean;
    connectPid?: number;
    existingTmuxSession?: string;
  }): Promise<void> {
    const { requestId, sessionId, projectPath, force, connectPid, existingTmuxSession } = message;

    if (!this.validateId(sessionId)) {
      console.warn(`[ConsoleRelayHandler] Invalid session ID format: ${sessionId}`);
      this.sendConsoleError(requestId, 'Invalid session ID format');
      return;
    }

    // If projectPath not provided, look it up from local sessions API
    let resolvedProjectPath: string | undefined = projectPath;
    if (!resolvedProjectPath) {
      resolvedProjectPath = (await this.lookupProjectPath(sessionId)) || undefined;
      if (resolvedProjectPath) {
        console.log(`[ConsoleRelayHandler] Resolved projectPath for console_start: ${resolvedProjectPath}`);
      }
    }

    console.log(`[ConsoleRelayHandler] Starting console for session ${sessionId} (force=${force}, projectPath=${resolvedProjectPath})`);

    // Clear any cached session so we always go through the local API
    // (which performs health checks on existing ttyd instances)
    this.activeSessions.delete(sessionId);

    const port = await this.findAvailablePort();
    if (!port) {
      this.sendConsoleError(requestId, 'No available ports for console');
      return;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(`http://localhost:${this.localApiPort}/ttyd/session/${sessionId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: resolvedProjectPath,
          port,
          mode: 'shared',
          force,
          connectPid,
          existingTmuxSession,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await response.json() as {
        success?: boolean;
        port?: number;
        error?: string;
        code?: string;
        data?: {
          port?: number;
          warnings?: string[];
          forcedStart?: boolean;
          [key: string]: unknown;
        };
      };

      if (!response.ok || !data.success) {
        // Pass through structured error data
        this.sendConsoleError(requestId, data.error || `API returned ${response.status}`, {
          code: data.code,
          data: data.data,
        });
        return;
      }

      // Port can be at data.port (flat) or data.data.port (nested)
      const actualPort = data.port || data.data?.port || port;
      console.log(`[ConsoleRelayHandler] Local API response: success=${data.success}, port=${data.port}, data.port=${data.data?.port}, actualPort=${actualPort}, alreadyRunning=${(data as any).data?.alreadyRunning}`);

      const session: ConsoleSession = {
        sessionId,
        requestId,
        ttydPort: actualPort,
        projectPath,
        startedAt: new Date(),
      };
      this.activeSessions.set(sessionId, session);

      // Pass warnings and forcedStart from local API to hub
      this.sendConsoleReady(requestId, session.ttydPort, sessionId, {
        warnings: data.data?.warnings,
        forcedStart: data.data?.forcedStart,
      });
      console.log(`[ConsoleRelayHandler] Console started on port ${session.ttydPort} for session ${sessionId}`);
    } catch (error) {
      const errorMessage = error instanceof Error
        ? (error.name === 'AbortError' ? 'Timeout starting console session' : error.message)
        : String(error);
      console.error(`[ConsoleRelayHandler] Failed to start console:`, errorMessage);
      this.sendConsoleError(requestId, errorMessage);
    }
  }

  /**
   * Handle console_start_all message from Hub (direct mode)
   * Starts ttyd for all running Claude sessions in a single call
   */
  public async handleConsoleStartAll(message: {
    requestId: string;
  }): Promise<void> {
    const { requestId } = message;

    console.log(`[ConsoleRelayHandler] Starting all console sessions (requestId=${requestId})`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000); // 120s timeout

      const response = await fetch(`http://localhost:${this.localApiPort}/ttyd/start-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await response.json() as {
        success?: boolean;
        error?: string;
        data?: {
          results?: Array<{
            sessionId: string;
            port?: number;
            url?: string;
            alreadyRunning?: boolean;
            error?: string;
          }>;
          summary?: {
            total: number;
            started: number;
            alreadyRunning: number;
            failed: number;
          };
        };
      };

      if (!response.ok || !data.success) {
        this.sendConsoleStartAllError(requestId, data.error || `API returned ${response.status}`);
        return;
      }

      // Cache successful results in activeSessions
      const results = data.data?.results || [];
      for (const result of results) {
        if (result.port && !result.error) {
          this.activeSessions.set(result.sessionId, {
            sessionId: result.sessionId,
            requestId,
            ttydPort: result.port,
            startedAt: new Date(),
          });
        }
      }

      // Send results back to hub
      this.sendConsoleStartAllReady(requestId, results, data.data?.summary);
      console.log(`[ConsoleRelayHandler] Start-all complete: ${data.data?.summary?.started} started, ${data.data?.summary?.alreadyRunning} already running, ${data.data?.summary?.failed} failed`);
    } catch (error) {
      const errorMessage = error instanceof Error
        ? (error.name === 'AbortError' ? 'Timeout starting all console sessions' : error.message)
        : String(error);
      console.error(`[ConsoleRelayHandler] Failed to start all consoles:`, errorMessage);
      this.sendConsoleStartAllError(requestId, errorMessage);
    }
  }

  /**
   * Send console_start_all_ready response to Hub
   */
  private sendConsoleStartAllReady(
    requestId: string,
    results: Array<{
      sessionId: string;
      port?: number;
      url?: string;
      alreadyRunning?: boolean;
      error?: string;
    }>,
    summary?: { total: number; started: number; alreadyRunning: number; failed: number }
  ): void {
    if (!this.ws || !this.ws.isConnected()) {
      console.warn('[ConsoleRelayHandler] Cannot send console_start_all_ready: WebSocket not connected');
      return;
    }

    this.ws.send({
      type: 'console_start_all_ready',
      requestId,
      results,
      summary,
    });
  }

  /**
   * Send console_start_all_error response to Hub
   */
  private sendConsoleStartAllError(requestId: string, error: string): void {
    if (!this.ws || !this.ws.isConnected()) {
      console.warn('[ConsoleRelayHandler] Cannot send console_start_all_error: WebSocket not connected');
      return;
    }

    this.ws.send({
      type: 'console_start_all_error',
      requestId,
      error,
    });
  }

  /**
   * Handle console_stop message from Hub (direct mode)
   */
  public async handleConsoleStop(message: { sessionId: string }): Promise<void> {
    const { sessionId } = message;

    console.log(`[ConsoleRelayHandler] Stopping console for session ${sessionId}`);

    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      await fetch(`http://localhost:${this.localApiPort}/ttyd/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (error) {
      clearTimeout(timeoutId);
      const errorMessage = error instanceof Error
        ? (error.name === 'AbortError' ? 'Timeout stopping console session' : error.message)
        : String(error);
      console.error(`[ConsoleRelayHandler] Failed to stop console:`, errorMessage);
    }

    this.activeSessions.delete(sessionId);
  }

  // ==========================================================================
  // UTILITY METHODS
  // ==========================================================================

  /**
   * Find an available port for ttyd
   */
  private async findAvailablePort(): Promise<number | null> {
    const usedPorts = new Set([
      ...Array.from(this.activeSessions.values()).map(s => s.ttydPort),
      ...Array.from(this.activeRelays.values()).map(r => r.ttydPort),
    ]);

    for (let port = this.minTtydPort; port <= this.maxTtydPort; port++) {
      if (!usedPorts.has(port)) {
        const available = await this.checkPortAvailable(port);
        if (available) {
          return port;
        }
      }
    }
    return null;
  }

  /**
   * Look up projectPath for a session from the local sessions API
   */
  private async lookupProjectPath(sessionId: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(
        `http://localhost:${this.localApiPort}/sessions/${sessionId}`,
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);
      if (!response.ok) return null;
      const data = await response.json() as { success?: boolean; data?: { projectPath?: string } };
      return data?.data?.projectPath || null;
    } catch {
      return null;
    }
  }

  /**
   * Check if a port is available
   */
  private checkPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      server.listen(port, '127.0.0.1');
    });
  }

  /**
   * Check if a port has something listening (opposite of checkPortAvailable)
   */
  private isPortListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(1000);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, '127.0.0.1');
    });
  }

  /**
   * Send console_ready response to Hub (direct mode)
   */
  private sendConsoleReady(
    requestId: string,
    port: number,
    sessionId: string,
    options?: { warnings?: string[]; forcedStart?: boolean }
  ): void {
    if (!this.ws || !this.ws.isConnected()) {
      console.warn('[ConsoleRelayHandler] Cannot send console_ready: WebSocket not connected');
      return;
    }

    this.ws.send({
      type: 'console_ready',
      requestId,
      ttydUrl: `http://localhost:${port}`,
      sessionId,
      port,
      warnings: options?.warnings,
      forcedStart: options?.forcedStart,
    });
  }

  /**
   * Send console_error response to Hub (direct mode)
   */
  private sendConsoleError(
    requestId: string,
    error: string,
    details?: { code?: string; data?: Record<string, unknown> }
  ): void {
    if (!this.ws || !this.ws.isConnected()) {
      console.warn('[ConsoleRelayHandler] Cannot send console_error: WebSocket not connected');
      return;
    }

    this.ws.send({
      type: 'console_error',
      requestId,
      error,
      code: details?.code,
      data: details?.data,
    });
  }

  /**
   * Cleanup all console sessions and relays
   */
  public async cleanup(): Promise<void> {
    // Cleanup direct sessions
    for (const sessionId of this.activeSessions.keys()) {
      try {
        await this.handleConsoleStop({ sessionId });
      } catch { }
    }
    this.activeSessions.clear();

    // Cleanup relay sessions
    for (const relayId of this.activeRelays.keys()) {
      try {
        await this.cleanupRelay(relayId);
      } catch { }
    }
    this.activeRelays.clear();
  }

  /**
   * Get list of active console sessions
   */
  public getActiveSessions(): Array<{
    sessionId: string;
    ttydPort: number;
    projectPath?: string;
    startedAt: Date;
  }> {
    return Array.from(this.activeSessions.values()).map(s => ({
      sessionId: s.sessionId,
      ttydPort: s.ttydPort,
      projectPath: s.projectPath,
      startedAt: s.startedAt,
    }));
  }

  /**
   * Get list of active relay sessions
   */
  public getActiveRelays(): Array<{
    relayId: string;
    sessionId: string;
    ttydPort: number;
    status: string;
    startedAt: Date;
  }> {
    return Array.from(this.activeRelays.values()).map(r => ({
      relayId: r.relayId,
      sessionId: r.sessionId,
      ttydPort: r.ttydPort,
      status: r.status,
      startedAt: r.startedAt,
    }));
  }
}

// Singleton instance
let handlerInstance: ConsoleRelayHandler | null = null;

export function getConsoleRelayHandler(options?: ConsoleRelayOptions): ConsoleRelayHandler {
  if (!handlerInstance) {
    handlerInstance = new ConsoleRelayHandler(options);
  }
  return handlerInstance;
}
