/**
 * REST Server (lm-assist)
 *
 * Exposes the control API over HTTP.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { homedir } from 'os';
import * as chokidar from 'chokidar';
import { TierControlApiImpl, createControlApi } from './control-api';
import { TierManager } from './tier-manager';
import type { TierEvent } from './types/control-api';
import { handleTtydProxyRequest, handleTtydProxyUpgrade, isTtydProxyPath } from './ttyd-proxy';
import { getStartupProfiler } from './startup-profiler';

// Modular Routes
import {
  createAllRoutes,
  createRouteContext,
  type RouteHandler,
  type ParsedRequest,
  type RouteContext,
} from './routes';

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
      port: options.port || 3100,
      host: options.host || '::',
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

    // Wire session cache onChange to milestone auto-extraction
    profiler.start('milestones', 'Milestone Wiring', 'Server Constructor');
    this.initMilestoneAutoExtraction();
    profiler.end('milestones');

    profiler.end('constructor');
  }

  /**
   * Wire session cache onChange to auto-extract milestones when sessions grow.
   */
  private initMilestoneAutoExtraction(): void {
    try {
      const { getSessionCache } = require('./session-cache');
      const { handleSessionChangeForMilestones } = require('./milestone/store');
      const { getMilestoneSettings } = require('./milestone/settings');
      const cache = getSessionCache();

      cache.onSessionChange((sessionId: string, cacheData: any) => {
        handleSessionChangeForMilestones(sessionId, cacheData, '[RestServer]');
      });

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

      // Only run the staleness scan if milestone processing is enabled
      const settings = getMilestoneSettings();
      if (settings.enabled) {
        setImmediate(() => {
          this.scanStaleMilestones(cache, handleSessionChangeForMilestones);
        });
      } else {
        console.log('Milestone auto-extraction disabled — skipping staleness scan');
      }

      console.log('Milestone auto-extraction wired to session cache');
    } catch (err) {
      console.warn('TierRestServer: Failed to initialize milestone auto-extraction:', err);
    }
  }

  private scanStaleMilestones(
    cache: any,
    handler: (sessionId: string, cacheData: any, prefix: string) => void
  ): void {
    try {
      const { getMilestoneStore } = require('./milestone/store');
      const store = getMilestoneStore();

      const staleSessions: Array<{ sessionId: string; cacheData: any }> = [];
      let total = 0;
      for (const { sessionId, cacheData } of cache.getAllSessionsFromCache()) {
        total++;
        if (store.needsReExtraction(sessionId, cacheData.numTurns)) {
          staleSessions.push({ sessionId, cacheData });
        }
      }

      if (staleSessions.length === 0) return;

      let processed = 0;
      const BATCH_SIZE = 5;

      const processBatch = () => {
        const end = Math.min(processed + BATCH_SIZE, staleSessions.length);
        for (let i = processed; i < end; i++) {
          const { sessionId, cacheData } = staleSessions[i];
          handler(sessionId, cacheData, '[PostWarming]');
        }
        processed = end;

        if (processed < staleSessions.length) {
          setImmediate(processBatch);
        } else {
          console.log(`[PostWarming] Milestone staleness scan: ${staleSessions.length} stale of ${total} sessions re-extracted`);
        }
      };

      processBatch();
    } catch (err) {
      console.warn('[PostWarming] Milestone staleness scan failed:', err);
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
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      // Handle WebSocket upgrades for ttyd proxy
      this.server.on('upgrade', (req, socket, head) => {
        if (req.url && isTtydProxyPath(req.url)) {
          handleTtydProxyUpgrade(req, socket, head);
        } else {
          socket.destroy();
        }
      });

      this.server.on('error', reject);

      this.server.listen(this.options.port, this.options.host, () => {
        profiler.end('httpListen');
        console.log(`lm-assist API server listening on http://${this.options.host}:${this.options.port}`);
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

    // API key authentication
    if (this.options.apiKey) {
      const providedKey = req.headers['x-api-key'] || this.getQueryParam(req.url || '', 'apiKey');
      if (providedKey !== this.options.apiKey) {
        this.sendJson(res, 401, { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
        return;
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

        if (result.redirect && typeof result.redirect === 'string') {
          res.writeHead(302, { Location: result.redirect });
          res.end();
        } else if (result.binary && result.data instanceof Buffer) {
          const headers: Record<string, string> = {
            'Content-Type': 'application/octet-stream',
            ...result.headers,
          };
          res.writeHead(result.success ? 200 : 400, headers);
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
          res.writeHead(result.success ? 200 : 400, headers);
          res.end(result.data);
        } else {
          this.sendJson(res, result.success ? 200 : 400, result);
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

    return {
      method: req.method || 'GET',
      path: url.pathname,
      params: {},
      query: Object.fromEntries(url.searchParams),
      body: await this.parseBody(req),
    };
  }

  private parseBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      if (req.method === 'GET' || req.method === 'DELETE') {
        resolve({});
        return;
      }

      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          resolve({});
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
export async function startServer(projectPath: string, port = 3100): Promise<TierRestServer> {
  const server = new TierRestServer({ projectPath, port });
  await server.start();
  return server;
}
