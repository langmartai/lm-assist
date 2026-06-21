# One-Time Node Enrollment (`lm-assist login`) Implementation Plan

> Scope: the **lm-assist worker** side (this repo). The matching hub endpoints
> (`POST /api/enroll/create`, `POST /api/enroll/redeem`) are implemented by the backend
> hub service and are treated here as an external API contract (see the design doc §3).

**Goal:** Let an authed lm-assist node mint a self-contained, single-use 15-minute "keypack" that a
fresh node redeems (via CLI or one local curl) to obtain a long-term hub key and auto-connect.

**Tech:** TypeScript core (tsc + `node --test`), raw Node HTTP server, `bin/lm-assist.js` CLI.

## Hub API contract (external)

- `POST /api/enroll/create` — authed (Bearer long-term key), body `{ ttlMinutes?, fromGatewayId? }`
  → `201 { token, expiresAt, hubUrl }`.
- `POST /api/enroll/redeem` — public, body `{ token, machineId? }` → `201 { apiKey, hubUrl, user }`
  or `410 { reason }` (not_found / expired / already_used). Single-use, short TTL.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-21-onetime-node-enrollment-design.md`.
- chokidar stays `^3.6.0`; never plain `npm install` — `npm install --ignore-scripts`. Node ≥ 20.9.
- Loopback exemption: strict 3-value loopback (`127.0.0.1`/`::1`/`::ffff:127.0.0.1`) **and** no browser
  `Origin`; **only** `POST /hub/login` (redeem). Minting stays token-gated. Never log token/keypack/key.

---

### Task 1: Keypack codec (`enroll-code.ts`) — TDD

**Files:** Create `core/src/hub-client/enroll-code.ts`; Test `core/src/__tests__/enroll-code.test.ts`.
**Produces:** `Keypack{v:1,hubUrl,token}`, `encodeKeypack` (`"lmkp_"+base64url`), `decodeKeypack` (strict).

- [ ] Write the failing test (round-trip + malformed prefix/encoding/shape; reject non-ws/wss scheme,
  link-local/metadata host, and >8 KB).
- [ ] Run `npm run build:test && node --test … enroll-code.test.js` → FAIL (module missing).
- [ ] Implement: base64url codec; `assertValidHubUrl` (require `ws://host`/`wss://host`; reject
  `169.254.`/`fe80:`/`metadata.google.internal`); 8 KB cap.
- [ ] Run the test → PASS. Commit.

### Task 2: Strict-loopback enroll-exemption helper — TDD

**Files:** Create `core/src/auth/enroll-exempt.ts`; Test `core/src/__tests__/enroll-exempt.test.ts`.
**Produces:** `isEnrollExempt(method, path, remoteAddress, origin)` — true only for `POST /hub/login`
from strict loopback **with no `Origin`**. (Minting `/hub/enroll/create` is NOT exempt.)

- [ ] Write the failing test (exempt `/hub/login` from loopback no-Origin; NOT exempt from LAN IP, with
  Origin, other paths, GET, or `/hub/enroll/create`).
- [ ] Run → FAIL. Implement the pure helper. Run → PASS. Commit.

### Task 3: Wire the exemption into the rest-server auth gate

**Files:** Modify `core/src/rest-server.ts` (import + the api-token gate block).
**Consumes:** `isEnrollExempt`.

- [ ] Import `isEnrollExempt`; compute `enrollExempt = isEnrollExempt(req.method, authPath,
  req.socket.remoteAddress, req.headers['origin'])`; add `&& !enrollExempt` to the gate condition.
- [ ] Build; run an alt-port worker (`LM_ASSIST_DATA_DIR=… API_PORT=… node core/dist/cli.js serve`);
  verify loopback no-Origin passes the gate, LAN IP / Origin / other paths → 401. Commit.

### Task 4: `POST /hub/enroll/create` route

**Files:** Modify `core/src/routes/core/hub.routes.ts`.
**Consumes:** `encodeKeypack`, `getHubConfig`, `getHubClient`, `isHubConfigured`.

- [ ] Append a route: require `status.authenticated`; `hubHttp = hubUrl.replace(/^ws:/,'http:')...`;
  `fetch(hubHttp+'/api/enroll/create', { method:'POST', redirect:'manual', headers:{Authorization:
  Bearer apiKey}, body:{ ttlMinutes?, fromGatewayId: status.gatewayId } })`; build
  `code = encodeKeypack({ v:1, hubUrl, token })`; return `{ code, expiresAt }`.
- [ ] Build; commit. (Token-gated — the CLI sends the api-token; verified live in Task 9/e2e.)

### Task 5: `POST /hub/login` route

**Files:** Modify `core/src/routes/core/hub.routes.ts`.
**Consumes:** `decodeKeypack`, `saveHubConnectionConfig`, `clearGatewayId`, `resetHubClient`, `getHubClient`.

- [ ] Append a route: `decodeKeypack(code)`; `fetch(hubHttp+'/api/enroll/redeem', { method:'POST',
  redirect:'manual', body:{ token, machineId } })`; on `410` surface the `reason`; on success
  `saveHubConnectionConfig({ apiKey, hubUrl })` → `clearGatewayId()` → `resetHubClient()` →
  `connect()` → wait → return `{ authenticated, connected, gatewayId, user }`.
- [ ] Build; alt-port worker → loopback no-token `/hub/login {}` returns "code required" (gate passed);
  bad keypack → "bad prefix". Commit.

### Task 6: `POST /hub/logout` route

**Files:** Modify `core/src/routes/core/hub.routes.ts`.

- [ ] Append a route: `saveHubConnectionConfig({ apiKey:'' })` → `clearGatewayId()` → `resetHubClient()`;
  return disconnected. Build; verify (token-gated). Commit.

### Task 7: `lm-assist login` / `logout` CLI

**Files:** Modify `bin/lm-assist.js` (`validCommands`, help, standalone command blocks).

- [ ] Add `login`/`logout` to `validCommands` + help. `login` (bare → interactive; `<keypack>` →
  redeem via `POST /hub/login`; `--new-node` → mint via `POST /hub/enroll/create`, print keypack +
  the run-on-new-node line; `--ttl`, validate positive integer). `logout` → `POST /hub/logout` or
  clear config when services are down. Use the existing loopback auth header; coerce error envelopes.
- [ ] Verify dispatch (`node bin/lm-assist.js login` → Usage; `help` shows both). Commit.

### Task 8: End-to-end

- [ ] Apply the hub contract on a test hub; generate a keypack on an authed node; redeem on a FRESH
  node (alt port, empty data dir) via tokenless-loopback `/hub/login`; confirm it persists the key,
  connects (`authenticated:true`, `gw4-…`), the token is single-use (re-redeem → 410), and the now-authed
  node can itself mint via `/hub/enroll/create`.

## Security hardening (review pass)

After implementation, two adversarial reviews + an automated push-review drove these worker-side fixes
(all unit/integration verified):

- **Minting token-gated** — only `/hub/login` (redeem) is loopback-tokenless; `/hub/enroll/create` requires
  the api-token (the CLI sends it). Closes "any local process can mint a keypack".
- **SSRF** — `decodeKeypack` requires `ws`/`wss` host, rejects link-local/metadata, caps size; enroll
  fetches use `redirect:'manual'`. Closes hostile-keypack SSRF/hijack via non-ws or metadata targets.
- **CSRF** — the loopback exemption also requires no browser `Origin`, blocking a page the user visits
  from POSTing to `127.0.0.1`.

## Deployment (worker)

Worker changes are pure JS in `core/` + `bin/` (no web/native-dep changes), so deploy by building
`core/dist` (`cd core && npm run build`) and syncing `core/dist` + `bin/lm-assist.js` + `package.json`
to each fleet host's install, then restarting Core. (Host-specific deploy mechanics are recorded in the
operator's private notes, not here.)

## Self-Review

Spec coverage: keypack §4.1→Task 1; exemption §4.3→Tasks 2–3; routes §4.2→Tasks 4–6; CLI §4.4→Task 7;
security §5→hardening pass; testing §7→Tasks 1,2,8. Type consistency: `Keypack`/`encodeKeypack`/
`decodeKeypack` and `isEnrollExempt(method,path,addr,origin)` used consistently across tasks.
