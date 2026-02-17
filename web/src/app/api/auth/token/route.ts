import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import path from 'path';

const CONFIG_FILE = 'assist-config.json';

interface AssistConfig {
  lanEnabled?: boolean;
  lanAuthEnabled?: boolean;
  lanAccessToken?: string;
}

function readConfig(): AssistConfig {
  try {
    const raw = readFileSync(path.join(process.cwd(), CONFIG_FILE), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * GET /api/auth/token — Return the LAN access token for URL building
 *
 * Only serves the token when the request comes from localhost or a proxied context.
 * LAN requests (non-localhost) get 403.
 */
export async function GET(request: NextRequest) {
  const host = request.headers.get('host') || '';
  const hostname = host.split(':')[0];

  // Only allow from localhost/127.0.0.1 or hub relay (server-side header, can't be forged by browser)
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
  const isHubRelay = request.headers.get('x-relay-source') === 'hub';

  if (!isLocalhost && !isHubRelay) {
    return NextResponse.json(
      { error: 'Forbidden' },
      { status: 403 },
    );
  }

  const config = readConfig();

  return NextResponse.json({
    lanAuthEnabled: config.lanAuthEnabled ?? false,
    lanAccessToken: config.lanAuthEnabled ? (config.lanAccessToken || null) : null,
  });
}
