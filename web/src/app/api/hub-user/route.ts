import { NextRequest, NextResponse } from 'next/server';

/**
 * Server-side proxy for hub user info.
 *
 * The assistant app runs on langmart.ai via proxy,
 * but the auth API is on api.langmart.ai — a different
 * subdomain/origin. Browsers block cross-origin requests (CORS).
 *
 * This API route runs server-side, bypassing CORS restrictions.
 * The client passes the API key via Authorization header,
 * and we forward it to the gateway's /auth/validate endpoint.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader) {
    return NextResponse.json({ error: 'No authorization header' }, { status: 401 });
  }

  // Gateway Type 1 runs on the same machine
  const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:8081';

  try {
    const res = await fetch(`${gatewayUrl}/auth/validate`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    if (!res.ok) {
      return NextResponse.json({ error: 'Auth validation failed' }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[hub-user] Failed to validate:', err);
    return NextResponse.json({ error: 'Failed to validate' }, { status: 500 });
  }
}
