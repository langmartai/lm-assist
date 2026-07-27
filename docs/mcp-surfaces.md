# MCP surfaces — stdio vs HTTP, and caller identity

> Read before adding an MCP tool or touching `mcp-session-resolver.ts` (it is on the hot path of every connector call).
>
> Split out of the repo [CLAUDE.md](../CLAUDE.md) so it is read on demand instead of loaded into every session. Content is unchanged.

### MCP Server (`core/src/mcp-server/`)

Provides 3 tools via stdio transport (server name: `lm-assist`):

| Tool | Description |
|------|-------------|
| `search` | Unified search across knowledge and file history |
| `detail` | Progressive disclosure for any item by ID (K001, sessionId:index) |
| `feedback` | Quality feedback on context sources (outdated, wrong, useful, etc.) |

**Two MCP surfaces — both come up with Core, neither is a separate process or port:**

1. **stdio** (table above) — `core/src/mcp-server/index.ts`, server name `lm-assist`, loaded by a **local** Claude Code session through the plugin; it is an HTTP client to Core's `/mcp/search|detail|feedback` shims (`mcp-api.routes.ts`).
2. **HTTP `/mcp`** — the Model Context Protocol StreamableHTTP endpoint served by **Core itself** at `POST/GET/DELETE /mcp` (`core/src/rest-server.ts` → `core/src/routes/core/mcp.routes.ts`). This is the surface reached **remotely through the hub** (the `mcp__claude_ai_lm-assist_langmart__*` connector tools).

**How the remote MCP reaches Core (no extra process/port — it rides the outbound hub WebSocket):**

```
Claude Code / claude.ai connector
  -> mcp.langmart.ai                      (public MCP endpoint, OAuth)
  -> LangMart hub  (assist-api.langmart.ai)
  -> api_relay message over the worker WebSocket   (the same HubClient connection Core dialed out)
  -> Core HubClient -> ApiRelayHandler    (core/src/hub-client/api-relay-handler.ts; /mcp is on its allow-list)
  -> localhost:3100/mcp                   (mcp.routes.ts) -> response relayed back up
```

So the remote MCP is live as soon as **(a) Core is started** (prod via `lm-assist start` — the `/mcp` route binds with Core, there is no separate MCP daemon) **and (b) the HubClient is authenticated** to `assist-api.langmart.ai` (auto-connects on Core start when `~/.lm-assist/hub.json` has `hubUrl` + `apiKey`; `register -> register_ack -> auth_confirmed`). The hub **pushes** requests down the existing outbound socket — nothing listens on a separate inbound MCP port. If Core is down (e.g. the chokidar crash above) the relay has nowhere to land and the connector errors with "MCP down", even though `mcp.langmart.ai` and the hub are healthy.

### Caller-identity resolution is ON THE HOT PATH of every connector MCP call

`mcp-session-resolver.ts` resolves WHO is calling. Its header used to say "resolved only for
bootstrap/session_status" — untrue since the backlog/mission write paths started calling it on
EVERY write via the `_actor` hint. Anything expensive added there is paid by every connector
tool call, in front of the relay's fixed 25s local / 30s gateway cutoffs. **Keep full store
sweeps, unbounded network calls and timer-only deadlines off this path.**

Measured on prod 117 (backlog_create, 4 concurrent, direct :3100): warm with a tool-call id
**9359ms → 42ms**; plain no-`_actor` path is 8ms.

- 🔴 **A cost that survives a WARM cache is not the cached thing.** The claude.ai call and the
  8s cache were the suspects; the web-caller shape (no tool-call id) already warmed to 9ms while
  the tool-call-id shape stayed at 9359ms **warm**. That row named the real culprit:
  `findPreciseClaudeCodeSession` — commented *"cheap (in-memory) so it runs every call"* —
  called `getAllSessionsFromCache()`, a **synchronous** lmdb `getRange()` that msgpack-decodes
  **all 13,607** cached sessions: **1663-1977ms per call**, against **6-8ms** for the file-tail
  scan it exists to accelerate. Split a path by input shape and compare warm rows.
- **The cheap fallback was also the RELIABLE one.** The tail scan wins on both axes — the
  caller's tool_use was written moments ago, precisely the window where the parsed cache LAGS.
  Recent sessions now come from a directory walk (**37-53ms** for 6,610 files, memoized 3s);
  the `cwd` label from an **O(1) point get for the ONE session chosen**, never for all.
- 🔴 **A `setTimeout` bound is not a deadline.** A 2.5s bound let an 8229ms call through, and
  `Promise.race` never cancelled the fetch. Proven: **a 2500ms timer did not fire at all during
  a 6s synchronous block.** Use an AbortController (combined with `claudeaiGet`'s internal
  timeout, not replacing it) **plus a wall-clock re-check after the await**.
- 🔴 **Stamp a cache at COMPLETION, not at start.** Stamped at start, an 8229ms resolution
  against an 8000ms TTL wrote an **already-expired** entry — the slower the resolution, the
  shorter its cache lived. Now completion-stamped + stale-while-revalidate, so resolution leaves
  the hot path after the first one (identity here is explicitly best-effort).
- **Injected test deps get NO live enrichment hook** — `getSessionCache()` constructs the cache
  *and* starts its chokidar watcher, the open-handle hang `core/scripts/run-tests.js` bisects.

Regression suite: `core/src/__tests__/mcp-session-resolver-latency.test.ts` (each test
mutation-verified — the born-expired one first PASSED with the bug reintroduced, because a 20ms
delay never approaches an 8s TTL; it now asserts the stamp directly).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/backlog` | List items (`?status=&type=&tag=&includeRemoved=`) |
| GET | `/backlog/graph` | Drawable `{nodes, edges:[{from,to,kind}]}` |
| GET | `/backlog/:id` | Full item incl. discussion/reviews/history |
| GET | `/backlog/:id/history` | Rev history, newest first |
| POST | `/backlog` | Create `{title, description?, type?, priority?, tags?, requestId?}` — idempotent on `requestId` |
| POST | `/backlog/:id` | Update whitelist fields (unknown field ⇒ `UNSUPPORTED_FIELD`) |
| POST | `/backlog/:id/link` `/unlink` | Add/remove typed edge `{to, kind}` |
| POST | `/backlog/:id/discuss` | Attach note `{note, session?}` (session defaults to caller) |
| POST | `/backlog/:id/review` | Attach review `{verdict: approve\|reject\|concerns, note?, by?}` |
| POST | `/backlog/:id/remove` | Soft delete (`{restore:true}` restores) |
| POST | `/backlog/:id/rollback` | Restore rev `{toRev}` as a new rev |
