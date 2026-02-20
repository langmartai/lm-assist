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

    // Core API port for proxying API calls when served from web UI.
    // When accessed via web proxy (langmart.ai/w/:machineId/assist/...),
    // API calls like /knowledge arrive on port 3848 (web UI) and need
    // to be forwarded to port 3100 (core API). The Content-Type header
    // condition ensures only JSON API calls are proxied, not page navigations.
    // Must be in beforeFiles so they run before Next.js page route matching.
    const coreApiUrl = `http://localhost:${process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100'}`;
    const coreApiPrefixes = [
      '/knowledge',
      '/milestones',
      '/milestone-pipeline',
      '/architecture',
      '/assist-resources',
    ];
    const coreApiRewrites = coreApiPrefixes.flatMap(prefix => [
      {
        source: `${prefix}/:path*`,
        has: [{ type: 'header' as const, key: 'content-type', value: '.*application/json.*' }],
        destination: `${coreApiUrl}${prefix}/:path*`,
      },
      {
        source: prefix,
        has: [{ type: 'header' as const, key: 'content-type', value: '.*application/json.*' }],
        destination: `${coreApiUrl}${prefix}`,
      },
    ]);

    return {
      beforeFiles: [
        ...coreApiRewrites,
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
