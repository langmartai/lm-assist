import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/auth/cloud-connect — Callback for OAuth assist-connect flow
 *
 * When the assist-connect popup on the platform loses window.opener (after the OAuth
 * redirect), it redirects here with the new API key. The popup's URL is fixed on the
 * platform side, so this route has to stay a GET.
 *
 * Query params: ?key=<api-key>&hubUrl=<wss://...>
 *
 * It changes NOTHING. It used to bind the node to whatever key it was handed, with
 * no caller check — so any page could navigate a victim's browser here and rebind
 * their node to an attacker's cloud account. Now it only hands the key to the
 * settings page in the URL FRAGMENT (never sent to a server, scrubbed on arrival);
 * the settings page asks the user to confirm, and the binding happens through
 * Core's authenticated PUT /hub/config.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const key = searchParams.get('key');
  // hubUrl is passed from the OAuth popup; fallback based on the request's host.
  // The settings page accepts only an exact known platform hub URL.
  const hubUrl = searchParams.get('hubUrl') || (() => {
    const host = request.nextUrl.hostname;
    if (host.includes('xeenhub')) return 'wss://assist-api.xeenhub.com';
    return 'wss://assist-api.langmart.ai';
  })();

  if (!key) {
    return new NextResponse(errorPage('Missing API key parameter'), {
      status: 400,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const fragment = new URLSearchParams({ cloudConnect: '1', key, hubUrl }).toString();
  return new NextResponse(null, {
    status: 303,
    headers: {
      // Relative on purpose: nextUrl.origin is the standalone bind address (0.0.0.0).
      Location: `/settings#${fragment}`,
      'Cache-Control': 'no-store',
      // The key arrived in this request's query; keep it out of the next page's Referer.
      'Referrer-Policy': 'no-referrer',
    },
  });
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
