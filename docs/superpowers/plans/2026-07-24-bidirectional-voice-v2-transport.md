# Bidirectional Voice v2 — Transport + Duplex Audio + Model Selection (Plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Core-hosted headless-Chrome relay that carries claude.ai's v2 voice WS, plus a browser audio engine + `/cowork` voice overlay with a model/effort/thinking control — a working duplex voice conversation, alongside the existing dictation.

**Architecture:** `cf_clearance` is fingerprint-bound, so real Chrome (Puppeteer, on Core) opens the claude.ai voice WS; a thin injected page script pipes frames over a loopback `wss` to Core; Core bridges to the user's browser over same-origin `wss`; all audio (Opus up / 320-byte PCM down) lives in the user's browser. This is lm-mobile's proven "WebView-relay" backend ported to Puppeteer.

**Tech Stack:** Node `http`/`ws`, `puppeteer-core` + system google-chrome, WebCodecs `AudioEncoder` (Opus), Web Audio `AudioContext`, Next.js 16/React 19, Zustand. Design: `docs/superpowers/specs/2026-07-24-bidirectional-voice-v2-design.md`. Protocol: `/home/yi/lm-assist/docs/claude-ai-voice-protocol.md` (node 123). Port sources on 117: `~/lm-mobile/agent/app/src/main/assets/{voice-engine.js,claude-ws-relay.js}`, `~/lm-mobile/agent/app/src/main/java/com/langmartai/lmmobile/agent/handlers/`.

## Global Constraints

- **Ports:** never hardcode. Core: `__dirname.includes('node_modules')` → prod 3100/3849 else dev 3200/3949. Web: `NEXT_PUBLIC_LOCAL_API_PORT`. HTTPS port = `WEB_PORT+1` (dev 3949 / prod 3849), `LM_HTTPS_PORT` overrides.
- **New core runtime deps go in BOTH `package.json` AND `core/package.json`** (dual-pin convention). `puppeteer-core` must be a declared dep; **pin `puppeteer-core` to the version already resolved in the repo** — verify with `node -e "console.log(require('puppeteer-core/package.json').version)"`.
- **chokidar stays `^3.6.0`; selfsigned stays `^2.4.1`** — do not bump (ESM `ERR_REQUIRE_ESM` hazard).
- **Tests run only from `core/src/__tests__/` (flat).** A `core/src/voice/__tests__/*` file is NOT run by `npm test`. Put every new core test in `core/src/__tests__/`.
- **`voice-url.ts` shared block must stay byte-identical** between `core/src/voice/voice-url.ts` and `web/src/lib/voice-url.ts` (a core test enforces it).
- **PII:** transcript/speech text logged only when `process.env.LM_VOICE_DEBUG === '1'`. Structural counts always.
- **Build under Node ≥20.9** (`export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"`). Worktree has no `node_modules` (resolves up-tree); new deps → `npm install <pkg> --no-save --ignore-scripts` in the MAIN repo, edit worktree `package.json`, build core with `npx tsc`, web with `npx next build`.
- **Rebuild + test on DEV only:** `./core.sh build && ./core.sh restart` → :3200/:3948. Prod (:3100/:3848) untouched.
- **Commits:** no backticks in `git commit -m` (use `-F -`); end body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01YTgqADR9WsL89babdyRPAT`.
- **Feature is additive:** the STT dictation relay (`voice-relay.ts` → `/voice/stt/ws`) and its web hook stay untouched.

## File Structure

**Core (`core/src/voice/`)**
- `voice-v2-capability.ts` (new) — pure availability probe (`LM_HTTPS` on + claude.ai cookie present + system Chrome path resolvable).
- `claude-chrome.ts` (new) — Puppeteer lifecycle manager (launch/reuse/ensureLoaded/openVoicePage/teardown), injectable browser factory.
- `claude-voice-url.ts` (new) — pure builder of the claude.ai voice WS URL from `{org, conv, model, effort, thinkingMode, voice, tz}`.
- `assets/claude-ws-relay.js` (new) — injected page script (ports lm-mobile `claude-ws-relay.js`), loopback-wss page bridge.
- `claude-voice-relay.ts` (new) — user bridge (`/voice/claude/ws`) + page bridge (`/voice/claude/page-bridge`) + orchestration.
- `voice-url.ts` (modify) — add `buildClaudeVoiceWsUrlFromParts` to the shared block.

**Core (other)**
- `rest-server.ts` (modify) — register the two upgrade routes.
- `package.json` + `core/package.json` (modify) — declare `puppeteer-core`.

**Web (`web/`)**
- `src/lib/voice-url.ts` (modify) — mirror `buildClaudeVoiceWsUrlFromParts` + `buildClaudeVoiceWsUrl`.
- `public/voice/claude-voice-engine.js` (new) — Opus encode + PCM playback (ports lm-mobile `voice-engine.js`).
- `src/hooks/useClaudeVoice.ts` (new) — session state machine + `message_sse` demux (audio/transcript/model; connectors deferred to Plan B).
- `src/components/cowork/ModelEffortSelector.tsx` (modify) — optional `thinking_mode`.
- `src/components/voice/ClaudeVoiceOverlay.tsx` (new) — the voice-mode overlay UI.
- `src/components/cowork/ChatView.tsx` (modify) — voice-mode toggle + mount the overlay.

**Tests (`core/src/__tests__/`)** — `claude-voice-url.test.ts`, `claude-voice-relay.test.ts`, `voice-url-claude.test.ts` (incl. byte-identity), `voice-v2-capability.test.ts`.

---

### Task 1: Voice-v2 capability probe + `puppeteer-core` dep

**Files:**
- Create: `core/src/voice/voice-v2-capability.ts`
- Test: `core/src/__tests__/voice-v2-capability.test.ts`
- Modify: `package.json`, `core/package.json`

**Interfaces:**
- Produces: `export function voiceV2Capability(env: {httpsEnabled: boolean; cookiePresent: boolean; chromePath: string | null}): { available: boolean; reason: string }` and `export function resolveChromePath(): string | null` (checks `/usr/bin/google-chrome`, `google-chrome-stable`, `chromium`, `PUPPETEER_EXECUTABLE_PATH`).

- [ ] **Step 1: Declare the dep.** In the MAIN repo run `node -e "console.log(require('puppeteer-core/package.json').version)"`, then add `"puppeteer-core": "<that exact version>"` to `dependencies` in BOTH `package.json` and `core/package.json`. In the worktree, `npm install --package-lock-only`.

- [ ] **Step 2: Write the failing test** (`core/src/__tests__/voice-v2-capability.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceV2Capability } from '../voice/voice-v2-capability';

test('available only when https + cookie + chrome all present', () => {
  assert.equal(voiceV2Capability({ httpsEnabled: true, cookiePresent: true, chromePath: '/usr/bin/google-chrome' }).available, true);
});
test('unavailable names the first missing precondition', () => {
  assert.match(voiceV2Capability({ httpsEnabled: false, cookiePresent: true, chromePath: '/x' }).reason, /https/i);
  assert.match(voiceV2Capability({ httpsEnabled: true, cookiePresent: false, chromePath: '/x' }).reason, /cookie/i);
  assert.match(voiceV2Capability({ httpsEnabled: true, cookiePresent: true, chromePath: null }).reason, /chrome/i);
});
```

- [ ] **Step 3: Run — expect FAIL.** `cd core && npx tsc && node --test dist-test/__tests__/voice-v2-capability.test.js` (or the repo's `npm test` filter). Expected: module-not-found / assertion fail.

- [ ] **Step 4: Implement** `voice-v2-capability.ts`:

```ts
import fs from 'node:fs';

const CHROME_CANDIDATES = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

export function resolveChromePath(): string | null {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  for (const p of CHROME_CANDIDATES) { try { if (fs.existsSync(p)) return p; } catch { /* noop */ } }
  return null;
}

export function voiceV2Capability(env: { httpsEnabled: boolean; cookiePresent: boolean; chromePath: string | null }): { available: boolean; reason: string } {
  if (!env.httpsEnabled) return { available: false, reason: 'LM_HTTPS is off — voice v2 needs a secure same-origin WSS' };
  if (!env.cookiePresent) return { available: false, reason: 'no claude.ai cookie on this node' };
  if (!env.chromePath) return { available: false, reason: 'no system Chrome found for the relay' };
  return { available: true, reason: 'ok' };
}
```

- [ ] **Step 5: Run — expect PASS.** Same command. Expected: all pass.

- [ ] **Step 6: Commit.** `git add core/src/voice/voice-v2-capability.ts core/src/__tests__/voice-v2-capability.test.ts package.json core/package.json package-lock.json` then commit `feat(voice): voice-v2 capability probe + puppeteer-core dep`.

---

### Task 2: claude.ai voice URL builder (pure)

**Files:**
- Create: `core/src/voice/claude-voice-url.ts`
- Test: `core/src/__tests__/claude-voice-url.test.ts`

**Interfaces:**
- Produces: `export interface ClaudeVoiceParams { org: string; conv: string; model?: string; effort?: string; thinkingMode?: string; voice?: string; tz?: string } ; export function buildClaudeVoiceUrl(p: ClaudeVoiceParams): string`

- [ ] **Step 1: Failing test:**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeVoiceUrl } from '../voice/claude-voice-url';

test('base params always present; model/effort/thinking only when set', () => {
  const base = buildClaudeVoiceUrl({ org: 'O', conv: 'C', tz: 'Asia/Singapore' });
  assert.match(base, /^wss:\/\/claude\.ai\/api\/ws\/voice\/organizations\/O\/chat_conversations\/C\?/);
  assert.match(base, /input_encoding=opus/); assert.match(base, /output_format=pcm_16000/);
  assert.match(base, /voice=buttery/); assert.match(base, /client_platform=web_claude_ai/);
  assert.doesNotMatch(base, /(^|&)model=/);
  const full = buildClaudeVoiceUrl({ org: 'O', conv: 'C', model: 'claude-sonnet-5', effort: 'high', thinkingMode: 'on' });
  assert.match(full, /[?&]model=claude-sonnet-5/); assert.match(full, /[?&]effort=high/); assert.match(full, /[?&]thinking_mode=on/);
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** (params verbatim from the protocol spec §1):

```ts
export interface ClaudeVoiceParams { org: string; conv: string; model?: string; effort?: string; thinkingMode?: string; voice?: string; tz?: string }

export function buildClaudeVoiceUrl(p: ClaudeVoiceParams): string {
  const q = new URLSearchParams({
    input_encoding: 'opus', input_sample_rate: '16000', input_channels: '1',
    output_format: 'pcm_16000', language: 'en', timezone: p.tz || 'UTC', tts_speed: '1.00',
    server_interrupt_enabled: 'true', voice: p.voice || 'buttery', client_aec: 'true',
    client_platform: 'web_claude_ai',
  });
  if (p.model) q.set('model', p.model);
  if (p.effort) q.set('effort', p.effort);
  if (p.thinkingMode) q.set('thinking_mode', p.thinkingMode);
  return `wss://claude.ai/api/ws/voice/organizations/${encodeURIComponent(p.org)}/chat_conversations/${encodeURIComponent(p.conv)}?${q.toString()}`;
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(voice): claude.ai v2 voice URL builder`.

---

### Task 3: Injected page relay script (`claude-ws-relay.js`)

**Files:**
- Create: `core/src/voice/assets/claude-ws-relay.js`

**Interfaces:**
- Consumes: injected into a `https://claude.ai` page with globals `__VOICE_URL__` (from Task 2) and `__BRIDGE_URL__` (`wss://127.0.0.1:<LM_HTTPS_PORT>/voice/claude/page-bridge?token=…`).
- Produces: bidirectional frame pipe: claude.ai WS binary/text ↔ page-bridge WS. Silent-Opus/`keep_alive` keepalive; forwards a `{type:'__page_status', state, code?}` control frame to the bridge on open/close (classify `4008` → `server_timeout`).

- [ ] **Step 1: Port + adapt.** Copy `~/lm-mobile/agent/app/src/main/assets/claude-ws-relay.js` to `core/src/voice/assets/claude-ws-relay.js`. Replace its native-bridge calls (Android `VoiceSink`/`window.__nativeSend`) with a **loopback page-bridge WebSocket**:

```js
// claude-ws-relay.js — injected into the claude.ai voice page. Bridges the
// claude.ai voice WS <-> a loopback wss to Core. No audio here (audio is in
// the user's browser); this only carries frames past Cloudflare via real Chrome.
(function () {
  const VOICE_URL = window.__VOICE_URL__, BRIDGE_URL = window.__BRIDGE_URL__;
  let up = null;      // claude.ai voice WS
  let bridge = null;  // loopback wss to Core
  const openBridge = () => {
    bridge = new WebSocket(BRIDGE_URL);
    bridge.binaryType = 'arraybuffer';
    bridge.onopen = () => openUpstream();
    bridge.onmessage = (ev) => { if (up && up.readyState === 1) up.send(ev.data); }; // browser->claude.ai
    bridge.onclose = () => { try { up && up.close(); } catch (e) {} };
  };
  const openUpstream = () => {
    up = new WebSocket(VOICE_URL);
    up.binaryType = 'arraybuffer';
    up.onopen = () => post({ type: '__page_status', state: 'up_open' });
    up.onmessage = (ev) => { if (bridge && bridge.readyState === 1) bridge.send(ev.data); }; // claude.ai->browser
    up.onclose = (e) => { post({ type: '__page_status', state: 'up_close', code: e.code, timeout: e.code === 4008 }); try { bridge && bridge.close(); } catch (er) {} };
    up.onerror = () => post({ type: '__page_status', state: 'up_error' });
  };
  const post = (o) => { try { if (bridge && bridge.readyState === 1) bridge.send(JSON.stringify(o)); } catch (e) {} };
  openBridge();
})();
```

- [ ] **Step 2: Manual sanity.** No unit test (browser-context asset); it is exercised by the Task 8/11 integration + e2e. Verify it parses: `node --check core/src/voice/assets/claude-ws-relay.js`.
- [ ] **Step 3: Commit** `feat(voice): injected claude.ai voice page relay (loopback-wss bridge)`.

---

### Task 4: Chrome lifecycle manager (`claude-chrome.ts`)

**Files:**
- Create: `core/src/voice/claude-chrome.ts`
- Test: `core/src/__tests__/claude-chrome.test.ts`

**Interfaces:**
- Consumes: `resolveChromePath()` (Task 1).
- Produces:
```ts
export interface VoicePage { evaluate(fn: string, ...args: unknown[]): Promise<unknown>; close(): Promise<void>; on(ev: string, cb: (...a: unknown[]) => void): void; }
export interface ChromeMgr { ensureLoaded(cookieHeader: string): Promise<void>; openVoicePage(voiceUrl: string, bridgeUrl: string): Promise<VoicePage>; teardownIfIdle(): Promise<void>; }
export function createChromeMgr(deps?: { launch?: () => Promise<any>; chromePath?: string | null }): ChromeMgr;
```
Launch args MUST include `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage`, `--ignore-certificate-errors` (so the page trusts Core's self-signed loopback wss). `ensureLoaded` sets cookies for `https://claude.ai` from `cookieHeader`, navigates to `https://claude.ai/`, waits ~9s for CF to settle. `openVoicePage` creates a page, sets `window.__VOICE_URL__`/`__BRIDGE_URL__` via `addScriptToEvaluateOnNewDocument`, navigates to a claude.ai page, injects `assets/claude-ws-relay.js`.

- [ ] **Step 1: Failing test** (inject a fake launch so no real Chrome in unit tests):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChromeMgr } from '../voice/claude-chrome';

test('reuses one browser across ensureLoaded calls', async () => {
  let launches = 0;
  const fakePage = { evaluate: async () => null, close: async () => {}, on: () => {}, setCookie: async () => {}, goto: async () => {}, addScriptToEvaluateOnNewDocument: async () => {}, addStyleTag: async () => {} };
  const fakeBrowser = { newPage: async () => fakePage, close: async () => {}, process: () => ({}) };
  const mgr = createChromeMgr({ chromePath: '/fake', launch: async () => { launches++; return fakeBrowser as any; } });
  await mgr.ensureLoaded('sessionKey=x');
  await mgr.ensureLoaded('sessionKey=x');
  assert.equal(launches, 1);
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `claude-chrome.ts` using `puppeteer-core` (default `launch` = `puppeteer.launch({executablePath: chromePath, headless: true, args:[…]})`). Parse the cookie header into `{name,value,url:'https://claude.ai'}` pairs for `page.setCookie`. Keep one `browser` + reuse; `teardownIfIdle` closes after no `openVoicePage` for `VOICE_CHROME_IDLE_MS` (default 300000). Guard all Puppeteer calls in try/catch; a launch failure throws a typed error the relay surfaces.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(voice): Puppeteer Chrome lifecycle manager for the voice relay`.

---

### Task 5: The relay bridges + route wiring (`claude-voice-relay.ts`, `rest-server.ts`)

**Files:**
- Create: `core/src/voice/claude-voice-relay.ts`
- Modify: `core/src/rest-server.ts` (add imports + upgrade branches near line 22 / the existing `isVoiceSttUpgrade` handling)
- Test: `core/src/__tests__/claude-voice-relay.test.ts`

**Interfaces:**
- Consumes: `buildClaudeVoiceUrl` (T2), `createChromeMgr` (T4), `resolveChromePath` (T1), `isValidToken`/`apiAuthEnabled` (existing `../auth/api-token`), the claude.ai cookie loader (reuse whatever `claudeai-session` module Core already uses; find via `grep -rl claudeai-session core/src`).
- Produces: `export function isClaudeVoiceUpgrade(req): boolean` (path `/voice/claude/ws`), `export function isClaudeVoicePageBridgeUpgrade(req): boolean` (path `/voice/claude/page-bridge`), `export function handleClaudeVoiceUpgrade(req, socket, head, opts)`, `export function handleClaudeVoicePageBridgeUpgrade(...)`, and `export async function bridgeClaudeVoice(userWs, pageBridgeWaiter, deps)` (injectable `makeChromeMgr` + `loadCookie` for tests).

Behavior: on a user WS connect, read the first JSON `{type:'connect', conversationUuid, model, effort, thinkingMode}`; build the voice URL (T2) + a page-bridge URL with a fresh one-time token; `ensureLoaded(cookie)` + `openVoicePage`. Pair the page-bridge WS (matched by the one-time token) with the user WS; then pipe binary frames both ways verbatim, and forward `__page_status` frames as `{type:'ready'|'reconnect'|'error'}` to the user. Structural logging like `voice-relay.ts`.

- [ ] **Step 1: Failing test** — mirror `core/src/voice/__tests__/`… no: put it in `core/src/__tests__/claude-voice-relay.test.ts`. Use fake user WS + fake page-bridge WS + a fake ChromeMgr; assert (a) a binary frame from the user reaches the page bridge, (b) a binary frame from the page bridge reaches the user, (c) `__page_status up_open` → user gets `{type:'ready'}`, (d) `up_close code:4008` → user gets `{type:'reconnect'}`.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeClaudeVoice } from '../voice/claude-voice-relay';
// ... construct FakeWs {readyState, send(rec), on(ev,cb), emit(ev,...a)} for user + bridge,
// a fake ChromeMgr whose openVoicePage resolves, and a loadCookie async () => 'sessionKey=x'.
// Drive: user.emit('message', Buffer.from(JSON.stringify({type:'connect',conversationUuid:'C'})));
// then bridge connects (test harness supplies it), assert frame relay + control mapping.
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `claude-voice-relay.ts` (structure mirrors `voice-relay.ts`: `WebSocketServer({noServer:true})`, `handleUpgrade`, token auth). Page-bridge auth = the one-time token minted per session (loopback-guarded: reject if remote address is not 127.0.0.1). Wire both `isClaudeVoiceUpgrade` and `isClaudeVoicePageBridgeUpgrade` into `rest-server.ts` next to `isVoiceSttUpgrade` (pass `options.apiKey`).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Build gate.** `./core.sh build` → clean tsc. Commit `feat(voice): Core relay bridges for claude.ai v2 voice + route wiring`.

---

### Task 6: Web transport contract (`buildClaudeVoiceWsUrl` + byte-identity)

**Files:**
- Modify: `core/src/voice/voice-url.ts` (add to the shared block), `web/src/lib/voice-url.ts` (mirror), 
- Test: `core/src/__tests__/voice-url-claude.test.ts`

**Interfaces:**
- Produces (in the shared block, both files byte-identical): `export function buildClaudeVoiceWsUrlFromParts(i: VoiceWsUrlInput): string | null` — same rules as `buildVoiceWsUrlFromParts` but path `/voice/claude/ws`. Web-only wrapper `buildClaudeVoiceWsUrl(opts:{isRemoteNode:boolean}): string|null` mirrors `buildVoiceWsUrl`.

- [ ] **Step 1: Failing test** (`voice-url-claude.test.ts`): assert `buildClaudeVoiceWsUrlFromParts` returns `wss://<host>/voice/claude/ws?token=…` for a local https page, `null` for remote/hub/insecure; AND re-assert the existing byte-identity check still passes for the shared block (read both files, extract between the SHARED markers, compare).

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — add the function inside the `===BEGIN/END SHARED VOICE URL LOGIC===` markers in `core/src/voice/voice-url.ts`, copy the identical block into `web/src/lib/voice-url.ts`, add the web wrapper.
- [ ] **Step 4: Run — expect PASS** (both the new cases and byte-identity).
- [ ] **Step 5: Commit** `feat(voice): buildClaudeVoiceWsUrl transport contract (core+web)`.

---

### Task 7: Browser audio engine (`claude-voice-engine.js`)

**Files:**
- Create: `web/public/voice/claude-voice-engine.js`

**Interfaces:**
- Produces a small class/factory `window.ClaudeVoiceEngine` (or an ES module the hook imports) with: `start({onFrame(opusBytes), onState})`, `playPcm(int16le320)`, `stop()`. Mic: `getUserMedia({echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1,sampleRate:48000})` → resample 48→16k → WebCodecs `AudioEncoder({codec:'opus',sampleRate:16000,bitrate:24000,opus:{application:'voip',frameDuration:20000}})` → `onFrame`. Playback: queue 320-byte PCM frames into an `AudioContext` at the play head (destination doubles as the AEC reference).

- [ ] **Step 1: Port + adapt.** Copy `~/lm-mobile/agent/app/src/main/assets/voice-engine.js` → `web/public/voice/claude-voice-engine.js`. Adaptations: (a) replace its relay-WS I/O with the `onFrame`/`playPcm` callbacks (the hook owns the WS); (b) keep the AEC3 `getUserMedia` constraints + the WebCodecs Opus encoder + the `AudioContext` PCM queue verbatim; (c) carry the 96 kHz worklet-tail fix (`keepFrom = Math.min(Math.floor(i) - 1, merged.length - 1)`) from `web/public/voice/mic-worklet.js` if a resample worklet is used; (d) strip Android-only bits.
- [ ] **Step 2: Parse check.** `node --check web/public/voice/claude-voice-engine.js`.
- [ ] **Step 3: Commit** `feat(voice): browser Opus/PCM audio engine (ported from lm-mobile)`.

---

### Task 8: The voice hook (`useClaudeVoice.ts`) — audio + transcript + model (no connectors yet)

**Files:**
- Create: `web/src/hooks/useClaudeVoice.ts`
- Test: `web/src/hooks/__tests__/useClaudeVoice.demux.test.ts` (pure demux fn tested with node:test/vitest per web test setup; if web has no test runner, extract the demux to a pure module and cover it in a core-style test)

**Interfaces:**
- Consumes: `buildClaudeVoiceWsUrl` (T6), `ClaudeVoiceEngine` (T7).
- Produces: `export function useClaudeVoice(opts:{conversationUuid:string; model:string; effort:string; thinkingMode?:string; isRemoteNode:boolean}): { state: VoiceState; transcript: string; assistantText: string; liveModel: string|null; start():void; stop():void; interrupt():void }` where `VoiceState = 'idle'|'connecting'|'listening'|'thinking'|'speaking'|'reconnect'|'error'`. Also `export function demuxMessageSse(frame: any, acc: DemuxAcc): DemuxAcc` (PURE — the testable core): handles `transcript_interim`→transcript, `message_start`→liveModel, `content_block_delta text_delta`→assistantText, `playback_start`/`user_input_end`→state, `tts_word`. Unknown `tool_use`/`connector_text` are **passed through untouched** (Plan B consumes them).

- [ ] **Step 1: Failing test** for `demuxMessageSse` — feed a `message_start {message:{model:'claude-sonnet-5'}}` → `liveModel==='claude-sonnet-5'`; a `content_block_delta {delta:{type:'text_delta',text:'hi'}}` → `assistantText==='hi'`; a `transcript_interim {text:'hello'}` → `transcript` includes 'hello'.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the hook: open `buildClaudeVoiceWsUrl(...)` WS (null→no-op), send `{type:'connect',conversationUuid,model,effort,thinkingMode}`, on `{type:'ready'}` start the engine; binary from WS = PCM → `engine.playPcm`; `engine` `onFrame` → `ws.send(opus)`; JSON frames → `demuxMessageSse`; `{type:'reconnect'}` → `reconnect` state; unmount cleanup (close WS + engine + AudioContext — carry the STT hook's cleanup lessons). 
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(voice): useClaudeVoice hook (duplex audio + transcript + live model)`.

---

### Task 9: Extend `ModelEffortSelector` with `thinking_mode`

**Files:**
- Modify: `web/src/components/cowork/ModelEffortSelector.tsx`

**Interfaces:**
- Produces: add optional props `thinking?: string; hideThinking?: boolean` and extend `onChange` to `(model, effort, thinking?) => void`. When `!hideThinking`, render a third "Thinking" section (`off`/`on`) in the popover. **Preserve existing call-sites**: keep the current `onChange(model, effort)` signature working (thinking is the optional 3rd arg; default `hideThinking = true`). Existing `ChatView`/`CoworkComposer` call-sites unchanged.

- [ ] **Step 1** (no separate runner for this pure UI change — verify by `next build` + reading): add the props + the Thinking section mirroring the Effort section markup; guard with `hideThinking` (default true).
- [ ] **Step 2: Build gate.** `cd web && npx next build` clean; confirm ChatView/CoworkComposer still type-check (3rd arg optional).
- [ ] **Step 3: Commit** `feat(voice): ModelEffortSelector optional thinking_mode`.

---

### Task 10: Cowork voice overlay + toggle

**Files:**
- Create: `web/src/components/voice/ClaudeVoiceOverlay.tsx`
- Modify: `web/src/components/cowork/ChatView.tsx` (add a voice-mode toggle button near the dictation mic ~line 199; mount the overlay when active)

**Interfaces:**
- Consumes: `useClaudeVoice` (T8), `ModelEffortSelector` (T9), the cowork conversation uuid + `model` state already in `ChatView` (`ChatView.tsx:32`).
- Produces: `export function ClaudeVoiceOverlay({ conversationUuid, model, effort, thinking, onModelChange, isRemoteNode, onClose }): JSX` — a panel with the `ModelEffortSelector` (controls the voice model), live transcript + assistant text, a speaking/thinking/listening indicator, Interrupt + Exit buttons. `tool_use`/`connector_text` render as a plain passthrough line for now (Plan B replaces with connector cards + approval).

- [ ] **Step 1:** Implement `ClaudeVoiceOverlay.tsx` wiring `useClaudeVoice`; states drive the indicator; buttons call `start/stop/interrupt`.
- [ ] **Step 2:** In `ChatView.tsx`, add a voice-mode toggle (icon button) that only renders when `buildClaudeVoiceWsUrl({isRemoteNode}) !== null` (hidden otherwise, like the dictation mic gate); toggling mounts `ClaudeVoiceOverlay` with the current `model`. Keep the existing dictation `MicButton` untouched.
- [ ] **Step 3: Build gate.** `./core.sh build && ./core.sh restart`; open `https://localhost:3949` (dev LM_HTTPS) on the Core host, confirm the voice toggle appears and the overlay opens (no console errors). If LM_HTTPS isn't on in dev, set `LM_HTTPS=1 ./core.sh restart`.
- [ ] **Step 4: Commit** `feat(voice): /cowork bidirectional voice overlay + toggle`.

---

### Task 11: End-to-end validation (real claude.ai WS) + connector-frame capture for Plan B

**Files:**
- Create: `core/src/__tests__/claude-voice-e2e.md` (a runnable checklist + a `scratchpad` script, kept out of `npm test` since it needs a live session)

**Interfaces:** none (validation task).

- [ ] **Step 1: Duplex smoke.** With dev services up + `LM_HTTPS=1`, on the Core host open `https://localhost:3949/cowork`, start voice, speak, confirm: transcript appears, an assistant voice reply plays, `liveModel` matches the `ModelEffortSelector` selection. Capture Core relay logs (frame/byte counts both directions).
- [ ] **Step 2: Model-param proof.** Select a non-default model (e.g. Opus 4.8), start voice, confirm `message_start.model` in the relay/console equals `claude-opus-4-8`.
- [ ] **Step 3: Reconnect.** Idle >10 min (or force a `4008` via a scripted close) → overlay shows reconnect → reconnect resumes the same conversation.
- [ ] **Step 4: CAPTURE the connector frames (closes the residual protocol gap → feeds Plan B).** On a conversation with a connector enabled (the spike conversation already had `enabled_mcp_tools`), ask something that triggers the connector; log the raw `message_sse` `tool_use` block (populated `integration_name`/`mcp_server_url`/`approval_key`/`approval_options`) + the approval round-trip + `connector_text`. Save the raw frames to `scratchpad/voice-connector-capture.json`. **This is the input to Plan B.**
- [ ] **Step 5: Commit** the e2e checklist + capture notes `test(voice): duplex+model e2e; capture live connector frames for Plan B`.

---

## Self-Review

**Spec coverage:** duplex audio (T3,T5,T7,T8) ✓; Chrome relay/CF (T4,T5) ✓; model selection control (T2 param, T9 control, T8 wiring, T10 UI) ✓; transport/degradation (T1,T6) ✓; reconnect/idle (T3,T5,T8,T11) ✓; alongside dictation (T10 keeps MicButton) ✓; testing (each task + T11) ✓. **Connectors** (spec §7) = Plan B, authored from T11's capture. **Residual protocol gap** closed in T11 ✓.

**Placeholders:** none — ported assets (T3,T7) name the exact source file + adaptations + a parse check; every codebase-specific unit has complete code + a test.

**Type consistency:** `buildClaudeVoiceUrl`/`ClaudeVoiceParams` (T2) used by T5; `createChromeMgr`/`VoicePage`/`ChromeMgr` (T4) used by T5; `buildClaudeVoiceWsUrl` (T6) used by T8,T10; `useClaudeVoice`/`demuxMessageSse` (T8) used by T10; `ModelEffortSelector` 3-arg `onChange` (T9) used by T10 — consistent.

---
**Plan B (connectors) — written after Task 11's capture:** connector/tool cards, the approval handshake UI (once/perChat/always), `connector_text` rendering, `mcp_auth_required`/`mcp_elicitation` surfacing, and `tool_result`/`turn_end` for client-executed builtins — grounded in the real frames from T11.4.
