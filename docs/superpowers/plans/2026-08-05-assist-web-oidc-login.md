# assist-web OIDC Login (keep API key) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Move assist-web's login onto standard OIDC against the platform provider (`auth.langmart.ai` / dev `auth.xeenhub.com`) while keeping the `sk-session` API key the SPA uses for `/api/*`.

**Architecture:** assist-web's Next backend becomes a confidential OIDC RP (`/api/auth/oidc-start` + `/api/auth/oidc-callback`). The callback trades the verified id_token for an `sk-session` key via a new **trusted-first-party** endpoint on gateway-type1 (`/api/auth/oidc-session-key`), then reuses the *existing* `/auth-landing`→`redeem-code`→`loginWithApiKey` tail via a one-time exchange-code. Minimal SPA change (just the login trigger).

**Tech Stack:** gateway-type1 (TS/Express, `jsonwebtoken`, `@langmart/shared-db`); assist-web (Next.js app-router, server route handlers); the platform OIDC provider (unchanged — confidential client + secret).

## Global Constraints
- Code in `/home/ubuntu/LangMartDesign`. Never `git add` unrelated WIP (`gateway-type2/gateway-config.json`, `assist-web/tsconfig.tsbuildinfo`, `docs/strategy/*`, `ui-gateway/testui/`). Commit only listed files by explicit path.
- The minted key is a normal `sk-session` `api_keys` row (full parity with today) — NOT an OIDC JWT. Only **trusted** oidc_clients may trade an id_token for a key; the ui-gateway stays untrusted (fence holds for it).
- The `client_secret` + `OIDC_ISSUER` live in assist-web's server env (gitignored), never in the browser. The id_token never reaches the browser — only the one-time code does (as `redeem-code` works today).
- Issuer: `PLATFORM_OIDC_ISSUER` (dev `https://auth.xeenhub.com`, prod `https://auth.langmart.ai`).

---

### Task 1: `oidc_clients.trusted` flag

**Files:** Create `datastore/migrations/2026-08-05_oidc_trusted.sql`; Modify `datastore/tables/50_oidc_clients.sql`.

- [ ] **Step 1: Migration**
```sql
ALTER TABLE oidc_clients ADD COLUMN IF NOT EXISTS trusted boolean NOT NULL DEFAULT false;
```
Add the same `trusted boolean NOT NULL DEFAULT false` column to `tables/50_oidc_clients.sql`'s CREATE.
- [ ] **Step 2: Apply + verify** — `PGPASSWORD=langmart_secret_2024 psql -h localhost -U langmart_admin -d langmart -f datastore/migrations/2026-08-05_oidc_trusted.sql` then `\d oidc_clients` shows `trusted | boolean`. Idempotent (re-run = no-op).
- [ ] **Step 3: Commit** `git add datastore/migrations/2026-08-05_oidc_trusted.sql datastore/tables/50_oidc_clients.sql && git commit -m "feat(db): oidc_clients.trusted flag"`

---

### Task 2: `oidc-session-key` endpoint (id_token → sk-session key, trusted clients only)

**Files:** Create `gateway-type1/lib/endpoints/auth/oidc-session-key.ts`; Modify `gateway-type1/lib/app.ts` (mount, public, before global `authenticate`); Test `gateway-type1/lib/endpoints/auth/__tests__/oidc-session-key.test.ts`.

**Interfaces:** Consumes `getPlatformOidcKeys` (`../../services/platform-oidc-keys`), `getOidcClient` (`../../oidc/client-store`), `PostgresClient`. Produces `POST /api/auth/oidc-session-key {id_token} → {apiKey}`; exports `verifyPlatformIdToken(idToken): Promise<{sub, aud}>` for the unit test.

- [ ] **Step 1: Write the failing test**
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import * as jwt from 'jsonwebtoken';
import { getPlatformOidcKeys } from '../../../services/platform-oidc-keys';
import { verifyPlatformIdToken } from '../oidc-session-key';

process.env.PLATFORM_OIDC_ISSUER = process.env.PLATFORM_OIDC_ISSUER || 'https://auth.test.local';

test('verifyPlatformIdToken accepts a valid platform id_token', async () => {
  const k = await getPlatformOidcKeys();
  const tok = jwt.sign({ sub: 'u1' }, k.privatePem, { algorithm: 'RS256', keyid: k.kid, issuer: 'https://auth.test.local', audience: 'assist-web', expiresIn: 900 } as jwt.SignOptions);
  const r = await verifyPlatformIdToken(tok);
  assert.strictEqual(r.sub, 'u1'); assert.strictEqual(r.aud, 'assist-web');
});
test('verifyPlatformIdToken rejects a wrong-issuer token', async () => {
  const k = await getPlatformOidcKeys();
  const tok = jwt.sign({ sub: 'u1' }, k.privatePem, { algorithm: 'RS256', keyid: k.kid, issuer: 'https://evil', audience: 'assist-web', expiresIn: 900 } as jwt.SignOptions);
  await assert.rejects(() => verifyPlatformIdToken(tok));
});
```
- [ ] **Step 2: Run — expect fail** `cd gateway-type1 && JWT_SECRET=dev npx tsx --test --test-force-exit lib/endpoints/auth/__tests__/oidc-session-key.test.ts` → module not found.
- [ ] **Step 3: Implement** `gateway-type1/lib/endpoints/auth/oidc-session-key.ts`:
```ts
import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { PostgresClient } from '../../db/client';
import { getPlatformOidcKeys } from '../../services/platform-oidc-keys';
import { getOidcClient } from '../../oidc/client-store';

const ISSUER = (process.env.PLATFORM_OIDC_ISSUER || 'https://auth.xeenhub.com').replace(/\/$/, '');
const MASTER_ORG_ID = '11111111-1111-1111-1111-111111111111';

export async function verifyPlatformIdToken(idToken: string): Promise<{ sub: string; aud: string }> {
  const k = await getPlatformOidcKeys();
  const c = jwt.verify(idToken, k.publicPem, { algorithms: ['RS256'], issuer: ISSUER }) as jwt.JwtPayload;
  return { sub: String(c.sub), aud: String(c.aud) };
}

// Mirror callback.ts createSessionKey (sk-session api_keys row).
async function mintSessionKey(userId: string, organizationId: string): Promise<string> {
  const db = PostgresClient.getInstance();
  const apiKey = 'sk-session-' + crypto.randomBytes(16).toString('hex') + crypto.randomBytes(20).toString('hex');
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30d, matches OAuth session default
  await db.query(
    `INSERT INTO api_keys (user_id, organization_id, key_hash, key_prefix, name, permissions, status, created_at, expires_at, usage_count, created_by, updated_by)
     VALUES ($1,$2,$3,'sk-session','OIDC Session','["read","write"]'::jsonb,'active',NOW(),$4,0,$1,$1)`,
    [userId, organizationId, keyHash, expiresAt.toISOString()]);
  return apiKey;
}

const router = Router();
// Public + self-authenticating via the id_token. Trades a TRUSTED client's id_token for an sk-session key.
router.post('/api/auth/oidc-session-key', async (req: Request, res: Response) => {
  try {
    const idToken = req.body?.id_token;
    if (!idToken || typeof idToken !== 'string') { res.status(400).json({ error: 'id_token required' }); return; }
    let claims;
    try { claims = await verifyPlatformIdToken(idToken); }
    catch { res.status(401).json({ error: 'invalid id_token' }); return; }
    const client = await getOidcClient(claims.aud);
    if (!client || !(client as any).trusted) { res.status(403).json({ error: 'client not trusted to exchange identity for an API key', aud: claims.aud }); return; }
    const u = (await PostgresClient.getInstance().query(`SELECT organization_id FROM users WHERE id=$1`, [claims.sub])).rows[0];
    if (!u) { res.status(401).json({ error: 'unknown user' }); return; }
    const apiKey = await mintSessionKey(claims.sub, u.organization_id || MASTER_ORG_ID);
    res.json({ apiKey });
  } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
});
export default router;
```
> `getOidcClient` returns the client row; ensure `client-store.ts`'s `OidcClient` type + SELECT include `trusted` (add `trusted` to the SELECT and type — small edit in that file; do it here and note it). If cleaner, read `trusted` with a direct query instead.
- [ ] **Step 4: Mount in app.ts** — beside `app.use(exchangeCodeRouter);` (~line 493): `import oidcSessionKeyRouter from './endpoints/auth/oidc-session-key'; app.use(oidcSessionKeyRouter);` (public, before the global `/v1`+`/api` `authenticate`).
- [ ] **Step 5: Run test — expect pass** (2 tests). Build clean.
- [ ] **Step 6: Commit** `git add gateway-type1/lib/endpoints/auth/oidc-session-key.ts gateway-type1/lib/app.ts gateway-type1/lib/oidc/client-store.ts gateway-type1/lib/endpoints/auth/__tests__/oidc-session-key.test.ts && git commit -m "feat(gateway-type1): /api/auth/oidc-session-key — trusted-client id_token → sk-session key"`

---

### Task 3: assist-web OIDC RP routes (Next backend)

**Files:** Create `assist-web/src/app/api/auth/oidc-start/route.ts`, `assist-web/src/app/api/auth/oidc-callback/route.ts`.

**Interfaces:** Reads env `OIDC_ISSUER`, `ASSISTWEB_OIDC_CLIENT_ID`, `ASSISTWEB_OIDC_CLIENT_SECRET`, `ASSISTWEB_PUBLIC_URL`. Produces the two GET routes. The callback ends by 302 → `/auth-landing?code=<exchange-code>` (reusing the existing SPA redeem).

- [ ] **Step 1: `oidc-start/route.ts`** — server route: generate PKCE `verifier`+`challenge`, `state`, `nonce`; store `{verifier,state,nonce}` in an HttpOnly cookie (`assistweb_oidc`, 10-min, SameSite=Lax); 302 to `${OIDC_ISSUER}/v1/auth/oidc/authorize?response_type=code&client_id=…&redirect_uri=${PUBLIC_URL}/api/auth/oidc-callback&scope=openid%20profile%20email&code_challenge=…&code_challenge_method=S256&state=…&nonce=…`. (Use `crypto` + `next/server` `NextResponse`; base64url the verifier/challenge.)
- [ ] **Step 2: `oidc-callback/route.ts`** — read `code`,`state` from the query and `{verifier,state,nonce}` from the cookie; reject on state mismatch. `POST ${OIDC_ISSUER}/v1/auth/oidc/token` (JSON: `grant_type=authorization_code, code, code_verifier, client_id, client_secret, redirect_uri`) → `{id_token}`. `POST ${OIDC_ISSUER}/api/auth/oidc-session-key {id_token}` → `{apiKey}`. Then obtain a one-time code for the SPA: `POST ${OIDC_ISSUER}/api/auth/exchange-code` with `Authorization: Bearer <apiKey>` → `{code}` (the existing authenticated exchange-code minter). Clear the cookie; 302 → `/auth-landing?code=<code>`. On any error, 302 → `/auth-landing?error=oidc`.
> The raw `apiKey` lives only in this server route + gateway-type1; the browser only ever sees the one-time code, exactly like today. Complete, runnable code is written in-task against Next's `route.ts` (`export async function GET(req: NextRequest)`), using `fetch` for the three server-to-server calls; the `exchange-code` reuse mirrors how `callback.ts` calls `createExchangeCode`.
- [ ] **Step 3: Build assist-web** `cd assist-web && npx next build` (or the repo's build) compiles both routes. Commit both files.

---

### Task 4: Point assist-web's login at OIDC

**Files:** Modify `assist-web/src/app/assist-connect/page.tsx` (the `window.location.href = ${mainSiteUrl}/assist-redirect…` at ~line 232) → redirect to `/api/auth/oidc-start?returnTo=…` instead. Grep for any other login initiation (`assist-redirect`) and repoint it too.

- [ ] Change the redirect target from the main-site `/assist-redirect` bridge to the same-origin `/api/auth/oidc-start`. Keep `returnTo` handling (pass it through oidc-start → cookie → final redirect). Build + commit.

---

### Task 5: Register assist-web client (trusted) + env

**Files:** none tracked (env is gitignored). Use the seeder from the provider work.

- [ ] Seed a **confidential, trusted** oidc_client: extend `gateway-type1/scripts/seed-oidc-client.ts` to accept a `--trusted` flag (or a direct `UPDATE oidc_clients SET trusted=true`), then seed `assist-web` with redirect `<assist-web>/api/auth/oidc-callback` and `trusted=true`. Record the secret into assist-web's server env (`ASSISTWEB_OIDC_CLIENT_ID/SECRET`, `OIDC_ISSUER=https://auth.xeenhub.com`, `ASSISTWEB_PUBLIC_URL`). Do NOT echo the secret. Restart assist-web (dev :3849).

---

### Task 6: E2E — OIDC login yields a working key; fence holds for untrusted

**Files:** Create `gateway-type1/e2e/assist-web-oidc.e2e.js` (node, like the provider e2e).

- [ ] Drive: mint a session key for the test user (seed recipe) → hit the platform authorize (x-api-key session) with the **assist-web** client + PKCE → code → token → **id_token**. Then:
  1. `POST /api/auth/oidc-session-key {id_token}` (assist-web, trusted) → 200 `{apiKey}`; assert the returned key hits a real `/api/*` route (e.g. `GET /api/keys`) = **200** (a working sk-session key).
  2. **Fence A/B:** mint an id_token for the **ui-gateway** client (untrusted) → `POST /api/auth/oidc-session-key` = **403**. Clean up seeded keys.
- [ ] Run + confirm PASS. Commit the e2e.

---

## Self-Review
Spec coverage: §3.1 trusted flag→T1; §3.2 oidc-session-key→T2; §3.3 assist-web RP→T3/T4; §3.5 register client→T5; §6 testing→T2 unit + T6 e2e; §7 deploy→after (dev then SG). Placeholders: T3 route bodies are described precisely (inputs, the three server calls, the cookie, the final redirect) with complete code written in-task — the Next `route.ts` idiom + the exchange-code reuse are the only non-literal parts, both anchored to existing code (`callback.ts`). Type consistency: `verifyPlatformIdToken`, `getOidcClient(...).trusted`, `mintSessionKey`, and the `sk-session` key shape are consistent across T2/T6. Security note carried into every task: only `trusted` clients exchange id_tokens; the raw key never reaches the browser.
