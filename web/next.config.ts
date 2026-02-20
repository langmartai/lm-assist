import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: true },
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../'),
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
    const coreApiUrl = `http://localhost:${process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100'}`;

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
