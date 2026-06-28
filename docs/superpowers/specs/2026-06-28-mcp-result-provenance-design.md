# MCP Result Provenance — Design

**Goal:** Tag the *result* of each MCP tool call with its origin so an LLM keeps connector/cluster/node/project/repo awareness across follow-up calls — routing the next call to the same connector and respecting the cluster/project/repo scope. Local connections are distinguished from connector (fleet) connections.

## Problem

The fleet-identity block (bootstrap/session_status/guide) orients the LLM at the *start*, but a multi-connector account loses track across rounds: after a result comes back, the LLM doesn't know which connector/fleet/node/cluster it came from, so a follow-up node-targeted call can route to the wrong connector (observed: `cluster_assign` cross-routing). Project and repo provenance is likewise absent from results. And the MCP can be connected **locally** (Claude Code → local Core, or stdio) where there is no fleet/connector at all — a tag must not pretend otherwise.

## Part A — origin footer on every result (connector · cluster · node, local-aware)

A `resultOriginTag()` helper (in `core/src/mcp-server/fleet-identity.ts`) reads the current MCP principal (`currentMcpContext()?.principal`) to pick the form:

- **Relayed via a connector** (`principal.type === 'cloud'` — the hub set `x-relay-source:hub`):
  `⟦lm-assist@<hub> · node:<hostname> · cluster:<cluster>⟧`
- **Local / direct** (`local` principal, or no context — loopback `/mcp`, `/mcp-call`, stdio):
  `⟦lm-assist · LOCAL · node:<hostname> · cluster:<cluster>⟧`

`<hub>` = `hubHostOf(getHubConfig().hubUrl)`, `<hostname>`/`<cluster>` from `getHubConfig()` + `getMyCluster()`. NEVER throws. Because a `node=B` call is relayed to and **runs on** node B, the footer reflects the actual handler/target (B + B's cluster).

**Injection** — append `'\n\n' + resultOriginTag()` to the text of each tool result at:
- `configureMcpServer`'s CallTool handler (`core/src/mcp-server/configure.ts`) — the shared dispatch wiring used by the HTTP `/mcp` connector path (and stdio if it shares it).
- the `/mcp-call` shim (`core/src/routes/core/mcp-api.routes.ts`) — the generic stdio/internal path.

**Skip** appending when the result text already contains `FLEET / CONNECTOR IDENTITY` (bootstrap/session_status/guide) so they aren't double-tagged. Append only to non-error text results (leave `isError` results unchanged).

## Part B — per-resource project + GitHub repo (where the tool knows it)

The resource-returning tools surface each item's own project + repo from the resource, not the handler:
- **sessions** (`list_recent_sessions`, `get_execution`, session detail) → for each session's `cwd`: the project name (basename) + the git remote `owner/repo` (best-effort: read `<cwd>/.git/config`, parse `[remote "origin"] url`, normalize `git@…:owner/repo.git` / `https://…/owner/repo(.git)` → `owner/repo`). Cache per cwd. **This is the only place new wiring is needed** — `get_execution` first gains a `cwd` field on its status response so the handler has something to resolve.
- **missions** (`mission_list`, mission detail) → **already covered, no new wiring.** These tools return the raw mission JSON, which already carries `env.repo` + `projects[]` + `binding.sessionId`; the repo/project provenance is therefore already present in the output. (A derived session-cwd fallback was considered but is redundant given the raw fields — YAGNI.)
- **github tools** (`github_query`/`github_mutate`) → **already covered, no new wiring.** The repo is in the call args and echoed in the result `data`.
- **data** (`data_catalog`/`data_get`/`data_query`) → dataset + node (already shown) — no change.

A shared pure helper `repoOf(cwd: string): { project: string; repo?: string } | null` in a new `core/src/utils/repo-id.ts`, reused by the session tools. `normalizeRemoteUrl` only emits `owner/repo` for HOSTED remotes (scp-style or `scheme://host/…`); a bare local path yields project-only. Per-resource fields are added to the existing result payloads (additive), not the footer.

## Components

- `core/src/mcp-server/fleet-identity.ts` — add `resultOriginTag(): string` (+ a pure `formatResultOriginTag(parts, relayed)` for testability).
- `core/src/mcp-server/configure.ts` — append the tag in CallTool.
- `core/src/routes/core/mcp-api.routes.ts` — append the tag in `/mcp-call`.
- `core/src/utils/repo-id.ts` — `repoOf(cwd)` (pure parse over an injected file-reader for tests).
- session + mission result builders — add `{ project, repo }` per item via `repoOf`.

## Error handling

`resultOriginTag()` and `repoOf()` never throw — every lookup guarded; omit a segment / return null on failure. A missing hub → LOCAL form. A non-git cwd → project only (no repo).

## Testing (`node:test`)

- `formatResultOriginTag` relayed → `lm-assist@<hub>`; local → `· LOCAL ·`; both carry node + cluster.
- the dispatch appends the tag (source-level assertion that CallTool/`/mcp-call` append `resultOriginTag()`), and skips when `FLEET / CONNECTOR IDENTITY` is present.
- `repoOf` parses `git@github.com:owner/repo.git`, `https://github.com/owner/repo`, `https://github.com/owner/repo.git` → `owner/repo`; non-git → `{project}` only; missing → null.

## Out of scope (YAGNI)

- Forcing claude.ai's connector resolution (awareness only — same as fleet-identity).
- Tagging binary/file-stream results.
- Per-resource project/repo for tools where the resource has no cwd/repo (terminals, account, etc.) — they get only the footer.

## Build order

Part A (footer — fixes follow-up routing + local awareness) ships first; Part B (per-resource project/repo) ships second. Independent.
