# Cowork Task Creation — Design Spec (2026-07-11)

## Overview

Add a **headless "create cowork task"** capability to lm-assist core, exposed as **(a) a REST endpoint** and **(b) an MCP tool** (on both the stdio `lm-assist` server and the remote `/mcp` connector). One call:

1. creates a Claude **cowork session** (cloud *or* local) on `api.anthropic.com` using the Claude Code OAuth token, then
2. sends the initial task prompt, and
3. returns the session handle (id, URL, status).

No browser / cookie needed — this is the **verified headless OAuth path** (see `docs/cowork-web-endpoints.md` §0d). Cowork is distinct from the existing CCR *code* sessions (`ccr-cloud.ts` → `/v1/sessions`, `claude.ai/code/{sid}`): cowork uses `/v1/code/sessions` (`cse_…`, `claude.ai/cowork/{cse}`).

## Goals

- `POST /cowork/tasks` creates + drives a cowork task in one call, cloud or local.
- MCP tool `cowork_create_task` mirrors it (both surfaces), with connector string-arg coercion.
- Reuse existing OAuth plumbing (`core/src/utils/claude-oauth.ts`) — including its built-in token auto-refresh.

## Non-goals (v1)

- No headless local **device discovery** (environment *listing* is cookie-only / 403 via OAuth) — `local` requires the caller to pass `environmentId`.
- No connector-attach, file/attachment staging, scheduled tasks, or waiting for the reply. (Create + send only; reading/driving is done via existing/other tools.)
- No new persistence — the created session lives on the Anthropic side; we return its id.

## Requirements

`create + send` in one call, supporting `cloud` **and** `local` targets.

### Request (POST /cowork/tasks)

| Field | Type | Req | Default | Notes |
|---|---|---|---|---|
| `prompt` | string | ✅ | — | the initial task text |
| `target` | `"cloud"` \| `"local"` | | `"cloud"` | where it runs |
| `environmentId` | string | ✅ if `local` | — | the bridge env id for a local device (ignored for cloud) |
| `model` | string | | `"claude-sonnet-5"` | e.g. `claude-opus-4-8`, `claude-sonnet-5` |
| `effort` | string | | `"medium"` | `"low"`\|`"medium"`\|`"high"`\|`"max"` → sent as `config.effort_level` |
| `title` | string | | derived from prompt (first ~60 chars) | session display title |

### Response (success)

```jsonc
{
  "sessionId": "cse_…",
  "url": "https://claude.ai/cowork/cse_…",
  "target": "cloud",
  "environmentKind": "anthropic_cloud",   // or "bridge" for local
  "environmentId": "env_…",
  "status": "active",
  "model": "claude-sonnet-5",
  "title": "…"
}
```

## Architecture

Three units, each with one responsibility:

1. **`core/src/cowork/cowork-tasks.ts`** — pure logic. Exports `createCoworkTask(opts): Promise<CoworkTaskResult>`. Talks to `api.anthropic.com` via the OAuth helpers. Knows nothing about HTTP routing or MCP.
2. **`core/src/routes/core/cowork.routes.ts`** — `createCoworkRoutes(ctx): RouteHandler[]` with `POST /cowork/tasks`. Validates the body, calls `createCoworkTask`, wraps with `wrapResponse`/`wrapError`.
3. **MCP tool `cowork_create_task`** — definition + handler; the handler loopbacks to `POST /cowork/tasks` via `workerPost` (so there is exactly one implementation of the logic path).

```
MCP tool (stdio + /mcp)  ─┐
                          ├─► POST /cowork/tasks (cowork.routes.ts) ─► createCoworkTask() ─► api.anthropic.com
REST caller ──────────────┘                                                (claude-oauth.ts)
```

### `createCoworkTask` internals

```
CLOUD_ENV = "env_011111111111111111111117"   // the anthropic_cloud singleton
1. org  = await getOrganizationUuid()
2. env  = target === "local" ? environmentId (required) : CLOUD_ENV
3. create: anthropicOAuthPost("/v1/code/sessions",
     { environment_id: env, config: { model, effort_level: effort }, tags: ["cowork"], title },
     ccrOpts)                                  // ccrOpts = beta ccr-byoc-2025-07-29 + anthropic-version + x-organization-uuid
   → session = resp.body.session  (id = cse_…, environment_kind, status, config)
4. sid  = "session_" + cse.slice("cse_".length)
5. send: anthropicOAuthPost(`/v1/code/sessions/${cse}/events`,
     { events: [ { payload: {
         type: "user", uuid: randomUUID(), session_id: sid, parent_tool_use_id: null,
         message: { role: "user", content: prompt } } } ] },
     ccrOpts)
6. return { sessionId: cse, url: `https://claude.ai/cowork/${cse}`, target,
            environmentKind, environmentId: env, status, model, title }
```

`ccrOpts` mirrors the private helper in `ccr-cloud.ts` (`betaHeader: 'ccr-byoc-2025-07-29'`, `extraHeaders: { 'anthropic-version': '2023-06-01', 'x-organization-uuid': org }`). If a shared exported `ccrOpts()` exists, import it; otherwise define a small local one (keep it DRY — prefer exporting the existing one if trivial).

## Auth

- Uses `core/src/utils/claude-oauth.ts`. `anthropicOAuthPost` runs through `ensureFreshAccessToken()` (auto-refresh within 5 min of expiry + retry-after-force-refresh on 401/403) — **no manual token handling**.
- If OAuth is entirely absent/unrecoverable, the helper surfaces the upstream error; the route maps it to a `COWORK_AUTH` error.

## Error handling

| Case | Result |
|---|---|
| missing `prompt` | `400 COWORK_BAD_REQUEST` "prompt is required" |
| `target=local` without `environmentId` | `400 COWORK_BAD_REQUEST` "environmentId is required for local target" |
| create returns non-2xx | `502 COWORK_CREATE_FAILED` with upstream status + message |
| send returns non-2xx | return the created session id + `warning` that the prompt failed to send (session exists; don't orphan silently) |
| OAuth unrecoverable | `401 COWORK_AUTH` |

All via `wrapError(code, message, start)`.

## MCP tool

- **Definition** (`core/src/mcp-server/tools/expanded.ts` → `EXPANDED_TOOL_DEFS`, or a new `tools/cowork.ts` imported there):
  - name `cowork_create_task`, `annotations.readOnlyHint: false`.
  - inputSchema: `prompt` (required), `target`, `environmentId`, `model`, `effort`, `title`.
  - description: plain-English + trigger words ("create a cowork task", "start a cowork session", "dispatch a background task to Claude"), and note cloud-default / local-needs-environmentId.
- **Handler** `handleCoworkCreateTask(args)` (`EXPANDED_HANDLERS['cowork_create_task']`): coerce args to strings, `workerPost('/cowork/tasks', {...})`, return `ok(JSON)` / `err(msg)`.
- **Registration**: add `coworkCreateTaskDef` to `LM_ASSIST_TOOL_DEFS` and `TOOL_SCOPES['cowork_create_task'] = 'write'` in `core/src/mcp-server/configure.ts`. Both dispatchers (stdio `mcp-server/index.ts`, HTTP `routes/core/mcp.routes.ts`) already fall through to `EXPANDED_HANDLERS[name]`, so no per-dispatcher case needed if the expanded pattern is used — **verify** during implementation and add explicit cases only if the fall-through isn't present.

## File changes (implementation map)

| File | Change |
|---|---|
| `core/src/cowork/cowork-tasks.ts` | **new** — `createCoworkTask()` + types |
| `core/src/routes/core/cowork.routes.ts` | **new** — `createCoworkRoutes(ctx)` with `POST /cowork/tasks` |
| `core/src/routes/core/index.ts` | register `...createCoworkRoutes(ctx)` |
| `core/src/mcp-server/tools/cowork.ts` (or extend `expanded.ts`) | **new** — `coworkCreateTaskDef` + `handleCoworkCreateTask` |
| `core/src/mcp-server/tools/expanded.ts` | add def to `EXPANDED_TOOL_DEFS`, handler to `EXPANDED_HANDLERS` |
| `core/src/mcp-server/configure.ts` | add to `LM_ASSIST_TOOL_DEFS` + `TOOL_SCOPES` |
| (optional) `core/src/mcp-server/index.ts`, `routes/core/mcp.routes.ts` | explicit dispatch case only if fall-through absent |

## Testing

Build + typecheck must stay green (`npx tsc --noEmit -p core/tsconfig.json`, `./core.sh build`).

End-to-end on **dev** (`:3200`, from this worktree — see verify note):

1. **Cloud happy path**: `POST :3200/cowork/tasks {"prompt":"Reply with exactly COWORK-API-OK and nothing else. No tools.","target":"cloud"}` → 200, `sessionId` `cse_…`, `environmentKind:"anthropic_cloud"`. Then `GET api.anthropic.com/v1/code/sessions/{cse}/events` (or the read path) shows the user event + eventually the reply. **Delete the session after.**
2. **Local**: same with `{"target":"local","environmentId":"env_01MPqfCuqStETNdAVympt96g"}` (123's bridge) → `environmentKind:"bridge"`; agent runs it locally. Delete after.
3. **Errors**: missing `prompt` → 400; `local` without `environmentId` → 400.
4. **MCP**: call `cowork_create_task` via the stdio server (dev mode) — returns the same handle.

**Verify note:** the running dev service (`:3200`) is served from the *main* checkout. To e2e-test the worktree build, either (a) build the worktree and point a throwaway core instance at it, or (b) restart dev from the worktree (`./core.sh restart`) — pick during the plan; do NOT disturb prod (`:3100`). All created test sessions must be deleted (`DELETE /v1/code/sessions/{cse}` via the OAuth helper).

## Out of scope / future

- `local` device discovery (needs the cookie/via-chrome env-listing).
- Connector attach, file/attachment staging, scheduled tasks, wait-for-reply, read/drive/delete endpoints (a follow-up `cowork_*` family per `docs/cowork-web-endpoints.md` §7).
