/**
 * API Relay Handler
 *
 * Handles api_relay requests from the Hub by calling local services
 * and returning the response back through the WebSocket connection.
 *
 * Supports multi-service routing: different path prefixes route to
 * different local ports (e.g., /admin -> :3000, /assist -> :3848,
 * /vibe -> :5173, default -> :3100).
 */

import * as http from 'http';
import * as path from 'path';
import { WebSocketClient } from './websocket-client';

/** Service route configuration for multi-service routing */
export interface ServiceRoute {
  /** Path prefix to match (e.g., '/admin', '/assist', '/vibe') */
  pathPrefix: string;
  /** Local port to route to */
  port: number;
  /** Whether to strip the prefix when forwarding (default: true) */
  stripPrefix: boolean;
  /** Human-readable description for logging */
  description: string;
}

export interface ApiRelayHandlerOptions {
  /** Local API port (default route) */
  localApiPort: number;
  /** WebSocket client for sending responses */
  wsClient: WebSocketClient;
  /** Service routes for multi-service routing */
  serviceRoutes?: ServiceRoute[];
}

export interface ApiRelayRequest {
  type: 'api_relay';
  requestId: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ApiRelayResponse {
  type: 'api_relay_response';
  requestId: string;
  status: number;
  data?: unknown;
  error?: string;
  headers?: Record<string, string>;
  encoding?: string;
}

export class ApiRelayHandler {
  private options: ApiRelayHandlerOptions;
  private serviceRoutes: ServiceRoute[];
  private pendingRequests: Map<string, NodeJS.Timeout> = new Map();

  // Maximum request body size (1MB)
  private static readonly MAX_BODY_SIZE = 1_000_000;

  // Web asset extensions that are always allowed (for proxied web apps)
  private static readonly WEB_ASSET_EXTENSIONS = new Set([
    '.html', '.css', '.js', '.mjs', '.jsx', '.ts', '.tsx',
    '.json', '.map', '.txt',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp4', '.webm', '.ogg', '.mp3', '.wav',
    '.pdf', '.xml', '.wasm',
  ]);

  constructor(options: ApiRelayHandlerOptions) {
    this.options = options;
    this.serviceRoutes = options.serviceRoutes || [];

    // Log configured service routes
    if (this.serviceRoutes.length > 0) {
      console.log(`[ApiRelayHandler] Service routes configured:`);
      for (const route of this.serviceRoutes) {
        console.log(`  ${route.pathPrefix}/* -> localhost:${route.port} [${route.description}]`);
      }
    }
    console.log(`  /* (default) -> localhost:${options.localApiPort} [Tier-Agent API]`);
  }

  // Allowed HTTP methods for relay
  private static readonly ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

  // Allowed API path prefixes for the default (tier-agent API) route
  private static readonly ALLOWED_API_PREFIXES = [
    '/sessions',
    '/projects',
    '/tasks',
    '/task-store',
    '/ttyd',
    '/ttyd-proxy',
    '/health',
    '/status',
    '/executions',
    '/vibe-coder',
    '/export',
    '/share',
    '/stream',
    '/specs',
    '/snapshots',
    '/deploy',
    '/protocol',
    '/jobs',
    '/preflight',
    '/knowledge',
    '/assist-resources',
    '/milestones',
    '/milestone-pipeline',
    '/architecture',
    '/session-index',
    '/session-search',
  ];

  /**
   * Resolve which service route matches the given path.
   * Returns the matching route and the rewritten path, or null if no service route matches.
   */
  private resolveServiceRoute(requestPath: string): { route: ServiceRoute; resolvedPath: string } | null {
    const normalizedPath = requestPath.split('?')[0]; // Remove query string

    // Match against service routes (longest prefix first - sorted by length desc)
    const sorted = [...this.serviceRoutes].sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);

    for (const route of sorted) {
      if (normalizedPath === route.pathPrefix || normalizedPath.startsWith(route.pathPrefix + '/')) {
        let resolvedPath = requestPath;
        if (route.stripPrefix) {
          // Strip the prefix, keep the rest (including query string)
          resolvedPath = requestPath.substring(route.pathPrefix.length) || '/';
        }
        return { route, resolvedPath };
      }
    }

    return null;
  }

  /**
   * Check if a path has a web asset extension
   */
  private isWebAsset(requestPath: string): boolean {
    const normalizedPath = requestPath.split('?')[0]; // Remove query string
    const ext = path.extname(normalizedPath).toLowerCase();
    return ApiRelayHandler.WEB_ASSET_EXTENSIONS.has(ext);
  }

  /**
   * Validate the API relay request
   */
  private validateRequest(request: ApiRelayRequest): string | null {
    const { requestId, method, path: reqPath } = request;

    // Validate requestId
    if (!requestId || typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 100) {
      return 'Invalid or missing requestId';
    }

    // Validate method
    if (!method || !ApiRelayHandler.ALLOWED_METHODS.has(method.toUpperCase())) {
      return `Invalid HTTP method: ${method}`;
    }

    // Validate path exists and starts with /
    if (!reqPath || typeof reqPath !== 'string' || !reqPath.startsWith('/')) {
      return `Invalid path: ${reqPath}`;
    }

    // Check for path traversal attempts
    if (reqPath.includes('..') || reqPath.includes('//')) {
      return `Invalid path: path traversal detected`;
    }

    const normalizedPath = reqPath.split('?')[0]; // Remove query string for validation

    // 1. Check if path matches a configured service route (always allowed)
    const serviceMatch = this.resolveServiceRoute(reqPath);
    if (serviceMatch) {
      // Service routes are always allowed
      return this.validateBody(request);
    }

    // 2. Check if path matches an API prefix (for default tier-agent API route)
    const isApiAllowed = ApiRelayHandler.ALLOWED_API_PREFIXES.some(prefix =>
      normalizedPath === prefix || normalizedPath.startsWith(prefix + '/')
    );
    if (isApiAllowed) {
      return this.validateBody(request);
    }

    // 3. Check if it's a web asset (static files for proxied web apps)
    if (this.isWebAsset(reqPath)) {
      return this.validateBody(request);
    }

    // 4. Allow root path
    if (normalizedPath === '/') {
      return this.validateBody(request);
    }

    return `Path not allowed: ${reqPath}`;
  }

  /**
   * Validate request body size
   */
  private validateBody(request: ApiRelayRequest): string | null {
    if (request.body !== undefined && request.body !== null) {
      try {
        const bodySize = JSON.stringify(request.body).length;
        if (bodySize > ApiRelayHandler.MAX_BODY_SIZE) {
          return `Request body too large: ${bodySize} bytes (max: ${ApiRelayHandler.MAX_BODY_SIZE})`;
        }
      } catch {
        return 'Invalid request body: cannot serialize';
      }
    }
    return null; // Valid
  }

  /**
   * Determine content encoding based on content-type header
   */
  private getContentEncoding(contentType: string | undefined): 'base64' | 'utf8' | 'json' {
    if (!contentType) return 'utf8';

    const ct = contentType.toLowerCase();

    // Binary types -> base64
    if (ct.startsWith('image/') || ct.startsWith('font/') ||
        ct.startsWith('audio/') || ct.startsWith('video/') ||
        ct.includes('application/octet-stream') ||
        ct.includes('application/wasm') ||
        ct.includes('application/pdf') ||
        ct.includes('application/zip')) {
      return 'base64';
    }

    // JSON types
    if (ct.includes('application/json')) {
      return 'json';
    }

    // Everything else is text (html, css, js, plain text, xml, etc.)
    return 'utf8';
  }

  /**
   * Handle an API relay request from the Hub
   */
  async handleRequest(request: ApiRelayRequest): Promise<void> {
    const { requestId, method, path: reqPath, query, body, headers } = request;

    // Validate the request
    const validationError = this.validateRequest(request);
    if (validationError) {
      console.warn(`[ApiRelayHandler] Validation failed: ${validationError}`);
      this.sendResponse({
        type: 'api_relay_response',
        requestId,
        status: 400,
        error: validationError,
      });
      return;
    }

    // Resolve the target service
    const serviceMatch = this.resolveServiceRoute(reqPath);
    const targetPort = serviceMatch ? serviceMatch.route.port : this.options.localApiPort;
    const targetPath = serviceMatch ? serviceMatch.resolvedPath : reqPath;
    const serviceDesc = serviceMatch ? serviceMatch.route.description : 'Tier-Agent API';

    console.log(`[ApiRelayHandler] Relaying ${method} ${reqPath} -> localhost:${targetPort}${targetPath} [${serviceDesc}] (requestId: ${requestId})`);

    // Track if we've already responded (to prevent race condition with timeout)
    let hasResponded = false;

    // Set timeout for the request
    const timeout = setTimeout(() => {
      if (hasResponded) return; // Already responded, don't send duplicate
      hasResponded = true;

      console.warn(`[ApiRelayHandler] Request timeout: ${requestId}`);
      this.sendResponse({
        type: 'api_relay_response',
        requestId,
        status: 504,
        error: 'Gateway timeout - local API did not respond',
      });
      this.pendingRequests.delete(requestId);
    }, 30000); // 30 second timeout

    this.pendingRequests.set(requestId, timeout);

    try {
      // Build URL with query parameters
      let url = targetPath;
      if (query && Object.keys(query).length > 0) {
        const params = new URLSearchParams(query);
        // If targetPath already has query string, append; otherwise add
        url = targetPath.includes('?')
          ? `${targetPath}&${params.toString()}`
          : `${targetPath}?${params.toString()}`;
      }

      // Make request to local service
      const response = await this.makeLocalRequest(method, url, body, headers, targetPort);

      // Check if timeout already fired
      if (hasResponded) {
        console.warn(`[ApiRelayHandler] Response arrived after timeout for ${requestId}`);
        return;
      }
      hasResponded = true;

      // Clear timeout
      clearTimeout(timeout);
      this.pendingRequests.delete(requestId);

      // Send response back to Hub
      this.sendResponse({
        type: 'api_relay_response',
        requestId,
        status: response.status,
        data: response.data,
        headers: response.headers,
        encoding: response.encoding,
      });

    } catch (error) {
      // Check if timeout already fired
      if (hasResponded) {
        console.warn(`[ApiRelayHandler] Error after timeout for ${requestId}`);
        return;
      }
      hasResponded = true;

      // Clear timeout
      clearTimeout(timeout);
      this.pendingRequests.delete(requestId);

      console.error(`[ApiRelayHandler] Error relaying request ${requestId}:`, error);

      this.sendResponse({
        type: 'api_relay_response',
        requestId,
        status: 500,
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }

  /**
   * Make HTTP request to a local service
   */
  private makeLocalRequest(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    port?: number,
  ): Promise<{ status: number; data: unknown; headers: Record<string, string>; encoding?: string }> {
    const targetPort = port || this.options.localApiPort;

    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: targetPort,
        path,
        method: method.toUpperCase(),
        headers: {
          ...headers,
          'x-relay-source': 'hub',
        },
      };

      // Only set Content-Type for requests with body (not for web app GETs where Accept might be text/html)
      const hdrs = options.headers as Record<string, string | string[] | undefined>;
      if (!hdrs['content-type'] && !hdrs['Content-Type']) {
        if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
          hdrs['Content-Type'] = 'application/json';
        }
      }

      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          const rawBuffer = Buffer.concat(chunks);
          const contentType = res.headers['content-type'] || '';
          const encoding = this.getContentEncoding(contentType);

          let parsedData: unknown;

          if (encoding === 'base64') {
            // Binary content - encode as base64
            parsedData = rawBuffer.toString('base64');
          } else if (encoding === 'json') {
            // JSON content - parse it
            const text = rawBuffer.toString('utf-8');
            try {
              parsedData = JSON.parse(text);
            } catch {
              parsedData = text;
            }
          } else {
            // Text content (html, css, js, etc.) - keep as string
            parsedData = rawBuffer.toString('utf-8');
          }

          // Extract response headers
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              responseHeaders[key] = value;
            } else if (Array.isArray(value)) {
              responseHeaders[key] = value.join(', ');
            }
          }

          resolve({
            status: res.statusCode || 500,
            data: parsedData,
            headers: responseHeaders,
            encoding,
          });
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      // Set request timeout
      req.setTimeout(25000, () => {
        req.destroy();
        reject(new Error('Local API request timeout'));
      });

      // Send body for POST/PUT/PATCH requests
      if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  /**
   * Send response back to Hub via WebSocket
   */
  private sendResponse(response: ApiRelayResponse): void {
    this.options.wsClient.send(response);
  }

  /**
   * Cleanup pending requests on disconnect
   */
  cleanup(): void {
    this.pendingRequests.forEach((timeout) => {
      clearTimeout(timeout);
    });
    this.pendingRequests.clear();
  }
}
