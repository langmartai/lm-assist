# MCP Tool Registry + /mcp-tools Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline execution — sole autonomous executor with full template context; fresh-subagent-per-task would discard the loaded mission-processes template context). Steps use checkbox syntax. Spec: `docs/superpowers/specs/2026-07-15-mcp-tool-registry-design.md` — every interface below is defined there; this plan sequences the work.

**Goal:** Editable fleet-synced MCP tool registry (description override + enable/disable, live on both MCP surfaces) with a first-class `/mcp-tools` page.

**Architecture:** Overlay-only dataset `mcp-tool-registry` (workflow-store pattern) + pure overlay application in `configureMcpServer` (both transports) + origin-anchored REST writes (`mission.routes.ts` workflow idioms) + mission-processes-mirrored web UI absorbing the Settings MCP tab.

**Tech Stack:** node:test (core, `core/src/__tests__/`, run via `cd core && npm test`), vitest (web, `cd web && npm test`), Next.js 16 App Router, data-service cache backend.

## Global Constraints

- Red-first: each core/web behavior lands as failing test → minimal impl → green → commit.
- Tool names/schemas/scopes/annotations/handlers stay code-owned and immutable (spec §4.7).
- `PROTECTED_TOOLS = {bootstrap, guide, session_status}` refuse disable, store-enforced (spec §4.1).
- Registry doc id regex `/^[a-z0-9][a-z0-9_-]{0,63}$/`; `MAX_DESCRIPTION_OVERRIDE_BYTES = 2048`; history cap 20 with full post-change state per entry (spec §4.1).
- Dataset descriptor: `backend:'cache'`, `visibility:'cross-node-readable'`, `syncMode:'full'`, `scope:'fleet'` (spec §4.2).
- Overlay fail-open on provider error; unknown names ignored by overlay but storable (spec §4.2/4.4).
- Reads local; writes origin-anchored with `_originHop` guard, fail-closed `ORIGIN_UNREACHABLE` (spec §4.5).
- Gates: core tsc stays 0 errors; web tsc ≤ 39 errors (pre-existing baseline); `next build` from worktree OK; no push, no deploy.

---

### Task 1: Registry model (pure)

**Files:** Create `core/src/mcp-server/registry/model.ts`; Test `core/src/__tests__/mcp-tool-registry-model.test.ts`.
**Produces:** `ToolRegistryDoc`, `ToolRegistryChange`, `PROTECTED_TOOLS: ReadonlySet<string>`, `MAX_DESCRIPTION_OVERRIDE_BYTES`, `TOOL_REGISTRY_HISTORY_CAP = 20`, `validateToolName(id)` / `validateDescriptionOverride(v)` → `{ok:true}|{ok:false;code;message}`, `toolRegistryChanged(old, next: {descriptionOverride: string|null; enabled: boolean})`.

- [x] Failing tests: name validation (accepts `detail`, `windows_terminal_list`, `zz-e2e-probe`; rejects `''`, uppercase, dots, 65+ chars, leading `-`), override validation (null ok, ≤2048 ok, >2048 `BODY_TOO_LARGE`-style code `OVERRIDE_TOO_LARGE`, empty-string rejected `INVALID_INPUT`), changed-detection (null old → true; identical → false; each field flips it).
- [x] Implement minimal model; run `cd core && npm test` filtered; green; commit.

### Task 2: Registry store (workflow-store mirror, no snapshots)

**Files:** Create `core/src/mcp-server/registry/store.ts`; Test `core/src/__tests__/mcp-tool-registry-store.test.ts`.
**Interfaces:** Consumes Task 1. **Produces:** `TOOL_REGISTRY_DATASET = 'mcp-tool-registry'`, `ToolRegistryPort {isEnabled; get(name); list(); put(doc)}`, `getToolDoc(name, port?)`, `listToolDocs(port?)`, `putToolDoc(input: {name; descriptionOverride?: string|null; enabled?: boolean}, actor: MissionActor, port?)` → `{doc; changed}` (merges over existing doc: omitted field keeps current value, defaults `null`/`true` for new docs), `rollbackToolDoc(name, toRev, actor, port?)` → `{doc}|{error:{code;message}}`, live port via `getDataService()` + `ensureDataset` (exact workflow-store idiom incl. `throwWriteRefused`/`throwDisabled`).

- [x] Failing tests (in-memory fake port, `memPorts()` style from `workflow-origin-anchor.test.ts`): rev 1 create with defaults; rev bump + merge semantics; `changed:false` no-op; history append full `state` + cap 20; **protected disable refusal `PROTECTED_TOOL`** (put with `enabled:false` on `guide`); protected override allowed; rollback restores `state` from entry rev N as new rev; rollback to missing rev → `NOT_FOUND`; **rollback restoring `enabled:false` on protected → `PROTECTED_TOOL`**; disabled data service → coded throw `DATA_SERVICE_DISABLED`; unknown/fake names storable (`zz-e2e-probe`).
- [x] Implement; green; commit.

### Task 3: Catalog (code-derived categories + implementation view)

**Files:** Create `core/src/mcp-server/registry/catalog.ts`; Test `core/src/__tests__/mcp-tool-catalog.test.ts`.
**Produces:** `ToolCatalogEntry {name; def; scope: ToolScope; category: string; module: string; protected: boolean}`, `getToolCatalog(): ReadonlyMap<string, ToolCatalogEntry>` (from `LM_ASSIST_TOOL_DEFS` post-node-param + `TOOL_SCOPES` + module membership over imported `*_TOOL_DEFS` arrays + curated inline map per spec §4.3), `handlerSourceFor(name): {module: string; source: string}|null` (8 base handlers + `EXPANDED_HANDLERS`, `String(fn)`), `CATEGORY_ORDER: string[]`.

- [x] Failing tests: **completeness** — every `LM_ASSIST_TOOL_NAMES` has a category (mirrors `assertScopesCoverTools`); spot categories (`mission_create`→mission, `github_query`→github, `search`→core, `machine_access`→machine-access, `transfer_send_file`→transfer); protected names present in catalog; `handlerSourceFor('detail')` returns non-empty source + module; `handlerSourceFor('nope')` null; def carries `node` param (post-withNodeParam evidence).
- [x] Implement; green; commit.

### Task 4: Overlay (pure) + configureMcpServer wiring

**Files:** Create `core/src/mcp-server/registry/overlay.ts`; Modify `core/src/mcp-server/configure.ts` (optional 3rd param); Test `core/src/__tests__/mcp-tool-overlay.test.ts`.
**Produces:** `ToolOverlay {byName: Record<string,{enabled:boolean; descriptionOverride:string|null}>}`, `OverlayProvider {get(): Promise<ToolOverlay|null>}`, `overlayFromDocs(docs)`, `applyOverlayToToolDefs(defs, overlay|null)`, `isToolDisabled(overlay|null, name)`, `disabledResult(name): McpToolResult` (text starts `⛔ TOOL_DISABLED`), `configureMcpServer(server, dispatch, overlay?)`.

- [x] Failing tests: override swaps only `description` (schema/name untouched, other defs untouched); disabled filtered from list; unknown overlay names ignored; null overlay identity; enabled+null-override doc = identity row; `configureMcpServer` with fake provider via raw handler invocation (`Server` request handlers) — ListTools reflects provider changes call-to-call (LIVE), CallTool on disabled returns `isError` + `TOOL_DISABLED` text and dispatch is NOT invoked, no-provider = today's behavior, provider throw = fail-open defaults.
- [x] Implement (ListTools awaits provider per request; CallTool pre-dispatch check); green; commit.

### Task 5: Live + HTTP providers, transport wiring, shim guards

**Files:** Create `core/src/mcp-server/registry/overlay-live.ts` (store-backed, 1500 ms TTL, fail-open) + `core/src/mcp-server/registry/overlay-http.ts` (api-client `GET /mcp-tools/overlay`, 5000 ms TTL, fail-open); Modify `core/src/routes/core/mcp.routes.ts` (`buildServer` passes live provider), `core/src/mcp-server/index.ts` (stdio passes http provider), `core/src/routes/core/mcp-api.routes.ts` (`/mcp-call` + 8 per-tool shims reject disabled via live provider → `wrapError('MCP_TOOL_DISABLED', …)`), `core/src/mcp-server/api-client.ts` (overlay fetch helper if needed); Test `core/src/__tests__/mcp-tool-overlay-live.test.ts` (TTL cache: one store read per window; fail-open on store throw; cache invalidation hook used by write routes `invalidateOverlayCache()`).

- [x] Failing tests for overlay-live TTL/fail-open/invalidate; implement; wire transports + shim guards; green; core tsc clean; commit.

### Task 6: REST routes (origin-anchored writes)

**Files:** Create `core/src/routes/core/mcp-tools.routes.ts`; Modify `core/src/routes/core/index.ts` (register); Tests `core/src/__tests__/mcp-tools-routes.test.ts`, `core/src/__tests__/mcp-tools-origin-anchor.test.ts`.
**Produces (route handlers, port-injected):** `handleToolList(port?)`, `handleToolOverlay(port?)`, `handleToolGet(name, port?)`, `handleToolSet(name, body, port?, actor?, origin?)`, `handleToolHistory(name, opts, port?)`, `handleToolRollback(name, body, port?, actor?, origin?)`; `OriginAnchorDeps`-shaped deps + `realToolOriginAnchor()` reading `getDatasetRegistry().get(TOOL_REGISTRY_DATASET)?.origin?.machineId` (copy `realOriginAnchor` idiom); envelopes per spec §4.5 table (incl. `orphanDocs`, `knownTool:false` flag, `effectiveDescription`, `implementation`).

- [x] Failing route tests: list joins catalog+docs (override/disabled/orphan visible; counts); get for known (def+implementation) and orphan (`knownTool:false`); set validates name/override, `PROTECTED_TOOL` envelope, unknown-name allowed+flagged; history newest-first; rollback envelope incl. NOT_FOUND.
- [x] Failing origin-anchor tests (exact `workflow-origin-anchor.test.ts` mirror): set/rollback proxy to origin with `_originHop:true` + local docs untouched; local when self/unstamped; fail-closed `ORIGIN_UNREACHABLE`; hopped never re-proxied, flag not persisted.
- [x] Implement (writes call `invalidateOverlayCache()`); register routes; green; commit.

### Task 7: Runtime e2e integration test (both surfaces, in-process)

**Files:** Test `core/src/__tests__/mcp-tools-runtime.test.ts` (uses real store with in-memory port injected into a live provider): override on a real tool shows in ListTools output; disable filters it and CallTool rejects; re-enable restores — proving the "live, no restart" loop end-to-end at the configureMcpServer layer.

- [x] Write + green; commit.

### Task 8: Web pure lib + vitest

**Files:** Create `web/src/lib/mcp-tools.ts`; Test `web/src/lib/__tests__/mcp-tools.test.ts` (mirror `mission-process.test.ts`).
**Produces:** `McpToolRow`/`McpToolGroup` types matching `GET /mcp-tools` payload; `groupTools(rows, categoryOrder)`; `toolBadges(row)` → `{scope, off:boolean, override:boolean, protected:boolean}`; `summarizeCounts(rows)`; `checkRevConflict(loadedRev, freshDoc)` (mission-process idiom); `truncateDescription(s, n)`.

- [x] Failing vitest cases (grouping/order/unknown-category-last+orphans, badges, counts, conflict, truncate); implement; `cd web && npm test` green; commit.

### Task 9: Web page + detail + sidebar + settings pointer

**Files:** Create `web/src/app/(dashboard)/mcp-tools/page.tsx`, `web/src/components/mcp-tools/McpToolsPage.tsx`, `web/src/components/mcp-tools/ToolDetail.tsx`; Modify `web/src/components/layout/Sidebar.tsx` (nav entry, `Wrench` icon), `web/src/app/(dashboard)/settings/page.tsx` (mcp tab → pointer card; drop `McpAccessTab` import/usage), delete `web/src/app/(dashboard)/settings/McpAccessTab.tsx`; Modify `core/src/routes/core/mcp.routes.ts` pending text → "MCP Tools page".
**Consumes:** Task 6 routes + existing `/mcp/access`, `/mcp/access/tool-gate`, `/mcp/pending*` routes; `useAppMode().apiClient.fetchPath`; mission-processes styling (inline CSS vars, `btn`/`badge` classes, `ConfirmButton`).
**Layout per spec §4.6:** header+counts+Refresh; pending banner; 320px grouped list (collapsible categories, rows: mono name, scope badge, `off`/`override` badges, truncated description); detail tabs Description (edit override, default-from-code box, Restore default, rev-conflict) / Implementation (module, def JSON, handler `<pre>`, read-only) / Settings (enabled toggle w/ protected lock + admin-gate toggle) / History (rev table + rollback ConfirmButton).

- [x] Implement page (lib from Task 8 for all logic); wire sidebar + settings pointer; web tsc ≤ baseline 39; commit.

### Task 10: Gates + E2E evidence + report

- [x] `cd core && npm test` full green; `cd web && npm test` green; core tsc 0; web tsc ≤39; `npx next build` from worktree OK.
- [x] E2E per spec §6: isolated-HOME worktree core on scratch port; page/API lists real tools by category; detail shows implementation; **override round-trip on `detail` + immediate rollback with before/after tools/list capture**; history+rollback on `zz-e2e-probe`; `:3100` read-only parity capture; record exact docs touched + final state.
- [x] Final commit(s); mission report (gates, evidence, registry docs state); wait in review.

## Self-Review (done)

Spec coverage: §4.1→T1, §4.2→T2, §4.3→T3, §4.4→T4/5/7, §4.5→T6, §4.6→T8/9, §5→T1-8, §6/§7→T10, req 5 absorption→T9, protected set→T2/T6, live-no-restart→T4/T7. Placeholders: none (interfaces pinned in spec §4). Type consistency: names above match spec §4 exactly (`putToolDoc`, `applyOverlayToToolDefs`, `OverlayProvider`, `TOOL_REGISTRY_DATASET`).
