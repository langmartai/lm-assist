# OAuth & Credential Storage

Source: `services/oauth/client.ts`, `utils/auth.ts`, `utils/secureStorage/`, `constants/oauth.ts`

## Credential File

**Path**: `~/.claude/.credentials.json` (mode `0o600`)

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1775176974059,
    "scopes": [
      "user:inference",
      "user:profile",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload"
    ],
    "subscriptionType": "max",
    "rateLimitTier": "default_claude_max_20x"
  }
}
```

## Storage Backend Selection

| Platform | Backend | Details |
|----------|---------|---------|
| macOS | Keychain | `security` CLI, service name: `Claude Code{suffix}{dirHash}` |
| Linux | Plain text | `~/.claude/.credentials.json` (mode 0o600) |
| Windows | Plain text | Same file |

## OAuth Flow

1. **Authorize**: Browser redirect to `https://claude.com/cai/oauth/authorize` (claude.ai) or `https://platform.claude.com/oauth/authorize` (Console)
2. **PKCE**: S256 code challenge, state parameter
3. **Callback**: `http://localhost:{port}/callback` or manual redirect via `https://platform.claude.com/oauth/code/callback`
4. **Token exchange**: POST `https://platform.claude.com/v1/oauth/token`
5. **Profile fetch**: GET `https://api.anthropic.com/api/oauth/profile` (subscription type, billing, org info)
6. **Store**: Save tokens to secure storage + account info to global config

**Client ID**: `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (prod)

## Token Refresh

Automatic via `checkAndRefreshOAuthTokenIfNeeded()`:
- Checks `expiresAt` with 5-minute buffer
- POST `https://platform.claude.com/v1/oauth/token` with `grant_type: refresh_token`
- Scope expansion allowed (backend's `ALLOWED_SCOPE_EXPANSIONS`)
- On 401/403 revocation: `withOAuth401Retry()` force-refreshes once

## OAuth Scopes

```typescript
CLAUDE_AI_OAUTH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload'
]
CONSOLE_OAUTH_SCOPES = ['org:create_api_key', 'user:profile']
```

## Testing Usage Endpoint Directly

```bash
TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.claude/.credentials.json'))['claudeAiOauth']['accessToken'])")

# Usage/utilization
curl -s https://api.anthropic.com/api/oauth/usage \
  -H "Authorization: Bearer $TOKEN" \
  -H "anthropic-beta: oauth-2025-04-20" | python3 -m json.tool

# Profile
curl -s https://api.anthropic.com/api/oauth/profile \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" | python3 -m json.tool

# Roles
curl -s https://api.anthropic.com/api/oauth/claude_cli/roles \
  -H "Authorization: Bearer $TOKEN" \
  -H "anthropic-beta: oauth-2025-04-20" | python3 -m json.tool
```

Note: The `anthropic-beta: oauth-2025-04-20` header is **required** for usage and roles endpoints. Without it: "OAuth authentication is currently not supported."

## Global Config

Account info cached in `~/.claude/config.json`:
```json
{
  "oauthAccount": {
    "accountUuid": "...",
    "emailAddress": "...",
    "organizationUuid": "...",
    "displayName": "...",
    "billingType": "stripe_subscription",
    "accountCreatedAt": "...",
    "subscriptionCreatedAt": "...",
    "organizationRole": "admin",
    "workspaceRole": null
  }
}
```
