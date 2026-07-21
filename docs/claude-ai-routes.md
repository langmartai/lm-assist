# claude.ai integration — lm-assist routes

Two parallel families of routes let lm-assist operate on the claude.ai web backend (the API behind the in-browser chat sidebar and conversation view).

| Family | Auth source | Best for |
|---|---|---|
| **Cookie-file path** (`/claude-ai/...`) | `~/.claude/claudeai-session.json` | Headless callers — cron jobs, dashboards, background sync |
| **Via-Chrome path** (`/claude-ai/via-chrome/...`) | Real Chrome via MCP | Interactive callers driven by Claude Code with Chrome MCP loaded |

Both hit the same endpoints on the same backend and return the same JSON. They differ only in *how the request is dispatched*.

The endpoint inventory is documented in [`lm-claude-endpoint/pages/claude-ai/`](https://github.com/langmartai/lm-claude-endpoint/tree/main/pages/claude-ai). This file documents the lm-assist wrapper.

---

## Family 1 — cookie-file path

### Configuration

Create `~/.claude/claudeai-session.json` (mode `0o600` will be enforced on writes):

```json
{
  "cookie": "<paste the full Cookie: header from a captured claude.ai web request>",
  "userAgent": "Mozilla/5.0 ... (optional; defaults to observed Chrome 146 Linux)"
}
```

How to capture the cookie:
1. Open `https://claude.ai/` in your browser (logged in).
2. DevTools → Network → click any `/api/...` request.
3. Right-click → Copy → **Copy as cURL**.
4. From the cURL command, grab everything inside `-H 'Cookie: …'`.
5. Paste into the `cookie` field.

`orgUuid`, `anthropic-device-id`, `anonymous-id`, `activity-session-id`, and `user_uuid` are auto-derived — claude.ai stores them as cookies *and* sends them as headers, so the helper extracts them at request time.

### Routes

#### Diagnostics

| Method | Path | Description |
|---|---|---|
| `GET` | `/claude-ai/healthz` | **One-glance health check.** File-based status + active probe of `/api/account_profile`. Returns `{ ok, reason, hint, sessionConfigured, identity, cookieFreshness, probe }`. Call this before driving any other route. |
| `GET` | `/claude-ai/session-status[?probe=true]` | Presence/identity (no secret values). With `?probe=true`, also actively hits `/api/account_profile` to verify the session is live. |

#### Conversations & projects

| Method | Path | Description |
|---|---|---|
| `GET` | `/claude-ai/conversations?limit=&starred=&consistency=&project_uuid=` | List conversations (`chat_conversations_v2`). |
| `POST` | `/claude-ai/conversations` | **WRITE** — create a new empty conversation. Body: `{ name?, uuid? }` (UUID auto-generated if omitted). Returns `{ ...conversation, uuid }`. |
| `GET` | `/claude-ai/conversations/:uuid?tree=&rendering_mode=&render_all_tools=` | Read one conversation (full message tree). |
| `DELETE` | `/claude-ai/conversations/:uuid` | **WRITE (destructive)** — permanently delete one conversation. UUID validated. claude.ai responds 204. |
| `POST` | `/claude-ai/conversations/:uuid/completion` | **WRITE** — send a message, drain SSE, return `{ text, events, humanMessageUuid, assistantMessageUuid }`. Body: `{ prompt, model?, timezone?, locale?, parentMessageUuid?, tools?, enableConnectorTools?, autoApproveTools?, timeoutMs? }`. |
| `POST` | `/claude-ai/conversations/:uuid/completion/stream` | **WRITE** — streaming variant for embedded chat clients: same body, answers `text/event-stream` over the raw socket (see "Embedded browser chat clients" below). |
| `GET` | `/claude-ai/conversations/:uuid/messages` | Parsed transcript for chat UIs: `{ uuid, name, messages: [{ role, type, text, thinking?, toolCalls?: [{name, input, result, isError}] }] }` (core-side `parseChatMessages`). |
| `POST` | `/claude-ai/conversations/:uuid/title` | **WRITE** — rename / auto-title. Body: `{ title? }` (omit `title` → server auto-generates). |
| `GET` | `/claude-ai/projects?limit=&include_harmony_projects=&creator_filter=` | List projects. |
| `GET` | `/claude-ai/artifacts/:uuid/versions` | Artifact version history. |

#### Personal Agent Skills

CRUD for your claude.ai **personal Agent Skills**. Distinct from the org-scoped `GET /claude-ai/org/skills` read above — same `list-skills` upstream endpoint, but this is the full personal-skills CRUD family. Mutating routes are **WRITES** against your real account and invalidate the short-TTL skills-list cache. (See [Personal Agent Skills](#personal-agent-skills) below for semantics: `source`/`enabled`, versioned edits, the 30 MiB upload ceiling, and the download channels.)

| Method | Path | Description |
|---|---|---|
| `GET` | `/claude-ai/skills?refresh=true` | List personal skills (`list-skills`). Short-TTL in-memory cache; `?refresh=true` bypasses it. Each entry: `{ id, name, description, source, enabled, partition_by, user_invocable, … }`. |
| `GET` | `/claude-ai/skills/:id/files` | File paths inside a skill (`list-skill-files`). Returns paths for `source=custom`; built-in (`anthropic-example`) skills return `[]`. |
| `GET` | `/claude-ai/skills/:id/download[?format=base64]` | Download the `.skill` (zip) bundle (`download-dot-skill-file`). **Default streams `application/zip`**; `?format=base64` returns JSON `{ filename, contentType, size, base64 }` for JSON-only transports. |
| `POST` | `/claude-ai/skills` | **WRITE** — create a simple (single `SKILL.md`) skill. Body: `{ name, description?, instructions? }`. |
| `POST` | `/claude-ai/skills/upload` | **WRITE** — upload a skill bundle. Body: `{ filename, contentBase64, overwrite?, checkSkillName?, contentType? }`. Sent as multipart `file` (built server-side). Hard limit: zip `< 30 MiB` (31457280 bytes). Registered **before** `/skills/:id` so the literal `upload` isn't captured as an `:id`. |
| `POST` | `/claude-ai/skills/:id` | **WRITE** — edit a simple skill. Body: `{ description?, instructions? }`. **Versioned** — returns a NEW skill id each edit; `name` is not editable. |
| `POST` | `/claude-ai/skills/:id/enable` | **WRITE** — enable a skill (id preserved). |
| `POST` | `/claude-ai/skills/:id/disable` | **WRITE** — disable a skill (id preserved). |
| `DELETE` | `/claude-ai/skills/:id` | **WRITE (destructive)** — delete a (personal) skill. |
| `GET` | `/claude-ai/skills/:id/file?path=ENC[&format=base64]` | Read one file out of the bundle (synthesized — see [Per-file CRUD](#per-file-crud-synthesized) below). Default **streams the bytes** with a content-type detected from the extension; `?format=base64` → JSON `{ path, contentType, size, base64 }`. `path` is URL-encoded and resolved against the bundle's top-level folder. |
| `PUT` | `/claude-ai/skills/:id/file` | **WRITE** — add or replace one file (read-modify-write of the whole bundle). Body: `{ path, content? \| contentBase64? }` (`content` = utf-8 text; `contentBase64` = base64 bytes). Returns the **NEW skill id**. |
| `DELETE` | `/claude-ai/skills/:id/file?path=ENC` | **WRITE (destructive)** — remove one file (RMW). `404 SKILL_FILE_NOT_FOUND` if absent; refuses to delete `SKILL.md`. |
| `POST` | `/claude-ai/skills/:id/rename` | **WRITE** — rename in place. Body: `{ name }` (alias `newName`). Native (`rename-skill` → `{ skill_id, new_name }`). |
| `POST` | `/claude-ai/skills/:id/duplicate` | **WRITE** — duplicate the skill. Body: `{ name? }` (alias `newName`). Native (`duplicate-skill` → `{ skill_id, new_name }`). |
| `POST` | `/claude-ai/skills/:id/delete-org` | **WRITE (destructive)** — delete an **org-shared** skill (native `delete-org-skill` → `{ skill_id }`); distinct from the personal `DELETE /claude-ai/skills/:id`. |

#### Marketplaces & plugins

Manage the account's claude.ai **plugin marketplaces** (each a GitHub repo with a `.claude-plugin/marketplace.json` at its root) and the plugins within them. Mutating routes (`POST`/`PUT`/`DELETE`) are **WRITES** against your real account.

> **Route order (first-match-wins):** `/:id/plugins/:pid` and `/:id/plugins` are registered **before** the bare `DELETE /:id`, so the literal `plugins` segment is never captured as an `:id`.

> **Account vs. default marketplace:** plugins added via your own marketplaces are returned by `GET /claude-ai/marketplaces/:id/plugins` (upstream `…/plugins/account-list-plugins`). `GET /claude-ai/plugins` (upstream `plugins/list-plugins`) returns **only the default marketplace's** plugins.

| Method | Path | Description |
|---|---|---|
| `GET` | `/claude-ai/marketplaces[?scope=account\|default\|org]` | List registered marketplaces (default `account`). Maps to `marketplaces/list-{account,default,org}-marketplaces`. Each entry: `{ id, name, source, source_url, sync_status, last_synced_sha, is_default, … }`. |
| `POST` | `/claude-ai/marketplaces` | **WRITE** — register an account marketplace (`create-account-marketplace`). Body: `{ name, source_url, source?="github" }`. `source_url` accepts `"owner/repo"` or a full `github.com` URL (normalized to `https://github.com/owner/repo`). claude.ai git-clones the repo's **default branch** (async — poll the list for `sync_status="success"`) and requires `.claude-plugin/marketplace.json` at its root. `400 marketplace_already_default` for the default repo. |
| `GET` | `/claude-ai/marketplaces/:id/plugins[?limit=100]` | Plugins published by an **account** marketplace (`…/plugins/account-list-plugins`). Each entry: `{ id, name, enabled, skills, … }`. |
| `DELETE` | `/claude-ai/marketplaces/:id/plugins/:pid` | **WRITE** — remove a plugin from a marketplace (`marketplaces/{id}/plugins/{plugin_id}`). |
| `DELETE` | `/claude-ai/marketplaces/:id` | **WRITE** — remove an account marketplace (`{id}/account-delete`). The upstream `200` alone is unreliable — **verify by re-listing**. |
| `GET` | `/claude-ai/plugins[?enabled_only=true]` | DEFAULT-marketplace plugins (`plugins/list-plugins`). |
| `PUT` | `/claude-ai/plugins/:id/enabled` | **WRITE** — enable/disable a plugin (`plugins/{id}/enabled`). Body: `{ enabled: boolean }`. |

#### Account / identity

| Method | Path | Description |
|---|---|---|
| `GET` | `/claude-ai/account-profile` | Standalone account profile (mirrors the call `healthz` uses internally). |
| `GET` | `/claude-ai/account/invites` | Pending org invites. |
| `GET` | `/claude-ai/user-access` | Per-user permissions / roles for the active org. |
| `GET` | `/claude-ai/sessions-active?page=&per_page=&application_slug=` | **Live sessions across all devices** — useful "where am I signed in?" security view. |

#### Org configuration

| Method | Path | Description |
|---|---|---|
| `GET` | `/claude-ai/bootstrap` | `/edge-api/bootstrap/{org_uuid}/app_start` — high-leverage page-load endpoint (≈500 KB; account + flags + recent conversations in one call). |
| `GET` | `/claude-ai/org` | Org metadata. |
| `GET` | `/claude-ai/org/subscription[?cached=false]` | Subscription plan, billing cycle, status. |
| `GET` | `/claude-ai/org/usage` | claude.ai-side usage view (distinct from `/claude-code/usage`). |
| `GET` | `/claude-ai/org/skills` | Custom skills installed in the org. |
| `GET` | `/claude-ai/org/mcp-bootstrap` | Connected MCP servers + auth status. **Response is SSE** — helper buffers the stream and returns `{ events, eventCount, eventTypes }`. |
| `GET` | `/claude-ai/org/styles` | Chat styles (formal, concise, etc.). |
| `GET` | `/claude-ai/org/model-config/:model` | Per-model capabilities & beta flags (`:model` e.g. `claude-opus-4-7`). |
| `GET` | `/claude-ai/org/memory-settings` | Memory feature flags + retention. |
| `GET` | `/claude-ai/org/cowork-settings` | Team / cowork mode toggles. |
| `GET` | `/claude-ai/org/sync-settings` | Drive / external-source sync config. |
| `GET` | `/claude-ai/org/sync/gdrive-progress` | Google Drive ingestion status. |
| `GET` | `/claude-ai/org/notifications` | Email / push notification preferences. |
| `GET` | `/claude-ai/memory` | Claude's persistent memory entries for the org. |

### Header fingerprint

Matches a captured Chrome 146 Linux request (`lm-proxy` 2026-05-10..14):

- `Host`, `Connection: keep-alive`
- `anthropic-anonymous-id`, `x-activity-session-id`, `anthropic-device-id` — derived from cookies
- `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`
- `anthropic-client-sha`, `anthropic-client-platform: web_claude_ai`, `anthropic-client-version: 1.0.0`
- `content-type: application/json`, `Accept: */*`
- `Sec-Fetch-{Site,Mode,Dest}: same-origin, cors, empty`
- `Referer` scoped per operation (`https://claude.ai/`, `/chat/{uuid}`, `/new`)
- `Accept-Encoding: gzip, deflate, br` (zstd dropped — Node's `fetch` can't decode it)
- `Cookie:` — the configured value

Intentionally omitted: `x-datadog-*`, `traceparent`, `tracestate`. They're random per-request — easier to skip than to forge wrongly.

### Caveats

- **`cf_clearance` / `__cf_bm` expire** (`__cf_bm` ≈ 30 min; tied to source IP). When they expire, calls return 403 / interstitial. Refresh by re-capturing the cookie.
- **Node's TLS fingerprint** (JA3/JA4) differs from Chrome's. Cloudflare can detect this. Fine for low-frequency reads on fresh Cloudflare cookies; tight polling will trip detection.

---

## Family 2 — via-chrome path

The cookie-file path has a maintenance burden (manual cookie refresh, IP pinning, TLS-fingerprint mismatch). The via-chrome path avoids all of that by routing the request *through real Chrome*.

### How it works

```
+-----------------+        +------------------+        +------------------+
|  Claude Code    |        |   lm-assist      |        |   your Chrome    |
|  with Chrome    |        |   (this server)  |        | claude.ai tab    |
|  MCP loaded     |        |                  |        |                  |
+-----------------+        +------------------+        +------------------+
        |                          |                            |
        |  POST /claude-ai/        |                            |
        |    via-chrome/...        |                            |
        |  ----------------------> |                            |
        |                          |                            |
        |  <-- { snippet, ... } -- |                            |
        |                          |                            |
        |  mcp__claude-in-chrome__javascript_tool                |
        |  text: <snippet>         |                            |
        |  --------------------------------------------------> |
        |                                                       |
        |                                                  (browser auto-
        |                                                   attaches every
        |                                                   cookie incl.
        |                                                   HttpOnly ones)
        |                                                       |
        |                                                       v
        |                                                  claude.ai backend
        |                                                       |
        |                                                       v
        |                                                  200 + JSON
        |  <-- { status, body, ... } ------------------------- |
```

`lm-assist` returns a JS snippet. The agent passes it verbatim to `mcp__claude-in-chrome__javascript_tool`. The snippet runs in the page context (same-origin to `claude.ai/api/...`), the browser auto-attaches every cookie including HttpOnly ones (`sessionKey`, `cf_clearance`, `__cf_bm`), and the JSON response comes back through the MCP tool.

No cookie file. No refresh chore. TLS fingerprint is real Chrome. Cloudflare sees a legitimate browser request.

### Routes

All accept a JSON body. All return `{ success: true, data: { snippet, description, url, method, instructions } }`. Every cookie-file route has a matching via-chrome variant.

#### Diagnostics

| Method | Path | Body |
|---|---|---|
| `POST` | `/claude-ai/via-chrome/health-check` | `{}` — **Call this first.** Returns a snippet that verifies the active tab is `claude.ai`, identity cookies are present, and `/api/account_profile` returns 200. Snippet returns `{ ok, reason, hint, pageUrl, identity, account? }`. |

#### Generic

| Method | Path | Body |
|---|---|---|
| `POST` | `/claude-ai/via-chrome` | `{ path: "/api/...", query?: {...}, description? }` — generic; path must start with `/api/`, `/edge-api/`, or `/v1/` |

#### Conversations & projects

| Method | Path | Body |
|---|---|---|
| `POST` | `/claude-ai/via-chrome/conversations` | `{ limit?, starred?, consistency?, projectUuid? }` |
| `POST` | `/claude-ai/via-chrome/conversations/create` | `{ name? }` — **WRITE** snippet; creates an empty conversation and returns the new `uuid`. (Registered before `/:uuid` — the literal `create` is not a UUID.) |
| `POST` | `/claude-ai/via-chrome/conversations/:uuid/delete` | `{}` — **WRITE (destructive)** snippet; UUID validated host-side. |
| `POST` | `/claude-ai/via-chrome/conversations/:uuid` | `{ tree?, renderingMode?, renderAllTools? }` |
| `POST` | `/claude-ai/via-chrome/conversations/:uuid/completion` | `{ prompt, model?, timezone?, locale?, parentMessageUuid? }` — **WRITE** snippet that reads `current_leaf_message_uuid`, POSTs `/completion`, drains the SSE stream in-page, and returns `{ status, text, events, eventTypes, eventCount, humanMessageUuid, assistantMessageUuid }`. |
| `POST` | `/claude-ai/via-chrome/conversations/:uuid/title` | `{ title? }` — **WRITE** snippet (omit `title` for auto-title). |
| `POST` | `/claude-ai/via-chrome/projects` | `{ limit?, includeHarmonyProjects?, creatorFilter? }` |
| `POST` | `/claude-ai/via-chrome/artifacts/:uuid/versions` | `{}` |

#### Personal Agent Skills

Snippet mirrors of the cookie-file skills routes. Mutating snippets carry the WRITE warning in their `instructions`.

| Method | Path | Body |
|---|---|---|
| `POST` | `/claude-ai/via-chrome/skills` | `{}` — list personal skills |
| `POST` | `/claude-ai/via-chrome/skills/create` | `{ name, description?, instructions? }` — **WRITE** snippet |
| `POST` | `/claude-ai/via-chrome/skills/upload` | `{ filename, contentBase64, overwrite?, checkSkillName?, contentType? }` — **WRITE** snippet; decodes the base64 bundle in-page → multipart `file`. Zip `< 30 MiB`. Large bundles make a large snippet. |
| `POST` | `/claude-ai/via-chrome/skills/:id/files` | `{}` |
| `POST` | `/claude-ai/via-chrome/skills/:id/download` | `{}` — snippet returns the `.skill` (zip) as base64. **CRITICAL GOTCHA: Chrome MCP's content filter frequently blocks long base64 payloads, so the result may be dropped at the `javascript_tool` boundary — for binary downloads prefer the cookie-file `GET /claude-ai/skills/:id/download` (streams `application/zip`).** |
| `POST` | `/claude-ai/via-chrome/skills/:id/edit` | `{ description?, instructions? }` — **WRITE** snippet (versioned — returns a new id) |
| `POST` | `/claude-ai/via-chrome/skills/:id/enable` | `{}` — **WRITE** snippet |
| `POST` | `/claude-ai/via-chrome/skills/:id/disable` | `{}` — **WRITE** snippet |
| `POST` | `/claude-ai/via-chrome/skills/:id/delete` | `{}` — **WRITE (destructive)** snippet (personal `delete-skill`) |
| `POST` | `/claude-ai/via-chrome/skills/:id/file/read` | `{ path }` — snippet does an in-page download+unzip and returns the file as base64. **Same base64 gotcha — for reads prefer the cookie-file `GET /claude-ai/skills/:id/file`.** |
| `POST` | `/claude-ai/via-chrome/skills/:id/file/put` | `{ path, content? \| contentBase64? }` — **WRITE** snippet; whole-bundle read-modify-write **in-page** (download → unzip → set file → rezip → upload overwrite) using the browser-native `DecompressionStream`/`CompressionStream`. Returns the NEW skill id. |
| `POST` | `/claude-ai/via-chrome/skills/:id/file/delete` | `{ path }` — **WRITE (destructive)** snippet; in-page RMW. |
| `POST` | `/claude-ai/via-chrome/skills/:id/rename` | `{ name }` (alias `newName`) — **WRITE** snippet |
| `POST` | `/claude-ai/via-chrome/skills/:id/duplicate` | `{ name? }` (alias `newName`) — **WRITE** snippet |
| `POST` | `/claude-ai/via-chrome/skills/:id/delete-org` | `{}` — **WRITE (destructive)** snippet (org-shared `delete-org-skill`) |

#### Account / identity

| Method | Path | Body |
|---|---|---|
| `POST` | `/claude-ai/via-chrome/account-profile` | `{}` |
| `POST` | `/claude-ai/via-chrome/account/invites` | `{}` |
| `POST` | `/claude-ai/via-chrome/user-access` | `{}` |
| `POST` | `/claude-ai/via-chrome/sessions-active` | `{ page?, perPage?, applicationSlug? }` |

#### Org configuration

| Method | Path | Body |
|---|---|---|
| `POST` | `/claude-ai/via-chrome/bootstrap` | `{}` |
| `POST` | `/claude-ai/via-chrome/org` | `{}` |
| `POST` | `/claude-ai/via-chrome/org/subscription` | `{ cached? }` |
| `POST` | `/claude-ai/via-chrome/org/usage` | `{}` |
| `POST` | `/claude-ai/via-chrome/org/skills` | `{}` |
| `POST` | `/claude-ai/via-chrome/org/mcp-bootstrap` | `{}` — snippet handles SSE in-page and returns `{ events, eventCount, eventTypes }` |
| `POST` | `/claude-ai/via-chrome/org/styles` | `{}` |
| `POST` | `/claude-ai/via-chrome/org/model-config/:model` | `{}` |
| `POST` | `/claude-ai/via-chrome/org/memory-settings` | `{}` |
| `POST` | `/claude-ai/via-chrome/org/cowork-settings` | `{}` |
| `POST` | `/claude-ai/via-chrome/org/sync-settings` | `{}` |
| `POST` | `/claude-ai/via-chrome/org/sync/gdrive-progress` | `{}` |
| `POST` | `/claude-ai/via-chrome/org/notifications` | `{}` |
| `POST` | `/claude-ai/via-chrome/memory` | `{}` |

### Snippet shape

The returned snippet is a standalone async IIFE. Every snippet starts with a `baseHeaders` block that re-injects the application-level headers claude.ai's web app normally adds via a fetch interceptor:

```js
(async () => {
  // Parse cookies once so per-session identity values are available.
  const cookies = Object.fromEntries(document.cookie.split(';').map(p => {
    const i = p.indexOf('='); if (i < 0) return [p.trim(), ''];
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  // Same header set claude.ai's web app sends on every /api/* call.
  const baseHeaders = {
    'anthropic-client-platform': 'web_claude_ai',
    'anthropic-client-version': '1.0.0',
    'anthropic-client-sha':      '8a753cbf88e19be0f5f67efefb1b07840b6402e9',
  };
  if (cookies['anthropic-device-id']) baseHeaders['anthropic-device-id']     = cookies['anthropic-device-id'];
  if (cookies['ajs_anonymous_id'])    baseHeaders['anthropic-anonymous-id']  = cookies['ajs_anonymous_id'];
  if (cookies['activitySessionId'])   baseHeaders['x-activity-session-id']   = cookies['activitySessionId'];

  const orgMatch = document.cookie.match(/lastActiveOrg=(...)/i);
  const org = orgMatch ? orgMatch[1] : '';
  const url = "/api/organizations/{org}/...".replace('{org}', org);
  try {
    const r = await fetch(url, {
      credentials: 'include',
      headers: { ...baseHeaders, 'Accept': '*/*' },
    });
    const text = await r.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: r.status, statusText: r.statusText, url, body };
  } catch (e) {
    return { error: 'fetch_failed', message: String(e), url };
  }
})()
```

`mcp__claude-in-chrome__javascript_tool` returns the value of that IIFE — `{ status, statusText, url, body }` — directly.

### Via-chrome header fingerprint

Bare `fetch()` inside the page bypasses claude.ai's own fetch interceptor, so application-level headers must be re-injected explicitly. The browser still attaches transport-level headers (UA, `Accept-Encoding`, `sec-ch-ua-*`, `Sec-Fetch-*`, `Origin`, `Referer`, `Cookie`) for us — those we cannot forge and don't need to.

| Header | Source | Value |
|---|---|---|
| `anthropic-client-platform` | pinned | `web_claude_ai` |
| `anthropic-client-version` | pinned | `1.0.0` |
| `anthropic-client-sha` | pinned (observed 2026-05-14) | `8a753cbf88e19be0f5f67efefb1b07840b6402e9` |
| `anthropic-device-id` | cookie `anthropic-device-id` | per-session UUID |
| `anthropic-anonymous-id` | cookie `ajs_anonymous_id` | `claudeai.v1.<uuid>` |
| `x-activity-session-id` | cookie `activitySessionId` | per-session UUID |

`x-datadog-*` and `traceparent` are intentionally omitted — they're per-request random IDs that claude.ai's Datadog RUM SDK adds, not load-bearing for the API, and easier to skip than to forge incorrectly.

Verified end-to-end: `GET /api/account_profile` and `POST /completion` both return 200 with the full header set attached.

### Caller workflow

From a Claude Code session with Chrome MCP loaded:

```bash
# 1. Ask lm-assist for a snippet
SNIPPET=$(curl -s -X POST http://localhost:3100/claude-ai/via-chrome/bootstrap -d '{}' \
  | jq -r '.data.snippet')
```

Then in the agent loop:

```
mcp__claude-in-chrome__javascript_tool(
  action: "javascript_exec",
  tabId: <id of an open https://claude.ai/* tab>,
  text: <SNIPPET>
)
```

If no claude.ai tab is open, use `mcp__claude-in-chrome__tabs_create_mcp` + `mcp__claude-in-chrome__navigate` to open one first.

### Path whitelist

`POST /claude-ai/via-chrome` rejects any path not starting with `/api/`, `/edge-api/`, or `/v1/`. This prevents a confused caller from being tricked into pointing the snippet at `/etc/passwd`-style relative URLs or external origins.

### Verified end-to-end (2026-05-14)

| Snippet | HTTP status | Notes |
|---|---|---|
| `via-chrome/conversations` (limit 3) | 200 | 3 conversations: "Weekly trading insights summary", "Deepgram speech-to-text pricing", … |
| `via-chrome/conversations/36a5ab7b-…` | 200 | name, model, 38 chat_messages |
| `via-chrome/bootstrap` | 200 | 516 KB, 10 top-level keys: `account`, `org_statsig`, `org_growthbook`, `system_prompts`, `current_user_access`, … |
| `via-chrome` with `path: /etc/passwd` | rejected | `INVALID_REQUEST: path must start with /api/, /edge-api/ or /v1/` |
| `via-chrome/conversations/{uuid}/completion` (write) | 200 | prompt `"Reply with exactly: PARSER_OK"` → `text: " PARSER_OK"`, 7 SSE events drained |
| `via-chrome/account_profile` with full `baseHeaders` | 200 | All 6 `anthropic-*` headers attached on the wire |

### Verified end-to-end (2026-05-19) — create / query / delete

Full lifecycle of the new conversation create + delete routes, exercised with the exact route-emitted snippets against real claude.ai. Safety baseline of all pre-existing conversation UUIDs captured before and re-checked after.

| Snippet | HTTP status | Notes |
|---|---|---|
| `via-chrome/conversations/create` (write) | 201 | Server echoed the client-generated UUID; UUID confirmed absent from the 62-conversation baseline. |
| `via-chrome/conversations/{uuid}` (read-back) | 200 | New conversation queryable by UUID immediately after create. |
| `via-chrome/conversations/{uuid}/delete` (destructive write) | 204 | Targeted only the just-created UUID (two host-side guards: equals created UUID, not in baseline). |
| read-back after delete | 404 | Conversation gone; absent from re-listed conversations. |
| baseline integrity | — | After-count == baseline count (62); every pre-existing conversation still present. Net account change: zero. |

---

## Pre-flight: is the integration healthy?

Both families expose a structured health check that returns a stable `reason` code the calling UI/script can branch on.

### Cookie-file path: `GET /claude-ai/healthz`

```bash
curl -s http://localhost:3100/claude-ai/healthz
```

```json
{
  "success": true,
  "data": {
    "ok": false,
    "reason": "session_not_configured",
    "hint": "Create ~/.claude/claudeai-session.json with at minimum {\"cookie\": \"...\"}",
    "sessionConfigured": false,
    "sessionPath": "/home/yi/.claude/claudeai-session.json",
    "cookieFreshness": {},
    "probe": { "ok": false, "status": 0, "reason": "session_not_configured", "hint": "..." }
  }
}
```

Possible `reason` values:

| `reason` | What it means | What to do |
|---|---|---|
| `ok` | Probe of `/api/account_profile` returned 200 | Proceed |
| `session_not_configured` | No file at `~/.claude/claudeai-session.json` | Create the file |
| `session_expired` | Probe got `401` — `sessionKey` invalid | Re-capture Cookie header from a logged-in claude.ai tab |
| `cloudflare_blocked` | Probe got `403`/`503` | Refresh `cf_clearance`/`__cf_bm` (reload claude.ai in the browser on the same source IP) |
| `network_error` | `fetch` itself threw | Check network / DNS / proxy |
| `upstream_error` | Other 4xx/5xx | Inspect `probe.status` for the upstream code |

For the diagnostic without the active probe, use `GET /claude-ai/session-status` (file-only) or `?probe=true` (file + probe).

When any other claude.ai route fails because no session is configured, it returns `{ code: 'CLAUDEAI_SESSION_NOT_CONFIGURED', message, hint }` so the same diagnosis is reachable from the failure path too.

### Via-chrome path: `POST /claude-ai/via-chrome/health-check`

lm-assist can't reach Chrome MCP itself (MCP is only available to the agent driving the session). Instead, this route returns a snippet the agent runs through `mcp__claude-in-chrome__javascript_tool`. The snippet returns the same `reason` codes plus a couple specific to the browser side:

| `reason` | What it means | What to do |
|---|---|---|
| `ok` | Tab is on `claude.ai`, logged in, probe 200 | Proceed |
| `wrong_tab` | Active tab isn't `claude.ai` | Use `mcp__claude-in-chrome__navigate` to https://claude.ai/ first |
| `not_logged_in` | `lastActiveOrg` cookie absent | User must log in to claude.ai in this browser |
| `session_expired`, `cloudflare_blocked`, `network_error`, `upstream_error` | same semantics as above | Same remediation as cookie-file path |

The agent loop is:

```
1. POST /claude-ai/via-chrome/health-check → snippet
2. javascript_tool(snippet) → { ok, reason, hint, identity, account }
3. If ok === false: surface the hint and stop; do NOT drive other routes
4. If ok === true: proceed with read / write routes
```

## When to use which

- **Cron / dashboard / scheduled jobs** → cookie-file path. The trade-off is the cookie refresh chore.
- **Interactive `Claude Code` skills / one-off lookups** → via-chrome. Zero setup once the user has the browser logged in.
- **Mixing**: a UI dashboard can show "your session needs a refresh" by polling `GET /claude-ai/session-status` and falling back to via-chrome (or prompting the user to re-capture).

## Endpoints not yet wired

The previously-listed claude.ai reads (`memory/settings`, `cowork_settings`, `sync/settings`, `list_styles`, `model_configs/{model}`, `skills/list-skills`, `mcp/v2/bootstrap`, `subscription_details`, `usage`, `invites`, `account_profile`) and the `POST .../title` write have all been wired in [the 2026-05-15 batch](../CHANGELOG.md). The current remaining gaps:

| Observed in capture | Why not wired |
|---|---|
| `/api/organizations/{org}/marketplaces/list-default-marketplaces` | Low value (returns hardcoded marketplace list). Easy to wire via generic `/claude-ai/via-chrome` if needed. |
| `/api/organizations/{org}/{kyc_status,payment_method,prepaid/*,overage_credit_grant,paused_subscription_details,hipaa/status,shares}` | Billing / compliance reads — out of scope for a session-management tool. |
| `/api/organizations/discoverable`, `/api/organizations/{org}/{experiences/claude_web,pending_domain_claim,referral/*,overage_spend_limit}` | Web-app-only UI affordances; no programmatic value. |
| `/api/account/{domain_density,deletion-allowed}` | One-off account-state reads. |
| `/api/ws/voice/organizations/{org}/chat_conversations/{conv}` | **WebSocket** — needs a different streaming-aware design (separate ticket). |

Anything in the catalog can be hit through `POST /claude-ai/via-chrome` with `{ path }` matching `/api/`, `/edge-api/`, or `/v1/` — that's the escape hatch for one-offs without writing a dedicated route.

---

## Write op: `POST /completion`

Both families expose the completion endpoint. It is one of the **write** operations in the surface (alongside `title`, conversation `create`, and conversation `delete`) — it adds real message history to your claude.ai account and consumes tokens. Treat with the same care as any "send email" or "post message" API.

### Body shape

```json
{
  "prompt": "Hello!",            // required
  "model": "claude-opus-4-7",    // optional, defaults to opus-4-7
  "timezone": "UTC",             // optional
  "locale": "en-US",             // optional
  "parentMessageUuid": "...",    // optional — auto-resolved from
                                 //   current_leaf_message_uuid if omitted.
                                 //   For an empty thread, pass the canonical
                                 //   null UUID "00000000-0000-4000-8000-000000000000".
  "tools": [],                   // optional pass-through (cookie path only)
  "attachments": [...],          // optional — text-channel attachments (see below)
  "files": [...],                // optional — file_uuid strings (see below)
  "syncSources": [...]           // optional — sync_source uuids (URL ingestion)
}
```

**`attachments` (text channel) — RECOMMENDED for any text content.** Pass full attachment objects:

```json
{
  "file_name": "transcript.md",
  "file_type": "text/markdown",
  "file_size": 169531,
  "extracted_content": "...the actual file text...",
  "origin": "user_upload",
  "kind": "file"
}
```

`extracted_content` is sent inline and the assistant sees it in context immediately. This is the right channel for markdown, source code, transcripts, anything the model should read directly.

**`files` (file_uuid channel) — for binaries.** Pass an array of `file_uuid` strings returned by `POST /api/{org_uuid}/upload` on claude.ai (lm-assist does not currently expose that upload route — call claude.ai directly with the cookie, or use the lm-voice webapp upload to get the uuid). Files land in the assistant's sandbox at `/mnt/user-data/uploads/<file_name>` as `file_kind:"blob"`. **Text content via this channel is unreliable** — blob extraction often surfaces as "the file came through empty" to the assistant even when the bytes are on the server. Use `attachments` for text and reserve `files` for images / actual binary blobs.

**`syncSources`** — array of sync_source uuids (URL ingestion sources). Both `syncSources` (camelCase) and `sync_sources` (snake_case) are accepted in the request body and forwarded as `sync_sources` to claude.ai.

The full body the helper sends to claude.ai (built from the above) mirrors the captured browser request: `prompt`, `timezone`, `personalized_styles: [Normal]`, `locale`, `model`, `tools`, `turn_message_uuids: { human_message_uuid, assistant_message_uuid }`, `attachments`, `files`, `sync_sources`, `rendering_mode: 'messages'`, `parent_message_uuid`. The two `turn_message_uuids` are freshly generated UUIDv4s — the server uses them as the canonical IDs of the new turn.

### Response

The route consumes the entire SSE stream and returns an aggregated object:

```json
{
  "success": true,
  "data": {
    "status": 200,
    "text": " PARSER_OK",                   // concatenated assistant text deltas
    "humanMessageUuid": "...",              // client-generated UUIDv4
    "assistantMessageUuid": "...",          // client-generated UUIDv4
    "eventCount": 7,
    "eventTypes": [
      "message_start", "content_block_start", "content_block_delta",
      "content_block_stop", "message_delta", "message_limit", "message_stop"
    ]
  }
}
```

Pass `?events=full` to also receive the raw event list.

**Observed event types** (live test 2026-05-14):

| Event | Purpose |
|---|---|
| `message_start` | Carries the **server-assigned** `message.uuid` and `parent_uuid` (UUIDv7s, time-ordered) and the model name. |
| `content_block_start` | Opens a content block. |
| `content_block_delta` | Streamed text deltas — `{ delta: { text: "..." } }`. The `text` field in the response sums these. |
| `content_block_stop` | Closes a content block. |
| `message_delta` | Final delta with `stop_reason`, `stop_sequence`, output token usage. |
| `message_limit` | Carries `{ rateLimit: { representativeClaim, windows: { "5h": {...}, "7d": {...} } } }`. |
| `message_stop` | Terminal event. |

**SSE separator note.** claude.ai uses `\r\n\r\n` (CRLF), not the bare `\n\n` of some SSE implementations. The parser accepts both.

**`turn_message_uuids` is advisory.** The body field `turn_message_uuids: { human_message_uuid, assistant_message_uuid }` is sent with client-generated UUIDv4s, but the server assigns its own UUIDv7s (encoded in the `message_start` event and visible in the conversation history). Treat the client UUIDs as request-correlation handles, not authoritative IDs.

### Safety notes

- The conversation must already exist — the completion route itself does not create one. Use `POST /claude-ai/conversations` (cookie-file) or `POST /claude-ai/via-chrome/conversations/create` (via-chrome) first, then send a completion to the returned `uuid`. Clean up test conversations with `DELETE /claude-ai/conversations/:uuid` or `POST /claude-ai/via-chrome/conversations/:uuid/delete`.
- `parentMessageUuid` is auto-fetched from `chat_conversations/:uuid`. If the conversation is empty, the call errors with `no_leaf_message_uuid`.
- The via-chrome snippet warns explicitly in its `instructions` field: *"This snippet is a WRITE — it creates real message history in the user's claude.ai account and consumes tokens. Verify intent before running."*

---

## Embedded browser chat clients (scoped tokens + streaming) — added 2026-07-21

Support for pages that embed a chat UI and call this API **directly from the
browser** (first consumer: the lm-unified-trade chart-chat panel). Two pieces:

### Scoped, revocable tokens (`core/src/auth/scoped-token.ts`)

The full node api-token must never ship to a page. A **scoped token** is minted
by a full-token caller, sent in the same `x-api-key` header (CORS already
allows it), and validated as a fallback in the rest-server auth gate. Scope
`claude-ai-chat` allows exactly:

- `POST /claude-ai/conversations` (create)
- `POST /claude-ai/conversations/:uuid/completion` and `…/completion/stream`
- `GET  /claude-ai/conversations/:uuid/messages`

Everything else — listing conversations (privacy), delete, rename, via-chrome,
any non-claude-ai route, and the token-admin routes themselves — stays
full-token-only. Tokens persist (0600) in `<dataDir>/scoped-tokens.json`
(default TTL 24 h, max 7 d, cap 50 live).

Admin routes (full token required):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/scoped-tokens` | Mint. Body `{ scope: 'claude-ai-chat', ttlMs?, label? }` → `{ id, token, scope, expiresAt, … }` (secret returned once). |
| `GET` | `/auth/scoped-tokens` | List `{ id, scope, label, createdAt, expiresAt, lastUsedAt }` — never the secrets. |
| `DELETE` | `/auth/scoped-tokens/:id` | Revoke immediately. |

### Streaming completion (`POST /claude-ai/conversations/:uuid/completion/stream`)

Same body as the blocking route; answers `text/event-stream` (consume with a
fetch reader — EventSource cannot POST). Frames:

- every upstream claude.ai SSE event verbatim (`message_start`,
  `content_block_start/delta/stop`, `message_delta`, …) — render text deltas
  and tool_use starts live;
- synthetic auto-approve progress: `lm_approval_fired` `{toolUseId, toolName}`,
  `lm_approvals` (the resolved list), `lm_continuation_text` `{text}`
  (full-text snapshots while the post-tool continuation is polled);
- one final `lm_result` — the blocking route's compact shape
  (`{status, text, humanMessageUuid, assistantMessageUuid, eventCount, approvals}`);
- `lm_error` `{message}` on failure. `:hb` comment heartbeats every 15 s.

Client disconnect does **not** abort the upstream turn — it still lands in the
conversation; reconcile from `GET /:uuid/messages`.

Verified 2026-07-21 (deployed 117 core): scoped-token 401 matrix, streamed
turn with `enableConnectorTools:[ext__chart-context__*]` auto-approving and
executing against the live chart view-context, `lm_result` text correct.

---

## Personal Agent Skills

CRUD for your claude.ai **personal Agent Skills** — wraps `/api/organizations/{org}/skills/*`. Both families expose it (cookie-file `/claude-ai/skills/...` and via-chrome `/claude-ai/via-chrome/skills/...`). The reads are safe; **create / upload / edit / enable / disable / delete are WRITES** against your real account.

### Semantics

- **`source`** — `'custom'` (you authored it), `'anthropic-example'` (built-in template), or `'plugin'`. Built-ins are read-only: `list-skill-files` returns `[]` for them.
- **`enabled`** — whether the skill is active. Toggle with `enable` / `disable`; these **preserve the skill id**.
- **Versioned edits** — `POST /claude-ai/skills/:id` (edit-simple-skill) returns a **NEW skill id every time**; the old id is superseded. `name` is not editable (create a new skill to rename). Re-read the list after an edit to pick up the new id.
- **Simple vs uploaded skills** — `create-simple-skill` / `edit-simple-skill` manage a single `SKILL.md` (name + description + instructions). `upload-skill` takes a full bundle (multiple files, scripts, resources) as a zip.
- **Upload size** — the bundle (zip) must be **`< 30 MiB` (31457280 bytes)**. lm-assist rejects oversized bundles locally (`BUNDLE_TOO_LARGE`) before hitting claude.ai.
- **Writes invalidate the cache** — the `GET /claude-ai/skills` list is cached in-memory with a short TTL (default 60 s). Every write clears it; `?refresh=true` forces a fresh read.

### Download channels

`GET /claude-ai/skills/:id/download` returns the `.skill` bundle (a zip):

- **Default** — streams `application/zip` (binary). The hub relay base64-encodes it transparently by content-type, so it's relay-safe.
- **`?format=base64`** — returns JSON `{ filename, contentType, size, base64 }` for callers that can't accept a binary body.
- **via-chrome** — `POST /claude-ai/via-chrome/skills/:id/download` produces a snippet that returns the zip as base64. **CRITICAL GOTCHA:** Chrome MCP's content filter frequently blocks long base64 payloads, so the snippet's result may be dropped at the `javascript_tool` boundary. **For binary downloads prefer the cookie-file route** — it streams `application/zip` with no such limit.

### Per-file CRUD (synthesized)

claude.ai has **no native per-file write endpoint** — the confirmed skill set is `create-simple-skill`, `edit-simple-skill`, `rename-skill`, `duplicate-skill`, `upload-skill`, `download-dot-skill-file`, `list-skills`, `list-org-skills`, `delete-skill`, `delete-org-skill`, `enable-skill`, `disable-skill`, and `list-skill-files`. So lm-assist synthesizes single-file read / update / delete as a **read-modify-write (RMW) of the entire `.skill` bundle**:

```
download-dot-skill-file → unzip → add/replace/remove one entry → rezip → upload-skill?overwrite=true
```

The ZIP codec uses Node's built-in `zlib` (`inflateRaw`/`deflateRaw`) with a hand-parsed/-built central directory — claude.ai bundles are real DEFLATE-compressed zips, so a store-only reader can't open them. (The via-chrome mirror does the same RMW **in-page** with the browser-native `DecompressionStream`/`CompressionStream`.)

**Path resolution.** `path` is matched against the bundle entries: an exact match wins, otherwise it's qualified with the bundle's top-level folder. So for a `skill-creator/…` bundle you can pass either `scripts/foo.py` or `skill-creator/scripts/foo.py`. Absolute paths and `..` segments are rejected.

**Caveats — read these before chaining writes:**

- **Versioned / new id on every write.** Like `edit-simple-skill`, `upload-skill?overwrite` mints a **NEW skill id** each call and supersedes the old one. Every write route returns `newSkillId` — chain subsequent writes against *that*, not the original id.
- **Non-atomic + serialized.** RMW is download-then-upload (not atomic). Concurrent file writes to one skill are **serialized in-process** by a per-skill mutex so they can't clobber each other; cross-process/cross-host concurrency is still last-writer-wins.
- **Identity preserved.** The bundle's top-level folder and the `SKILL.md` frontmatter `name` are kept intact, and `check_skill_name` is sent as a server-side guard so `overwrite` replaces the **same** skill (never creating a duplicate). Writing `SKILL.md` itself pins the `name` back to the original (a per-file write never renames — use `/rename` for that).
- **Disabled state preserved.** `overwrite` re-enables a skill, so if it was disabled the RMW re-applies `disable-skill` afterwards (reported as `reDisabled: true`).
- **30 MiB ceiling.** The rebuilt bundle is rejected locally (`BUNDLE_TOO_LARGE` / error) if it reaches claude.ai's `< 31457280`-byte limit.
- **Cache.** Every write invalidates the short-TTL skills-list cache.
- **`SKILL.md` is protected** from `DELETE .../file` (deleting it would orphan the bundle) — delete the whole skill instead.
- **via-chrome file read** returns the file as **base64**, which Chrome MCP's content filter frequently blocks — prefer the cookie-file `GET /claude-ai/skills/:id/file` (it streams the bytes with a detected content-type).

### Native passthroughs (rename / duplicate / delete-org)

Three additional **native** claude.ai skill endpoints, with request bodies confirmed by reading the web SPA bundle (`index-<hash>.js`):

| Route | Upstream | Confirmed body |
|---|---|---|
| `POST /claude-ai/skills/:id/rename` | `skills/rename-skill` | `{ skill_id, new_name }` |
| `POST /claude-ai/skills/:id/duplicate` | `skills/duplicate-skill` | `{ skill_id, new_name }` (the SPA always sends `new_name`; lm-assist sends it only when a `name`/`newName` is provided) |
| `POST /claude-ai/skills/:id/delete-org` | `skills/delete-org-skill` | `{ skill_id }` (org-shared twin of the personal `delete-skill`) |

`rename` preserves the skill id; `duplicate` creates a **new** skill (its own id). All three are WRITES and invalidate the skills-list cache.

### Examples (cookie-file path)

```bash
# List personal skills (cached; ?refresh=true bypasses)
curl -s http://localhost:3100/claude-ai/skills | jq '.data.skills[] | {id, name, source, enabled}'

# Files inside a custom skill (built-ins return [])
curl -s http://localhost:3100/claude-ai/skills/<skill_id>/files | jq '.data.file_paths'

# Download the .skill bundle (streams application/zip)
curl -s http://localhost:3100/claude-ai/skills/<skill_id>/download -o skill.zip

# …or as base64 JSON
curl -s 'http://localhost:3100/claude-ai/skills/<skill_id>/download?format=base64' | jq -r '.data.base64' | base64 -d > skill.zip

# Create a simple skill (WRITE)
curl -s -X POST http://localhost:3100/claude-ai/skills \
  -H 'content-type: application/json' \
  -d '{"name":"my-skill","description":"What it does and when to use it","instructions":"Step-by-step instructions for Claude."}'

# Upload a skill bundle (WRITE) — base64-encode the zip first
curl -s -X POST http://localhost:3100/claude-ai/skills/upload \
  -H 'content-type: application/json' \
  -d "{\"filename\":\"my-skill.zip\",\"contentBase64\":\"$(base64 -w0 my-skill.zip)\",\"overwrite\":false}"

# Edit a simple skill (WRITE; returns a NEW id)
curl -s -X POST http://localhost:3100/claude-ai/skills/<skill_id> \
  -H 'content-type: application/json' \
  -d '{"description":"Updated description","instructions":"Updated instructions."}'

# Enable / disable (WRITE; id preserved)
curl -s -X POST http://localhost:3100/claude-ai/skills/<skill_id>/enable
curl -s -X POST http://localhost:3100/claude-ai/skills/<skill_id>/disable

# Delete (WRITE; destructive)
curl -s -X DELETE http://localhost:3100/claude-ai/skills/<skill_id>

# ── Per-file CRUD (synthesized read-modify-write) ──

# Read one file (streams bytes; ?format=base64 for JSON). path is URL-encoded.
curl -s 'http://localhost:3100/claude-ai/skills/<skill_id>/file?path=scripts%2Fhello.py' -o hello.py

# Add / replace a text file (WRITE; returns the NEW skill id in data.newSkillId)
curl -s -X PUT http://localhost:3100/claude-ai/skills/<skill_id>/file \
  -H 'content-type: application/json' \
  -d '{"path":"scripts/hello.py","content":"print(\"hi\")\n"}'

# Add / replace a binary file (base64)
curl -s -X PUT http://localhost:3100/claude-ai/skills/<skill_id>/file \
  -H 'content-type: application/json' \
  -d "{\"path\":\"assets/logo.png\",\"contentBase64\":\"$(base64 -w0 logo.png)\"}"

# Remove a file (WRITE; destructive) — use the latest id from the previous write
curl -s -X DELETE 'http://localhost:3100/claude-ai/skills/<skill_id>/file?path=scripts%2Fhello.py'

# ── Native passthroughs ──

# Rename in place (WRITE)
curl -s -X POST http://localhost:3100/claude-ai/skills/<skill_id>/rename \
  -H 'content-type: application/json' -d '{"name":"my-renamed-skill"}'

# Duplicate (WRITE; creates a new skill)
curl -s -X POST http://localhost:3100/claude-ai/skills/<skill_id>/duplicate \
  -H 'content-type: application/json' -d '{"name":"my-skill-copy"}'

# Delete an ORG-shared skill (WRITE; destructive) — distinct from the personal delete above
curl -s -X POST http://localhost:3100/claude-ai/skills/<skill_id>/delete-org
```

### Examples (via-chrome path)

Each returns a `{ snippet, … }`; pass `snippet` to `mcp__claude-in-chrome__javascript_tool` in an authenticated claude.ai tab (see the via-chrome workflow above).

```bash
# List skills
curl -s -X POST http://localhost:3100/claude-ai/via-chrome/skills -d '{}' | jq -r '.data.snippet'

# Create (WRITE)
curl -s -X POST http://localhost:3100/claude-ai/via-chrome/skills/create \
  -H 'content-type: application/json' \
  -d '{"name":"my-skill","description":"…","instructions":"…"}' | jq -r '.data.snippet'

# Enable / delete (WRITE)
curl -s -X POST http://localhost:3100/claude-ai/via-chrome/skills/<skill_id>/enable -d '{}' | jq -r '.data.snippet'
curl -s -X POST http://localhost:3100/claude-ai/via-chrome/skills/<skill_id>/delete -d '{}' | jq -r '.data.snippet'

# Per-file put (WRITE; in-page read-modify-write) and rename
curl -s -X POST http://localhost:3100/claude-ai/via-chrome/skills/<skill_id>/file/put \
  -H 'content-type: application/json' \
  -d '{"path":"scripts/hello.py","content":"print(\"hi\")\n"}' | jq -r '.data.snippet'
curl -s -X POST http://localhost:3100/claude-ai/via-chrome/skills/<skill_id>/rename \
  -H 'content-type: application/json' -d '{"name":"my-renamed-skill"}' | jq -r '.data.snippet'
```
