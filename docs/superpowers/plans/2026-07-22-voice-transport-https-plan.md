# Voice transport foundation: opt-in HTTPS terminator + same-origin WSS (mission_9f5e6ec7)

Branch `feat/voice-transport-https`. FOUNDATION for the voice-dictation epic (parent
mission_d2c4acb6); children A/B consume the URL contract delivered here.

## Problem (verified)

The cowork mic is gated `{voiceWsUrl && voice.supported}`. Off-localhost both legs fail:

1. `voice.supported` needs `navigator.mediaDevices.getUserMedia` + `AudioWorklet` — browsers
   expose them ONLY in a secure context (https or localhost). `http://<LAN-IP>:3948` → hidden.
2. `voiceWsUrl` is null when remote/proxied (the hub `_coreapi` relay cannot carry a WS upgrade).
3. Even with an https page, `ws://` is mixed content — the STT socket must be `wss://`, and
   direct `http://host:3200` API fetches from an https page are mixed content too (blocked).

So "just TLS the web port" is not enough: the page, the REST/SSE API calls, AND the voice WS
must all be secure **on one origin** (self-signed cert acceptance is per host:port — one origin
means one accept).

## Design: one Core-hosted HTTPS terminator port per env

A single `https.Server` inside the Core process (opt-in, additive — plain HTTP untouched):

```
https://<host>:3949 (dev) / :3849 (prod)   [default webPort+1, LM_HTTPS_PORT overrides]
  ├─ /_coreapi/*            → stripped + dispatched IN-PROCESS to Core's handleRequest
  │                            (REST + SSE, no localhost hop, no buffering)
  ├─ /voice/stt/ws          → Core's upgrade router (voice STT relay; ?token= auth as today)
  ├─ /ttyd-proxy/*, /ttyd/* → Core's upgrade router / handler (terminal WS, future-proof)
  └─ everything else        → proxied to the local Next web server (http-proxy, ws:true for HMR)
```

- Enable: `LM_HTTPS=1` env (also honored from `.env`), `./core.sh start --https`,
  `lm-assist start --https`. Off by default. Failure to init TLS never kills plain HTTP.
- Cert: self-signed, auto-generated + cached in `~/.lm-assist/tls` (prod) / `tls-dev` (dev),
  key 0600, SANs = localhost/127.0.0.1/::1/hostname/current LAN IPv4s, 397d validity,
  regenerated when missing/corrupt/expiring(<14d)/IP drift. Generator: `selfsigned@^2.4.1`
  (CJS + node-forge, webpack-dev-server lineage; v5 pulls ESM-leaning deps — same hazard
  class as chokidar 4/5, so pin major 2).
- Port detection: never hardcode — derived from runtime ports (`WEB_PORT`/`ASSIST_WEB_PORT`
  env, else `__dirname.includes('node_modules')` + `LM_ASSIST_PROD` pattern → 3848/3948).

### Client (web) changes

- `detectAppMode()`: on an `https:` page (non-hub-domain) → `{ mode:'local', baseUrl:'/_coreapi' }`
  — same-origin fetches/SSE (mixed-content-safe). Relative-base precedent already exists
  (cloud hybrid client uses `${basePath}/_coreapi`).
- New `web/src/lib/voice-url.ts` → `buildVoiceWsUrl({isRemoteNode})` — THE contract for
  children A/B. Decision matrix (pure fn, canonical copy tested in core):
  - remote/hub-proxied node → `null` (v1: relay can't WS; mic hidden cleanly — TODO below)
  - https page + local mode → `wss://<page-host>/voice/stt/ws?token=…` (same origin)
  - https page + hub mode → `null`
  - http page + localhost → `ws://127.0.0.1:<corePort>/voice/stt/ws?token=…` (today's path)
  - http page + LAN IP → `null` (insecure context; mic hidden — same visible outcome as today)
- `CoworkPage.tsx` consumes the helper; ChatView gate `{voiceWsUrl && voice.supported}` stays.

### Files

New: `core/src/tls/cert-manager.ts`, `core/src/tls/https-terminator.ts`,
`core/src/voice/voice-url.ts` (canonical shared logic, marker-delimited),
`web/src/lib/voice-url.ts` (identical shared block + browser adapter),
tests `core/src/tls/__tests__/{cert-manager,https-terminator}.test.ts`,
`core/src/voice/__tests__/voice-url.test.ts` (matrix + byte-identity sync check of the
shared block across the core/web copies), `docs/voice-https-transport.md`.

Modified: `core/src/rest-server.ts` (extract `routeUpgrade`, `maybeStartHttps`, stop()),
`core/src/cli.ts` (`--https`), `core/src/service-manager.ts` (forward `LM_HTTPS*`+`WEB_PORT`,
`start --https`), `core.sh` (`--https`, pass `WEB_PORT` to core, print https URL),
`core/package.json` (+`selfsigned@^2.4.1`), root lockfile, `web/src/lib/api-client.ts`,
`web/src/components/cowork/CoworkPage.tsx`, `.env.example`, `CLAUDE.md` (short section).

### Security notes

- No new auth surface: `/_coreapi` requests hit the same `x-api-key` gate in `handleRequest`;
  the voice WS keeps `?token=` ring-token auth; loopback-only routes still see the real client
  socket address (terminator dispatches in-process on the TLS socket) → LAN callers stay denied.
- TLS private key never leaves `~/.lm-assist/tls*/` (0600). No HSTS, no http→https redirect
  (additive opt-in — plain-HTTP behavior must stay byte-identical).

### Out of scope (v1, documented TODO for the epic)

- Remote/hub WSS relay for voice (`wss://` up the api-relay socket) — mic stays hidden on
  proxied nodes, no error spam. Children A/B consume the same helper so it lights up later.
- Mic UI on MC/CCR/Code/chart-chat (children A/B).
- Terminal iframes on the https origin (URLs are API-built absolute http; terminator already
  routes `/ttyd*` for a future same-origin URL fix).

## Verification

1. Targeted core tests: `node scripts/run-tests.js tls voice-url` (after `npm run build:test`).
2. `./core.sh build` clean; web `next build` clean.
3. Runtime (dev worktree, offset-free :3200/:3948, LM_HTTPS=1): curl -k https://127.0.0.1:3949/
   → 307 /sessions; `/_coreapi/health` → health JSON; SSE `/_coreapi/stream` streams; `ws`
   client to `wss://127.0.0.1:3949/voice/stt/ws?token=…` → `{type:'ready'}` (real STT upstream);
   same via LAN IP. Plain http :3200/:3948 unchanged with LM_HTTPS unset AND set.
4. Report exact second-device URL (https://<LAN-IP>:3949) + one-time cert-accept steps.
5. HUMAN REVIEW GATE: push branch, report need_approval — no merge.
