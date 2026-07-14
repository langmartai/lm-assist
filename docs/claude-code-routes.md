# Claude Code OAuth integration — lm-assist routes

Routes that proxy `api.anthropic.com` endpoints using Claude Code's OAuth token (the one Claude Code itself stores in `~/.claude/.credentials.json`). Outbound headers match the real `claude-code/<version>` fingerprint observed in `lm-proxy` captures, with the appropriate `anthropic-beta` value per endpoint.

Source of fingerprint truth for each route is either:
- **Live capture** — from `lm-proxy` audit log (`yi@192.0.2.23`, 2026-05-10..14)
- **Source** — the leaked Claude Code source (`claude-code-2.1.88/source/src/...`)

The endpoint inventory upstream of this wrapper lives in [`lm-claude-endpoint`](https://github.com/langmartai/lm-claude-endpoint).

## Configuration

No configuration needed beyond a working `claude /login` — lm-assist reads `~/.claude/.credentials.json` directly and refreshes the access token via `POST platform.claude.com/v1/oauth/token` when within the 5-minute expiry buffer. New tokens are atomically renamed back into the credentials file.

macOS is **not yet supported** (Claude Code uses Keychain there rather than the plain file used on Linux/Windows). `GET /claude-code/oauth-status` reports `storage: 'keychain'` and `present: false` on Darwin.

## Diagnostics

| Method | Path | Description |
|---|---|---|
| `GET` | `/claude-code/oauth-status` | Token presence + expiry. Reports `{ present, platform, storage, expired?, expiresAt?, msUntilExpiry?, scopes?, subscriptionType?, rateLimitTier? }`. No secret values returned. |

## Profile & usage

| Method | Path | Description |
|---|---|---|
| `GET` | `/claude-code/profile` | Account / org / application info. Mirrors `getOauthProfileFromOauthToken()`. |
| `GET` | `/claude-code/usage` | `Utilization` payload: rate-limit windows (5h, 7d, 7d-opus, 7d-sonnet, plus several undocumented fields) and `extra_usage` block. |
| `GET` | `/claude-code/roles` | Org + workspace role for the current OAuth user. **Bearer ONLY** — does NOT include `anthropic-beta` (verified in `services/oauth/client.ts:279`). |
| `GET` | `/claude-code/account-settings` | OAuth account settings (onboarding flags, dismissed banners). |

## CLI configuration & launch

| Method | Path | Description |
|---|---|---|
| `GET` | `/claude-code/cli-bootstrap?entrypoint=&model=` | Full CLI bootstrap config bundle — account, organization, model availability, oauth_account block. `entrypoint` examples: `sdk-cli`, `interactive`. `model` is the model id (e.g. `claude-haiku-4-5-20251001`). |
| `GET` | `/claude-code/grove` | Extended-thinking grove config. May return 403 if the account doesn't have Grove access — that's a server-side permission decision, not a fingerprint error. |
| `GET` | `/claude-code/penguin` | Fast-mode config. Returns `{ enabled, disabled_reason? }`. |
| `GET` | `/claude-code/policy-limits` | Org-level usage caps + compliance taints. Source: `services/policyLimits/index.ts`. |
| `GET` | `/claude-code/settings` | Remote-managed Claude Code settings (e.g. `cleanupPeriodDays`, env-flag overrides). Source: `services/remoteManagedSettings/index.ts`. |
| `GET` | `/claude-code/user-settings` | User state blob with checksum (per-feature UI state, persisted to backend for cross-device sync). Source: `services/settingsSync/index.ts`. |

## Team memory

| Method | Path | Description |
|---|---|---|
| `GET` | `/claude-code/team-memory?repo=owner/repo[&view=hashes]` | Team-scoped memory entries for a repo. `view=hashes` returns metadata + entry checksums only (no entry bodies). Source: `services/teamMemorySync/index.ts`. |

## MCP

| Method | Path | Description |
|---|---|---|
| `GET` | `/claude-code/mcp-servers?limit=` | Anthropic-managed MCP servers connected to this account (Google Drive, etc.). Uses `anthropic-beta: mcp-servers-2025-12-04` + `anthropic-version: 2023-06-01` (not the standard `oauth-2025-04-20`). |
| `GET` | `/claude-code/mcp-registry?limit=&version=&visibility=&cursor=` | Public MCP marketplace catalog. **No auth required** — public endpoint. |

## Routines / Triggers (CCR)

Full CRUD over the Claude Code **Routines** (a.k.a. *Triggers*) surface — the scheduled cloud agents that run on a cron and fire a CCR (Claude Code Remote) session. lm-assist proxies the upstream `/v1/code/triggers` family (plus `/v1/environment_providers`, needed to build create bodies) using the OAuth bearer + the `ccr-triggers-2026-01-30` fingerprint (see the exceptions table below). Helpers live in `core/src/utils/claude-oauth.ts` (`listRoutines`, `getRoutine`, `createRoutine`, `updateRoutine`, `runRoutine`, `deleteRoutine`, `listRoutineEnvironments`, `getClaudeCodeRoutineRunBudget`).

| Method | Path | Upstream | Description |
|---|---|---|---|
| `GET` | `/claude-code/routines` | `GET /v1/code/triggers` | List routines/triggers. Returns the raw upstream `{ data: [...], has_more }`. |
| `GET` | `/claude-code/routines/run-budget` | `GET /v1/code/routines/run-budget` | Organization's **routine RUN quota** for the rolling 24-hour window. Returns the raw upstream `{ limit, used, unified_billing_enabled }` (`limit`/`used` are **strings**) plus a clearly-derived integer `remaining` = `Number(limit) - Number(used)`. Plan tiers: Pro 5 / Max 15 / Team-Enterprise 25; overage billed via Extra Usage when `unified_billing_enabled`. |
| `GET` | `/claude-code/routines/:id` | `GET /v1/code/triggers/{id}` | Read a single routine/trigger by id (`trig_…`). |
| `POST` | `/claude-code/routines` | `POST /v1/code/triggers` | **[WRITE]** Create a routine/trigger. The JSON body is passed straight through to upstream (see contract below). |
| `POST` | `/claude-code/routines/:id/run` | `POST /v1/code/triggers/{id}/run` | **[WRITE]** Run now — fire the routine immediately (spawns a CCR cloud session). Body-less. |
| `POST` | `/claude-code/routines/:id` | `POST /v1/code/triggers/{id}` | **[WRITE]** Partial update of a routine/trigger. JSON body passed through. Registered **after** `/:id/run`. |
| `DELETE` | `/claude-code/routines/:id` | `DELETE /v1/code/triggers/{id}` | **[WRITE / destructive]** Delete a routine/trigger. Returns `{ deleted_session_count: "N" }`. |
| `GET` | `/claude-code/environments` | `GET /v1/environment_providers` | List routine **environments** for `job_config.ccr.environment_id` when building create bodies. |

> **Route ordering matters.** The static `GET /routines/run-budget` and `GET /routines` are registered **before** the `GET /routines/:id` catch-all, and `POST /routines/:id/run` is registered **before** `POST /routines/:id`. The dispatcher is first-match-wins per method (`rest-server.ts`), so a generic `:id` route placed first would otherwise swallow `run-budget`/`run`.

All routes return the standard lm-assist envelope: `{ success, data }` on a 2xx upstream; `{ success: false, error: { code: "UPSTREAM_<status>", message }, data: <upstream body> }` on a non-2xx upstream; and `{ success: false, error: { code: "OAUTH_UNAVAILABLE", message } }` when the OAuth token can't be obtained (no creds / refresh failure). `POST` create and update also return `{ success: false, error: { code: "INVALID_BODY", … } }` if the JSON body is missing or not an object.

### Validated upstream contract

Tested live against `api.anthropic.com` (2026-06-03):

- `GET /v1/code/triggers` → `{ data: [...], has_more }`
- `GET /v1/environment_providers` → `{ environments: [{ environment_id: "env_…", kind: "anthropic_cloud", state: "active" }] }`
- `POST /v1/code/triggers` body shape → `{ trigger: { id: "trig_…", next_run_at, mcp_connections, … } }` (`mcp_connections` are auto-attached upstream):
  ```jsonc
  {
    "name": "my-routine",
    "cron_expression": "0 9 * * *",   // UTC; minimum cadence ≥ 1 hour
    "enabled": true,
    "job_config": {
      "ccr": {
        "environment_id": "env_…",
        "session_context": {
          "model": "claude-sonnet-4-6",
          "sources": [{ "git_repository": { "url": "https://github.com/owner/repo" } }],
          "allowed_tools": ["Bash", "Read", "Edit"]
        },
        "events": [
          { "data": { "type": "user", "message": { "role": "user", "content": "do the thing" } } }
        ]
      }
    }
  }
  ```
- `POST /v1/code/triggers/{id}/run` → `200` (fires a CCR cloud session)
- `DELETE /v1/code/triggers/{id}` → `{ "deleted_session_count": "N" }`

### curl examples

```bash
BASE=http://localhost:3100        # prod; dev uses 3200

# List routines
curl -s "$BASE/claude-code/routines" | jq

# Read one
curl -s "$BASE/claude-code/routines/trig_abc123" | jq

# RUN quota for the rolling 24h window
curl -s "$BASE/claude-code/routines/run-budget" | jq

# Environments — pick an environment_id for the create body
curl -s "$BASE/claude-code/environments" | jq

# Create  [WRITE]
curl -s -X POST "$BASE/claude-code/routines" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "daily-standup",
    "cron_expression": "0 9 * * *",
    "enabled": true,
    "job_config": { "ccr": {
      "environment_id": "env_xxx",
      "session_context": {
        "model": "claude-sonnet-4-6",
        "sources": [{ "git_repository": { "url": "https://github.com/owner/repo" } }],
        "allowed_tools": ["Bash", "Read", "Edit"]
      },
      "events": [{ "data": { "type": "user", "message": { "role": "user", "content": "Summarize overnight CI failures." } } }]
    } }
  }' | jq

# Run now  [WRITE]
curl -s -X POST "$BASE/claude-code/routines/trig_abc123/run" | jq

# Update (partial — e.g. disable)  [WRITE]
curl -s -X POST "$BASE/claude-code/routines/trig_abc123" \
  -H 'Content-Type: application/json' \
  -d '{ "enabled": false }' | jq

# Delete  [WRITE / destructive]
curl -s -X DELETE "$BASE/claude-code/routines/trig_abc123" | jq
```

## Header fingerprint

Standard pattern (most endpoints):

```
Accept:           application/json, text/plain, */*
Accept-Encoding:  gzip, compress, deflate, br
Authorization:    Bearer sk-ant-oat01-...
Content-Type:     application/json
User-Agent:       claude-code/<detected-version>
Connection:       keep-alive
anthropic-beta:   oauth-2025-04-20
```

Exceptions:

| Endpoint | Deviation |
|---|---|
| `/claude-code/roles` | **No** `anthropic-beta` header (Bearer only) |
| `/claude-code/mcp-servers` | `anthropic-beta: mcp-servers-2025-12-04` + `anthropic-version: 2023-06-01` |
| `/claude-code/routines`, `/claude-code/routines/*`, `/claude-code/environments` | `anthropic-beta: ccr-triggers-2026-01-30` + `anthropic-version: 2023-06-01` + `x-organization-uuid: <org uuid>` (beta header **required** — the surface 404s without it). Covers the whole CCR triggers CRUD, `run-budget`, and `environments`. |
| `/claude-code/mcp-registry` | **No** `Authorization` header — public endpoint |

`anthropicOAuthGet()` in `core/src/utils/claude-oauth.ts` accepts `betaHeader: null` (drop the header), `betaHeader: '<value>'` (override), `extraHeaders: { ... }` (add more), and `skipAuth: true` (public endpoints) to compose these variants. It, along with `anthropicOAuthPost(path, body?, opts?)` and `anthropicOAuthDelete(path, opts?)`, are thin wrappers over a shared `anthropicOAuthRequest(method, path, opts)` core that owns the header fingerprint, optional JSON body, and the single-retry-on-401 (force-refresh) logic. Retrying a 401/403 after refresh is safe for the write paths too: an auth-rejected request never reached the upstream mutation.

## Smoke-test results (2026-05-15)

Live against an authenticated Claude Code OAuth (subscription: `max`):

| Route | HTTP | Result |
|---|---|---|
| `/claude-code/roles` | 200 | `organization_role: "admin"` |
| `/claude-code/account-settings` | 200 | onboarding flags + dismissed banners |
| `/claude-code/cli-bootstrap?entrypoint=sdk-cli&model=claude-haiku-4-5-20251001` | 200 | Full account + org config bundle |
| `/claude-code/grove` | 403 | Server denial (this account lacks Grove access — call shape verified correct) |
| `/claude-code/penguin` | 200 | `{ enabled: false, disabled_reason: 'extra_usage_disabled' }` |
| `/claude-code/policy-limits` | 200 | restrictions + compliance taints |
| `/claude-code/settings` | 200 | `{ cleanupPeriodDays: 30, env: {...} }` |
| `/claude-code/user-settings` | 200 | User state with sha256 checksum |
| `/claude-code/mcp-servers?limit=3` | 200 | Google Drive MCP server entry |
| `/claude-code/mcp-registry?limit=2` | 200 | Public endpoint, no-auth verified |
| `/claude-code/routines/run-budget` | 200 | `{ limit: "15", used: "0", unified_billing_enabled: true, remaining: 15 }` (verified 2026-06-03, `max`) |
| `/claude-code/routines` (list) | 200 | `{ data: [], has_more: false }` (verified 2026-06-03, `max`, org has 0 routines) |

## Refresh / token lifecycle

`anthropicOAuthGet()` and the routes it powers all use `getValidAccessToken()` under the hood, which:

1. Reads `~/.claude/.credentials.json`
2. If the access token has more than 5 minutes left → return it as-is
3. Else → `POST platform.claude.com/v1/oauth/token` with `grant_type: refresh_token`, parse the response, atomic-rename back to the credentials file
4. On 401/403 from the upstream → force-refresh once and retry (handles edge cases where the server invalidates a token before its expiry)

The same routine that Claude Code uses internally (`refreshOAuthToken()` in `services/oauth/client.ts`), so lm-assist coexists with a running Claude Code without fighting over the credentials file.

## Endpoints **not** wired

| Endpoint | Why not |
|---|---|
| `GET /v1/models`, `POST /v1/messages/count_tokens` | Not called by Claude Code itself (Anthropic API surface intended for SDK consumers). Would need a separate auth model. |
| `POST /v1/messages` | Direct Anthropic inference — different cost model, would charge against the OAuth account. Out of scope for the proxy. |
| `GET /api/oauth/organizations` (basic) | Only sub-routes (`/referral/eligibility`, etc.) captured. Uses a different `claude_code_sdk` fingerprint. Add if needed. |
| `PATCH /api/oauth/account/settings` | Update path — not currently exposed. Read is wired (`/claude-code/account-settings`). |
| `PUT /api/claude_code/{user_settings,team_memory}` | Write paths for the settings/memory endpoints. Read paths wired. |
| `POST /api/oauth/file_upload` | File management — separate design (multipart, content-type negotiation). |
| `/v1/code/sessions/*`, `/v1/sessions/ws`, `/v1/code/upstreamproxy/*` | CCR (Claude Code Remote) control plane — WebSocket-based; needs streaming design. |

Anything in the [catalog](https://github.com/langmartai/lm-claude-endpoint) can be added on demand; the pattern is uniform.

## See also

- [`docs/claude-ai-routes.md`](./claude-ai-routes.md) — the parallel claude.ai web-session integration (cookie-file + via-chrome paths). Different host, different auth, complementary use cases.
- [`lm-claude-endpoint`](https://github.com/langmartai/lm-claude-endpoint) — endpoint catalog independent of any wrapper. Use it to look up new endpoints, their captured headers, and source references.
