# HTTPS terminator + WSS voice transport (`LM_HTTPS=1`)

Opt-in secure origin that makes **browser voice dictation work off-localhost**. Off by
default; plain-HTTP serving is untouched whether it's on or off.

## Why it exists

The mic UI is gated `{voiceWsUrl && voice.supported}` and both legs fail on
`http://<LAN-IP>`:

- `voice.supported` needs `getUserMedia` + `AudioWorklet`, which browsers expose only in a
  **secure context** (https or localhost).
- From an https page, `ws://` and `http://` subresources are **mixed content** (blocked), so
  the STT socket must be `wss://` and the Core API calls must be same-origin.
- Self-signed cert acceptance is **per host:port origin** — putting the page, the API and
  the WS on one https origin means one accept per device.

## What runs

When `LM_HTTPS=1`, the Core process adds ONE `https.Server` (the *terminator*) on
`webPort+1` — dev `:3949`, prod `:3849`, `LM_HTTPS_PORT` overrides:

| Path on the https origin | Handled by |
|---|---|
| `/_coreapi[/*]` | prefix stripped → Core's request handler **in-process** (REST + SSE; the client socket stays the real remote, so loopback-only route guards keep denying LAN callers) |
| `/voice/stt/ws` | Core's upgrade router → voice STT relay (`?token=` ring-token auth, unchanged) |
| `/ttyd-proxy/*`, `/ttyd/*` | Core's terminal proxy (request + upgrade) |
| everything else | proxied to the local Next web server (`ws:true`, so dev HMR passes) |

Client side, `detectAppMode()` returns `{ mode:'local', baseUrl:'/_coreapi' }` on any
non-hub https page, so every fetch/SSE goes same-origin. `buildVoiceWsUrl()`
(`web/src/lib/voice-url.ts`) emits `wss://<page-host>/voice/stt/ws?token=…` there.

## Enabling

```bash
# dev (repo)
./core.sh start --https            # or restart --https; or LM_HTTPS=1 ./core.sh start
# prod (npm CLI)
LM_HTTPS=1 lm-assist start         # or put LM_HTTPS=1 in the repo-root .env (persistent)
# direct serve
lm-assist serve --https
```

`WEB_PORT` is forwarded to the Core process automatically (core.sh and service-manager)
so worktree/custom web ports proxy correctly. TLS init failure never takes down plain HTTP.

## Certificate

Self-signed, auto-generated + cached (regenerated when missing/corrupt, key mismatch,
expiring < 14 days, or the host's IPv4s/hostname drift out of the SANs):

- prod: `~/.lm-assist/tls/` · dev: `~/.lm-assist/tls-dev/` (`key.pem` 0600, `cert.pem`,
  `meta.json`; dir 0700)
- SANs: `localhost`, `127.0.0.1`, `::1`, the machine hostname, and all current LAN IPv4s
- CN `lm-assist`, RSA-2048, SHA-256, 397-day validity
- Generator: `selfsigned` **pinned to major 2** (CJS + node-forge). The v5 line pulls
  ESM-leaning deps — same `require()`-of-ESM hazard class as chokidar 4/5. Do not bump.

**One-time per device+browser:** the first visit to `https://<host-IP>:<port>` shows the
self-signed warning — Advanced → Proceed (Chrome/Edge) or Show Details → visit (Safari).
That single accept covers the page, all API calls and the voice WS (same origin). The
warning-free alternative is importing `cert.pem` into the device's trust store — because
the cert carries correct IP SANs it verifies cleanly then (`curl --cacert cert.pem
https://<LAN-IP>:3949/` passes full verification).

## The voice URL contract (for the mic UIs / epic children)

```ts
import { buildVoiceWsUrl } from '@/lib/voice-url';
const voiceWsUrl = useMemo(() => buildVoiceWsUrl({ isRemoteNode }), [isRemoteNode]);
// gate the mic UI: {voiceWsUrl && voice.supported}  — keep BOTH legs
```

| Page | Result |
|---|---|
| https + local mode (terminator) | `wss://<page-host>/voice/stt/ws?token=…` |
| http + localhost | `ws://127.0.0.1:<corePort>/voice/stt/ws?token=…` (unchanged) |
| http + LAN IP | `null` (insecure context — mic can't exist; hidden cleanly) |
| hub origin / remote-proxied node | `null` (see TODO) |

The decision logic is duplicated in `core/src/voice/voice-url.ts` (node --test coverage)
and `web/src/lib/voice-url.ts` (what the UI imports); a core test
(`voice-url.test.ts`) fails if the marker-delimited blocks diverge — edit both together.

## Scope / TODO

- **Remote/hub voice (TODO v1):** the hub `_coreapi` relay can't carry a WS upgrade, so on
  proxied nodes `buildVoiceWsUrl` returns null and the mic stays hidden (no error spam).
  Lighting it up needs a WSS relay over the hub worker socket (or portfwd-direct) — epic
  follow-up; the UIs need no change then, only the helper.
- Terminal iframes still build absolute `http://host:port` console URLs, so they don't
  render on the https origin yet; the terminator already routes `/ttyd*` for a future
  same-origin URL fix.
- No HSTS, no http→https redirect, by design — additive opt-in only.

## Verifying

Pin the generated cert as the CA (full TLS verification — never disable it):

```bash
CA=~/.lm-assist/tls-dev/cert.pem            # prod: ~/.lm-assist/tls/cert.pem
curl --cacert "$CA" https://<LAN-IP>:3949/                    # 307 → /sessions
curl --cacert "$CA" https://127.0.0.1:3949/_coreapi/health    # core health JSON
node -e "const{WebSocket}=require('ws');const f=require('fs');const h=process.env.HOME;const t=f.readFileSync(h+'/.lm-assist/api-token','utf8').trim();const ca=f.readFileSync(h+'/.lm-assist/tls-dev/cert.pem');const w=new WebSocket('wss://127.0.0.1:3949/voice/stt/ws?token='+t,{ca});w.on('message',m=>{console.log(String(m));w.terminate()})"
# → {"type":"ready"}   (sent only after the upstream Anthropic STT session opened)
```

Core tests: `node scripts/run-tests.js tls-cert-manager tls-https-terminator voice-url`.
