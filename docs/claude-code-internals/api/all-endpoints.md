# Complete API Endpoint Map

Base URL: `https://api.anthropic.com` (from `getOauthConfig().BASE_API_URL`)

## Auth Header Modes

**OAuth (Max/Pro/Team/Enterprise):**
```
Authorization: Bearer {accessToken}
anthropic-beta: oauth-2025-04-20      ← REQUIRED for all OAuth API calls
```

**API Key:**
```
x-api-key: {anthropic_api_key}
```

Both: `User-Agent: claude-code/{version}`

---

## 1. Messages API (Core Inference)

| Method | Endpoint | Source |
|--------|----------|--------|
| POST | `/v1/messages` | `services/api/claude.ts` via Anthropic SDK |

## 2. OAuth Endpoints

| Method | Endpoint | Headers | Purpose |
|--------|----------|---------|---------|
| POST | `/v1/oauth/token` | Content-Type | Token exchange & refresh |
| GET | `/api/oauth/profile` | Bearer | Account + org profile |
| GET | `/api/oauth/usage` | Bearer + beta | Usage/utilization |
| GET | `/api/oauth/claude_cli/roles` | Bearer | Org/workspace roles |
| POST | `/api/oauth/claude_cli/create_api_key` | Bearer | Create API key |
| GET | `/api/claude_cli_profile` | x-api-key + beta | Profile via API key |

## 3. Account & Settings

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/oauth/account/settings` | Grove/privacy settings |
| PATCH | `/api/oauth/account/settings` | Update settings |
| POST | `/api/oauth/account/grove_notice_viewed` | Mark notice viewed |
| GET | `/api/claude_code_grove` | Grove notice config |
| GET | `/api/claude_code/settings` | Remote managed settings |
| GET | `/api/claude_code/user_settings` | Settings sync (+ `anthropic-beta: oauth-2025-04-20`) |
| GET | `/api/claude_code/policy_limits` | Policy-based limits |
| GET | `/api/claude_code_penguin_mode` | Fast mode config |
| GET | `/api/organization/claude_code_first_token_date` | First usage date |
| GET | `/api/claude_code/organizations/metrics_enabled` | Metrics opt-out |
| GET | `/api/claude_cli/bootstrap` | Bootstrap config |

## 4. Organization Endpoints

All require `x-organization-uuid` header.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/oauth/organizations/{org}/admin_requests` | Create admin request |
| GET | `/api/oauth/organizations/{org}/admin_requests/me` | My admin requests |
| GET | `/api/oauth/organizations/{org}/admin_requests/eligibility` | Check eligibility |
| GET | `/api/oauth/organizations/{org}/referral/eligibility` | Referral eligibility |
| GET | `/api/oauth/organizations/{org}/referral/redemptions` | Referral redemptions |
| GET | `/api/oauth/organizations/{org}/overage_credit_grant` | Overage credit grant |
| GET | `/api/oauth/organizations/{org}/code/repos/{owner}/{repo}` | Repo access check |
| GET | `/api/oauth/organizations/{org}/sync/github/auth` | GitHub sync auth |

## 5. CCR (Remote Sessions)

All require `anthropic-beta: ccr-byoc-2025-07-29` + `x-organization-uuid`.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/v1/sessions` | Create remote session |
| GET | `/v1/sessions/{id}` | Get session |
| PATCH | `/v1/sessions/{id}` | Update session |
| POST | `/v1/sessions/{id}/archive` | Archive session |
| GET | `/v1/sessions/{id}/events` | Session events (SSE) |
| PUT | `/v1/session_ingress/session/{id}` | Transcript ingress (`anthropic-version: 2023-06-01`) |
| GET | `/v1/code/sessions/{id}/teleport-events` | Teleport events |
| POST | `/v1/code/github/import-token` | Import GitHub token |
| POST | `/v1/environment_providers/cloud/create` | Create cloud env |
| GET | `/v1/environment_providers` | List env providers |
| GET | `/v1/ultrareview/quota` | Ultrareview quota |

## 6. Files API

Requires `anthropic-beta: files-api-2025-04-14,oauth-2025-04-20` + `anthropic-version: 2023-06-01`.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/v1/files/{fileId}/content` | Download file |
| POST | `/v1/files` | Upload file |
| GET | `/v1/files` | List files |

## 7. Other

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/claude_code/team_memory/sync` | Team memory sync (`anthropic-beta: oauth-2025-04-20`) |
| POST | `/api/claude_code/events` | Analytics/telemetry |
| GET | `/mcp-registry/v0/servers?version=latest&visibility=commercial` | MCP server registry |
| WSS | `wss://api.anthropic.com/v1/audio/speech` | Voice STT (`anthropic-version: 2023-06-01`) |

## OAuth Flow URLs (browser redirects)

| URL | Purpose |
|-----|---------|
| `https://claude.com/cai/oauth/authorize` | Claude.ai login |
| `https://platform.claude.com/oauth/authorize` | Console login |
| `https://platform.claude.com/v1/oauth/token` | Token exchange |
| `https://platform.claude.com/oauth/code/callback` | Manual redirect |
| Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | Prod client |
