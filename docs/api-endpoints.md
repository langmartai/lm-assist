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

### Harness (non-Claude agent runners)

**Topic file:** [`docs/harness-runs.md`](./harness-runs.md) — storage, recorder, redaction, OpenCode DB rules, retention, backfill.

Harnesses (`qwen`, `opencode`) run behind `POST /agent/execute` with `runner: "<id>"`. None of
`/harness/*` is on the hub relay allow-list: these routes are node-local. The run-history routes are
GET-only and every response is redacted.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/harness/status` | Every runner with capabilities + a bounded binary probe (~1.6 s — do not poll), and the provider profiles (redacted: `hasKey`, never the key) |
| PUT | `/harness/provider/:name` | Create/update a provider profile `{baseUrl, apiKey?, model?, note?, makeDefault?}`. **Loopback only** — a direct call to Core — and refused (`FORBIDDEN`, 403) when `x-relay-source` or `x-forwarded-host/for/proto` is present (the hub relay and the web `/_coreapi` proxy both reach Core from 127.0.0.1). `apiKey` may be omitted to keep the stored one, except when `baseUrl` changes (`INVALID_INPUT`) |
| GET | `/harness/runners?days=1..365` | Per-runner summary: capabilities, default profile, isolation, window stats (success rate, p50/p95, tokens, top tools, recent failures). Never probes. `sdk`/`tmux` are listed with `recorded:false` |
| GET | `/harness/runs` | Recorded (and, on dev, backfilled) runs, newest first — see query below |
| GET | `/harness/runs/:id` | One run: `{run, status (derived), live, abortable, childAlive? (interrupted only), sources}` |
| GET | `/harness/runs/:id/transcript` | One page of the normalized event stream — see query below |
| GET | `/harness/runs/:id/debug?lines=1..200` | Tail of qwen's own debug log (qwen only; `NOT_APPLICABLE` 404 otherwise) |

`GET /harness/runs` query: `runner=<id>`, `status=<csv>` (`running|succeeded|failed|timed_out|aborted|refused|launch_failed|interrupted|not_started|unknown`),
`q=<≤100 chars>` (prompt, cwd, model, session id, run id), `since=<epoch ms|24h|7d|30d|all>`,
`includeBackfill=1|0` (default 1), `limit=1..200` (default 50), `offset`. Returns
`{core, runs, counts:{shown, matched, total, running, byRunner, byStatus}, nextOffset, backfill}`;
`byRunner`/`byStatus` are facet counts (every filter except their own).

`GET /harness/runs/:id/transcript` query: `source=auto|captured|native` (default auto: captured while
live, the CLI's own store after), `offset`, `limit=1..1000` (default 300), `maxField=256..65536`
(default 4000), `ifVersion=<version>` — a match answers `unchanged: true` with no events, which is how
a live run is polled cheaply. Each field is redacted before it is cut to `maxField`, and an event cut
there (text, reasoning, tool, user) carries `truncated: true`.

Errors: `INVALID_QUERY` (400, echoes the value sent), `INVALID_ID` (400 — ids must match
`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`), `NOT_FOUND` (404 — pruned by retention, or recorded by the other
dev/prod Core).

Related changes on the agent routes:
- `POST /agent/execution/:id/abort` also ends in-flight **foreground** harness runs (via the run
  record and the harness's own live-child map). Response shape unchanged: `{success, sessionId, reason?}`.
- `GET /agent/executions` items carry `runner` and `cwd`.
- `POST /agent/execute` with a harness runner refuses an `executionId` that is invalid
  (`INVALID_EXECUTION_ID`) or already used on this node (`DUPLICATE_EXECUTION_ID`), as a
  `success:false` response naming the runner. A `background:true` request for ANY runner is refused
  with `DUPLICATE_EXECUTION_ID` when its id is a run still in flight (a finished id may be reused
  by the Claude runners, as before).

### SSE Streams
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/stream` | General event stream (optional `?executionId=` filter) |
| GET | `/tasks/events` | Real-time task file change events |
