import { NextRequest, NextResponse } from 'next/server';
import { chmodSync } from 'fs';
import { randomBytes } from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { coreBaseUrlServer, serverAuthHeader } from '@/lib/server-auth';
import { assistConfigFile, readAssistConfig, writeAssistConfig } from '@/lib/assist-config';
import { deriveIssuer, requestOrigin } from '@/lib/oidc-issuer';

const COOKIE_NAME = 'lm_oidc';
const CLIENT_ID = 'lm-assist-local';

// Cache one JWKS per issuer (jose handles refresh/cooldown internally).
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(issuer: string) {
  let s = jwksByIssuer.get(issuer);
  if (!s) { s = createRemoteJWKSet(new URL(`${issuer}/v1/auth/oidc/jwks.json`)); jwksByIssuer.set(issuer, s); }
  return s;
}

function fail(req: NextRequest, error: string): NextResponse {
  // requestOrigin, not nextUrl — nextUrl carries the standalone bind address (0.0.0.0).
  const res = NextResponse.redirect(`${requestOrigin(req)}/lan-blocked?error=${error}`, 302);
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
      body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: ck.verifier, client_id: CLIENT_ID, redirect_uri: `${requestOrigin(req)}/api/auth/oidc-callback` }),
    });
    const tok = await tr.json().catch(() => ({}));
    if (!tr.ok || !tok.id_token) return fail(req, 'oidc');

    // 2. Verify id_token: RS256 via the issuer JWKS, iss, aud, exp (jose) + nonce (ours).
    const { payload } = await jwtVerify(tok.id_token, jwksFor(issuer), { issuer, audience: CLIENT_ID, algorithms: ['RS256'] });
    if (!ck.nonce || payload.nonce !== ck.nonce) return fail(req, 'oidc');

    // 3. The authorization rule: only the device-bound user is admitted.
    const dr = await fetch(`${coreBaseUrlServer()}/hub/user`, { headers: serverAuthHeader() });
    const dj = await dr.json().catch(() => ({}));
    const deviceUserId: string | undefined = dj?.data?.id;
    if (!dr.ok || !deviceUserId) return fail(req, 'no_hub');
    if (String(payload.sub) !== String(deviceUserId)) return fail(req, 'owner_mismatch');

    // 4. Grant: read/auto-generate the lanAccessToken.
    const cfg = readAssistConfig();
    // LAN access switched off means no LAN browser gets in, owner or not — Core
    // refuses LAN-key grants in that state, so handing out the key would only
    // produce a sign-in that bounces straight back here.
    if (cfg.lanAuthEnabled === false) return fail(req, 'lan_disabled');
    if (!cfg.lanAccessToken) {
      cfg.lanAuthEnabled = true;
      cfg.lanAccessToken = randomBytes(32).toString('hex');
      // 0600: the file holds the LAN credential — owner-only.
      writeAssistConfig(cfg);
    }
    // Repair perms on EVERY grant, not only on create — a pre-existing file from the
    // old default-mode writers can be 0664 while already holding a token.
    try { chmodSync(assistConfigFile(), 0o600); } catch { /* file vanished between read and chmod — grant still valid */ }

    // 5. Fragment handoff — the token must never appear in a query string / server log.
    // Cookie is HttpOnly but not authenticated input — re-validate with oidc-start's safeReturnTo guard.
    const safeReturnTo = ck.returnTo && /^\/(?![/\\])[^\x00-\x1f\x7f]*$/.test(ck.returnTo) ? ck.returnTo : '/';
    // requestOrigin, not nextUrl — nextUrl carries the standalone bind address (0.0.0.0).
    const u = new URL('/lan-blocked', requestOrigin(req));
    u.hash = `granted=${cfg.lanAccessToken}&returnTo=${encodeURIComponent(safeReturnTo)}`;
    const res = NextResponse.redirect(u, 302);
    res.cookies.delete({ name: COOKIE_NAME, path: '/' });
    return res;
  } catch (e) {
    // Message only — jose claim-validation errors carry the DECODED ID-TOKEN CLAIMS
    // as an enumerable .payload, which console.error(e) would print into the log.
    console.error('[oidc-callback]', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    return fail(req, 'oidc');
  }
}
