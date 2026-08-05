# Design: progressive (paged) `bootstrap`

## Problem

`bootstrap` (the lm-assist MCP tool that loads every use-case playbook in one call)
produces ~75 KB of text against the 64 KiB per-result ceiling enforced centrally by
`capToolResult` (`result-cap.ts`). The last ~15% is dropped on every call — the cut lands
inside `machine-access` and takes `claude-ai`, `account`, `login`, `github`, `files`,
`clusters` and the per-node auth+cluster blocks with it.

The current mitigation (a header paragraph naming the dropped topics, shipped on
`main`) is honest but leaves the tail genuinely unreachable except via `guide(topic=…)`.
This is backlog `bl_057c3e0b`.

Measured (2026-08-05, from the compiled `GUIDES`): header 1,952 B + 23 sections summing
68,652 B. Largest single section `ccr` = 9,904 B, `missions` = 9,529 B — comfortably
smaller than any per-page budget, so **whole-section page boundaries always fit**.

## Goal

Return `bootstrap` **progressively across pages**, each page comfortably under the
ceiling, so the whole playbook is reachable without any silent/marker truncation — while
preserving the tool's "you are now aware of everything" contract.

## Approach (chosen)

**Fat page 1 + manifest, section-boundary paging, adaptive to the live ceiling.**

- `bootstrap` gains one optional argument: `page` (integer ≥ 1, default 1).
- Pages are packed from **whole sections in `BOOTSTRAP_SECTION_ORDER`** — a section is
  never split across pages. Packing is greedy: fill a page with sections until the next
  would exceed the per-page content budget, then start a new page.
- **Page 1** (what the mandatory no-arg session-start call returns) =
  `fleetIdentity` + header + **manifest** + auth block + cluster block + the first run of
  full playbooks that fit + a page footer.
- **Page K ≥ 2** = a compact continuation header (`page K of N`, topics on this page) +
  the next run of full playbooks + a page footer.
- The **manifest** is a generated table of contents listing every topic, its one-line
  blurb (reused from `GUIDE_BLURBS`), and the page it is on — so page 1 alone makes the
  session aware of all topics even before any further page is pulled.
- The **page footer** on a non-final page names the next call
  (`bootstrap(page=K+1)`) and the topics it will bring; on the final page it says the
  bootstrap is complete. Both always remind that `guide(topic=X)` fetches any one topic.

Why section-boundary over byte-offset paging: boundaries are meaningful (a page is a set
of whole playbooks), the manifest can give exact page numbers, and no page ever cuts
mid-record — which is the whole failure mode we are removing.

### Adaptivity to the ceiling (important, not a nice-to-have)

The per-page content budget is derived from the **live** ceiling
(`maxResultBytes()`), not a hardcoded constant:

```
contentBudget = maxResultBytes() - WRAP_RESERVE
```

`WRAP_RESERVE` (a constant, ~12 KiB) covers the largest per-page wrapping
(fleetIdentity + header + manifest + auth + cluster + footer, measured < 8 KiB on page 1;
reserve is generous on purpose). Consequences, all desirable:

- Default ceiling (65,536) → `contentBudget` ≈ 53 KiB → **2 pages** today
  (page 1 ≈ 20 sections, page 2 ≈ the last 3 + auth/cluster already on p1).
- A node that **raises** `MCP_RESULT_MAX_BYTES` large enough → **1 page**, and the footer
  says "complete" with no `page=2` prompt. The old all-in-one behavior returns for free
  on hosts that opted into a bigger ceiling.
- A node with a **small** ceiling → more, smaller pages; each still valid.

### Invariant (the point of the whole change)

**Every assembled page is ≤ the ceiling**, so `capToolResult` never fires on a bootstrap
page. This is asserted by a test that caps every page and checks `size.truncated === false`.
Edge case: a *single* section larger than `contentBudget` (none exist today) becomes its
own page and could exceed the ceiling; it would then be centrally truncated with the
explicit marker and `guide(topic=…)` remains the fallback. A test pins that today's
content has no such section, so this stays a theoretical tail, not a live risk.

## Components (all in `core/src/mcp-server/tools/guide.ts`)

- `bootstrapEntries(lookup)` → `{ key, body }[]` — every section in order with
  content-override applied (extracted from today's `buildBootstrap`).
- `paginateEntries(entries, contentBudget)` → `string[][]` — **pure**, the greedy packer;
  returns the section-key groups per page. Order preserved; every key appears exactly once.
- `buildManifest(pages, lookup)` → `string` — the TOC (topic · blurb · page).
- `buildBootstrapPage(pageNum, { entries, pages, lookup, identity, auth, cluster, ceiling })`
  → `{ text, page, totalPages }` — assembles one page.
- `handleBootstrap(args)` — reads `page` (default 1, clamped to `[1, totalPages]`),
  computes ceiling via `maxResultBytes()`, assembles that page. Auth + cluster blocks are
  computed once and placed on **page 1** (node status belongs up front, next to
  fleetIdentity). Out-of-range `page` returns the last page with a note (never an error —
  a session-start auto-call must never hard-fail).

`buildBootstrap` (the current all-in-one) is kept as a thin wrapper = "all pages joined",
used only by tests and any internal caller, so existing behavior is expressible.

## Header + description changes

- `BOOTSTRAP_HEADER_DEFAULT` (content-overlayable as `bootstrap.header`): the
  "🔴 THE TAIL OF THIS RESPONSE IS CUT" paragraph is **replaced** by a short paragraph
  explaining paging + the manifest, and the FLOW mermaid updated to show
  `page 1 → (page 2 …) → act`. The override mechanism is unchanged; only the default text
  changes. Deploy note: verify no live `bootstrap.header` override in the assist-content
  registry still carries the old warning — if one exists, update or clear it, or the code
  default is shadowed.
- Tool description (`bootstrapToolDef`): document `page`, state that the no-arg call
  returns page 1 with a manifest and that further pages are pulled with `bootstrap(page=N)`.

## Testing

Replace the now-obsolete "bootstrap warns that its own tail is cut" test in
`guide.test.ts` (it asserted `size.truncated === true`) with:

- **page 1 is not truncated**: `capToolResult(bootstrap({}), 'bootstrap').size.truncated === false`.
- **every page is not truncated**: loop `page=1..N`, cap each, assert none truncated and none carry the `RESULT TRUNCATED` marker.
- **manifest completeness**: page 1 lists every topic in `BOOTSTRAP_SECTION_ORDER` with a page number.
- **coverage + no dupes**: the union of sections across all pages equals `BOOTSTRAP_SECTION_ORDER`, each exactly once, order preserved.
- **footer wiring**: a non-final page names `bootstrap(page=K+1)`; the final page says complete; both mention `guide(topic=…)`.
- **out-of-range page** (`page=999`) returns the last page, not an error.
- **raised ceiling collapses to one page**: with a large `MCP_RESULT_MAX_BYTES`, `totalPages === 1` and no `page=2` prompt.
- **pure packer** (`paginateEntries`): sections packed in order by budget; a tiny budget yields many pages; each page's byte sum ≤ budget (except a lone oversized section).
- **no oversized section today**: every section body < `contentBudget` at the default ceiling.

Update `guide-content-runtime.test.ts`: change its `bootstrapText` helper to concatenate
**all pages** (so section-override assertions don't depend on which page a section lands
on); the byte-identical-with-junk-overlay assertions then compare full concatenations.

## Out of scope / YAGNI

- No cursor/opaque-token paging — `page` integers are enough for static sectioned content.
- No prose trimming of the playbooks (a separate content decision; paging makes it
  unnecessary for correctness).
- No change to `guide(topic)` or `guide(index)`.
- No change to `capToolResult` — the central backstop stays exactly as is.

## Rollout

Fleet dataset content is untouched (code-only). Deploy the compiled `guide.js` to prod
nodes the same surgical way as the terminal work; refresh the connector tool cache per
node so the new `page` argument surfaces on the next session. Verify page 1 ≤ ceiling and
the manifest renders live.
