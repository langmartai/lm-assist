# Whole-Site OIDC Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a standard OIDC provider inside `gateway-type1` (platform host), built on the existing social/SAML login, that issues verifiable identity JWTs no app can turn into a full-power credential — and move the UI gateway's login onto it, off the MCP connector's OAuth server.

**Architecture:** A new router `oidc-provider.ts` on `gateway-type1` serves discovery at the well-known root and `authorize`/`token`/`userinfo`/`jwks` under `/v1/auth/oidc/*` (avoiding collision with `oauth-mcp.ts`'s root `/oauth/*`). `authorize` resolves the human from the existing `langmart_session` via `optionalAuth`. `token` returns an `id_token` and a `userinfo`-only `access_token`, **both RS256 JWTs signed by a platform keypair — neither an `api_keys` row**, so the shared `authenticate` keystone (which validates only `api_keys` + `sessions`-JWTs) structurally rejects them on `/api/*`. Then the OIDC layer is removed from `oauth-mcp.ts` and the UI gateway repointed.

**Tech Stack:** TypeScript (`gateway-type1`, CommonJS/tsc), Express 4, `jsonwebtoken ^9` (already a dep), node `crypto`, `pg` via `@langmart/shared-db`'s `PostgresClient`, `@langmart/shared-auth` (`optionalAuth`). Test runner introduced here: `node --test` via `tsx` (gateway-type1 has none).

## Global Constraints

- Code lives in `/home/ubuntu/LangMartDesign` (YiHuangDB / HTTPS remote). Do NOT push to lm-assist. Do NOT `git add` unrelated on-box WIP (`gateway-type2/gateway-config.json`, `assist-web/tsconfig.tsbuildinfo`, `docs/strategy/*`); commit only listed files by explicit path.
- TypeScript `module: commonjs`, `target ES2020` (match gateway-type1's `tsconfig.json`). No new ESM-only deps.
- **Endpoint placement:** platform OIDC uses `/v1/auth/oidc/{authorize,token,userinfo,jwks.json}` + the required `/.well-known/openid-configuration` at root. It must be mounted **before** the global `app.use('/v1', authenticate)` at `app.ts:543` and beside `app.use(oauthMcpRouter)` at `app.ts:504`.
- **Issuer:** `PLATFORM_OIDC_ISSUER` env, default `https://api.xeenhub.com` (dev) / `https://api.langmart.ai` (prod). The discovery `issuer` and every id_token `iss` = this value.
- **The load-bearing invariant:** the `id_token` and `access_token` are RS256 JWTs signed by the platform OIDC keypair and are NEVER written to `api_keys`. The `access_token` carries `aud:"userinfo"` and is accepted ONLY by `/v1/auth/oidc/userinfo`.
- **DB:** `import { PostgresClient } from '@langmart/shared-db'; PostgresClient.getInstance()`. Live locally (`langmart_admin`/`langmart_secret_2024`, db `langmart`).
- **Signing key** persists in `system_properties.platform_oidc_signing_keys` (first-writer-wins), DISTINCT from the MCP issuer's `oidc_signing_keys`.

---

### Task 1: Schema migration — `api_keys.metadata` + `oidc_clients`

**Files:**
- Create: `datastore/tables/50_oidc_clients.sql`
- Create: `datastore/migrations/2026-08-04_oidc_provider.sql`

**Interfaces:**
- Produces: table `oidc_clients(id uuid pk, client_id text unique, client_secret_hash text, redirect_uris text[], name text, created_at timestamptz)`; column `api_keys.metadata jsonb`.

- [ ] **Step 1: Write the migration SQL**

Create `datastore/migrations/2026-08-04_oidc_provider.sql`:
```sql
-- Whole-site OIDC provider. Idempotent.
-- (1) Make rebuild-from-SQL match the live DB: MCP scoping, SAML sessions, and
--     ui-gateway all read/write api_keys.metadata, but the column is absent from
--     committed schema (it exists only in the live DB).
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS metadata jsonb;

-- (2) Controlled OIDC relying-party registry (NO open DCR).
CREATE TABLE IF NOT EXISTS oidc_clients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          text UNIQUE NOT NULL,
  client_secret_hash text NOT NULL,
  redirect_uris      text[] NOT NULL,
  name               text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
```

Create `datastore/tables/50_oidc_clients.sql` with the same `CREATE TABLE IF NOT EXISTS oidc_clients (...)` block (the committed canonical schema).

- [ ] **Step 2: Apply + verify**

Run:
```bash
PGPASSWORD=langmart_secret_2024 psql -h localhost -U langmart_admin -d langmart -f /home/ubuntu/LangMartDesign/datastore/migrations/2026-08-04_oidc_provider.sql
PGPASSWORD=langmart_secret_2024 psql -h localhost -U langmart_admin -d langmart -c "\d oidc_clients" -c "\d api_keys" | grep -E "oidc_clients|metadata"
```
Expected: `oidc_clients` table listed; `metadata | jsonb` present on `api_keys`. Re-running the migration is a no-op (no error).

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add datastore/tables/50_oidc_clients.sql datastore/migrations/2026-08-04_oidc_provider.sql
git commit -m "feat(db): oidc_clients table + api_keys.metadata (schema-drift fix)"
```

---

### Task 2: Platform OIDC signing keys + test harness

**Files:**
- Create: `gateway-type1/lib/services/platform-oidc-keys.ts`
- Modify: `gateway-type1/package.json` (add tsx + test script)
- Test: `gateway-type1/lib/services/__tests__/platform-oidc-keys.test.ts`

**Interfaces:**
- Produces: `getPlatformOidcKeys(): Promise<{kid,privatePem,publicPem}>`, `getPlatformJwks(): Promise<{keys:object[]}>`.

- [ ] **Step 1: Add the test harness to gateway-type1**

Edit `gateway-type1/package.json` — add to `devDependencies`: `"tsx": "^4.19.0"` (keep existing). Add to `scripts`: `"test": "node --import tsx --test $(find lib -name '*.test.ts')"`. Then `cd /home/ubuntu/LangMartDesign && npm install` (workspace root).

- [ ] **Step 2: Write the failing test**

Create `gateway-type1/lib/services/__tests__/platform-oidc-keys.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { getPlatformOidcKeys, getPlatformJwks } from '../platform-oidc-keys';

test('stable kid across calls, distinct PEM blocks', async () => {
  const a = await getPlatformOidcKeys();
  const b = await getPlatformOidcKeys();
  assert.strictEqual(a.kid, b.kid);
  assert.match(a.privatePem, /BEGIN PRIVATE KEY/);
  assert.match(a.publicPem, /BEGIN PUBLIC KEY/);
});
test('jwks exposes the public key with matching kid + RS256', async () => {
  const k = await getPlatformOidcKeys();
  const jwks = await getPlatformJwks();
  const jwk = jwks.keys.find((x: any) => x.kid === k.kid);
  assert.ok(jwk);
  assert.strictEqual((jwk as any).alg, 'RS256');
});
```

- [ ] **Step 3: Run — expect fail**

Run: `cd gateway-type1 && npx tsx --test lib/services/__tests__/platform-oidc-keys.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

Create `gateway-type1/lib/services/platform-oidc-keys.ts` (mirrors the shipped `oidc-keys.ts`, but a distinct `system_properties` key):
```ts
import { createHash, createPublicKey, generateKeyPairSync } from 'crypto';
import { PostgresClient } from '@langmart/shared-db';

const PROP = 'platform_oidc_signing_keys';
interface KeyRec { kid: string; privatePem: string; publicPem: string; }
let cached: KeyRec | null = null;

function parse(v: unknown): KeyRec | null {
  try { const r = typeof v === 'string' ? JSON.parse(v) : v; if (r && r.kid && r.private_pem && r.public_pem) return { kid: r.kid, privatePem: r.private_pem, publicPem: r.public_pem }; } catch {}
  return null;
}

export async function getPlatformOidcKeys(): Promise<KeyRec> {
  if (cached) return cached;
  const db = PostgresClient.getInstance();
  const r = await db.query(`SELECT property_value FROM system_properties WHERE property_name=$1`, [PROP]);
  const existing = r.rows.length ? parse(r.rows[0].property_value) : null;
  if (existing) { cached = existing; return existing; }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const kid = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  await db.query(
    `INSERT INTO system_properties (property_name, property_value) VALUES ($1,$2::jsonb) ON CONFLICT (property_name) DO NOTHING`,
    [PROP, JSON.stringify({ kid, private_pem: privateKey, public_pem: publicKey, created_at: new Date().toISOString() })],
  );
  const rr = await db.query(`SELECT property_value FROM system_properties WHERE property_name=$1`, [PROP]);
  cached = parse(rr.rows[0].property_value)!;
  return cached;
}

export async function getPlatformJwks(): Promise<{ keys: object[] }> {
  const k = await getPlatformOidcKeys();
  const jwk = createPublicKey(k.publicPem).export({ format: 'jwk' }) as Record<string, unknown>;
  return { keys: [{ ...jwk, kid: k.kid, use: 'sig', alg: 'RS256' }] };
}
```
> If `system_properties` uses a different column/PK name than `property_name`/`property_value`, match `oauth-mcp.ts`'s `oidc-keys.ts` exactly (read it first).

- [ ] **Step 5: Run — expect pass**

Run: `cd gateway-type1 && npx tsx --test lib/services/__tests__/platform-oidc-keys.test.ts` → 2 pass. Then `cd /home/ubuntu/LangMartDesign && npm install` already done; confirm `cd gateway-type1 && npm run build` is clean.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add gateway-type1/package.json gateway-type1/lib/services/platform-oidc-keys.ts gateway-type1/lib/services/__tests__/platform-oidc-keys.test.ts
git commit -m "feat(gateway-type1): platform OIDC RS256 signing keys + node --test harness"
```

---

### Task 3: Token mint/verify

**Files:**
- Create: `gateway-type1/lib/services/platform-oidc-tokens.ts`
- Test: `gateway-type1/lib/services/__tests__/platform-oidc-tokens.test.ts`

**Interfaces:**
- Consumes: `getPlatformOidcKeys` (Task 2).
- Produces:
  - `signIdToken(claims: {sub:string; email?:string; email_verified?:boolean; name?:string; picture?:string; nonce?:string}, opts:{aud:string; issuer:string; ttlSec:number}): Promise<string>`
  - `signAccessToken(sub: string, issuer: string, ttlSec?: number): Promise<string>` (aud `"userinfo"`)
  - `verifyUserinfoToken(token: string, issuer: string): Promise<{sub:string}>` (throws unless valid + `aud:"userinfo"`)

- [ ] **Step 1: Write the failing test**

Create `gateway-type1/lib/services/__tests__/platform-oidc-tokens.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import * as jwt from 'jsonwebtoken';
import { signIdToken, signAccessToken, verifyUserinfoToken } from '../platform-oidc-tokens';
import { getPlatformOidcKeys } from '../platform-oidc-keys';

const ISS = 'https://api.test.local';

test('id_token carries sub/aud/iss/nonce + scoped claims, verifies under the platform key', async () => {
  const tok = await signIdToken({ sub: 'u1', email: 'a@b.c', email_verified: true, name: 'A', nonce: 'n1' }, { aud: 'client-x', issuer: ISS, ttlSec: 900 });
  const k = await getPlatformOidcKeys();
  const c = jwt.verify(tok, k.publicPem, { algorithms: ['RS256'], audience: 'client-x', issuer: ISS }) as any;
  assert.strictEqual(c.sub, 'u1'); assert.strictEqual(c.email, 'a@b.c'); assert.strictEqual(c.nonce, 'n1');
});

test('access token is userinfo-scoped and verifyUserinfoToken accepts it', async () => {
  const at = await signAccessToken('u1', ISS, 600);
  const r = await verifyUserinfoToken(at, ISS);
  assert.strictEqual(r.sub, 'u1');
});

test('verifyUserinfoToken REJECTS an id_token (wrong aud)', async () => {
  const idt = await signIdToken({ sub: 'u1' }, { aud: 'client-x', issuer: ISS, ttlSec: 900 });
  await assert.rejects(() => verifyUserinfoToken(idt, ISS));
});
```

- [ ] **Step 2: Run — expect fail** (`npx tsx --test lib/services/__tests__/platform-oidc-tokens.test.ts` → module not found).

- [ ] **Step 3: Implement**

Create `gateway-type1/lib/services/platform-oidc-tokens.ts`:
```ts
import * as jwt from 'jsonwebtoken';
import { getPlatformOidcKeys } from './platform-oidc-keys';

export async function signIdToken(
  claims: { sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string; nonce?: string },
  opts: { aud: string; issuer: string; ttlSec: number },
): Promise<string> {
  const k = await getPlatformOidcKeys();
  const payload: Record<string, unknown> = { sub: claims.sub };
  if (claims.email !== undefined) { payload.email = claims.email; payload.email_verified = !!claims.email_verified; }
  if (claims.name) payload.name = claims.name;
  if (claims.picture) payload.picture = claims.picture;
  if (claims.nonce) payload.nonce = claims.nonce;
  return jwt.sign(payload, k.privatePem, { algorithm: 'RS256', keyid: k.kid, audience: opts.aud, issuer: opts.issuer, subject: claims.sub, expiresIn: opts.ttlSec } as jwt.SignOptions);
}

export async function signAccessToken(sub: string, issuer: string, ttlSec = 600): Promise<string> {
  const k = await getPlatformOidcKeys();
  return jwt.sign({ sub }, k.privatePem, { algorithm: 'RS256', keyid: k.kid, audience: 'userinfo', issuer, subject: sub, expiresIn: ttlSec } as jwt.SignOptions);
}

export async function verifyUserinfoToken(token: string, issuer: string): Promise<{ sub: string }> {
  const k = await getPlatformOidcKeys();
  const c = jwt.verify(token, k.publicPem, { algorithms: ['RS256'], audience: 'userinfo', issuer }) as jwt.JwtPayload;
  return { sub: String(c.sub) };
}
```

- [ ] **Step 4: Run — expect pass** (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add gateway-type1/lib/services/platform-oidc-tokens.ts gateway-type1/lib/services/__tests__/platform-oidc-tokens.test.ts
git commit -m "feat(gateway-type1): platform OIDC id_token + userinfo-scoped access token (RS256, non-api_keys)"
```

---

### Task 4: `oidc_clients` store

**Files:**
- Create: `gateway-type1/lib/oidc/client-store.ts`
- Test: `gateway-type1/lib/oidc/__tests__/client-store.test.ts`

**Interfaces:**
- Produces:
  - `type OidcClient = { clientId:string; clientSecretHash:string; redirectUris:string[]; name:string }`
  - `getOidcClient(clientId:string): Promise<OidcClient|null>`
  - `redirectAllowed(client:OidcClient, redirectUri:string): boolean`
  - `seedOidcClient(input:{clientId:string; clientSecret:string; redirectUris:string[]; name:string}): Promise<void>` (upsert; stores `sha256(secret)`)

- [ ] **Step 1: Write the failing test**

Create `gateway-type1/lib/oidc/__tests__/client-store.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { seedOidcClient, getOidcClient, redirectAllowed } from '../client-store';
import { PostgresClient } from '@langmart/shared-db';

test('seed → get round-trips; redirect allow-list is exact', async () => {
  await seedOidcClient({ clientId: 'test-cli', clientSecret: 's3cr3t', redirectUris: ['https://ok/cb'], name: 'T' });
  const c = await getOidcClient('test-cli');
  assert.ok(c); assert.strictEqual(c!.name, 'T');
  assert.strictEqual(redirectAllowed(c!, 'https://ok/cb'), true);
  assert.strictEqual(redirectAllowed(c!, 'https://evil/cb'), false);
  await PostgresClient.getInstance().query(`DELETE FROM oidc_clients WHERE client_id='test-cli'`);
});
test('missing client → null', async () => { assert.strictEqual(await getOidcClient('nope-xyz'), null); });
```

- [ ] **Step 2: Run — expect fail.**

- [ ] **Step 3: Implement**

Create `gateway-type1/lib/oidc/client-store.ts`:
```ts
import { createHash } from 'crypto';
import { PostgresClient } from '@langmart/shared-db';

export type OidcClient = { clientId: string; clientSecretHash: string; redirectUris: string[]; name: string };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function getOidcClient(clientId: string): Promise<OidcClient | null> {
  const r = await PostgresClient.getInstance().query(
    `SELECT client_id, client_secret_hash, redirect_uris, name FROM oidc_clients WHERE client_id=$1`, [clientId]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { clientId: row.client_id, clientSecretHash: row.client_secret_hash, redirectUris: row.redirect_uris, name: row.name };
}
export function redirectAllowed(client: OidcClient, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri);
}
export async function seedOidcClient(input: { clientId: string; clientSecret: string; redirectUris: string[]; name: string }): Promise<void> {
  await PostgresClient.getInstance().query(
    `INSERT INTO oidc_clients (client_id, client_secret_hash, redirect_uris, name) VALUES ($1,$2,$3,$4)
     ON CONFLICT (client_id) DO UPDATE SET client_secret_hash=EXCLUDED.client_secret_hash, redirect_uris=EXCLUDED.redirect_uris, name=EXCLUDED.name`,
    [input.clientId, sha256(input.clientSecret), input.redirectUris, input.name]);
}
export { sha256 as sha256Hex };
```

- [ ] **Step 4: Run — expect pass. Step 5: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add gateway-type1/lib/oidc/client-store.ts gateway-type1/lib/oidc/__tests__/client-store.test.ts
git commit -m "feat(gateway-type1): oidc_clients store (controlled registry, no open DCR)"
```

---

### Task 5: The OIDC provider router

**Files:**
- Create: `gateway-type1/lib/routes/oidc-provider.ts`
- Modify: `gateway-type1/lib/app.ts` (mount, before line 543)
- Test: `gateway-type1/lib/routes/__tests__/oidc-provider.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4 + `optionalAuth` from `@langmart/shared-auth` (`shared/auth/src/auth.ts:851`, standard `(req,res,next)` middleware that sets `req.user` when a valid `langmart_session`/Bearer is present, else leaves it undefined and calls next).
- Produces: `oidcProviderRouter` (default export). Endpoints: `GET /.well-known/openid-configuration`, `GET /v1/auth/oidc/jwks.json`, `GET /v1/auth/oidc/authorize`, `POST /v1/auth/oidc/token`, `GET|POST /v1/auth/oidc/userinfo`. Exports `pkceOk(verifier,challenge):boolean` for unit test.

- [ ] **Step 1: Write the failing test** (the pure PKCE + discovery pieces; the session/bounce path is covered by the Task 8 e2e)

Create `gateway-type1/lib/routes/__tests__/oidc-provider.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash, randomBytes } from 'crypto';
import { pkceOk } from '../oidc-provider';

const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');

test('pkceOk true for a matching S256 pair, false otherwise', () => {
  const v = b64url(randomBytes(32));
  const c = b64url(createHash('sha256').update(v).digest());
  assert.strictEqual(pkceOk(v, c), true);
  assert.strictEqual(pkceOk(v, c.slice(0, -2) + 'xx'), false);
});
```

- [ ] **Step 2: Run — expect fail.**

- [ ] **Step 3: Implement the router**

Create `gateway-type1/lib/routes/oidc-provider.ts`:
```ts
import { Router, Request, Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import { optionalAuth } from '../middleware/auth';
import { PostgresClient } from '@langmart/shared-db';
import { getPlatformJwks } from '../services/platform-oidc-keys';
import { signIdToken, signAccessToken, verifyUserinfoToken } from '../services/platform-oidc-tokens';
import { getOidcClient, redirectAllowed, sha256Hex } from '../oidc/client-store';

const ISSUER = (process.env.PLATFORM_OIDC_ISSUER || 'https://api.xeenhub.com').replace(/\/$/, '');
const AUTHZ = `${ISSUER}/v1/auth/oidc/authorize`;
const TOKEN = `${ISSUER}/v1/auth/oidc/token`;
const USERINFO = `${ISSUER}/v1/auth/oidc/userinfo`;
const JWKS = `${ISSUER}/v1/auth/oidc/jwks.json`;
const WEB_LOGIN = (process.env.LANGMART_WEB_URL || 'https://xeenhub.com');
const ID_TTL = 15 * 60;

const router = Router();

export function pkceOk(verifier: string, challenge: string): boolean {
  const h = createHash('sha256').update(verifier).digest('base64').replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
  return h === challenge;
}

interface Code { userId: string; clientId: string; redirectUri: string; challenge: string; scope: string; nonce?: string; exp: number; }
const codes = new Map<string, Code>();
setInterval(() => { const n = Date.now(); for (const [k, v] of codes) if (v.exp < n) codes.delete(k); }, 60_000).unref();

router.get('/.well-known/openid-configuration', (_req, res) => {
  res.json({
    issuer: ISSUER, authorization_endpoint: AUTHZ, token_endpoint: TOKEN, userinfo_endpoint: USERINFO, jwks_uri: JWKS,
    response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
    grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'], scopes_supported: ['openid', 'profile', 'email'],
    claims_supported: ['sub', 'email', 'email_verified', 'name', 'picture'],
  });
});

router.get('/v1/auth/oidc/jwks.json', async (_req, res) => { res.json(await getPlatformJwks()); });

router.get('/v1/auth/oidc/authorize', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, scope, state, nonce } = req.query as Record<string, string | undefined>;
    if (response_type !== 'code') { res.status(400).send('invalid response_type'); return; }
    if (!client_id) { res.status(400).send('client_id required'); return; }
    const client = await getOidcClient(client_id);
    if (!client) { res.status(400).send('unknown client'); return; }
    if (!redirect_uri || !redirectAllowed(client, redirect_uri)) { res.status(400).send('redirect_uri not registered'); return; }
    if (!code_challenge || code_challenge_method !== 'S256') { res.status(400).send('PKCE S256 required'); return; }

    const userId = (req as any).user?.id as string | undefined;
    if (!userId) {
      // Not logged in — bounce through the existing web login, returning here.
      const here = `${AUTHZ}?${new URLSearchParams(req.query as Record<string, string>).toString()}`;
      res.redirect(302, `${WEB_LOGIN}/mcp-redirect?return=${encodeURIComponent(here)}`);
      return;
    }
    const code = randomBytes(32).toString('hex');
    codes.set(code, { userId, clientId: client_id, redirectUri: redirect_uri, challenge: code_challenge, scope: scope || 'openid', nonce, exp: Date.now() + 10 * 60 * 1000 });
    const cb = new URL(redirect_uri); cb.searchParams.set('code', code); if (state) cb.searchParams.set('state', state);
    res.redirect(302, cb.toString());
  } catch (e) { res.status(500).send('server_error: ' + (e instanceof Error ? e.message : String(e))); }
});

router.post('/v1/auth/oidc/token', async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (b.grant_type !== 'authorization_code') { res.status(400).json({ error: 'unsupported_grant_type' }); return; }
    const client = await getOidcClient(b.client_id || '');
    if (!client || sha256Hex(b.client_secret || '') !== client.clientSecretHash) { res.status(401).json({ error: 'invalid_client' }); return; }
    const entry = codes.get(b.code || '');
    if (!entry || entry.exp < Date.now()) { res.status(400).json({ error: 'invalid_grant', error_description: 'unknown or expired code' }); return; }
    codes.delete(b.code);
    if (entry.clientId !== b.client_id || entry.redirectUri !== b.redirect_uri) { res.status(400).json({ error: 'invalid_grant', error_description: 'client/redirect mismatch' }); return; }
    if (!pkceOk(b.code_verifier || '', entry.challenge)) { res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE mismatch' }); return; }

    const u = (await PostgresClient.getInstance().query(`SELECT id,email,email_verified,display_name,avatar_url FROM users WHERE id=$1`, [entry.userId])).rows[0] || {};
    const scopes = entry.scope.split(' ');
    const idToken = await signIdToken({
      sub: entry.userId,
      email: scopes.includes('email') ? u.email : undefined,
      email_verified: scopes.includes('email') ? !!u.email_verified : undefined,
      name: scopes.includes('profile') ? u.display_name : undefined,
      picture: scopes.includes('profile') ? u.avatar_url : undefined,
      nonce: entry.nonce,
    }, { aud: entry.clientId, issuer: ISSUER, ttlSec: ID_TTL });
    const accessToken = await signAccessToken(entry.userId, ISSUER, 600);
    res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 600, id_token: idToken, scope: entry.scope });
  } catch (e) { res.status(500).json({ error: 'server_error', error_description: e instanceof Error ? e.message : String(e) }); }
});

const userinfo = async (req: Request, res: Response) => {
  try {
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    const { sub } = await verifyUserinfoToken(bearer, ISSUER);
    const u = (await PostgresClient.getInstance().query(`SELECT id,email,email_verified,display_name,avatar_url FROM users WHERE id=$1`, [sub])).rows[0];
    if (!u) { res.status(401).json({ error: 'invalid_token' }); return; }
    res.json({ sub: u.id, email: u.email, email_verified: !!u.email_verified, name: u.display_name || undefined, picture: u.avatar_url || undefined });
  } catch { res.status(401).json({ error: 'invalid_token' }); }
};
router.get('/v1/auth/oidc/userinfo', userinfo);
router.post('/v1/auth/oidc/userinfo', userinfo);

export default router;
```
> Note: import `optionalAuth` from `'../middleware/auth'` (gateway-type1 re-exports the shared-auth middleware there, same as `authenticate`). Confirm the users column names (`display_name`, `avatar_url`, `email_verified`) against `callback.ts`'s SELECT — they match the inventory.

- [ ] **Step 4: Mount in app.ts**

Edit `gateway-type1/lib/app.ts` — after `app.use(oauthMcpRouter);` (line 504) add:
```ts
import oidcProviderRouter from './routes/oidc-provider';
app.use(oidcProviderRouter);
```
(Mounted before `app.use('/v1', authenticate)` at line 543, so `/v1/auth/oidc/*` is handled publicly here first.)

- [ ] **Step 5: Run the pkce test + build**

Run: `cd gateway-type1 && npx tsx --test lib/routes/__tests__/oidc-provider.test.ts` → pass; `npm run build` → clean.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add gateway-type1/lib/routes/oidc-provider.ts gateway-type1/lib/routes/__tests__/oidc-provider.test.ts gateway-type1/lib/app.ts
git commit -m "feat(gateway-type1): whole-site OIDC provider router (authorize-over-session, JWT-only tokens)"
```

---

### Task 6: Deprecate the MCP-AS OIDC

**Files:**
- Modify: `gateway-type1/lib/routes/oauth-mcp.ts` (remove the OIDC additions from `7dfa6cbe`)
- Delete: `gateway-type1/lib/services/oidc-keys.ts`

**Interfaces:** none new. Reverts `oauth-mcp.ts` to a pure connector-token AS.

- [ ] **Step 1: Remove the OIDC code from oauth-mcp.ts**

In `gateway-type1/lib/routes/oauth-mcp.ts` remove exactly these (verify by re-reading; anchors as of this plan):
- the import `import { getJwks, signIdToken } from '../services/oidc-keys';` (line ~31)
- `const ID_TOKEN_TTL_SEC = ...` (line ~60)
- from the `/.well-known/oauth-authorization-server` handler, revert `scopes_supported` to `['mcp:read','mcp:write']` and DELETE the added `jwks_uri` line (~177-178)
- the entire `router.get('/.well-known/openid-configuration', ...)` handler (~193-210)
- the entire `router.get('/.well-known/jwks.json', ...)` handler (~212)
- `async function mintIdToken(...)` (~221-243)
- the `userinfoHandler` + `router.get/post('/oauth/userinfo', ...)` (~245-281)
- in `/oauth/token`, the block `let idToken ...; if (entry.scope.split(' ').includes('openid')) { idToken = await mintIdToken(...) }` and the `...(idToken ? { id_token: idToken } : {})` spread in the response (~536-548) — restore the response to `{ access_token, token_type, expires_in, refresh_token, scope }`.

- [ ] **Step 2: Delete the now-orphaned key service**

Run: `git rm gateway-type1/lib/services/oidc-keys.ts` (only `oauth-mcp.ts` imported it — confirm with `grep -rn "services/oidc-keys" gateway-type1/lib` → no hits after Step 1).

- [ ] **Step 3: Build + confirm connector flow intact**

Run: `cd gateway-type1 && npm run build` → clean. Grep the compiled `dist/lib/routes/oauth-mcp.js` for `openid` → should be gone; for `mcp:read` → still present.

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add gateway-type1/lib/routes/oauth-mcp.ts gateway-type1/lib/services/oidc-keys.ts
git commit -m "refactor(oauth-mcp): remove the OIDC layer — MCP AS is connector-tokens only again"
```

---

### Task 7: Repoint the UI gateway + seed its client

**Files:**
- Modify: `ui-gateway/.env` (`OIDC_ISSUER`)
- Create: `gateway-type1/scripts/seed-oidc-client.ts` (admin seeding helper)

**Interfaces:** Consumes `seedOidcClient` (Task 4).

- [ ] **Step 1: Seed the gateway's OIDC client**

Create `gateway-type1/scripts/seed-oidc-client.ts`:
```ts
import { randomBytes } from 'crypto';
import { seedOidcClient } from '../lib/oidc/client-store';
(async () => {
  const clientId = process.argv[2] || 'ui-gateway';
  const redirect = process.argv[3] || 'http://10.0.1.117:8087/auth/callback';
  const secret = randomBytes(24).toString('hex');
  await seedOidcClient({ clientId, clientSecret: secret, redirectUris: [redirect, 'http://localhost:8087/auth/callback'], name: 'UI Gateway' });
  console.log(`SEEDED client_id=${clientId}\nclient_secret=${secret}\nredirect=${redirect}`);
  process.exit(0);
})();
```
Run: `cd gateway-type1 && npx tsx scripts/seed-oidc-client.ts ui-gateway http://10.0.1.117:8087/auth/callback` — record the printed `client_secret`.

- [ ] **Step 2: Repoint ui-gateway/.env**

Edit `ui-gateway/.env`: set `OIDC_ISSUER=https://api.xeenhub.com`, `UI_GATEWAY_CLIENT_ID=ui-gateway`, `UI_GATEWAY_CLIENT_SECRET=<the seeded secret>`.

- [ ] **Step 3: Restart both, verify discovery on the new issuer**

Run:
```bash
cd /home/ubuntu/LangMartDesign
npm run build --prefix gateway-type1 && ./core.sh restart 1
./core.sh restart ui-gateway
curl -s https://api.xeenhub.com/.well-known/openid-configuration | python3 -c "import json,sys;d=json.load(sys.stdin);print('issuer',d['issuer']);print('authz',d['authorization_endpoint'])"
```
Expected: issuer `https://api.xeenhub.com`, authz `…/v1/auth/oidc/authorize`.

- [ ] **Step 4: Commit** (`.env` is gitignored — commit only the script)

```bash
cd /home/ubuntu/LangMartDesign
git add gateway-type1/scripts/seed-oidc-client.ts
git commit -m "feat(gateway-type1): admin seeder for oidc_clients; repoint ui-gateway (.env, untracked)"
```

---

### Task 8: E2E — login + structural fence + MCP quarantine

**Files:**
- Create: `gateway-type1/e2e/oidc-provider.e2e.ts`

**Interfaces:** Consumes the running gateway-type1 (`api.xeenhub.com`), ui-gateway (`:8087`), and the seeded `ui-gateway` client.

- [ ] **Step 1: Write the e2e script**

Create `gateway-type1/e2e/oidc-provider.e2e.ts` that, using `fetch` + a manual PKCE:
1. **discovery + jwks** from `https://api.xeenhub.com` resolve; jwks has an RS256 key.
2. **login e2e via ui-gateway** (repointed): drive `http://10.0.1.117:8087/auth/login` through the redirect chain (the gateway now bounces to `api.xeenhub.com/v1/auth/oidc/authorize`). To make it non-interactive, seed a `langmart_session` for the test user by minting an `sk-session` key for that user (mirror `callback.ts`'s `createSessionKey`) OR reuse the ui-gateway bound-client test path against the NEW issuer. Assert the ui-gateway `/auth/me` returns the test user after callback.
3. **structural fence A/B:** obtain a platform `access_token` (run the authorize+token flow directly with the seeded client, a `langmart_session` cookie, and PKCE). Assert `GET api.xeenhub.com/v1/auth/oidc/userinfo` with it → 200 + correct `sub`; assert `GET api.xeenhub.com/api/keys` (a real authed route) with the SAME token → **401** (the keystone can't validate a platform JWT). This is the headline proof.
4. **MCP quarantine:** `POST mcp.xeenhub.com/oauth/token` (existing connector client) still returns an `mcp:read/write` access token with NO `id_token` even when `scope=openid` is requested; and `mcp.xeenhub.com/oauth/token`'s response has no `id_token` key.

Run: `cd gateway-type1 && npx tsx e2e/oidc-provider.e2e.ts` — all assertions pass. (Full runnable code is written during this task using the ui-gateway e2e in `ui-gateway/src/e2e/flow.test.ts` and the login driver pattern as references; the seeding of a `langmart_session` for the test user is the one new piece — read `callback.ts:176` `createSessionKey` for the exact insert.)

- [ ] **Step 2: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add gateway-type1/e2e/oidc-provider.e2e.ts
git commit -m "test(gateway-type1): e2e — OIDC login, structural /api fence, MCP quarantine"
```

---

## Self-Review

**Spec coverage:** §1 problem → Tasks 5+6 (provider + MCP removal). §2 decision A → Task 5. §3 components → Tasks 2 (keys), 5 (router). §4 authorize-over-session → Task 5 authorize handler (`optionalAuth` + bounce). §5 token JWT-only fence → Task 3 + Task 5 token handler + Task 8 A/B. §6 clients → Task 4 + Task 7 seeding. §7 deprecate MCP OIDC → Task 6. §8 schema → Task 1. §9 errors → Task 5 handlers. §10 testing → Tasks 2–5 unit + Task 8 e2e. §11 deployment → Task 7 + a follow-up SG deploy (out of this plan's dev scope). ✓ all covered.

**Placeholder scan:** Task 8 Step 1 describes the e2e in prose rather than a full code block — deliberate: the `langmart_session` seeding depends on reading `callback.ts:176` for the exact `createSessionKey` insert, which the implementer does in-task. The three assertions and their expected results are concrete. All other steps carry complete code.

**Type consistency:** `getPlatformOidcKeys(){kid,privatePem,publicPem}` consistent (Tasks 2,3). `signIdToken/signAccessToken/verifyUserinfoToken` signatures match between Task 3 def and Task 5 use. `OidcClient{clientId,clientSecretHash,redirectUris,name}` + `getOidcClient/redirectAllowed/seedOidcClient/sha256Hex` consistent (Tasks 4,5,7). `PLATFORM_OIDC_ISSUER` used identically in Task 5 + Task 8.

**Deviations to flag at execution:** (1) the not-logged-in bounce reuses `LANGMART_WEB_URL/mcp-redirect` — confirm that page returns to an arbitrary `return` URL (it does for MCP); if it is MCP-specific, use the platform login entry the web app exposes. (2) `optionalAuth` import path (`../middleware/auth`) — confirm gateway-type1 re-exports it there like `authenticate`.
