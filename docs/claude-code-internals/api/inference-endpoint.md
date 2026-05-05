# Inference Endpoint — Messages API

Source: `services/api/client.ts`, `services/api/claude.ts` (3419 lines)

## Endpoint

```
POST https://api.anthropic.com/v1/messages
```

Called via `anthropic.beta.messages.create({ ...params, stream: true })` from the Anthropic SDK.

## Authentication (Two Modes)

**OAuth subscribers (Max/Pro/Team/Enterprise):**
```
SDK config: { apiKey: null, authToken: oauthTokens.accessToken }
→ Authorization: Bearer sk-ant-oat01-...
```

**API key users:**
```
SDK config: { apiKey: "sk-ant-api03-..." }
→ x-api-key: sk-ant-api03-...
```

Both hit the same endpoint. The `anthropic-beta: oauth-2025-04-20` header tells the API to accept OAuth auth.

## Default Headers (set on SDK client)

```
x-app: cli
User-Agent: claude-code/2.1.88 ...
X-Claude-Code-Session-Id: {sessionId}
```

Conditional:
```
x-claude-remote-container-id: {id}       ← CLAUDE_CODE_CONTAINER_ID
x-claude-remote-session-id: {id}         ← CLAUDE_CODE_REMOTE_SESSION_ID
x-client-app: {app}                      ← CLAUDE_AGENT_SDK_CLIENT_APP
x-anthropic-additional-protection: true   ← CLAUDE_CODE_ADDITIONAL_PROTECTION
Authorization: Bearer {token}             ← ANTHROPIC_AUTH_TOKEN / apiKeyHelper
```

Custom from env: `ANTHROPIC_CUSTOM_HEADERS="Name: value\nOther: value2"`

Per-request: `x-client-request-id: {uuid}` (1P only, for timeout correlation)

## Request Body

```typescript
{
  model: "claude-sonnet-4-20250514",
  messages: [...],                    // with cache_control breakpoints
  system: [...],                      // array of text blocks with cache_control
  tools: [...],                       // tool definitions (may include defer_loading)
  tool_choice: ...,                   // optional
  betas: [...],                       // see beta-headers.md
  metadata: {
    user_id: JSON.stringify({
      device_id: "{persistent-uuid}",
      account_uuid: "{oauth-account-uuid}",
      session_id: "{session-uuid}",
      ...extraMetadata                // from CLAUDE_CODE_EXTRA_METADATA env
    })
  },
  max_tokens: 16384,
  thinking: {
    type: "adaptive"                  // or { type: "enabled", budget_tokens: N }
  },
  temperature: undefined,             // omitted when thinking enabled
  context_management: {               // when context-management beta active
    edits: [...]
  },
  output_config: {
    effort: "high",                   // effort beta
    task_budget: {...},               // task budgets beta
    format: {...},                    // structured outputs beta
  },
  speed: "fast",                      // fast mode
  anti_distillation: ["fake_tools"],  // 1P CLI only, feature-gated
  ...extraBodyParams                  // from CLAUDE_CODE_EXTRA_BODY env
}
```

## System Prompt Injection

The **first block** of the system prompt is the attribution header, injected as content:

```
x-anthropic-billing-header: cc_version=2.1.88.{fingerprint}; cc_entrypoint=cli; cch=00000; cc_workload=interactive;
```

- `cch=00000` — placeholder overwritten by Bun's native HTTP stack with attestation hash
- `cc_workload` — routing hint (interactive, cron, etc.)
- Parsed server-side, not an HTTP header

## Cache Breakpoints

Messages have `cache_control` injected at strategic positions:
```typescript
cache_control: {
  type: "ephemeral",
  ttl: "1h",        // eligible subscribers not on overage
  scope: "global"    // global cache strategy (cross-org sharing)
}
```

## Prompt Cache Sharing

The forked-agent path (compact, side queries) reuses the main conversation's prompt cache by inheriting the same system prompt + tool schemas. This is why `cacheSafeParams` is threaded everywhere — changing them would bust the cache.

## Timeout

Default: `600_000ms` (10 minutes), overridable via `API_TIMEOUT_MS` env.
