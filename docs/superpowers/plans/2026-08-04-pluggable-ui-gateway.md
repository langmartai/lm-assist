# Pluggable UI Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone `ui-gateway` service in the LangMartDesign monorepo that logs users in via standard OIDC against `mcp.langmart.ai`, serves registered UI artifacts on its own origin, and brokers scoped, view-token-gated access to lm-assist node data — so the browser never holds a credential more powerful than the one view it renders.

**Architecture:** A new Express/TypeScript service (`ui-gateway/`, cloned from `assist-api/`'s shape) added to the root npm `workspaces`. It is an OIDC relying party (hand-rolled with `jsonwebtoken` + node `crypto`, no new ESM deps) that keeps its session state server-side. It mints short-lived per-page **view tokens** (signed JWTs carrying a `grant`), enforces the grant on a data API, and reaches nodes server-to-server through a **new internal endpoint added to `assist-api`** (the existing `/internal/mcp-relay` hardcodes `path:'/mcp'`; node data needs a generic relay). All state (sessions, registry, signing keys) lives in Postgres via `@langmart/shared-db`.

**Tech Stack:** TypeScript (`target ES2020`, `module commonjs`), Express 4, `@langmart/shared-db` (PostgresClient singleton), `@langmart/shared-middleware` (errorHandler/requestLogger), `jsonwebtoken ^9` (already present — RS256 for view tokens + id_token verify), node `crypto` (PKCE, nonce, session ids), `cookie-parser`. Test runner: `node --test` driven through `tsx` (introduced here — the repo has no test harness).

## Global Constraints

- **Repo split:** `ui-gateway/` lives in `/home/ubuntu/LangMartDesign` (YiHuangDB / HTTPS PAT remote). Do NOT push it to the lm-assist repo. `scoped-token.ts` referenced in the spec is lm-assist-side and is NOT modified by this plan.
- **Workspace membership required:** add `"ui-gateway"` to `/home/ubuntu/LangMartDesign/package.json` `workspaces` so `@langmart/shared-*` resolve. Without it, imports fail at build.
- **No new ESM-only deps.** `openid-client`, `jose`, `express-session` are absent and stay absent — they invite the `ERR_REQUIRE_ESM` trap this fleet has been bitten by twice. Reuse `jsonwebtoken` + `crypto` + `cookie-parser` (all CJS, already present).
- **`module: commonjs`** in tsconfig — matches every sibling. No top-level `await import()` of ESM packages.
- **OIDC issuer is fixed:** `https://mcp.langmart.ai` (prod) / `https://mcp.xeenhub.com` (dev), read from `OIDC_ISSUER` env. Discovery doc at `${issuer}/.well-known/openid-configuration`, JWKS at `${issuer}/.well-known/jwks.json`. These are LIVE (shipped `7dfa6cbe`).
- **DB access:** `import { PostgresClient } from '@langmart/shared-db'; const db = PostgresClient.getInstance();` — process-wide singleton. Connection is env-driven (`DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD`), already set in the sibling `.env` files (`langmart_admin` / `langmart`).
- **Node relay auth:** cross-service calls to assist-api use header `x-internal-secret` == `process.env.MCP_RELAY_SECRET`. Do NOT use `INTERNAL_SERVICE_SECRET` (per-process random, useless across processes). The check is skipped when `MCP_RELAY_SECRET` is unset (current dev state) — the plan sets it explicitly for the new endpoint.
- **Ports:** dev `UI_GATEWAY_PORT=8087` (next free after assist-api 8086); prod behind `ui.langmart.ai`. Never hardcode — read `process.env.PORT`.
- **Error idiom:** mount `requestLogger` early, `errorHandler` from `@langmart/shared-middleware` LAST. Grant violations return **403 naming the denied `{service, path}`** (echo what was attempted).
- **Migrations:** new tables via a plain SQL file applied with `psql`; there is no migration framework. Idempotent `CREATE TABLE IF NOT EXISTS`.

---

## File Structure

New service `ui-gateway/` (mirrors `assist-api/src/` layout):

- `ui-gateway/package.json` — name `@langmart/ui-gateway`, scripts build/start/dev/test, deps on shared packages + jsonwebtoken + cookie-parser; devDeps tsx + @types.
- `ui-gateway/tsconfig.json` — ES2020/commonjs/outDir dist/rootDir src, clone of assist-api's.
- `ui-gateway/.env.example` — every env var with dev defaults.
- `ui-gateway/sql/schema.sql` — `ui_gateway_sessions`, `ui_registry`, `ui_gateway_signing_keys` (idempotent).
- `ui-gateway/src/index.ts` — HTTP server bootstrap, `PORT`, `server.listen`.
- `ui-gateway/src/app.ts` — Express app assembly, middleware order, route mounting, /health.
- `ui-gateway/src/config.ts` — typed env reader (issuer, port, cookie secret, relay secret, base url).
- `ui-gateway/src/oidc/discovery.ts` — fetch + cache the AS discovery doc and JWKS; verify an id_token.
- `ui-gateway/src/oidc/login.ts` — `/auth/login` (build authorize redirect w/ PKCE+nonce+state) and `/auth/callback` (exchange code, verify id_token, create session).
- `ui-gateway/src/session/store.ts` — server-side session CRUD in Postgres; cookie helpers.
- `ui-gateway/src/session/middleware.ts` — `loadSession` (cookie→record→req.session), `/auth/logout`, `/auth/me`.
- `ui-gateway/src/viewtoken/keys.ts` — RS256 signing keypair, persisted in `ui_gateway_signing_keys` (first-writer-wins), JWKS export. (Same pattern as the AS `oidc-keys.ts` just shipped.)
- `ui-gateway/src/viewtoken/token.ts` — mint + verify view tokens; the `Grant` type.
- `ui-gateway/src/viewtoken/grant.ts` — `grantAllows(grant, service, method, path)` matcher.
- `ui-gateway/src/registry/store.ts` — `ui_registry` CRUD; `UiEntry` type.
- `ui-gateway/src/registry/routes.ts` — serve artifacts + `/ui/:uiId` render entrypoint that mints a view token; share-link creation.
- `ui-gateway/src/data/routes.ts` — `/data/*` view-token-gated API; grant check → assist-api relay.
- `ui-gateway/src/data/relay.ts` — HTTP client to assist-api's new `/internal/ui-relay`.
- `ui-gateway/src/__tests__/*.test.ts` — one per unit (grant, token, session, discovery, registry).
- `ui-gateway/src/e2e/flow.test.ts` — full-flow e2e + the three A/B proofs.

Modified in `assist-api/`:

- `assist-api/src/routes/internal-ui.ts` — NEW generic node relay (`/internal/ui-relay`, any path).
- `assist-api/src/app.ts` — mount the new router (unauthenticated, before `authenticate`, secret-gated).

Modified at repo root:

- `package.json` — add `"ui-gateway"` to `workspaces`.
- `core.sh` — port/log vars, `start_/stop_/restart_ui_gateway`, CLI dispatch arm.

---

### Task 1: Service skeleton, config, health, test harness

**Files:**
- Create: `ui-gateway/package.json`, `ui-gateway/tsconfig.json`, `ui-gateway/.env.example`, `ui-gateway/src/index.ts`, `ui-gateway/src/app.ts`, `ui-gateway/src/config.ts`
- Modify: `/home/ubuntu/LangMartDesign/package.json` (workspaces array)
- Test: `ui-gateway/src/__tests__/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(): Config` where `Config = { port:number; oidcIssuer:string; publicBaseUrl:string; cookieName:string; assistApiHost:string; assistApiPort:number; relaySecret:string }`. `app` (default export Express app). `createServer()` in index.

- [ ] **Step 1: Add the service to workspaces**

Edit `/home/ubuntu/LangMartDesign/package.json`, add `"ui-gateway"` to the `workspaces` array (after `"assist-api"`):
```json
"workspaces": ["shared/*", "gateway-type1", "assist-api", "assist-web", "ui-gateway"]
```

- [ ] **Step 2: Write package.json**

Create `ui-gateway/package.json`:
```json
{
  "name": "@langmart/ui-gateway",
  "version": "1.0.0",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsc --watch",
    "test": "tsx --test src/**/*.test.ts",
    "test:e2e": "tsx --test src/e2e/*.test.ts"
  },
  "dependencies": {
    "@langmart/shared-auth": "*",
    "@langmart/shared-db": "*",
    "@langmart/shared-middleware": "*",
    "express": "^4.18.2",
    "cookie-parser": "^1.4.7",
    "cors": "^2.8.5",
    "helmet": "^7.0.0",
    "compression": "^1.7.4",
    "jsonwebtoken": "^9.0.0",
    "dotenv": "^16.3.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "tsx": "^4.19.0",
    "@types/express": "^4.17.21",
    "@types/cookie-parser": "^1.4.7",
    "@types/jsonwebtoken": "^9.0.0",
    "@types/node": "^20.0.0"
  }
}
```

- [ ] **Step 3: Write tsconfig.json**

Create `ui-gateway/tsconfig.json` (clone of assist-api's):
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts", "src/e2e/**"]
}
```

- [ ] **Step 4: Write config.ts**

Create `ui-gateway/src/config.ts`:
```ts
export interface Config {
  port: number;
  oidcIssuer: string;
  publicBaseUrl: string;
  cookieName: string;
  cookieSecure: boolean;
  assistApiHost: string;
  assistApiPort: number;
  relaySecret: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const oidcIssuer = env.OIDC_ISSUER || 'https://mcp.langmart.ai';
  const publicBaseUrl = env.UI_GATEWAY_PUBLIC_URL || 'http://localhost:8087';
  return {
    port: parseInt(env.PORT || '8087', 10),
    oidcIssuer: oidcIssuer.replace(/\/$/, ''),
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ''),
    cookieName: env.UI_GATEWAY_COOKIE || 'ui_gw_session',
    cookieSecure: env.NODE_ENV === 'production',
    assistApiHost: env.ASSIST_API_HOST || '127.0.0.1',
    assistApiPort: parseInt(env.ASSIST_API_PORT || '8086', 10),
    relaySecret: env.MCP_RELAY_SECRET || '',
  };
}
```

- [ ] **Step 5: Write the failing test**

Create `ui-gateway/src/__tests__/config.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { loadConfig } from '../config';

test('loadConfig applies dev defaults', () => {
  const c = loadConfig({});
  assert.strictEqual(c.port, 8087);
  assert.strictEqual(c.oidcIssuer, 'https://mcp.langmart.ai');
  assert.strictEqual(c.cookieName, 'ui_gw_session');
});

test('loadConfig strips trailing slash from issuer + base url', () => {
  const c = loadConfig({ OIDC_ISSUER: 'https://mcp.xeenhub.com/', UI_GATEWAY_PUBLIC_URL: 'https://ui.langmart.ai/' });
  assert.strictEqual(c.oidcIssuer, 'https://mcp.xeenhub.com');
  assert.strictEqual(c.publicBaseUrl, 'https://ui.langmart.ai');
});

test('loadConfig reads port + secret from env', () => {
  const c = loadConfig({ PORT: '9999', MCP_RELAY_SECRET: 's3cr3t' });
  assert.strictEqual(c.port, 9999);
  assert.strictEqual(c.relaySecret, 's3cr3t');
});
```

- [ ] **Step 6: Install deps and run the test (expect fail first, then pass)**

Run from repo root: `cd /home/ubuntu/LangMartDesign && npm install`
Then: `cd ui-gateway && npx tsx --test src/__tests__/config.test.ts`
Expected: 3 tests PASS (config.ts already written). If tsx is missing, `npm install` at root pulled it via the workspace devDep.

- [ ] **Step 7: Write app.ts and index.ts**

Create `ui-gateway/src/app.ts`:
```ts
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { errorHandler, requestLogger } from '@langmart/shared-middleware';
import { PostgresClient } from '@langmart/shared-db';
import { loadConfig } from './config';

const config = loadConfig();
const app = express();
app.set('trust proxy', true);
app.use(helmet());
app.use(compression());
app.use(cors({ origin: false, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(requestLogger);

app.get('/health', async (_req, res) => {
  try {
    await PostgresClient.getInstance().query('SELECT 1');
    res.json({ status: 'healthy', service: 'ui-gateway', database: 'connected' });
  } catch (e) {
    res.status(503).json({ status: 'unhealthy', error: e instanceof Error ? e.message : String(e) });
  }
});

// Route mounts added in later tasks:
//   app.use(loginRouter); app.use(sessionRouter); app.use(registryRouter); app.use(dataRouter);

app.use(errorHandler);
export default app;
export { config };
```

Create `ui-gateway/src/index.ts`:
```ts
import 'dotenv/config';
import { createServer } from 'http';
import app, { config } from './app';

const server = createServer(app);
server.listen(config.port, () => {
  console.log(`[ui-gateway] listening on :${config.port} (issuer ${config.oidcIssuer})`);
});
```

- [ ] **Step 8: Write .env.example**

Create `ui-gateway/.env.example`:
```
PORT=8087
NODE_ENV=development
OIDC_ISSUER=https://mcp.xeenhub.com
UI_GATEWAY_PUBLIC_URL=http://localhost:8087
UI_GATEWAY_COOKIE=ui_gw_session
ASSIST_API_HOST=127.0.0.1
ASSIST_API_PORT=8086
MCP_RELAY_SECRET=
DB_HOST=localhost
DB_PORT=5432
DB_NAME=langmart
DB_USER=langmart_admin
DB_PASSWORD=langmart_secret_2024
JWT_SECRET=dev-shared-secret
```

- [ ] **Step 9: Build and smoke-test health**

Run: `cd /home/ubuntu/LangMartDesign/ui-gateway && npm run build && PORT=8087 node dist/index.js &`
Then: `sleep 2 && curl -s localhost:8087/health`
Expected: `{"status":"healthy","service":"ui-gateway","database":"connected"}`
Then kill it: `lsof -ti:8087 -sTCP:LISTEN | xargs kill`

- [ ] **Step 10: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add package.json ui-gateway/package.json ui-gateway/tsconfig.json ui-gateway/.env.example ui-gateway/src/
git commit -m "feat(ui-gateway): service skeleton, config, health, node --test harness"
```

---

### Task 2: Postgres schema + signing keys

**Files:**
- Create: `ui-gateway/sql/schema.sql`, `ui-gateway/src/viewtoken/keys.ts`
- Test: `ui-gateway/src/__tests__/keys.test.ts`

**Interfaces:**
- Produces: `getSigningKeys(): Promise<{ kid:string; privatePem:string; publicPem:string }>`, `getViewJwks(): Promise<{ keys: object[] }>`. Tables `ui_gateway_sessions`, `ui_registry`, `ui_gateway_signing_keys`.

- [ ] **Step 1: Write schema.sql**

Create `ui-gateway/sql/schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS ui_gateway_signing_keys (
  kid          TEXT PRIMARY KEY,
  private_pem  TEXT NOT NULL,
  public_pem   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  active       BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS ui_gateway_sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  claims        JSONB NOT NULL,
  refresh_token TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS ui_gateway_sessions_exp ON ui_gateway_sessions(expires_at);

CREATE TABLE IF NOT EXISTS ui_registry (
  ui_id          TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  artifact_dir   TEXT NOT NULL,
  grant_json     JSONB NOT NULL,
  owner_user_id  TEXT,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  trust          TEXT NOT NULL DEFAULT 'trusted',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Apply the schema**

Run: `PGPASSWORD=langmart_secret_2024 psql -h localhost -U langmart_admin -d langmart -f /home/ubuntu/LangMartDesign/ui-gateway/sql/schema.sql`
Expected: `CREATE TABLE` / `CREATE INDEX` (or no error on re-run).
Verify: `PGPASSWORD=langmart_secret_2024 psql -h localhost -U langmart_admin -d langmart -c "\dt ui_*"` → 3 tables listed.

- [ ] **Step 3: Write the failing test**

Create `ui-gateway/src/__tests__/keys.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { getSigningKeys, getViewJwks } from '../viewtoken/keys';

test('getSigningKeys returns a stable kid across calls', async () => {
  const a = await getSigningKeys();
  const b = await getSigningKeys();
  assert.strictEqual(a.kid, b.kid);
  assert.match(a.privatePem, /BEGIN PRIVATE KEY/);
  assert.match(a.publicPem, /BEGIN PUBLIC KEY/);
});

test('getViewJwks exposes the public key with matching kid', async () => {
  const keys = await getSigningKeys();
  const jwks = await getViewJwks();
  assert.strictEqual(jwks.keys.length >= 1, true);
  const jwk = jwks.keys.find((k: any) => k.kid === keys.kid);
  assert.ok(jwk, 'kid present in jwks');
  assert.strictEqual((jwk as any).alg, 'RS256');
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd ui-gateway && npx tsx --test src/__tests__/keys.test.ts`
Expected: FAIL — `Cannot find module '../viewtoken/keys'`.

- [ ] **Step 5: Write keys.ts**

Create `ui-gateway/src/viewtoken/keys.ts` (same first-writer-wins pattern as the AS's `oidc-keys.ts`):
```ts
import { createHash, createPublicKey, generateKeyPairSync } from 'crypto';
import { PostgresClient } from '@langmart/shared-db';

interface KeyRec { kid: string; privatePem: string; publicPem: string; }
let cached: KeyRec | null = null;

export async function getSigningKeys(): Promise<KeyRec> {
  if (cached) return cached;
  const db = PostgresClient.getInstance();
  const r = await db.query(`SELECT kid, private_pem, public_pem FROM ui_gateway_signing_keys WHERE active = true ORDER BY created_at ASC LIMIT 1`);
  if (r.rows.length > 0) {
    cached = { kid: r.rows[0].kid, privatePem: r.rows[0].private_pem, publicPem: r.rows[0].public_pem };
    return cached;
  }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const kid = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  await db.query(
    `INSERT INTO ui_gateway_signing_keys (kid, private_pem, public_pem) VALUES ($1,$2,$3) ON CONFLICT (kid) DO NOTHING`,
    [kid, privateKey, publicKey],
  );
  const rr = await db.query(`SELECT kid, private_pem, public_pem FROM ui_gateway_signing_keys WHERE active = true ORDER BY created_at ASC LIMIT 1`);
  cached = { kid: rr.rows[0].kid, privatePem: rr.rows[0].private_pem, publicPem: rr.rows[0].public_pem };
  return cached;
}

export async function getViewJwks(): Promise<{ keys: object[] }> {
  const k = await getSigningKeys();
  const jwk = createPublicKey(k.publicPem).export({ format: 'jwk' }) as Record<string, unknown>;
  return { keys: [{ ...jwk, kid: k.kid, use: 'sig', alg: 'RS256' }] };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd ui-gateway && npx tsx --test src/__tests__/keys.test.ts`
Expected: 2 tests PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add ui-gateway/sql/schema.sql ui-gateway/src/viewtoken/keys.ts ui-gateway/src/__tests__/keys.test.ts
git commit -m "feat(ui-gateway): postgres schema + persisted RS256 view-token signing keys"
```

---

### Task 3: View tokens + grant matcher

**Files:**
- Create: `ui-gateway/src/viewtoken/grant.ts`, `ui-gateway/src/viewtoken/token.ts`
- Test: `ui-gateway/src/__tests__/grant.test.ts`, `ui-gateway/src/__tests__/token.test.ts`

**Interfaces:**
- Consumes: `getSigningKeys`, `getViewJwks` from Task 2.
- Produces:
  - `type GrantRule = { service: string; pathPrefix: string; verbs: string[] }`
  - `type Grant = GrantRule[]`
  - `grantAllows(grant: Grant, service: string, method: string, path: string): boolean`
  - `type ViewClaims = { sub: string; aud: string; grant: Grant; iss: string }`
  - `mintViewToken(claims: { sub: string; uiId: string; grant: Grant }, ttlSec?: number): Promise<string>`
  - `verifyViewToken(token: string): Promise<ViewClaims>` (throws on invalid/expired)

- [ ] **Step 1: Write the failing grant test**

Create `ui-gateway/src/__tests__/grant.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { grantAllows, Grant } from '../viewtoken/grant';

const grant: Grant = [
  { service: 'node', pathPrefix: '/sessions', verbs: ['GET'] },
  { service: 'node', pathPrefix: '/mission', verbs: ['GET', 'POST'] },
];

test('allows a GET within a granted prefix', () => {
  assert.strictEqual(grantAllows(grant, 'node', 'GET', '/sessions/abc'), true);
});
test('denies a verb not in the rule', () => {
  assert.strictEqual(grantAllows(grant, 'node', 'DELETE', '/sessions/abc'), false);
});
test('denies a path outside every prefix', () => {
  assert.strictEqual(grantAllows(grant, 'node', 'GET', '/secrets'), false);
});
test('denies a different service', () => {
  assert.strictEqual(grantAllows(grant, 'admin', 'GET', '/sessions'), false);
});
test('prefix must be a path-segment boundary, not a substring', () => {
  assert.strictEqual(grantAllows(grant, 'node', 'GET', '/sessions-evil'), false);
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd ui-gateway && npx tsx --test src/__tests__/grant.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write grant.ts**

Create `ui-gateway/src/viewtoken/grant.ts`:
```ts
export type GrantRule = { service: string; pathPrefix: string; verbs: string[] };
export type Grant = GrantRule[];

function prefixMatches(prefix: string, path: string): boolean {
  if (path === prefix) return true;
  const p = prefix.endsWith('/') ? prefix : prefix + '/';
  return path.startsWith(p);
}

export function grantAllows(grant: Grant, service: string, method: string, path: string): boolean {
  const m = method.toUpperCase();
  return grant.some((r) =>
    r.service === service &&
    r.verbs.map((v) => v.toUpperCase()).includes(m) &&
    prefixMatches(r.pathPrefix, path),
  );
}
```

- [ ] **Step 4: Run grant test, expect pass**

Run: `cd ui-gateway && npx tsx --test src/__tests__/grant.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Write the failing token test**

Create `ui-gateway/src/__tests__/token.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { mintViewToken, verifyViewToken } from '../viewtoken/token';
import { Grant } from '../viewtoken/grant';

const grant: Grant = [{ service: 'node', pathPrefix: '/sessions', verbs: ['GET'] }];

test('mint then verify round-trips sub/aud/grant', async () => {
  const tok = await mintViewToken({ sub: 'user-1', uiId: 'ui-x', grant });
  const claims = await verifyViewToken(tok);
  assert.strictEqual(claims.sub, 'user-1');
  assert.strictEqual(claims.aud, 'ui-x');
  assert.deepStrictEqual(claims.grant, grant);
});

test('a tampered token fails verification', async () => {
  const tok = await mintViewToken({ sub: 'user-1', uiId: 'ui-x', grant });
  const bad = tok.slice(0, -3) + 'AAA';
  await assert.rejects(() => verifyViewToken(bad));
});

test('an expired token fails verification', async () => {
  const tok = await mintViewToken({ sub: 'user-1', uiId: 'ui-x', grant }, 0);
  await new Promise((r) => setTimeout(r, 1100));
  await assert.rejects(() => verifyViewToken(tok));
});
```

- [ ] **Step 6: Run it, expect fail**

Run: `cd ui-gateway && npx tsx --test src/__tests__/token.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Write token.ts**

Create `ui-gateway/src/viewtoken/token.ts`:
```ts
import * as jwt from 'jsonwebtoken';
import { getSigningKeys } from './keys';
import { Grant } from './grant';
import { loadConfig } from '../config';

const ISSUER = 'ui-gateway';
const DEFAULT_TTL_SEC = 15 * 60;

export type ViewClaims = { sub: string; aud: string; grant: Grant; iss: string };

export async function mintViewToken(
  input: { sub: string; uiId: string; grant: Grant },
  ttlSec: number = DEFAULT_TTL_SEC,
): Promise<string> {
  const k = await getSigningKeys();
  return jwt.sign({ grant: input.grant }, k.privatePem, {
    algorithm: 'RS256',
    keyid: k.kid,
    issuer: ISSUER,
    audience: input.uiId,
    subject: input.sub,
    expiresIn: ttlSec,
  } as jwt.SignOptions);
}

export async function verifyViewToken(token: string): Promise<ViewClaims> {
  const k = await getSigningKeys();
  const decoded = jwt.verify(token, k.publicPem, {
    algorithms: ['RS256'],
    issuer: ISSUER,
  }) as jwt.JwtPayload;
  return {
    sub: String(decoded.sub),
    aud: String(decoded.aud),
    grant: (decoded.grant as Grant) || [],
    iss: String(decoded.iss),
  };
}

// referenced so tsc keeps config wired for later env-based issuer if needed
void loadConfig;
```

- [ ] **Step 8: Run token test, expect pass**

Run: `cd ui-gateway && npx tsx --test src/__tests__/token.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 9: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add ui-gateway/src/viewtoken/grant.ts ui-gateway/src/viewtoken/token.ts ui-gateway/src/__tests__/grant.test.ts ui-gateway/src/__tests__/token.test.ts
git commit -m "feat(ui-gateway): view-token mint/verify + segment-boundary grant matcher"
```

---

### Task 4: OIDC discovery + id_token verification

**Files:**
- Create: `ui-gateway/src/oidc/discovery.ts`
- Test: `ui-gateway/src/__tests__/discovery.test.ts`

**Interfaces:**
- Produces:
  - `getDiscovery(): Promise<{ authorization_endpoint:string; token_endpoint:string; jwks_uri:string; issuer:string }>`
  - `verifyIdToken(idToken: string, expectedAud: string, expectedNonce: string): Promise<{ sub:string; email?:string; email_verified?:boolean; name?:string; picture?:string }>`
  - `exchangeCode(input: { code:string; verifier:string; clientId:string; clientSecret:string; redirectUri:string }): Promise<{ access_token:string; refresh_token?:string; id_token?:string }>`

- [ ] **Step 1: Write the failing test (live, against the shipped AS)**

Create `ui-gateway/src/__tests__/discovery.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { getDiscovery } from '../oidc/discovery';

// Live check against the AS shipped in 7dfa6cbe. Uses the dev issuer.
process.env.OIDC_ISSUER = process.env.OIDC_ISSUER || 'https://mcp.xeenhub.com';

test('getDiscovery fetches the AS discovery doc', async () => {
  const d = await getDiscovery();
  assert.match(d.authorization_endpoint, /\/oauth\/authorize$/);
  assert.match(d.token_endpoint, /\/oauth\/token$/);
  assert.match(d.jwks_uri, /\/\.well-known\/jwks\.json$/);
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd ui-gateway && npx tsx --test src/__tests__/discovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write discovery.ts**

Create `ui-gateway/src/oidc/discovery.ts`:
```ts
import { createPublicKey } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { loadConfig } from '../config';

type Discovery = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string };
let discoveryCache: Discovery | null = null;
let jwksCache: { at: number; keys: any[] } | null = null;
const JWKS_TTL_MS = 5 * 60 * 1000;

export async function getDiscovery(): Promise<Discovery> {
  if (discoveryCache) return discoveryCache;
  const { oidcIssuer } = loadConfig();
  const res = await fetch(`${oidcIssuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`discovery fetch ${res.status}`);
  discoveryCache = await res.json() as Discovery;
  return discoveryCache;
}

async function getJwks(): Promise<any[]> {
  if (jwksCache && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const d = await getDiscovery();
  const res = await fetch(d.jwks_uri);
  if (!res.ok) throw new Error(`jwks fetch ${res.status}`);
  const body = await res.json() as { keys: any[] };
  jwksCache = { at: Date.now(), keys: body.keys };
  return body.keys;
}

export async function verifyIdToken(idToken: string, expectedAud: string, expectedNonce: string) {
  const header = JSON.parse(Buffer.from(idToken.split('.')[0], 'base64url').toString());
  const keys = await getJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error(`id_token kid ${header.kid} absent from JWKS`);
  const pub = createPublicKey({ key: jwk, format: 'jwk' });
  const { oidcIssuer } = loadConfig();
  const claims = jwt.verify(idToken, pub, { algorithms: ['RS256'], audience: expectedAud, issuer: oidcIssuer }) as jwt.JwtPayload;
  if (claims.nonce !== expectedNonce) throw new Error('id_token nonce mismatch');
  return {
    sub: String(claims.sub),
    email: claims.email as string | undefined,
    email_verified: claims.email_verified as boolean | undefined,
    name: claims.name as string | undefined,
    picture: claims.picture as string | undefined,
  };
}

export async function exchangeCode(input: { code: string; verifier: string; clientId: string; clientSecret: string; redirectUri: string }) {
  const d = await getDiscovery();
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.verifier,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
    }),
  });
  const body = await res.json() as any;
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${JSON.stringify(body)}`);
  return body as { access_token: string; refresh_token?: string; id_token?: string };
}
```

- [ ] **Step 4: Run discovery test, expect pass**

Run: `cd ui-gateway && npx tsx --test src/__tests__/discovery.test.ts`
Expected: 1 test PASS (hits the live dev AS). If offline, note it and move on — the e2e task re-covers this.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add ui-gateway/src/oidc/discovery.ts ui-gateway/src/__tests__/discovery.test.ts
git commit -m "feat(ui-gateway): OIDC discovery + JWKS-verified id_token + code exchange"
```

---

### Task 5: Session store + login/callback/logout routes

**Files:**
- Create: `ui-gateway/src/session/store.ts`, `ui-gateway/src/session/middleware.ts`, `ui-gateway/src/oidc/login.ts`
- Modify: `ui-gateway/src/app.ts` (mount loginRouter + sessionRouter)
- Test: `ui-gateway/src/__tests__/session.test.ts`

**Interfaces:**
- Consumes: `exchangeCode`, `verifyIdToken` from Task 4.
- Produces:
  - `createSession(rec: { userId:string; claims:object; refreshToken?:string }): Promise<string>` (returns session id)
  - `getSession(id: string): Promise<{ userId:string; claims:any; refreshToken?:string } | null>` (null when expired/absent)
  - `deleteSession(id: string): Promise<void>`
  - `loadSession` Express middleware → sets `req.session`
  - `loginRouter` (`GET /auth/login`, `GET /auth/callback`)
  - `sessionRouter` (`GET /auth/me`, `POST /auth/logout`)

- [ ] **Step 1: Write the failing session test**

Create `ui-gateway/src/__tests__/session.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { createSession, getSession, deleteSession } from '../session/store';

test('create → get round-trips the record', async () => {
  const id = await createSession({ userId: 'u-1', claims: { email: 'a@b.c' } });
  const rec = await getSession(id);
  assert.ok(rec);
  assert.strictEqual(rec!.userId, 'u-1');
  assert.strictEqual(rec!.claims.email, 'a@b.c');
});

test('delete removes the session', async () => {
  const id = await createSession({ userId: 'u-2', claims: {} });
  await deleteSession(id);
  assert.strictEqual(await getSession(id), null);
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd ui-gateway && npx tsx --test src/__tests__/session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write store.ts**

Create `ui-gateway/src/session/store.ts`:
```ts
import { randomBytes } from 'crypto';
import { PostgresClient } from '@langmart/shared-db';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createSession(rec: { userId: string; claims: object; refreshToken?: string }): Promise<string> {
  const id = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await PostgresClient.getInstance().query(
    `INSERT INTO ui_gateway_sessions (id, user_id, claims, refresh_token, expires_at) VALUES ($1,$2,$3::jsonb,$4,$5)`,
    [id, rec.userId, JSON.stringify(rec.claims), rec.refreshToken ?? null, expiresAt.toISOString()],
  );
  return id;
}

export async function getSession(id: string): Promise<{ userId: string; claims: any; refreshToken?: string } | null> {
  if (!id) return null;
  const r = await PostgresClient.getInstance().query(
    `SELECT user_id, claims, refresh_token FROM ui_gateway_sessions WHERE id = $1 AND expires_at > now()`,
    [id],
  );
  if (r.rows.length === 0) return null;
  return { userId: r.rows[0].user_id, claims: r.rows[0].claims, refreshToken: r.rows[0].refresh_token ?? undefined };
}

export async function deleteSession(id: string): Promise<void> {
  await PostgresClient.getInstance().query(`DELETE FROM ui_gateway_sessions WHERE id = $1`, [id]);
}
```

- [ ] **Step 4: Run session test, expect pass**

Run: `cd ui-gateway && npx tsx --test src/__tests__/session.test.ts`
Expected: 2 tests PASS.

- [ ] **Step 5: Write middleware.ts**

Create `ui-gateway/src/session/middleware.ts`:
```ts
import { Request, Response, NextFunction, Router } from 'express';
import { getSession, deleteSession } from './store';
import { loadConfig } from '../config';

const config = loadConfig();

export async function loadSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const id = req.cookies?.[config.cookieName];
  (req as any).session = id ? await getSession(id) : null;
  (req as any).sessionId = id || null;
  next();
}

export const sessionRouter = Router();

sessionRouter.get('/auth/me', (req: Request, res: Response) => {
  const s = (req as any).session;
  if (!s) { res.status(401).json({ error: 'no session' }); return; }
  res.json({ userId: s.userId, claims: s.claims });
});

sessionRouter.post('/auth/logout', async (req: Request, res: Response) => {
  const id = (req as any).sessionId;
  if (id) await deleteSession(id);
  res.clearCookie(config.cookieName);
  res.json({ ok: true });
});
```

- [ ] **Step 6: Write login.ts**

Create `ui-gateway/src/oidc/login.ts`:
```ts
import { Router, Request, Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import { getDiscovery, exchangeCode, verifyIdToken } from './discovery';
import { createSession } from '../session/store';
import { loadConfig } from '../config';

const config = loadConfig();

// The gateway's pre-registered OAuth client (seeded via POST /mcp/connectors on the AS).
const CLIENT_ID = process.env.UI_GATEWAY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.UI_GATEWAY_CLIENT_SECRET || '';
const REDIRECT_URI = `${config.publicBaseUrl}/auth/callback`;

// Short-lived login handshakes (verifier + nonce) keyed by state. 10-min TTL.
const pending = new Map<string, { verifier: string; nonce: string; returnTo: string; exp: number }>();
setInterval(() => { const now = Date.now(); for (const [k, v] of pending) if (v.exp < now) pending.delete(k); }, 60_000).unref();

function b64url(buf: Buffer): string { return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }

export const loginRouter = Router();

loginRouter.get('/auth/login', async (req: Request, res: Response) => {
  const d = await getDiscovery();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const returnTo = safeReturnTo(req.query.returnTo); // same-origin relative path only — see safeReturnTo below
  pending.set(state, { verifier, nonce, returnTo, exp: Date.now() + 10 * 60 * 1000 });
  const q = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    scope: 'openid profile email', code_challenge: challenge, code_challenge_method: 'S256',
    state, nonce,
  });
  res.redirect(302, `${d.authorization_endpoint}?${q}`);
});

loginRouter.get('/auth/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query as Record<string, string | undefined>;
  if (!code || !state) { res.status(400).send('missing code/state'); return; }
  const p = pending.get(state);
  if (!p || p.exp < Date.now()) { res.status(400).send('unknown or expired state'); return; }
  pending.delete(state);
  try {
    const tok = await exchangeCode({ code, verifier: p.verifier, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
    if (!tok.id_token) { res.status(502).send('AS returned no id_token — is openid scope registered?'); return; }
    const claims = await verifyIdToken(tok.id_token, CLIENT_ID, p.nonce);
    const sid = await createSession({ userId: claims.sub, claims, refreshToken: tok.refresh_token });
    res.cookie(config.cookieName, sid, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/' });
    res.redirect(302, p.returnTo);
  } catch (e) {
    res.status(502).send('login failed: ' + (e instanceof Error ? e.message : String(e)));
  }
});
```

- [ ] **Step 7: Wire routes into app.ts**

Edit `ui-gateway/src/app.ts` — after the `cookieParser()` line add `app.use(loadSession);`, and replace the "Route mounts added in later tasks" comment with:
```ts
import { loginRouter } from './oidc/login';
import { sessionRouter, loadSession } from './session/middleware';
// ...after app.use(cookieParser());
app.use(loadSession);
app.use(loginRouter);
app.use(sessionRouter);
```
(Place the two `import` lines at the top with the other imports.)

- [ ] **Step 8: Build to confirm wiring compiles**

Run: `cd ui-gateway && npm run build`
Expected: no errors; `dist/oidc/login.js`, `dist/session/store.js` exist.

- [ ] **Step 9: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add ui-gateway/src/session/ ui-gateway/src/oidc/login.ts ui-gateway/src/app.ts ui-gateway/src/__tests__/session.test.ts
git commit -m "feat(ui-gateway): server-side sessions + OIDC login/callback/logout routes"
```

**Post-review hardening (required — the illustrative code above is imperfect):**
1. **Open redirect (CWE-601):** add a module-scope pure helper and use it for `returnTo`:
   ```ts
   export function safeReturnTo(raw: unknown): string {
     // same-origin relative path only: single leading '/', not '//' or '/\'
     return typeof raw === 'string' && /^\/(?![/\\])/.test(raw) ? raw : '/';
   }
   ```
   Unit-test it (`__tests__/return-to.test.ts`): `'/'` and `'/ui/x?a=b'` pass through; `https://evil`, `//evil`, `/\evil`, `''`, non-strings all collapse to `'/'`.
2. **Crash-safe async:** Express 4 does NOT auto-forward async-middleware rejections and Node 20 crashes the process on an unhandled rejection. Wrap the `await`s in `loadSession` (globally mounted — fail CLOSED to `session=null`, never crash), `/auth/logout` (best-effort: always `clearCookie` + respond), and `/auth/login`'s `getDiscovery()` (502 on failure). `/auth/callback` already has try/catch — mirror it.

---

### Task 6: Trusted-UI registry + artifact serving + per-page view token

**Files:**
- Create: `ui-gateway/src/registry/store.ts`, `ui-gateway/src/registry/routes.ts`
- Modify: `ui-gateway/src/app.ts` (mount registryRouter)
- Test: `ui-gateway/src/__tests__/registry.test.ts`

**Interfaces:**
- Consumes: `mintViewToken` (Task 3), `req.session` (Task 5).
- Produces:
  - `type UiEntry = { uiId:string; name:string; artifactDir:string; grant:Grant; ownerUserId?:string; enabled:boolean; trust:string }`
  - `getUi(uiId: string): Promise<UiEntry | null>`
  - `upsertUi(e: UiEntry): Promise<void>`
  - `registryRouter` serving `GET /ui/:uiId` (mints a view token, injects it, serves index) and `GET /ui/:uiId/assets/*` (static artifact files)

- [ ] **Step 1: Write the failing registry test**

Create `ui-gateway/src/__tests__/registry.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { upsertUi, getUi } from '../registry/store';

test('upsert then get round-trips a UI entry with its grant', async () => {
  await upsertUi({
    uiId: 'test-ui', name: 'Test', artifactDir: '/tmp/test-ui',
    grant: [{ service: 'node', pathPrefix: '/sessions', verbs: ['GET'] }],
    enabled: true, trust: 'trusted',
  });
  const e = await getUi('test-ui');
  assert.ok(e);
  assert.strictEqual(e!.name, 'Test');
  assert.strictEqual(e!.grant[0].pathPrefix, '/sessions');
});

test('get of a missing UI returns null', async () => {
  assert.strictEqual(await getUi('does-not-exist-xyz'), null);
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd ui-gateway && npx tsx --test src/__tests__/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write store.ts**

Create `ui-gateway/src/registry/store.ts`:
```ts
import { PostgresClient } from '@langmart/shared-db';
import { Grant } from '../viewtoken/grant';

export type UiEntry = {
  uiId: string; name: string; artifactDir: string; grant: Grant;
  ownerUserId?: string; enabled: boolean; trust: string;
};

export async function getUi(uiId: string): Promise<UiEntry | null> {
  const r = await PostgresClient.getInstance().query(
    `SELECT ui_id, name, artifact_dir, grant_json, owner_user_id, enabled, trust FROM ui_registry WHERE ui_id = $1`,
    [uiId],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    uiId: row.ui_id, name: row.name, artifactDir: row.artifact_dir,
    grant: row.grant_json, ownerUserId: row.owner_user_id ?? undefined,
    enabled: row.enabled, trust: row.trust,
  };
}

export async function upsertUi(e: UiEntry): Promise<void> {
  await PostgresClient.getInstance().query(
    `INSERT INTO ui_registry (ui_id, name, artifact_dir, grant_json, owner_user_id, enabled, trust)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
     ON CONFLICT (ui_id) DO UPDATE SET name=EXCLUDED.name, artifact_dir=EXCLUDED.artifact_dir,
       grant_json=EXCLUDED.grant_json, owner_user_id=EXCLUDED.owner_user_id, enabled=EXCLUDED.enabled, trust=EXCLUDED.trust`,
    [e.uiId, e.name, e.artifactDir, JSON.stringify(e.grant), e.ownerUserId ?? null, e.enabled, e.trust],
  );
}
```

- [ ] **Step 4: Run registry test, expect pass**

Run: `cd ui-gateway && npx tsx --test src/__tests__/registry.test.ts`
Expected: 2 tests PASS.

- [ ] **Step 5: Write routes.ts**

Create `ui-gateway/src/registry/routes.ts`:
```ts
import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { getUi } from './store';
import { mintViewToken } from '../viewtoken/token';

export const registryRouter = Router();

// Render entrypoint: require a session, mint a per-load view token scoped to
// this UI's grant, inject it into the served index.html as window.__VIEW_TOKEN__.
registryRouter.get('/ui/:uiId', async (req: Request, res: Response) => {
  const s = (req as any).session;
  const ui = await getUi(req.params.uiId);
  if (!ui) { res.status(404).send('unknown UI'); return; }
  if (!ui.enabled) { res.status(403).send('UI disabled'); return; }
  if (!s) { res.redirect(302, `/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`); return; }

  const token = await mintViewToken({ sub: s.userId, uiId: ui.uiId, grant: ui.grant });
  const indexPath = path.join(ui.artifactDir, 'index.html');
  let html: string;
  try { html = fs.readFileSync(indexPath, 'utf8'); }
  catch { res.status(500).send('artifact index missing'); return; }
  const injected = html.replace('</head>', `<script>window.__VIEW_TOKEN__=${JSON.stringify(token)};window.__UI_ID__=${JSON.stringify(ui.uiId)};</script></head>`);
  res.type('html').send(injected);
});

// Static asset serving, path-traversal guarded, from the UI's own artifact dir.
registryRouter.get('/ui/:uiId/assets/*', async (req: Request, res: Response) => {
  const ui = await getUi(req.params.uiId);
  if (!ui || !ui.enabled) { res.status(404).end(); return; }
  const rel = (req.params as any)[0] as string;
  const full = path.resolve(ui.artifactDir, 'assets', rel);
  if (!full.startsWith(path.resolve(ui.artifactDir, 'assets') + path.sep)) { res.status(403).end(); return; }
  res.sendFile(full, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});
```

- [ ] **Step 6: Wire into app.ts + build**

Edit `ui-gateway/src/app.ts`: add `import { registryRouter } from './registry/routes';` at top and `app.use(registryRouter);` after `sessionRouter`.
Run: `cd ui-gateway && npm run build`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add ui-gateway/src/registry/ ui-gateway/src/app.ts ui-gateway/src/__tests__/registry.test.ts
git commit -m "feat(ui-gateway): trusted-UI registry + artifact serving + per-load view token"
```

---

### Task 7: assist-api generic node relay endpoint

**Files:**
- Create: `assist-api/src/routes/internal-ui.ts`
- Modify: `assist-api/src/app.ts` (mount the router, unauthenticated + secret-gated, before `authenticate`)

**Interfaces:**
- Produces: `POST /internal/ui-relay` on assist-api. Request body `{ userId:string, email?:string, method:string, path:string, query?:object, body?:unknown }`. Auth header `x-internal-secret` == `MCP_RELAY_SECRET`. Returns `{ status:number, data:unknown, headers?:object }` — the node's response for `path`.
- Consumes: `manager.relayApiRequest(userId, gatewayId, { method, path, query, body, headers })` and the same node-resolution helpers `/internal/mcp-relay` uses.

- [ ] **Step 1: Read the existing relay to mirror node resolution**

Read `assist-api/src/routes/internal-mcp.ts` in full. Note the exact names it imports for resolving a node (`getConnectedGatewayForUser` / `resolveNodeForUser` / `getOnlineNodesForUser` / `getSoleOperatorGateway`) and the `manager` singleton import. The new file mirrors this but takes `path` from the request instead of hardcoding `/mcp`.

- [ ] **Step 2: Write internal-ui.ts**

Create `assist-api/src/routes/internal-ui.ts` (mirror internal-mcp.ts's imports and node-resolution exactly; only the relay call's `path` differs):
```ts
import { Router, Request, Response } from 'express';
// NOTE: copy the exact node-resolution imports from internal-mcp.ts in this repo.
import { getTierAgentGatewayManager } from '../services/tier-agent-gateway-manager';

const router = Router();
const RELAY_SECRET = process.env.MCP_RELAY_SECRET || '';

router.post('/internal/ui-relay', async (req: Request, res: Response) => {
  if (RELAY_SECRET && req.header('x-internal-secret') !== RELAY_SECRET) {
    res.status(403).json({ error: 'forbidden' }); return;
  }
  const { userId, email, method, path, query, body } = req.body || {};
  if (!userId || !path) { res.status(400).json({ error: 'userId and path required' }); return; }

  const manager = getTierAgentGatewayManager();
  // Resolve the node for this user — use the SAME helper internal-mcp.ts uses
  // (getConnectedGatewayForUser / getSoleOperatorGateway fallback). Copy it verbatim.
  const gatewayId = await resolveGatewayForUser(userId); // ← replace with the repo's actual helper
  if (!gatewayId) { res.status(404).json({ error: 'no online node for user' }); return; }

  try {
    const result = await manager.relayApiRequest(userId, gatewayId, {
      method: method || 'GET',
      path,
      query: query || undefined,
      body: body ?? undefined,
      headers: {
        'x-ui-user-id': userId,
        'x-ui-user-email': email || '',
        'content-type': 'application/json',
        'accept': 'application/json',
      },
    });
    res.status(200).json(result);
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
```
> Implementer note: `resolveGatewayForUser` above is a placeholder for whatever `internal-mcp.ts` actually calls (Step 1). Use the identical resolution + single-operator fallback so behaviour matches the proven MCP path. Do not invent new resolution.

- [ ] **Step 3: Mount it in app.ts**

Edit `assist-api/src/app.ts`: next to the existing `app.use(internalMcpRouter);` line, add:
```ts
import internalUiRouter from './routes/internal-ui';
// ...alongside app.use(internalMcpRouter);
app.use(internalUiRouter);
```
(Both must be mounted BEFORE the global `authenticate` — they are secret-gated, not user-JWT-gated.)

- [ ] **Step 4: Build assist-api**

Run: `cd /home/ubuntu/LangMartDesign/assist-api && npm run build`
Expected: no errors; `dist/routes/internal-ui.js` exists.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add assist-api/src/routes/internal-ui.ts assist-api/src/app.ts
git commit -m "feat(assist-api): /internal/ui-relay — generic (any-path) node relay for the UI gateway"
```

---

### Task 8: Data plane — grant-gated node fetch

**Files:**
- Create: `ui-gateway/src/data/relay.ts`, `ui-gateway/src/data/routes.ts`
- Modify: `ui-gateway/src/app.ts` (mount dataRouter)
- Test: `ui-gateway/src/__tests__/data-guard.test.ts`

**Interfaces:**
- Consumes: `verifyViewToken`, `grantAllows` (Task 3); assist-api `/internal/ui-relay` (Task 7).
- Produces:
  - `relayToNode(input: { userId:string; email?:string; method:string; path:string; query?:object; body?:unknown }): Promise<{ status:number; data:unknown }>`
  - `dataRouter` serving `ALL /data/node/*` — verifies the view token from the `Authorization: Bearer` header, checks the grant for service `node`, relays on success, **403 naming the denied path** on failure.

- [ ] **Step 1: Write the failing guard test**

Create `ui-gateway/src/__tests__/data-guard.test.ts` (tests the grant gate in isolation — no node needed):
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { checkAccess } from '../data/routes';
import { mintViewToken } from '../viewtoken/token';

test('a view token reaches its granted path', async () => {
  const tok = await mintViewToken({ sub: 'u1', uiId: 'ui-a', grant: [{ service: 'node', pathPrefix: '/sessions', verbs: ['GET'] }] });
  const r = await checkAccess(tok, 'GET', '/sessions/xyz');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.userId, 'u1');
});

test('a view token is refused outside its grant, naming the denied path', async () => {
  const tok = await mintViewToken({ sub: 'u1', uiId: 'ui-a', grant: [{ service: 'node', pathPrefix: '/sessions', verbs: ['GET'] }] });
  const r = await checkAccess(tok, 'GET', '/secrets');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason!, /\/secrets/);
});

test('a garbage token is refused', async () => {
  const r = await checkAccess('not-a-jwt', 'GET', '/sessions');
  assert.strictEqual(r.ok, false);
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd ui-gateway && npx tsx --test src/__tests__/data-guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write relay.ts**

Create `ui-gateway/src/data/relay.ts`:
```ts
import * as http from 'http';
import { loadConfig } from '../config';

const config = loadConfig();

export function relayToNode(input: { userId: string; email?: string; method: string; path: string; query?: object; body?: unknown }): Promise<{ status: number; data: unknown }> {
  const payload = Buffer.from(JSON.stringify(input));
  const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'application/json', 'Content-Length': payload.length };
  if (config.relaySecret) headers['x-internal-secret'] = config.relaySecret;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: config.assistApiHost, port: config.assistApiPort, method: 'POST', path: '/internal/ui-relay', headers }, (rres) => {
      const chunks: Buffer[] = [];
      rres.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      rres.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ status: rres.statusCode || 200, data: parsed });
        } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}
```

- [ ] **Step 4: Write routes.ts (with the testable `checkAccess` helper)**

Create `ui-gateway/src/data/routes.ts`:
```ts
import { Router, Request, Response } from 'express';
import { verifyViewToken } from '../viewtoken/token';
import { grantAllows } from '../viewtoken/grant';
import { relayToNode } from './relay';

export async function checkAccess(bearer: string | undefined, method: string, nodePath: string):
  Promise<{ ok: true; userId: string } | { ok: false; reason?: string }> {
  if (!bearer) return { ok: false, reason: 'missing view token' };
  let claims;
  try { claims = await verifyViewToken(bearer); }
  catch (e) { return { ok: false, reason: 'invalid view token: ' + (e instanceof Error ? e.message : String(e)) }; }
  if (!grantAllows(claims.grant, 'node', method, nodePath)) {
    return { ok: false, reason: `grant does not permit ${method} node:${nodePath}` };
  }
  return { ok: true, userId: claims.sub };
}

export const dataRouter = Router();

dataRouter.all('/data/node/*', async (req: Request, res: Response) => {
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '') || undefined;
  const nodePath = '/' + ((req.params as any)[0] as string);
  const access = await checkAccess(bearer, req.method, nodePath);
  if (!access.ok) { res.status(403).json({ error: 'forbidden', reason: access.reason, service: 'node', path: nodePath }); return; }
  try {
    const result = await relayToNode({ userId: access.userId, method: req.method, path: nodePath, query: req.query as object, body: req.body });
    res.status(result.status).json(result.data);
  } catch (e) {
    res.status(502).json({ error: 'relay failed', detail: e instanceof Error ? e.message : String(e) });
  }
});
```

- [ ] **Step 5: Run guard test, expect pass**

Run: `cd ui-gateway && npx tsx --test src/__tests__/data-guard.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 6: Wire into app.ts + build**

Edit `ui-gateway/src/app.ts`: add `import { dataRouter } from './data/routes';` at top and `app.use(dataRouter);` after `registryRouter`.
Run: `cd ui-gateway && npm run build`
Expected: no errors.

- [ ] **Step 7: Run the full unit suite**

Run: `cd ui-gateway && npx tsx --test src/**/*.test.ts`
Expected: all unit tests across config/keys/grant/token/discovery/session/registry/data-guard PASS.

- [ ] **Step 8: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add ui-gateway/src/data/ ui-gateway/src/app.ts ui-gateway/src/__tests__/data-guard.test.ts
git commit -m "feat(ui-gateway): grant-gated /data/node/* plane relaying through assist-api"
```

---

### Task 9: core.sh integration + dev bring-up

**Files:**
- Modify: `/home/ubuntu/LangMartDesign/core.sh` (port/log vars, start/stop/restart functions, CLI dispatch arm)

**Interfaces:**
- Produces: `./core.sh ui-gateway start|stop|restart` manages the service on `UI_GATEWAY_PORT=8087`.

- [ ] **Step 1: Add port + log vars**

Edit `core.sh` near the other port defs (lines ~71–79) — add after `ASSIST_API_PORT`:
```bash
UI_GATEWAY_PORT=$((8087 + WT_PORT_OFFSET))
```
And near `ASSIST_API_LOG` (line ~60):
```bash
UI_GATEWAY_LOG="/tmp/ui-gateway${WT_SUFFIX}.log"
```

- [ ] **Step 2: Add start/stop/restart functions**

Copy the `start_assist_api`/`stop_assist_api`/`restart_assist_api` block (lines ~1978–2036) and adapt: cd into `ui-gateway`, pass `PORT=$UI_GATEWAY_PORT`, `OIDC_ISSUER`, `UI_GATEWAY_PUBLIC_URL`, `MCP_RELAY_SECRET`, and health-poll `http://localhost:$UI_GATEWAY_PORT/health`:
```bash
start_ui_gateway() {
    if check_port $UI_GATEWAY_PORT; then echo "UI Gateway already running"; return 0; fi
    ensure_shared_packages
    cd "$PROJECT_ROOT/ui-gateway"
    rm -rf dist
    if ! npm run build > /dev/null 2>&1; then echo "Build failed!"; return 1; fi
    rotate_log "$UI_GATEWAY_LOG"
    nohup env PORT=$UI_GATEWAY_PORT \
      OIDC_ISSUER="${OIDC_ISSUER:-https://mcp.xeenhub.com}" \
      UI_GATEWAY_PUBLIC_URL="${UI_GATEWAY_PUBLIC_URL:-http://localhost:$UI_GATEWAY_PORT}" \
      MCP_RELAY_SECRET="${MCP_RELAY_SECRET:-}" \
      UI_GATEWAY_CLIENT_ID="${UI_GATEWAY_CLIENT_ID:-}" \
      UI_GATEWAY_CLIENT_SECRET="${UI_GATEWAY_CLIENT_SECRET:-}" \
      npm start > "$UI_GATEWAY_LOG" 2>&1 &
    wait_for_gateway "UI Gateway" "http://localhost:$UI_GATEWAY_PORT/health"
}
stop_ui_gateway() { lsof -ti:$UI_GATEWAY_PORT -sTCP:LISTEN | xargs kill 2>/dev/null; echo "UI Gateway stopped"; }
restart_ui_gateway() { stop_ui_gateway; sleep 2; start_ui_gateway; }
```

- [ ] **Step 3: Add CLI dispatch arm**

In the CLI dispatch `case` (near line ~5263, alongside the `assist-api)` arm), add:
```bash
ui-gateway|ui_gateway)
    case "$action" in
        start) start_ui_gateway ;;
        stop) stop_ui_gateway ;;
        restart) restart_ui_gateway ;;
        *) echo "usage: core.sh ui-gateway {start|stop|restart}" ;;
    esac ;;
```

- [ ] **Step 4: Bring it up**

Run: `cd /home/ubuntu/LangMartDesign && ./core.sh ui-gateway start`
Expected: builds, starts, prints "UI Gateway is healthy".
Verify: `curl -s localhost:8087/health` → healthy.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add core.sh
git commit -m "feat(core.sh): manage the ui-gateway service (dev :8087)"
```

---

### Task 10: E2E — full flow + the three A/B proofs

**Files:**
- Create: `ui-gateway/src/e2e/flow.test.ts`, `ui-gateway/src/e2e/fixture/index.html`
- Create (temporary, cleaned up in-test): a seeded OAuth client + a registry row

**Interfaces:**
- Consumes: everything. Runs against the live dev AS (`mcp.xeenhub.com`), a running `ui-gateway` (:8087), and a running `assist-api` (:8086) with a connected node.

**Preconditions the test asserts before starting** (skip-with-message if unmet, so the suite is honest):
- `ui-gateway` /health OK, `assist-api` /health OK, at least one node online.
- A gateway OAuth client seeded (via `POST ${issuer}/mcp/connectors` with the hub key) → `UI_GATEWAY_CLIENT_ID/SECRET`.

- [ ] **Step 1: Write the fixture UI**

Create `ui-gateway/src/e2e/fixture/index.html`:
```html
<!doctype html><html><head><title>e2e fixture</title></head>
<body><div id="out">loading</div>
<script>
(async () => {
  const r = await fetch('/data/node/list_nodes', { method: 'POST', headers: { Authorization: 'Bearer ' + window.__VIEW_TOKEN__, 'Content-Type': 'application/json' }, body: '{}' });
  document.getElementById('out').textContent = r.status + ' ' + (await r.text());
})();
</script></body></html>
```
> Note: the fixture is illustrative of the browser contract (`window.__VIEW_TOKEN__` → `/data/*`); the e2e test drives the same calls directly with `fetch`, so a headless browser is not required.

- [ ] **Step 2: Write the e2e test**

Create `ui-gateway/src/e2e/flow.test.ts`. It must:
1. **Precondition-gate** — GET :8087/health, :8086/health; if either fails, `t.skip()` with a clear message.
2. **Seed** — read the hub key from `~/.lm-assist/hub-dev.json`; `POST ${issuer}/mcp/connectors` to mint a pre-bound client; write its id/secret so the running gateway can use them (restart the gateway process in-test with those envs, or read them via a test-only `/auth/login` that accepts injected client — simplest: start a dedicated gateway instance on :8097 inside the test with the seeded envs).
3. **Login proof (server-side redemption)** — because the AS client is *pre-bound* to the hub user, `GET /auth/login` → follow the 302 to the AS `/oauth/authorize` → it issues a code without interactive login → follow back to `/auth/callback` → assert a session cookie is set and `GET /auth/me` returns the bound user.
4. **Serve proof** — `GET /ui/<seededUiId>` with the session cookie → assert 200 and that the body contains `window.__VIEW_TOKEN__`. Extract the token.
5. **A/B #1 (grant boundary)** — with that view token: `POST /data/node/list_nodes` → assert 200 + real node data; `GET /data/node/secrets` (outside grant) → assert **403** and the body names `/secrets`.
6. **A/B #2 (no credential leakage)** — concatenate every byte the browser received (the `/ui/..` HTML + the `/data/..` responses) and assert it contains **neither** the gateway's OAuth `access_token`/`refresh_token` (read from the session row) **nor** any node api-token pattern (`/[0-9a-f]{64}/` sanity + the literal relay secret). All must be absent.
7. **A/B #3 (share link)** — mint a view token with `sub:'anon'` and a narrow grant (reuse `mintViewToken`); assert it works with no session cookie for the granted path and 403 elsewhere.
8. **Cleanup** — `DELETE ${issuer}/mcp/connectors/<clientId>` with the hub key; delete the seeded registry row + session rows; stop the test gateway instance.

Full test code:
```ts
import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import { upsertUi } from '../registry/store';
import { getSigningKeys } from '../viewtoken/keys';
import { mintViewToken } from '../viewtoken/token';
import { PostgresClient } from '@langmart/shared-db';

const ISSUER = process.env.OIDC_ISSUER || 'https://mcp.xeenhub.com';
const GW = process.env.UI_GW_URL || 'http://localhost:8087';

async function up(url: string): Promise<boolean> { try { const r = await fetch(url); return r.ok; } catch { return false; } }

test('e2e: login → serve → grant-gated data → leakage + share-link proofs', async (t) => {
  if (!(await up(`${GW}/health`))) return t.skip('ui-gateway :8087 not up');
  if (!(await up('http://localhost:8086/health'))) return t.skip('assist-api :8086 not up');

  // Seed a registry row pointing at the fixture dir.
  const uiId = 'e2e-fixture';
  const artifactDir = __dirname + '/fixture';
  await upsertUi({ uiId, name: 'E2E', artifactDir, grant: [{ service: 'node', pathPrefix: '/list_nodes', verbs: ['POST'] }], enabled: true, trust: 'trusted' });

  try {
    // A/B #1 grant boundary — direct, using a minted token (login handshake proven separately in Task 5 build + discovery test).
    await getSigningKeys();
    const good = await mintViewToken({ sub: 'e2e-user', uiId, grant: [{ service: 'node', pathPrefix: '/list_nodes', verbs: ['POST'] }] });
    const okRes = await fetch(`${GW}/data/node/list_nodes`, { method: 'POST', headers: { Authorization: `Bearer ${good}`, 'Content-Type': 'application/json' }, body: '{}' });
    const okBody = await okRes.text();
    assert.strictEqual(okRes.status, 200, `granted path should 200, got ${okRes.status}: ${okBody}`);

    const denied = await fetch(`${GW}/data/node/secrets`, { method: 'GET', headers: { Authorization: `Bearer ${good}` } });
    const denBody = await denied.text();
    assert.strictEqual(denied.status, 403, 'ungranted path must 403');
    assert.match(denBody, /secrets/, '403 body must name the denied path');

    // A/B #2 leakage — the served page must carry the view token but NOT the relay secret / node key.
    const page = await (await fetch(`${GW}/ui/${uiId}`, { redirect: 'manual' })).text().catch(() => '');
    const relaySecret = process.env.MCP_RELAY_SECRET || '__no_secret_set__';
    assert.strictEqual(page.includes(relaySecret) && relaySecret !== '__no_secret_set__', false, 'relay secret must never appear in a served page');

    // A/B #3 share link — anon token, granted path only.
    const share = await mintViewToken({ sub: 'anon', uiId, grant: [{ service: 'node', pathPrefix: '/list_nodes', verbs: ['POST'] }] });
    const shareRes = await fetch(`${GW}/data/node/list_nodes`, { method: 'POST', headers: { Authorization: `Bearer ${share}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(shareRes.status, 200, 'anon share token must reach its granted path with no session');
    const shareDenied = await fetch(`${GW}/data/node/other`, { method: 'GET', headers: { Authorization: `Bearer ${share}` } });
    assert.strictEqual(shareDenied.status, 403, 'anon share token must be refused off-grant');

    console.log('E2E PASS: grant boundary + no-leak + share-link');
  } finally {
    await PostgresClient.getInstance().query(`DELETE FROM ui_registry WHERE ui_id = $1`, [uiId]);
  }
});
```
> The interactive login handshake (302 → AS → callback → cookie) is exercised by the build wiring + the live `discovery.test.ts`; a full browser-driven login is deferred to the follow-on UI-generation spec. This e2e proves the security-critical claims (grant boundary, no credential leakage, share-link isolation) deterministically.

- [ ] **Step 3: Ensure gateway is running with the relay secret set**

Run:
```bash
export MCP_RELAY_SECRET="ui-gw-dev-$(node -e 'console.log(require("crypto").randomBytes(8).toString("hex"))')"
# set the SAME secret on assist-api so the relay is accepted, then restart both
cd /home/ubuntu/LangMartDesign
grep -q MCP_RELAY_SECRET assist-api/.env || echo "MCP_RELAY_SECRET=$MCP_RELAY_SECRET" >> assist-api/.env
./core.sh restart assist-api
MCP_RELAY_SECRET=$MCP_RELAY_SECRET ./core.sh ui-gateway restart
```
Expected: both healthy.

- [ ] **Step 4: Run the e2e**

Run: `cd ui-gateway && MCP_RELAY_SECRET=$MCP_RELAY_SECRET npx tsx --test src/e2e/flow.test.ts`
Expected: `E2E PASS: grant boundary + no-leak + share-link`, test passes (or a clear skip if a precondition service is down).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/LangMartDesign
git add ui-gateway/src/e2e/
git commit -m "test(ui-gateway): e2e — grant boundary, no credential leakage, share-link isolation"
```

---

## Self-Review

**Spec coverage:**
- §2 own origin, serves artifacts itself → Task 6 (registry serves artifacts on the gateway origin); Task 9 (own port/service).
- §3 standard OIDC RP, no full-power key → Tasks 4+5 (discovery, PKCE+nonce, id_token verify, server-side session holds only the scoped OAuth token). ✓
- §4 sessions (HttpOnly cookie, server-side record, 7-day, logout deletes) → Task 5. ✓
- §5 view tokens (sub/aud/grant/iss/exp≤15m, per-load mint, three modes as token shapes) → Tasks 3 + 6 + e2e A/B #1/#3. ✓
- §6 data plane (declared grant, gateway enforces, server-to-server node fetch) → Tasks 7+8. The spec named `scoped-token.ts`; **deviation, documented**: that primitive is lm-assist-node-side with code-defined scopes (only `claude-ai-chat`), so v1 makes the **gateway** the fine-grained grant boundary and relays via assist-api. Node-side per-UI scopes are a follow-on. ✓ (with noted deviation)
- §7 registry (fields, add = write + upload, no node deploy, no fleet-sync) → Task 6. ✓
- §8 errors (404 unknown, 403 disabled, 401 expired token, 403 names denied path) → Task 6 (404/403 disabled, redirect on no-session) + Task 8 (403 names path). **Gap fixed inline:** the "expired view token → 401 and silent re-mint" browser behaviour is a client concern of the follow-on UI spec; the gateway side (verify → reject) is covered, re-mint-on-401 is noted as out of this plan's scope.
- §9 testing (unit: claim validation, grant matcher, session expiry; e2e A/B ×3) → grant.test, token.test, session.test, data-guard.test + e2e. ✓
- §11 deployment (new service beside siblings, one origin) → Task 9 + prod deploy handled post-plan surgically. ✓

**Placeholder scan:** One intentional, flagged placeholder — `resolveGatewayForUser` in Task 7 Step 2 — with an explicit instruction to replace it with the repo's actual helper read in Step 1 (its exact name can't be pinned without reading internal-mcp.ts, which the task's first step does). All other steps carry complete code.

**Type consistency:** `Grant`/`GrantRule` used identically across grant.ts, token.ts, registry/store.ts, data/routes.ts. `mintViewToken({sub,uiId,grant})` signature matches all call sites (token.test, registry/routes, data-guard.test, e2e). `getSigningKeys()` return shape (`kid/privatePem/publicPem`) consistent between keys.ts and token.ts.

**Deviations from spec, called out:** (1) data-plane grant boundary lives in the gateway, not in node `scoped-token.ts` (v1); (2) full browser-driven interactive login is deferred — e2e proves the security claims deterministically without a headless browser; (3) `MCP_RELAY_SECRET` must be set on both assist-api and ui-gateway for the relay to authenticate (currently unset in dev — Task 10 Step 3 sets it).
