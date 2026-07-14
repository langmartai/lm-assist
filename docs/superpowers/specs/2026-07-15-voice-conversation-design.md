# Voice Conversation (Spec 5) — Design

**Status:** approved 2026-07-15. Sibling of the cowork/chat program (`docs/superpowers/specs/2026-07-14-cowork-chat-surface-design.md`).

## Goal

Add **push-to-talk voice conversation** to the lm-assist web **Chat** surface: hold a mic button, speak, release → the speech is transcribed and sent as a chat message → Claude's reply is spoken back aloud. A real spoken conversation, gated by the mic button (no hands-free / no barge-in in v1).

## Why this architecture (de-risked)

The reply and TTS already exist; only speech-in is new, and its hard part (the STT transport) is **already spiked and passing headless**. We use the **Anthropic `voice_stream` STT WebSocket** with the Claude Code **OAuth** token — which is **NOT Cloudflare-gated** (unlike claude.ai's own voice WS). This mirrors the working `lm-voice` app on 107; we port its proven pieces.

```
[hold 🎤] getUserMedia → AudioWorklet (→ linear16 16k mono PCM, 80ms frames)
   → browser WS → Core /voice/stt/ws  → STTClient → Anthropic voice_stream WS (OAuth, server-side)
   ← {type:TranscriptText}=interim / {type:TranscriptEndpoint}=final  → relayed to browser
[release] → finalize (CloseStream) → final transcript
   → useChatConversation.send(transcript)      ← the chat completion we already built
   ← reply text → SpeechSynthesis.speak(speechText(reply))   ← the read-aloud engine we already shipped
[idle → ready for next turn]
```

## Components & interfaces

### 1. Core: `core/src/voice/stt-client.ts` (port of lm-voice `stt-client.js`)
A Node `ws` client for the Anthropic STT WS. Ported almost verbatim (JS→TS). Interface:
```ts
class STTClient extends EventEmitter {
  constructor(opts: { token: string; baseUrl?: string; language?: string; keyterms?: string[]; userAgent?: string });
  connect(): Promise<void>;              // opens WS, sends initial KeepAlive, starts 8s keepalive
  sendAudio(buf: Buffer): void;          // push a linear16 PCM chunk (ignored after finalize)
  finalize(): Promise<string>;           // sends CloseStream, resolves when the final endpoint/timeout lands
  close(): void;                         // abort (1000)
  // events: 'open' | 'transcript'(text, isFinal) | 'error'(err) | 'close'(code, reason)
}
```
- URL (from the passing spike): `wss://api.anthropic.com/api/ws/speech_to_text/voice_stream?encoding=linear16&sample_rate=16000&channels=1&endpointing_ms=300&utterance_end_ms=1000&language=en&use_conversation_engine=true&stt_provider=deepgram-nova3`
- Headers: `Authorization: Bearer <oauth>`, `User-Agent: claude-cli/<ver> (external, cli)`, `anthropic-client-platform: claude_code_cli`, `x-app: cli`; `perMessageDeflate: true`.
- `baseUrl` overridable via env (`LM_VOICE_STREAM_BASE_URL`) so tests point at a **mock WS** (lm-voice's test method).

### 2. Core: `/voice/stt/ws` WebSocket relay (rest-server upgrade branch)
Add `isVoiceSttUpgrade(req)` / `handleVoiceSttUpgrade(req, socket, head)` alongside the existing ttyd/tcp/portfwd branches in `rest-server.ts`'s `server.on('upgrade', …)`. The handler:
- Authenticates the browser WS (api-token via `?token=` query or header — browsers can't set WS headers, so accept a query param validated against the same api-token).
- `getValidAccessToken()` + `detectClaudeCodeVersion()` → constructs an `STTClient`, `connect()`.
- Bridges: browser **binary** frames → `stt.sendAudio(buf)`; browser **text** `{"type":"finalize"}` → `await stt.finalize()`; `stt.on('transcript', (t, final) → browser.send(JSON {type:'transcript', text, final}))`; `stt.on('error'|'close')` → browser JSON + close.
- Uses the `ws` `WebSocketServer({ noServer:true })` to complete the browser handshake (the lib is already a dep).

### 3. Web: `web/public/voice/mic-worklet.js` (port of lm-voice worklet, verbatim)
Standard `AudioWorkletProcessor` (`registerProcessor('mic-downsampler', …)`) — linear-interpolation resample of mic input to 16 kHz mono Int16 LE, posts 80 ms (1280-sample) ArrayBuffer frames. Copied unchanged.

### 4. Web: `web/src/hooks/useVoiceConversation.ts`
Orchestrates one push-to-talk turn and exposes state to the UI:
```ts
type VoiceState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error';
useVoiceConversation(opts: {
  wsUrl: string;                          // resolves Core /voice/stt/ws (+ token)
  onFinalTranscript: (text: string) => Promise<void>;  // = useChatConversation.send
  speak: (text: string) => void;          // shared TTS
}): { state; interim: string; error: string|null; start(): void; stop(): void; supported: boolean };
```
- `start()` (mic press): `getUserMedia({audio:{channelCount:1}})` → AudioContext + worklet → open Core WS → stream frames; `state='listening'`, live `interim`.
- `stop()` (mic release): stop capture, send `{"type":"finalize"}`, await final transcript (`state='transcribing'`), then `onFinalTranscript` (`state='thinking'`), then `speak(reply)` (`state='speaking'`), then `idle`.
- Cleans up AudioContext/stream/WS on stop/unmount/error.

### 5. Web: shared TTS util `web/src/lib/speech.ts`
Extract `speechText(md)` + a `speak(text)`/`cancel()` helper from `TranscriptMessage.tsx` (read-aloud) so both the action row and voice reuse one implementation.

### 6. Web: voice UI in `ChatView`
Replace the disabled 🎤 in the chat composer with a live push-to-talk button (pointerdown=start / pointerup/leave=stop). A compact status line shows state + live interim transcript ("listening… ‹interim›" / "thinking…" / "speaking…"), and an error inline. Reply auto-speaks; the transcript is added as a normal user turn by the existing `send()`.

## Data flow (one turn)
hold → capture+relay+interim → release → finalize→final → `send(final)` → reply → `speak(reply)` → idle.

## Error handling
- Mic permission denied / no `getUserMedia` → `supported=false`, button disabled, inline hint.
- STT WS upgrade rejected / error / close → `state='error'` + message; user can retry or type.
- No OAuth token (Core) → relay closes with an error frame.
- `SpeechSynthesis` unavailable → skip speaking (reply text still shows).
- Empty final transcript → no send.

## Scope (v1 / YAGNI)
- **Chat surface only** (reply = chat completion). Cowork voice is a later add (same hook, `send` = cowork drive).
- **Push-to-talk** only — no hands-free auto-endpointing, **no barge-in** (those need the full-duplex claude.ai voice WS = the harder Cloudflare-gated path, deferred).
- **Browser `SpeechSynthesis`** TTS (Supertonic backend = v2).
- **English** (`language=en`).
- **117-gated** — the reply uses the claude.ai cookie like the rest of chat (STT itself is OAuth and node-agnostic, but the conversation completion is cookie-bound).

## Testing
- **Core `STTClient`**: unit test against a **mock WS** (`LM_VOICE_STREAM_BASE_URL`) — assert connect→KeepAlive→sendAudio→finalize→`transcript(final)` sequence, and error/close handling. Plus the real PCM→transcript e2e is the already-passing spike (`scratchpad/stt-spike.mjs`).
- **Relay route**: unit test the bridge (mock STTClient + a fake browser socket) — binary→sendAudio, finalize→CloseStream, transcript→browser JSON, auth rejection.
- **Web**: `speechText()` unit test (markdown stripping); the hook + UI verified live in-browser on 117 (mic → transcript → reply → spoken).

## Global constraints
- chokidar stays `^3.6.0`; ESM `import()` in Core stays `Function`-indirected (SDK/agent rule) — not touched here, `ws` is CJS.
- No new hardcoded ports; browser→Core WS URL derives from the same base as other client calls.
- Reuse existing components (`useChatConversation`, read-aloud TTS, rest-server WS upgrade) — do not fork them.
