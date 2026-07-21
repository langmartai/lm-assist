# Backlog / feature-idea GRAPH — design (mission_0656cd21, 2026-07-21)

A fleet-synced, versioned registry of NOT-YET-IMPLEMENTED ideas/features/issues/bugs/tasks
("backlog items") forming a typed graph, managed from any session via MCP tools on both
surfaces, with a /backlog graph UI reusing the mission-graph machinery. Complements
missions: missions = work being executed; backlog = ideas not yet turned into work.

## Reuse map (no reinvention)

| Need | Reused from | How |
|---|---|---|
| Versioned JSON meta docs, rev-history, rollback, write locks, dataset creation on write path only | `core/src/mcp-server/registry/doc-store.ts` (`createOverlayDocStore`) — the SAME factory behind the mcp-tool + assist-content registries | third instantiation: `registry/backlog-store.ts` with `BacklogState` field specs |
| Fleet dataset + cross-node sync | dataset descriptor family the factory already writes (`cache` backend, `cross-node-readable`, `syncMode:'full'`, `scope:'fleet'`) | dataset id **`backlog`**; created by the FIRST WRITE (origin = first writer). **NOT added to `system-datasets.ts`** — boot-time `registry.create` on every node would make every node a local owner → permanent split-brain (known catch (b): reads must NEVER create the dataset; neither must boot). |
| Origin-anchored writes | `routes/core/origin-anchor.ts` (shared by workflow/tool/content registries) | `realOriginAnchor('backlog')`; every write handler does the `_originHop` / `anchorToOrigin` dance verbatim (assist-content.routes idiom) |
| Actor attribution + caller session identity | `mission/mission-actor.ts` `resolveMcpActor` (+ `_actor` transport hint via `withActorHint`) | writes attributed like missions; `backlog_discuss` derives `{sessionId, sessionKind}` from the resolved actor (`local-session`→`code`, `claudeai-conversation`→`conversation`) |
| Hub relay reach | `hub-client/api-relay-handler.ts` | add **`/backlog`** to `ALLOWED_API_PREFIXES` (known catch (a)) + relay-allow test mirroring `relay-assist-content-allow.test.ts` |
| MCP tools, both surfaces | `tools/mission-workflow.ts` pattern (defs + handlers via `_passthrough` workerGet/workerPost) | new `tools/backlog.ts`; spread into `EXPANDED_TOOL_DEFS`/`EXPANDED_HANDLERS`; entries in `TOOL_SCOPES` (boot assert) + `registry/catalog.ts` (completeness test) |
| Graph UI | `web/src/lib/mission-layout.ts` (pure — used as-is) + `MissionGraphCanvas` HTML-cards-in-one-CSS-transform-div pattern (pan/pinch/fit, border-point edges) | new `components/backlog/*` modeled on `missions/dashboard/*`; mission components untouched (zero regression surface) |

## Item model

Doc = `OverlayDoc<BacklogState>` (name/rev/history/createdBy/lastUpdatedBy/createdAt/updatedAt
from the factory). API serialization aliases `id = name`, `version = rev` (mission meta schema).

```ts
BacklogState = {
  title: string;            // ≤300 chars, required at create
  description: string;      // markdown, ≤16384 bytes (content-registry cap)
  type: 'idea'|'feature'|'issue'|'bug'|'task';                        // default 'idea'
  status: 'open'|'discussing'|'accepted'|'deferred'|'rejected'|'planned'|'implemented'; // default 'open'
  priority: 'low'|'med'|'high'|'critical';                            // default 'med'
  tags: string[];           // ≤20, each ≤40 chars, normalized+deduped
  edges: { to: string; kind: 'depends-on'|'blocks'|'relates-to'|'parent-of'|'duplicate-of'|'spawned-mission' }[]; // ≤100, no self-edges, deduped
  discussion: { sessionId: string; sessionKind: 'conversation'|'code'|'remote'|'web'|'api'; note: string; at: number; label?: string }[]; // note ≤4000; capped last 200
  reviews: { by: string; verdict: 'approve'|'reject'|'concerns'; note?: string; at: number }[]; // capped last 100
  removed: boolean;         // SOFT delete (default false)
}
```

- **Ids**: generated `bl_<8 lowercase hex>`; grammar `/^bl_[a-z0-9]{4,16}$/`. Create is
  atomic create-if-absent via `mutate` (collision → coded `ID_COLLISION`).
- **`sessionKind`**: the mission's 3 kinds (`conversation|code|remote`) are what MCP callers
  resolve/declare; `web|api` cover management-UI/plain-API notes so entries never lie.
  Remote/CCR callers can't be resolved from local caches — the tool doc tells them to pass
  `sessionId` + `sessionKind:'remote'` explicitly; auto-resolution yields the other two.
- **Remove = soft delete** (`removed:true` as a normal rev): keeps rev-history + revert
  working, and sidesteps cross-node deletion-propagation semantics (sync is reconcile/PULL —
  upsert-shaped). List/graph exclude removed unless `includeRemoved`. Restore = another rev.
- **historyCap 20** (content-registry precedent); array fields summarized as `n:<len>` in the
  `changes` diff (full state still in `history[].state` so rollback restores everything).

## Two additive doc-store factory extensions (shared, backward-compatible)

1. `OverlayFieldSpec.equals?(a,b)` — per-field equality for change detection + the changes
   diff. Default stays strict `!==`, so the tool/content registries are bit-for-bit
   unchanged. Backlog array fields use JSON equality → repeated identical writes stay
   `changed:false` instead of minting junk revs.
2. `store.mutate(name, transform, actor, port?)` — runs `transform(prev)` INSIDE the same
   per-name write lock as the put (put's body extracted to share it; calling `put` inside
   `withNameLock` would deadlock on the chained promise). Needed because link/unlink/
   discuss/review are read-modify-write on arrays: two concurrent links to one item through
   plain `put` would each read `edges=[]` and the second write would erase the first.
   `transform` may throw coded errors (`NOT_FOUND`, `ID_COLLISION`); returning `null` = no-op.

## Routes — `core/src/routes/core/backlog.routes.ts` (envelope + port-injected handlers, assist-content idiom)

Literals precede `/:id` patterns. Reads local (replica); writes origin-anchored.

| Method | Path | Notes |
|---|---|---|
| GET | `/backlog` | list rows (summaries + counts); `?status=&type=&tag=&includeRemoved=` |
| GET | `/backlog/graph` | `{nodes,edges:[{from,to,kind}]}` for rendering; excludes removed |
| GET | `/backlog/:id` | full item incl. discussion/reviews/history |
| GET | `/backlog/:id/history` | newest-first |
| POST | `/backlog` | create `{title, description?, type?, priority?, tags?, status?}` |
| POST | `/backlog/:id` | update whitelist `{title,description,type,status,priority,tags}` — unknown field ⇒ coded `UNSUPPORTED_FIELD` (the assist-content 200-noop lesson); edges/discussion/reviews only via the dedicated ops |
| POST | `/backlog/:id/link` `/unlink` | `{to, kind}`; link validates target exists + no self-edge; duplicate ⇒ `changed:false` |
| POST | `/backlog/:id/discuss` | `{note, session?:{id,kind,label?}}` — session defaults from resolved actor |
| POST | `/backlog/:id/review` | `{verdict, note?, by?}` — `by` defaults from resolved actor |
| POST | `/backlog/:id/remove` | `{restore?:true}` soft delete / restore |
| POST | `/backlog/:id/rollback` | `{toRev}` → restores as NEW rev |

## MCP tools — `tools/backlog.ts`, BOTH surfaces via the existing plumbing

`backlog_list` `backlog_get` `backlog_graph` (read) · `backlog_create` `backlog_update`
`backlog_link` `backlog_unlink` `backlog_review` `backlog_discuss` `backlog_remove` (write).
Handlers = loopback workerGet/workerPost with `withActorHint` on writes (connector caller
identity rides `_actor.toolUseId` → `resolveMcpActor` in the route). Connector string-arg
coercion (tags array-as-string, booleans) handled in the tool handlers. Registered in:
`EXPANDED_TOOL_DEFS`/`EXPANDED_HANDLERS`, `TOOL_SCOPES`, `registry/catalog.ts`
(+ `CATEGORY_ORDER` gains `backlog`). Connector sees them after deploy via the canonical
reload: `refresh_connector_tools` → re-run `set_connector_auto_approve` (no restart of
claude.ai needed; core restart is part of deploy anyway).

## Web UI — `/backlog` (graph like missions, mission components untouched)

- `web/src/lib/backlog-types.ts` + `web/src/hooks/useBacklog.ts` (fetch via
  `apiClient.fetchPath` — already unwraps `{data}`; machineId passthrough like
  `useMissionGraph`).
- `components/backlog/BacklogGraphCanvas.tsx` — MissionGraphCanvas pattern: one CSS-transform
  div, HTML cards + SVG edges (kills foreignObject zoom-ghost), wheel/pinch zoom, drag pan,
  double-click/Fit, border-point arrows; edge COLOR by kind + legend; reuses
  `computeMissionLayout` verbatim for clusters/hubs/focus/recent.
- `BacklogCard` (accent by type, status pill, priority badge), `BacklogNodeDetail` (markdown
  description via existing `react-markdown`, status/priority selects → update, link/unlink,
  discussion + reviews with add forms, version history + revert, remove/restore),
  `BacklogCreatePanel`, `BacklogLayoutPicker` (reworded hints), filter row (type/status/tag).
- Page `app/(dashboard)/backlog/page.tsx`; Sidebar entry `Backlog` (Lightbulb) after
  Mission Graph.

## Tests (node:test, `core/src/__tests__/`)

`backlog-model.test.ts` (validation/normalization/graph builder) ·
`backlog-store.test.ts` (rev/merge/no-op-with-arrays/mutate atomicity/create-collision/
rollback/coded throws — mirrors content-registry-store.test.ts) ·
`backlog-routes.test.ts` (handlers over memPort: CRUD, link dedupe/missing-target/self-edge,
discuss session attach, review, remove/restore, graph shape, UNSUPPORTED_FIELD, rollback;
reads never create the dataset) · `backlog-origin-anchor.test.ts` (mirrors
assist-content-origin-anchor.test.ts) · `relay-backlog-allow.test.ts` ·
`backlog-mcp.test.ts` (defs/scopes/coercion). Existing completeness suites
(mcp-tool-catalog, mcp-tool-scopes, assertScopesCoverTools) pick the new tools up
automatically. Regression: full missions/registries/data-service suites must stay green.

## E2E (Phase 5 evidence)

Deploy fleet → connector reload → drive a claude.ai conversation via `claudeai_completion`
(enable_connector_tools): create 2–3 items, `backlog_link` depends-on, `backlog_review`,
`backlog_discuss` (caller auto-attached), `backlog_graph` returns nodes+edges → verify
`/backlog` UI renders, history lists revs, rollback restores. Cross-node: read a replica row
from another node (123/107) to prove fleet sync. Evidence doc:
`docs/superpowers/specs/2026-07-21-backlog-graph-e2e.md`.
