# lm-assist LAN Login via Platform OIDC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** lm-assist web's LAN admission becomes a standard OIDC code+PKCE flow against the platform provider — identity only; the local `lanAccessToken` model is kept; the raw-platform-API-key postMessage dies.

**Architecture:** Platform side (LangMartDesign gateway-type1): `oidc_clients.public` flag (secret-less clients), a `lan:<path>` redirect sentinel (RFC1918/localhost, any port), and a seeded `lm-assist-local` client (`public=true, trusted=false`). lm-assist side (this repo, `web/`): two Next route handlers (`oidc-start`, `oidc-callback`) that derive the issuer from the node's own hub, verify the id_token with jose, apply the existing device-owner rule (`sub === /hub/user id`), and grant the existing `lanAccessToken` via a URL-fragment handoff to a reworked `/lan-blocked`.

**Tech Stack:** Next 16 route handlers (lm-assist `web/`), jose (hoisted at repo root), Express + jsonwebtoken (gateway-type1), `node --test` + tsx (gateway-type1 tests).

**Spec:** `docs/superpowers/specs/2026-08-05-lm-assist-lan-oidc-login-design.md` (in this repo). Read it for security rationale; the binding values are repeated per task below.

## Global Constraints

- Client id is exactly `lm-assist-local`; registered `public=true`, `trusted=false`, `redirect_uris=['lan:/api/auth/oidc-callback']`. No client secret exists anywhere.
- The platform API key must NEVER be fetched, stored, or transited by any code in this plan (identity only).
- The `lanAccessToken` reaches the browser ONLY as a URL **fragment** (`#granted=…`), never a query param.
- lm-assist branch: `feat/lan-oidc-login` (off main). LangMartDesign branch: `feat/oidc-public-client` (off main, currently `2e15073d`).
- LangMartDesign: never `git add` unrelated WIP (`gateway-type2/gateway-config.json`, `assist-web/tsconfig.tsbuildinfo`, `docs/strategy/`, `ui-gateway/testui/`, `core.sh.bak*`).
- gateway-type1 tests run with `npx tsx --test --test-force-exit <file>` (the pii-detector setInterval leak requires `--test-force-exit`).
- lm-assist web has no test runner: verification is `cd web && npx tsc --noEmit` (pre-existing errors, if any, must be shown pre-existing) plus the live e2e in Task 5.
- PKCE is S256 everywhere; `b64url` = base64 with `=` stripped, `+`→`-`, `/`→`_`.

---

### Task 1: Platform — public clients + `lan:` redirect sentinel + seed (LangMartDesign)

**Files:**
- Create: `datastore/migrations/2026-08-05_oidc_public.sql`
- Modify: `datastore/tables/50_oidc_clients.sql` (add the column to the canonical table def)
- Modify: `gateway-type1/lib/oidc/client-store.ts` (type + SELECT + seed + sentinel matcher)
- Modify: `gateway-type1/lib/routes/oidc-provider.ts` (~line 85: public-client token path)
- Create: `gateway-type1/scripts/seed-lm-assist-oidc-client.ts`
- Test: `gateway-type1/lib/oidc/__tests__/client-store.test.ts` (new)

**Interfaces:**
- Consumes: existing `OidcClient` type, `redirectAllowed(client, uri)`, `seedOidcClient(input)`, token handler's `sha256Hex` secret check at `oidc-provider.ts:85`, `pkceOk` at `:90`.
- Produces: `OidcClient.public: boolean`; `redirectAllowed` understanding `lan:<path>` entries; token endpoint accepting secret-less exchanges for `public` clients only. Task 5 runs the seed script.

- [ ] **Step 1: failing tests for the sentinel matcher + public flag plumbing.** Create `gateway-type1/lib/oidc/__tests__/client-store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { redirectAllowed, OidcClient } from '../client-store';

const lanClient: OidcClient = { clientId: 'lm-assist-local', clientSecretHash: '', redirectUris: ['lan:/api/auth/oidc-callback'], name: 'LM Assist Local', trusted: false, public: true } as OidcClient;
const exactClient: OidcClient = { clientId: 'x', clientSecretHash: 'h', redirectUris: ['https://a.example/cb'], name: 'X', trusted: false, public: false } as OidcClient;

test('lan sentinel accepts localhost + RFC1918, any port, exact path', () => {
  for (const u of [
    'http://localhost:3848/api/auth/oidc-callback',
    'http://127.0.0.1:3948/api/auth/oidc-callback',
    'http://10.0.1.117:3948/api/auth/oidc-callback',
    'http://172.16.0.9:3848/api/auth/oidc-callback',
    'http://172.31.255.1:3848/api/auth/oidc-callback',
    'http://192.168.1.5:3848/api/auth/oidc-callback',
  ]) assert.ok(redirectAllowed(lanClient, u), u);
});

test('lan sentinel rejects public IPs, https, wrong path, out-of-range 172, hostnames', () => {
  for (const u of [
    'http://8.8.8.8:3848/api/auth/oidc-callback',
    'https://10.0.1.117:3948/api/auth/oidc-callback',
    'http://10.0.1.117:3948/api/auth/other',
    'http://172.32.0.1:3848/api/auth/oidc-callback',
    'http://evil.example:3848/api/auth/oidc-callback',
    'http://10.0.1.117:3948/api/auth/oidc-callback/extra',
  ]) assert.ok(!redirectAllowed(lanClient, u), u);
});

test('exact-match entries unaffected', () => {
  assert.ok(redirectAllowed(exactClient, 'https://a.example/cb'));
  assert.ok(!redirectAllowed(exactClient, 'http://10.0.0.1:1/cb'));
});
```

- [ ] **Step 2: run it — must FAIL** (`public` not on the type; sentinel not implemented):
`cd gateway-type1 && npx tsx --test --test-force-exit lib/oidc/__tests__/client-store.test.ts` → compile error / assertion failures.

- [ ] **Step 3: implement.**
`datastore/migrations/2026-08-05_oidc_public.sql`:
```sql
-- Public (secret-less, PKCE-only) OIDC clients — RFC 8252 installed apps.
ALTER TABLE oidc_clients ADD COLUMN IF NOT EXISTS public boolean NOT NULL DEFAULT false;
```
Add the same column to `datastore/tables/50_oidc_clients.sql`.

`client-store.ts`: add `public: boolean` to `OidcClient`; add `, public` to the SELECT and `public: !!row.public` to the mapper; extend `seedOidcClient` input with `public?: boolean`, adding the column to INSERT + `ON CONFLICT DO UPDATE` (mirror how `trusted` was added in commit `2e15073d`). Replace `redirectAllowed`:
```ts
const RFC1918 = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/;
function lanRedirectOk(sentinelPath: string, redirectUri: string): boolean {
  let u: URL; try { u = new URL(redirectUri); } catch { return false; }
  if (u.protocol !== 'http:') return false;               // LAN sentinel is http-only by design
  if (u.pathname !== sentinelPath) return false;          // exact path
  if (u.search || u.hash) return false;                   // no query/fragment tricks
  const h = u.hostname;
  return h === 'localhost' || h === '127.0.0.1' || RFC1918.test(h);
}
export function redirectAllowed(client: OidcClient, redirectUri: string): boolean {
  return client.redirectUris.some(entry =>
    entry.startsWith('lan:') ? lanRedirectOk(entry.slice(4), redirectUri) : entry === redirectUri);
}
```

`oidc-provider.ts` token handler (current line ~85):
```ts
// BEFORE: if (!client || sha256Hex(b.client_secret || '') !== client.clientSecretHash) { 401 }
if (!client) { res.status(401).json({ error: 'invalid_client' }); return; }
// Public (secret-less) clients — RFC 8252: PKCE (checked below) is the proof of
// possession; there is no secret to compare. Confidential clients unchanged.
if (!client.public && sha256Hex(b.client_secret || '') !== client.clientSecretHash) {
  res.status(401).json({ error: 'invalid_client' }); return;
}
```
(The existing `pkceOk` check a few lines down stays — it is what makes the public path safe. Do not touch it.)

`scripts/seed-lm-assist-oidc-client.ts` (mirror `seed-assistweb-oidc-client.ts`, no secret printed because none exists):
```ts
import { seedOidcClient } from '../lib/oidc/client-store';
(async () => {
  await seedOidcClient({
    clientId: 'lm-assist-local', clientSecret: '', name: 'LM Assist Local',
    redirectUris: ['lan:/api/auth/oidc-callback'], trusted: false, public: true,
  });
  console.log('SEEDED client_id=lm-assist-local (public, trusted=false, lan sentinel redirect)');
  process.exit(0);
})();
```
(If `seedOidcClient` hashes the empty secret that is fine — a `public` client's hash is never compared.)

- [ ] **Step 4: run the test file — all pass.** Also run the existing suite file touched by the type change: `npx tsx --test --test-force-exit lib/endpoints/auth/__tests__/oidc-session-key.test.ts` (must stay green — the `OidcClient` type gained a field; `isClientTrusted` behavior unchanged).

- [ ] **Step 5: commit** on `feat/oidc-public-client`:
```bash
git checkout -b feat/oidc-public-client main
git add datastore/migrations/2026-08-05_oidc_public.sql datastore/tables/50_oidc_clients.sql gateway-type1/lib/oidc/client-store.ts gateway-type1/lib/oidc/__tests__/client-store.test.ts gateway-type1/lib/routes/oidc-provider.ts gateway-type1/scripts/seed-lm-assist-oidc-client.ts
git commit -m "feat(oidc): public (PKCE-only) clients + lan: redirect sentinel + lm-assist-local seed"
```

---

### Task 2: lm-assist — `/api/auth/oidc-start` (issuer from the hub)

**Files:**
- Create: `web/src/app/api/auth/oidc-start/route.ts`
- Create: `web/src/lib/oidc-issuer.ts` (shared with Task 3)

**Interfaces:**
- Consumes: `serverAuthHeader()` from `web/src/lib/server-auth.ts`; Core `GET /hub/status` (`{data:{hubUrl}}`, e.g. `wss://assist-api.langmart.ai`); env `LM_LOCAL_API_PORT` (runtime) falling back to `NEXT_PUBLIC_LOCAL_API_PORT` then `3100` (the pattern in `cloud-verify/route.ts:67`).
- Produces: `deriveIssuer(): Promise<string|null>` in `oidc-issuer.ts` (`assist-api.langmart.ai` → `https://auth.langmart.ai`; `assist-api.xeenhub.com` → `https://auth.xeenhub.com`; unknown/no hub → null). Cookie `lm_oidc` = JSON `{verifier,state,nonce,returnTo}` HttpOnly SameSite=Lax Path=/ maxAge 600. Task 3 reads both.

- [ ] **Step 1: `web/src/lib/oidc-issuer.ts`:**
```ts
import { serverAuthHeader } from '@/lib/server-auth';

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
```

- [ ] **Step 2: `oidc-start/route.ts`** — mirror the assist-web RP start (PKCE+state+nonce cookie, misconfig guard), differing in: issuer from `deriveIssuer()`, client `lm-assist-local`, redirect_uri from the **request origin** (`req.nextUrl.origin` — the LAN browser's own URL is the right origin), cookie name `lm_oidc`, failure target `/lan-blocked?error=…`:
```ts
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
    httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: 600,
  });
  return res;
}
```
(`secure:false` deliberately — the LAN origin is plain http; an https-only cookie would never round-trip. Comment this in the code.)

- [ ] **Step 3: verify** `cd web && npx tsc --noEmit 2>&1 | head` — no NEW errors (record any pre-existing ones).
- [ ] **Step 4: commit** on `feat/lan-oidc-login` (branch off main first): `git add web/src/lib/oidc-issuer.ts web/src/app/api/auth/oidc-start/route.ts && git commit -m "feat(web): OIDC start — identity-only public RP against the node's hub issuer"`.

---

### Task 3: lm-assist — `/api/auth/oidc-callback` (verify → owner check → grant)

**Files:**
- Create: `web/src/app/api/auth/oidc-callback/route.ts`

**Interfaces:**
- Consumes: `lm_oidc` cookie + `deriveIssuer()` (Task 2); `jose` (repo-root hoisted): `createRemoteJWKSet`, `jwtVerify`; Core `GET /hub/user` (`{success, data:{id}}`) with `serverAuthHeader()`; `~/.lm-assist/assist-config.json` read/auto-generate `lanAccessToken` (exact logic of `cloud-verify/route.ts:60-65`: if `lanAuthEnabled` (default true) and no token → generate `randomBytes(32).toString('hex')` and persist).
- Produces: 302 `/lan-blocked#granted=<token>` on success; 302 `/lan-blocked?error=<oidc|owner_mismatch|no_hub>` on failure. Task 4's page consumes both.

- [ ] **Step 1: implement.** Structure (complete file; follow it exactly):
```ts
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
    const u = req.nextUrl.clone(); u.pathname = '/lan-blocked'; u.search = '';
    u.hash = `granted=${cfg.lanAccessToken}&returnTo=${encodeURIComponent(ck.returnTo || '/')}`;
    const res = NextResponse.redirect(u, 302);
    res.cookies.delete({ name: COOKIE_NAME, path: '/' });
    return res;
  } catch (e) {
    console.error('[oidc-callback]', e);
    return fail(req, 'oidc');
  }
}
```

- [ ] **Step 2: verify** `cd web && npx tsc --noEmit 2>&1 | head` — no NEW errors. Confirm `jose` resolves: `node -e "const p=require.resolve('jose',{paths:['./web']}); console.log(p)"` from repo root.
- [ ] **Step 3: commit**: `git add web/src/app/api/auth/oidc-callback/route.ts && git commit -m "feat(web): OIDC callback — verify id_token, device-owner check, fragment lanAccessToken grant"`.

---

### Task 4: lm-assist — `/lan-blocked` rework (redirect sign-in + fragment grant)

**Files:**
- Modify: `web/src/app/lan-blocked/page.tsx`

**Interfaces:**
- Consumes: `#granted=<token>&returnTo=<path>` fragment and `?error=<oidc|owner_mismatch|no_hub>` from Task 3; existing `/api/server` (`{cloudBound, hubDomain, lanAuthEnabled}`).
- Produces: stores `assist_access_key` in localStorage exactly as before; navigates to `returnTo` (same-origin path only) or `/`.

- [ ] **Step 1: rework the page.** Keep the visual shell, `expired` handling, manual-steps fallback, and the `/api/server` cloudBound probe. Changes:
  1. **Delete** the `postMessage` listener effect (lines ~61-111), the popup `window.open` in `handleSignIn`, and the `/api/auth/cloud-verify` fetch — the popup path is retired.
  2. **Add a fragment-grant effect** (runs once on mount, before anything else):
```ts
useEffect(() => {
  const h = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const granted = h.get('granted');
  if (!granted) return;
  localStorage.setItem('assist_access_key', granted);
  const rt = h.get('returnTo') || '/';
  const dest = /^\/(?![/\\])/.test(rt) ? rt : '/';
  window.history.replaceState({}, '', '/lan-blocked');   // scrub the token from the URL/history
  setVerifyStatus('success');
  setTimeout(() => router.replace(dest), 800);
}, [router]);
```
  3. **`handleSignIn`** becomes a same-tab redirect carrying the page the user tried to reach if the guard recorded one (keep it simple — current page is /lan-blocked, so just `/`):
```ts
const handleSignIn = useCallback(() => {
  setVerifyStatus('waiting');
  window.location.href = '/api/auth/oidc-start?returnTo=%2F';
}, []);
```
  4. **Error display:** read `?error=` on mount; map `owner_mismatch` → "This account is not the owner bound to this device. Sign in with the device owner's account."; `no_hub` → "This device is not connected to a cloud account. Connect it on localhost first."; `oidc` → "Sign-in failed. Try again."; render in the existing error box. Clear `verifyStatus` back to idle.
  5. The "Waiting for sign in…" copy changes to reflect a redirect (e.g. "Redirecting to sign in…") — there is no popup to wait for.
  6. `showSignIn` stays gated on `cloudBound === true` (an unbound device can't pass the owner check anyway).

- [ ] **Step 2: verify** `cd web && npx tsc --noEmit 2>&1 | head` — no NEW errors; grep the page for `cloud-verify|postMessage|window.open` → no hits.
- [ ] **Step 3: deprecation marker:** add a top-of-file comment to `web/src/app/api/auth/cloud-verify/route.ts`: `/** @deprecated Replaced by the OIDC LAN login (oidc-start/oidc-callback). Kept one release for rollback; remove after the fleet is on the OIDC flow. */` (no behavior change).
- [ ] **Step 4: commit**: `git add web/src/app/lan-blocked/page.tsx web/src/app/api/auth/cloud-verify/route.ts && git commit -m "feat(web): lan-blocked signs in via OIDC redirect; popup/postMessage path retired"`.

---

### Task 5: Seed dev client, deploy dev, live e2e (controller runs this hands-on)

**Files:** none new in-repo (e2e script in scratchpad; evidence in the ledger).

**Interfaces:** consumes everything above; produces the pass/fail evidence.

- [ ] **Step 1:** LangMartDesign dev: apply the migration to the dev DB (`psql … -f datastore/migrations/2026-08-05_oidc_public.sql` or the inline ALTER), rebuild + restart gw1 (`./core.sh restart 1`), run `seed-lm-assist-oidc-client` (tsx from repo root paths) → verify `SELECT client_id, public, trusted, redirect_uris FROM oidc_clients WHERE client_id='lm-assist-local'` → `t | f | {lan:/api/auth/oidc-callback}`.
- [ ] **Step 2:** lm-assist dev: rebuild web with Node 20 (`export PATH=$HOME/.nvm/versions/node/v20.19.6/bin:$PATH && ./core.sh restart`, per the dev-web memory) → `:3948` up.
- [ ] **Step 3:** live e2e (node script, mirror the assist-web one):
  - A: `GET http://<LAN-IP>:3948/api/auth/oidc-start` → 302 to `https://auth.xeenhub.com/v1/auth/oidc/authorize` with `client_id=lm-assist-local` + S256 + `lm_oidc` cookie; authorize with a seeded `x-api-key` for the **device-bound** test user → 302 back to the LAN callback; `GET` callback with the cookie → 302 `/lan-blocked#granted=<token>`; assert token equals `~/.lm-assist/assist-config.json` `lanAccessToken` AND `POST /api/auth/validate {token}` → `{valid:true}`; assert the token never appears in a query string.
  - B (owner mismatch): repeat with an id_token for a **different** platform user (mint a second test identity or an sk-session key for another user) → callback 302 `?error=owner_mismatch`, and assist-config token unchanged.
  - C (fence): POST the captured `lm-assist-local` id_token to `https://auth.xeenhub.com/api/auth/oidc-session-key` → **403** (trusted=false).
  - D (public-client hygiene): token endpoint with the right code but WRONG `code_verifier` → 400 `invalid_grant`.
- [ ] **Step 4:** record results in the ledger; commit any e2e-driven fixes.

---

## Final: whole-branch review (both repos), then merge on user go

`review-package` per repo (`main..feat/oidc-public-client`, `main..feat/lan-oidc-login`); one capable-model reviewer over both packages with the fence + owner-rule + fragment-handoff invariants; fix, re-verify, then ask the user before merge/push/SG.
