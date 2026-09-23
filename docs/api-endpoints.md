# API endpoint reference

> Lookup table for every REST endpoint plus the session-history query dimensions. Reference, not rules.
>
> Split out of the repo [CLAUDE.md](../CLAUDE.md) so it is read on demand instead of loaded into every session. Content is unchanged.

## Key API Endpoints

### Health & Status
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/status` | Server status (uptime, project path) |

### Sessions (27 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/sessions` | List Claude Code sessions |
| GET | `/sessions/:id` | Get full session data |
| GET | `/sessions/:id/conversation` | Get session conversation |
| GET | `/sessions/:id/from/:lineIndex` | Delta fetch — messages from JSONL line position |
| GET | `/sessions/:id/has-update` | Lightweight poll — check if session changed |
| GET | `/sessions/:id/exists` | Check if session file exists |
| GET | `/sessions/:id/messages/last/:count` | Last N messages (shorthand) |
| GET | `/sessions/:id/compact-messages` | Continuation/compaction messages |
| GET | `/sessions/:id/subagents` | All subagents spawned by session |
| GET | `/sessions/:id/subagents/:agentId` | Specific subagent session |
| GET | `/sessions/:id/forks` | Sessions forked from this one |
| GET | `/sessions/:id/related` | All related sessions (parents, forks, subagents, siblings) |
| GET | `/sessions/:id/dag` | Message DAG with branch info |
| GET | `/sessions/:id/session-dag` | Cross-session DAG (subagents, teams) |
| GET,POST | `/sessions/batch-check` | Check multiple sessions for updates in one request |
| POST | `/session-cache/warm` | Pre-load sessions into memory cache |
| POST | `/session-cache/clear` | Clear cache (specific session or all) |
| GET | `/monitor/executions` | Currently running executions with live status |
| GET | `/monitor/summary` | Aggregated execution counts by status/tier |
| POST | `/monitor/abort/:executionId` | Abort a specific execution |

### Querying Session Execution History

Sessions are stored as JSONL files in `~/.claude/projects/*/sessions/*.jsonl`. Each line is a message. The API provides three indexing dimensions for slicing into a session:

| Index | Type | Description |
|-------|------|-------------|
| `lineIndex` | 0-based | Raw JSONL line position in the file |
| `turnIndex` | 1-based | Conversation turn number (each user msg and each assistant msg is a turn) |
| `userPromptIndex` | 0-based | Sequential count of user messages only |

#### Common query patterns

**Get full session with all data:**
```
GET /sessions/:id?unlimited=true
```

**Get a specific user interaction (e.g., the 5th user prompt and its response):**
```
GET /sessions/:id?fromUserPromptIndex=4&toUserPromptIndex=4
```

**Get everything from turn 10 onwards:**
```
GET /sessions/:id?fromTurnIndex=10&unlimited=true
```

**Delta fetch — get only new messages since last poll:**
```
GET /sessions/:id/from/1523?limit=100
```
Use `fromLineIndex` alone (no other filters) for fast incremental updates via raw message cache.

**Conditional request — skip re-parse if unchanged:**
```
GET /sessions/:id?ifModifiedSince=2026-03-10T12:00:00Z
```
Returns `notModified: true` if the session hasn't changed since the timestamp.

**Formatted conversation (for display):**
```
GET /sessions/:id/conversation?toolDetail=summary&lastN=20
```
Query params: `lastN`, `beforeLine` (pagination), `toolDetail` (`none`|`summary`|`full`), `includeSystemPrompt`, `fromTurnIndex`/`toTurnIndex`.

**Batch check many sessions at once:**
```
POST /sessions/batch-check
Body: { "sessions": [{ "sessionId": "abc", "knownFileSize": 12345 }] }
```
Returns which sessions have changed, avoiding per-session polling.

**Monitor live executions:**
```
GET /monitor/executions
```
Returns `executionId`, `sessionId`, `status`, `isRunning`, `turnCount`, `costUsd`, `elapsedMs`.

**SSE stream for real-time updates:**
```
GET /stream?executionId=abc123
```
Server-sent events with `execution_update` events. Omit `executionId` for all events.

#### Key response fields from `GET /sessions/:id`

- **Metadata:** `sessionId`, `cwd`, `model`, `claudeCodeVersion`, `permissionMode`, `tools[]`, `mcpServers[]`
- **Execution:** `numTurns`, `durationMs`, `totalCostUsd`, `usage`, `modelUsage`, `isActive`, `status` (`running`|`completed`|`error`|`interrupted`|`idle`|`stale`)
- **Messages:** `userPrompts[]`, `toolUses[]`, `responses[]`, `thinkingBlocks[]`, `systemPrompt`
- **Operations:** `fileChanges[]`, `gitOperations[]`, `fileSummary`
- **Organization:** `todos[]`, `tasks[]`, `plans[]`, `subagents[]`
- **Team:** `teamName`, `allTeams[]`, `teamOperations[]`, `teamMessages[]`
- **Pagination:** `totalUserPrompts`, `totalTurns`, `lastLineIndex`, `lastTurnIndex`, `hasMore`
- **Fork tracking:** `forkedFromSessionId`

#### Additional query params for `GET /sessions/:id`

| Param | Default | Description |
|-------|---------|-------------|
| `cwd` | default project | Project directory to search in |
| `includeRawMessages` | false | Include raw JSONL lines (HEAVY: measured 7.8 MB vs 512 KB on a 2707-turn session — prefer the two compact params below for chat views) |
| `includeToolResults` | false | Compact `toolResults[]`: result text per `tool_use` id (`{toolUseId, content, isError?, truncated?, fullLength?, lineIndex}`), window-filtered, server-capped at 4000 chars/entry |
| `includeSystemMessages` | false | Compact `systemMessages[]`: system/summary rows (`{type, subtype?, content, lineIndex, timestamp?, durationMs?}`), server-capped at 2000 chars/entry |
| `includeReads` | false | Include read-only file operations |
| `fromLineIndex` / `toLineIndex` | — | Filter by JSONL line range |
| `fromTurnIndex` / `toTurnIndex` | — | Filter by turn range |
| `fromUserPromptIndex` / `toUserPromptIndex` | — | Filter by user prompt range |
| `lastNUserPrompts` | 50 | Last N user prompts (default limit) |
| `unlimited` | false | Return all data (no 50-message default limit) |
| `ifModifiedSince` | — | ISO timestamp for conditional requests |

### Projects (12 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/projects` | List all projects |
| GET | `/projects/:path/sessions` | Sessions for a project |
| GET | `/projects/:path/tasks` | Tasks with session mapping |

### Tasks (10 + 12 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/tasks` | List task lists |
| GET | `/tasks/:listId` | Get tasks in a list |
| GET | `/task-store/tasks` | Aggregated tasks across sessions |
| GET | `/task-store/tasks/ready` | Ready (unblocked) tasks |

### Knowledge (21 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/knowledge` | List knowledge entries |
| GET | `/knowledge/search` | Search knowledge (BM25 + vector) |
| POST | `/knowledge/generate` | Generate knowledge from sessions |

### Web Terminal (13 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/ttyd/start` | Start ttyd for a session |
| POST | `/ttyd/stop` | Stop ttyd server |
| GET | `/ttyd/status` | Get ttyd status |
| GET | `/ttyd/processes` | List session processes |

### Hub Client (6 endpoints)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/hub/status` | Connection status |
| POST | `/hub/connect` | Connect to Hub |
| POST | `/hub/disconnect` | Disconnect from Hub |
| PUT | `/hub/config` | Update Hub config (persists to .env) |

### MCP endpoint + tool loading profiles

**Guides:** [`docs/mcp-surfaces.md`](./mcp-surfaces.md#tool-loading-profiles-and-the-per-request-pin) (the pin: resolution, threading, rules) · [`docs/mcp-connector.md`](./mcp-connector.md#one-connector-per-profile) (connector URLs, create, Connect).

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST, GET, DELETE | `/mcp` | MCP Streamable HTTP endpoint, stateless (a fresh server per request). The hub relays the public connector here |
| POST, GET, DELETE | `/mcp?profile=<name>` | Same endpoint, pinned to one tool loading profile for this request: `tools/list`, instructions, result footer, `bootstrap`, `session_status` and `mcp_profile` follow it. An unknown name falls back to the node default, which the banner and footer state. The hub relays a public `/mcp/<name>` as this query |
| POST | `/mcp-call` | stdio shim `{tool, args}`. The header `x-lm-mcp-profile` carries the stdio process's `LM_MCP_PROFILE` pin |
| GET | `/mcp-tools/profile` | The node default (`nodeDefault`, also `active`: what unpinned clients get), every profile with its tool count on this node and any unmatched selectors, the known selectors, and this hub's connector URL for each profile |
| POST | `/mcp-tools/profile` | Set the node default `{profile}`. Applies to unpinned clients only; pinned connectors are unaffected. Also clears the unpinned claude.ai connectors' cached tool list (fire-and-forget) |
| GET | `/mcp/profile-connectors` | `{base, hub, nodeDefault, claudeai: {ok, error?}, unpinned, profiles[], unknownPins[]}`. Each row has the URL on this node's hub, the suggested connector name, the claude.ai connector for that URL (`{uuid, name, connected, authStatus, toolCount}`, or `null`) and a count of duplicates. `unknownPins` are connectors on this hub whose profile this node does not define. When claude.ai cannot be read, the URLs still come back with `claudeai.ok: false`. Never lists tool names. `HUB_NOT_CONFIGURED` on a node without a hub |
| POST | `/mcp/profile-connectors` | Create the claude.ai connector for `{profile}` (an alias is canonicalised), named `lm-assist <hub> <profile>`. Idempotent by URL and serialised: an existing connector is returned. Replies `{created, profile, url, connector, nextStep}`, where `nextStep` is *Connect* in claude.ai. Needs a claude.ai session on the node (`CLAUDEAI_UNAVAILABLE` otherwise) |
| DELETE | `/mcp/profile-connectors/:profile` | Remove every claude.ai connector whose URL is this node's hub `/mcp/<profile>`. Replies `{profile, url, removed, failed}`. The unpinned connector cannot be removed through this route |

These two routes sit under `/mcp/` rather than `/mcp-tools/` on purpose: an older Core reads any
one-segment path under `/mcp-tools` as a tool name (a stray `POST` there would write a junk
registry doc), while `/mcp/<x>` has no catch-all and answers a clean 404.

### Claude Code OAuth (14 endpoints)

**Full guide:** [`docs/claude-code-routes.md`](./claude-code-routes.md).

Proxies `api.anthropic.com` endpoints that use Claude Code's OAuth token (from `~/.claude/.credentials.json`). Outbound headers match the real `claude-code/<version>` fingerprint observed in lm-proxy captures, with the appropriate `anthropic-beta` value per endpoint (source-verified against the leaked Claude Code source).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/claude-code/oauth-status` | Token presence + expiry (no secrets) |
| GET | `/claude-code/usage` | Live `Utilization` payload (rate-limit windows) |
| GET | `/claude-code/profile` | Account / org / application info |
| GET | `/claude-code/roles` | Org + workspace role for current OAuth (no beta header) |
| GET | `/claude-code/account-settings` | OAuth account settings (onboarding flags, dismissed banners) |
| GET | `/claude-code/cli-bootstrap?entrypoint=&model=` | Full CLI bootstrap config (account/org/model bundle) |
| GET | `/claude-code/grove` | Extended-thinking grove config |
| GET | `/claude-code/penguin` | Fast-mode config |
| GET | `/claude-code/policy-limits` | Org-level usage caps + compliance taints |
| GET | `/claude-code/settings` | Remote-managed Claude Code settings |
| GET | `/claude-code/user-settings` | User state with checksum |
| GET | `/claude-code/team-memory?repo=owner/repo[&view=hashes]` | Team-scoped memory |
| GET | `/claude-code/mcp-servers` | Anthropic-managed MCP servers (`anthropic-beta: mcp-servers-2025-12-04`) |
| GET | `/claude-code/mcp-registry` | Public MCP marketplace catalog (no auth) |

### SSE Streams
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/stream` | General event stream (optional `?executionId=` filter) |
| GET | `/tasks/events` | Real-time task file change events |
