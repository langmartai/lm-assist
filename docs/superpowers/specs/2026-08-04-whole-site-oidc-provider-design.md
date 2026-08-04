# Whole-Site OIDC Provider — Design

**Date:** 2026-08-04 · **Status:** approved for implementation
**Scope:** stand up a standard OIDC provider on LangMart's platform auth (`gateway-type1`), built on the existing social/SAML login, and move the UI gateway's site-login onto it — off the MCP connector's OAuth server. Includes the `api_keys.metadata` schema-drift fix.
**Out of scope (sequenced follow-on specs):** migrating `assist-web` onto OIDC; retiring the JS-readable `langmart_session` full-power session key; credential typing/scoping cleanup across key families; retiring the dead HS256 JWT/`sessions` path.

## 1. Problem

LangMart has **one identity core** — every credential (social login, SAML, API keys, MCP tokens) resolves to the single `users` table through one shared validator (`shared/auth` `authenticate`), org/role via `organization_members`. But the *login* surfaces are tangled:

- The **only OIDC issuer today is the MCP connector's Authorization Server** (`gateway-type1/lib/routes/oauth-mcp.ts`, host `mcp.langmart.ai`). The OIDC layer (`/.well-known/openid-configuration`, `/oauth/userinfo`, id_token via `mintIdToken`, shipped in `7dfa6cbe`) was bolted onto the server built for claude.ai connector tokens. Its `/oauth/token` mints `sk-langmart-…` `api_keys` rows with `metadata.kind:'mcp_oauth'`. So a *site login* through it produces an MCP connector token as a byproduct. The UI gateway (`ui-gateway`) federates from this — i.e. the whole site's login rides the MCP server. Wrong surface.
- The real whole-site human login (social OAuth `/v1/auth/authorize`→`/v1/auth/callback`; SAML `/api/saml/:configId/acs`) mints a `sk-session-…` **API key delivered as the `langmart_session` cookie, deliberately not HttpOnly** — a full-power user key readable by page JS, then copied to other apps by the exchange-code bridge. (This anti-pattern is out of scope to fix here but is why the new provider must NOT add another browser-held full-power key.)
- **Schema drift landmine:** the `api_keys.metadata jsonb` column that MCP scoping, SAML sessions, and the `kind` fence all depend on is **absent from committed SQL** (`datastore/tables/26_api_keys.sql`); it exists only in the live DB. A rebuild-from-SQL yields a DB where MCP, SAML, and ui-gateway logins fail on insert.

**Goal:** site-login OIDC on the site-login service, issuing a *verifiable identity* that apps consume without holding a full-power key — and quarantine `oauth-mcp.ts` to connector tokens.

## 2. Decision (Approach A)

A new **OIDC provider module inside `gateway-type1`**, served on the platform host (issuer `https://api.langmart.ai`, dev `https://api.xeenhub.com` — the box that already owns `/v1/auth/*`, the `users` table, and social/SAML login). It reuses the existing login rather than re-implementing it, issues only verifiable JWTs (no `api_keys` row), uses a controlled client registry, and replaces the MCP-AS OIDC.

Rejected: **B** (extract OIDC from `oauth-mcp.ts` into a shared module on both hosts) — the MCP authorize mints `api_keys` and carries a connector client registry the platform one must not; they diverge immediately, so sharing preserves the entanglement. **C** (standalone `auth-oidc` service) — the provider needs the session + `users` + social/SAML flow that all live *in* `gateway-type1`; a separate service just calls back in, for no isolation benefit.

## 3. Components

New file `gateway-type1/lib/routes/oidc-provider.ts` (mounted public in `app.ts`, before the global `authenticate`, alongside `oauthMcpRouter`). New service `gateway-type1/lib/services/platform-oidc-keys.ts` (RS256 keypair, persisted in `system_properties.platform_oidc_signing_keys`, first-writer-wins — mirrors the shipped `oidc-keys.ts`). New table `oidc_clients`.

Endpoints (issuer root):
- `GET /.well-known/openid-configuration` — discovery; advertises the endpoints below, `id_token_signing_alg_values_supported:['RS256']`, `scopes_supported:['openid','profile','email']`, `response_types_supported:['code']`, `code_challenge_methods_supported:['S256']`.
- `GET /.well-known/jwks.json` — the platform OIDC public key (distinct `kid` from the MCP issuer).
- `GET /oauth/authorize` — §4 flow.
- `POST /oauth/token` — §5.
- `GET|POST /oauth/userinfo` — verifies the identity access token (§5) against the platform JWKS; returns `{sub,email,email_verified,name,picture}` from `users`.

## 4. Authorize — over the existing session

`/oauth/authorize` (`response_type=code`, `client_id`, `redirect_uri`, `code_challenge`+`S256`, `scope`, `state`, `nonce`):
1. Validate `client_id` against `oidc_clients`; `redirect_uri` must be in that client's `redirect_uris` — else reject **before** any redirect.
2. Require PKCE S256.
3. Resolve the human via the **`exchange_code` SSO bridge** — the proven pattern the MCP AS already uses (NOT a server-read of `langmart_session`; that cookie is a one-shot handoff the SPA exchanges into a `localStorage` key, and `optionalAuth` reads only headers, so a browser redirect to `authorize` carries no server-readable identity). Resolution order (mirrors `oauth-mcp.ts`): (a) `req.user` if a Bearer was attached (server/SPA path, via `optionalAuth`); (b) `?exchange_code=` → `redeemExchangeCode()` → `userId` (the browser path); (c) else bounce.
   - Resolved → mint a one-time auth code (10-min TTL) bound to `{userId, clientId, redirectUri, codeChallenge, scope, nonce}`; 302 to `redirect_uri?code&state`.
   - Not resolved → 302 to the web bridge `LANGMART_WEB_URL/mcp-redirect?return=<this authorize URL>`; the bridge page runs as the logged-in SPA user, mints an `exchange_code` via `/api/auth/exchange-code`, and returns to `authorize?exchange_code=…`. The bridge's `allowedReturnPrefixes` must include the platform authorize URL (a one-line web-app addition). A dedicated (non-MCP-named) platform bridge page is a follow-up.

Auth codes live in an in-memory Map with a periodic sweep (acceptable — a restart re-bounces an in-flight Connect through the already-present session; same posture as `oauth-mcp.ts`).

## 5. Token — both outputs are verifiable JWTs, neither is an `api_keys` row (load-bearing)

`POST /oauth/token` (`grant_type=authorization_code`, `code`, `code_verifier`, `client_id`, `client_secret`, `redirect_uri`):
- Verify client secret (hash) + PKCE (`SHA256(verifier)==codeChallenge`) + `redirect_uri` match + code unexpired/one-time.
- Return:
  - `id_token` — RS256 JWT signed by the platform OIDC key: `sub`=`users.id`, `iss`, `aud`=`client_id`, `nonce`, `exp` ≤ 15 min; `email/email_verified` if `email` scope, `name/picture` if `profile` scope.
  - `access_token` — RS256 JWT, `aud:"userinfo"`, `sub`, `exp` ~10 min. Its **only** accepted use is `/oauth/userinfo`.
  - `token_type:"Bearer"`, `expires_in`, `scope`.

**Why this is the crux:** the shared `authenticate` keystone validates *only* `api_keys` rows and `sessions`-table JWTs (verified with a *different* secret, `JWT_SECRET`). A platform-OIDC-signed JWT is neither — so it is **structurally incapable of authenticating to `/api/*`**. Login through this provider cannot mint anything that touches the general API. No `requireNotMcpToken`-style guard is needed; the fence is the credential shape itself. No refresh token in v1 (short access token; re-auth is a silent redirect through the live session).

## 6. Clients — controlled registry

New committed table `oidc_clients`: `id uuid pk`, `client_id text unique`, `client_secret_hash text`, `redirect_uris text[]`, `name text`, `created_at timestamptz default now()`. Seeded by an admin script/endpoint (master-org admin only) — the UI gateway is the first client. **No public `/oauth/register`** (the deliberate contrast with the MCP AS's open DCR).

## 7. Deprecate the MCP-AS OIDC (move, don't duplicate)

Remove from `gateway-type1/lib/routes/oauth-mcp.ts` the OIDC additions from `7dfa6cbe`: the `/.well-known/openid-configuration` handler, `/.well-known/jwks.json`, `/oauth/userinfo`, `mintIdToken`, and the `openid`-scope id_token branch in `/oauth/token`. `oauth-mcp.ts` reverts to a pure claude.ai **connector-token** AS (RFC 9728/8414 metadata, DCR for connectors, `mcp:read/write` tokens, `kind:mcp_oauth`). The `services/oidc-keys.ts` used only by that layer is removed. `ui-gateway/.env` repoints `OIDC_ISSUER` `mcp.*`→`api.*`; a new `oidc_clients` row for the gateway replaces its MCP DCR registration. Nothing else consumed the MCP OIDC (verified: only ui-gateway).

## 8. Schema migration (fold the landmine in)

One committed migration (`datastore/tables/` + the dump), idempotent:
- `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS metadata jsonb;` — makes rebuild-from-SQL match the live DB (MCP/SAML/ui-gateway all insert into it).
- `CREATE TABLE IF NOT EXISTS oidc_clients (…);` (§6).

## 9. Error handling

`invalid_client` (unknown client / bad secret); bad `redirect_uri` → rejected pre-redirect (never open-redirect); missing session → login bounce (not an error); expired/replayed code → `invalid_grant`; PKCE mismatch → `invalid_grant`; identity access token presented to `/api/*` → 401 from `authenticate` (structural); non-`userinfo`-aud token at `/oauth/userinfo` → 401.

## 10. Testing

- **Unit** (introduce a runner for gateway-type1 — none exists; `node --test` + `tsx`): id_token & access-token sign/verify, discovery-doc shape, PKCE S256 check, `oidc_clients` validation, redirect_uri allow-listing.
- **E2E** (live, against dev AS on `api.xeenhub.com`, ui-gateway repointed):
  1. full login: ui-gateway `/auth/login` → platform `/oauth/authorize` (over a real `langmart_session`) → code → id_token → ui-gateway session; `/auth/me` returns the real user.
  2. **Headline A/B — the structural fence:** the identity `access_token` is *accepted* at `/oauth/userinfo` (200, correct claims) and *rejected* at a real authenticated `/api/*` route (401) — proving login can't mint an API-capable credential.
  3. **Quarantine proof:** the MCP AS `/.well-known/openid-configuration` now 404s, while `POST mcp.*/oauth/token` still mints an `mcp:read/write` connector token (the MCP flow is intact).

## 11. Deployment

`gateway-type1` change → surgical SG deploy (per `sg-prod-surgical-hotfix`: overwrite the changed files from the target sha, rebuild only gateway-type1, `./core.sh restart 1`). The `oidc_clients` table + `api_keys.metadata` migration applied via `psql` (idempotent). `ui-gateway/.env` `OIDC_ISSUER` repoint + restart. Dev first (`api.xeenhub.com`), then SG when the user asks. Seed the gateway's `oidc_clients` row on each environment.
