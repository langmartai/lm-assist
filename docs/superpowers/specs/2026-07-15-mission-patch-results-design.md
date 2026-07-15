# Mission patch: results writable + reject unknown fields (end silent-ignore)

**Mission:** mission_3922a14d · **Branch:** `feat/mission-patch-results` (from origin/main @ 37592c1)
**Status:** DESIGN — gated with Mission Controller before implementation.
**Provenance:** drafted by the prior executor (lost to a Core outage); re-verified claim-by-claim
against the code by the replacement executor 2026-07-15 — all facts confirmed, three refinements
folded in (marked ⟨rev2⟩): stronger problem statement, replace-entry `summary` optionality, per-entry
truncation in the shaped history diff.

## Problem

`handlePatch` (core/src/routes/core/mission.routes.ts:205, serving `POST|PATCH /mission/:id`)
whitelists fields implicitly: anything not matched is **silently dropped** with `success:true`.
Known instances of the class:

| Field | Status |
|---|---|
| `manageMode` | intentional human-only rail — keep (FORBIDDEN for controller) |
| `progress` | was silently ignored; fixed 2026-07-15 (validated `{percent,summary}`, human-only) |
| `results` | **still silently ignored** — controllers finish missions with `results` n=0 and must declare in chat that tooling can't write them; the wrap-flow docs (`workflow-defaults.ts` — design/impl/bugfix/deploy/wrapup.completed all say "record in mission results via mission_update") instruct a write that does nothing |

Two deliverables: (1) make `results` writable with explicit append/replace semantics,
(2) end the class — unknown fields now return `UNSUPPORTED_FIELD`, never silent success.

## Current model facts (studied)

- `MissionResult` = `{ at: number; ref: string; summary?: string }` (mission-model.ts:35); `Mission.results: MissionResult[]`, init `[]`.
- Only existing writer: `mirrorProgress()` (mission-store.ts:258) — `m.results.push(...)`, no validation, no actor on entries. ⟨rev2⟩ Its ONLY production caller (worker.routes.ts:87 telemetry) passes **progress only** — the `results` param defaults to `[]` — so today **nothing writes `results` in production at all**; every completed mission carries `results: []`. The wrap-flow gap is total, not partial.
- History: `TRACKED_FIELDS` (mission-history.ts:5) = title, objective, plan, nextSteps, projects, tags, parentId, dependsOn, status, env, manageMode. `results` NOT tracked → no rev bump / no change record today. `tags` has a per-dimension diff special-case (precedent for a shaped diff).
- Patch body always carries two meta keys via the MCP passthrough (`mission_update` forwards **all** args): `id` (duplicates the URL id) and `_actor` (transport hint, consumed+deleted by `actorFor()` at handler entry). Leader-anchoring proxies the raw body (incl. `_actor`) to the elected leader, which re-enters `handlePatch`.
- All existing callers use known fields only (full caller audit in the Out-of-scope ⟨rev2⟩ note); all test suites use known fields — except the whitelist-regression test (mission-patch-progress.test.ts:90) which **asserts the silent-ignore** of `control`/`interim` and must be flipped to assert loud rejection.

## Decisions

### D1 — Append is the primary write: `resultsAppend: entry | entry[]`

- Common case = add one completion record. Accepts a single entry object or an array.
- **Any actor may append** — controller included; this IS the wrap-flow fix.
- Server stamps `at` (caller-supplied `at`/`by` on append entries → rejected as unknown entry keys; no backdating).
- Each appended entry is **actor-attributed**: new optional model field `by?: MissionActor` on `MissionResult` (precedent: `MissionAdjustment.actor`). Telemetry path unchanged (its entries simply have no `by`).
- `resultsAppend: []` → INVALID_INPUT (a no-op append is a caller bug — loud, per mission spirit).

### D2 — Replace is explicit + human-only: `results: [...]` requires `resultsReplace: true`

- `results` is the mission's outcome/audit record → the model warrants protecting history (objective's option taken).
- `results: [...]` **without** `resultsReplace:true` → INVALID_INPUT with guidance ("use resultsAppend to add entries, or set resultsReplace:true to replace") — kills the likeliest footgun (controller sending `results:[...]` expecting append and wiping instead).
- `resultsReplace` must be `true` or `'true'` when present (connector coercion precedent of `env.exclusive`); any other value → INVALID_INPUT naming it. Present (any value) **without** `results` → INVALID_INPUT.
- `results` + `resultsAppend` in one body → INVALID_INPUT (ambiguous).
- Replace is **human-only** (controller → FORBIDDEN), same rail style as manageMode/progress. Controller keeps append, which is all the wrap flow needs; destructive curation is a human act.
- Replace entries MAY carry `at` (number, preserved; absent → stamped now) and `by` (preserved) so read-modify-write curation round-trips. `results: []` with the flag = explicit clear, allowed (history records the wiped content — recoverable).

### D3 — Entry validation (patch path)

- Entry must be a plain object; **unknown entry keys rejected** (same anti-silent-drop spirit; catches `refs` typo'd for `ref`). Allowed keys: append `{ref, summary}`; replace `{ref, summary, at, by}`.
- `ref`: required non-empty string, ≤ 500 chars (both paths).
- `summary` ⟨rev2, split by path⟩: **append → required** non-empty string ≤ 2000 (a fresh completion record must say what was delivered; the wrap flow's whole point). **Replace → optional**, validated (non-empty string ≤ 2000) when present — REQUIRED would break read-modify-write round-trips of legacy/telemetry-era entries that lack `summary`. Model keeps `summary?` optional.
- `at` on replace entries: coerced `Number()`, must be finite > 0 (connector stringifies numbers); absent → stamped now.
- `by` on replace entries: accepted as-is when a plain object (audit metadata round-trip; not deep-validated), else rejected.
- Caps: ≤ 20 entries per call; total `results` length ≤ 100 → INVALID_INPUT beyond.
- Connector tolerance: `results`/`resultsAppend` arriving as a JSON **string** is parsed first (precedent: `arr()` helper; MCP connector stringifies args). A string that fails to parse → INVALID_INPUT — never the `arr()`-style silent skip.
- Validation is atomic: the whole block validates before any mutation of `m.results`.
- Robustness: `withActorBackfill` gains `if (!Array.isArray(m.results)) m.results = []` (legacy records; also protects `mirrorProgress`'s bare `.push`).

### D4 — `UNSUPPORTED_FIELD` contract (end the class)

- `SUPPORTED_PATCH_FIELDS` = `title, objective, plan, nextSteps, dependsOn, projects, tags, parentId, status, manageMode, progress, env, binding, results, resultsAppend, resultsReplace`.
- Tolerated meta keys (not "fields", used or consumed, never dropped): `_actor` (transport hint), `id` (MCP passthrough — validated `body.id === URL id`, mismatch → INVALID_INPUT).
- Check runs in `handlePatch` after leader-anchor + actor resolution, **before any mutation** (fail-fast; a body mixing valid+unknown applies nothing).
- Error: `UNSUPPORTED_FIELD`, message names every offender AND lists the supported set, e.g.
  `unsupported field(s): "control", "interim" — supported: title, objective, plan, nextSteps, dependsOn, projects, tags, parentId, status, manageMode, progress, env, binding, results, resultsAppend, resultsReplace`.
- Intentional rails keep their specific codes: manageMode human-only → FORBIDDEN; binding on onboarded mission for controller → FORBIDDEN; progress for controller → FORBIDDEN; replace for controller → FORBIDDEN (new, D2).

### D5 — History: `results` joins TRACKED_FIELDS with a shaped diff

- `TRACKED_FIELDS` += `'results'` → any results change (patch OR telemetry path) bumps `rev`, sets `lastUpdatedBy`, records a `MissionChange` with actor, spills to the durable history dataset. This is "history-tracked like other TRACKED_FIELDS".
- Diff shape special-cased in `diffMission` (tags precedent) to avoid duplicating a monotonically-growing array on every append:
  - pure append: `changes.results = { from: { count: old }, to: { count: new, appended: [entries] } }` — compact, content visible.
  - replace/other: `changes.results = { from: { count, entries: old }, to: { count, entries: new } }` — a destructive replace is recoverable from history.
  - ⟨rev2⟩ Every entry in a shaped diff passes through the existing `trunc` per string field (`ref`/`summary` capped at 500 chars in the HISTORY record only; `m.results` keeps full content). Bounds the inline mission record: without it a max-size replace (100 × 2.5KB × from+to = ~500KB per change, ×50 inline cap) could bloat every `listMissions` read. Recovery trade-off accepted: refs round-trip fully (≤500 by validation); only summary tails >500 are lost in history.
- `control`/`interim`/`progress` tracking status unchanged (out of scope).

### D6 — Consumers (requirement 3)

- `mission_update` MCP handler already forwards all args → `results`/`resultsAppend`/`resultsReplace` pass through with zero handler change. Its `inputSchema` + description gain the three fields (so the controller LLM discovers them) — description states: append for completion records; replace is human-only.
- **Report note (doc evolution is out of my scope):** wrapup.completed's "tooling cannot write results" workaround clause becomes obsolete; the default docs' existing "record in results via mission_update" instructions start actually working. ⟨rev2⟩ The workaround clause lives in the LIVE registry copy of wrapup.completed (mission-workflows dataset), not `workflow-defaults.ts` — the shipped default already instructs the write this change makes real.

## Alternatives considered (rejected)

- **Overload `results: entry` as append** — ambiguous with replace, exactly the footgun D2 kills; explicit `resultsAppend` is self-describing for the controller LLM.
- **Controller-allowed replace** — an LLM wiping the outcome/audit record on a misread is the risk the flag exists for; append covers the whole wrap flow, curation stays human.
- **Dedicated `POST /mission/:id/results` route** — cleaner REST but the consumer contract is `mission_update` passthrough (objective req 3); a new route would need its own MCP tool + leader anchoring for no added capability.

## Test plan (red-first, node:test, memPort conventions — deep-clone port for history assertions)

New `core/src/__tests__/mission-patch-results.test.ts`:
1. append single entry → stored `{at stamped, ref, summary, by:=actor}`; rev bumped; history change has actor + compact appended diff.
2. append array; controller actor CAN append (wrap flow).
3. append validation: missing/empty/oversize ref & summary; non-object entry; unknown entry key (incl. `at`/`by` on append); empty array; per-call cap (>20); total cap (>100); nothing applied on rejection.
4. replace with flag (human): replaces; preserves given `at`/`by`; stamps missing `at`; `results: []` clears; history carries from/to entries (per-field trunc'd per D5).
5. replace rails: no flag → INVALID_INPUT; flag without results → INVALID_INPUT; results+resultsAppend → INVALID_INPUT; controller replace → FORBIDDEN.
6. UNSUPPORTED_FIELD: unknown field named + supported list in message; mixed valid+unknown applies nothing; `control`/`interim` now rejected; `id` (matching) + `_actor` tolerated; `id` mismatch → INVALID_INPUT.
7. JSON-string bodies for results/resultsAppend (connector) parse correctly.

Updated: mission-patch-progress.test.ts:90 whitelist-regression test flips to expect UNSUPPORTED_FIELD (its intent — "telemetry not patchable" — strengthened from silent to loud).

Gates: `./core.sh build` (tsc clean) + mission test files + full `npm test` suite; evidence via test output (live :3100 not touched; deps-injected per workspace rules). Optional: one curl round-trip against a scratch-port serve of this build if cheap.

## Out of scope (noted residuals, unchanged behavior)

- Type-mismatch silent-skips on legacy fields (`title: 42` still skipped by `str()`); `handleCreate` unknown fields; `binding.kind` silent default to 'worker'; `progress` not history-tracked. Same class-adjacent items, separate scope — listed for the record.
- ⟨rev2⟩ Reserved records are patchable by id (`POST /mission/__controller__` — `getMission` doesn't filter `RESERVED_IDS`, only `listMissions` does). Pre-existing quirk, orthogonal to results; noted for the record.
- Web UI results editor; workflow doc evolution (human/controller).
- ⟨rev2⟩ Verified all existing patch callers use supported fields only, so the rejection breaks nobody: web `MissionDetailView.tsx` sends `{title,objective,plan,nextSteps}` / `{status}`; `MissionsPage.tsx` sends `{objective}` / `{status}` / `{binding:null}`; `mission_update` MCP forwards its schema'd args; no other server-side `handlePatch` callers exist (routes :1834/:1836 only).

## Files touched

| File | Change |
|---|---|
| core/src/mission/mission-model.ts | `MissionResult.by?`, caps consts, pure `validateResultsPatch()` helper, `withActorBackfill` results guard |
| core/src/mission/mission-history.ts | TRACKED_FIELDS += results; shaped diff special-case |
| core/src/routes/core/mission.routes.ts | SUPPORTED set + UNSUPPORTED_FIELD pre-flight + id-match + results block in handlePatch |
| core/src/mcp-server/tools/mission.ts | mission_update schema/description |
| core/src/__tests__/mission-patch-results.test.ts | new suite |
| core/src/__tests__/mission-patch-progress.test.ts | flip whitelist-regression test |
