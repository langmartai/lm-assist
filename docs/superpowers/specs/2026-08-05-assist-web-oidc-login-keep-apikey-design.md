# assist-web OIDC Login (keep the API key) — Design

**Date:** 2026-08-05 · **Status:** approved for implementation
**Scope:** migrate assist-web's login from the exchange-code bridge to standard OIDC against the platform provider (`auth.langmart.ai` / dev `auth.xeenhub.com`), **while preserving the `sk-session` API key** the SPA uses for every `/api/*` call.
**Explicit constraint (user):** keep the API key — assist-web needs it for direct `/api/*` access. So this migrates *authentication* to OIDC; it does NOT remove the browser-held key.

## 1. Problem

assist-web logs in via a bespoke bridge: `assist-connect` → main-site `/assist-redirect` (social SSO) → one-time exchange-code → assist-web `/auth-landing?code` → `POST /api/auth/redeem-code` → a raw `sk-session` **API key** → `loginWithApiKey()` → stored in `localStorage` (`langmart-web-api-key`), used as the Bearer for all `/api/*`. This is a non-standard identity handoff, and the only OIDC relying party today is the ui-gateway. We want assist-web on standard OIDC — but the OIDC access token is deliberately `userinfo`-only (the structural fence), so pure OIDC would break assist-web's API access.

## 2. Decision

**assist-web becomes a server-side confidential OIDC relying party (in its Next.js backend), then trades the verified id_token for the `sk-session` API key it already relies on.** Mirrors the ui-gateway's server-side RP model, so the provider is used as-is (confidential client + secret; no provider change). The id_token never reaches the browser — only the API key does, exactly as today.

Rejected: a browser-side public-client (PKCE-only) SPA flow — needs CORS on the provider's token endpoint and exposes the id_token to the SPA; the Next backend already exists, so server-side is cleaner and more secure.

## 3. Components

1. **`oidc_clients.trusted` flag** (DB migration): `ALTER TABLE oidc_clients ADD COLUMN IF NOT EXISTS trusted boolean NOT NULL DEFAULT false;`. Only *trusted* first-party clients may trade an id_token for an API key. The ui-gateway stays `trusted=false` (identity only — the fence holds for it).
2. **New endpoint `POST /api/auth/oidc-session-key`** (gateway-type1, `endpoints/auth/oidc-session-key.ts`), mounted **public** (self-authenticating via the id_token), rate-limited. Body `{ id_token }`. It:
   - Verifies the id_token against the platform JWKS (`platform-oidc-keys`): RS256, `iss` = `PLATFORM_OIDC_ISSUER`, `exp`, and `aud` = a registered client.
   - Loads the `aud` client from `oidc_clients`; **requires `trusted=true`** (else 403).
   - Mints an `sk-session` API key for the id_token's `sub` (reuse the exact `createSessionKey(userId, orgId)` logic from `callback.ts` — same `key_prefix='sk-session'`, expiry, `api_keys` row).
   - Returns `{ apiKey }`.
   - Security: an id_token is only obtainable by completing assist-web's OIDC login **as that user**; trading it yields a key **for that same `sub`** — no cross-user escalation. The `trusted` gate stops *other* OIDC clients (ui-gateway) from minting keys, preserving the fence for them.
3. **assist-web Next backend OIDC RP** (`assist-web/src/app/api/auth/oidc-*`):
   - `GET /api/auth/oidc-start` — create PKCE verifier + `state` + `nonce` (store server-side in an HttpOnly cookie/session), 302 to `${OIDC_ISSUER}/v1/auth/oidc/authorize` (client_id, redirect_uri=`…/api/auth/oidc-callback`, scope `openid profile email`, S256).
   - `GET /api/auth/oidc-callback` — validate `state`; exchange `code`→`id_token` at the token endpoint (confidential: client_id+secret, PKCE verifier); verify id_token (iss/aud/nonce); `POST` it to `…/api/auth/oidc-session-key` → `apiKey`; hand the apiKey to the SPA the same way `redeem-code` does today (a one-time internal handoff → the SPA's `loginWithApiKey`), then redirect to `/assist`.
   - The `client_secret` lives in assist-web's server env (gitignored), never in the browser.
4. **Retire** assist-web's `/assist-redirect`→exchange-code→`/auth-landing`→`redeem-code` login path (leave the `redeem-code` platform endpoint itself for now — other consumers may exist; just stop assist-web using it).
5. **Register** an `oidc_clients` row for assist-web: confidential (has secret), `trusted=true`, redirect_uris = assist-web's `/api/auth/oidc-callback` (dev + prod).

## 4. Data flow

`login → assist-web /api/auth/oidc-start → auth.* /oauth/authorize (SSO) → assist-web /api/auth/oidc-callback → [server: code→id_token → /api/auth/oidc-session-key → sk-session apiKey] → SPA loginWithApiKey(apiKey) → /api/* as today`.

## 5. Error handling

Unknown/expired code → the callback surfaces a login error (retry). id_token verify fail (bad sig/iss/exp/nonce) → callback 400, no key minted. `oidc-session-key` on a non-trusted `aud` → **403** (the fence). state mismatch → reject (CSRF). Token-endpoint/JWKS unreachable → login unavailable, existing sessions unaffected.

## 6. Testing

- **Unit:** id_token verify in `oidc-session-key` (accepts a valid platform id_token for a trusted aud; rejects wrong iss/exp/untrusted-aud); the trusted-gate 403.
- **E2E (live):** drive assist-web's `/api/auth/oidc-start` → authorize (resolve the test user via the x-api-key/exchange_code path as in the provider e2e) → callback → assert it returns/sets a **working `sk-session` apiKey** that (a) hits a real `/api/*` route = 200 and (b) is a normal api_key (not an OIDC JWT). **A/B:** the ui-gateway's id_token (untrusted client) → `oidc-session-key` = **403** (the fence holds for non-trusted clients).

## 7. Deployment

gateway-type1 change (new endpoint + `trusted` column) → surgical SG deploy (`sg-prod-surgical-hotfix`). assist-web change (Next RP routes) → rebuild+restart assist-web (dev :3849 / prod). Register the assist-web `oidc_clients` row (trusted) + set its client_id/secret + `OIDC_ISSUER` in assist-web's server env, per environment. Dev first (`auth.xeenhub.com`), then SG when asked.

## 8. Out of scope

Moving the API key server-side / behind a proxy (killing the browser key) — the user explicitly keeps it. Migrating other consumers off `redeem-code`. Scoping the minted key below full user (`sk-session`) — keep parity with today; scope-narrowing is a follow-up.
