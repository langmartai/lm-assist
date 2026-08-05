import type { NextRequest } from 'next/server';
import { serverAuthHeader } from '@/lib/server-auth';

// The origin the BROWSER is actually on. req.nextUrl reflects the standalone
// server's bind address (0.0.0.0:3948) — measured, not the Host header — which
// would poison every redirect and the OIDC redirect_uri. Derive from Host,
// constrained to the shapes this flow serves (localhost/127.0.0.1/RFC1918,
// optional port); anything else (host-header injection, public hosts) falls
// back to nextUrl.origin, which the AS-side lan: sentinel then rejects.
const LAN_HOST = /^(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(:\d{1,5})?$/;
export function requestOrigin(req: NextRequest): string {
  const host = req.headers.get('host') || '';
  return LAN_HOST.test(host) ? `http://${host}` : req.nextUrl.origin;
}

// assist-api.langmart.ai → https://auth.langmart.ai (dev: xeenhub.com alike).
// The node's hub decides the issuer — no separate config to drift.
export async function deriveIssuer(): Promise<string | null> {
  const apiPort = process.env.LM_LOCAL_API_PORT || process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100';
  try {
    const r = await fetch(`http://localhost:${apiPort}/hub/status`, { headers: serverAuthHeader() });
    const j = await r.json();
    const hubUrl: string | undefined = j?.data?.hubUrl || j?.hubUrl;
    if (!hubUrl) return null;
    const host = new URL(hubUrl.replace(/^ws/, 'http')).hostname;      // assist-api.langmart.ai
    const domain = host.split('.').slice(-2).join('.');                 // langmart.ai
    if (domain !== 'langmart.ai' && domain !== 'xeenhub.com') return null;
    return `https://auth.${domain}`;
  } catch { return null; }
}
