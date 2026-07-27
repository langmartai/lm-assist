# Voice — browser mic → claude.ai, HTTPS transport, Chrome lifecycle

> Read before touching anything under `core/src/voice/`, `web/src/hooks/useClaudeVoice.ts`, or the `LM_HTTPS` terminator.
>
> Split out of the repo [CLAUDE.md](../CLAUDE.md) so it is read on demand instead of loaded into every session. Content is unchanged.

### Opt-in HTTPS terminator (voice / secure context) — `LM_HTTPS=1`

The browser mic needs a **secure context** (getUserMedia only exists on https/localhost) and an https page can't open `ws://`/`http://` (mixed content). `LM_HTTPS=1` (or `./core.sh start --https` / `lm-assist serve --https`; persist via `.env`) makes Core add ONE `https.Server` on **WEB_PORT+1** (dev `:3949` / prod `:3849`, `LM_HTTPS_PORT` overrides): `/_coreapi/*` → Core in-process (REST+SSE), `/voice/stt/ws` + `/ttyd*` → Core upgrade router, everything else → proxied to Next. Client: `detectAppMode()` returns `baseUrl:'/_coreapi'` on non-hub https pages; `web/src/lib/voice-url.ts` `buildVoiceWsUrl()` is THE voice URL contract (wss same-origin on https, ws://127.0.0.1 on localhost, null when the mic can't work — remote/hub v1 TODO). Self-signed cert auto-managed in `~/.lm-assist/tls[-dev]/` (key 0600; SANs = localhost+hostname+LAN IPv4s; regen on expiry/IP drift); one cert-accept per device+browser. Additive: plain HTTP untouched; TLS failure never kills HTTP. The decision logic is duplicated core↔web with a byte-identity test (`voice-url.test.ts`) — edit both. **Dep pin: `selfsigned` stays `^2.4.1`** (CJS; v5 pulls ESM-leaning deps — chokidar-class `ERR_REQUIRE_ESM` hazard). Full guide: [`docs/voice-https-transport.md`](./voice-https-transport.md).

### Bidirectional voice v2 — startup latency + Chrome lifecycle

Voice bridges the browser mic to claude.ai's own voice WS through ONE headless Chrome
(`core/src/voice/claude-chrome.ts`). Two independent mechanisms keep it fast; they solve
different halves and **both** are needed:

- **Condition-based readiness** — `waitForClaudeReady` polls the REAL signals (same-origin
  `GET /api/account` → 200 **and** `cf_clearance` in the jar) instead of the two hardcoded 10s
  sleeps that used to cost ~20s *per session*. `VOICE_CHROME_SETTLE_MS` is now a **CAP, not a
  floor**. On cap it PROCEEDS (a 200 without cf_clearance just means CF never challenged this
  browser) — the asset's reconnect-once still covers a transient reject.
- **Persistent primed page + CF keepalive** — ONE long-lived navigated claude.ai page holds a
  warm `cf_clearance`/`__cf_bm` in the browser-scoped jar, so the *next* session doesn't redo
  the challenge. It is NOT the voice page (that still needs its own binding + navigation).
  Cheap-validated before reuse, re-primed on any failure, recycled by age, single-flight.

🔴 **The keepalive must be a REAL same-origin `GET /api/account`** (`probeAccount`) — a no-op
`setInterval` JS ping does NOT refresh cookies; only a real request makes Cloudflare re-issue
`Set-Cookie`. This is also why the readiness poll and the keepalive share one function.

🔴 **Never regress the CF fix** (`0f33806`, lm-mobile `docs/claude-voice-implementation.md` §4):
the real-Chrome UA launch arg, and a `GET /api/account` immediately before the WS upgrade. A
headless UA draws CF's bot challenge → `up_error`. Cookie **NAMES** only in logs, never values.

🔴 **`teardownIfIdle()` had NO caller** before this pass — Chrome lived until Core restarted.
It is now driven by an internal unref'd sweeper, and gated on a **live-channel count**:
`lastOpenAt` is stamped when a channel OPENS, so a long call looks idle by timestamp alone and
a naive sweep would kill it mid-conversation.

Client (`web/src/hooks/useClaudeVoice.ts`): the mic opens at **click**, not on `{ready}` — the
socket and the audio engine come up concurrently instead of stacking. Frames captured before
the relay is ready go to a bounded ~5s ring (`web/src/lib/claude-voice-uplink.ts`) and flush on
`{ready}`. The engine's `ac.resume()` **stays non-blocking** (`await` there is the original
`up=0` hang).

| env | default | meaning |
|---|---|---|
| `VOICE_CHROME_SETTLE_MS` | `10000` | **cap** on the readiness poll |
| `VOICE_CHROME_READY_POLL_MS` | `250` | poll interval |
| `VOICE_PRIMED_PAGE` | `1` | `0` disables the persistent primed page |
| `VOICE_PRIMED_MAX_AGE_MS` | `1800000` | recycle the primed page |
| `VOICE_CF_KEEPALIVE_MS` | `480000` | CF keepalive (below `__cf_bm` lifetime); `0` = off |
| `VOICE_CHROME_IDLE_MS` | `300000` | idle teardown window |
| `VOICE_CHROME_IDLE_SWEEP_MS` | `60000` | idle sweeper tick |

**Selectable voice (who speaks back).** The voice is a WS query param **fixed at connect**, so
it applies on the NEXT start, never the live call. Catalogue = claude.ai's own five —
`buttery` (default), `airy`, `mellow`, `glassy`, `rounded` — read out of its shipped bundle,
NOT from an API (there is none; every plausible route 404s). Ids are a **closed set**: an
unknown value makes claude.ai reject the WS upgrade (`up_error`, no audio), so
`normalizeVoice()` whitelists before it reaches the wire. Kept in two places on purpose —
`core/src/voice/claude-voice-url.ts` (`CLAUDE_VOICES`, validation) and
`web/src/components/voice/VoiceSelector.tsx` (`VOICES`, labels + localStorage) — **edit both**.
Path: selector → overlay → `useClaudeVoice` → connect frame `voice` → `ConnectMsg` →
`buildClaudeVoiceUrl`. Catalogue, the rolldown asset-graph crawl that recovers it (claude.ai is
no longer Next.js — no `_buildManifest`), and the unwired extras (`tts_speed` tiers, activation
mode): [`docs/claude-ai-voice-protocol.md`](./claude-ai-voice-protocol.md).

**A voice session must PROVE it owns the conversation before any audio flows.**

Investigating a report that a live voice transcript surfaced in an unrelated claude.ai
conversation (2026-07-25) produced one finding that outranks the report itself:

🔴 **claude.ai ACCEPTS any well-formed conversation uuid, existing or not.** Measured live:
a nonexistent uuid returns `up_open` + `session_server_initialized` + live interim
transcripts, then **silently discards every turn** (`message_complete` never fires, nothing
persists). Only a *malformed* id (`conv-e2e`, empty) or a bad org is rejected (1006). So
`{ready}` says nothing about WHERE speech lands — a session can be open and recording
against a conversation that isn't the caller's, looking perfectly healthy the whole time.

The guard is a same-origin `GET /api/organizations/{org}/chat_conversations/{conv}` run
**inside the voice page**, so what is verified is the exact origin, jar and identity the WS
upgrade will use (existing→200, nonexistent→404, wrong org→404). It parses `{org, conv}`
back out of the URL it is about to dial (`parseClaudeVoiceUrl`), so the pair checked and the
pair used cannot drift. It fails **closed on 404/403** and **open on inconclusive** (0/5xx) —
a transport blip is not evidence of a wrong conversation. It runs *before* the final
`GET /api/account`, so the CF ordering invariant above is untouched.

🔴 **`getBrowser()` needs its own single-flight** — `ensureLoaded`'s `primingPromise`
single-flights the PRIMING, one layer above the launch. Two concurrent cold starts both saw
`browser === null`, both launched Chrome; the second assignment orphaned the first AND
divorced the primed cookie-warm page from the browser serving voice pages → `403`, `jar=14`,
both sessions dead at `up=0`. Measured before/after: 2 launches→1, `up=0`→`up=2245`.

🔴 **A synthetic voice repro did NOT reproduce this leak — even with the fix reverted.** Real
fake-mic sessions (sequential, concurrent, and two sessions sharing ONE long-lived browser),
each speaking a unique marker word, plus an account-wide sweep: every transcript landed only
in its own conversation, in all three shapes, both with and without the `/chat/<conv>`
pinning. So that harness is **not a detector for this failure mode** and a green run from it
is not evidence the leak is gone — the real trigger lives in state it doesn't recreate
(freshly-created empty conversations, no concurrent traffic on the account, a browser whose
SPA has never rendered a conversation). The load-bearing evidence for the pinning fix is the
prod before/after in `ea489ff`, not a synthetic run. If you touch this path, verify the way
that commit did — on prod, counting messages per conversation across real sessions.

Attribution was the other gap: not one log line named the conversation a session bound to,
which is why the incident was discoverable only by a human reading a chat. Both sides of the
bridge now log `conv=` (an id, never content). Regression suite: the pinning, cross-talk,
refusal and single-flight tests in `voice-conversation-pinning.test.ts` /
`claude-voice-relay.test.ts` / `claude-chrome.test.ts` — each **mutation-verified** (bug
reintroduced ⇒ test fails).

**Verify voice with `up>0`, never `{ready}` alone.** `{ready}` proves the transport; prod once
ran `page_status up_open -> ready` with `up=0` (no audio at all). `core/src/__tests__/voice-audio-flow.test.ts`
is the regression test — real Chrome + fake mic + the real engine asset through the real relay,
asserting frames arrive; it self-skips where no Chrome resolves. Design:
[`docs/superpowers/specs/2026-07-25-voice-v2-latency-hardening-design.md`](./superpowers/specs/2026-07-25-voice-v2-latency-hardening-design.md).
