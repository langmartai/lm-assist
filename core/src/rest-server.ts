/**
 * REST Server (lm-assist)
 *
 * Exposes the control API over HTTP.
 */

import * as http from 'http';
import { startApiTokenRotation, isValidToken, apiAuthEnabled, isLocalAddress } from './auth/api-token';
import { validateScopedRequest } from './auth/scoped-token';
import { isEnrollExempt } from './auth/enroll-exempt';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { homedir } from 'os';
import * as chokidar from 'chokidar';
import { TierControlApiImpl, createControlApi } from './control-api';
import { TierManager } from './tier-manager';
import type { TierEvent } from './types/control-api';
import { handleTtydProxyRequest, handleTtydProxyUpgrade, isTtydProxyPath } from './ttyd-proxy';
import { isTcpUpgrade, handleTcpUpgrade } from './transport/tcp-upgrade';
import { isPortfwdUpgrade, handlePortfwdUpgrade } from './transport/portfwd-upgrade';
import { isVoiceSttUpgrade, handleVoiceSttUpgrade } from './voice/voice-relay';
import { getStartupProfiler } from './startup-profiler';

// Modular Routes
import {
  createAllRoutes,
  createRouteContext,
  type RouteHandler,
  type ParsedRequest,
  type RouteContext,
} from './routes';
import type { BusEvent } from './bus/types';

/** Map a bus event to a /stream-safe payload (broadcast as a generic TierEvent). */
export function busEventToSse(e: BusEvent): { type: 'bus_event'; timestamp: Date; tier: 'system'; data: { topic: string; origin: string; seq: number; eventType: string; at: number; id: string } } {
  return {
    type: 'bus_event', timestamp: new Date(), tier: 'system',
    data: { topic: e.topic, origin: e.origin, seq: e.seq, eventType: e.type, at: e.at, id: `${e.origin}:${e.seq}` },
  };
}

// ============================================================================
// Types
// ============================================================================

interface ServerOptions {
  port?: number;
  host?: string;
  projectPath: string;
  tierManager?: TierManager;
  cors?: boolean;
  apiKey?: string;
}


// ============================================================================
// Server Implementation
// ============================================================================

export class TierRestServer {
  private server: http.Server | null = null;
  private api: TierControlApiImpl;
  private options: Required<ServerOptions>;
  // SSE clients with optional filter by executionId
  private sseClients: Map<http.ServerResponse, { executionId?: string; lastEventId?: number }> = new Map();
  // SSE clients for Claude Tasks real-time updates
  private claudeTasksSSEClients: Set<http.ServerResponse> = new Set();
  // File watcher for Claude Tasks directory
  private claudeTasksWatcher: ReturnType<typeof chokidar.watch> | null = null;
  // Modular route context and routes
  private routeContext: RouteContext | null = null;
  private modularRoutes: RouteHandler[] = [];

  constructor(options: ServerOptions) {
    const profiler = getStartupProfiler();
    profiler.start('constructor', 'Server Constructor');

    this.options = {
      port: options.port || (__dirname.includes('node_modules') ? 3100 : 3200),
      host: options.host || process.env.LM_ASSIST_API_HOST || '127.0.0.1',
      projectPath: options.projectPath,
      tierManager: options.tierManager || undefined as any,
      cors: options.cors ?? true,
      apiKey: options.apiKey || '',
    };

    // Create or use provided tier manager
    profiler.start('tierManager', 'TierManager', 'Server Constructor');
    const tierManager = this.options.tierManager || new TierManager({
      projectPath: this.options.projectPath,
    });
    this.options.tierManager = tierManager;
    profiler.end('tierManager');

    profiler.start('controlApi', 'ControlApi', 'Server Constructor');
    this.api = createControlApi(this.options.projectPath, tierManager);
    profiler.end('controlApi');

    // Subscribe to events for SSE
    this.api.subscribe((event) => this.broadcastEvent(event));

    // Initialize modular routes
    profiler.start('routes', 'Routes', 'Server Constructor');
    this.routeContext = createRouteContext(
      this.api,
      tierManager,
      this.options.projectPath
    );
    this.modularRoutes = createAllRoutes(this.routeContext);
    profiler.end('routes');
    console.log(`Loaded ${this.modularRoutes.length} modular routes`);

    // Initialize Claude Tasks file watcher
    profiler.start('tasksWatcher', 'Tasks Watcher', 'Server Constructor');
    this.initClaudeTasksWatcher();
    profiler.end('tasksWatcher');

    // Wire session cache events
    profiler.start('sessionEvents', 'Session Events', 'Server Constructor');
    this.initSessionCacheEvents();
    profiler.end('sessionEvents');

    // Initialize memory cache singleton — auto-starts the chokidar watcher
    // and wires file-change events into the SSE broadcast.
    profiler.start('memoryCache', 'MemoryCache', 'Server Constructor');
    this.initMemoryCacheEvents();
    profiler.end('memoryCache');

    profiler.start('busEvents', 'BusEvents', 'Server Constructor');
    this.initBusEvents();
    profiler.end('busEvents');

    profiler.end('constructor');
  }

  /**
   * Wire memory cache file events to SSE broadcast.
   */
  private initMemoryCacheEvents(): void {
    try {
      const { getMemoryCache } = require('./memory-cache');
      const memCache = getMemoryCache();
      memCache.onMemoryChange((dirPath: string, data: any) => {
        // Broadcast as a generic TierEvent-shaped payload — clients that
        // subscribe to /stream without an executionId filter will receive it.
        try {
          this.broadcastEvent({
            type: 'memory_file_changed',
            timestamp: new Date(),
            tier: 'system',
            data: {
              dirPath,
              source: data.source,
              fileCount: data.files.length,
              maxMtimeMs: data.maxMtimeMs,
            },
          } as any);
        } catch {
          /* swallow */
        }
      });

      // Start the cross-node memory autosync daemon (Stream A). It hooks the
      // SAME memory-cache watcher (no second chokidar) and the hub receive
      // channel. OBSERVE-ONLY by default (MEMORY_AUTOSYNC=observe) — it only
      // detects + logs a sync PLAN; no git mutation unless MEMORY_AUTOSYNC=on.
      try {
        const { getAutoSyncDaemon } = require('./memory/autosync');
        const daemon = getAutoSyncDaemon();
        daemon.start();
        console.log(`[Server] Memory autosync daemon: mode=${daemon.getMode()}`);
      } catch (e) {
        console.warn('[Server] Memory autosync daemon init failed:', e);
      }

      // Start the cross-node RULE autosync daemon (own chokidar v3 watch of ~/.claude/rules/*.md;
      // pull-based fleet-wide reconcile). On by default (ruleSyncEnabled; env RULE_AUTOSYNC overrides).
      try {
        const { getRuleAutoSyncDaemon } = require('./rules/autosync');
        const rd = getRuleAutoSyncDaemon();
        rd.start();
        console.log(`[Server] Rule autosync daemon: mode=${rd.getMode()}`);
      } catch (e) {
        console.warn('[Server] Rule autosync daemon init failed:', e);
      }

      // Eager-warm the session-footprint cache ~3s after boot so the FIRST cross-fleet survey
      // (and any peer's proxyGet of /fleet/session-footprints/local) returns populated data
      // instead of a one-shot `warming` snapshot. Deferred + best-effort (lazy warm still applies).
      try {
        const warmFp = setTimeout(() => {
          try { require('./fleet/session-footprint-collector').getLocalSnapshot(); } catch { /* deps not ready — lazy warm covers it */ }
        }, 3000);
        if (warmFp.unref) warmFp.unref();
      } catch { /* ignore */ }

      // Cross-project memory signposts: write the managed _cross-project.md (+ a MEMORY.md pointer)
      // into every project on start, and refresh when the project set changes. Default ON; per-node
      // local (never cross-node synced). Lets an LLM recalling memory know to use the langmart MCP
      // for other projects' memory.
      try {
        require('./memory/cross-project-signpost').startCrossProjectSignpost();
        console.log('[Server] Cross-project memory signpost: started');
      } catch (e) {
        console.warn('[Server] Cross-project signpost init failed:', e);
      }

      // Start the periodic memory harvest daemon (Stream A feeder). Default OFF
      // (MEMORY_HARVEST_DAEMON != on). When off: logs disabled and returns
      // immediately -- no timers, no Opus agents spawned.
      try {
        const { getHarvestDaemon } = require('./memory/harvest-daemon');
        const hd = getHarvestDaemon();
        hd.start();
        console.log('[Server] Memory harvest daemon: enabled=' + hd.getStatus().enabled);
      } catch (e) {
        console.warn('[Server] Memory harvest daemon init failed:', e);
      }
    } catch (err) {
      console.warn('[Server] MemoryCache init failed:', err);
    }
  }

  /** Bridge bus events to the SSE /stream (mirrors initMemoryCacheEvents). */
  private initBusEvents(): void {
    try {
      const { getBus } = require('./bus') as typeof import('./bus');
      getBus().onLocalEvent((e) => {
        try { this.broadcastEvent(busEventToSse(e) as any); } catch { /* swallow */ }
      });
    } catch { /* bus disabled / not ready */ }
  }

  /**
   * Wire session cache file events to invalidate caches.
   */
  private initSessionCacheEvents(): void {
    try {
      const { getSessionCache } = require('./session-cache');
      const cache = getSessionCache();

      // Invalidate tasks session-info cache when session files are added/deleted
      // (a new session file could resolve a previously-null lookup)
      cache.onFileEvent((event: string) => {
        if (event === 'add' || event === 'unlink') {
          try {
            const { getTasksService } = require('./tasks-service');
            // Only clear session info lookups; don't flush the full task list cache
            // since task file changes have their own watcher
            getTasksService().invalidateSessionInfoCache();
          } catch { /* ignore */ }
        }
      });

      console.log('Session cache events wired');
    } catch (err) {
      console.warn('TierRestServer: Failed to initialize session cache events:', err);
    }
  }

  private initClaudeTasksWatcher(): void {
    const tasksDir = path.join(homedir(), '.claude', 'tasks');

    if (!fs.existsSync(tasksDir)) {
      fs.mkdirSync(tasksDir, { recursive: true });
    }

    this.claudeTasksWatcher = chokidar.watch(tasksDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 2,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.claudeTasksWatcher
      .on('add', (filePath: string) => this.handleClaudeTaskFileChange('add', filePath))
      .on('change', (filePath: string) => this.handleClaudeTaskFileChange('change', filePath))
      .on('unlink', (filePath: string) => this.handleClaudeTaskFileChange('unlink', filePath))
      .on('addDir', (dirPath: string) => this.handleClaudeTaskDirChange('addDir', dirPath))
      .on('unlinkDir', (dirPath: string) => this.handleClaudeTaskDirChange('unlinkDir', dirPath))
      .on('error', (error: unknown) => console.error('Claude Tasks watcher error:', error));

    console.log(`Claude Tasks watcher initialized for ${tasksDir}`);
  }

  private handleClaudeTaskFileChange(event: 'add' | 'change' | 'unlink', filePath: string): void {
    if (!filePath.endsWith('.json')) return;

    // Invalidate tasks service cache on any task file change
    try {
      const { getTasksService } = require('./tasks-service');
      getTasksService().invalidateCache();
    } catch { /* ignore */ }

    const tasksDir = path.join(homedir(), '.claude', 'tasks');
    const relativePath = path.relative(tasksDir, filePath);
    const parts = relativePath.split(path.sep);

    if (parts.length !== 2) return;

    const listId = parts[0];
    const taskId = parts[1].replace('.json', '');

    let task: any = null;
    if (event !== 'unlink') {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        task = JSON.parse(content);
      } catch {
        // Ignore parse errors
      }
    }

    const eventType = event === 'add' ? 'task_created' : event === 'change' ? 'task_updated' : 'task_deleted';

    this.broadcastClaudeTasksEvent({
      type: eventType,
      listId,
      taskId,
      task,
      timestamp: new Date().toISOString(),
    });
  }

  private handleClaudeTaskDirChange(event: 'addDir' | 'unlinkDir', dirPath: string): void {
    // Invalidate tasks service cache on list add/remove
    try {
      const { getTasksService } = require('./tasks-service');
      getTasksService().invalidateCache();
    } catch { /* ignore */ }

    const tasksDir = path.join(homedir(), '.claude', 'tasks');
    const relativePath = path.relative(tasksDir, dirPath);

    if (!relativePath || relativePath.includes(path.sep)) return;

    const listId = relativePath;
    const eventType = event === 'addDir' ? 'list_created' : 'list_deleted';

    this.broadcastClaudeTasksEvent({
      type: eventType,
      listId,
      timestamp: new Date().toISOString(),
    });
  }

  private broadcastClaudeTasksEvent(event: {
    type: 'task_created' | 'task_updated' | 'task_deleted' | 'list_created' | 'list_deleted' | 'connected';
    listId?: string;
    taskId?: string;
    task?: any;
    timestamp: string;
  }): void {
    const data = JSON.stringify(event);

    for (const client of this.claudeTasksSSEClients) {
      try {
        client.write(`event: ${event.type}\n`);
        client.write(`data: ${data}\n\n`);
      } catch {
        this.claudeTasksSSEClients.delete(client);
      }
    }
  }

  private handleClaudeTasksSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const connectedEvent = JSON.stringify({
      type: 'connected',
      timestamp: new Date().toISOString(),
    });
    res.write(`event: connected\ndata: ${connectedEvent}\n\n`);

    this.claudeTasksSSEClients.add(res);

    req.on('close', () => {
      this.claudeTasksSSEClients.delete(res);
    });

    const pingInterval = setInterval(() => {
      try {
        res.write(`:ping\n\n`);
      } catch {
        clearInterval(pingInterval);
        this.claudeTasksSSEClients.delete(res);
      }
    }, 30000);

    req.on('close', () => {
      clearInterval(pingInterval);
    });
  }

  /**
   * Start the server
   */
  start(): Promise<void> {
    const profiler = getStartupProfiler();
    profiler.start('httpListen', 'HTTP Listen');
    startApiTokenRotation();
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      // Handle upgrades: ttyd WebSocket proxy, or the lm-tcp file-transfer path
      // (direct-TCP-for-LAN rides the Core port via an HTTP Upgrade — no
      // dedicated listener port to open).
      this.server.on('upgrade', (req, socket, head) => {
        if (req.url && isTtydProxyPath(req.url)) {
          handleTtydProxyUpgrade(req, socket, head);
        } else if (isTcpUpgrade(req)) {
          handleTcpUpgrade(req, socket, head);
        } else if (isPortfwdUpgrade(req)) {
          handlePortfwdUpgrade(req, socket, head);
        } else if (isVoiceSttUpgrade(req)) {
          handleVoiceSttUpgrade(req, socket, head, this.options.apiKey);
        } else {
          socket.destroy();
        }
      });

      this.server.on('error', reject);

      this.server.listen(this.options.port, this.options.host, () => {
        profiler.end('httpListen');
        console.log(`lm-assist API server listening on http://${this.options.host}:${this.options.port}`);
        try { require('./monitor/build-history').recordBuild(); } catch (e) { console.error('[Server] build-history record failed:', (e as any)?.message); }
        resolve();
      });
    });
  }

  /**
   * Stop the server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const [client] of this.sseClients) {
        client.end();
      }
      this.sseClients.clear();

      for (const client of this.claudeTasksSSEClients) {
        client.end();
      }
      this.claudeTasksSSEClients.clear();

      if (this.claudeTasksWatcher) {
        this.claudeTasksWatcher.close();
        this.claudeTasksWatcher = null;
      }

      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the API instance
   */
  getApi(): TierControlApiImpl {
    return this.api;
  }

  // --------------------------------------------------------------------------
  // Request Handling
  // --------------------------------------------------------------------------

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS headers
    if (this.options.cors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    }

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Handle ttyd proxy requests (bypasses authentication)
    if (req.url && isTtydProxyPath(req.url)) {
      if (handleTtydProxyRequest(req, res)) {
        return;
      }
    }

    // API token authentication (rotating ring; /health open for liveness).
    // Emergency kill-switch: LM_ASSIST_API_AUTH=0
    {
      const authPath = (req.url || '').split('?')[0];
      // Optional: trust requests from this machine itself (the local desk) so a
      // local browser whose web build can't attach the token still works.
      // LAN/remote callers still need the token. Off unless LM_ASSIST_API_AUTH_EXEMPT_LOCAL=1.
      const exemptLocal = process.env.LM_ASSIST_API_AUTH_EXEMPT_LOCAL === '1'
        && isLocalAddress(req.socket.remoteAddress);
      // Node-enrollment routes are tokenless from STRICT loopback only AND only when
      // there is no browser Origin (blocks drive-by CSRF); the keypack is the credential.
      // LAN/remote/browser callers still need the token. See enroll-exempt.ts.
      const enrollExempt = isEnrollExempt(req.method, authPath, req.socket.remoteAddress, req.headers['origin']);
      // The WhatsApp Cloud API webhook is called by Meta's servers, which
      // cannot present the lm-assist token. It carries its own auth: a verify
      // token on the GET handshake and an HMAC-SHA256 body signature on POST
      // (see core/src/whatsapp/webhook.ts), enforced inside the route handler.
      const whatsappWebhookExempt = authPath === '/whatsapp/webhook';
      if (apiAuthEnabled() && authPath !== '/health' && !exemptLocal && !enrollExempt && !whatsappWebhookExempt) {
        const rawKey = req.headers['x-api-key'];
        const providedKey = (Array.isArray(rawKey) ? rawKey[0] : rawKey) || this.getQueryParam(req.url || '', 'apiKey');
        // Full ring token first; then the narrow scoped-token fallback (browser
        // chat clients — only the scope's route allow-list, see auth/scoped-token.ts).
        const okAuth = isValidToken(providedKey) || (this.options.apiKey && providedKey === this.options.apiKey)
          || validateScopedRequest(providedKey, req.method || 'GET', authPath);
        if (!okAuth) {
          this.sendJson(res, 401, { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API token' } });
          return;
        }
      }
    }

    // Handle SSE endpoint
    if (req.method === 'GET' && req.url?.startsWith('/stream')) {
      this.handleSSE(req, res);
      return;
    }

    // Handle Claude Tasks SSE endpoint
    if (req.method === 'GET' && req.url === '/tasks/events') {
      this.handleClaudeTasksSSE(req, res);
      return;
    }

    // Cowork live SSE — proxy Anthropic's /v1/code/sessions/{cse}/events/stream (OAuth) to the browser.
    // Special-cased (not a normal route) because SSE needs the raw socket, not the buffered ApiResponse.
    {
      const m = req.method === 'GET' && req.url?.match(/^\/cowork\/tasks\/(cse_[^/?]+)\/stream/);
      if (m) {
        void this.handleCoworkStream(req, res, m[1]);
        return;
      }
    }

    // MCP Protocol endpoint (POST/GET/DELETE /mcp).
    // StreamableHTTPServerTransport needs raw req/res to drive both
    // single-response and SSE flows. Match exact `/mcp` (with optional
    // query string) so `/mcp/search` etc. continue through normal dispatch.
    {
      const url = (req.url || '').split('?')[0];
      if (url === '/mcp' && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
        const { handleMcpRequest } = await import('./routes/core/mcp.routes');
        await handleMcpRequest(req, res);
        return;
      }
    }

    // Streaming claude.ai completion (embedded chat clients) — SSE needs the
    // raw socket, so it's special-cased like /mcp and the cowork stream. Auth
    // already ran above (full token or a 'claude-ai-chat' scoped token).
    {
      const url = (req.url || '').split('?')[0];
      const m = req.method === 'POST' && url.match(/^\/claude-ai\/conversations\/(?<uuid>[0-9a-fA-F-]{36})\/completion\/stream$/);
      if (m) {
        const { handleCompletionStream } = await import('./routes/core/claude-ai.routes');
        await handleCompletionStream(req, res, m.groups!.uuid);
        return;
      }
    }

    // Parse request
    const parsed = await this.parseRequest(req);

    // Find matching route
    for (const route of this.modularRoutes) {
      if (route.method !== parsed.method) continue;

      const match = parsed.path.match(route.pattern);
      if (!match) continue;

      parsed.params = match.groups || {};

      try {
        const result = await route.handler(parsed, this.api);
        // A route/error envelope may carry an explicit `httpStatus` (set by
        // handlers that need a status other than the flat 200/400 default —
        // e.g. 502 upstream failures, 401 auth, 404 not-found). Honor it when
        // present; otherwise fall back to the historical success?200:400.
        const status: number = typeof result.httpStatus === 'number'
          ? result.httpStatus
          : (result.success ? 200 : 400);

        if (result.redirect && typeof result.redirect === 'string') {
          res.writeHead(302, { Location: result.redirect });
          res.end();
        } else if (result.binary && result.data instanceof Buffer) {
          const headers: Record<string, string> = {
            'Content-Type': 'application/octet-stream',
            ...result.headers,
          };
          res.writeHead(status, headers);
          res.end(result.data);
        } else if (result._isFile && result._filePath) {
          const filePath = result._filePath as string;
          const contentType = (result._contentType as string) || 'application/octet-stream';
          try {
            const fileContent = fs.readFileSync(filePath);
            res.writeHead(200, {
              'Content-Type': contentType,
              'Content-Length': fileContent.length,
              'Cache-Control': 'public, max-age=86400',
            });
            res.end(fileContent);
          } catch (err) {
            this.sendJson(res, 404, {
              success: false,
              error: { code: 'FILE_NOT_FOUND', message: `File not found: ${filePath}` },
            });
          }
        } else if (result.raw && typeof result.data === 'string') {
          const headers: Record<string, string> = {
            'Content-Type': 'text/plain',
            ...result.headers,
          };
          res.writeHead(status, headers);
          res.end(result.data);
        } else {
          this.sendJson(res, status, result);
        }
      } catch (err) {
        this.sendJson(res, 500, {
          success: false,
          error: { code: 'INTERNAL_ERROR', message: String(err) },
        });
      }
      return;
    }

    // 404
    this.sendJson(res, 404, {
      success: false,
      error: { code: 'NOT_FOUND', message: `Route not found: ${parsed.method} ${parsed.path}` },
    });
  }

  private async parseRequest(req: http.IncomingMessage): Promise<ParsedRequest> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const { body, rawBody } = await this.parseBody(req);

    return {
      method: req.method || 'GET',
      path: url.pathname,
      params: {},
      query: Object.fromEntries(url.searchParams),
      body,
      rawBody,
      headers: req.headers,
      clientIp: req.socket?.remoteAddress || undefined,
    };
  }

  private parseBody(req: http.IncomingMessage): Promise<{ body: any; rawBody: string }> {
    return new Promise((resolve) => {
      // GET has no body. DELETE *can* have one per RFC 7231 §4.3.5 and is
      // commonly used (e.g. cookie/storage filters); parse it like POST/PUT.
      if (req.method === 'GET') {
        resolve({ body: {}, rawBody: '' });
        return;
      }

      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        // Keep the raw bytes alongside the parsed value: HMAC webhook
        // verification (WhatsApp) signs the exact body, which a re-stringify
        // of the parsed object would not reproduce.
        try {
          resolve({ body: body ? JSON.parse(body) : {}, rawBody: body });
        } catch {
          resolve({ body: {}, rawBody: body });
        }
      });
    });
  }

  private sendJson(res: http.ServerResponse, status: number, data: any): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }

  private getQueryParam(url: string, param: string): string | null {
    try {
      const parsed = new URL(url, 'http://localhost');
      return parsed.searchParams.get(param);
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Server-Sent Events (SSE)
  // --------------------------------------------------------------------------

  private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const executionId = url.searchParams.get('executionId') || undefined;
    const lastEventIdStr = url.searchParams.get('lastEventId');
    const lastEventId = lastEventIdStr ? parseInt(lastEventIdStr, 10) : undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    res.write(`event: connected\ndata: {"message":"Connected to event stream"}\n\n`);

    this.sseClients.set(res, { executionId, lastEventId });

    req.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  /**
   * Cowork live-stream proxy — GET /cowork/tasks/:cse/stream.
   *
   * Opens Anthropic's `/v1/code/sessions/{cse}/events/stream` (OAuth,
   * ccr-byoc beta) and pipes the raw SSE bytes straight to the browser.
   * Special-cased outside the modular route table because a route handler
   * returns a buffered `ApiResponse` — incompatible with a live stream.
   */
  private async handleCoworkStream(req: http.IncomingMessage, res: http.ServerResponse, cse: string): Promise<void> {
    try {
      const { ensureFreshAccessToken, getOrganizationUuid } = await import('./utils/claude-oauth');
      const { creds } = await ensureFreshAccessToken();
      const token = creds.accessToken;
      const org = await getOrganizationUuid();
      const lastId = req.headers['last-event-id'];
      const url = `https://api.anthropic.com/v1/code/sessions/${cse}/events/stream`;
      const upstream = await fetch(url, { headers: {
        'authorization': `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'ccr-byoc-2025-07-29',
        'anthropic-client-feature': 'ccr',
        'x-organization-uuid': org,
        'accept': 'text/event-stream',
        ...(lastId ? { 'last-event-id': String(lastId) } : {}),
      } });
      if (!upstream.ok || !upstream.body) { res.writeHead(upstream.status || 502).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      const reader = upstream.body.getReader();
      req.on('close', () => reader.cancel().catch(() => {}));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end();
    }
  }

  private broadcastEvent(event: TierEvent): void {
    const data = JSON.stringify(event);

    for (const [client, filter] of this.sseClients) {
      if (filter.executionId) {
        if ('executionId' in event && event.executionId !== filter.executionId) {
          continue;
        }
      }

      client.write(`event: ${event.type}\ndata: ${data}\n\n`);
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createRestServer(options: ServerOptions): TierRestServer {
  return new TierRestServer(options);
}

/**
 * Quick start server with defaults
 */
export async function startServer(projectPath: string, port = (__dirname.includes('node_modules') ? 3100 : 3200), host?: string): Promise<TierRestServer> {
  const server = new TierRestServer({ projectPath, port, host });
  await server.start();
  return server;
}
