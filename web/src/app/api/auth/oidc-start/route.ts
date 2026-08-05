import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, createHash } from 'crypto';
import { deriveIssuer } from '@/lib/oidc-issuer';

const COOKIE_NAME = 'lm_oidc';
const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const safeReturnTo = (raw: string | null) => (raw && /^\/(?![/\\])/.test(raw) ? raw : '/');

export async function GET(req: NextRequest) {
  const issuer = await deriveIssuer();
  if (!issuer) {
    const u = req.nextUrl.clone(); u.pathname = '/lan-blocked'; u.search = 'error=no_hub'; u.hash = '';
    return NextResponse.redirect(u, 302);
  }
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get('returnTo'));
  const q = new URLSearchParams({
    response_type: 'code', client_id: 'lm-assist-local',
    redirect_uri: `${req.nextUrl.origin}/api/auth/oidc-callback`,
    scope: 'openid profile email', code_challenge: challenge, code_challenge_method: 'S256',
    state, nonce,
  });
  const res = NextResponse.redirect(`${issuer}/v1/auth/oidc/authorize?${q}`, 302);
  res.cookies.set(COOKIE_NAME, JSON.stringify({ verifier, state, nonce, returnTo }), {
    // secure:false deliberately — the LAN origin is plain http; an https-only cookie would never round-trip.
    httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: 600,
  });
  return res;
}
