# MCP Tool Registry + /mcp-tools Page — Design Brief

**Date:** 2026-07-15 · **Branch:** `feat/mcp-tool-registry` (based on fetched `origin/main` @ `37592c1`)
**Mission:** promote MCP tool management to a first-class page and make the toolset *editable* (description override + on/off) via a fleet-synced registry, following the mission-processes registry arc (`workflow-store.ts` + `/mission/workflows` routes + `web/src/components/mission-processes/*`) as the template.

## 1. Problem

The ~150 MCP tools lm-assist advertises are hard-coded: descriptions live in `core/src/mcp-server/tools/*`, the only management UI is the Settings "MCP" tab (admin-approval gates only), and nothing can be tuned without a code change + redeploy. We want a dedicated `/mcp-tools` page listing every tool by category, with per-tool editable description and enable/disable — applied **live** to both MCP surfaces — while tool names, schemas, scopes, and handlers stay code-owned.

## 2. Current architecture (verified)

- **One canonical tool list for both surfaces:** `configure.ts` builds `LM_ASSIST_TOOL_DEFS` (base defs from `tools/definitions.ts` + `EXPANDED_TOOL_DEFS` from `tools/expanded.ts`, each wrapped by `withNodeParam`) and `configureMcpServer(server, dispatch)` registers ListTools (returns the defs verbatim) + CallTool (runs `dispatch`).
- **HTTP `/mcp` surface** (`routes/core/mcp.routes.ts`): fresh `Server` per request → `configureMcpServer(server, dispatch)` with an in-process dispatcher (8 base handlers + `EXPANDED_HANDLERS`).
- **stdio surface** (`mcp-server/index.ts`, ships in the plugin cache): same `configureMcpServer`, dispatcher forwards over HTTP to core — per-tool shims (`/mcp/search` …) and the generic `POST /mcp-call` (`mcp-api.routes.ts`) which dispatches `EXPANDED_HANDLERS[tool]`.
- **Scopes:** `TOOL_SCOPES` in `configure.ts` (read/write/admin), boot-asserted complete by `assertScopesCoverTools()`.
- **Template registry arc:** `mission/workflow-store.ts` (dataset `mission-workflows`, cache backend, `scope:'fleet'`, `syncMode:'full'`; port seams for tests; rev + inline history; coded write-refusal errors) and the `/mission/workflows` routes in `mission.routes.ts` (origin-anchored writes: `OriginAnchorDeps` + `anchorToOrigin` + `_originHop` loop guard, fail-closed `ORIGIN_UNREACHABLE`; the READ_ONLY_REPLICA silent-drop remediation).
- **Data storage:** dev-repo builds write `~/.lm-assist/data-dev/…`, prod `~/.lm-assist/data/…` (`core/src/data/paths.ts`) — dev e2e cannot touch the prod fleet registry.

## 3. Approaches considered

**A. Registry as full tool docs (defs stored in the dataset, code seeds them).** Rejected: makes code and registry compete for ownership of names/schemas/handlers; sync lag or a stale doc could mask a new tool; violates "defaults ALWAYS come from code".

**B. Overlay-only registry (chosen).** The dataset holds *only* deltas: `{descriptionOverride, enabled}` per tool name. Absence of a doc ⇒ pure default. Code remains the single source of truth for names, schemas, scopes, handlers; the overlay is applied at ListTools/CallTool time. Registry docs for names the local build doesn't know are **ignored by the overlay** (required anyway for mixed-version fleets, and it enables the scratch-doc e2e).

**C. Per-node registry (no fleet sync).** Rejected: the fleet norm (workflow registry precedent) is fleet-wide docs with origin-anchored writes; per-node config would fragment tool behavior invisibly.

## 4. Design

### 4.1 Registry model (`core/src/mcp-server/registry/model.ts`)

```ts
interface ToolRegistryDoc {
  name: string;                       // MCP tool name, /^[a-z0-9][a-z0-9_-]{0,63}$/ (underscores allowed, unlike workflow ids)
  descriptionOverride: string | null; // null ⇒ default from code
  enabled: boolean;                   // false ⇒ omitted from tools/list + calls rejected
  rev: number;                        // monotonic
  history: ToolRegistryChange[];      // inline, cap 20, each entry carries FULL post-change state
  createdBy / lastUpdatedBy: MissionActor;   // same actor shape as workflow docs
  createdAt / updatedAt: number;
}
interface ToolRegistryChange {
  rev: number; at: number; actor: MissionActor;
  state: { descriptionOverride: string | null; enabled: boolean };  // rollback source of truth
  changes: Record<string, { from: unknown; to: unknown }>;          // description summarized as len:N
}
```

- `MAX_DESCRIPTION_OVERRIDE_BYTES = 2048` (longest in-code description is ~1 KiB).
- **Deviation from template, documented:** no separate snapshot dataset. Workflow docs need full-body snapshots because bodies are 64 KiB; registry docs are tiny, so each inline history entry carries the full `{descriptionOverride, enabled}` state and **rollback restores from inline history** (cap 20 revs — older revs are not restorable, accepted).
- **Protected set** (refuse `enabled:false`, enforced in the store so every write path is covered):
  `PROTECTED_TOOLS = { bootstrap, guide, session_status }` — the orientation surface an agent needs to discover everything else; disabling any of them could lock a connector out of self-help. The registry's own management surface is REST + web UI (deliberately **no** MCP management tool in v1), so it cannot be disabled via the registry and needs no protected entry. Description overrides on protected tools are allowed (only disable is refused). Rollback is guarded identically (a rollback that would restore `enabled:false` on a protected tool is refused with `PROTECTED_TOOL`).

### 4.2 Store (`core/src/mcp-server/registry/store.ts`) — mirrors `workflow-store.ts`

- Dataset `mcp-tool-registry`: `backend:'cache'`, `visibility:'cross-node-readable'`, `syncMode:'full'`, `scope:'fleet'` (exact workflow-store descriptor).
- `ToolRegistryPort { isEnabled, get, list, put }` seam; live adapter over `getDataService()`; tests inject an in-memory fake.
- `putToolDoc(input, actor, port)`: validate name + override size; protected-disable refusal (`PROTECTED_TOOL`); no-op detection (`changed:false`); rev++, history append (cap 20) with full state; coded throws on refused/disabled writes (`throwWriteRefused` / `throwDisabled` idiom — never silently no-op).
- `rollbackToolDoc(name, toRev, actor, port)`: find history entry `rev === toRev` → `putToolDoc` with its `state` (protected guard applies inside putToolDoc).
- No seeding (overlay-only; empty registry = all defaults).
- Unknown tool names are **storable** (mixed-version fleets sync docs for tools this build doesn't have; e2e scratch doc `zz-e2e-probe`); the overlay and the catalog simply don't apply them.

### 4.3 Code catalog (`core/src/mcp-server/registry/catalog.ts`)

Read-only, code-derived table `name → { def, scope, category, module }` + `handlerSourceFor(name)`.

- **Category = defining module** under `core/src/mcp-server/tools/*` where the module is cohesive (programmatic membership over the imported `*_TOOL_DEFS` arrays: github, whatsapp, transfer, port-forward→transfer, fs-inspect→transfer, data, cluster, machine-access, mission×4→mission, worker-role→worker, bus/fabric-probe/node-status/node-builds/node-upgrade/lifecycle→fleet, session-messaging/session-dag/session-footprints→session, auth-status/claudeai-login/claude-code-account/claudeai-account/claude-code-usage→auth, scheduler→fleet, browser-task→agent, refresh-connector→claudeai, elevated→elevated, guide→core, session-resolver→core …); for grab-bag modules (`expanded.ts` inline defs, `definitions.ts`) a curated `name → category` map (terminal, memory, claudeai, ccr, agent, session, core…).
- A **completeness test** mirrors `assertScopesCoverTools()`: every name in `LM_ASSIST_TOOL_NAMES` must resolve to a category — a new tool without one fails the suite.
- Implementation view: def JSON is the **advertised** def (post-`withNodeParam`, i.e. exactly what tools/list serves); handler source = `String(handler)` from a merged map (8 base handlers + `EXPANDED_HANDLERS`), plus the module pointer. Read-only by construction — no write path exists.

### 4.4 Overlay runtime (`core/src/mcp-server/registry/overlay.ts` — pure; + live/http providers)

```ts
type ToolOverlay = { byName: Record<string, { enabled: boolean; descriptionOverride: string | null }> };
interface OverlayProvider { get(): Promise<ToolOverlay | null> }   // null ⇒ no overlay (fail-open)
applyOverlayToToolDefs(defs, overlay)   // filter enabled:false, swap description; unknown names ignored
isToolDisabled(overlay, name); disabledResult(name)                // clear DISABLED error text
```

- `configureMcpServer(server, dispatch, overlay?)` gains an optional third param. ListTools awaits `overlay.get()` per request and applies it; CallTool rejects disabled tools *before* dispatch with `isError:true` text `⛔ TOOL_DISABLED — "<name>" is disabled in the lm-assist MCP tool registry (re-enable it on the /mcp-tools page)`. No param ⇒ today's behavior byte-for-byte.
- **HTTP `/mcp`:** `buildServer()` passes a core-side provider (`overlay-live.ts`: reads the store, ~1.5 s TTL cache, fail-open `null` on any error). Fresh-server-per-request + per-request ListTools ⇒ **live, no restart**.
- **stdio:** `index.ts` passes an HTTP provider (`overlay-http.ts`: `GET /mcp-tools/overlay` via the existing api-client base, ~5 s TTL, fail-open). ListTools consults it per request ⇒ live. (The installed plugin binary picks this up on its next plugin update — a deployment fact, not a design gap.)
- **Belt-and-suspenders for stale stdio binaries:** core-side guards in `mcp-api.routes.ts` — `POST /mcp-call` and the 8 per-tool shims reject disabled tools (`MCP_TOOL_DISABLED`) using the live provider. So even an old plugin build cannot *call* a disabled tool (its cached tools/list may still show it until updated).
- **Fail-open rationale:** the overlay is a UX/management layer, not a security boundary (that remains TOOL_SCOPES + the gateway + admin gates). If the data service is off or the registry is unreadable, serving code defaults keeps the MCP surface functional; enforcement resumes the moment the store is readable again.

### 4.5 REST routes (`core/src/routes/core/mcp-tools.routes.ts`) — workflow-route idioms

Bare `{success,data}/{success,error}` envelopes; port-injected testable handlers; registered in `routes/core/index.ts`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/mcp-tools` | Catalog join: every advertised tool `{name, category, module, scope, protected, defaultDescription, effectiveDescription, enabled, hasOverride, rev?, lastUpdatedBy?, updatedAt?}` + `categories[]` + `orphanDocs[]` (registry docs whose name isn't in this build — e.g. scratch probes) + counts. **Local read** |
| GET | `/mcp-tools/overlay` | Minimal `{byName}` map for the stdio provider + tests. **Local read** |
| GET | `/mcp-tools/:name` | Detail: advertised def JSON, scope, category, module, protected, defaultDescription, registry doc, effectiveDescription, `implementation: {module, handlerSource}`. Works for orphan docs (`knownTool:false`, no def/implementation). **Local read** |
| POST | `/mcp-tools/:name` | `{descriptionOverride?: string\|null, enabled?: boolean}` → `{doc, changed}`. **Origin-anchored write** (`_originHop` guard, fail-closed `ORIGIN_UNREACHABLE`), protected-disable → `PROTECTED_TOOL`, unknown name allowed but flagged `knownTool:false` |
| GET | `/mcp-tools/:name/history` | `{history}` from the doc (inline entries, newest first). **Local read** |
| POST | `/mcp-tools/:name/rollback` | `{toRev}` → `{doc}`. **Origin-anchored write**, same guards |

**Deviation from template, documented:** reads are **local**, not leader-anchored. Missions live on the elected leader; the tool registry is a fleet-synced dataset where *this node's* code defines the tool universe — the correct read is always the local catalog + local replica. Writes anchor to the **dataset origin** exactly like `handleWorkflowSet`/`-Rollback` (READ_ONLY_REPLICA remediation), with the same `_originHop` mixed-version loop guard and the same fail-closed proxy error.

Actor attribution: web/API writes record `coarseActor('user','api'-channel)` equivalents (same `MissionActor` shape as workflow docs; `_actor` MCP hint honored if a future MCP surface is added).

### 4.6 Web UI

- **Sidebar:** `{ href: '/mcp-tools', icon: Wrench, label: 'MCP Tools' }` in `Sidebar.tsx` `baseNavItems`.
- **Route:** `web/src/app/(dashboard)/mcp-tools/page.tsx` → `<McpToolsPage/>` (7-line wrapper, mission-processes pattern).
- **`components/mcp-tools/McpToolsPage.tsx`** — mirrors `MissionProcessesPage`: header (title, `N tools · M overridden · K disabled` counts, Refresh), pending-approvals banner (from `/mcp/pending`, only when non-empty), left list (320 px) grouped by category (collapsible headers `CATEGORY (n)`), rows = mono name + scope badge (read/write/admin) + `off` badge when disabled + `override` badge when overridden + one-line truncated effective description; right pane = `<ToolDetail/>`. Orphan registry docs render under a trailing `unregistered docs` group.
- **`components/mcp-tools/ToolDetail.tsx`** — mirrors `ProcessDetail`: provenance bar (name, category, scope, protected lock, rev, lastUpdatedBy) + 4 tabs:
  - **Description** — effective description shown; textarea editing the override; *default from code always shown alongside* (read-only box); Save (`POST {descriptionOverride}`), Revert (local), **Restore default** (`POST {descriptionOverride: null}`); rev-conflict check before save (`checkRevConflict` idiom).
  - **Implementation** — read-only: module pointer, advertised def JSON (pretty), handler source in `<pre>`. No edit affordances.
  - **Settings** — Enabled toggle (ConfirmButton for disable; protected tools show a lock note and no disable control) + the **admin-gate** toggle (existing `PUT /mcp/access/tool-gate`), scope/category readouts.
  - **History** — table rev / when / actor / changes / Rollback (ConfirmButton), current rev badged.
- **Pure lib `web/src/lib/mcp-tools.ts`** (vitest-covered, mirrors `lib/mission-process.ts`): category grouping/ordering, badge derivation (`hasOverride`, disabled), counts, `checkRevConflict`. All fetches via `useAppMode().apiClient.fetchPath` (proxy-aware) — same as mission-processes.
- **Settings page (req 5):** the `'mcp'` tab content is replaced by a pointer card — "MCP tool management has moved → **/mcp-tools**" (link) — and `McpAccessTab.tsx` is deleted; its two functions (per-tool admin gate, pending confirm/deny) are **absorbed** into the new page (Settings tab toggle + page-level banner) so nothing regresses and no duplicate management UI remains. The pending-confirmation message in `mcp.routes.ts` that pointed at "the lm-assist MCP settings tab" is updated to point at the MCP Tools page.

### 4.7 What stays immutable (req 4)

Tool **names, input schemas, scopes, annotations, handlers** — code-owned, no registry field can touch them; the Implementation tab is read-only by construction (no write route accepts schema/handler data).

## 5. Testing (red-first, `core/src/__tests__/` + web vitest)

1. `mcp-tool-registry-model.test.ts` — name validation (underscores ok, junk rejected), override size cap, changed-detection.
2. `mcp-tool-registry-store.test.ts` — put creates rev 1 / bumps rev / no-ops on identical input; history cap + full-state entries; rollback restores state (and appends a new rev); **protected-set disable refusal** (put + rollback paths); coded throw when port disabled; unknown-name docs storable.
3. `mcp-tool-overlay.test.ts` — **override applied** to tools/list defs; **disabled filtered**; **unknown names ignored**; empty/null overlay = identity; `disabledResult` shape; `configureMcpServer` with fake provider: ListTools reflects overlay live (change provider between calls), CallTool rejects disabled with DISABLED error and never dispatches, no-provider behaves as before.
4. `mcp-tools-routes.test.ts` — list/get/set/history/rollback envelopes over in-memory port; set flags `knownTool:false` for unknown names; PROTECTED_TOOL envelope.
5. `mcp-tools-origin-anchor.test.ts` — mirrors `workflow-origin-anchor.test.ts`: proxy to origin with `_originHop`, local when self/unstamped, fail-closed `ORIGIN_UNREACHABLE`, hopped requests never re-proxied.
6. Catalog completeness — every advertised tool categorized; protected names exist in the catalog.
7. Web `src/lib/__tests__/mcp-tools.test.ts` — grouping, ordering, badges, counts, rev-conflict.

## 6. E2E plan (req 6/8 — safety on the live fleet registry)

- Run the **worktree build** of core on a scratch port with an **isolated HOME** (fresh `data-dev`, no hub config → no hub connect, no interference with the machine's real dev/prod cores). The tool list is code-owned, so the page lists the real ~150 tools regardless.
- Description-override round-trip on the harmless read tool **`detail`**: override → verify `POST /mcp` tools/list shows it → **immediately roll back** (restore default) → verify restored. History + rollback exercised via the scratch doc **`zz-e2e-probe`** (fake name; overlay ignores it). Disable/enable runtime path is proven by unit/integration tests + optionally on `zz-e2e-probe` only.
- Live prod core **:3100 read paths only**: capture the real `/mcp` tools/list for name-parity evidence with the page. **No writes to :3100, no writes to any fleet-synced store** (isolated HOME guarantees this even against the dev fleet).
- Report the exact registry docs touched and their final state.

## 7. Quality gates

Baselines captured pre-change: core tsc `--noEmit` **0 errors**; web tsc **39 pre-existing errors** (web builds with `ignoreBuildErrors: true`) — after: core stays 0, web ≤ 39. `cd core && npm test` green; `cd web && npm test` (vitest) green; `npx next build` from the worktree succeeds. Commits on `feat/mcp-tool-registry`; **no push, no deploy**.

## 8. Out of scope

MCP management tools for the registry (`mcp_tool_*`) — REST/web only in v1; per-node (non-fleet) overrides; editing schemas/scopes/names; gateway-side scope enforcement changes; disabling REST routes (registry governs MCP tools only).
