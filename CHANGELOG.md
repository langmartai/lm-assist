# Changelog

## [Unreleased]

### claude.ai via-chrome — feature parity with cookie-file `/completion` + managed-browser banner + GUI→headless switch (2026-05-27)

A batched set of additions that bring the `/claude-ai/via-chrome/*` family up to par with the cookie-file path, plus two new endpoints that turn a launched browser into a clearly-labelled "managed" surface and let it transition from login-time-visible to runtime-headless without losing the session.

**`POST /claude-ai/via-chrome/conversations/:uuid/completion` — three new body fields.**

- `tools: [...]` — SPA-shaped MCP tool definitions to pass through to claude.ai. Previously hardcoded to `[]`, which meant the model had no way to see any connector's tools when called through this path; the only workaround was to embed the array client-side. Now pass-through.
- `autoApproveTools: boolean` — mirror of the cookie-file path's behavior. When `true`, the generated snippet does the full gate dance inside the browser: track every `tool_use` content_block as it streams, fire `POST /tool_approval` the moment `content_block_stop` arrives for it (NOT `message_delta` — that event doesn't fire until after approval lands, so waiting for it deadlocks), then poll the conversation until the assistant message has the `tool_result` block + post-tool text + non-`tool_use` `stop_reason`, and merge the final text into the snippet's return value. Approval key resolution is the same three-tier fallback (caller override → hash-suffixed key learned from the conv's `enabled_mcp_tools` → bare `<srv>:<tool>` key for first-time approval), with the same `<integration>:<tool>` ↔ `<tool>` name normalization. Validated end-to-end at 7–10 s for a real MCP tool call.
- `showOverlay: boolean` — when `true`, the snippet installs a managed-browser banner at the top of the page (`#__lm-assist-via-overlay`, z-index 2147483647), updates its status as the flow progresses (`"Sending prompt…"` → `"Calling claude.ai /completion (streaming)…"` → `"Done."`), installs a `beforeunload` warning, and intercepts clicks on `<a href>` pointing to non-claude.ai hosts (blocked + banner turns red with "Blocked navigation to {host}"). DOM is built node-by-node (`createElement` + `textContent`, no `innerHTML`) so the markup is XSS-safe by construction. A `MutationObserver` re-installs the banner if claude.ai's SPA wipes the node during a route change.

**`POST /claude-ai/browser/install-idle-banner` (new endpoint).** Body: `{port?, baseText?, noteText?}`. Attaches via CDP to every page target on a spawned browser, registers a `Page.addScriptToEvaluateOnNewDocument` script with the same overlay DOM, and stashes the live `CDPSession` objects in a module-level Map so the script registration survives subsequent navigations (CDP clears registrations when the session disconnects; a poller every 3 s also picks up new tabs the user opens). Initial state is green "Idle. Waiting for next lm-assist request." Survives across SPA route changes via `MutationObserver`. The via-chrome `/completion` snippet's `showOverlay: true` is idempotent against this banner — if it sees `window.__lmAssistViaOverlay` already installed, it updates the existing status rather than tearing down + recreating, and resets to "Idle" instead of removing the banner on completion. So the user gets a single persistent banner across the browser's lifetime, with status that ticks through what's happening.

**Off-site navigation detection.** The installer script checks `location.hostname` on every doc load. If the user lands on a host that isn't `claude.ai`, `*.claude.ai`, `*.anthropic.com`, or `accounts.google.com` (the last for Google SSO during login), it installs a red variant of the banner — "You navigated to {hostname} — this browser is reserved for claude.ai. Returning…" — and `location.replace('https://claude.ai/')`s after 1.8 s. The user briefly sees the banner explaining why they're being bounced. Verified by navigating the managed Chrome to `example.com` and watching the red banner render, then the auto-redirect fire, then the normal green idle banner restore on return.

**`POST /claude-ai/browser/switch-to-headless` (new endpoint).** Body: `{pid, profile?, port?, oldPort?, browser?}`. Closes the currently-running visible Chrome and re-launches it against the SAME profile directory in headless mode. Cookies + login state survive because Chrome's profile storage (cookies, localStorage, IndexedDB) lives on disk in the profile dir, not in the process. The new launch forces `--user-agent=Mozilla/5.0 ... Chrome/145.0.0.0 Safari/537.36` (no `HeadlessChrome`) because Cloudflare gates the default headless UA with an "Almost there… Just a moment…" challenge that 403s every API call regardless of cookies. After the switch, `/api/account_profile` from the new headless Chrome returns 200 against the same logged-in session. Companion idle-banner state for the old port is cleaned up automatically. Caller's typical sequence:

```
1. POST /claude-ai/browser/launch                {headless:false, profile:'isolated', port:9555}
2. POST /claude-ai/browser/install-idle-banner   {port:9555}                                ← banner shows "Idle, waiting…"
3. user logs in claude.ai inside the visible window
4. POST /claude-ai/browser/capture-session       {port:9555}                                ← proves session is live
5. POST /claude-ai/browser/switch-to-headless    {pid:<from-launch>, oldPort:9555, port:9777}
                                                                                            ↳ visible window closes
                                                                                            ↳ headless Chrome on :9777 inherits session via shared profile dir
6. POST /claude-ai/via-chrome/conversations/<uuid>/completion  ...  (runs silently)
```

The visible-mode behaviors (idle banner, snippet status updates, link/nav guards, off-site auto-redirect) only apply in non-headless launches — they're a courtesy for the user's eyes. Headless skips them entirely.

### claude.ai completion — server-side MCP tool-approval (`autoApproveTools`) (2026-05-27)

`POST /claude-ai/conversations/:uuid/completion` now accepts an `autoApproveTools` body field. When `true`, lm-assist intercepts the per-call approval gate that claude.ai's SPA normally shows the user ("Claude wants to use *foo* from *bar*") and resolves it automatically server-side. Caller gets a single response with `text`, `events`, `approvals: [{toolUseId, toolName, status, ok}, ...]`, and the post-tool continuation merged in. Default `false` — opt-in only, no behavior change for existing callers.

**Why this is a thing.** When a connector's tool doesn't have `account.settings.enabled_mcp_tools["<srv>:<tool>-<hash>"]` set (i.e. never previously `approval_option:'always'`-approved on this account), claude.ai's `/completion` SSE pauses after the model emits the `tool_use` block and waits for the SPA to `POST /tool_approval`. Without an interactive SPA, the SSE just hangs until timeout. The autoApprove path closes that loop: detect, approve, wait for continuation, return one merged response.

**Trigger point is non-obvious.** The first attempt waited for `message_delta { stop_reason: 'tool_use' }`. That event never arrives during the pause — claude.ai backend holds the SSE open BEFORE the message_delta, waiting for approval first. Fix: fire approval the moment `content_block_stop` arrives for a tool_use block. Verified against a live capture: backend resumes within ~500ms of the approval landing, then emits `tool_result` + post-tool text + `message_delta` + `message_stop` in that order on the same SSE.

**`approval_key` construction is three-tier.** claude.ai's `/tool_approval` body wants `approval_key: "<srv_uuid>:<tool>-<contentHash>"`. The hash is a content hash of the tool's current name + description + input_schema. Each conv's `settings.enabled_mcp_tools` carries any always-approved tools as `<srv>:<tool>-<hash>` keys; tools that have never been always-approved are only present as the bare `<srv>:<tool>` form. lm-assist now resolves in this order:

  1. Explicit `approvalKey` from the caller (highest priority, escape hatch).
  2. Hash-suffixed key learned from a one-off probe conversation that inherits `account.settings.enabled_mcp_tools` (cached 5 min per orgUuid).
  3. **Bare `<srv>:<tool>` key** as a fallback — claude.ai accepts this on first-time approval and computes the current hash server-side. This is what makes new tools work without a manual `always-allow` setup first.
  4. Tool not exposed by any connector (e.g. the SPA's internal `tool_search`) → synthetic 204; caller moves on.

**Integration-prefix stripping.** claude.ai's SSE delivers tool names as `<integration>:<tool>` (e.g. `lm-assist:search_memory`), but the conv's `enabled_mcp_tools` indexes by bare `<tool>` only. Lookup tries both shapes — `entry.hashKeys[fullName] || entry.hashKeys[strippedName] || entry.bareKeys[fullName] || entry.bareKeys[strippedName]` where `strippedName = fullName.split(':').pop()`. Forgetting this step costs about 90 seconds per failed test run before the SSE aborts.

**Post-SSE conv poll.** After approval, the model's continuation arrives by extending the SAME assistant message on claude.ai's side — not on a new SSE stream. The /completion stream closes with `message_stop`; lm-assist then polls `GET /chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true` every 1500ms (up to `min(timeoutMs, 60s)`) until the assistant message has both a `tool_result` block AND non-empty final text AND a non-`tool_use` `stop_reason` — at which point `text` in the response is the model's post-tool message (not just the pre-tool intro that the SSE captured). End-to-end wall time: ~9-10s for `search_memory` against the lm-assist MCP connector.

**Companion endpoint additions on `POST /claude-ai/conversations`** (so the gate can be FORCED for testing without changing account settings): `enabledMcpTools: {"<srv>:<tool>": true}` REPLACES inherited account settings on that conv — pass only the bare key to ensure no `alwaysApprovedKey` slips in via inheritance and the gate must fire. `toolSearchMode: "off"` is also passed through (advisory — claude.ai backend sometimes overrides).

**New exports in `core/src/utils/claudeai-session.ts`:** `discoverApprovalKeys(orgUuid?) → {hashKeys, bareKeys, expiresAt}`, `approveToolUse({orgUuid, convUuid, toolUseId, toolName, approvalOption?, approvalKey?, timeoutMs?})`, `clearApprovalKeyCache(orgUuid?)`. The first two are also reachable indirectly via `/completion?autoApproveTools=true`; the third is for tests + post-deploy hash-invalidation after the connector's tool descriptions are edited.

**Debug logging gated.** The per-stage `[autoApprove] ...` console traces (tool_use detection, approval HTTP result + latency, SSE-drained event count, conv-poll iterations) are off by default. Export `LM_ASSIST_DEBUG_AUTOAPPROVE=1` (or `=true`) to enable when investigating a gated flow that isn't completing as expected. ~8 log lines per /completion call when on.

**Validated end-to-end on 2026-05-27** — 9-10s round-trip for a gated `lm-assist:search_memory` invocation. Stock `undici`-backed `fetch` in lm-assist passes Cloudflare's bot scoring on every endpoint in the flow; no TLS-impersonation client is needed for this surface.

### claude.ai completion — attachments / files / sync_sources pass-through (2026-05-23)

The completion routes on both paths (`/claude-ai/conversations/:uuid/completion` and `/claude-ai/via-chrome/conversations/:uuid/completion`) previously hardcoded `attachments: []`, `files: []`, `sync_sources: []` in the body sent to claude.ai. Callers could not attach anything; the only workaround was to bypass lm-assist and call claude.ai directly with the cookie. These three fields are now pass-throughs from the request body.

**Text content goes via `attachments`, not `files`.** The two channels are not interchangeable:

- `attachments: [{file_name, file_type, file_size, extracted_content, origin:"user_upload", kind:"file"}]` — sent inline with the prompt. The assistant sees `extracted_content` in context immediately. This is the right channel for markdown, source code, transcripts.
- `files: ["<file_uuid>"]` — file_uuid strings from `POST /api/{org}/upload` on claude.ai. Files land in the sandbox at `/mnt/user-data/uploads/` as `file_kind:"blob"`. Text extraction from blob uploads is unreliable — the assistant often reports "the file came through empty" even when the bytes are on the server. Use this only for binaries.

A separate session attached a 169 KB transcript via `files: [uuid]` and saw the assistant report empty content; re-sending the same bytes via `attachments` with `extracted_content` inline worked immediately. The documentation in `docs/claude-ai-routes.md` now spells out the distinction.

**No upload route added in this change.** Getting a `file_uuid` still requires calling `POST /api/{org}/upload` on claude.ai directly (the lm-voice webapp does this for images; markdown/source doesn't need it). Adding an upload route to lm-assist is a separate piece of work.

**Body field naming.** Accepts both `syncSources` (camelCase, matches the existing `parentMessageUuid` style) and `sync_sources` (snake_case, matches the wire format). Forwards as `sync_sources`. `attachments` and `files` are the same name in both directions.

### Browser control surface — generic CDP + claude.ai cookie capture (2026-05-20)

Two coupled additions that turn lm-assist into a Chrome DevTools Protocol fallback for environments where claude-in-chrome MCP isn't loaded.

**`/browser/*` family — 24 generic browser-control endpoints.** Tabs CRUD, navigate, JS eval, cookies (read/write/delete), text/HTML inspection, click/type/hover/wait-for/find, storage (local/session), viewport, key dispatch, screenshots, plus page-script-injection taps for console messages and network requests. Targets any browser launched with `--remote-debugging-port` (default 9222). Mirrors most of claude-in-chrome MCP's surface so the same workflows can run without MCP.

**`/claude-ai/browser/*` family — 6 composite endpoints for cookie-file capture.** `launch-and-capture` (the headline) spawns Chrome with an isolated profile dir (`~/.claude/claudeai-browser-profile/`), injects a persistent in-page overlay explaining what the user must do and why, polls Chrome's cookie store until `sessionKey` appears, then writes both the per-profile session file (`~/.claude/claudeai-session.<profile>.json`) and the canonical `~/.claude/claudeai-session.json` so the existing cookie-file routes can pick it up without further setup. Stage-aware overlay messages ("Sign in with Google", "Approve OAuth", "Returning to claude.ai") drive the overlay text via per-target persistent CDP sessions, so hard navigations within the login flow (e.g. `/` → `/login` → `accounts.google.com` → `/new`) don't reset the status banner.

**Multi-browser detection + Firefox best-effort.** `GET /claude-ai/browser/installed` enumerates Chrome, Edge, Brave, Vivaldi, Chromium, Opera, and Firefox across Windows/macOS/Linux. `POST /claude-ai/browser/launch` accepts `{"browser": "<kind>"}` to pick which to launch. Firefox launches with `--remote-debugging-port` but uses WebDriver-BiDi internally; only a subset of CDP methods are honored — caller should treat Firefox as best-effort. Chromium-family browsers (Chrome/Edge/Brave/Vivaldi/Chromium/Opera) all share the full CDP feature set.

**Linux GUI autodetect.** When `headless` is false on Linux and lm-assist's process env has no `DISPLAY`, the launcher probes `/tmp/.X11-unix/X0` and auto-sets `DISPLAY=:0` so Chrome can render on the user's running X session. If no display is reachable at all, returns a structured error pointing the caller to `{"headless": true}`.

**Implementation notes worth flagging:**
- The overlay's status text is preserved across hard navigations by re-registering `Page.addScriptToEvaluateOnNewDocument` on every status update (a new registration carries the latest initial-render text). Without this, claude.ai's `/` → `/new` redirect resets the banner to "Waiting for sign-in" even after capture completes.
- `Storage.getCookies` is the browser-level cookie dump (works on Chrome 115+); `Network.getAllCookies` is the fallback for older Chromes. `Network.deleteCookies` is page-level only — the delete route routes through any open page target.
- The `CDPSession` primitive (one WebSocket, many commands) is required for `Page.addScriptToEvaluateOnNewDocument` — Chrome auto-removes the registration when the registering client disconnects, so the open-and-close `sendCDP` helper is unsafe for that command.

### `parseBody` reads DELETE bodies (2026-05-20)

`rest-server.ts#parseBody` previously returned `{}` for any DELETE request, dropping JSON bodies silently. RFC 7231 §4.3.5 allows DELETE bodies and the new `/browser/*` cookie/storage filtered-delete routes need them. No existing handlers read `req.body` on DELETE, so the change is additive.

### claude.ai conversation create + delete (2026-05-19)

The claude.ai surface could list/read conversations and write (completion, title) but had no way to **create** or **delete** a conversation. The generic via-chrome escape hatch (`POST /claude-ai/via-chrome` `{path}`) is GET-only — `buildViaChromeSnippet` hardcodes a GET fetch with no method/body — so it could not substitute. Both operations are now first-class across both families.

| Route | claude.ai path | Notes |
|---|---|---|
| **`POST /claude-ai/conversations`** | POST `…/chat_conversations` | **WRITE** — create empty conversation; body `{name?,uuid?}`; client-generated UUIDv4 (server echoes it); returns `{…conversation, uuid}`; HTTP 201 |
| **`DELETE /claude-ai/conversations/:uuid`** | DELETE `…/chat_conversations/{uuid}` | **WRITE (destructive)** — UUID validated host-side; HTTP 204 |
| **`POST /claude-ai/via-chrome/conversations/create`** | POST `…/chat_conversations` | snippet generates the UUID in-page and returns it; WRITE note in `instructions` |
| **`POST /claude-ai/via-chrome/conversations/:uuid/delete`** | DELETE `…/chat_conversations/{uuid}` | UUID validated host-side; destructive-WRITE note in `instructions` |

`createConversation()` / `deleteConversation()` model the existing `setConversationTitle` write (same header fingerprint, timeout, return shape). The via-chrome `create` route is registered **before** the `/conversations/:uuid` read route — the rest-server router is first-match-wins and the literal `create` would otherwise be captured as a `:uuid` (the old server returned `INVALID_REQUEST` for that path because the read route's UUID check rejected `"create"`).

**Verified end-to-end** against real claude.ai with the exact route-emitted snippets: create 201 → query 200 → delete 204 → readback 404, with a pre/post safety baseline (all 62 existing conversation UUIDs) confirming zero collateral change. Deployed live to `:3100`.

### Endpoint expansion — 28 new routes across Claude Code OAuth + claude.ai

A batched expansion of the catalog-backed endpoints. Each fingerprint was either captured live via `lm-proxy` (2026-05-10..14) or extracted from the leaked Claude Code source (`claude-code-2.1.88/source/src/`), so every new route ships with a verified header/auth/body shape rather than a guess.

**New Claude Code OAuth routes** (all `GET`, OAuth bearer with the appropriate `anthropic-beta`):

| Route | Anthropic path | Fingerprint source |
|---|---|---|
| `/claude-code/roles` | `/api/oauth/claude_cli/roles` | source: `services/oauth/client.ts` — Bearer **without** `anthropic-beta` |
| `/claude-code/account-settings` | `/api/oauth/account/settings` | live capture |
| `/claude-code/cli-bootstrap` | `/api/claude_cli/bootstrap?entrypoint=&model=` | live capture |
| `/claude-code/grove` | `/api/claude_code_grove` | live capture |
| `/claude-code/penguin` | `/api/claude_code_penguin_mode` | live capture |
| `/claude-code/policy-limits` | `/api/claude_code/policy_limits` | source: `services/policyLimits/index.ts` |
| `/claude-code/settings` | `/api/claude_code/settings` | source: `services/remoteManagedSettings/index.ts` |
| `/claude-code/user-settings` | `/api/claude_code/user_settings` | source: `services/settingsSync/index.ts` |
| `/claude-code/team-memory?repo=` | `/api/claude_code/team_memory` | source: `services/teamMemorySync/index.ts` (`?repo=owner/repo[&view=hashes]`) |
| `/claude-code/mcp-servers` | `/v1/mcp_servers` | live capture — uses `anthropic-beta: mcp-servers-2025-12-04` + `anthropic-version: 2023-06-01` |
| `/claude-code/mcp-registry` | `/mcp-registry/v0/servers` | live capture — **no auth** (public) |

`anthropicOAuthGet()` extended with `extraHeaders`, `query`, and `skipAuth` to support the per-endpoint header variations (alternative `anthropic-beta` values, the no-auth `mcp-registry` case, etc.).

**New claude.ai cookie-file + via-chrome routes** (all read-only `GET` except where noted):

| Route | claude.ai path | Notes |
|---|---|---|
| `/claude-ai/account-profile` | `/api/account_profile` | Standalone (was internal to healthz) |
| `/claude-ai/org` | `/api/organizations/{org}` | Org metadata |
| `/claude-ai/org/subscription` | `…/subscription_details?cached=true` | |
| `/claude-ai/org/usage` | `…/usage` | claude.ai-side usage (differs from `/claude-code/usage`) |
| `/claude-ai/org/skills` | `…/skills/list-skills` | |
| `/claude-ai/org/mcp-bootstrap` | `…/mcp/v2/bootstrap` | **SSE response** — helper drains stream, returns parsed events |
| `/claude-ai/org/styles` | `…/list_styles` | |
| `/claude-ai/org/model-config/:model` | `…/model_configs/{model}` | |
| `/claude-ai/org/memory-settings` | `…/memory/settings` | |
| `/claude-ai/org/cowork-settings` | `…/cowork_settings` | |
| `/claude-ai/org/sync-settings` | `…/sync/settings` | |
| `/claude-ai/org/sync/gdrive-progress` | `…/sync/ingestion/gdrive/progress` | |
| `/claude-ai/org/notifications` | `…/notification/preferences` | |
| `/claude-ai/account/invites` | `/api/accounts/{account}/invites` | |
| `/claude-ai/user-access` | `/api/bootstrap/{org}/current_user_access` | Per-user permissions/roles |
| `/claude-ai/sessions-active` | `/api/auth/sessions/list-active` | **Live sessions across devices** — useful security view |
| **`POST /claude-ai/conversations/:uuid/title`** | POST `…/title` | **WRITE** — rename/auto-title (omit body for auto-title) |

Each cookie-file route has a matching `POST /claude-ai/via-chrome/...` variant that returns the equivalent JS snippet for `mcp__claude-in-chrome__javascript_tool`. The via-chrome snippets reuse the existing `baseHeaders` block (full claude.ai fingerprint).

**Smoke-tested live** against the OAuth-authenticated account:
- 10/11 Claude Code routes → 200 (only `grove` returned 403, which is the server denying Grove access for this Max account — call shape verified correct)
- Each returns the expected data: roles (admin), account-settings (onboarding flags), cli-bootstrap (full org config), penguin (fast mode disabled), policy-limits (restrictions), settings, user-settings (with checksum), mcp-servers (Google Drive entry), mcp-registry (public, no auth)

### claude.ai web-session integration — health-check interface

Adds a uniform "is the integration ready?" surface so callers don't have to discover failure mode by failure mode. All claude.ai routes can now be preceded by a single health check that distinguishes config errors, expired sessions, Cloudflare blocks, and network problems.

**New routes:**

- `GET /claude-ai/healthz` — one-glance verdict. Combines file-based status with an active `/api/account_profile` probe. Returns `{ ok, reason, hint, sessionConfigured, identity, cookieFreshness, probe }`.
- `GET /claude-ai/session-status?probe=true` — opt-in active probe attached to the existing file-based status.
- `POST /claude-ai/via-chrome/health-check` — returns a snippet the agent runs in any tab. Verifies the active tab is `claude.ai`, identity cookies are present, and `/api/account_profile` returns 200. Returns `{ ok, reason, hint, pageUrl, identity, account? }`.

**Stable `reason` codes** the UI can branch on:

| Code | Both paths | Meaning |
|---|---|---|
| `ok` | ✓ | Ready to proceed |
| `session_not_configured` | cookie-file | No `~/.claude/claudeai-session.json` |
| `session_expired` | both | `sessionKey` invalid (401) |
| `cloudflare_blocked` | both | `cf_clearance`/`__cf_bm` expired or IP mismatch (403/503) |
| `network_error` | both | `fetch` threw |
| `upstream_error` | both | other 4xx/5xx |
| `wrong_tab` | via-chrome | active tab isn't `claude.ai` |
| `not_logged_in` | via-chrome | `lastActiveOrg` cookie absent |

**Better failure responses** on existing routes: distinguishes `CLAUDEAI_SESSION_NOT_CONFIGURED` (with a hint pointing at `/claude-ai/healthz`) from generic `CLAUDEAI_SESSION_UNAVAILABLE`. Live-tested against the Windows host (no config file) and the real claude.ai tab (returns `ok: true` with identity).

### claude.ai web-session integration — via-chrome header fingerprint hardening

Bare `fetch()` inside the claude.ai page bypasses claude.ai's own fetch interceptor — so the application-level headers its web app normally adds were missing from our via-chrome snippets. The browser was only filling transport-level headers (UA, `Accept-Encoding`, `sec-ch-ua-*`, `Sec-Fetch-*`, `Origin`, `Referer`, `Cookie`).

`buildViaChromeSnippet` and `snippetSendMessage` now emit a `baseHeaders` block at the top of every snippet and spread it into every `fetch()`:

| Header | Source | Value |
|---|---|---|
| `anthropic-client-platform` | pinned | `web_claude_ai` |
| `anthropic-client-version` | pinned | `1.0.0` |
| `anthropic-client-sha` | pinned (observed) | `8a753cbf88e19be0f5f67efefb1b07840b6402e9` |
| `anthropic-device-id` | from cookie `anthropic-device-id` | per-session UUID |
| `anthropic-anonymous-id` | from cookie `ajs_anonymous_id` | `claudeai.v1.<uuid>` |
| `x-activity-session-id` | from cookie `activitySessionId` | per-session UUID |

Identity values are extracted from non-HttpOnly cookies, so callers don't need to supply anything extra. `x-datadog-*` and `traceparent` remain intentionally omitted (random per-request, easier to skip than to forge wrongly).

Affected snippet generators: list/read/projects/memory/bootstrap/artifacts (via `buildViaChromeSnippet`) **and** `snippetSendMessage`'s two inner fetches (the read pre-flight and the actual `/completion` POST).

Live-tested through Chrome MCP:
- `GET /api/account_profile` with full `baseHeaders` → 200
- `POST /completion` with full `baseHeaders` → 200, 7 events, text `" HDR_OK"`

### claude.ai web-session integration — POST /completion (write op)

Both families now support sending messages:

- `POST /claude-ai/conversations/:uuid/completion` (cookie-file path) — Node `fetch` posts the message with `Accept: text/event-stream`, the helper drains the SSE stream and returns aggregated `{ status, text, events, eventTypes, humanMessageUuid, assistantMessageUuid }`. Auto-resolves `parent_message_uuid` from the conversation's `current_leaf_message_uuid`.
- `POST /claude-ai/via-chrome/conversations/:uuid/completion` (via-chrome path) — returns a JS snippet that does the read-conv + POST + stream-drain inside the page, returning the same aggregated result via `mcp__claude-in-chrome__javascript_tool`.

Request body shape mirrors a captured browser call: `prompt`, `timezone`, `personalized_styles`, `locale`, `model`, `tools`, fresh client-generated `turn_message_uuids` (UUIDv4), `attachments`/`files`/`sync_sources` empty, `rendering_mode: 'messages'`, `parent_message_uuid` from the conversation's leaf.

**Live-tested end-to-end** against the "Greeting" thread on 2026-05-14:
- `prompt: "Reply with exactly: PARSER_OK"` → `text: " PARSER_OK"`, 7 events drained
- Observed event types: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_limit`, `message_stop`
- The `message_limit` event carries `{ representativeClaim, windows: { '5h': {...}, '7d': {...} } }` — useful for surfacing rate-limit headroom

**Discoveries during the live test** (folded into the SSE parser):
1. claude.ai uses **CRLF separators** (`\r\n\r\n`), not bare `\n\n`. First attempt returned `eventCount: 0` despite a successful 200 because the parser only looked for LF. Parser now accepts both. Documented in `docs/claude-ai-routes.md`.
2. **`turn_message_uuids` is advisory.** The server assigns its own UUIDv7s (visible in `message_start.message.uuid`) and ignores the client UUIDv4s we sent. The client UUIDs are useful only as request-correlation handles. Doc updated.

`POST /completion` is the only **write** in the current surface — creates real message history and consumes tokens. The via-chrome snippet's `instructions` warns explicitly; the cookie-path handler validates `prompt` presence.

The other observed write endpoint (`POST .../title`) remains unimplemented.

### claude.ai web-session integration — via-chrome path + additional read endpoints

Adds a second route family `/claude-ai/via-chrome/*` that returns ready-to-paste JS snippets for `mcp__claude-in-chrome__javascript_tool`. Snippets run inside an authenticated `claude.ai` tab, so the browser auto-attaches every cookie (including HttpOnly `sessionKey` / `cf_clearance` / `__cf_bm` that page JS can't read). No cookie file, no refresh chore, real-Chrome TLS fingerprint. Full design notes in [`docs/claude-ai-routes.md`](./docs/claude-ai-routes.md).

New routes (cookie-file path):
- `GET /claude-ai/memory` — Claude's persistent memory for the org
- `GET /claude-ai/bootstrap` — `/edge-api/bootstrap/{org_uuid}/app_start`, the highest-leverage single call (≈500 KB: account, feature flags, recent conversations, system prompts, user access in one shot)
- `GET /claude-ai/artifacts/:uuid/versions` — artifact version history

New routes (via-chrome path):
- `POST /claude-ai/via-chrome` — generic snippet generator for any `/api/`, `/edge-api/`, `/v1/` path. Path whitelist blocks other prefixes.
- `POST /claude-ai/via-chrome/conversations`, `…/conversations/:uuid`, `…/projects` — mirrors of the cookie-file convenience routes
- `POST /claude-ai/via-chrome/memory`, `…/bootstrap`, `…/artifacts/:uuid/versions` — same for the new endpoints

End-to-end verified against a real Chrome tab via Chrome MCP:
- `via-chrome/conversations` (limit 3) → **200**, 3 conversations
- `via-chrome/conversations/36a5ab7b-…` → **200**, full transcript, 38 messages
- `via-chrome/bootstrap` → **200**, 516 KB JSON with 10 top-level keys (`account`, `org_statsig`, `org_growthbook`, `system_prompts`, `current_user_access`, etc.)

Bug fix during testing: the `bootstrap` path takes the **org_uuid** (`lastActiveOrg`), not the user uuid (`ajs_user_id`) — the user-uuid form returns 404. Initial snippet helper guessed wrong; corrected in both helpers (`getBootstrapAppStart`, `snippetBootstrapAppStart`).

New helper module: `core/src/utils/claudeai-via-chrome.ts` — `buildViaChromeSnippet`, `snippetListConversations`, `snippetReadConversation`, `snippetListProjects`, `snippetGetMemory`, `snippetBootstrapAppStart`, `snippetArtifactVersions`.

### claude.ai web-session integration

Four new routes that operate on claude.ai's web backend — the cookie-authenticated API behind `claude.ai/chat/...`. Endpoint inventory in [`lm-claude-endpoint:pages/claude-ai/`](https://github.com/langmartai/lm-claude-endpoint/tree/main/pages/claude-ai).

- **New: `GET /claude-ai/session-status`** — reports presence of `~/.claude/claudeai-session.json`, validates that the cookie string contains `sessionKey`, `cf_clearance`, `__cf_bm`, and surfaces the auto-derived identity (`org_uuid`, `anthropic-device-id`, `anonymous-id`, `activity-session-id`, `user_id`). No raw cookie values returned.
- **New: `GET /claude-ai/conversations`** — proxies `GET claude.ai/api/organizations/{org_uuid}/chat_conversations_v2`. Supports `?limit=`, `?starred=true|false`, `?consistency=eventual|strong`, `?project_uuid=`.
- **New: `GET /claude-ai/conversations/:uuid`** — proxies `GET claude.ai/api/organizations/{org_uuid}/chat_conversations/{conv_uuid}` with the same default query the web app sends (`tree=True`, `rendering_mode=messages`, `render_all_tools=true`). Returns the full message tree with `chat_messages[]` (`content` blocks: `text`, `tool_use`, `tool_result`, attachments).
- **New: `GET /claude-ai/projects`** — proxies `GET claude.ai/api/organizations/{org_uuid}/projects`.
- **New helper: `core/src/utils/claudeai-session.ts`** — `readClaudeAISession()`, `getClaudeAISessionStatus()`, `parseCookieString()`, `deriveIdentity()`, `claudeaiGet()`, plus per-endpoint wrappers (`listConversations`, `readConversation`, `listProjects`).

#### Configuration

User pastes their browser Cookie header once into `~/.claude/claudeai-session.json` (mode 0o600 enforced on write):

```json
{
  "cookie": "<paste full Cookie: header from a captured claude.ai request>",
  "userAgent": "Mozilla/5.0 ... (optional — defaults to observed Chrome 146 Linux)"
}
```

`orgUuid`, `anthropic-device-id`, `anonymous-id`, `activity-session-id`, `user_id` are auto-derived from the cookie itself (claude.ai stores them as cookies *and* sends them as headers). The user shouldn't need to maintain those separately.

Why config-file rather than auto-extract from Chrome / Claude Desktop:
- Browser cookie stores are encrypted per platform (DPAPI on Windows, libsecret on Linux, Keychain on macOS). Decryption is fragile and fights with the browser's own write locks.
- `cf_clearance` / `__cf_bm` rotate every ~30 min and are IP-bound — auto-extraction wouldn't keep them fresh anyway.

#### Wire-fingerprint hardening

`claudeaiGet()` sends the same header set captured from real claude.ai web traffic (lm-proxy capture, 2026-05-10..2026-05-14):

- `Host`, `Connection: keep-alive`
- `anthropic-anonymous-id`, `x-activity-session-id`, `anthropic-device-id` — derived from cookies
- `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform` — pinned to observed Chrome 146 Linux values (overridable)
- `anthropic-client-sha`, `anthropic-client-platform: web_claude_ai`, `anthropic-client-version: 1.0.0`
- `content-type: application/json`, `Accept: */*`
- `Sec-Fetch-{Site,Mode,Dest}: same-origin, cors, empty`
- `Referer` set per operation: `https://claude.ai/` for list, `https://claude.ai/chat/{conv_uuid}` for read, `https://claude.ai/new` for projects
- `Accept-Encoding: gzip, deflate, br` — note: real Chrome 146 sends `..., zstd` but Node's `fetch` can't decode zstd responses, so we drop it. Still matches older Chrome / Edge fingerprints.

Headers intentionally omitted: `x-datadog-{origin,trace-id,parent-id,sampling-priority}`, `traceparent`, `tracestate`. They're random per request and easier to forge wrongly than to skip. claude.ai accepts the request without them.

**Caveats** (documented in the helper):
- `cf_clearance` and `__cf_bm` are tied to the source IP and expire (~30 min for `__cf_bm`). When they expire, requests get 403 / interstitial — the user must refresh the cookie from a fresh browser request.
- Node's TLS fingerprint (JA3/JA4) differs from Chrome's. Cloudflare can detect this. Low-frequency reads on a fresh `cf_clearance` succeed; tight polling will trip detection regardless of header correctness.
- macOS Keychain note doesn't apply here — this is a config-file integration on all platforms.

#### Live test (2026-05-14, against yi@10.0.1.123's captured cookie)

| Call | Status | Result |
|---|---|---|
| `listConversations({ limit: 5 })` | 200 | 5 conversations: "Weekly trading insights summary", "Deepgram speech-to-text pricing", ... |
| `readConversation("36a5ab7b-…")` | 200 | `name: "Weekly trading insights summary"`, `model: claude-opus-4-7`, `chat_messages: 38` |
| `listProjects({ limit: 5 })` | 200 | 0 items (no projects shared with this account) |

### Claude Code OAuth integration

Three new routes that let any local caller — UI dashboard, CLI tool, scheduled job — read the same usage and profile data Claude Code itself reads, without re-implementing the OAuth dance.

- **New: `GET /claude-code/oauth-status`** — surfaces presence and expiry of Claude Code's OAuth credentials (`~/.claude/.credentials.json`) without exposing the tokens. Reports platform, storage backend, scopes, subscription type, rate limit tier, and ms-until-expiry.
- **New: `GET /claude-code/usage`** — proxies `GET https://api.anthropic.com/api/oauth/usage` using Claude Code's OAuth access token. Returns the `Utilization` payload (rate-limit windows: 5-hour, 7-day, 7-day-opus, 7-day-sonnet, plus `extra_usage`). Auto-refreshes the access token via `POST platform.claude.com/v1/oauth/token` when within 5 minutes of expiry and persists the new token atomically back to the credentials file.
- **New: `GET /claude-code/profile`** — proxies `GET https://api.anthropic.com/api/oauth/profile`. Returns account / organization / application info.
- **New helper: `core/src/utils/claude-oauth.ts`** — `readClaudeOAuth()`, `getValidAccessToken()` (refresh-when-needed), `anthropicOAuthGet(path)` (auth + single 401 retry), `getOAuthStatus()`, `detectClaudeCodeVersion()`, `getClaudeCodeUserAgent()`.
- **Limitation:** macOS is not yet supported — Claude Code stores credentials in the Keychain rather than the plain file used on Linux/Windows. `getOAuthStatus()` reports `storage: 'keychain'` and `present: false` on Darwin.

#### Wire-fingerprint hardening

`anthropicOAuthGet()` was originally sending the fetch defaults plus a `lm-assist/0.1` User-Agent. A review of real Claude Code traffic captured by `lm-proxy` (see [`lm-claude-endpoint:get-api-oauth-usage.md`](https://github.com/langmartai/lm-claude-endpoint/blob/main/pages/api-anthropic-com/get-api-oauth-usage.md)) showed three deviations from the real-client pattern; all are fixed:

| Header | Before | After |
|---|---|---|
| `User-Agent` | `lm-assist/0.1 (claude-code-oauth-proxy)` | `claude-code/<version>` from `detectClaudeCodeVersion()`, fallback `2.1.137` |
| `Accept-Encoding` | fetch default (`gzip, deflate, br`) | `gzip, compress, deflate, br` (axios pattern Claude Code inherits) |
| `Connection` | fetch default | `keep-alive` (explicit) |

Other Claude Code endpoints carry `anthropic-client-platform`, `anthropic-client-version`, `anthropic-version`, and `x-organization-uuid` headers, but `/api/oauth/usage` does **not**. We deliberately omit them — adding them here would itself be a deviation from the observed fingerprint.

`detectClaudeCodeVersion()` reads the installed `@anthropic-ai/claude-code` package by scanning common install locations (Windows: nvm4w `node_modules`, `%APPDATA%\npm`; Unix: `/usr/lib/node_modules`, `/usr/local/lib/node_modules`, `~/.local`). The result is memoized for the process lifetime.

`anthropicOAuthGet()` gains an optional `betaHeader: null` opt-out for endpoints (such as the initial post-login `/api/oauth/profile` fetch) that Claude Code calls without `anthropic-beta`.

#### Polling recommendation

Real Claude Code hits `/api/oauth/usage` only on the user's `/usage` command and from the `useRateLimitWarningNotification` hook — observed cadence in 5 days of captured traffic is roughly one call. Automated callers of this lm-assist route should cache responses and poll no faster than every ~5 minutes; a tight-loop watcher would be the loudest abnormal-traffic signal regardless of header correctness.

### Terminal API

- **refactor: `core/src/terminal-manager.ts` (536 LOC, monolithic) → `core/src/terminal/` (10+ modules, ~1940 LOC, layered)** — types / errors / validate / mutex / audit / tmux / inspector / registry / cc / spawn-tabs / manager. Each layer addresses a class of bugs from the post-merge review (22 bugs in the original). See `docs/terminal-refactor.md` for the full record.
- **fix: 22 bugs structurally prevented** — flag-merge in `ccLaunch`, pivot race against pre-pivot `❯`, target-body-bypass on send-keys, sshTarget shell injection on wt-ssh, gnome command injection, idempotency drift on `tmuxCreate`, empty wait-for pattern matching anything, `lines=0` returning full screen, no post-create cwd verification, no per-session mutex, no registry reconciliation, in-memory cache never reloaded, non-atomic registry write, `tmuxList` parser corrupted on `\t` in names, and others. Full list in `docs/terminal-refactor.md` §3.
- **fix: visible gnome tabs now tracked + closable** — three bugs in the `kind:'gnome'` path discovered during live UI testing: (a) `tabPid` was always null because `pgrep -x gnome-terminal-server` matches against `/proc/PID/comm` which Linux truncates to 15 chars; rewritten to read `/proc/*/cmdline` directly. (b) The `command` field did nothing because `bash -c '"$1"; exec bash'` quoted `$1` as a single executable name; switched to `bash -c 'eval "$1"; exec bash'` so shell operators work as users expect. (c) DELETE didn't close non-tmux gnome tabs because interactive bash ignores `SIGTERM`; now uses `SIGHUP` (simulates terminal hangup). Also adds `cwd` existence pre-check and explicit `SPAWN_FAILED` when no display env is available.
- **feat: window grouping + maximize for gnome tabs** — new `windowGroup` option (default `'lm-assist'`) makes all tabs share ONE maximized gnome-terminal window as native tabs instead of N floating windows. First tab spawns `gnome-terminal --window --maximize`; subsequent tabs locate it via `wmctrl -l` title-prefix and add a tab via `xdotool key ctrl+shift+t`. Per-tab cwd/command/title injected via a self-deleting `/tmp/lm-assist-tab-setup-XXX.sh` so only one short visible `source` line appears (then `clear` erases it). Requires `wmctrl` + `xdotool`; falls back to fresh window if either is missing.
- **New: typed error union** — `TerminalError` with 11 codes (`INVALID_INPUT`, `SESSION_NOT_FOUND`, `PRECONDITION_FAILED`, `POSTCONDITION_FAILED`, `TIMEOUT`, etc.) and per-code HTTP status mapping. Replaces the previous flat `TERMINAL_ERROR(string)`.
- **New: 5 endpoints for CC interactive control** — `POST /terminal/cc/:name/interrupt` (Ctrl-C), `/slash` (typed slash commands like `/clear`, `/agents`, `/usage`, `/model`, `/memory`, `/status`, `/config`, `/logout`), `/accept-dialog`, `/reject-dialog`, `/select-choice` (numbered menu picker). Plus `POST /terminal/tabs/prune-dead` to clean stale registry entries.
- **New: `GET /terminal/cc/:name/status` enriched** — returns `currentMode` (normal/plan/bash), `pendingDialog` (trust/permission/compact/choice), `authState` (authenticated/unauthenticated/unknown — read from `~/.claude.json` with screen fallback), `contextPct` (0–100 from footer), `authEmail`.
- **New: `wait-for` outcome enum** — `{ outcome: 'matched' \| 'timeout' \| 'session-gone' }` instead of just `{ matched: boolean }`. Callers can distinguish "still working" from "session crashed".
- **New: every mutation produces an audit log line** at `~/.cache/lm-assist/terminal-audit-{date}.jsonl` with op, session, outcome, elapsedMs, caller (from `X-LM-Caller` header).
- **New: 72-test integration + unit suite** under `core/src/__tests__/terminal/`. 38 integration tests (13 against live CC + 5 against live GUI gnome tabs, gated by `RUN_LIVE_CC=1` and gnome presence), 26 inspector unit tests, 3 wt-ssh static tests. Runs in ~10s without live CC, ~63s with. Wired via `npm test` and `npm run test:live`.

### Agent API

- **New: `POST /agent/session/:sessionId/resume`** — Resume an existing Claude Code session with a new prompt. Wraps `api.agent.resume()` so callers don't need to re-supply full session state.

### Cross-Platform

- **fix: detached-runner Windows support** — `spawnDetached()` now branches on platform. On Windows it resolves `claude.cmd` from the npm prefix, spawns with `shell: true` and explicit stdio fds (cmd.exe drops inherited fds when detached), and pipes the prompt through stdin instead of `-p <text>` (cmd.exe mangles large or special-char prompts). Unix path keeps the `setsid + nohup` double-fork unchanged.

## [0.1.64] - 2026-03-22

### Session List

- **New: Command session filter** — Toggle button ("Cmds") in the session sidebar filters to show/hide command-only sessions (slash command executions like `/trade-analyze`). Preference persists in localStorage.
- **fix: command-only sessions missing from list** — Sessions where all user prompts are slash commands were excluded from the session list. `isRealUserPrompt` now treats `command` prompt type as a real prompt.

## [0.1.63] - 2026-03-19

### Skill & Command Tracing

- **New: Skills dashboard page** (`/skills`) — Three-panel layout with skill inventory grouped by plugin, detail view with stats and session list, and analytics panel with top skills, chain patterns, and success rates.
- **New: Skills tab in session detail** — Vertical timeline showing all Skill tool invocations within a session, with chain flow visualization, span attribution (tools, files, subagents), and expandable detail view.
- **New: Commands tab in session detail** — Tracks slash command invocations (e.g., `/trade-analyze`) extracted from `<command-name>` XML tags in session messages.
- **New: Skill execution tracing** — Full causal chain per skill invocation: what instructions loaded, what tools Claude called, what files were touched, what subagents were spawned. Deep trace follows into subagent sessions recursively.
- **New: Cross-session skill index** — Persistent JSON index that builds lazily as sessions are loaded. Tracks invocation frequency, success rates, and common skill chain patterns (sliding window detection).
- **New: Installed skill inventory** — Scans `~/.claude/plugins/installed_plugins.json` to discover installed skills with full descriptions from SKILL.md frontmatter.
- **New: 8 REST API endpoints** — `/skills`, `/skills/analytics`, `/skills/analytics/chains`, `/skills/detail/:skillName`, `/sessions/:id/skills`, `/sessions/:id/skills/:index/trace`, `/skills/reindex`, `/skills/refresh-inventory`.

### Session Detail Enhancements

- **Skills tab shows invocation count badge** — `skillInvocationCount` flows through the full API stack.
- **Commands tab shows invocation count badge** — `commandInvocationCount` flows through the full API stack.
- **Skill detail session list** — Shows rich session metadata (model, cost, turns, users, agents, file size) matching the Sessions sidebar format, with last message preview.
- **Subagent expansion** — Session cards in skill detail show expandable subagent lists with type, description, cost, last message, and clickable links.
- **Selected skill persists** — Selected skill in the Skills page persists in localStorage across refreshes.

### Bug Fixes

- **fix: detect `<command-message>` prefix in classifyUserPrompt** — Slash command messages start with `<command-message>` not `<command-name>`; now detects both prefixes.
- **fix: subagent session lookup by agentId** — Skills/commands endpoints now match subagent sessions by agentId from filename, not just internal sessionId.
- **fix: background execute returns sessionId** — `/agent/execute` with `background: true` now polls up to 5s for sessionId before returning, instead of always returning null.
- **fix: LAN auth retry for new tabs** — Dashboard layout retries `/auth/is-local` check once with 3s timeout to handle race condition when Core API is slow to respond in new tabs.

## [0.1.62] - 2026-03-16

### Bug Fixes

- **fix: subagent conversations not visible in web session viewer** — Agent tool invocations returned empty `agentId` values because the parser relied on `agent_progress` messages that aren't always present. Now extracts agentId from the Agent tool_result text as a fallback.
- **fix: agent files with long first lines silently skipped** — `getAgentParentSessionId()` and `getAgentFirstLineData()` used fixed-size buffers (2KB/4KB) too small for agent files with large system prompts (4600+ bytes). Increased buffer to 16KB with regex fallback for truncated JSON.
- **fix: missing parentUuid on subagent invocations** — Invocations now capture the parent assistant message UUID, enabling position mapping in the web UI timeline.
- **fix: unify tool_result content handling** — The `parseSessionMessages()` tool_result handler only processed string content, making array-content subagent matching dead code. Now extracts text from both formats uniformly.

## [0.1.60] - 2026-03-13

- fix: console tab connecting to wrong session when another Claude instance runs in same project
- fix: fork session not working — auto-detection hijacked fork requests into existing tmux sessions

## [0.1.59] - 2026-03-11

### Knowledge Pipeline

- **Fix: Support Claude Code's `Agent` tool** — Claude Code renamed the subagent dispatch tool from `Task` to `Agent`. Session cache and agent session store now recognize both names, enabling subagent extraction from all recent sessions.
- **Fix: Accept `general-purpose` subagent type** — The explore-agent identifier and knowledge generator now accept both `explore` and `general-purpose` agent types, matching Claude Code's current subagent naming.
- **Fix: Knowledge stats count all active entries** — The `/knowledge/generate/stats` endpoint now counts all active knowledge entries (not just agent-sourced ones), so the UI title bar shows the correct total.
- **Fix: Mark duplicate candidates as skipped** — Duplicate generation errors now properly mark candidates as `skipped` instead of leaving them as perpetually `candidate`, preventing inflated pending counts.
- **Fix: Scheduler respects project exclusions** — Pending candidate counts now filter out excluded projects, so the scheduler status accurately reflects only active projects.

### Settings UI

- **New: "Run Now" button** — Trigger immediate knowledge discovery + generation from the Settings page instead of waiting for the 5-minute scheduler interval. Polls and updates status in real time.

### CLI

- **New: `lm-assist storage clean` command** — Clean the `~/.lm-assist` data directory with double confirmation (or `-y` flag to skip). Stops all running services before cleaning.

### API

- **New: `POST /knowledge/scheduler/run`** — Trigger immediate discovery + generation, bypassing interval timers.

## [0.1.58] - 2026-03-10

- feat: add session ID to statusline and expand session API docs
- feat: add excluded projects feature
- feat: add `lm-assist setup --key` CLI command for cloud connection
- fix: Windows SSH detached process killed on session close
- feat: knowledge scheduler, UI improvements, and bug fixes
