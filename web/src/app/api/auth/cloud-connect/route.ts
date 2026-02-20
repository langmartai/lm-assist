import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/auth/cloud-connect — Callback for OAuth assist-connect flow
 *
 * When the assist-connect popup on langmart.ai loses window.opener (after OAuth redirect),
 * it redirects here with the new API key so the local machine can save it.
 *
 * Query params: ?key=<api-key>&hubUrl=<wss://...>
 *
 * Flow:
 * 1. Receives the new assist API key from the langmart.ai popup redirect
 * 2. Calls PUT /hub/config on the local tier-agent to save the key + reconnect
 * 3. Redirects to /settings with a success indicator
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const key = searchParams.get('key');
  const hubUrl = searchParams.get('hubUrl') || 'wss://api.langmart.ai';

  if (!key) {
    return new NextResponse(errorPage('Missing API key parameter'), {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const apiPort = process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100';
  const tierAgentUrl = `http://localhost:${apiPort}`;

  try {
    const res = await fetch(`${tierAgentUrl}/hub/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key, hubUrl, reconnect: true }),
    });

    const json = await res.json();

    if (!json.success) {
      return new NextResponse(errorPage(json.error || 'Failed to save API key'), {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Redirect to settings page with success indicator
    const settingsUrl = new URL('/settings', request.nextUrl.origin);
    settingsUrl.searchParams.set('cloud', 'connected');
    return NextResponse.redirect(settingsUrl);
  } catch (err) {
    return new NextResponse(errorPage('Failed to reach local API server'), {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    });
  }
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html><head><title>Cloud Connect Error</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111;color:#eee">
<div style="text-align:center;max-width:400px">
<h3 style="color:#f87171">Connection Failed</h3>
<p style="color:#999;font-size:14px">${message}</p>
<p style="color:#666;font-size:12px">Close this window and try again from Settings.</p>
</div></body></html>`;
}
