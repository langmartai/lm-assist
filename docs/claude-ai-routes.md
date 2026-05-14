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

| Method | Path | Description |
|---|---|---|
| `GET` | `/claude-ai/session-status` | Presence/identity (no secret values). Reports `hasSessionKey`, `hasCfClearance`, `hasCfBm` so callers can prompt for refresh. |
| `GET` | `/claude-ai/conversations?limit=&starred=&consistency=&project_uuid=` | List conversations. |
| `GET` | `/claude-ai/conversations/:uuid?tree=&rendering_mode=&render_all_tools=` | Read one conversation (full message tree). |
| `GET` | `/claude-ai/projects?limit=&include_harmony_projects=&creator_filter=` | List projects. |
| `GET` | `/claude-ai/memory` | Claude's persistent memory for the org. |
| `GET` | `/claude-ai/bootstrap` | `/edge-api/bootstrap/{org_uuid}/app_start` — high-leverage page-load endpoint (≈500 KB; account + flags + recent conversations in one call). |
| `GET` | `/claude-ai/artifacts/:uuid/versions` | Version history for an artifact (code/doc blocks Claude generated). |
| `POST` | `/claude-ai/conversations/:uuid/completion` | **WRITE** — send a new message to an existing conversation, drain the SSE stream, return aggregated `{ text, events, humanMessageUuid, assistantMessageUuid }`. |

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

All accept a JSON body. All return `{ success: true, data: { snippet, description, url, method, instructions } }`.

| Method | Path | Body |
|---|---|---|
| `POST` | `/claude-ai/via-chrome` | `{ path: "/api/...", query?: {...}, description? }` — generic; path must start with `/api/`, `/edge-api/`, or `/v1/` |
| `POST` | `/claude-ai/via-chrome/conversations` | `{ limit?, starred?, consistency?, projectUuid? }` |
| `POST` | `/claude-ai/via-chrome/conversations/:uuid` | `{ tree?, renderingMode?, renderAllTools? }` |
| `POST` | `/claude-ai/via-chrome/projects` | `{ limit?, includeHarmonyProjects?, creatorFilter? }` |
| `POST` | `/claude-ai/via-chrome/memory` | `{}` |
| `POST` | `/claude-ai/via-chrome/bootstrap` | `{}` |
| `POST` | `/claude-ai/via-chrome/artifacts/:uuid/versions` | `{}` |
| `POST` | `/claude-ai/via-chrome/conversations/:uuid/completion` | `{ prompt, model?, timezone?, locale?, parentMessageUuid? }` — **WRITE** snippet that reads `current_leaf_message_uuid`, POSTs `/completion`, drains the SSE stream in-page, and returns `{ status, text, events, eventTypes, eventCount, humanMessageUuid, assistantMessageUuid }`. |

### Snippet shape

The returned snippet is a standalone async IIFE:

```js
(async () => {
  const orgMatch = document.cookie.match(/lastActiveOrg=(...)/i);
  if (!orgMatch && true) {
    return { error: 'no_org', message: '...' };
  }
  const org = orgMatch ? orgMatch[1] : '';
  const url = "/api/organizations/{org}/...".replace('{org}', org);
  try {
    const r = await fetch(url, { credentials: 'include', headers: { 'Accept': '*/*' } });
    const text = await r.text();
    let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: r.status, statusText: r.statusText, url, body };
  } catch (e) {
    return { error: 'fetch_failed', message: String(e), url };
  }
})()
```

`mcp__claude-in-chrome__javascript_tool` will return the value of that IIFE — `{ status, statusText, url, body }` — directly.

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

---

## When to use which

- **Cron / dashboard / scheduled jobs** → cookie-file path. The trade-off is the cookie refresh chore.
- **Interactive `Claude Code` skills / one-off lookups** → via-chrome. Zero setup once the user has the browser logged in.
- **Mixing**: a UI dashboard can show "your session needs a refresh" by polling `GET /claude-ai/session-status` and falling back to via-chrome (or prompting the user to re-capture).

## Endpoints not yet wired

From the lm-proxy capture, these read endpoints work in the browser context but aren't wrapped by lm-assist yet. Add convenience routes as you need them, or call them via `POST /claude-ai/via-chrome` with the path verbatim:

- `/api/organizations/{org}/memory/settings`
- `/api/organizations/{org}/cowork_settings`
- `/api/organizations/{org}/sync/settings`, `/api/organizations/{org}/sync/ingestion/gdrive/progress`
- `/api/organizations/{org}/list_styles`, `/api/organizations/{org}/model_configs/{model}`
- `/api/organizations/{org}/skills/list-skills`, `/api/organizations/{org}/marketplaces/list-default-marketplaces`
- `/api/organizations/{org}/mcp/v2/bootstrap`
- `/api/organizations/{org}/subscription_details`, `/api/organizations/{org}/usage`
- `/api/accounts/{account_uuid}/invites`, `/api/account_profile`

Write endpoints observed but **not implemented**:

- `POST /api/organizations/{org}/chat_conversations/{conv}/title` — auto-title / rename

---

## Write op: `POST /completion`

Both families expose the completion endpoint. This is the only **write** in the current surface — it adds real message history to your claude.ai account and consumes tokens. Treat with the same care as any "send email" or "post message" API.

### Body shape

```json
{
  "prompt": "Hello!",            // required
  "model": "claude-opus-4-7",    // optional, defaults to opus-4-7
  "timezone": "UTC",             // optional
  "locale": "en-US",             // optional
  "parentMessageUuid": "...",    // optional — auto-resolved from
                                 //   current_leaf_message_uuid if omitted
  "tools": []                    // optional pass-through (cookie path only)
}
```

The full body the helper sends to claude.ai (built from the above) mirrors the captured browser request: `prompt`, `timezone`, `personalized_styles: [Normal]`, `locale`, `model`, `tools`, `turn_message_uuids: { human_message_uuid, assistant_message_uuid }`, `attachments: []`, `files: []`, `sync_sources: []`, `rendering_mode: 'messages'`, `parent_message_uuid`. The two `turn_message_uuids` are freshly generated UUIDv4s — the server uses them as the canonical IDs of the new turn.

### Response

The route consumes the entire SSE stream and returns an aggregated object:

```json
{
  "success": true,
  "data": {
    "status": 200,
    "text": "...",                       // concatenated assistant text deltas
    "humanMessageUuid": "...",
    "assistantMessageUuid": "...",
    "eventCount": 42,
    "eventTypes": ["completion","message_start","content_block_delta", ...]
  }
}
```

Pass `?events=full` to also receive the raw event list.

### Safety notes

- The conversation must already exist. The route does not create new conversations.
- `parentMessageUuid` is auto-fetched from `chat_conversations/:uuid`. If the conversation is empty, the call errors with `no_leaf_message_uuid`.
- The via-chrome snippet warns explicitly in its `instructions` field: *"This snippet is a WRITE — it creates real message history in the user's claude.ai account and consumes tokens. Verify intent before running."*
