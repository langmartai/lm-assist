# YouTube Connector (embedded-JSON reader + CDP browser fallback)

lm-assist can read PUBLIC YouTube data — a channel's video list, one video's
metadata, and a video's transcript — exposed as MCP tools that ride the same hub
relay as the other connectors. No YouTube Data API, no API key, no quota.

Built 2026-08-05 on branch `feat/youtube-connector`, modelled on the Gmail
connector's browser bridge — and then, driven by measurement, inverted: the DATA
path is a plain fetch of YouTube's pages with their embedded JSON parsed
node-side, and the CDP browser is the *authenticated fallback*, not the primary.

## How it fits the architecture

```
claude.ai / Claude Code
  └─ mcp__…_lm-assist_…_youtube_*             (MCP tools)
       └─ LangMart hub ──api_relay──▶ Core    (/youtube/* on loopback)
                                        ├─ fetchPageText: node-side fetch ──▶ youtube.com   (PRIMARY)
                                        └─ fallback: cdp-client ──CDP──▶ Chrome (port 9225) (cookies)
```

Each MCP tool wraps this node's own `/youtube/*` REST route on loopback (single
source of truth), so identical behavior is reachable from the stdio MCP, the HTTP
`/mcp` endpoint, and remotely via the hub relay.

**There is no local store and no DOM scraping.** Every page YouTube serves embeds
its full data as JSON (`ytInitialData`, `ytInitialPlayerResponse`); the connector
fetches the page bytes and parses that JSON in node. No selectors, no rendered-DOM
race, and — because `fetch(url)` returns exactly that url's bytes — none of the
"did the RIGHT view render" verification the DOM connectors need.

## 🔴 Why the browser is the FALLBACK — measured 2026-08-05, exhaustively

On node 123, **every Chrome was blocked from youtube.com by the network path**
while a plain node/curl fetch of the same URLs returned 200 in ~60 ms:

| probe | result |
|---|---|
| headed Chrome, fresh profile, youtube.com tab | navigation never commits; `Runtime.enable` never answers |
| headless=new, robots.txt only, QUIC off, PQ/ECH off, v4-forced | same — in-page `fetch` to youtube.com hangs (AbortError at 40s) |
| `about:blank` tab in the SAME Chrome | answers in **3 ms** |
| claude.ai / mail.google.com tabs (Gmail's driver) | answer in **6 ms** |
| `curl` / node fetch of the same youtube URLs | **HTTP 200 in ~60 ms** |

An on-path filter RSTs/blackholes browser-fingerprint TLS to youtube.com on that
LAN. Not fixable in code — so the connector must not DEPEND on the browser for
public reads. `fetchPageText` tries node-side first and falls back to the driver
browser's in-page fetch (cookies attached — the Gmail `view=om` lesson) for
age-gated content and consent-walled regions.

🔴 **When the browser IS used, its tab stays parked on `robots.txt`** — rendering
the YouTube SPA under `headless=new` wedges the renderer (accepts the debugger
socket, answers nothing; every CDP call then times out). All the Gmail bridge
disciplines carry over: bounded CDP calls, the 3-rung openSession recovery ladder
(probe → recycle tab → relaunch, rate-limited, only when a profile exists), the
single-writer driver lock (bounded 120s, holder-age in the refusal), and recycle
opens the fresh tab BEFORE closing old ones (closing the last tab exits headless
Chrome).

## 🔴 The transcript endpoint lies with an empty 200 — measured 2026-08-05

The caption `baseUrl` from the WEB player response returns **HTTP 200 with an
EMPTY body** to a client without a browser proof-of-origin token (`pot`) —
success-shaped nothing. The connector treats empty as expected-not-final and
falls back to the **innertube ANDROID client** (`/youtubei/v1/player`, clientName
ANDROID): the same track that returned an empty body via the web url returned the
full transcript via the ANDROID url. That response is **srv3 XML**
(`<p t="4212" d="793">text</p>`, ASR tracks nest `<s>` word spans), parsed by
`parseSrv3`; json3 is parsed by `parseJson3`. `TRANSCRIPT_EMPTY` is only thrown
after BOTH endpoints came back empty.

## 🔴 The 2026 channel layout is `lockupViewModel`, not `videoRenderer`

A channel `/videos` page now renders through lockup view models. Verified field
by field on a live page:

| field | where |
|---|---|
| videoId | `lockupViewModel.contentId` (`contentType: LOCKUP_CONTENT_TYPE_VIDEO`) |
| title | `metadata.lockupMetadataViewModel.title.content` (plain string, NOT runs) |
| views/published | `…metadata.contentMetadataViewModel.metadataRows[].metadataParts[].text.content` |
| duration | `contentImage.thumbnailViewModel.overlays[].thumbnailBottomOverlayViewModel.badges[].thumbnailBadgeViewModel.text` |

`collectChannelVideos` handles BOTH shapes (classic renderers still appear on
search/other surfaces) via a deep scan that does not hard-code the nesting.
Playlist lockups (`LOCKUP_CONTENT_TYPE_PLAYLIST`) are skipped.

## Tools & scopes

6 tools. All reads are public; login is the only admin surface.

| Tool | Scope | Purpose |
|---|---|---|
| `youtube_status` | read | provider, browser running?, profile on disk?, signed in? |
| `youtube_channel_videos` | read | a channel's videos, newest first (handle / URL / UC-id / name search) |
| `youtube_video` | read | one video's metadata + description from its URL/id |
| `youtube_transcript` | read | timestamped transcript; optional `lang` (BCP-47); human track preferred over ASR |
| `youtube_selfcheck` | read | the canary: channel list + transcript end to end |
| `youtube_login` | admin | launch the driver browser (authenticated fallback only) |

Registered in `expanded.ts` (defs + handlers), `configure.ts` `TOOL_SCOPES`,
`registry/catalog.ts` (category `youtube` + CATEGORY_ORDER), and
`routes/core/index.ts` — a missing `TOOL_SCOPES` entry CRASHES Core on every
`tools/list` (see `docs/mcp-surfaces.md` and the Gmail incident).

## REST routes

`GET /youtube/status` · `GET /youtube/channel-videos?channel=&limit=` ·
`GET /youtube/video?video=` · `GET /youtube/transcript?video=&lang=` ·
`GET /youtube/selfcheck?channel=&video=` · `POST /youtube/login` ·
`GET /youtube/login/status?port=` · `POST /youtube/keepalive`

Accepted `video` forms: a bare 11-char id, `watch?v=`, `youtu.be/…`,
`/shorts/…`, `/live/…`, `/embed/…`. Accepted `channel` forms: `@handle`, bare
handle, `UC…` id, a full channel URL, or free text (resolved via a channel
search). Transcripts are bounded by `YOUTUBE_MAX_TRANSCRIPT_CHARS` (default
100k) with `truncated` REPORTED, never silent.

## Selfcheck semantics

`browser.reachable` is INFORMATIONAL, not a gate — public reads do not need the
browser, so a missing browser is a skip that names the consequence ("age-gated
fallback unavailable"), and `channel.videos` / `transcript.fetch` run regardless.
"Could not run" (BROWSER_NOT_RUNNING / BROWSER_BUSY / CDP_* ) is a SKIP, never a
FAIL — a suite that goes red because the environment was down teaches the reader
to ignore red. A channel whose first videos have no captions is a SKIP for
`transcript.fetch` (the feature was not exercised), not a failure.

## Environment

| Var | Default | Effect |
|---|---|---|
| `YOUTUBE_CDP_PORT` | `9225` | debug port of the fallback driver browser |
| `YOUTUBE_CDP_URL` | — | full CDP base; wins over the port |
| `YOUTUBE_KEEPALIVE_MIN` | `0` (off) | keep-alive interval in minutes for a signed-in session |
| `YOUTUBE_MAX_TRANSCRIPT_CHARS` | `100000` | flattened-transcript ceiling (truncation reported) |
| `YOUTUBE_PROVIDER` | `cdp` | provider name (forward-compat) |
| `LM_ASSIST_PROD` | — | `true` forces prod paths (no `-dev` suffix) |

## Validation status

**Verified LIVE 2026-08-05 on 123 (dev :3200)**, each through the REST route:

| Check | Result |
|---|---|
| `youtube_selfcheck` | **ok=true — 3 passed / 0 failed / 1 skip** (browser, honestly) |
| `channel-videos @YouTube` | 5/5 with title/views/duration (lockup layout) |
| `channel-videos mkbhd` (bare handle) | resolved to Marques Brownlee, real videos |
| `video` (full watch URL) | title/channel/views/length/publish date/description/captions flag |
| `transcript` (id) | 146 segments, human `en` track preferred over ASR |
| `transcript` (`youtu.be` URL + `lang=pt-BR`) | 145 segments in Portuguese |
| unit tests (parsers, registration, scopes, catalog budget) | 17/17 pass |
