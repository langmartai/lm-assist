# Claude Code OAuth integration — lm-assist routes

Routes that proxy `api.anthropic.com` endpoints using Claude Code's OAuth token (the one Claude Code itself stores in `~/.claude/.credentials.json`). Outbound headers match the real `claude-code/<version>` fingerprint observed in `lm-proxy` captures, with the appropriate `anthropic-beta` value per endpoint.

Source of fingerprint truth for each route is either:
- **Live capture** — from `lm-proxy` audit log (`yi@10.0.1.123`, 2026-05-10..14)
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
| `/claude-code/mcp-registry` | **No** `Authorization` header — public endpoint |

`anthropicOAuthGet()` in `core/src/utils/claude-oauth.ts` accepts `betaHeader: null` (drop the header), `betaHeader: '<value>'` (override), `extraHeaders: { ... }` (add more), and `skipAuth: true` (public endpoints) to compose these variants.

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
