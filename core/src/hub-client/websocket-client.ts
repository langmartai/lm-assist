/**
 * WebSocket Client for Hub Connection
 *
 * Handles the WebSocket connection to LangMart Hub (Type 1 Gateway),
 * including registration, heartbeat, and message handling.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { clearGatewayId } from './hub-config';

export interface WebSocketClientOptions {
  /** Hub WebSocket URL */
  url: string;
  /** API key for authentication */
  apiKey: string;
  /** Machine ID (hardware fingerprint) */
  machineId: string;
  /** Gateway ID (null for first connection, assigned by server) */
  gatewayId: string | null;
  /** Local API port for relay */
  localApiPort: number;
}

export class WebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: WebSocketClientOptions;
  private _isConnected = false;
  private pingInterval: NodeJS.Timeout | null = null;

  // Ping interval (25 seconds - less than typical 30s proxy timeout)
  private static readonly PING_INTERVAL_MS = 25000;

  constructor(options: WebSocketClientOptions) {
    super();
    this.options = options;
  }

  /**
   * Connect to the Hub
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Create WebSocket connection with headers
        const ws = new WebSocket(this.options.url, {
          headers: {
            'X-Gateway-Type': '4',
            'X-Instance-ID': this.options.machineId,
            'X-Version': this.getVersion(),
          },
        });
        this.ws = ws;

        // Set up event handlers
        ws.on('open', () => {
          console.log('[WebSocketClient] Connection opened');
          this._isConnected = true;
          this.emit('connected');

          // Start ping/pong keep-alive
          this.startPingInterval();

          // Send registration message
          this.sendRegistration();
          resolve();
        });

        ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        ws.on('close', (code: number, reason: Buffer) => {
          const reasonStr = reason?.toString() || 'Unknown';
          console.log(`[WebSocketClient] Connection closed: ${code} - ${reasonStr}`);
          this._isConnected = false;
          this.ws = null;
          this.stopPingInterval();
          this.emit('disconnected', reasonStr);
        });

        ws.on('pong', () => {
          // Pong received - connection is alive
          // This is handled automatically by the ws library
        });

        ws.on('error', (error: Error) => {
          console.error('[WebSocketClient] Error:', error.message);
          this.emit('error', error);
          if (!this._isConnected) {
            reject(error);
          }
        });

        // Connection timeout
        const timeout = setTimeout(() => {
          if (!this._isConnected) {
            ws.close();
            reject(new Error('Connection timeout'));
          }
        }, 10000);

        ws.once('open', () => clearTimeout(timeout));

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the Hub
   */
  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      // Stop ping interval first
      this.stopPingInterval();

      if (!this.ws) {
        resolve();
        return;
      }

      // Send graceful shutdown notification
      this.send({
        type: 'worker_shutdown',
        gateway_id: this.options.gatewayId,
        reason: 'Graceful shutdown',
        timestamp: new Date().toISOString(),
      });

      // Wait a bit for the message to be sent
      setTimeout(() => {
        this.ws?.close(1000, 'Client disconnecting');
        this.ws = null;
        this._isConnected = false;
        resolve();
      }, 100);
    });
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Send a JSON message to the Hub
   */
  send(message: unknown): void {
    if (!this.isConnected()) {
      console.warn('[WebSocketClient] Cannot send - not connected');
      return;
    }

    try {
      this.ws!.send(JSON.stringify(message));
    } catch (error) {
      console.error('[WebSocketClient] Failed to send message:', error instanceof Error ? error.message : error);
      // Emit error so HubClient can handle it
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Send binary data to the Hub (for console relay)
   * Frame format: [0xFF] [8-byte relayId hash] [payload]
   */
  sendBinary(relayIdHash: Buffer, payload: Buffer): void {
    if (!this.isConnected()) {
      return;
    }

    try {
      // 0xFF marker + 8-byte relay ID hash + payload
      const frame = Buffer.concat([
        Buffer.from([0xff]),
        relayIdHash,
        payload,
      ]);
      this.ws!.send(frame);
    } catch (error) {
      console.error('[WebSocketClient] Failed to send binary:', error instanceof Error ? error.message : error);
    }
  }

  /**
   * Send heartbeat (only if authenticated with a gateway ID)
   */
  sendHeartbeat(): void {
    // Only send heartbeat if we have a gateway ID (authenticated)
    if (!this.options.gatewayId) {
      console.warn('[WebSocketClient] Skipping heartbeat - no gateway ID assigned yet');
      return;
    }

    this.send({
      type: 'heartbeat',
      gateway_id: this.options.gatewayId,
      timestamp: new Date().toISOString(),
      metrics: {
        cpu_usage: this.getCpuUsage(),
        memory_usage: this.getMemoryUsage(),
        uptime: process.uptime(),
      },
    });
  }

  /**
   * Send registration message to Hub
   */
  private sendRegistration(): void {
    const registration = {
      event: 'gateway_register',
      gateway_type: 4,
      gateway_id: this.options.gatewayId, // null for first connection
      instance_id: this.options.machineId,
      api_key: this.options.apiKey,
      mode: 'tier_agent',
      system_info: {
        os_platform: os.platform(),
        os_release: os.release(),
        node_version: process.version,
        arch: os.arch(),
        hostname: os.hostname(),
        is_container: this.isInContainer(),
        run_mode: 'standalone',
      },
      capabilities: {
        supports_api_relay: true,
        supports_console_relay: true,
        local_api_port: this.options.localApiPort,
      },
      version: this.getVersion(),
    };

    console.log(`[WebSocketClient] Sending registration (gateway_id: ${this.options.gatewayId || 'new'})`);
    this.send(registration);
  }

  /**
   * Handle incoming messages from Hub
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      // Convert to Buffer for inspection
      let buffer: Buffer;
      if (Buffer.isBuffer(data)) {
        buffer = data;
      } else if (data instanceof ArrayBuffer) {
        buffer = Buffer.from(data);
      } else if (Array.isArray(data)) {
        buffer = Buffer.concat(data);
      } else {
        buffer = Buffer.from(String(data));
      }

      // Check for binary console frame (starts with 0xFF)
      // Format: [0xFF][8-byte hash][payload]
      if (buffer.length >= 9 && buffer[0] === 0xff) {
        const relayIdHash = buffer.subarray(1, 9);  // 8 bytes
        const payload = buffer.subarray(9);
        this.emit('console_binary_data', { relayIdHash, payload });
        return;
      }

      // Otherwise parse as JSON
      const dataStr = buffer.toString('utf-8');
      const message = JSON.parse(dataStr) as Record<string, unknown>;
      const messageType = message.type || message.event;

      // Debug log all incoming messages except heartbeat responses
      if (messageType !== 'heartbeat_ack' && messageType !== 'pong') {
        console.log(`[WebSocketClient] Received message: type=${messageType}`);
      }

      switch (messageType) {
        case 'register_ack':
          console.log('[WebSocketClient] Registration acknowledged');
          break;

        case 'auth_confirmed':
          console.log(`[WebSocketClient] Authentication confirmed: ${message.gateway_id || message.gatewayId}`);
          this.emit('authenticated', {
            gatewayId: message.gateway_id || message.gatewayId,
            sessionId: message.sessionId,
          });
          break;

        case 'auth_failed':
          console.error(`[WebSocketClient] Authentication failed: ${message.reason}`);
          this.emit('auth_failed', message.reason);
          this.ws?.close(4001, 'Authentication failed');
          break;

        case 'gateway_id_conflict':
          console.warn('[WebSocketClient] Gateway ID conflict - clearing local config');
          // Clear local gateway ID and reconnect
          clearGatewayId();
          this.options.gatewayId = null;
          this.emit('gateway_conflict');
          this.ws?.close(4002, 'Gateway ID conflict');
          break;

        case 'heartbeat_ack':
          this.emit('heartbeat_ack');
          break;

        case 'api_relay':
          // Hub is requesting us to call our local API
          this.emit('api_relay', message);
          break;

        case 'console_start':
          // Hub wants to start a console relay session
          this.emit('console_start', message);
          break;

        case 'console_start_all':
          // Hub wants to start consoles for all running sessions
          console.log(`[WebSocketClient] Received console_start_all: requestId=${message.requestId}`);
          this.emit('console_start_all', message);
          break;

        case 'console_stop':
          // Hub wants to stop a console relay session
          this.emit('console_stop', message);
          break;

        case 'console_start_relay':
          // Hub wants to start a console relay session (binary relay mode)
          console.log(`[WebSocketClient] Received console_start_relay: relayId=${message.relayId}, sessionId=${message.sessionId}`);
          this.emit('console_start_relay', message);
          break;

        case 'console_connect_ttyd':
          // Hub wants to connect to an existing ttyd instance (for iframe proxy)
          console.log(`[WebSocketClient] Received console_connect_ttyd: relayId=${message.relayId}, port=${message.ttydPort}`);
          this.emit('console_connect_ttyd', message);
          break;

        case 'console_stop_relay':
          // Hub wants to stop a console relay session (binary relay mode)
          this.emit('console_stop_relay', message);
          break;

        case 'console_relay_data':
          // Hub is sending binary console data (base64 encoded)
          this.emit('console_relay_data', message);
          break;

        default:
          console.log(`[WebSocketClient] Unknown message type: ${messageType}`);
      }
    } catch (error) {
      console.error('[WebSocketClient] Failed to parse message:', error);
    }
  }

  /**
   * Start ping interval for keep-alive
   */
  private startPingInterval(): void {
    this.stopPingInterval();

    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch (error) {
          console.warn('[WebSocketClient] Failed to send ping:', error instanceof Error ? error.message : error);
        }
      }
    }, WebSocketClient.PING_INTERVAL_MS);
  }

  /**
   * Stop ping interval
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Get tier-agent version
   */
  private getVersion(): string {
    try {
      const packagePath = path.join(__dirname, '../../package.json');
      if (fs.existsSync(packagePath)) {
        const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8')) as { version?: string };
        return pkg.version || '0.0.0';
      }
    } catch {
      // Silently fall back to default version if package.json is unavailable
    }
    return '0.0.0';
  }

  /**
   * Check if running in a container
   */
  private isInContainer(): boolean {
    try {
      // Check for Docker
      if (fs.existsSync('/.dockerenv')) return true;
      // Check for cgroup
      if (fs.existsSync('/proc/1/cgroup')) {
        const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf-8');
        if (cgroup.includes('docker') || cgroup.includes('kubepods')) {
          return true;
        }
      }
    } catch {
      // Container detection failed - assume not in container
    }
    return false;
  }

  /**
   * Get approximate CPU usage
   */
  private getCpuUsage(): number {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    }

    // Return approximate usage (1 - idle percentage)
    return Math.round((1 - totalIdle / totalTick) * 100);
  }

  /**
   * Get memory usage percentage
   */
  private getMemoryUsage(): number {
    const total = os.totalmem();
    const free = os.freemem();
    return Math.round(((total - free) / total) * 100);
  }
}
