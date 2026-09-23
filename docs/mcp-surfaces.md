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

### Tool loading profiles and the per-request pin

> The user-facing side (connector URLs, creating a connector per profile, the Connect step) is
> in [One connector per profile](./mcp-connector.md#one-connector-per-profile). The design is
> `docs/superpowers/specs/2026-09-23-mcp-profile-connectors-design.md`.

A profile (`core/src/mcp-server/registry/profiles.ts`) names the subset of tools that
`tools/list` advertises: `basic`, `platform`, `extended` or `admin`. `platform` used to be
called `langmart`, and `PROFILE_ALIASES` keeps that name working, both in a pin and in an
existing node-default file. Two things can choose the profile for a request:

- The **node default**. It lives in `mcp-profile[-dev].json` in the data dir
  (`LM_ASSIST_DATA_DIR`, else `~/.lm-assist`) and is written by `mcp_profile set` and
  `POST /mcp-tools/profile`. `activeProfileName()` reads it behind a 1.5 s cache, and it is
  `admin` when the file is absent. It applies to unpinned clients.
- A **pin**: a profile name carried by ONE request. A pin is never written to that file or to
  the module cache.

`resolveEffectiveProfile(pin)` returns the `EffectiveProfile` that every consumer reads:

| input | result |
|---|---|
| no pin | `{ name: activeProfileName(), source: 'node-default' }` |
| a known pin (`canonicalProfileName` resolves the alias) | `{ name: <canonical>, source: 'pin', pin }` |
| an unknown pin, or one that fails `isValidPinSyntax` (`^[a-z][a-z0-9-]{0,31}$`, not `connectors`) | `{ name: activeProfileName(), source: 'node-default', pin, unknownPin: true }`; the echoed `pin` is cut to 64 printable characters |

Every lookup checks own keys only (`Object.hasOwn`). A bare `PROFILE_DEFINITIONS[name]` once
accepted `constructor`, and a single POST took the node's whole MCP surface down
(`mcp-profiles.test.ts`).

**How the pin reaches the handlers.**

- **HTTP.** The hub relays the public `https://mcp.<domain>/mcp/<profile>` to the node as
  `/mcp?profile=<profile>`. It does this on every relay, including a node-targeted `tools/call`.
  - The node only ever sees the query form, so a profile name cannot collide with the node's
    own `/mcp/*` REST routes (`/mcp/search`, `/mcp/connectors`, `/mcp/pending`, …).
  - No routing changed: `rest-server.ts` already matches `/mcp` with the query stripped and
    passes the raw `req` on, and `api-relay-handler.ts` re-appends a relayed `query`.
  - `handleMcpRequest` (`routes/core/mcp.routes.ts`) computes
    `resolveEffectiveProfile(parseProfilePin(req.url))` and hands the result on twice:
    - To `buildServer(effective)`, which passes it to
      `configureMcpServer(server, dispatch, overlay, extTools, { profile: effective })` and to
      `getLmAssistInstructions(effective)`. The `Server` and its instructions are built BEFORE
      the request context exists, so they take the profile as an argument.
    - Into `runWithMcpContext({ principal, toolUseId, profile: effective }, …)`, where tool
      handlers and the result footer read it with `currentEffectiveProfile()`. Measured: the
      AsyncLocalStorage context set around `transport.handleRequest` still holds after an
      `await`, and two concurrent requests with different pins each see their own.
- **stdio.** `core/src/mcp-server/index.ts` reads `LM_MCP_PROFILE` (`PROFILE_PIN_ENV`) once at
  start and resolves it with `resolveEffectiveProfile`.
  - A pinned process passes the result as the `configureMcpServer` option `{ profile }`. When
    no MCP context is active, which is the stdio case, the CallTool handler installs
    `{ principal: { type: 'local' }, profile }`. The footer and the bootstrap gate then read the
    same pin as they do on HTTP. An unpinned stdio server passes no option and installs no
    context, exactly as before.
  - The instructions are built from the process pin, else from
    `resolveEffectiveProfile(undefined)`. So an unpinned stdio server on a narrowed node default
    also names its profile, the same as HTTP does.
  - `api-client.ts` sends the pin with every `/mcp-call` as the header `x-lm-mcp-profile`
    (`PROFILE_PIN_HEADER`).
  - `mcp-api.routes.ts` lifts that header into `runWithMcpContext`, so the Core-side handlers
    (`bootstrap`, `mcp_profile`, `session_status`) see the pin the stdio process was started
    with.
- **tools/list** serves `liveEffectiveProfile(opts?.profile ?? currentEffectiveProfile())`:
  the server's own profile, else the request context's, else the node default.
  - A pin stays fixed. A node-default resolution is re-read on every list, so a stdio server
    resolved at spawn still follows `mcp_profile set`.
  - The filter runs AFTER the overlay. A tool switched off in the registry stays off under
    every profile, and a profile can only narrow.
  - `PROTECTED_TOOLS` (`bootstrap`, `guide`, `mcp_profile`, `session_status`) are always
    listed.

**Hot-path rules.** Every conversation pays for `initialize` and `tools/list`, so:

- No disk or network access per request for the pin. It comes from the URL or the environment.
  Only the node default reads a file, through the existing 1.5 s cache.
- Never write a pin into `activeProfileName()`'s cache or into the file. If you did, one
  connector's pin would become every unpinned client's surface.
- No tool counting on `initialize`. The banner names the profile, never a live count.
- When `profileNeedsExtTools(effective.name)` is false (no `ext__` selector, and not `all`),
  tools/list does not fetch the plugin list at all. The fleet fan-out behind it
  (`fleetExtToolDefs`, up to 5 s) would be filtered out anyway.
- Each tools/list writes ONE line, prefixed `[mcp] tools/list`, to the console of the process
  serving it. The line gives the effective profile, its source, the pin if any, and the
  advertised count.
  - For HTTP, that console is the Core log: `lm-assist logs core`, plus `--dev` for a dev
    checkout. A stdio server writes the line to its stderr.
  - The line does NOT go to `mcp-calls.jsonl`. That file is a fleet dataset capped at 1,000
    lines, and one line per `tools/list` would push the tool-call history out of it.
  - `logToolCall` records nothing about profiles, so this line is the only record of what a
    connector was actually served.

🔴 **The byte-identity contract.** With no pin and node default `admin` (the shipped default),
tools/list, the instructions, the result footer and bootstrap must be byte-identical to the
build before pins existed. `getLmAssistInstructions()` called with no argument, or with a
node-default `admin` resolution, must return exactly the old text.
- `result-origin.test.ts`, `fleet-identity.test.ts` and `session-start-routing.test.ts` pin this
  and must pass UNMODIFIED. If you had to edit one of them to get green, the contract broke.
- A node whose operator narrowed the default (no pin, default `basic`) does get the
  profile-aware banner and bootstrap, because the effective profile drives them.
- The footer's `· profile <name>` segment appears only when a pin is present.

🔴 **Advertise-only.** A pin changes what `tools/list` returns and what the model is told, and
nothing else. `tools/call` has no profile check: a hidden tool stays callable, and the overlay,
the bootstrap gate, the admin gate and `TOOL_SCOPES` apply exactly as before. Do not add a
profile refusal, for two reasons:

- The hub does not bind a token to a resource, so any token works on any profile URL. A refusal
  would be a boundary in name only.
- claude.ai caches `tools/list`, so right after a change it still believes the old tools exist.
  A call gate would hard-fail each of those tools until someone refreshed the connector.

Nothing may treat a pinned connector as restricted.

**What the model is told.**

- The first sentence of the instructions carries the profile:
  `⟦THIS CONNECTOR⟧ lm-assist · PRODUCTION · profile basic`. Claude Code cuts instructions at
  about 2,048 characters, so anything the model must know goes in that sentence. That includes
  an unknown pin and the fallback it got.
- The paragraph about two connectors separates two axes:
  - different **hubs** are independent fleets, so fall back to the other one;
  - different **profiles on one hub** reach the same nodes, so they are not a failover.
- The result footer (`result-origin.ts`) gains `· profile <name>` only when a pin is present.
  An unknown pin is named there too, with the fallback it got.
- `session_status` gains a `profile` field (effective, source, pin, node default) whenever the
  profile is named: a pin, known or unknown, or a narrowed node default. It is absent in the
  unpinned `admin` case.
- `bootstrap` and `guide`:
  - leave out any section whose governed tools are ALL hidden;
  - build the page manifest from what is actually delivered;
  - close with one line naming what the profile hides and saying that the unpinned or `admin`
    connector carries it;
  - include the "call `list_claudeai_conversations` first" mandate only when the profile
    advertises that tool.
- The FLEET / CONNECTOR IDENTITY block that `bootstrap` returns stays profile-unaware. It is
  the same under every profile. The banner, `session_status`, the footer and bootstrap's
  closing line carry the profile.

**The bootstrap gate key.** `gateKeyFor(conversationId, profile)` returns the bare conversation
id, unless `isNarrowedProfile(profile.name)` is true, in which case it returns
`<id>#<profile>`. The gate passes on the bare key OR on the matching `#<profile>` key. A full
bootstrap therefore satisfies every profile, and a narrowed one satisfies only itself. The key
is a plain string, so it flows through the in-memory registry, the node-local persist file and
the fleet-shared `mcp-bootstrap` dataset with no schema change.

**`mcp_profile`.**
- `get` reports `{ effective, source, pin, nodeDefault }`, when the node default was set, and
  each profile's description with its connector URL on this hub, plus the unpinned URL.
  - It makes NO claude.ai call. It is a protected tool, listed under every profile, and reading
    claude.ai's connector list is a ~30 s stream.
  - Its `connectorsHint` says where that status lives. For claude.ai connector status per
    profile, call `mcp_connectors {action:"list"}`.
- `set` changes the node default ONLY. When called through a pinned connector, the reply says
  that this connector did not change and names the connector that has the requested profile.
- A node-default change, from `mcp_profile set` or `POST /mcp-tools/profile`, calls
  `onNodeDefaultProfileChanged`. That clears the cached tool list of the unpinned claude.ai
  connectors.
  - It is fire-and-forget, and it is deferred when the node holds no claude.ai cookie.
  - It never runs the real refresh under `node --test`.
  - Pinned connectors are not touched.

**Mixed versions: a call that works proves nothing.**

- An older node ignores `?profile=` and serves its own default.
- An older hub drops `?profile=` silently and answers `/mcp/<profile>` with an HTTP 500.
- The hub sends untargeted calls, including every `initialize` and `tools/list`, to the user's
  most recently connected node. In a mixed fleet, a pinned connector therefore gets the full
  surface whenever an older node answers.

Check the banner or the footer, never just that the call succeeded. Deploying the hub first is
safe, because an older node ignores the query.

**Internal consumers stay unpinned.** The mission controller calls the local `/mcp`, and its
playbooks use `mcp__lm-assist-hub__*`; both need the `mission` and `worker` categories. Do not
pin either of them, and never rename the `lm-assist-hub` Claude Code entry.

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
