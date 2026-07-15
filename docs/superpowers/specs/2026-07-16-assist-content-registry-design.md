# Assist Content Registry — editable bootstrap/guide content + /assist-content editor page

**Mission:** mission_02694681 · branch `feat/bootstrap-content-editor` (cut from origin/main `02c3aa8`)
**Date:** 2026-07-16 · **Status:** APPROVED (controller gate, with guardrails) — implementing

Gate guardrails applied: (1) generalization boundary clean + explicitly stated in the final
report — mission.routes moves FULLY onto the shared origin-anchor (no half-migration),
workflow-store persistence cleanly unchanged; (2) enumeration exhaustive — every editable
content string both tools emit maps to a doc id/field (see §3 inventory; BLURB one-liners
became `blurbOverride`); (3) existing mission-route + workflow-store suites run as an
explicit regression gate over the shared-anchor change.

Make the `bootstrap` and `guide` MCP tools' hard-coded content strings editable fleet-wide —
the same treatment the mission process docs and the MCP tool registry got — by **reusing and
generalizing the just-merged MCP-tool-registry machinery**, not by forking a third copy of the
store pattern.

---

## 1. What exists today (the reuse targets)

| Piece | File | Role |
|---|---|---|
| Tool registry model | `core/src/mcp-server/registry/model.ts` | pure doc/change types, validation, PROTECTED_TOOLS |
| Tool registry store | `core/src/mcp-server/registry/store.ts` | dataset-backed CRUD + inline full-state history + rollback + per-name write locks; port seam for tests; **reads never create the dataset** |
| Overlay (pure) | `registry/overlay.ts` | apply deltas to code defaults; fail-open |
| Overlay provider (in-proc) | `registry/overlay-live.ts` | TTL 1.5 s store reads + `invalidateOverlayCache()` |
| Overlay provider (stdio) | `registry/overlay-http.ts` | `GET /mcp-tools/overlay`, TTL 5 s |
| Catalog | `registry/catalog.ts` | code-derived name → def/category/module map + completeness-test contract |
| Routes | `routes/core/mcp-tools.routes.ts` | list/overlay/get/set/history/rollback; **origin-anchored writes** (`_originHop`, fail-closed, refusals relayed verbatim) |
| Workflow registry | `mission/workflow-store.ts` + `routes/core/mission.routes.ts` | the OTHER consumer of the shape (snapshot-dataset history, editPolicy, 64 KiB bodies) — including an **older, lossier copy of the origin-anchor** |
| Web tool page | `web/src/components/mcp-tools/*`, `web/src/lib/mcp-tools.ts` | list + detail tabs, rev-conflict guard idiom |
| Web process page | `web/src/components/mission-processes/*`, `web/src/lib/mission-process.ts` | **the UX to replicate verbatim**: grouped list, Rendered/Raw/Edit/History tabs, conflict banner, ConfirmButton rollback |

Content source: `core/src/mcp-server/tools/guide.ts` — `GUIDES` (23 topic bodies), `BLURB`
(index one-liners), `TOPIC_TOOLS`/`ALIASES` (resolution), module-load constants `INDEX`
(`buildIndex()`: preamble + golden rules + generated topic list) and `BOOTSTRAP`
(`buildBootstrap()`: preamble header + 22 ordered topic sections; `mission-controller` is
deliberately excluded from bootstrap). Dynamic blocks (fleet identity, auth, cluster) are
computed per call and are NOT content.

Dispatch fact (verified): **guide/bootstrap only ever execute in the Core process** — the
stdio plugin forwards them via `POST /mcp-call` (`EXPANDED_HANDLERS` → `mcpGenericCall`), and
HTTP `/mcp` dispatches in-process. So the content overlay needs only an **in-process
provider**; no stdio HTTP provider is required (unlike the tool overlay, which gates
tools/list inside the stdio binary itself).

## 2. Generalize in place — what is shared, what is new, what is refactored

**A third copy is avoided by extracting the two genuinely copy-shaped layers and instantiating
both consumers on them:**

### 2a. Generic overlay-doc store (core)

- **NEW `core/src/mcp-server/registry/doc-model.ts`** — pure generic types, NO IO imports
  (stdio-graph-safe; `model.ts` is imported by `overlay.ts` → `configure.ts` → stdio binary):
  `OverlayChange<S>`, `OverlayDoc<S>` (flattened persisted shape `{name, ...S, rev, history,
  createdBy, lastUpdatedBy, createdAt, updatedAt}` — byte-identical to today's persisted
  `ToolRegistryDoc`), `OverlayDocPort<S>`, `Validation`, shared `lenOf`/changed-diff helpers.
- **NEW `core/src/mcp-server/registry/doc-store.ts`** — generic store factory
  `createOverlayDocStore<S>(spec)` with spec = `{dataset, datasetTitle, label, historyCap,
  validateName, fields: [{key, validate, defaultValue, summarize?}], refuseWrite?}`.
  Carries over verbatim from today's `store.ts`: write-only `ensureDataset` (reads NEVER
  create — the fleet-split lesson), coded throws (`DATA_SERVICE_DISABLED`,
  `DATA_WRITE_FAILED`), per-name write locks, merge semantics, inline full-state history
  capped at `historyCap`, rollback-as-new-rev.
- **REFACTOR `registry/store.ts`** → thin instantiation of the generic store with
  `S = {descriptionOverride, enabled}` + `refuseWrite` = PROTECTED_TOOLS check. **Public API
  unchanged** (`getToolDoc/listToolDocs/putToolDoc/rollbackToolDoc`, `ToolRegistryPort`,
  `TOOL_REGISTRY_DATASET`); `model.ts` keeps its exported names (types become aliases of the
  generic ones; PROTECTED_TOOLS/validators stay). Existing tests
  (`mcp-tool-registry-{model,store,liveport}`, `mcp-tools-routes`, runtime, overlay) must pass
  unmodified — they are the no-regression proof.
- **NEW `registry/content-model.ts`** — `ContentState = {contentOverride: string | null,
  blurbOverride: string | null}` (gate guardrail 2: the BLURB one-liners are content the
  guide index emits, so they are editable too — on the owning topic's doc, not a separate
  id), `MAX_CONTENT_OVERRIDE_BYTES = 16384`, `MAX_BLURB_OVERRIDE_BYTES = 300` (single line),
  id grammar `/^(bootstrap|guide)\.[a-z0-9][a-z0-9.-]{0,80}$/` (reject `..`, trailing
  `.`/`-`), no protected set (content cannot be disabled; worst case is bad prose,
  restorable in one call). `blurbOverride` is refused for known units that carry no blurb
  (`bootstrap.header`, `guide.index`); scratch/unknown docs accept both fields (never
  rendered anyway).
- **NEW `registry/content-store.ts`** — instantiation: dataset **`assist-content-registry`**
  (cache backend, `visibility:'cross-node-readable'`, `syncMode:'full'`, `scope:'fleet'` —
  the exact tool-registry/workflow descriptor), history cap 20. Worst-case record ≈ 20×16 KiB
  ≈ 340 KiB < the ~1 MiB record cap.
- **NEW `registry/content-catalog.ts`** — code-derived enumeration (catalog.ts precedent),
  imports the exported defaults from `guide.ts`:
  `getContentCatalog(): Map<id, {id, group:'bootstrap'|'guide', key, title, blurb?,
  defaultBody, renderedIn:('bootstrap'|'guide')[]}>`.
- **NEW `registry/content-live.ts`** — in-process provider mirroring `overlay-live.ts`:
  `sharedContentOverlay().get()` → `Map<id, override>` (TTL 1.5 s, fail-open null),
  `invalidateContentOverlayCache()` called by the write routes.

### 2b. Shared origin-anchor (routes layer)

- **NEW `core/src/routes/core/origin-anchor.ts`** — extracts the **improved** mcp-tools
  variant: `OriginAnchorDeps`, `createDatasetOriginAnchor(datasetId, label)` (hub proxy that
  parses non-2xx bodies so origin refusals relay verbatim), `anchorToOrigin(deps, path, body,
  label)` with the `_originHop` loop guard + fail-closed `ORIGIN_UNREACHABLE`, and the
  `isRegistryEnvelope` guard.
- **REFACTOR both existing consumers onto it:** `mcp-tools.routes.ts` (drop its local copy)
  and `mission.routes.ts` (drop its older copy — this **upgrades workflow writes** to the
  verbatim-refusal semantics the tool registry already shipped; e.g. a HUMAN_ONLY_DOC refusal
  from the origin surfaces as itself instead of ORIGIN_UNREACHABLE). Existing
  `*-origin-anchor` tests keep their injected-deps seams; assertions that pinned the old lossy
  workflow behavior are updated deliberately and documented in the commit.

**Deliberately NOT refactored:** `mission/workflow-store.ts` persistence (snapshot-dataset
history, editPolicy, seeded defaults — a different, live-fleet-critical shape). The
no-third-copy constraint is satisfied at the two layers that were about to be copied a third
time: the doc store and the origin anchor. Workflow persistence unification stays a flagged
follow-up (the ensure-on-read fix there is already queued fleet work).

### 2c. Web reuse

- **Imports, not copies:** `ConfirmButton`/`errText`/`timeAgo` (`components/memory/format`),
  `MarkdownSplitEditor` (`components/missions`), `MermaidBlock`
  (`components/mission-processes`), `checkRevConflict` (`lib/mission-process`),
  `truncateDescription` (`lib/mcp-tools`).
- **NEW `web/src/lib/assist-content.ts`** (pure, vitest'd): row/detail types,
  `groupContentUnits` (bootstrap group vs guide group, server order preserved),
  `contentBadges` (override/rev/renderedIn), byte formatting.
- **NEW `web/src/components/assist-content/{AssistContentPage,ContentDetail}.tsx`** — page
  modeled verbatim on `MissionProcessesPage`/`ProcessDetail` (same layout constants, same
  tab set, same conflict-banner + rollback UX), detail semantics from `ToolDetail` (override
  vs default, Restore-default as two-click ConfirmButton).
- Page/detail shells stay page-specific by design: the three detail panes have genuinely
  different data models; the shared skeleton lives in the imported primitives + pure libs.
  (Extracting a generic "RegistryDetailShell" would refactor two shipped pages for no
  behavioral gain — rejected as churn, recorded here.)

## 3. Content doc ids — enumerated FROM the code, stable

One doc per bootstrap-specific section and per guide topic. 25 units total:

- **`bootstrap.header`** — the bootstrap preamble (title + intro paragraph of
  `buildBootstrap`). Group `bootstrap`, renderedIn `[bootstrap]`.
- **`guide.index`** — the guide-tool no-arg output's preamble + golden rules (everything
  `buildIndex` emits before the generated `## Topics` list). Group `guide`, renderedIn
  `[guide]`.
- **`guide.<topic>`** — one per `GUIDES` key (23): `orientation`, `cross-node`, `connectors`,
  `access-paths`, `workflows`, `roles`, `install`, `data`, `sessions`, `knowledge`, `agents`,
  `terminals`, `ccr`, `nodes`, `claude-ai`, `account`, `github`, `files`, `missions`,
  `login`, `clusters`, `mission-controller`, `machine-access`. Group `guide`; renderedIn
  `[guide]` plus `bootstrap` for the 22 in the bootstrap section order (all except
  `mission-controller`).

**Composition stays code-owned; prose is overridable — exhaustively (gate guardrail 2).**
The full inventory of static content the two tools emit and where each piece lands:

| Emitted content | Doc id / field |
|---|---|
| bootstrap preamble | `bootstrap.header` · contentOverride |
| each bootstrap section body (22) | `guide.<topic>` · contentOverride (shared with guide) |
| guide topic bodies (23) | `guide.<topic>` · contentOverride |
| guide index preamble + golden rules | `guide.index` · contentOverride |
| index topic one-liners (BLURB, 23) | `guide.<topic>` · **blurbOverride** |
| bootstrap/guide TOOL descriptions | already editable via the MCP-tool registry |

Deliberately code-owned (stated, not silent): section order + the `## Topics` scaffolding
(composition), `ALIASES`/`TOPIC_TOOLS` (resolution tables, not prose), the unknown-topic
error template, and the DYNAMIC status blocks (fleet identity, auth block, cluster block —
live status rendering, not onboarding prose). Defaults always come from code; the registry
stores overrides only; absence of doc = pure default. **Unknown ids are writable
(scratch/mixed-version) but NEVER rendered** — they list as orphans on the page, exactly
like tool-registry orphan docs.

## 4. Runtime — override ?? default, live, no restart

`guide.ts` restructuring (its top-level import graph must stay stdio-light):

- Export the default pieces: `GUIDE_TOPIC_KEYS`, `BOOTSTRAP_SECTION_ORDER`,
  `BOOTSTRAP_HEADER_DEFAULT`, `INDEX_PREAMBLE_DEFAULT`, `GUIDE_BLURBS`, plus the existing
  `GUIDES_TEST_EXPORT` (kept).
- Replace module-load `INDEX`/`BOOTSTRAP` constants with `buildIndex(lookup)` /
  `buildBootstrap(lookup)` where `lookup(id) => override | undefined`; a precomputed
  default-composition fast path keeps the no-override case byte-identical to today (existing
  guide/bootstrap tests guard this).
- `handleGuide`/`handleBootstrap` obtain the overlay via **lazy `require` of `content-live`
  inside the handler** (the established `authBlock()` pattern in this same file) with
  try/catch → null ⇒ pure defaults. Fail-open like the tool overlay: content is a management
  layer, not a security boundary.
- `guide(topic)` returns `lookup('guide.'+key) ?? GUIDES[key]`; the `connectors` fleet-identity
  prepend, the unknown-topic fallback, aliases, and substring matching are unchanged.
- Bootstrap output = fleetIdentity + (bootstrap.header override ?? default) + sections in code
  order, each (guide.<topic> override ?? default) + auth/cluster blocks. `withOriginTag` and
  `enrichBootstrapWithIdentity` post-processing (provenance/footers) untouched.
- Writes on this node call `invalidateContentOverlayCache()` → next call renders the edit
  (same freshness contract as tool overlay: TTL 1.5 s cross-node reads, immediate locally).

## 5. REST surface — `routes/core/assist-content.routes.ts`

Mirrors `mcp-tools.routes.ts` (bare envelopes + `toApi`, handlers port-injected for tests):

| Method | Path | Behavior |
|---|---|---|
| GET | `/assist-content` | catalog joined with docs: units (id/group/key/title/renderedIn/defaultBytes/hasOverride/overrideBytes/rev/lastUpdatedBy/updatedAt), orphanDocs, counts |
| GET | `/assist-content/overlay` | `{byId: {id: override}}` (debug/parity) |
| GET | `/assist-content/:id` | `{id, knownUnit, group?, title?, renderedIn?, defaultBody, doc, effectiveBody}` |
| POST | `/assist-content/:id` | write `{contentOverride: string\|null}` — **origin-anchored** via the shared anchor, `_originHop` guard, fail-closed; invalidates the live cache |
| GET | `/assist-content/:id/history` | reversed inline history |
| POST | `/assist-content/:id/rollback` | `{toRev}` — origin-anchored, restores that rev's full state as a new rev |

Reads LOCAL (defaults are code-owned per node; replica syncs fleet-wide), writes
ORIGIN-anchored — the workflow/tool-registry pattern exactly.

**Relay allow-list:** add `'/assist-content'` to `ApiRelayHandler.ALLOWED_API_PREFIXES` — the
mandatory checklist item from the mcp-registry max-review (cross-node writes/reads die 400 at
the relay without it) — with a `relay-assist-content-allow` test.

No new MCP tools (parity with the tool registry: the management surface is REST/web; the
model.ts precedent comment applies).

## 6. Editor page — `/assist-content` (sidebar: "Assist Content")

- `web/src/app/(dashboard)/assist-content/page.tsx` shell + Sidebar entry (BookText icon),
  after "MCP Tools".
- **List (left, 320 px):** two groups — `bootstrap` (bootstrap.header) and `guide`
  (guide.index + 23 topics, server order). Each row: mono id, title, badges — `rev N`
  (stored) / `default` (un-stored), `override` when overridden, `§bootstrap` renderedIn
  marker on topics included in bootstrap; last-edit actor + timeAgo when stored. Header bar:
  counts (units · overridden · orphans) + Refresh. Orphan docs listed in a trailing
  `orphans` group (id + rev, no default).
- **Detail (right) — mission-processes tabs verbatim:** provenance bar (id, title, rev/default
  badge, renderedIn badges, last edit) + `Rendered / Raw / Edit / History`:
  - Rendered: effectiveBody through ReactMarkdown + remarkGfm (+ MermaidBlock idiom); for
    `guide.index` a hint that the topic list below it is generated.
  - Raw: effectiveBody in a mono pre.
  - Edit: MarkdownSplitEditor prefilled with override ?? default; Save disabled until dirty;
    **save re-GETs and refuses on rev advance** (conflict banner with reload-discard action —
    ProcessDetail verbatim); byte counter vs the 16 KiB cap; **Restore default** as a
    two-click ConfirmButton posting `contentOverride: null` (kept revision-trailed).
  - History: rev table (rev/when/actor/override-bytes-or-“cleared”/current badge) +
    Rollback ConfirmButton on non-current revs.
- Writes apply the origin's returned doc directly (ToolDetail's `applyDoc` idiom — a re-GET
  on a non-origin node would read the lagging replica and make the save look dropped).

## 7. Tests (red-first) + gates

Core (`core/src/__tests__/`, node:test, mirroring the tool-registry suite):
- `content-registry-model.test.ts` — id grammar (accept all 25; reject bad prefix/`..`/
  trailing junk/oversize), override cap, changed-check.
- `content-registry-store.test.ts` — put/merge/no-op/rev/history-cap/rollback/forged-history,
  DATA_SERVICE_DISABLED + write-refusal propagation, via fake port against the **generic**
  store instantiation.
- `content-catalog.test.ts` — **enumeration completeness**: catalog ids ==
  {bootstrap.header, guide.index} ∪ {guide.<k> ∀ k ∈ GUIDES}; every bootstrap section maps
  to a catalog unit with renderedIn ∋ bootstrap; ids match the grammar.
- `guide-content-runtime.test.ts` — override wins / null falls back / **unknown ids ignored**
  (overlay with `guide.zz-e2e-probe` + `bootstrap.nonsense` ⇒ output byte-identical to
  defaults); bootstrap composes header + section overrides; index preamble override; footers
  untouched (handler-level, provider injected).
- `assist-content-routes.test.ts` — list/get/set/history/rollback envelopes, knownUnit vs
  orphan, strict input validation, invalidate hook called.
- `assist-content-origin-anchor.test.ts` — hop guard, fail-closed, refusal-envelope
  passthrough (shared-anchor behavior for the new dataset).
- `relay-assist-content-allow.test.ts` — allow-list includes `/assist-content`.
- Existing tool-registry + workflow suites re-run green post-refactor (the no-regression
  proof for 2a/2b; any workflow-anchor assertion updates called out explicitly).

Web (vitest): `web/src/lib/__tests__/assist-content.test.ts` — grouping, badges, byte/cap
formatting (conflict check is the imported, already-tested `checkRevConflict`).

Gates: core `npx tsc` clean (baseline), node:test in ~30-file batches (full-suite OOM
gotcha), web vitest, `next build` from the worktree, all services on my own ports.

## 8. E2E (isolated — the live core :3100 and the fleet registry are never touched)

Isolated-HOME core from this worktree's build: `HOME=<scratch> node core/dist/cli.js serve
--port 3297` (own free port; 3299 & friends are busy per workspace rules), dataServiceEnabled
seeded directly in the scratch project-settings (known gotcha: default FALSE, not
route-writable). Web `next start` on 3946 pointed at :3297 for a page-served check (browser
tools off → curl HTML + API transcripts are the evidence).

1. `GET /assist-content` → 25 units, 0 overridden.
2. **Real-topic round-trip (isolated, then rolled back):** POST override on
   `guide.machine-access` → rev 1 → **MCP evidence**: `POST /mcp` initialize + tools/call
   `guide(topic="machine-access")` returns the override text (footer intact) and `bootstrap`
   contains it — live, no restart; also override `bootstrap.header` and see it lead the
   bootstrap output. Then restore default (`contentOverride:null` → rev 2, effective ==
   default, verified via guide again) — full trail retained in history.
3. **Scratch/orphan doc:** POST `guide.zz-e2e-probe` → created, orphan-listed,
   `guide("zz-e2e-probe")` does NOT serve it (index fallback), bootstrap unchanged; exercise
   history + rollback on it.
4. History + rollback: roll `guide.machine-access` back to rev 1 (override returns), then to
   rev 2/default — assert each step via `GET .../history` and a live guide call.
5. Report the exact final registry state (docs + revs) in the final report.

## 9. Risks / decisions

- **Byte-compat of default output** — no-override composition must equal today's strings;
  existing guide/bootstrap tests + a dedicated assertion pin it.
- **stdio import graph** — generic types split into pure `doc-model.ts`; `content-live`
  reached only via lazy require inside handlers (authBlock precedent). The stdio binary keeps
  serving defaults if Core is unreachable — same fail-open stance as the tool overlay.
- **Mixed-version fleet** — old builds ignore the dataset entirely (defaults); writes anchor
  to the dataset origin as usual. No seeding, so no split-brain surface; reads never create.
- **Workflow anchor upgrade** — behavior change limited to error-surfacing on origin refusals
  (strictly better; the exact defect class the tools max-review fixed); covered by updated
  origin-anchor tests.
- Out of scope: BLURB/alias/TOPIC_TOOLS overrides, MCP write tools for content, workflow-store
  persistence unification, `LM_ASSIST_INSTRUCTIONS_BODY` (connector instructions ≠
  bootstrap/guide content).
