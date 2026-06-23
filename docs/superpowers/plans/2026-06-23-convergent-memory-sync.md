# Convergent Memory Sync — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. TDD throughout.

**Goal:** Memory sync default-on + a Memory settings tab (Increment 1), then git-remote peer discovery + convergent auto-merge (Increment 2). Spec: `docs/superpowers/specs/2026-06-23-convergent-memory-sync-design.md`.

**Conventions:** node ≥20 (`export PATH=/home/ubuntu/.nvm/versions/node/v20.19.6/bin:$PATH`); `cd core && npm run build:test && node --test dist-test/__tests__/<f>.test.js`. Tests touching memory-api close caches in `after` (`resetMemoryCache()` + `stopSessionCache()`).

---

# INCREMENT 1 — default-on + Memory settings tab

## Task 1: `memorySyncEnabled` setting (default true)

**Files:** modify `core/src/project-settings.ts`; test `core/src/__tests__/memory-sync-enabled-setting.test.ts`

- [ ] **Step 1: failing test** — mirror the existing `crossProjectSignpostEnabled` setting test (fresh-require pattern with `LM_ASSIST_DATA_DIR`): assert `getProjectSettings().memorySyncEnabled === true` by default; reads `false` from file; `saveProjectSettings` round-trips.
- [ ] **Step 2: implement** — add `memorySyncEnabled: boolean` to `ProjectSettings`, `DEFAULTS` (`true`), the load mapping, and the save mapping (mirror `crossProjectSignpostEnabled`).
- [ ] **Step 3: run → pass; commit** `feat(settings): memorySyncEnabled (default true)`.

## Task 2: `resolveMode` honors the setting

**Files:** modify `core/src/memory/autosync.ts`; test `core/src/__tests__/autosync-resolve-mode.test.ts`

- [ ] **Step 1: failing test** — `resolveMode()` returns `on` when `memorySyncEnabled` true + no env; `off` when setting false + no env; env `MEMORY_AUTOSYNC=observe|off|on` always wins. (Set env + a fresh `LM_ASSIST_DATA_DIR` settings file; re-require autosync.)
- [ ] **Step 2: implement**
```ts
export function resolveMode(): AutoSyncMode {
  const v = (process.env.MEMORY_AUTOSYNC || '').trim().toLowerCase();
  if (v === 'on') return 'on';
  if (v === 'off') return 'off';
  if (v === 'observe') return 'observe';
  // no explicit env → driven by the setting (default true → on)
  try { return require('../project-settings').getProjectSettings().memorySyncEnabled ? 'on' : 'off'; }
  catch { return 'observe'; }
}
```
Update the header comment (no longer "observe by default"). (Lazy `require` avoids a load cycle; `getProjectSettings` is cheap + mtime-cached.)
- [ ] **Step 3: run → pass; full build; commit** `feat(memory): autosync mode follows memorySyncEnabled (default on)`.

## Task 3: `PUT /project-settings` passthrough + live apply

**Files:** modify `core/src/routes/core/project-settings.routes.ts`; test `core/src/__tests__/project-settings-memory-toggle.test.ts`

- [ ] **Step 1: failing test** — call the PUT handler with `{memorySyncEnabled:false, crossProjectSignpostEnabled:false}`; assert the response data reflects both; GET returns them. (Hermetic `LM_ASSIST_DATA_DIR`.)
- [ ] **Step 2: implement** — add both fields to the `saveProjectSettings({...})` call; after save, on a `memorySyncEnabled` change reset the autosync daemon (`require('../../memory/autosync').getAutoSyncDaemon()` — re-create/restart so the new mode takes), and on a `crossProjectSignpostEnabled` change call `startCrossProjectSignpost()` (enable) or stop the watcher (disable). Wrap in try/catch like the knowledge toggle.
- [ ] **Step 3: run → pass; commit** `feat(settings): /project-settings toggles memory sync + signpost (live apply)`.

## Task 4: Memory settings tab (web)

**Files:** modify `web/src/app/(dashboard)/settings/page.tsx` (+ a `MemoryTab.tsx` if the page is tab-componentized); manual + a light render check.

- [ ] **Step 1:** read `page.tsx` to learn the tab pattern (cf. `McpAccessTab.tsx`). Add a **Memory** tab.
- [ ] **Step 2:** the tab fetches `GET /project-settings` (via `workerFetch`/api-client — NOT raw fetch; see web-core-fetch-rules) + `GET /memory/sync/status`; renders two toggles (cross-project signpost, memory sync) that `PUT /project-settings` on change; shows the read-only status (node mode, peers, daemon mode + counts).
- [ ] **Step 3:** `cd web && PATH=…v20…/bin:$PATH npx next build` compiles (≥Node 20.9). Commit `feat(web): Memory settings tab (signpost + sync toggles + status)`.

## Task 5: Increment-1 verification — full core suite + web build; deploy 117 dev; smoke the toggles.

---

# INCREMENT 2 — git-remote peers + convergent auto-merge

> Detailed TDD steps authored at the start of Increment 2 (after Increment 1 ships). High-level task list:

- **2.1 `project-remote.ts`** — `projectRemoteKey(cwd)` (normalize `git remote get-url origin`) + tests (ssh/https/.git/trailing-slash/no-remote).
- **2.2 `/memory/projects-by-remote?key=`** route — this node's slugs for a remote key + test.
- **2.3 `peer-resolve.ts`** — resolve peer set `[{node,slug}]` from `list_nodes` + the by-remote lookup (pure matcher unit-tested; network part integration).
- **2.4 `merge3.ts`** — deterministic diff3 (base/local/peer) → {clean, merged} | {conflict, hunks}; base store under `<cwd>/memory/.sync-base/`; tests (clean union, overlapping conflict, no-base, fast-forward, identical).
- **2.5 `llm-merge.ts`** — agent-backed conflict resolver (sdk-runner); prompt = base+local+peer → coherent merged file; validate frontmatter; degrade to reconcile-plan on failure. Test with a mocked runner.
- **2.6 `ingest.ts` merge-on-ingest** — replace blind write with: base-aware merge (fast-forward / 3-way / LLM) into the LIVE dir; update base; dedup. Tests for each path + idempotent re-ingest.
- **2.7 `planPushBack` generalization + daemon peer push/pull** — push to every peer; pull+merge from peers on bootstrap/notify/periodic. Tests for the pure planner (persistent node WITH peers → push).
- **2.8 bootstrap + Memory tab** — `/memory/sync/enable` auto-resolves peers by remote; tab shows peers + merge/conflict counts.
- **2.9 Integration** — 3-node convergence test (diverge → converge; non-overlap no-LLM; overlap mocked-LLM; temporary/host-local excluded; idempotent).
- **2.10 Full suite + deploy fleet.**

## Self-review notes
- resolveMode lazy-requires project-settings to avoid an autosync↔settings load cycle — verify no cycle at build.
- Merge writes to LIVE memory — gate strictly by the exclusions; base-aware so non-conflicting edits never clobber; LLM failure must never lose data (degrade to reconcile-plan).
- Convergence must be idempotent: re-ingesting the merged content (hash == base) is a no-op (prevents notify storms).
