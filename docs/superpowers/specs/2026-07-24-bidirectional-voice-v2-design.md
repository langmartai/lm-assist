# lm-assist bidirectional voice v2 — model + connectors (design)

**Program:** `bidirectional-voice-v2` (lm-assist arm) · **Mission:** `mission_049f9920` · **Date:** 2026‑07‑24
**Prereq (done):** research `mission_3aa00fc5` → protocol spec `/home/yi/lm-assist/docs/claude-ai-voice-protocol.md` (on node 123) + fleet memory `bidirectional-voice-v2-protocol.md`.

## 1. Goal & scope

Add a **full bidirectional voice conversation mode** (audio in + out, real‑time) to lm‑assist that relays **claude.ai's own v2 voice product** — bringing the user's real **model selection** and **connector/MCP** support — living **alongside** the existing STT dictation (which is untouched), on the **/cowork** surface.

**In scope (all‑in, this mission):** duplex audio; a visible **model/effort/thinking control**; the **connector/MCP agentic loop** with the in‑band **approval handshake**; idle/reconnect handling.
**Out of scope (v1):** remote/hub access (local + cookie‑gated, like today's voice); replacing dictation; non‑claude.ai (own‑backend) voice.

## 2. Background — the protocol (summary; full spec on 123)

claude.ai's in‑browser v2 voice is the **same WS transport** as the OLD one lm‑mobile cracked, plus two additions:

- **Endpoint:** `wss://claude.ai/api/ws/voice/organizations/{org}/chat_conversations/{conv}?…` — bound to an existing chat conversation. Cookie auth + `Origin: https://claude.ai`; **Cloudflare‑gated on the upgrade**. `permessage-deflate`.
- **Audio:** uplink raw **Opus** (~20 ms); downlink **320‑byte PCM** (16‑bit LE mono @ 16 kHz, 10 ms).
- **NEW #1 — model selection:** query params `model`, `effort`, `thinking_mode` (+ `dev_overrides`, `project_uuid`, `client_aec`, `client_platform`); default voice `airy`→`buttery`. The model runs in‑socket; `message_sse` re‑muxes the `/completion` SSE (`message_start.model` = authoritative per‑turn model).
- **NEW #2 — agentic tool + connector/MCP loop:** tools surface as `message_sse` `content_block_start type:"tool_use"` carrying connector metadata (`integration_name`, `integration_icon_url`, `is_mcp_app`, `mcp_server_url`, `approval_key`, `approval_options`); client returns `tool_result` + `turn_end`; connector output renders as `connector_text`; **in‑band approval handshake** `{tool_use_id, is_approved, approval_key, approval_option ∈ once|perChat|always}`; connector auth via `mcp_auth_required` / `mcp_elicitation`. Client `tools_register` stays an empty no‑op.
- New client frames: `client_metrics`, `client_abort_reason`. Removed: `dev_text` injection.
- **Residual protocol gap:** no live capture of a *populated* connector invocation (schema + client handling fully recovered). Closed during implementation (§10).

## 3. The Cloudflare constraint & the proven architecture

**Finding (spike, 2026‑07‑24, node 117):** `cf_clearance` is bound to the **TLS/JA fingerprint** of the client that solved the challenge. A Node `ws` client — even with a *fresh, same‑egress‑IP, headless‑Chrome‑minted* `cf_clearance` — gets `403 cf-mitigated: challenge`. Opening the identical WS **from inside the Puppeteer Chrome page** returned `opened=true` + `session_server_initialized` + `message_sse`. (lm‑mobile's older "Node passes" note is stale; CF rotates fingerprint buckets.)

⇒ **The voice WS MUST be carried by real Chrome.** Architecture = **Core‑hosted headless‑Chrome frame‑relay** (lm‑mobile's proven default "WebView‑relay" backend, ported to Puppeteer). Real Chrome holds the claude.ai WS (passes CF with the browser's own fingerprint + auto‑attached cookies); **all audio stays in the user's browser**; Core bridges frames.

```
User browser (/cowork)              Core (117, Node)                       claude.ai
┌────────────────────┐  same-origin ┌──────────────────────────────┐     ┌────────────┐
│ useClaudeVoice     │  wss         │ /voice/claude/ws  (user bridge)│     │ voice WS   │
│  mic → Opus  ──────┼─── binary ──▶│        ▲ frames ▼             │     │ (Opus in / │
│  PCM ← playback ◀──┼─── PCM ──────┤  claude-voice-relay.ts        │     │  PCM out + │
│  transcript/tools  │  JSON ctrl   │        ▲ frames ▼             │     │  message_  │
│  approval UI       │◀────────────▶│  claude-chrome.ts (Puppeteer) │     │  sse)      │
│  ModelEffort ctrl  │              │   page: claude-ws-relay.js ───┼─ws─▶│            │
└────────────────────┘              │   page↔Core: loopback wss     │◀────┤            │
                                    └──────────────────────────────┘     └────────────┘
```

**Page↔Core bridge (fast path):** the relay Chrome is launched with `--ignore-certificate-errors`, so the injected page script (on the `https://claude.ai` origin) opens a **loopback `wss://127.0.0.1:<LM_HTTPS_PORT>/voice/claude/page-bridge?token=…`** to Core — full‑speed binary frames, not mixed content (wss is secure), cert trusted via the flag (our controlled Chrome only). Fallback if that proves unreliable: Puppeteer CDP bindings (`exposeFunction` page→Core + `evaluate` Core→page, base64), which lm‑mobile's analogous WebView bridge proves adequate at ~50 fps each way.

## 4. Components

### Core (`core/src/voice/`)
- **`claude-chrome.ts`** — Puppeteer lifecycle: launch/reuse one headless `google-chrome` (system binary; `--no-sandbox --ignore-certificate-errors`), load the node's claude.ai cookie into the context, `ensureLoaded()` (navigate to claude.ai so CF mints/refreshes state), one page per active voice session, health/relaunch, idle teardown. Reads the cookie via the existing `claudeai-session` path (Core‑side; never to the browser).
- **`claude-voice-relay.ts`** — the two bridges (sibling of `voice-relay.ts`): (a) the **user bridge** `/voice/claude/ws` (browser ↔ Core), token‑auth (`isValidToken`/`apiAuthEnabled` like the STT relay); (b) the **page bridge** `/voice/claude/page-bridge` (Chrome page ↔ Core, loopback‑guarded + token). Builds the voice URL **with v2 params** from the client's `connect` message. Pipes Opus/PCM/JSON both ways; per‑session structural logging (frame/byte/type counts; PII‑safe, transcript text behind `LM_VOICE_DEBUG`).
- **`assets/claude-ws-relay.js`** — thin injected page script: opens the claude.ai voice WS + the loopback page‑bridge wss, pipes frames, silent‑Opus / `keep_alive` keepalive, classifies server close (`4008` = idle timeout). Ported from lm‑mobile `claude-ws-relay.js`.
- **`rest-server.ts`** — register `isClaudeVoiceUpgrade` / `handleClaudeVoiceUpgrade` (+ the page‑bridge upgrade) next to the STT branch.
- **Config/flags:** `autoVoiceV2Enabled` (or `LM_VOICE_V2`) gate; capability probe = `LM_HTTPS` on + claude.ai cookie present + system Chrome resolvable. Missing any ⇒ report unavailable (mic hidden), never crash.

### Web (`web/`)
- **`public/voice/claude-voice-engine.js`** — browser audio engine: `getUserMedia({echoCancellation,noiseSuppression,autoGainControl,channelCount:1,sampleRate:48000})` → resample 48→16k → WebCodecs `AudioEncoder({codec:'opus',sampleRate:16000,bitrate:24000,opus:{application:'voip',frameDuration:20000}})` → Core; 320‑byte PCM → `AudioContext` queued playback (destination = AEC reference). Ported from lm‑mobile `voice-engine.js`.
- **`hooks/useClaudeVoice.ts`** — state machine (`idle|connecting|listening|thinking|speaking|reconnect|error`); demux `message_sse` (transcript_interim, message_start/model, text deltas, `tool_use`, `connector_text`, message_complete); the **approval handshake**; keepalive; `4008` reconnect (resume same conversation); interrupt (`server_interrupt`). Contract sibling of the STT hook.
- **`components/voice/`** + cowork **`ChatView.tsx`** — a **voice‑mode toggle** + overlay: live transcript, speaking/thinking indicator, interrupt/exit, and **connector/tool cards + the approval prompt** (once/perChat/always). Sits alongside the existing dictation `MicButton`.
- **Model control — reuse `ModelEffortSelector`** (§6).
- **`lib/voice-url.ts`** — add `buildClaudeVoiceWsUrl()` (same rules as `buildVoiceWsUrl`, path `/voice/claude/ws`); keep the core↔web byte‑identity test.

## 5. Data flow

1. **Enter voice mode** on /cowork → hook resolves `buildClaudeVoiceWsUrl()` (null ⇒ hide). Opens the user bridge WS with a `connect` message `{conversationUuid, model, effort, thinkingMode, voice:'buttery'}`.
2. **Core** ensures Chrome loaded → new page → injects `claude-ws-relay.js` → page opens the claude.ai voice WS (v2 params) + the loopback page‑bridge. On `session_server_initialized`, Core sends `{type:'ready'}` to the browser.
3. **Audio loop:** browser Opus frames → user bridge → Core → page bridge → page → claude.ai; claude.ai 320‑byte PCM → reverse → `AudioContext` playback. `transcript_interim` + `tts_word` update the overlay.
4. **Model:** carried on connect (query params); `message_start.model` echoed to the overlay as the live per‑turn model.
5. **Tool/connector loop:** `tool_use` block → overlay renders a tool/connector card (name + `integration_name`/`mcp_server_url` when present). If `approval_key`/`approval_options` present → **approval prompt**; user choice → client sends `{is_approved, approval_key, approval_option}`. `connector_text` streams into the transcript (and is spoken by the server). Client‑executed builtins: `ask_user_question` surfaces in the overlay; **unsupported** client‑tools return an error `tool_result` so the model recovers (bounded scope — connectors are server‑executed and need only approval + render).
6. **Idle/close:** `4008` (or a preceding `{type:'error'}`) → `reconnect` state → re‑enter same conversation on user action. Chrome crash → relaunch + surface error.

## 6. Model‑selection control (the requested UI)

Reuse **`web/src/components/cowork/ModelEffortSelector.tsx`** — the existing claude.ai‑captured inline **"Sonnet 5 · Medium ▾"** popover (models: Opus 4.8 / Sonnet 5 / Fable 5 / Haiku 4.5; efforts low/medium/high/max). It already drives `ChatView`/`CoworkComposer`. For voice:
- Place it in the voice overlay header (and/or keep ChatView's existing instance as the source of truth), controlling the **voice conversation's** `model` + `effort`.
- **Extend** it (optional third control) to also set **`thinking_mode`** (the protocol's third param) — a small toggle/section in the same popover, `hideThinking` defaulting to preserve current chat/cowork call‑sites.
- Selected `{model, effort, thinkingMode}` → the `connect` message → relay query params. Changing the model mid‑session reconnects the socket (params are set at upgrade) — surfaced as a brief "switching model…" state.

This gives the voice mode a **visible model control identical to what we have and to claude.ai's captured voice control**, satisfying the requirement.

## 7. Connector / MCP design

- **Execution model:** MCP connectors run **server‑side** (claude.ai holds the MCP connection). The lm‑assist client's responsibilities are **approval + render** — it does not execute connector calls.
- **Approval UI:** when a `tool_use` carries `approval_options`, show a compact prompt (tool/connector name + `integration_name`) with **Once / For this chat / Always** → send the matching `{is_approved:true, approval_key, approval_option}`; a Deny sends `{is_approved:false, approval_key}`. `perChat` persists for the session; `always` is the user's global grant (claude.ai‑side).
- **Auth:** `mcp_auth_required` / `mcp_elicitation` → surface a "connector needs authorization" notice (deep‑link/handled on claude.ai; v1 just informs).
- **Rendering:** `tool_use` → tool card; `connector_text` → styled transcript block; both spoken by the server TTS.

## 8. Transport / security / scope / degradation

- **v1 = local + cookie‑gated.** Works when browsing lm‑assist web **on the Core host** (localhost, or `LM_HTTPS` LAN) that holds the claude.ai cookie (117). `buildClaudeVoiceWsUrl()` returns null for remote/hub/insecure → mic hidden. Remote/hub voice = future (same limit as today's dictation; the hub `_coreapi` relay can't WS‑upgrade).
- **Secrets:** Core holds the claude.ai cookie; the browser never sees it. The user↔Core WS carries the rotating api token in the query string (browsers can't set WS headers), exactly like the STT relay. `--ignore-certificate-errors` applies **only** to the Core‑spawned relay Chrome, never the user's browser.
- **Degrades cleanly:** any missing precondition ⇒ "voice‑v2 unavailable" (feature hidden), plain HTTP + dictation untouched.

## 9. Error handling & Chrome lifecycle

- CF re‑challenge / stale state → `ensureLoaded()` re‑navigate to refresh; auth‑monitor already keeps the 117 cookie live.
- Idle `4008` → reconnect UI (resume same conversation). Keepalive prevents transport drop but not the ~10‑min inactivity close (documented).
- One reused Chrome; lazy‑start on first connect; health‑checked; relaunch on crash; idle teardown after N minutes with no session. Bounded memory; structural per‑session logging (never speech text unless `LM_VOICE_DEBUG`).

## 10. Testing

- **Unit:** injectable fake page/WS (mirrors `voice-relay.test.ts`) for both bridges + the `message_sse`/tool/approval demux; `buildClaudeVoiceWsUrl` cases + the core↔web byte‑identity test.
- **E2e (headless Chrome, real WS — like the spike):** assert `session_server_initialized`; a **model‑param** turn (verify `message_start.model` matches the selected model); and — **closing the residual gap** — enable a connector on the test conversation (the spike conversation already has `enabled_mcp_tools`), invoke it, and capture the populated `tool_use` (`integration_name`/`mcp_server_url`) + the approval round‑trip. Test at the user's real mic rate (96 kHz repro, per [[voice-capture-bugs]]).
- **Build:** `next build` + core `tsc` clean; tests live in `core/src/__tests__/` (flat — the runner skips `core/src/<mod>/__tests__/`).

## 11. Risks

- **Persistent Chrome is a heavier Core dep** — mitigated by lazy‑start, health‑check, graceful‑off, idle teardown. `puppeteer-core` + system Chrome already present on 117; declare `puppeteer-core` as a core dep (dual‑pin convention) and treat Chrome as an optional runtime capability.
- **Page↔Core throughput** — validate the loopback‑wss bridge at voice frame rates early; CDP‑binding fallback documented.
- **Connector loop** — the one unverified case; closed live in §10 before merge.
- **CF cookie freshness** — auth‑monitor maintained; `ensureLoaded` re‑mints on demand.

## 12. Out of scope / future

Remote/hub voice transport; own‑backend (non‑claude.ai) voice; TTS voice picker UI; multi‑conversation voice; desktop_app `client_platform`.

---
**Deliverables:** this spec (committed) → implementation plan (`docs/superpowers/plans/2026-07-24-bidirectional-voice-v2.md`) → phased implementation with tests → verify on dev (:3200/:3948) → human merge gate.
