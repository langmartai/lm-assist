import { NextRequest, NextResponse } from 'next/server';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import path from 'path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { serverAuthHeader } from '@/lib/server-auth';
import { deriveIssuer } from '@/lib/oidc-issuer';

const COOKIE_NAME = 'lm_oidc';
const CLIENT_ID = 'lm-assist-local';
const CONFIG_FILE = path.join(homedir(), '.lm-assist', 'assist-config.json');

// Cache one JWKS per issuer (jose handles refresh/cooldown internally).
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(issuer: string) {
  let s = jwksByIssuer.get(issuer);
  if (!s) { s = createRemoteJWKSet(new URL(`${issuer}/v1/auth/oidc/jwks.json`)); jwksByIssuer.set(issuer, s); }
  return s;
}

function fail(req: NextRequest, error: string): NextResponse {
  const u = req.nextUrl.clone(); u.pathname = '/lan-blocked'; u.search = `error=${error}`; u.hash = '';
  const res = NextResponse.redirect(u, 302);
  res.cookies.delete({ name: COOKIE_NAME, path: '/' });
  return res;
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const raw = req.cookies.get(COOKIE_NAME)?.value;
  let ck: { verifier: string; state: string; nonce: string; returnTo: string } | null = null;
  if (raw) { try { ck = JSON.parse(raw); } catch { ck = null; } }
  if (!code || !state || !ck || ck.state !== state) return fail(req, 'oidc');

  try {
    const issuer = await deriveIssuer();
    if (!issuer) return fail(req, 'no_hub');

    // 1. code + PKCE verifier -> id_token. PUBLIC client: no client_secret exists.
    const tr = await fetch(`${issuer}/v1/auth/oidc/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: ck.verifier, client_id: CLIENT_ID, redirect_uri: `${req.nextUrl.origin}/api/auth/oidc-callback` }),
    });
    const tok = await tr.json().catch(() => ({}));
    if (!tr.ok || !tok.id_token) return fail(req, 'oidc');

    // 2. Verify id_token: RS256 via the issuer JWKS, iss, aud, exp (jose) + nonce (ours).
    const { payload } = await jwtVerify(tok.id_token, jwksFor(issuer), { issuer, audience: CLIENT_ID });
    if (!ck.nonce || payload.nonce !== ck.nonce) return fail(req, 'oidc');

    // 3. The authorization rule — identical to cloud-verify: only the device-bound user is admitted.
    const apiPort = process.env.LM_LOCAL_API_PORT || process.env.NEXT_PUBLIC_LOCAL_API_PORT || '3100';
    const dr = await fetch(`http://localhost:${apiPort}/hub/user`, { headers: serverAuthHeader() });
    const dj = await dr.json().catch(() => ({}));
    const deviceUserId: string | undefined = dj?.data?.id;
    if (!dr.ok || !deviceUserId) return fail(req, 'no_hub');
    if (String(payload.sub) !== String(deviceUserId)) return fail(req, 'owner_mismatch');

    // 4. Grant: read/auto-generate the lanAccessToken (same as cloud-verify).
    let cfg: { lanEnabled?: boolean; lanAuthEnabled?: boolean; lanAccessToken?: string } = {};
    try { cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { /* fresh */ }
    if (!cfg.lanAccessToken) {
      cfg.lanAuthEnabled = true;
      cfg.lanAccessToken = randomBytes(32).toString('hex');
      mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
      writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
    }

    // 5. Fragment handoff — the token must never appear in a query string / server log.
    // Cookie is HttpOnly but not authenticated input — re-validate with oidc-start's safeReturnTo guard.
    const safeReturnTo = ck.returnTo && /^\/(?![/\\])[^\x00-\x1f\x7f]*$/.test(ck.returnTo) ? ck.returnTo : '/';
    const u = req.nextUrl.clone(); u.pathname = '/lan-blocked'; u.search = '';
    u.hash = `granted=${cfg.lanAccessToken}&returnTo=${encodeURIComponent(safeReturnTo)}`;
    const res = NextResponse.redirect(u, 302);
    res.cookies.delete({ name: COOKIE_NAME, path: '/' });
    return res;
  } catch (e) {
    console.error('[oidc-callback]', e);
    return fail(req, 'oidc');
  }
}
