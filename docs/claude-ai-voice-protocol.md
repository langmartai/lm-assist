# claude.ai voice protocol — the voice catalogue (who speaks back)

How lm-assist picks **which voice claude.ai answers in**, where the real names came from, and
how to re-derive them when claude.ai ships new ones.

## The catalogue

Five voices. `buttery` is claude.ai's own default.

| id | label |
|----|-------|
| `buttery` | Buttery |
| `airy` | Airy |
| `mellow` | Mellow |
| `glassy` | Glassy |
| `rounded` | Rounded |

Canonical copies (edit **both** — same deliberate core↔web duplication as the voice-URL contract):

- `core/src/voice/claude-voice-url.ts` → `CLAUDE_VOICES`, `DEFAULT_CLAUDE_VOICE`, `normalizeVoice()`
- `web/src/components/voice/VoiceSelector.tsx` → `VOICES`, `DEFAULT_VOICE`

🔴 **The id list is closed, and an unknown value is not a soft error.** The voice is a WS query
param fixed at connect; claude.ai validates it against its own set and rejects the upgrade for
anything else, so a typo produces `up_error` and a call with **no audio at all** — not a
fallback. `normalizeVoice()` therefore whitelists before the id can reach the wire, degrading
to `buttery` exactly as claude.ai's own client does with a stale persisted pick.

## Where the names come from (and why the obvious routes fail)

**There is no voice-catalogue API.** Verified 404 on the live account: `/api/voices`,
`/api/organizations/<org>/voices`, `/api/organizations/<org>/voice_settings`,
`/api/organizations/<org>/voice/voices`, `/api/ws/voice/voices`.
(`/api/organizations/voices` returns 400 — that is just the org-id-missing shape, not a route.)

The list ships **in the client bundle**. Two things make it hard to find:

1. **claude.ai is no longer a Next.js app.** It is bundled with **rolldown** and its assets are
   served from `https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/`. So
   `_buildManifest.js` / `buildId` / `_next/static` enumeration — the Next.js playbook — finds
   nothing, because none of it exists any more.
2. Grepping only the ~20 *eagerly loaded* scripts misses it: the voice code lives in chunks
   reached through the lazy graph.

### The method that works: crawl the rolldown asset graph to closure

`assets-proxy.anthropic.com` is a **public CDN — no auth, no Cloudflare**, so this needs no
browser, no proxy and no cookies once you have the entry URLs. Rolldown emits lazy-chunk
filenames as literal `"<name>-<hash>.js"` strings inside their parents, so a transitive crawl
from the eager set reaches every chunk.

1. Load `https://claude.ai/new` once in a real Chrome (cookies + a real-Chrome UA — see the CF
   notes in `CLAUDE.md`) and record every `.js` response URL. That is the seed set only.
   Note `performance.getEntriesByType('resource')` can come back empty; listen to Chrome's
   `response` event instead.
2. Fetch each seed chunk from the CDN, regex out every `["'`/]([\w$]+(?:-[\w$]+)*-[\w-]{8})\.js["'`]`
   reference, and repeat until no new names appear (~1,400 chunks, a couple of minutes).
3. Grep the fetched bodies for a **known-good name** — `buttery` — to prove you found the real
   list rather than a plausible-looking one.

As of 2026-07-25 that lands in two chunks whose definitions corroborate each other:

```js
// shared-10-*.js — the picker list (ids + human labels)
zA=[{id:"buttery",label:"Buttery"},{id:"airy",label:"Airy"},{id:"mellow",label:"Mellow"},
    {id:"glassy",label:"Glassy"},{id:"rounded",label:"Rounded"}]
JA="buttery"                      // default
VA="claude-selected-voice"        // localStorage key claude.ai persists the pick under
KA=[{id:"slow",value:.8},{id:"normal",value:1},{id:"fast",value:1.2}]   // tts_speed tiers

// shared-13-*.js — the closed validator + the persisted read
Lx=new Set(["buttery","airy","mellow","glassy","rounded"])
function Ox(e){return e||(()=>{try{const v=localStorage.getItem("claude-selected-voice");
  if(v&&Lx.has(v))return v}catch{}return null})()??"buttery"}
```

Completeness check: of the five, only `rounded` appears outside those two chunks (it is also a
CSS/border term). The only voice-shaped `{id,label}` array and the only voice `Set` in the whole
graph are the two above, so the catalogue is these five and nothing is gated behind a flag.

Chunk hashes change on every claude.ai deploy — re-run the crawl rather than hardcoding a
filename. Reference implementation of this method lives in this commit's session scratchpad;
it is ~60 lines of `fetch` + regex.

## The URL contract

`core/src/voice/claude-voice-url.ts` mirrors claude.ai's own query builder (its bundled `Rg(e)`)
key for key, so a URL we build is indistinguishable from one its web app builds:

```
wss://claude.ai/api/ws/voice/organizations/<org>/chat_conversations/<conv>
  ?input_encoding=opus&input_sample_rate=16000&input_channels=1&output_format=pcm_16000
  &language=en&timezone=<tz>&tts_speed=1.00&server_interrupt_enabled=true
  &voice=<id>&client_aec=true&client_platform=web_claude_ai
  [&model=…][&effort=…][&thinking_mode=…]
```

## How the choice travels

```
VoiceSelector (localStorage "claude-voice-selected")
  -> ClaudeVoiceOverlay state
  -> useClaudeVoice({voice})
  -> connect frame {type:"connect", conversationUuid, model, effort, thinkingMode, voice}
  -> claude-voice-relay.ts ConnectMsg
  -> buildClaudeVoiceUrl({voice}) -> normalizeVoice() -> &voice=<id>
```

**Applies on the NEXT start, never the live call.** The voice is fixed at connect and
`useClaudeVoice.start()` is a no-op while a session is active, so the footer labels both
selectors "Applies on next start" rather than implying a live switch. The overlay reads the
remembered voice during its **first render**, not in a mount effect — it auto-starts on mount,
and a mount effect would land in the same flush, so `start()` would close over the default and
ignore the remembered pick on exactly the call that matters most.

Tests: `core/src/__tests__/claude-voice-url.test.ts` (catalogue, every id reaches the query,
unknown degrades) and `claude-voice-relay.test.ts` (the connect frame's voice survives into the
WS URL).

## Discovered but deliberately not wired

Present in claude.ai's client, out of scope for "who speaks back" — documented so the next
person does not have to re-derive them:

| thing | value |
|---|---|
| speed tiers → `tts_speed` | `slow` 0.8 · `normal` 1.0 · `fast` 1.2 (clamped 0.7–1.2). We send a fixed `1.00`. |
| activation mode | `claude-voice-activation-mode`, e.g. `hands_free` |
| speed persistence | `claude-voice-speed` |
| device pickers | `voice-mode:selected-mic-device-id` / `voice-mode:selected-speaker-device-id` |
| other query params | `dev_overrides`, `project_uuid` |

## Safety

Log cookie **names** only, never values, and strip query strings from any logged URL — the voice
WS URL carries org/conversation ids and the connection is authenticated by cookie.
