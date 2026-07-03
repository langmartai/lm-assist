# WhatsApp CDP Provider (client-side / desktop app)

The `cdp` WhatsApp provider drives a logged-in WhatsApp **Desktop app** (a WebView2 wrapper
around WhatsApp Web) over the Chrome DevTools Protocol, and exposes it through the same
6-tool MCP surface and `/whatsapp/*` routes as the server (Meta Cloud API) provider.
Provider selection: `WHATSAPP_PROVIDER=cdp` (this build defaults to `cdp`); CDP endpoint via
`WHATSAPP_CDP_URL`/`WHATSAPP_CDP_PORT` (default `http://localhost:9222`).

## DOM facts (WebView2 build, mid-2026)

These are the extraction rules `cdp-client.ts` relies on; re-verify them when WhatsApp
updates its web bundle.

- **No `message-in` / `message-out` classes.** Message direction comes from:
  `data-icon="tail-out"` (first bubble of an outbound group) OR a status-tick icon ligature
  `wds-ic-(read|delivered|sent|check|time)` in the row's text content — every outbound bubble
  carries a tick; inbound rows never do. `tail-in` marks inbound group leaders.
- **Per-message tick state** maps from the same ligature: `wds-ic-read` → read,
  `wds-ic-delivered` → delivered, `wds-ic-sent`/`-check` → sent, `wds-ic-time` → pending.
- **Chat rows**: name from `span[title]` — but filter UI hint titles ("click here for contact
  info" and localized variants) or a hint becomes the chat name. Time labels are locale text
  (`19:09`, `上午/下午h:mm`, `昨天`/`Yesterday`, weekday names, `yyyy/m/d`); unread badge is an
  aria-label containing unread/未读 or a small digit-only span.
- **Self number**: `localStorage['last-wid-md']` (fallback `last-wid`) holds the logged-in
  wid, e.g. `"<digits>:1@c.us"` — `/whatsapp/status` returns the digits as `self`.
- **Avatars**: chat rows render profile pictures; `blob:` sources are fetchable in-page
  (fetch → data URL), https CDN URLs pass through and hot-link fine cross-origin.
- The list is **virtualized** — only rendered rows exist in the DOM. Ingest covers what is
  visible; scroll `#pane-side` (scrollTop = 0 is most-recent) to surface more chats.
- Opening a chat requires a TRUSTED CDP `Input.dispatchMouseEvent` click (synthetic JS
  `.click()` does not fire the app's React handlers).

## Local stores (all under `WA_DATA_DIR`, a display cache — the device is source of truth)

| File | Contents |
|---|---|
| `messages.jsonl` | Append-only ingested messages, deduped by id (first-seen wins) |
| `chat-order.json` | The app's own chat order + unread badges + avatars, rewritten per sync |
| `read-state.json` | Per-chat read cursors (`markRead`) |
| `media/local-<sha1>` (+ `.json` mime sidecar) | Image bytes captured from rendered messages (≤2.5MB each, capped at 300 files, pruned oldest-first) |

Because the message store is first-seen-wins, tick states are overlaid FRESH on every
`/whatsapp/messages` read from the current sync (a message read later must turn blue).
Send echoes are deduped at read time — DOM copies carry invisible bidi control marks
(U+202A etc.); strip them before comparing text.

`/whatsapp/chats` returns chats in the app's own order with the badge as `unreadCount`.
`/whatsapp/media?id=local-…` serves the local cache as `{ mime, base64 }` so a relay can
stream bytes to a remote consumer. Voice/video/document bytes are not captured yet (the app
lazy-loads them only on user interaction).

## Deploy trap: partial dist syncs

When the running core is an npm install and the provider is deployed by copying built files,
always sync the WHOLE set as one unit — `dist/whatsapp/*`, `dist/routes/core/whatsapp.routes.js`,
`dist/mcp-server/tools/whatsapp.js` — and make sure `dist/mcp-server/configure.js` TOOL_SCOPES
covers every WhatsApp tool (including `whatsapp_login: 'admin'`). A missing scope entry makes
`assertScopesCoverTools` throw on the FIRST MCP request and **crashes the core process**
(symptom: API port dead, log tail shows the TOOL_SCOPES error). A leftover `cdp-client.js`
next to hub-variant routes is the tell that an npm update overwrote a previous sync.
