# Browser auth (Stage 1)

How a browser gets — and does not get — authority over a node's Core API, and the rules
every loopback-trust decision in Core follows. Code: `core/src/auth/` (`browser-token.ts`,
`peer-trust.ts`, `origin-policy.ts`, `ttyd-cap.ts`, `lan-access.ts`, `api-token.ts`,
`token-admin.ts`), `core/src/ttyd-proxy.ts`.

## The rule: no HTML carries a credential

The web layout used to inline the Core ring token (`window.__LM_API_TOKEN__`) into every
server-rendered response — pages, RSC flights, 404s, `/lan-blocked`. Anything that could
fetch a page (a LAN device, a relayed request, the web's own `/_coreapi` rewrite) walked
away with full node authority. Now the layout injects only `window.__LM_LOCAL_API_PORT__`,
and the browser asks **Core** for the token at runtime, because only Core sees the real
TCP peer.

- **Direct local mode** (the page talks to Core on `http://<host>:<corePort>` or, behind the
  HTTPS terminator, `/_coreapi`): the web calls `GET /auth/browser-token` once, keeps the
  token in module memory, and re-fetches after a 401 (rotation).
- **Hub-proxied mode** (`/w/<id>/assist/…` through the hub web-proxy): the browser never
  holds the node token. The hub relay injects `x-api-key` server-side on every relayed
  request, so the web does not call `/auth/browser-token` at all.

## `GET /auth/browser-token`

Its own gate, dispatched in `rest-server.ts` **before** the api-token gate. Any `x-api-key`
on this route is ignored, so a relayed browser can never trade its injected key for the
ring token. Decision order, first match wins:

| # | Condition | Result |
|---|---|---|
| 1 | method ≠ GET | 405 `METHOD_NOT_ALLOWED` |
| 2 | `x-relay-source` present | 403 `RELAYED` |
| 3 | `Origin` present and not an allowed web origin | 403 `ORIGIN_NOT_ALLOWED` |
| 4 | `X-LM-Client` ≠ `web` | 400 `CLIENT_HEADER_REQUIRED` |
| 5 | `LM_ASSIST_API_AUTH` kill-switch off | 200 `{ token: null, via: 'auth-disabled' }` |
| 6 | direct local peer (below) **and** `Host` names this machine | 200 `{ token, via: 'local' }` |
| 7 | `X-LM-LAN-Key` present: valid (timing-safe) while `lanAuthEnabled` | 200 `{ token, via: 'lan-key' }`, else 401 `LAN_KEY_INVALID` |
| 8 | anything else | 401 `UNAUTHORIZED` |

Any exception → 500 `INTERNAL`, never with a token. Success body:
`{ success: true, data: { token, via, expiresAt: null } }`; errors:
`{ success: false, error: { code, message } }`. Headers: `Cache-Control: no-store`,
`Vary: Origin`, plus CORS.

Why each check:

- **The socket peer** is the only honest "is this machine?" signal — and only when nothing
  stood in between (next section).
- **Host** stops DNS rebinding: a rebound page's request is same-origin, so it carries no
  `Origin`, but it does carry the attacker's hostname.
- **`X-LM-Client`** is a non-safelisted header: a cross-origin page must preflight (answered
  only for own origins), and no-cors fetches, `<script>`/`<img>` tags and navigations can
  never send it.

## Forwarding headers: presence cancels loopback trust

The web binds `0.0.0.0` and rewrites `/_coreapi/*` to `127.0.0.1:<corePort>`, so a LAN
browser reaches Core **from loopback**. Next's proxy always marks that hop with
`x-forwarded-host` — set to the incoming Host, which can be the empty string. The hub relay
also dials Core over loopback, marked with `x-relay-source`.

So in `peer-trust.ts`, the **presence** of any of `x-forwarded-for`, `x-forwarded-host`,
`forwarded`, `x-real-ip` (any value, `''` included) means "the socket peer is not the
caller". `x-forwarded-proto` is deliberately **not** in the list: the HTTPS terminator sets
it on an in-process dispatch whose socket *is* the real peer, so the desk on
`https://localhost:<webPort+1>` stays trusted.

Every loopback/local trust point uses it:

| Site | Rule |
|---|---|
| `/auth/browser-token` branch 6 | direct local peer (loopback or an own interface IP), no forwarding, not relayed |
| `LM_ASSIST_API_AUTH_EXEMPT_LOCAL=1` gate exemption | same, plus own `Host` and no foreign `Origin` |
| `POST /hub/login` enrollment exemption | strict loopback, no `Origin`, no forwarding, not relayed |
| `/auth/is-local` | direct local peer |
| mcp-plugins enable/disable/grant/sync-connector | direct loopback, **relay refused** (as its message always said) |
| machine-access writes, `/cluster/self`, `/mission/controller/adopt`, memory-sync, rule-sync | direct loopback; the hub relay's direct dial still accepted |
| harness provider credential write | stricter: also refuses `x-forwarded-proto` (console-only) |
| data access-manager `local` / `peer` / sync-`owner` principals | loopback **and** no forwarding header |

The hub relay strips client-supplied `x-relay-source`, `x-lm-user-id` and every forwarding
header (`sanitizeRelayHeaders`) before re-issuing a request, so relay-accepting guards keep
working. Consequence: loopback-only admin writes no longer work through the web's
`/_coreapi` proxy (LAN or hub-proxied pages). They still work from the desk (direct or via
the HTTPS terminator), the CLI and MCP.

## CORS

Core no longer answers `Access-Control-Allow-Origin: *`. For a request with an `Origin`:

- `Vary: Origin` always.
- The Origin is reflected (with `Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`,
  `Allow-Headers: Content-Type, Authorization, X-API-Key, X-LM-Client, X-LM-LAN-Key`,
  `Max-Age: 600`) only when it is **this machine's web UI** — `http://<own-host>:<webPort>`
  or `https://<own-host>:<httpsPort>` — or when the request (the preflight's
  `Access-Control-Request-Method` on OPTIONS) targets a **scoped-token route**, which keeps
  any-origin reflection so `lmsc_` embeds still work.
- Never `Allow-Credentials`. OPTIONS always answers 204.
- The raw-socket handlers (`/stream`, `/tasks/events`, the cowork and completion streams)
  set no CORS header of their own: `writeHead` headers **replace** the ones `routeRequest`
  staged, which is how `/tasks/events` kept answering `*` after the allow-list shipped. A
  static guard in `rest-server-request-safety.test.ts` fails on any
  `'Access-Control-Allow-Origin': '*'` literal in `core/src`.

Requests without an `Origin` (CLI, MCP, hooks, fabric, the hub relay, the local-tier BFF)
are unaffected.

Ports: `webPort = WEB_PORT || ASSIST_WEB_PORT || 3848 (npm install) / 3948 (repo)`,
`httpsPort = LM_HTTPS_PORT || webPort + 1`. Own hostnames: `localhost`, `127.0.0.1`, `::1`,
every interface address, `os.hostname()` and `<hostname>.local`, refreshed every 60 s.

Two env vars widen the **Host** check and the **Origin** check (decision row 3) — and
nothing else:

| Env | Meaning |
|---|---|
| `LM_ASSIST_ALLOWED_HOSTS` | CSV of extra hostnames treated as this machine's names (Host check and web origins) |
| `LM_ASSIST_CORS_ORIGINS` | CSV of extra exact origins to reflect (scoped-token embeds, LAN-key clients) |

They **never grant local trust**. `via: local` (row 6) also needs the TCP peer to be loopback
or one of this machine's interface IPs **with no forwarding header**, and no env var changes
that. So:

- **Works as a local desk:** a same-machine DNS alias (with `LM_ASSIST_ALLOWED_HOSTS`),
  `localhost`, and the built-in `LM_HTTPS` terminator.
- **Is a LAN client:** a NAT or port-proxy address (for example a WSL2 or `netsh portproxy`
  address — the peer Core sees is the gateway, not this machine) and **any third-party reverse
  proxy** (Caddy, nginx: an https page always calls `/_coreapi`, and Next's rewrite always
  adds `x-forwarded-host`). These need the allow-list entry so their Origin passes **and a
  LAN key** (below). For https, use `LM_HTTPS` rather than a third-party proxy.

Trusting a NAT or port-proxy peer IP instead is deliberately not offered: that peer fans in
every client behind it, so it would hand the ring token to the whole LAN — exactly the
laundering the forwarding-header rule removes.

## Terminals: capabilities and a loopback-only ttyd

ttyd 1.6.3 has no credential of its own and every terminal is writable, and the ttyd proxy
used to dial **any** local port without auth — an open relay to every loopback service. Now:

- ttyd is spawned with `-i 127.0.0.1` (all five spawn sites; `ttydLoopbackArgs()`), so it is
  reachable only through Core. Windows never spawns ttyd.
- `/ttyd-proxy/<port>/…` (and the relay's `/ttyd/<port>/…`) authenticates **first** — a valid
  `x-api-key` or a valid capability — and only then requires an active Core-managed ttyd
  instance on that port: unauthenticated → 401 on every port (no port oracle), authenticated
  but unmanaged → 404. `x-api-key` is never forwarded to ttyd.
- Iframes cannot send headers, so Core builds every terminal URL as
  `/ttyd-proxy/<port>/c/<cap>/` with
  `cap = base64url(HMAC-SHA256(HMAC-SHA256(ringToken, 'lm-assist/ttyd-cap/v1'), '<port>:<instanceId>'))`.
  It is bound to one ttyd instance, stable for its life (the dashboard re-derives URLs on every
  poll without reloading the iframe), survives a Core restart, stays valid through a
  scheduled rotation's grace window and dies at once on revoke-now. It lives in the **path**
  because ttyd builds `/ws` and `/token` from `location.pathname` (the query string never
  reaches `/token`). The root page is served `Referrer-Policy: no-referrer` and `no-store`.
- `GET /ttyd/processes` returns `hash = <processHash>.<tokenGeneration>`, so a client polling
  with `?hash=` refetches its URLs after any rotation.
- The web treats terminal URLs as opaque and never builds `http://<host>:<ttydPort>`.
- Hub-proxied terminals are unchanged for the browser; the node side is authorized by the
  relay-injected `x-api-key` (HTTP) and by `ConsoleRelayHandler`, which now sends the
  api-token on its WebSocket into the proxy.

If a node's ttyd build cannot bind `127.0.0.1`, terminal start fails with "port not bound" —
there is deliberately no switch that re-opens all interfaces.

## LAN access

`<dataDir>/assist-config.json` (0600): `lanAuthEnabled` (default `true`) and `lanAccessToken`.

- `lanAuthEnabled: true` — LAN browsers present the LAN key as `X-LM-LAN-Key` to
  `/auth/browser-token`. A browser gets the key by:
  - **Sign In on `/lan-blocked`** (OIDC with the cloud account that owns the node). Needs a
    cloud-bound node and a page on `http://localhost` or an RFC1918 address — the redirect
    URI is built from that host.
  - Otherwise, the operator-only legacy link `/auth?token=<lanAccessToken>`, with the key
    read from `<dataDir>/assist-config.json` on the node. The page scrubs it from the address
    bar and history at once. Nothing generates this link any more.
  `/lan-blocked` has no field to paste a key into (a Stage-2 item).
- `lanAuthEnabled: false` now means **new** LAN sign-ins are refused: the LAN-key branch of
  `/auth/browser-token` stops issuing. It used to mean "open LAN".
- The browser keeps the key in `localStorage['assist_access_key']`; the OIDC hand-off passes
  it in a URL fragment (`/lan-blocked#granted=…`), which never reaches a server.

⚠️ **Turning LAN access off, or `token lan-key --regenerate`, does not sign anyone out.** A
LAN browser that signed in received the full ring token (Stage 1 has no per-device
credential), and Core's gate checks only the token, never the peer or the LAN setting. Open
LAN tabs keep working, and a device that kept the token keeps full Core and terminal
authority. To evict every LAN device, revoke the token **and** replace the LAN key (a device
re-bootstraps from its stored key otherwise):

```bash
lm-assist token rotate --now --lan-key
```

This machine's own tabs recover by themselves. Restart any older Core sharing the data dir
(see Rotation). The Settings toggle and the CLI say this; per-device, revocable browser
credentials are Stage 2.

## Rotation

The scheduled rotation (30 days, 7-day grace ring) is unchanged, and nothing rotates or
revokes on boot. **Revoke-now** is an explicit operator action:

```bash
lm-assist token rotate --now [--lan-key]               # npm install (bin forwards to core)
node core/dist/cli.js token rotate --now [--lan-key]   # dev checkout
node core/dist/cli.js token lan-key --regenerate       # NEW LAN sign-ins need the new key
node core/dist/cli.js token status                     # timestamps + counts, never a value
```

(`lm-assist token …` runs the same code as `node "$(npm root -g)/lm-assist/core/dist/cli.js" token …`;
both act on `LM_ASSIST_DATA_DIR` or `~/.lm-assist` of the shell that runs them.)

or `POST /auth/token/rotate {regenerateLanKey?}` — token required, direct loopback, no
`Origin`, no forwarding or relay header.

Revoke-now mints a new token and revokes **every** known token (current, grace, the file's,
the meta sidecar's). Revocations are sha256 hashes in `<dataDir>/api-token.revoked.json`
(0600, 90-day / 200-entry bound), written **before** the new token file so a peer Core that
notices the file change already finds them. Every Core on this build filters its ring by
that file and re-checks the token file at most once a second even on a ring hit, so the old
tokens die everywhere within about a second. Open dashboard tabs re-fetch on their next 401;
scripts re-read the token file.

⚠️ An **older Core** sharing the data dir (dev and prod on one host share
`~/.lm-assist/api-token`) neither reads the revoked file nor re-checks on hits: it keeps the
old token valid until it restarts. Restart it after a rotate-now. The revoked file is
separate from `api-token.meta.json` precisely because an older build rewrites the meta file
at its own rotation and would re-add a revoked token there.

Never run a rotate-now against a live data dir from tests or scripts: every Core and client
sharing it is cut off. Tests use `LM_ASSIST_DATA_DIR=$(mktemp -d)`.

## Framing (clickjacking)

The dashboard acts with full Core authority, and a framed page is still same-origin with
Core's allow-list — `/auth/browser-token` judges the socket, not the top-level site. So a
hostile page could frame `/settings` and lay a decoy over a button. The one that matters is
the cloud-connect confirm: `/api/auth/cloud-connect` 303s **any** caller to
`/settings#cloudConnect=1&key=…&hubUrl=…`, so a link carrying the attacker's own key for the
real platform hub arms the card, and one click rebinds the node to the attacker's account.

- Every web response carries `Content-Security-Policy: frame-ancestors 'self'
  https://langmart.ai https://*.langmart.ai https://xeenhub.com https://*.xeenhub.com`
  (`web/next.config.ts`): same-origin frames (hybrid consoles, terminals) and the platform
  iframe that shows hub-proxied pages. Nothing else. No `X-Frame-Options` — it cannot express
  an allow-list.
- Independently of that header (a proxy in front may drop it), the confirm card refuses to
  arm inside any frame (`web/src/lib/cloud-connect-arm.ts`). The legitimate fallback lands in
  the sign-in popup, a top-level window.
- The card no longer says "the account that just signed in" — nothing records that this
  browser started a sign-in. It says a link asks to connect an account that will control the
  device, and asks to **replace** the account when the node is already bound.

Stage 2: a one-shot sign-in nonce (or a platform-echoed `state`) so the card arms only for a
sign-in this browser started, and showing which account the key belongs to.

## Voice

The voice WebSockets still carry the ring token as `?token=` (browsers cannot set WS
headers); the web now takes it from the runtime-fetched token instead of a window global.
Single-use voice tickets are deferred to Stage 2.

## Verifying

`core/scripts/check-token-leak.js` is the regression gate. It reads the ring token(s) and the
LAN key into memory only and prints counts, never values:

```bash
node core/scripts/check-token-leak.js --web http://<LAN-IP>:<webPort> --core http://<LAN-IP>:<corePort>
```

Every line must be `PASS … ring=0 lan=0`. Run it against a packed build before publishing.

## Stage 2 direction

Stage 1 still gives an authenticated browser the full ring token in JS memory. Stage 2
replaces it with a short-lived, narrowly-scoped browser credential: `/auth/browser-token`
returns a numeric `expiresAt` (the web already refreshes 60 s before it), `/auth/check`
accepts those credentials, terminal capabilities bind to the browser session rather than the
ring, voice moves to single-use tickets, and hub-key exposure to hybrid-mode pages is
restricted. The `peer-trust` and `origin-policy` modules are the building blocks.
