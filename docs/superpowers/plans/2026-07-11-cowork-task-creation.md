# Cowork Task Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a headless "create cowork task" REST endpoint (`POST /cowork/tasks`) and MCP tool (`cowork_create_task`) that creates a Claude cowork session (cloud or local) via the Claude Code OAuth token and sends an initial prompt, in one call.

**Architecture:** Three units — `cowork-tasks.ts` (pure logic hitting `api.anthropic.com` via existing OAuth helpers) ← `cowork.routes.ts` (thin REST route) ← MCP tool handler (loopbacks to the route via `workerPost`, so there is one logic path). Cowork = `/v1/code/sessions` (`cse_…`), distinct from the existing CCR code sessions in `ccr-cloud.ts`.

**Tech Stack:** TypeScript (core builds CommonJS), Node HTTP route system (`RouteHandler`), the `lm-assist` MCP server (stdio + HTTP `/mcp`).

**Spec:** `docs/superpowers/specs/2026-07-11-cowork-task-creation-design.md`. **Endpoint reference:** `docs/cowork-web-endpoints.md`.

## Global Constraints

- **Reuse OAuth plumbing** — `core/src/utils/claude-oauth.ts`: `anthropicOAuthPost()`, `getOrganizationUuid()`, and the CCR options shape (`betaHeader:'ccr-byoc-2025-07-29'`, `extraHeaders:{'anthropic-version':'2023-06-01','x-organization-uuid':org}`). Do **not** reimplement token handling — `anthropicOAuthPost` already auto-refreshes. **Read `claude-oauth.ts` first to copy exact signatures + return shape.**
- **Cloud env singleton:** `env_011111111111111111111117` (`environment_kind: anthropic_cloud`).
- **`session_id` form:** `"session_" + cse.slice(4)` (strip the `cse_` prefix; the events payload uses the `session_…` form of the same id).
- **Response wrappers:** routes use `wrapResponse(data,start)` / `wrapError(code,msg,start)` from `core/src/api/helpers.ts`. MCP handlers use `ok()`/`err()` + `workerPost()` from `core/src/mcp-server/tools/_passthrough.ts`.
- **Never hardcode ports** (dev 3200 / prod 3100). `workerPost` already targets the right loopback.
- **Verification per task:** `npx tsc --noEmit -p core/tsconfig.json` must exit 0. E2e uses `curl` against the **dev** API only (never prod `:3100`). **Every cowork session created during testing MUST be deleted afterward** (`DELETE /v1/code/sessions/{cse}` via the OAuth helper / a scratch node script).
- **MCP connector coercion:** connector args may arrive as strings — coerce in the handler.

---

### Task 1: Core logic + REST route (`POST /cowork/tasks`)

**Files:**
- Create: `core/src/cowork/cowork-tasks.ts`
- Create: `core/src/routes/core/cowork.routes.ts`
- Modify: `core/src/routes/core/index.ts` (register the route factory)

**Interfaces:**
- Consumes (read exact signatures from the files): `anthropicOAuthPost(pathname, body, opts)`, `getOrganizationUuid()` from `../utils/claude-oauth`; `wrapResponse`, `wrapError` from `../../api/helpers`; `RouteContext`, `RouteHandler`, `ParsedRequest` from the routes types.
- Produces: `createCoworkTask(opts: CreateCoworkTaskOpts): Promise<CoworkTaskResult>` and `createCoworkRoutes(ctx: RouteContext): RouteHandler[]`.

- [ ] **Step 1: Read the exact helper signatures.** Open `core/src/utils/claude-oauth.ts` (confirm `anthropicOAuthPost` param order + return shape `{status,statusText,body,headers}`, and whether an exported `ccrOpts()` exists — if yes, import it; if not, build the opts inline as below). Open `core/src/api/helpers.ts` (`wrapResponse`/`wrapError`). Open `core/src/routes/core/claude-code.routes.ts` for the route-file pattern, and `index.ts` for registration.

- [ ] **Step 2: Implement `core/src/cowork/cowork-tasks.ts`.**

```typescript
import { randomUUID } from 'crypto';
import { anthropicOAuthPost, getOrganizationUuid } from '../utils/claude-oauth';

const CLOUD_ENV_ID = 'env_011111111111111111111117'; // anthropic_cloud singleton

export interface CreateCoworkTaskOpts {
  prompt: string;
  target?: 'cloud' | 'local';
  environmentId?: string;      // required when target === 'local'
  model?: string;              // default claude-sonnet-5
  effort?: string;             // default medium -> config.effort_level
  title?: string;
}

export interface CoworkTaskResult {
  sessionId: string;           // cse_…
  url: string;                 // https://claude.ai/cowork/{cse}
  target: 'cloud' | 'local';
  environmentKind?: string;    // anthropic_cloud | bridge
  environmentId: string;
  status?: string;
  model: string;
  title: string;
  warning?: string;            // set if the prompt failed to send
}

export class CoworkTaskError extends Error {
  constructor(public code: string, message: string, public httpStatus = 502) {
    super(message);
  }
}

// Match ccr-cloud.ts's private ccrOpts(): CCR beta + version + org header.
async function ccrOpts() {
  const org = await getOrganizationUuid();
  return {
    betaHeader: 'ccr-byoc-2025-07-29',
    extraHeaders: { 'anthropic-version': '2023-06-01', 'x-organization-uuid': org },
  };
}

export async function createCoworkTask(opts: CreateCoworkTaskOpts): Promise<CoworkTaskResult> {
  const prompt = (opts.prompt || '').trim();
  if (!prompt) throw new CoworkTaskError('COWORK_BAD_REQUEST', 'prompt is required', 400);

  const target = opts.target === 'local' ? 'local' : 'cloud';
  if (target === 'local' && !opts.environmentId) {
    throw new CoworkTaskError('COWORK_BAD_REQUEST', 'environmentId is required for local target', 400);
  }
  const environmentId = target === 'local' ? String(opts.environmentId) : CLOUD_ENV_ID;
  const model = opts.model || 'claude-sonnet-5';
  const effort = opts.effort || 'medium';
  const title = opts.title || (prompt.length > 60 ? prompt.slice(0, 57) + '…' : prompt);
  const cc = await ccrOpts();

  // 1) create the cowork session
  const created = await anthropicOAuthPost('/v1/code/sessions', {
    environment_id: environmentId,
    config: { model, effort_level: effort },
    tags: ['cowork'],
    title,
  }, cc);
  if (created.status < 200 || created.status >= 300) {
    throw new CoworkTaskError('COWORK_CREATE_FAILED',
      `create failed (${created.status}): ${JSON.stringify(created.body).slice(0, 300)}`, 502);
  }
  const session = created.body?.session || created.body?.response_shape || created.body;
  const cse: string = session?.id;
  if (!cse) throw new CoworkTaskError('COWORK_CREATE_FAILED', 'no session id in create response', 502);
  const sid = 'session_' + cse.slice(4);

  // 2) send the initial prompt
  let warning: string | undefined;
  const sent = await anthropicOAuthPost(`/v1/code/sessions/${cse}/events`, {
    events: [{ payload: {
      type: 'user', uuid: randomUUID(), session_id: sid, parent_tool_use_id: null,
      message: { role: 'user', content: prompt },
    } }],
  }, cc);
  if (sent.status < 200 || sent.status >= 300) {
    warning = `session created but prompt send failed (${sent.status})`;
  }

  return {
    sessionId: cse,
    url: `https://claude.ai/cowork/${cse}`,
    target,
    environmentKind: session?.environment_kind,
    environmentId,
    status: session?.status,
    model,
    title,
    ...(warning ? { warning } : {}),
  };
}
```

> NOTE: adjust `anthropicOAuthPost` call sites if Step-1 reading shows a different param order/return field (e.g. `data` vs `body`). Keep the logic identical.

- [ ] **Step 3: Implement `core/src/routes/core/cowork.routes.ts`.**

```typescript
import type { RouteContext, RouteHandler } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { createCoworkTask, CoworkTaskError } from '../../cowork/cowork-tasks';

export function createCoworkRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'POST',
      pattern: /^\/cowork\/tasks$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          const b = req.body || {};
          const result = await createCoworkTask({
            prompt: b.prompt,
            target: b.target,
            environmentId: b.environmentId,
            model: b.model,
            effort: b.effort,
            title: b.title,
          });
          return wrapResponse(result, start);
        } catch (e) {
          if (e instanceof CoworkTaskError) return wrapError(e.code, e.message, start);
          return wrapError('COWORK_ERROR', (e as Error).message, start);
        }
      },
    },
  ];
}
```

> Confirm the import path for `RouteContext`/`RouteHandler` from Step 1 (the Explore map says these types live in `core/src/routes/index.ts`; adjust the relative path if `routes/core/index.ts` re-exports them).

- [ ] **Step 4: Register the route** in `core/src/routes/core/index.ts`: add `import { createCoworkRoutes } from './cowork.routes';` and `...createCoworkRoutes(ctx),` to the array returned by `createCoreRoutes`.

- [ ] **Step 5: Typecheck.** Run: `npx tsc --noEmit -p core/tsconfig.json` — Expected: exit 0.

- [ ] **Step 6: Build + start dev from this worktree, e2e cloud happy path.** Build (`./core.sh build`), ensure dev core runs from the worktree on `:3200` (see the plan's "Running dev from the worktree" note). Then:

Run:
```bash
curl -s -XPOST localhost:3200/cowork/tasks -H 'content-type: application/json' \
  -d '{"prompt":"Reply with exactly COWORK-API-OK and nothing else. Do not use any tools.","target":"cloud"}' | head -c 600
```
Expected: `success:true`, `data.sessionId` matching `cse_…`, `data.environmentKind:"anthropic_cloud"`, `data.url` `https://claude.ai/cowork/cse_…`. **Record the `cse` for cleanup.**

- [ ] **Step 7: E2e error cases.**

Run:
```bash
curl -s -XPOST localhost:3200/cowork/tasks -H 'content-type: application/json' -d '{}' | head -c 200
curl -s -XPOST localhost:3200/cowork/tasks -H 'content-type: application/json' -d '{"prompt":"x","target":"local"}' | head -c 200
```
Expected: first → `COWORK_BAD_REQUEST` "prompt is required"; second → `COWORK_BAD_REQUEST` "environmentId is required for local target".

- [ ] **Step 8: E2e local path (optional, against 123's bridge).**

Run:
```bash
curl -s -XPOST localhost:3200/cowork/tasks -H 'content-type: application/json' \
  -d '{"prompt":"Reply with exactly COWORK-LOCAL-OK.","target":"local","environmentId":"env_01MPqfCuqStETNdAVympt96g"}' | head -c 600
```
Expected: `data.environmentKind:"bridge"`. (Requires the 123 desktop app bridged; skip if unavailable.) **Record the `cse`.**

- [ ] **Step 9: Delete all test sessions.** For each recorded `cse`, delete via the OAuth helper (scratch node one-liner using `anthropicOAuthDelete('/v1/code/sessions/'+cse, await ccrOpts())`) and confirm a follow-up GET returns 404.

- [ ] **Step 10: Commit.**
```bash
git add core/src/cowork/cowork-tasks.ts core/src/routes/core/cowork.routes.ts core/src/routes/core/index.ts
git commit -m "feat(cowork): POST /cowork/tasks — headless cowork task create+send (cloud+local)"
```

---

### Task 2: MCP tool `cowork_create_task`

**Files:**
- Create: `core/src/mcp-server/tools/cowork.ts` (definition + handler)
- Modify: `core/src/mcp-server/tools/expanded.ts` (add to `EXPANDED_TOOL_DEFS` + `EXPANDED_HANDLERS`)
- Modify: `core/src/mcp-server/configure.ts` (add to `LM_ASSIST_TOOL_DEFS` + `TOOL_SCOPES`)
- Modify (only if the dispatchers don't fall through to `EXPANDED_HANDLERS`): `core/src/mcp-server/index.ts`, `core/src/routes/core/mcp.routes.ts`

**Interfaces:**
- Consumes: `ok`, `err`, `workerPost` from `./_passthrough`; the `POST /cowork/tasks` route from Task 1.
- Produces: `coworkCreateTaskDef` (tool definition object) and `handleCoworkCreateTask(args)` handler.

- [ ] **Step 1: Read the MCP wiring.** Open `core/src/mcp-server/tools/expanded.ts` (confirm the exact shape of `EXPANDED_TOOL_DEFS` entries + `EXPANDED_HANDLERS` map + the `McpToolResult` type + `_passthrough` exports incl. `workerPost` signature). Open `core/src/mcp-server/configure.ts` (`LM_ASSIST_TOOL_DEFS`, `TOOL_SCOPES`). Open both dispatchers (`mcp-server/index.ts`, `routes/core/mcp.routes.ts`) to confirm they fall through to `EXPANDED_HANDLERS[name]` (the Explore map says they do).

- [ ] **Step 2: Create `core/src/mcp-server/tools/cowork.ts`.**

```typescript
import { ok, err, workerPost, type McpToolResult } from './_passthrough';

export const coworkCreateTaskDef = {
  name: 'cowork_create_task',
  description:
    'Create a Claude Cowork task: creates a cowork session (cloud by default, or on a local ' +
    'device) and sends the initial prompt, running in the background. Use for "create a cowork ' +
    'task", "start a cowork session", "dispatch a background task to Claude". Returns the session ' +
    'id + URL. For target="local" you must pass environmentId (a bridge device env id).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: { type: 'string', description: 'The task prompt to send.' },
      target: { type: 'string', description: '"cloud" (default) or "local".' },
      environmentId: { type: 'string', description: 'Bridge env id — required when target="local".' },
      model: { type: 'string', description: 'Model id, default claude-sonnet-5.' },
      effort: { type: 'string', description: 'low|medium|high|max, default medium.' },
      title: { type: 'string', description: 'Optional session title.' },
    },
    required: ['prompt'],
  },
};

export async function handleCoworkCreateTask(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const s = (v: unknown) => (v == null ? undefined : String(v));
    const body = {
      prompt: s(args.prompt) || '',
      target: s(args.target),
      environmentId: s(args.environmentId),
      model: s(args.model),
      effort: s(args.effort),
      title: s(args.title),
    };
    const res = await workerPost('/cowork/tasks', body);
    // workerPost returns the ApiResponse envelope; surface data or error.
    if (res && res.success === false) return err(JSON.stringify(res.error || res));
    return ok(JSON.stringify(res?.data ?? res, null, 2));
  } catch (e) {
    return err((e as Error).message);
  }
}
```

> Confirm `workerPost`'s return shape in Step 1 (does it unwrap the `ApiResponse` or return it raw?) and adjust the `res.success`/`res.data` handling to match.

- [ ] **Step 3: Register in `expanded.ts`.** Import `{ coworkCreateTaskDef, handleCoworkCreateTask }`; add `coworkCreateTaskDef` to `EXPANDED_TOOL_DEFS`; add `cowork_create_task: handleCoworkCreateTask` to `EXPANDED_HANDLERS`.

- [ ] **Step 4: Register in `configure.ts`.** Add `coworkCreateTaskDef` to `LM_ASSIST_TOOL_DEFS` (if not already surfaced via `EXPANDED_TOOL_DEFS` spread — check to avoid duplicates) and `cowork_create_task: 'write'` to `TOOL_SCOPES`.

- [ ] **Step 5: Dispatcher fall-through check.** If Step-1 reading showed either dispatcher does NOT fall through to `EXPANDED_HANDLERS`, add `case 'cowork_create_task': return handleCoworkCreateTask(args);` to it. Otherwise no change.

- [ ] **Step 6: Typecheck.** Run: `npx tsc --noEmit -p core/tsconfig.json` — Expected: exit 0.

- [ ] **Step 7: Build + e2e via the HTTP `/mcp` shim (or the stdio server).** Rebuild + restart dev core. Verify the tool is listed and callable. Simplest check via the loopback the handler uses:

Run:
```bash
curl -s -XPOST localhost:3200/cowork/tasks -H 'content-type: application/json' \
  -d '{"prompt":"Reply with exactly COWORK-MCP-OK.","target":"cloud"}' | head -c 400
```
(confirms the path the MCP handler calls). Then confirm the tool appears in the tool list (`grep` the built `dist` or call the MCP `tools/list` per the mcp.routes pattern). **Record + delete the created `cse`.**

- [ ] **Step 8: Commit.**
```bash
git add core/src/mcp-server/tools/cowork.ts core/src/mcp-server/tools/expanded.ts core/src/mcp-server/configure.ts
git commit -m "feat(cowork): cowork_create_task MCP tool (stdio + /mcp)"
```

---

## Running dev from the worktree (for e2e steps)

The dev service (`:3200`) normally runs from the **main** checkout. To e2e-test this worktree's build without disturbing it:
- Build the worktree: `./core.sh build` (from the worktree root).
- Stop the main dev core if running, then start dev from the worktree: `./core.sh restart` (worktree). It binds `:3200` (dev) — **never touch prod `:3100`**.
- After testing, the reviewer may restore dev to the main checkout. Note this in the handoff.
- OAuth token comes from `~/.claude/.credentials.json` (shared, host-level) — the same token used throughout the research; if expired, the helper auto-refreshes.

## Self-Review

- **Spec coverage:** POST /cowork/tasks (Task 1) ✓; cloud+local (Task 1 env resolution) ✓; create+send (Task 1 steps 2) ✓; MCP tool both surfaces (Task 2) ✓; error handling (Task 1 step 7 + CoworkTaskError) ✓; auth reuse/auto-refresh (global constraints + Task 1) ✓; testing incl. cleanup (Task 1 step 9, Task 2 step 7) ✓; local-needs-environmentId (Task 1 validation) ✓.
- **Placeholder scan:** the `> NOTE/Confirm` callouts are "verify against the real file signatures" instructions (the implementer has the codebase), not code placeholders — the actual code is present in every code step.
- **Type consistency:** `createCoworkTask`/`CreateCoworkTaskOpts`/`CoworkTaskResult`/`CoworkTaskError` (Task 1) are consumed consistently by the route; `coworkCreateTaskDef`/`handleCoworkCreateTask` (Task 2) names match across `cowork.ts`/`expanded.ts`/`configure.ts`.
