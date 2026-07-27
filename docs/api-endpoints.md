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
| `includeRawMessages` | false | Include raw JSONL lines |
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
