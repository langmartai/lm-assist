# lm-assist MCP connector for claude.ai

Status: design + phase-1 plan
Author: yi.huang@databunny.sg
Created: 2026-05-27
Scope of phase 1: **dev hub only (xeenhub.com)**. Production (langmart.ai) is touched in a follow-up after dev confirms.

## Goal

Expose lm-assist's read surface to claude.ai web / Claude Desktop / Claude Code as a registered remote MCP connector. Make the same tool implementations reachable two ways:

1. **stdio** — Claude Code CLI (already shipping, 3 tools).
2. **HTTPS** — claude.ai backend pulls tools server-side from a public URL. Routes through the langmart hub's web-proxy WebSocket relay to the user's worker, so individual lm-assist instances do not need their own public endpoints.

Identity is federated through the langmart hub account. The hub is the OAuth authorization server. Tokens carry `langmart user_id` and the hub routes calls to that user's connected worker.

## Non-goals for phase 1

- No agent execution, no writes, no terminal drive. Read-only tools only.
- No production hub changes (langmart.ai untouched). All work runs against dev hub on `xeenhub.com`.
- No npm publish until end-to-end works on dev.
- No single-operator OAuth path. Federated via hub only.

## Architecture

```
claude.ai backend
   │ HTTPS (Anthropic egress 160.79.106.37/39)
   ▼
mcp.xeenhub.com
   │ Cloudflare-proxied → NPM at 10.0.1.114 → :8081 hub on 192.0.2.17
   ▼
gateway-type1 hub (192.0.2.17:8081)
   ├─ /.well-known/oauth-protected-resource/mcp     ─┐
   ├─ /.well-known/oauth-authorization-server       │ public
   ├─ /oauth/authorize  (langmart consent UI)        │ OAuth
   ├─ /oauth/token                                   │ surface
   ├─ /oauth/register   (RFC 7591 DCR)              ─┘
   │
   └─ /mcp  ─┐
             │ Bearer → langmart user_id → worker lookup
             ▼
   web-proxy WS api_relay  (new "mcp" service slot)
             │
             ▼
   worker / user's host
             │ inbound from hub on existing api_relay channel
             ▼
   lm-assist :3100 /mcp   (new HTTP MCP endpoint, no local auth)
             │
             ▼
   shared tool handlers (7 tools)
             │
       ┌─────┴─────┐
       ▼           ▼
   stdio        HTTP/SSE
   (Claude     (claude.ai
    Code)       backend)
```

## Five components

### 1. Tool handlers refactor — `lm-assist/core/src/mcp-server/`

Existing tools (`search.ts`, `detail.ts`, `feedback.ts`) already return the canonical MCP shape `{ content: [{type, text}], isError? }`. They directly call in-process stores.

Add four new read tools:

| Tool | Backing | Notes |
|---|---|---|
| `list_sessions` | `getSessionCache().getAllSessionsFromCache()` + filter | Recent Claude Code sessions for the user's projects |
| `read_session` | `getSessionCache().getSessionData(id)` + redact | Read a single session's transcript (configurable detail level) |
| `list_conversations` | reuse `claude-ai.routes.ts` helper that calls `/api/organizations/{org}/chat_conversations_v2` | Recent claude.ai conversations |
| `read_conversation` | reuse claude.ai cookie-path conversation read | One conversation's message tree |

Layout:
- `tools/definitions.ts` — append 4 new tool defs.
- `tools/list-sessions.ts`, `tools/read-session.ts`, `tools/list-conversations.ts`, `tools/read-conversation.ts` — new handlers.
- `tools/index.ts` — barrel re-export so both transports import from one place. The handlers stay pure (no transport coupling).

### 2. HTTP MCP transport — `lm-assist/core/src/routes/core/mcp.routes.ts` (NEW)

Mount `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` at `/mcp` on the existing :3100 server. Reuse the same `Server` instance pattern from `core/src/mcp-server/index.ts`, just swap the transport.

```ts
// pseudo
const server = new Server({ name: 'lm-assist', version: pkg.version }, { capabilities: { tools: {} } });
registerAllTools(server);   // calls setRequestHandler for list + call, drives same handlers as stdio

router.all('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ /* stateless */ });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

The HTTP endpoint has **no authentication of its own**. The hub validates Bearer + routes by user_id. Worker assumes any request that reaches `/mcp` is authorized. This is the same trust model the existing `/w/:workerId/admin/*` web-proxy uses.

Reference implementation already on linux-117 at `/home/ubuntu/mcp-claude-test/server.js` (the one from the lm-voice doc). Mirror its structure for protocol version `2025-11-25`.

### 3. OAuth authorization server — `LangMartDesign/gateway-type1/lib/routes/oauth-mcp.ts` (NEW)

**Revised 2026-05-27 to reuse langmart's existing API key + auth infrastructure** instead of building a parallel token store. Earlier draft added three new tables (clients/codes/tokens); the revised design adds zero schema and one `system_properties` row.

Implement these endpoints in the hub. All are public (no Bearer required to reach them).

| Route | Spec | Purpose |
|---|---|---|
| `GET /.well-known/oauth-protected-resource/mcp` | RFC 9728 | `{resource, authorization_servers:["https://mcp.xeenhub.com"]}` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | Metadata pointing to the four endpoints below |
| `GET /oauth/authorize` | OAuth 2.0 + PKCE S256 | Consent UI. If user not logged in to langmart → redirect to hub's existing login (`/v1/auth/authorize` then back). After consent, 302 to `https://claude.ai/api/mcp/auth_callback?code=...&state=...` |
| `POST /oauth/token` | RFC 6749 + RFC 8707 | Exchange code for Bearer. Validate PKCE verifier. **Issue a new row in `api_keys`** (no separate token table) with `metadata={kind:'mcp_oauth', mcp_client_id, resource_url, refresh_token_hash, refresh_expires_at}`. Refresh token rotation per OAuth 2.1. |
| `POST /oauth/register` | RFC 7591 | Dynamic client registration. Append to the `mcp_oauth_clients` JSON in `system_properties`. Return `{client_id, client_secret}`. |

Auth method: `client_secret_post`. Token format: opaque `sk-langmart-...` (the existing API key prefix). The Bearer that claude.ai eventually sends is a regular langmart API key — the existing `authenticate` middleware on `/api/*` and `/mcp` validates it without any new code path.

State storage:
- **Tokens** — `api_keys` table (reused). User sees / revokes them in the existing Settings → API Keys page.
- **Registered MCP clients** — single row in `system_properties` (key `mcp_oauth_clients`, JSON array). For phase 1 with a few clients (claude.ai, Toolbox, Claude Desktop, custom DCR) this is enough; promote to a table only if registration volume grows.
- **One-time auth codes** — in-memory Map with TTL ~10 min. Survives the request flight between `/oauth/authorize` and `/oauth/token`; gateway-type1 restart kicks in-flight Connect flows back to the consent page, which is fine.

Reuse:
- `gateway-type1/lib/middleware/auth.ts::authenticate` — already runs on `/api/*` and `/v1/*`. Mount `/mcp` under it; the middleware populates `req.user` from the Bearer automatically.
- langmart's web login (consent step redirect) — no new login UI needed.
- `api_keys` issuance / rotation / revocation — all existing.

### 4. Hub MCP web-proxy slot — `LangMartDesign/gateway-type1/lib/routes/web-proxy.ts` + `tier-agent-core/src/hub-client/api-relay-handler.ts`

Add `mcp` to the worker service routing table next to `admin`, `assist`, `vibe`.

In `gateway-type1/lib/routes/web-proxy.ts`:
- Add a new route `app.all('/mcp', ...)` (not `/w/:workerId/mcp/*` — the OAuth-issued token already carries the user_id, so the URL stays clean).
- Pull user_id from validated Bearer.
- Look up that user's worker.
- Forward request to `/w/<workerId>/mcp` via the existing WS api_relay handler. Preserve SSE streaming for `text/event-stream` responses (MCP uses SSE for server-to-client messages).

In `tier-agent-core/src/hub-client/api-relay-handler.ts`:
- Add `mcp` to the service routing table mapping to `MCP_PORT` (env var, default to 3100 since lm-assist mounts `/mcp` on its main port). Path: `/w/:id/mcp/*` → worker forwards to `http://127.0.0.1:3100/mcp$REQUEST_PATH`.

### 5. npm connector package + DNS — `@langmartai/lm-assist-mcp-connector`

A thin npm package containing:
- A `register` CLI: `npx @langmartai/lm-assist-mcp-connector register --org $ORG_UUID --name lm-assist` → calls `POST /api/organizations/{org}/mcp/remote_servers` with the user's claude.ai cookies (read from `~/.claude/claudeai-session.json` if present, otherwise prompt the user to paste).
- A `whoami` CLI: prints the OAuth status of the registered server.
- A README explaining the flow.

DNS + cert (one-time on dev):
- Cloudflare A record `mcp.xeenhub.com → 118.189.213.114` (proxied). Use the existing `cf-dns.sh` helper.
- NPM proxy host: `mcp.xeenhub.com → 192.0.2.17:8081` with Let's Encrypt cert via NPM API.

Production (deferred): same routine for `mcp.langmart.ai → 203.0.113.10` after dev confirms.

## Sequencing — incremental, each step independently verifiable

### Step A — worker side, stub OAuth (zero hub changes)
1. Refactor tools, add 4 new handlers.
2. Add `/mcp` HTTP endpoint on lm-assist :3100.
3. Verify locally with `curl -X POST http://localhost:3100/mcp -d '{"method":"initialize",...}'`.
4. Verify via the existing `/home/ubuntu/mcp-claude-test/server.js` pattern: register a stub MCP that proxies to lm-assist :3100, expose at `mcp-test.xeenhub.com/mcp`, register with claude.ai, smoke-test one tool call end-to-end.

**Exit criterion:** a tool registered through the stub returns real lm-assist data when called from claude.ai.

### Step B — hub OAuth server + web-proxy mcp slot
1. Implement Component 3 routes in gateway-type1.
2. Implement Component 4 worker routing.
3. Migrate test from stub to real hub: register at `mcp.xeenhub.com` (configured to hit the hub, not the stub). claude.ai → hub OAuth → hub /mcp → WS to worker → lm-assist.
4. Verify Bearer validation, user_id routing, SSE pass-through, refresh token cycle.

**Exit criterion:** registration from a real claude.ai account, OAuth Connect button works, all 7 tools callable.

### Step C — connector package + DNS finalization
1. Cut `@langmartai/lm-assist-mcp-connector` v0.1.0. Don't publish — pack and test locally.
2. Confirm Cloudflare/NPM/cert setup matches what's documented in `mcp-registration-research.md`.

**Exit criterion:** a fresh user could `npx ... register`, get an OAuth Connect prompt, and use the connector from a new claude.ai conversation.

### Step D — promote to langmart.ai (separate PR, requires explicit approval)
Repeat steps from B + C against Singapore hub + `mcp.langmart.ai`. Deferred — not in this plan.

## Smoke test recipe (Step A target)

```bash
# 1. Build lm-assist with new endpoint
cd /home/ubuntu/lm-assist && npm run build && lm-assist restart

# 2. Probe the MCP endpoint
curl -sS -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}' | jq

# Expect: protocol response with capabilities.tools

# 3. List tools
curl -sS -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq

# Expect: 7 tools

# 4. Call one
curl -sS -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_sessions","arguments":{"limit":3}}}' | jq

# Expect: real session list
```

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| OAuth bug exposes a token to wrong user | Bind token to `(user_id, mcp_server_url)` and re-validate on every call. Unit tests on token issuance + lookup. Manual test cycle with two distinct langmart accounts before any prod promotion. |
| SSE streaming breaks at the WS relay boundary | `api-relay-handler.ts` already handles SSE for the `assist` service (the LangMart Assistant streams). Verify by inspection before writing new code. |
| Anthropic egress IP change | The egress IPs `160.79.106.37/39` are not stable. Don't allowlist by IP — let Cloudflare front. |
| `mcp.xeenhub.com` cert renewal failure | NPM's Let's Encrypt auto-renew works for the existing `*.xeenhub.com` hostnames. Same recipe. |
| Cookie path for the connector CLI exposes secrets | The `register` CLI reads cookies only at user-invoke time, never persists them, and warns when they're absent. |

## Files I will create or change

```
lm-assist/
├── core/src/mcp-server/
│   ├── tools/
│   │   ├── definitions.ts          (extend with 4 new tool defs)
│   │   ├── list-sessions.ts        (new)
│   │   ├── read-session.ts         (new)
│   │   ├── list-conversations.ts   (new)
│   │   ├── read-conversation.ts    (new)
│   │   └── index.ts                (new — barrel + register())
│   ├── server-factory.ts           (new — shared Server() builder for both transports)
│   ├── index.ts                    (refactor to use server-factory)
│   └── api-client.ts               (unchanged)
├── core/src/routes/core/
│   └── mcp.routes.ts               (new — StreamableHTTPServerTransport mount)
└── docs/plans/
    └── 2026-05-27-lm-assist-mcp-claude-ai-connector.md  (this file)

LangMartDesign/
├── gateway-type1/lib/routes/
│   ├── oauth-mcp.ts                (new — 5 OAuth + well-known routes)
│   └── web-proxy.ts                (extend — add /mcp top-level route)
└── tier-agent-core/src/hub-client/
    └── api-relay-handler.ts        (extend — add mcp to service routing table)

new repo:
@langmartai/lm-assist-mcp-connector  (new npm package — register CLI)
```

## Open questions deferred to phase 2

- Do `execute_agent` + terminal tools land behind per-call approval, or do we add a separate "elevated tools" connector?
- Whether to share the same OAuth token across `lm-assist` and a future `tier-agent` MCP, or issue separate tokens per surface.
- Whether to expose write claude.ai operations (`POST /completion`, `POST /title`) as MCP tools at all — they cost tokens and the SPA's parent_message_uuid handling makes them error-prone.

These re-open after Step C exit confirms phase 1.
