# Gemini Web integration — lm-assist via-Chrome JS bridge

`lm-assist` provides an in-browser JS bridge (`via-chrome`) for **Gemini Web (`https://gemini.google.com/`)**, mirroring the `/claude-ai/via-chrome/*` family in [`docs/claude-ai-routes.md`](./claude-ai-routes.md).

All endpoints return `{ success: true, data: { snippet, description, url, method, instructions } }` (or `{ success: false, error }`). Pass `snippet` verbatim to `mcp__claude-in-chrome__javascript_tool` (`action: "javascript_exec"`) or `POST /browser/tabs/:id/eval` inside an authenticated `https://gemini.google.com/*` Chrome tab.

---

## Protocol architecture

Gemini Web splits its API across multiple hosts (verified via `lm-proxy/docs/gemini-web-protocol.md`):

| Operation | Mechanism | Why |
|---|---|---|
| **Models, chat list, turns/history, rename, delete, usage/quotas, Gems, saved info, scheduled tasks, extensions, notebooks, profile** | Direct same-origin `fetch('/_/BardChatUi/data/batchexecute?...', { credentials: 'include' })` | Same origin as `gemini.google.com`; reads session tokens directly from `window.WIZ_global_data` (`SNlM0e` → `at`, `cfb2h` → `bl`, `FdrFJe` → `f.sid`, `eptZe` → path prefix, `QrtxK` → `authuser`, `oPEP7c` → signed-in email) and decodes `)]}'` chunked `wrb.fr` Boq envelopes. |
| **Chat generation (`send`)** | Drives the authenticated Gemini SPA prompt editor + Send button, then reads back the completed turn via `hNvQHb` | Chat streaming runs cross-origin on `geminiweb-pa.clients6.google.com/v1/processSession` (WebChannel v8 + Base64 Protobuf) and requires `SAPISIDHASH`, `X-Server-Token`, and a fresh Web App Attestation (`waa-pa.clients6.google.com`) token. Driving the page's own UI lets Chrome execute attestation natively. |

---

## Routes

### Diagnostics & discovery

| Method | Path | Body | Purpose |
|---|---|---|---|
| `POST` | `/gemini-web/via-chrome/health-check` | `{}` | **Call first.** Verifies tab host is `gemini.google.com`, `WIZ_global_data` tokens exist, and `otAQ7b` returns a signed-in policy. Returns `{ ok, reason, pageUrl, identity?, policyName?, modelCount?, hint }` using the shared reason vocabulary (`ok`, `wrong_tab`, `not_logged_in`, `session_expired`, `network_error`, `upstream_error`). |
| `POST` | `/gemini-web/via-chrome` | `{ rpcId, args?, sourcePath?, hl?, description?, write?, destructive? }` | Generic `batchexecute` RPC caller. `rpcId` must match `/^[A-Za-z0-9]{4,12}$/`. |
| `POST` | `/gemini-web/via-chrome/models` | `{}` | Lists available models (`id`, `name`, `description`, `capabilityIds`) and active `policyName` via `otAQ7b`. |
| `POST` | `/gemini-web/via-chrome/models/switch` | `{ model, thinkingLevel? }` | Switches active model (`Auto`, `4 Hydrogen`, `Neon`, `Carbon`, or model ID) and optional thinking level (`low`/`standard`/`medium`/`high` or `1`/`4`/`2`) via the Gemini mode picker. |
| `POST` | `/gemini-web/via-chrome/usage` | `{}` | Reads per-feature allowances/usage via `MyzX6c`. |
| `POST` | `/gemini-web/via-chrome/profile` | `{}` | Reads Google account profile (`photo`, `name`, `email`) via `o30O0e`. |
| `POST` | `/gemini-web/via-chrome/subscription` | `{}` | Reads subscription / upgrade banner state via `sJBwce`. |

### Conversations & turns

Conversation IDs accept either `c_<hex>` or bare `<hex>` (normalized to `c_<hex>`). Response IDs accept `r_<hex>` or `<hex>`.

| Method | Path | Body | Purpose |
|---|---|---|---|
| `POST` | `/gemini-web/via-chrome/tools/select` | `{ tool }` | **WRITE** — opens `Upload & tools` in the composer and selects a tool chip (`Create image` / `Create video` / `Create music` / `Canvas`, plus aliases `image`, `picture`, `video`, `movie`, `music`, `audio`). |
| `POST` | `/gemini-web/via-chrome/conversations` | `{ limit?, cursor? }` | Lists sidebar conversations (`MaZiqc`) with `{ id, bareId, title }` and `nextCursor`. |
| `POST` | `/gemini-web/via-chrome/conversations/create` | `{ prompt?, model?, thinkingLevel?, tool?, timeoutMs?, showOverlay? }` | Resets tab to a fresh new chat (and if `prompt` is given, optionally switches model, selects `tool`, submits prompt, extracts minted `conversationId`/`responseId` from URL or `BardVeMetadataKey`, waits for text or generated media, and reads back `turns` + `attachments`). |
| `POST` | `/gemini-web/via-chrome/conversations/:id` | `{ maxTurns? }` | Reads turns (`hNvQHb`) with parsed `{ conversationId, responseId, prompt, candidateId, text }[]` alongside raw `body`. |
| `POST` | `/gemini-web/via-chrome/conversations/:id/attachments` | `{ maxTurns? }` | Scans conversation turns (`hNvQHb`) for downloadable `contribution.usercontent.google.com` & `lh3.googleusercontent.com` attachment/media URLs. |
| `POST` | `/gemini-web/via-chrome/conversations/:id/rename` | `{ title }` (or `{ name }`) | **WRITE** — renames conversation via `MUAZcd`. |
| `POST` | `/gemini-web/via-chrome/conversations/:id/delete` | `{}` | **WRITE (DESTRUCTIVE)** — deletes conversation via `GzXR5e`. |
| `POST` | `/gemini-web/via-chrome/conversations/send` | `{ prompt, convId?, tool?, timeoutMs?, showOverlay? }` | **WRITE** — optionally selects `tool` and submits `prompt` in the Gemini SPA UI (if `convId` is given, asserts tab is on `/app/<bareId>` first), extracts `BardVeMetadataKey` IDs, waits for text or `domMedia` completion, and reads back turns + downloadable `attachments` via `hNvQHb`. |
| `POST` | `/gemini-web/via-chrome/conversations/:id/send` | `{ prompt, tool?, timeoutMs?, showOverlay? }` | **WRITE** — same as `/conversations/send`, scoped to `:id`. |
| `POST` | `/gemini-web/via-chrome/turns/:id` | `{}` | Reads response metadata via `PCck7e`. |

### Attachments (upload, `ProcessFile`, download)

| Method | Path | Body | Purpose |
|---|---|---|---|
| `POST` | `/gemini-web/via-chrome/attachments/upload` | `{ filename, contentBase64, mimeType? }` | **WRITE** — attaches base64 file bytes to the active Gemini composer via paste / drop / file input so Chrome runs Scotty upload (`push.clients6.google.com`) + `ProcessFile` natively. |
| `POST` | `/gemini-web/via-chrome/attachments/process-file` | `{ blobPath, filename, mimeType }` | Calls same-origin `BardFrontendService/ProcessFile` for a `/contrib_service/...` blob path and returns `processedFileUuid`. |
| `POST` | `/gemini-web/via-chrome/attachments/download` | `{ url }` | Fetches an allowlisted `contribution.usercontent.google.com`, `lh3.googleusercontent.com`, or `gemini.google.com` asset inside the tab and returns `{ contentType, filename, size, base64 }`. |

### Workspace & personalization RPCs

| Method | Path | Body | RPC ID |
|---|---|---|---|
| `POST` | `/gemini-web/via-chrome/gems` | `{}` | `Ub3MPb` (custom Gems) |
| `POST` | `/gemini-web/via-chrome/saved-info` | `{}` | `VVSn5c` (saved info / memory) |
| `POST` | `/gemini-web/via-chrome/scheduled-tasks` | `{}` | `I4z33b` (scheduled actions) |
| `POST` | `/gemini-web/via-chrome/extensions` | `{}` | `cCSu7` (extensions / integrations) |
| `POST` | `/gemini-web/via-chrome/notebooks` | `{}` | `xsWV3` (notebooks / library) |

### Browser helpers

| Method | Path | Body | Purpose |
|---|---|---|---|
| `POST` | `/gemini-web/browser/via-chrome/identify` | `{}` | Returns `{ snippet, profiles, note }` using `WIZ_global_data.oPEP7c` + `o30O0e` so callers can match the active tab's Google email against `listChromeProfiles()`. |
| `POST` | `/gemini-web/browser/install-idle-banner` | `{ port?, baseText?, noteText? }` | Installs the persistent `lm-assist-gemini-idle` banner over CDP (matching `gemini.google.com`, `*.google.com`, `accounts.google.com`, redirecting off-target tabs to `https://gemini.google.com/app`). |
| `POST` | `/gemini-web/browser/login` | `{ profile?, port?, headless?, browser? }` | Launches (or attaches to) a Chrome window on `port` (default `9225`) with a persistent `user-data-dir` at `~/.lm-assist/gemini-web/login-profile/<profile>`, installs the guided login banner, and checks sign-in status. |
| `GET` | `/gemini-web/browser/login/status` | `?port=9225` | Polls the login browser via `snippetHealthCheck()` + `snippetIdentify()`, flips the login banner green once authenticated, and returns `{ ok, port, loggedIn, email, policyName, modelCount, reason, pageUrl }`. |
| `GET` | `/gemini-web/browser/overview` | `?port=9225&limit=20` | Combined Web UI snapshot returning `{ status, models, conversations, usage }` from the live Gemini browser tab on `port`. |
| `POST` | `/gemini-web/browser/send` | `{ port?, convId?, createNew?, prompt, model?, thinkingLevel?, tool?, timeoutMs? }` | **WRITE** — Core-side trusted CDP send (`Page.bringToFront` + `Input.dispatchKeyEvent` `Enter`), bypassing untrusted synthetic DOM submit restrictions; ideal for plain turns as well as image (`Create image`) and video (`Create video`) generation, returning text, `domMedia`, `BardVeMetadataKey` IDs, `hNvQHb` turns, and downloadable `attachments`. |
| `POST` | `/gemini-web/browser/conversations/:id/delete` | `{ port? }` | **WRITE (DESTRUCTIVE)** — deletes a conversation inside the active Gemini Chrome tab via `GzXR5e`. |

---

## Web UI Dashboard (`/gemini`)

`lm-assist` includes a dedicated dashboard page at `:3848/gemini` (`web/src/app/(dashboard)/gemini/page.tsx`, linked from the **Gemini** sidebar item):
- **Gemini Web Browser & Guided Login:** Configure CDP port (default `9225`) and Chrome profile, launch/attach the guided login window (`POST /gemini-web/browser/login`), and inspect signed-in email/policy/model count (`GET /gemini-web/browser/overview`).
- **Prompt & Media Composer:** Choose model, thinking level, optional composer tool (`Create image`, `Create video`, `Create music`, `Canvas`), target `convId` or **New chat**, and send prompts via trusted CDP input (`POST /gemini-web/browser/send`).
- **Conversations & Gemini MCP:** List recent Gemini Web conversations with one-click **Reply here** and **Delete** (`POST /gemini-web/browser/conversations/:id/delete`), plus **Gemini CLI & Desktop App MCP** activate/deactivate controls (`both|stdio|hub`, profile).

---

## Guided Login Process

Because Windows Chrome isolates App-Bound cookies per `--user-data-dir` and restricts `--remote-debugging-port` on the default `User Data` directory, Gemini Web uses the same persistent-profile guided login pattern as `gmail/login.ts` and `claudeai-browser-launch.ts`:

1. Call `POST /gemini-web/browser/login` with `{ "profile": "xiaoqiang3020", "port": 9225 }` (defaults: `profile: "default"`, `port: 9225`, `headless: false`).
2. `lm-assist` launches a dedicated Chrome window at `~/.lm-assist/gemini-web/login-profile/<profile>` (leaving your normal Chrome untouched), navigates to `https://gemini.google.com/app`, and overlays the `lm-assist-gemini-login` guide banner (`lm-assist · sign in to Gemini Web`).
3. If the profile is signed out (which otherwise leaves Gemini on a signed-out prompt page instead of a login prompt), `geminiWebLogin` automatically redirects the tab to `https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp&passive=false`.
4. Sign in manually to your Google account in that window (`lm-assist` never reads or types passwords).
5. Poll `GET /gemini-web/browser/login/status?port=9225` until `loggedIn: true`. Future launches of the same `profile` reuse the saved Google session automatically.

---

## Typical caller loop

1. `POST /gemini-web/via-chrome/health-check` → execute `data.snippet` in the `https://gemini.google.com/app` tab. Confirm `{ ok: true, reason: "ok" }`.
2. `POST /gemini-web/via-chrome/conversations` → execute `data.snippet` to list chats.
3. `POST /gemini-web/via-chrome/conversations/send` (or navigate tab to `https://gemini.google.com/app/<bareId>` and call `.../conversations/:id/send`) → execute `data.snippet` to send a prompt and receive `{ ok, conversationId, responseId, text, turns }`.
