# Voice Conversation (Spec 5) — Implementation Plan

> Spec: `docs/superpowers/specs/2026-07-15-voice-conversation-design.md`. Push-to-talk voice on the Chat surface. Much of this ports proven `lm-voice` code (`~/lm-voice/app`). Execute on `main` (session convention). Build → test → deploy 117 → live-verify.

## Global constraints
- STT WS URL/headers/protocol EXACTLY as the passing spike (`scratchpad/stt-spike.mjs`) + `lm-voice/app/src/lib/stt-client.js`. `baseUrl` overridable via `LM_VOICE_STREAM_BASE_URL` for tests.
- `ws` is CJS (fine for Core CJS build). Reuse existing pieces: `useChatConversation.send`, read-aloud TTS, rest-server `server.on('upgrade')` dispatch. No new hardcoded ports.
- Browser can't set WS headers → browser→Core WS auth via `?token=<api-token>` query param, validated server-side.

## Task 1 — Core `core/src/voice/stt-client.ts` (+ test)
Port `lm-voice/app/src/lib/stt-client.js` to TS verbatim (EventEmitter; `connect/sendAudio/finalize/close`; events `open|transcript(text,isFinal)|error|close`). URL builder with the spike's query params; headers `Authorization: Bearer`, `User-Agent: claude-cli/<ver> (external, cli)`, `anthropic-client-platform: claude_code_cli`, `x-app: cli`; `perMessageDeflate`. `baseUrl` from opts/`LM_VOICE_STREAM_BASE_URL`.
**Test** `core/src/voice/__tests__/stt-client.test.ts`: spin a local `ws` mock server (baseUrl→it), assert on connect it gets `{"type":"KeepAlive"}`; `sendAudio(buf)` forwards binary; on `{"type":"TranscriptText",data}` emits `transcript(text,false)`, on `TranscriptEndpoint` emits `transcript(last,true)`; `finalize()` sends `{"type":"CloseStream"}` and resolves. `Function`-free (pure `ws`).

## Task 2 — Core relay `core/src/voice/voice-relay.ts` + rest-server branch (+ test)
`isVoiceSttUpgrade(req)` = `req.url` path `^/voice/stt/ws`. `handleVoiceSttUpgrade(req, socket, head)`:
- Validate `?token=` against the api-token (reuse the same check other routes use; reject → `socket.destroy()` after 401 handshake).
- `WebSocketServer({noServer:true}).handleUpgrade(...)` → browser WS.
- `getValidAccessToken()` + `detectClaudeCodeVersion()` → `new STTClient({token, userAgent})`; `await connect()`.
- Bridge: browser binary msg → `stt.sendAudio(Buffer)`; browser text `{"type":"finalize"}` → `stt.finalize()`; browser text `{"type":"close"}`/ws close → `stt.close()`. `stt.on('transcript',(t,f)=>ws.send(JSON {type:'transcript',text:t,final:f}))`; `stt.on('error',e=>ws.send(JSON {type:'error',message}))` ; `stt.on('close',()=>ws.close())`.
- Register the branch in `rest-server.ts` `server.on('upgrade')` (before the `else socket.destroy()`).
**Test** `voice-relay.test.ts`: mock STTClient (inject), fake browser ws — assert binary→sendAudio, finalize text→finalize(), transcript event→browser JSON, bad token→rejected.

## Task 3 — Web worklet `web/public/voice/mic-worklet.js`
Copy `lm-voice/app/src/renderer/mic-worklet.js` VERBATIM (registerProcessor `mic-downsampler`, 16k Int16 80ms frames). Served as a static asset for `audioWorklet.addModule`.

## Task 4 — Web shared TTS `web/src/lib/speech.ts` (+ test) + refactor
Extract `speechText(md:string):string` (the markdown-strip from `TranscriptMessage.tsx`) + `speak(text)/cancelSpeech()` (SpeechSynthesis wrappers). Refactor `TranscriptMessage.tsx` read-aloud to import them (no behavior change). **Test** `speech.test.ts`: `speechText` strips fences/inline-code/links/md punctuation.

## Task 5 — Web hook `web/src/hooks/useVoiceConversation.ts`
State machine `idle|listening|transcribing|thinking|speaking|error`; `{state,interim,error,supported,start(),stop()}`. `start`: `getUserMedia({audio:{channelCount:1}})` → `AudioContext` → `addModule('/voice/mic-worklet.js')` → `AudioWorkletNode('mic-downsampler')` → open `WebSocket(coreWsUrl+?token)`; worklet `onmessage` (ArrayBuffer) → `ws.send(buf)` while OPEN; ws `{type:transcript}` → set `interim` (or accumulate finals). `stop`: stop tracks/close AudioContext, `ws.send('{"type":"finalize"}')`, await a final transcript (or timeout), then `onFinalTranscript(text)` (thinking) → `speak(reply)` (speaking) → idle. Full cleanup on stop/unmount/error. `supported = !!navigator.mediaDevices?.getUserMedia && !!window.AudioWorklet`.

## Task 6 — Web `ChatView` voice UI
Replace the disabled 🎤 with a push-to-talk button (pointerdown=`start`, pointerup/pointerleave=`stop`), wired to `useVoiceConversation({ wsUrl, onFinalTranscript: (t)=>send(t), speak })`. Status line above composer: `listening… ‹interim›` / `transcribing…` / `thinking…` / `speaking…` / error. Disable + hint when `!supported`. `wsUrl` derives from the same base as `apiFetch` (Core origin) with `/voice/stt/ws?token=`.

## Task 7 — Build, deploy 117, live-verify
`./core.sh build`-equivalent (clean-recompile the new voice files), core tests green; `next build` + standalone deploy to 117; restart; browser on 117: hold mic → speak → see interim → release → transcript sent → reply spoken. Then final review subagent over the whole diff.
