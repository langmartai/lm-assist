# claude.ai web integration — conversations, tokens, forking

> Read before touching `core/src/claude-ai/` or any `/claude-ai/*` route. Endpoint-level detail lives in [claude-ai-routes.md](./claude-ai-routes.md).
>
> Split out of the repo [CLAUDE.md](../CLAUDE.md) so it is read on demand instead of loaded into every session. Content is unchanged.

### Measuring + forking a claude.ai conversation (`conversation_tokens` / `conversation_fork`)

A claude.ai web conversation has a hard context ceiling and no operator-controlled
compaction, so a long working chat eventually strands its state. Two tools measure it
and carry it forward. Both take an EXPLICIT `conversation_uuid` — the web client does
not tag MCP calls with a caller id, so there is no "this conversation", ever
(`rename_conversation`'s recency guess once returned an unrelated session).

🔴 **Naive counting over-reports the live context by 3.8x.** Measured on a real
62-message / 2.0 MB conversation. Four traps, all of which a "sum the messages"
implementation walks into:

| trap | what it costs |
|---|---|
| `msg.text` (flat mirror) is **EMPTY** — content lives only in `content[]` | reports **0** for a full chat |
| `display_content` is a separate, non-identical **render** copy, not model input | 669 KB of 1.81 MB — roughly **doubles** the count |
| messages are a **TREE**; edited/retried turns sit on dead branches | 10 of 62 messages counted that aren't in context |
| **COMPACTION** — `compaction_summary` REPLACES everything before it | 1,808,999 → 892,971 → **475,302** chars |

So the estimate is **not** simply a lower bound: it over-counts (compaction, dead
branches, display_content) *and* under-counts (system prompt, tool schemas). It reports
`liveTokens` vs `totalTokens` separately with an explicit `unmeasured[]`.

chars/token is calibrated **per block class** against `/v1/messages/count_tokens` on real
sampled blocks — text 4.074, tool_use 3.584, **tool_result 2.834**. A flat 4.0 under-counts
tool_result (the dominant class in any operational chat) by ~30%. Thinking is stored with
`thinking_hidden=true` and an EMPTY body — only one-line summaries persist, so the rest is
declared in `unmeasured[]` rather than silently reported as zero.

**Credential-aware routing.** These tools are REGISTERED on every node but only FUNCTIONAL
where a claude.ai cookie lives. Each call preflights the local cookie, serves in place if
good, else forwards to a cookie-bearing node via `/mcp-call` (relay-allowed) reporting
`servedByNodeId`, else refuses with the eligible hostIds + the `claudeai_login` remedy.
A forwarded call carries `_noForward` so two nodes cannot ping-pong.

🔴 **`/claude-ai` is deliberately NOT on the hub relay's `ALLOWED_API_PREFIXES`** — it can
send messages and DELETE conversations. The consequence: `auth_status({allNodes:true})`
probes peers with `proxyGet('/claude-ai/healthz')`, the relay rejects it, and **every remote
node reports `cookie:?`** — which reads as "no cookie" but means "never asked". That is why
the fleet looked like it had exactly one cookie-bearing node when it has at least two. The
credential survey therefore lives at **`GET /fleet/credentials[/local]`** (read-only,
secret-free) and keeps `unreachable` strictly distinct from "no cookie".

🔴 **A display name is not an identity.** One live sweep returned 13 rows in which `vm`
appeared 4x, `ubuntu-Virtual-Machine` 3x and `DESKTOP-GDKLATG` 2x, and a dev-repo Core
appends `" (dev)"` to its hostname. Everything routes on **hostId** (`gw4-…`). An explicit
`node` that lacks a cookie is REFUSED, never rerouted — node choice implicitly selects an
ACCOUNT, so the resolved account is reported on every result. Account identity comes from
the **cookie** (`lastActiveOrg`/`ajs_user_id`), not the probe: `/api/account_profile`
returns a flat preferences object with no `account`/`organization` key.

⚠️ **Forking waits for the model, so it must not confuse "slow" with "failed".**
`sendMessage` drains the SSE; an 11 KB handoff ran past `workerPost`'s 30s and reported
FAILURE for a fork that had been created AND seeded — the `send_session_message`
false-negative class, where a retry would create a SECOND conversation in the real account.
The drain is now bounded (20s; returning early does not cancel the turn) and on expiry the
route **re-reads the conversation to VERIFY** a human message landed rather than guessing.
Landed-but-unanswered is `replyPending`, a state, not an error.

**The handoff is POINTERS, not prose.** This feature was scoped inside an already-compacted
conversation whose summary kept the narrative and dropped the provenance — the assistant
then re-derived the CCR taxonomy from inference instead of re-reading `guide("ccr")` and
needed two human corrections. So the seed carries verbatim human turns, ids with the command
that re-reads each, and the playbook names — and **excludes tool_result bodies** (77% of the
source). Real numbers: 2.0 MB source → 11 KB seed. Both live forks opened with the successor
saying it would *re-read the pointers rather than trust the summary*.

Modules: `core/src/claude-ai/conversation-tokens.ts` (pure estimator),
`conversation-handoff.ts` (pure handoff), `core/src/fleet/credential-fleet.ts` +
`credential-collector.ts`, `core/src/mcp-server/tools/conversation-ops.ts`.
Routes: `GET /claude-ai/conversations/:uuid/tokens`, `POST …/fork` (`dryRun` supported),
`GET /fleet/credentials[/local]`.

### claude.ai Web Integration (15 endpoints)

**lm-assist can introspect and operate on the user's claude.ai web account** — list conversations, read full message trees, list projects, read memory and artifacts, AND send new messages to existing conversations. Two parallel families:

| Path | Auth | Best for |
|---|---|---|
| `/claude-ai/...` | `~/.claude/claudeai-session.json` (cookie file) | Headless callers (cron, dashboards, scheduled jobs) |
| `/claude-ai/via-chrome/...` | Real Chrome via MCP | Interactive agents driven by Claude Code with Chrome MCP loaded |

**ALWAYS pre-flight with the health check** before driving these routes. Both families share a stable `reason` vocabulary (`ok`, `session_not_configured`, `session_expired`, `cloudflare_blocked`, `wrong_tab`, `not_logged_in`, `network_error`, `upstream_error`).

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/claude-ai/healthz` | One-glance verdict (file status + live `/api/account_profile` probe) |
| GET | `/claude-ai/session-status[?probe=true]` | File status; optional active probe |
| POST | `/claude-ai/via-chrome/health-check` | Snippet the agent runs in a tab to verify it's on `claude.ai`, logged in, and reachable |
| GET | `/claude-ai/account-profile` | Standalone account profile read |
| GET | `/claude-ai/conversations` | List conversations |
| GET | `/claude-ai/conversations/:uuid` | Read full message tree of one conversation |
| GET | `/claude-ai/projects` | List Projects |
| GET | `/claude-ai/memory` | Claude's persistent memory for the org |
| GET | `/claude-ai/bootstrap` | High-leverage page-load: account + flags + recent conversations |
| GET | `/claude-ai/artifacts/:uuid/versions` | Artifact version history |
| GET | `/claude-ai/org` | Org metadata |
| GET | `/claude-ai/org/subscription` | Subscription details (`?cached=true` by default) |
| GET | `/claude-ai/org/usage` | claude.ai-side usage |
| GET | `/claude-ai/org/skills` | Installed skills |
| GET | `/claude-ai/org/mcp-bootstrap` | Connected MCP servers (**SSE** — events drained server-side) |
| GET | `/claude-ai/org/styles` | Chat styles |
| GET | `/claude-ai/org/model-config/:model` | Per-model capabilities |
| GET | `/claude-ai/org/memory-settings` | Memory feature flags + retention |
| GET | `/claude-ai/org/cowork-settings` | Team/cowork mode toggles |
| GET | `/claude-ai/org/sync-settings` + `/claude-ai/org/sync/gdrive-progress` | Drive sync config + ingestion status |
| GET | `/claude-ai/org/notifications` | Email/push prefs |
| GET | `/claude-ai/account/invites` | Pending org invites |
| GET | `/claude-ai/user-access` | Per-user permissions/roles |
| GET | `/claude-ai/sessions-active` | **Live sessions across devices** — security view |
| POST | `/claude-ai/conversations/:uuid/completion` | **WRITE** — send a message, drain SSE, return aggregated text + events |
| PUT | `/claude-ai/conversations/:uuid` | **WRITE** — **rename** a conversation (`{name}` or `{title}`); returns `previousName` |
| POST | `/claude-ai/conversations/:uuid/title` | **WRITE** — claude.ai's **auto-title generator** (needs `message_content`). ⚠️ NOT a rename — see below |
| POST | `/claude-ai/via-chrome` | Generic snippet generator (path whitelist: `/api/`, `/edge-api/`, `/v1/`) |
| POST | `/claude-ai/via-chrome/...` | Convenience snippet generators mirroring every cookie-file route above |

**Renaming a conversation — `/title` is NOT the rename endpoint.** Despite its
name, `POST .../:uuid/title` is claude.ai's **auto-title generator**: it derives a
title from message content and takes `{message_content, recent_titles}`. Handing it
a title returns `400 "message_content is required."` — it can never set a title of
your choosing. The real rename is a plain `PUT` on the conversation resource:

```
PUT /api/organizations/{org}/chat_conversations/{uuid}   {"name": "New title"}   -> 202
```

Established twice independently (live probe + reading claude.ai's own front-end
bundle, where the "Rename chat" dialog submits `{name}`). Neighbours, so a future
"fix" doesn't wander back: `PATCH`/`POST` on the resource → **405**; `POST .../rename`
→ **404**. Sibling PUTs that *do* exist carry `?rendering_mode=raw` (settings,
`is_starred`) — the rename has **no query string**. Wrapped by
`renameConversation()` (`claudeai-session.ts`), the `PUT /claude-ai/conversations/:uuid`
route, and the `rename_conversation` MCP tool; regression-locked by
`core/src/__tests__/rename-conversation.test.ts`.

Two traps fall out of this: anything that renames by rewriting the chat name (e.g.
`setConversationAutoDelete`'s `[lm-autodel:…]` marker) must go through
`renameConversation`, **and** a successful rename must call
`ClaudeAiCache.updateName()` — `GET /claude-ai/conversations` answers from
`listIndex()` with **no TTL**, so a rename that skips it reads back stale forever
and looks like it silently failed.

**Header fingerprint** — both paths re-inject the application-level headers claude.ai's web app normally adds (`anthropic-client-platform`, `anthropic-client-version`, `anthropic-client-sha`, `anthropic-device-id`, `anthropic-anonymous-id`, `x-activity-session-id`). Identity values come from non-HttpOnly cookies. `x-datadog-*` and `traceparent` are intentionally omitted (random per request, not load-bearing).

**Full integration guide:** [`docs/claude-ai-routes.md`](./claude-ai-routes.md) — covers cookie capture workflow, the via-chrome agent loop pattern, the SSE response shape, the reason-code table, and verified end-to-end test results.

**Endpoint inventory** (independent of lm-assist's wrapper): [`lm-claude-endpoint`](https://github.com/langmartai/lm-claude-endpoint).
