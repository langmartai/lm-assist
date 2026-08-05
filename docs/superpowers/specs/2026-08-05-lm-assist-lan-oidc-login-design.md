# lm-assist LAN Login via Platform OIDC (identity-only RP) — Design

**Date:** 2026-08-05 · **Status:** approved for implementation
**Scope:** replace lm-assist web's LAN-admission login (popup → platform `assist-connect` → postMessage of the user's **raw platform API key** → `cloud-verify`) with a standard OIDC authorization-code flow against the platform provider (`auth.langmart.ai` / dev `auth.xeenhub.com`). lm-assist becomes an **identity-only** relying party. All local tokens (`lanAccessToken`, the `x-api-key` worker token, the device-bound hub key) are unchanged.

## 1. Problem

A non-localhost LAN browser hitting lm-assist web is gated by `lanAccessToken` (`useLanAuthGuard` → `/lan-blocked`). Today's sign-in: popup to `https://<hubDomain>/assist-connect?mode=verify` → the platform SPA postMessages the signed-in user's **full-power platform API key** cross-window → `/api/auth/cloud-verify` validates it at the gateway, compares with the device-bound hub user (`GET /hub/user`), and hands out the `lanAccessToken`. Problems: a raw full-power key transits `postMessage`; the popup/opener flow is fragile (opener loss after OAuth redirect → two-click UX; `isAllowedOrigin` rejects LAN-IP origins outright); and it is a bespoke identity handoff where a standard one now exists.

## 2. Decision

**lm-assist web's Next backend becomes a public (secret-less, PKCE) identity-only OIDC RP.** Redirect (no popup) to the platform authorize endpoint; the callback verifies the id_token server-side, applies the **same device-owner rule** as today (`id_token.sub === /hub/user id`), and on match grants the existing `lanAccessToken`. No platform API key is obtained or needed — the client is registered `trusted=false`, so it is **structurally unable** to mint one (the `oidc-session-key` fence 403s it).

Why a public client: lm-assist installs on many machines; one shared "confidential" secret distributed to every install is not confidential, and per-node registration is heavy. Public client + PKCE S256 is the standard for installed apps (RFC 8252); the provider already mandates PKCE for every client.

Why identity-only: authorization is inherently local (is this the device owner?), so an id_token is all lm-assist needs. The fence stays exactly as strong.

## 3. Components

### Platform (LangMartDesign, gateway-type1)
1. **`oidc_clients.public` flag** (migration + `tables/50`): `ALTER TABLE oidc_clients ADD COLUMN IF NOT EXISTS public boolean NOT NULL DEFAULT false;` `client-store.ts` SELECTs + exposes it; `seedOidcClient` accepts it.
2. **Token endpoint public-client path** (`oidc-provider.ts` ~line 85): if `client.public`, skip the `client_secret` hash comparison (PKCE, already enforced at line ~90, carries the proof); non-public clients unchanged. A public client MUST still present the correct `code_verifier`.
3. **LAN redirect sentinel** (`redirectAllowed` in `client-store.ts`): a `redirect_uris` entry of the form `lan:<path>` matches `http://<host>:<port><path>` where `<host>` is `localhost`, `127.0.0.1`, or an RFC1918 address (`10.*`, `172.16-31.*`, `192.168.*`), any port, `<path>` exact. Admin-seeded like any other entry — only clients that list it get it. Exact-match entries keep working.
4. **Seed `lm-assist-local`** (`scripts/seed-lm-assist-oidc-client.ts`): `public=true`, `trusted=false`, `redirect_uris=['lan:/api/auth/oidc-callback']`, no secret.

### lm-assist (this repo, web/)
5. **`GET /api/auth/oidc-start`** (Next route): derive the issuer from Core `GET /hub/status` → `hubUrl` (`assist-api.langmart.ai` → `https://auth.langmart.ai`; `xeenhub` likewise; no hub → redirect back to `/lan-blocked?error=no_hub`). Mint PKCE verifier/challenge (S256) + `state` + `nonce` into an HttpOnly `lm_oidc` cookie (SameSite=Lax, 600 s); `redirect_uri = <request origin>/api/auth/oidc-callback`; 302 to `<issuer>/v1/auth/oidc/authorize` (`client_id=lm-assist-local`, `scope=openid profile email`).
6. **`GET /api/auth/oidc-callback`**: validate `state` against the cookie; POST the token endpoint (`grant_type=authorization_code`, `code`, `code_verifier`, `client_id` — **no client_secret**); verify the id_token with **jose** (`createRemoteJWKSet(<issuer jwks_uri>)`, RS256, `iss`, `aud=lm-assist-local`, `exp`, and `nonce === cookie.nonce`); fetch the device-bound user (`GET /hub/user` with `serverAuthHeader()`); require `claims.sub === hubUser.id` else `/lan-blocked?error=owner_mismatch`; on match read/auto-generate `lanAccessToken` in `~/.lm-assist/assist-config.json` (same logic as `cloud-verify`); clear the cookie; 302 to **`/lan-blocked#granted=<token>`** (URL *fragment* — never sent to servers/logs).
7. **`/lan-blocked` rework**: on mount, if `location.hash` carries `granted`, store it as `assist_access_key`, strip the hash, `router.replace('/')`. "Sign In" becomes a same-tab redirect to `/api/auth/oidc-start` (popup + `postMessage` listener + `cloud-verify` call removed). Show `error=` params (`owner_mismatch`, `no_hub`, `oidc`) inline. Manual-token steps stay. `cloud-verify/route.ts` is kept but marked deprecated (removal is a later cleanup); `cloud-connect` (device binding in Settings) is untouched.

## 4. Data flow

`LAN browser → /lan-blocked → /api/auth/oidc-start → auth.<hub>/v1/auth/oidc/authorize (SSO on the platform) → /api/auth/oidc-callback [server: code+PKCE→id_token → verify → sub===hub/user → lanAccessToken] → /lan-blocked#granted → localStorage assist_access_key → dashboard`. The platform API key never appears anywhere in this flow.

## 5. Security notes

- **Fence intact:** `lm-assist-local` is `trusted=false` → `oidc-session-key` 403s its id_tokens (e2e-asserted). Public ⇒ never trusted, by seeding.
- **Loose LAN redirect, bounded blast radius:** with PKCE, an intercepted code is useless without the verifier. The residual risk (user completes login for an attacker-initiated flow on a hostile LAN) yields only identity *claims* — no platform key (fence), no lanAccessToken (the attacker's box grants against *its own* device-owner, not the victim's node).
- The `lanAccessToken` handoff uses a URL fragment (not query) so the long-lived local secret stays out of request lines and logs; it lands in the same `localStorage` slot the popup flow used.
- Owner rule unchanged: only the platform user the *device* is bound to is admitted — same as `cloud-verify` today.

## 6. Error handling

No hub configured → `no_hub` (manual token remains). Provider/JWKS unreachable → `oidc` error, no grant. `state`/`nonce`/signature/`iss`/`aud` failure → `oidc` error, no grant. `sub` mismatch → `owner_mismatch` with explicit copy. Token endpoint `invalid_client`/`invalid_grant` → `oidc` error. Every failure path clears the `lm_oidc` cookie and grants nothing.

## 7. Testing

- **Unit (platform):** sentinel matcher (accepts `http://10.0.1.117:3948/api/auth/oidc-callback`, `http://192.168.1.5:3848/...`, `http://localhost:3848/...`; rejects public IPs, `https` downgrade-mix, wrong path, `172.32.*`); public-client token path (no secret accepted, wrong `code_verifier` still rejected); non-public client still requires its secret.
- **Unit (lm-assist):** issuer derivation from `hubUrl`; owner-match decision; fragment-grant handling.
- **E2E (dev, live):** drive `:3948` `/api/auth/oidc-start` → authorize (resolve the test user via `x-api-key`, as in the provider e2e) → callback → assert `#granted=<lanAccessToken>` matches `assist-config.json` and admits via `/api/auth/validate`; **wrong-user** id_token → `owner_mismatch`, no grant; **fence A/B:** an `lm-assist-local` id_token POSTed to `oidc-session-key` → **403**.

## 8. Deployment

Platform: migration + code on gateway-type1 (dev first; SG surgical + prod seed when asked). lm-assist: normal web build; dev `:3948` first, fleet deploy later. Per-env seeding: run `seed-lm-assist-oidc-client.ts` against each environment's DB (no secret to distribute — the client is public).

## 9. Out of scope

Removing `cloud-verify`/the `assist-connect` verify mode (deprecate only). Per-node redirect registration. OIDC for the cloud-proxied path (already authenticated by the platform). Replacing `lanAccessToken`/`x-api-key` with sessions (the local token model is kept deliberately).
