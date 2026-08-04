# Pluggable UI Gateway — Auth & Credential Model (Design)

**Date:** 2026-08-04 · **Status:** draft for review
**Scope:** the gateway's identity, session, and credential model, plus the v1 trusted-UI registry.
UI generation, catalog/discovery, and component linting are follow-on specs.

## 1. Problem

lm-assist cannot add a UI without code changes on every node, and its browser credential model
makes doing so unsafe anyway:

- The node's service map is hardcoded (`/admin`, `/assist`, `/vibe`) in
  `core/src/hub-client/index.ts` — a new UI means a Core change plus a fleet deploy.
- Every page served through the hub's `/w/<machineId>/<service>/` relay is same-origin with every
  other UI on that machine and receives the node's **full-power** API token inlined as
  `window.__LM_API_TOKEN__`. That token is permanent in practice (rotation has never fired —
  `bl_ff8aad3b`), so any single page-scrape is an unbounded node compromise.
- The relay imposes a 30s timeout, 1MB body cap, no WebSocket/SSE, stripped headers, and gives the
  node no caller identity.
- The fleet runs on six opaque bearer credentials, none of which carries its own scope; the
  "may this caller reach this?" decision is re-implemented in five code paths across hub and node.

**Goal:** pluggable UIs — registered now, generated later — with SSO, where the browser never
holds a credential more powerful than the one view it is rendering.

## 2. Decision

Build a standalone **UI gateway**: its own origin, serving UI artifacts itself. Pluggable UIs
never transit the `/w/` relay.

- **v1 serves trusted, registered UIs only** (user's increment selection). The isolation model is
  built for untrusted code from day one, so admitting generated UIs later is a registry policy
  change, not an architecture change.
- Rejected — *B: new auth but still served via `/w/`*: cannot isolate untrusted code (shared
  origin, machine-scoped cookie) and inherits every relay limit. *C: retrofit the existing
  system*: surgery on three smeared authorization layers across two repos, and it still cannot
  isolate without a new origin — you end up building A anyway, entangled.

## 3. Identity — standard OIDC relying party

LangMart's AS is an OIDC provider since `7dfa6cbe` (live on `https://mcp.langmart.ai`:
discovery, JWKS, RS256 id_token, userinfo). The gateway federates as a **standard OIDC
relying party** — any off-the-shelf client library, zero custom federation code.

- Login: authorization-code + PKCE redirect to the AS with scope `openid profile email` and a
  `nonce`. How the AS logs the human in (its web login bridge) is the AS's internal detail —
  the gateway never touches it.
- The gateway verifies the returned `id_token` against the published JWKS (`iss`, `aud`,
  `nonce`, `exp`) and starts its own session from the claims (`sub`, email, name, picture).
- The gateway holds **no full-power LangMart key, ever** — stronger than the earlier draft,
  which parked a redeemed `sk-…` key server-side. What the token endpoint returns is an
  OAuth-minted access token that (per scope fix `f71918f0`) reaches only `/mcp` and
  `/oauth/userinfo`; the gateway keeps it and the rotating refresh token server-side solely to
  re-confirm the account periodically.
- Client registration: one pre-registered OAuth client for the gateway (DCR at deploy time or a
  seeded registry row) carrying the gateway's redirect URI.
- This deliberately breaks with the current assist-web pattern (JS-readable `langmart_session`
  cookie copied into `localStorage` as a full-power key). That pattern is the anti-goal.

## 4. Sessions

- Gateway session cookie: **HttpOnly, Secure, SameSite=Lax**, gateway origin only. Opaque id →
  server-side record `{userId, claims, refreshToken, createdAt, exp}`.
- TTL 7 days sliding. Logout deletes the record — which also kills every future token mint.

## 5. View tokens — one claim set

The gateway is the **single issuer and validator** of view tokens: short-lived signed JWTs handed
to a UI page. This is the "role that holds identity and cross-checks access" — it exists because
we trust neither the browser nor the node with each other's credentials.

| claim | meaning |
|---|---|
| `sub` | LangMart user id, or `anon` for share links |
| `aud` | `uiId` this token renders |
| `grant` | array of `{service, pathPrefix, verbs}` the UI may reach |
| `iss` | the gateway |
| `exp` | ≤ 15 minutes |

- Minted per page-load from a live session; silently re-minted on 401 while the session lives.
- Revocation = session deletion (stops re-mints) + short `exp` (bounds outstanding tokens). No
  revocation list in v1.
- The three access modes are **token shapes, not code paths**: your own UI (`sub`=owner, owner's
  grant), someone else's UI (`sub`=viewer, the *viewer's* grant), share link (`sub`=`anon`, a
  narrow grant pinned at link creation).

## 6. Data plane — declared contracts, server-side fetch

- A UI's registry entry **declares** the data it needs; that declaration becomes its grant.
- The UI calls the gateway's data API with its view token. The gateway checks the grant, then
  fetches from the node **server-to-server** over the existing hub↔worker channel, using a node
  scoped token (`scoped-token.ts` — the Core primitive built for exactly this, currently unused).
- The browser never holds a node credential; the node never trusts a browser. WebSocket/SSE work
  because the gateway owns both legs.

## 7. v1 registry — trusted UIs

Gateway-local table: `{uiId, name, artifactSource, grant, owner, enabled, trust:'trusted'}`.
Adding a UI = a registry write + artifact upload; **zero node deploys**. No fleet-sync in v1 —
only the gateway consumes the registry.

## 8. Errors

- Unknown `uiId` → 404. Disabled → 403. Expired view token → 401 and the page re-mints silently
  via its session; session gone → login redirect.
- Grant violation → **403 naming the denied `{service, path}`** — refuse loudly, echo what was
  attempted (the backlog-registry lesson).
- LangMart bridge down → new logins unavailable; existing sessions keep working until `exp`
  (the gateway validates sessions locally).

## 9. Testing

- Unit: claim validation, grant matcher, session-store expiry.
- E2E A/B (the proof style that verified the MCP scope fix):
  1. a view token for UI-X reaches X's granted path and gets 403 on any other path;
  2. every byte the browser receives across the full login+render flow is grepped for the
     OAuth access/refresh tokens and the node api-token — **all must be absent**;
  3. a share-link token works logged-out and carries only its pinned grant.

## 10. Out of scope (follow-on specs)

UI generation pipeline · catalog/discovery · component linting ·
migrating the three built-in UIs off `/w/` · LangMartDesign's open DCR + unread `permissions`
field (its own finding, filed separately). The OIDC layer on LangMart's AS was originally
listed here — it shipped early (`7dfa6cbe`) and is now the §3 login path.

## 11. Deployment shape

One new service in the hub estate beside `gateway-type1`/`assist-api` (LangMartDesign family; SG
deploys remain user-managed). One origin (e.g. `ui.langmart.ai`) in v1 — acceptable because all
UIs are trusted; per-UI origin isolation (subdomain per `uiId`) is the already-planned lever for
the untrusted era.
