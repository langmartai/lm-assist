import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  async redirects() {
    return [
      { source: '/', destination: '/terminals', permanent: false },
      { source: '/dashboard', destination: '/terminals', permanent: false },
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
    return [
      {
        source: '/api/tier-agent/:path*',
        destination: `${gatewayUrl}/api/tier-agent/:path*`,
      },
    ];
  },
};

export default nextConfig;
