import type { NextConfig } from 'next';
import path from 'path';
import fs from 'fs';

/**
 * The workspace root = the nearest ancestor holding a REAL (hoisted) node_modules.
 * In the main checkout that's `web/..` (unchanged behavior). In a git worktree under
 * `.claude/worktrees/<name>/` there is no local install — deps resolve from the main
 * checkout above it — and Turbopack refuses to compile anything outside its root, so
 * the root must be that ancestor, not the worktree.
 */
function workspaceRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    dir = path.dirname(dir);
    const nm = path.join(dir, 'node_modules');
    try { if (fs.lstatSync(nm).isDirectory()) return dir; } catch { /* keep walking */ }
  }
  return path.join(start, '../');
}
const ROOT = workspaceRoot(__dirname);

/**
 * Who may FRAME a dashboard page. The dashboard acts with full Core authority, so a
 * third-party page framing it could lay a decoy over a button (clickjacking) — e.g. the
 * cloud-connect confirm, which rebinds this node to another hub account. Allowed:
 *  - 'self': hybrid mode frames same-origin pages (/api/tier-agent consoles, terminals);
 *  - the LangMart platform origins: hub-proxied pages (/w/<id>/assist/…) are shown in a
 *    platform iframe (TopBar's "Fullscreen" button exists for that case).
 * frame-ancestors ONLY — no default-src/script-src here (the app relies on inline script).
 * X-Frame-Options cannot express an allow-list, so it is not sent.
 */
const FRAME_ANCESTORS =
  "frame-ancestors 'self' https://langmart.ai https://*.langmart.ai https://xeenhub.com https://*.xeenhub.com";

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: '/:path*', headers: [{ key: 'Content-Security-Policy', value: FRAME_ANCESTORS }] },
    ];
  },
  typescript: { ignoreBuildErrors: true },
  output: 'standalone',
  outputFileTracingRoot: ROOT,
  turbopack: { root: ROOT },
  async redirects() {
    return [
      { source: '/', destination: '/sessions', permanent: false },
      { source: '/dashboard', destination: '/session-dashboard', permanent: false },
      { source: '/terminals', destination: '/session-dashboard', permanent: false },
      { source: '/workers', destination: '/machines', permanent: true },
      { source: '/claude-sessions', destination: '/sessions', permanent: true },
      { source: '/claude-sessions/:path*', destination: '/sessions', permanent: true },
      { source: '/claude-projects', destination: '/projects', permanent: true },
      { source: '/claude-tasks', destination: '/tasks', permanent: true },
    ];
  },
  async rewrites() {
    // Gateway Type 1 URL for proxying tier-agent API calls (console, worker endpoints)
    // Needed for hybrid mode: iframe console URLs use /api/tier-agent/... relative paths
    // which must be forwarded to GW1 for token auth + worker relay
    const gatewayUrl = process.env.GATEWAY_TYPE1_URL || 'http://localhost:8081';

    // Core API proxy via /_coreapi prefix.
    // When accessed via web proxy (langmart.ai/w/:machineId/assist/...),
    // API calls use /_coreapi/... paths which get rewritten to the core API
    // on port 3100. This avoids header-based conditions (Content-Type) which
    // don't work through the WebSocket relay chain (headers are lost).
    const coreApiUrl = `http://127.0.0.1:${process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100'}`;

    return {
      beforeFiles: [
        {
          source: '/_coreapi/:path*',
          destination: `${coreApiUrl}/:path*`,
        },
      ],
      afterFiles: [
        {
          source: '/api/tier-agent/:path*',
          destination: `${gatewayUrl}/api/tier-agent/:path*`,
        },
      ],
      fallback: [],
    };
  },
};

export default nextConfig;
