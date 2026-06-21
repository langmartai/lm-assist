# One-Time Node Enrollment (`lm-assist login`) — Design

- **Date:** 2026-06-21
- **Status:** Implemented
- **Scope:** lm-assist worker (this repo). The matching hub endpoints live in the backend
  hub service and are described here only as an external API contract.

## 1. Problem & Goal

Provisioning a freshly-installed lm-assist node onto the hub requires copying a long-term API
key by hand; the key travels in the clear and never expires.

**Goal:** a secure, automatable **one-time node-enrollment** ("login") flow:

1. On an **existing authed node**, call its local API to mint a **one-time key** (the node relays
   to the hub using its own long-term key). Output is a self-contained **keypack**.
2. Carry the keypack to a **fresh, un-authed node** and call *its* local API with the keypack.
3. The fresh node **redeems** the keypack; the hub atomically issues a brand-new long-term key
   bound to the same account, marks the one-time key **used**, and returns the long-term key once.
4. The fresh node **persists** the long-term key, clears its node identity, and reconnects.
5. Exposed as `lm-assist login` / `lm-assist logout` **and** as a tokenless local `curl`.

## 2. End-to-end flow

```
AUTHED node (has long-term key)                    FRESH node (no key)
──────────────────────────────                     ──────────────────
lm-assist login --new-node
  └─POST 127.0.0.1:<port>/hub/enroll/create
      └─POST <hubHttp>/api/enroll/create            (Bearer long-term key)
      ◀─ { token, expiresAt }
  keypack = "lmkp_" + base64url({ v:1, hubUrl, token })
  print keypack + "run on new node: lm-assist login <keypack>"
                          ─────────  carry keypack  ─────────▶
                                                   lm-assist login <keypack>
                                                     └─decode → { hubUrl, token }
                                                     └─POST 127.0.0.1:<port>/hub/login { code }
                                                         └─POST <hubHttp>/api/enroll/redeem { token, machineId }
                                                         ◀─ { apiKey, hubUrl, user }
                                                     saveHubConnectionConfig({ apiKey, hubUrl })
                                                     clearGatewayId(); reconnect → auth_confirmed ✅
```

## 3. Hub API contract (external — implemented by the backend hub service)

The worker depends on two HTTP endpoints. Their internal implementation is out of scope for this repo.

- **`POST /api/enroll/create`** — **authenticated** (Bearer long-term key). Body `{ ttlMinutes?, fromGatewayId? }`.
  Mints a one-time enrollment token (stored hashed, default 15-min TTL, single-use). Returns
  `201 { token, expiresAt, hubUrl }`.
- **`POST /api/enroll/redeem`** — **public** (the one-time token is the credential). Body `{ token, machineId? }`.
  Atomically validates the token (pending + not expired), mints a long-term worker key bound to the
  token's owner, and marks the token used — exactly once even under concurrent requests. Returns
  `201 { apiKey, hubUrl, user }`, or `410 { reason }` for not_found / expired / already_used.

Properties the worker relies on: single-use redeem, short TTL, the long-term key is an ordinary
worker key bound to the inviter's account, and minting is authenticated while redeem is not.

## 4. Worker side — lm-assist (this repo)

### 4.1 Keypack codec — `core/src/hub-client/enroll-code.ts`

```ts
export interface Keypack { v: 1; hubUrl: string; token: string; }
export function encodeKeypack(k: Keypack): string   // "lmkp_" + base64url(JSON)
export function decodeKeypack(code: string): Keypack // strict validation (see §5)
```

### 4.2 Routes — `core/src/routes/core/hub.routes.ts`

- **`POST /hub/enroll/create`** — requires hub auth; relays to `<hubHttp>/api/enroll/create` with the
  node's Bearer key; returns `{ code, expiresAt }` (the keypack built from the node's own `hubUrl`).
- **`POST /hub/login`** — body `{ code }`; decode → redeem against `<hubHttp>/api/enroll/redeem` →
  `saveHubConnectionConfig({ apiKey, hubUrl })` → `clearGatewayId()` → reconnect → return status.
- **`POST /hub/logout`** — clear the key + node identity, disconnect.

`<hubHttp>` is the configured `hubUrl` with `ws(s):` → `http(s):` (the existing conversion used by
`GET /hub/user`). Enroll fetches use `redirect: 'manual'`.

### 4.3 Loopback-tokenless gate — `core/src/auth/enroll-exempt.ts` + `core/src/rest-server.ts`

Core gates every route behind the loopback `x-api-key` token. **Only `POST /hub/login`** is exempt,
and only when (a) the peer is **strict loopback** (`127.0.0.1`/`::1`/`::ffff:127.0.0.1`) **and**
(b) there is **no browser `Origin` header**. `POST /hub/enroll/create` is **not** exempt — minting
requires the token (the authed node has it locally; the CLI sends it). Everything else keeps the gate.

### 4.4 CLI — `bin/lm-assist.js`

`lm-assist login` (interactive), `lm-assist login <keypack>` (redeem), `lm-assist login --new-node`
(`--ttl`), `lm-assist logout`. The CLI sends the api-token via the existing loopback auth header.

## 5. Security model

- One-time token: short TTL, single-use, transported only over HTTPS inside the keypack; it is **not**
  a worker credential (it can only be redeemed once for a *separate* long-term key).
- **Redeem** (`/hub/login`) is tokenless from strict loopback + no-Origin (blocks drive-by CSRF — Core
  binds `0.0.0.0`). **Minting** (`/hub/enroll/create`) is token-gated. The keypack is the redeem credential.
- `decodeKeypack` restricts `hubUrl` to `ws://host` / `wss://host`, rejects link-local / cloud-metadata
  hosts, and caps the keypack at 8 KB. `redirect: 'manual'` on the enroll fetches.
- Logs never include the token, keypack, or minted key.

## 6. Dev/prod & the "dev → prod endpoint" point

The keypack **carries `hubUrl`**, so redeeming on a *dev* node writes the prod hub URL into the dev hub
config (overriding the dev default) and connects there — no extra flags. Worker code uses the existing
dev/prod config-path logic.

## 7. Testing

- Unit (node:test): keypack codec (round-trip, malformed, scheme/link-local/oversize rejection) +
  the loopback/Origin exemption helper.
- Worker routes: `/hub/enroll/create` / `/hub/login` / `/hub/logout` against an alt-port worker;
  loopback-vs-LAN and Origin gating; a fresh node redeems a keypack and connects.
- End-to-end: generate on an authed node, redeem on a fresh node, confirm enrollment + that the token
  is single-use.

## 8. Rejected alternatives

- **Directly mint a long-term key and pass it** — violates "one-time / invalidate after use".
- **One-time key as a normal worker key** — it could then be used as a credential directly; weaker.
- **Swap the key at the WS layer** — needs new protocol messages; the HTTP exchange reuses the
  unchanged connection path.
