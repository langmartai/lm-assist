# Backlog / feature-idea graph, and registry write-path rules

> Read before adding any fleet-synced registry write path — the coerce/strip/idempotency rules generalise.
>
> Split out of the repo [CLAUDE.md](../CLAUDE.md) so it is read on demand instead of loaded into every session. Content is unchanged.

### Backlog / feature-idea graph (12 endpoints)

A fleet-synced registry of NOT-YET-IMPLEMENTED ideas/features/issues/bugs/tasks forming a
typed graph (edges: `depends-on|blocks|relates-to|parent-of|duplicate-of|spawned-mission`).
Versioned like the other registries (every write = a rev with full-state history; rollback
restores as a NEW rev). Dataset `backlog` (cache backend, scope fleet) — created by the
FIRST WRITE on the origin node; reads never create it. Writes are origin-anchored; reads
serve from the local replica. Web UI: `/backlog` (graph like missions). MCP tools (both
surfaces): `backlog_list/get/create/update/link/unlink/review/discuss/remove/graph` —
`backlog_discuss` auto-attaches the CALLER session (connector tool-call id → precise
session; remote/CCR self-declare `sessionId`+`sessionKind:"remote"`). Removal is SOFT
(`removed:true` rev; `restore:true` brings it back). Design:
`docs/superpowers/specs/2026-07-21-backlog-graph-design.md`.

**Write-path robustness (2026-07-25).** Registry WRITES used to refuse callers over things
reads never checked — the reason "creates keep failing while lists work" is always a
validation refusal, not a transport fault. Three rules now hold, and new registry writes
should follow them:
- **Coerce caller-plausible enums, refuse the rest LOUDLY.** `priority:"medium"` → `med`,
  `"urgent"`→`critical`, `status:"done"`→`implemented`, `type:"enhancement"`→`feature`
  (`normalizePriority/Type/Status` in `backlog-model.ts`). An unmappable value still fails,
  but the message now **echoes what was sent** (`priority "spicy" is not valid — …`);
  without that, a caller retries the same value forever (it did: 3× identically).
- **Consume transport keys before the unknown-field guard.** `node` is the connector's
  ROUTING param and rides on nearly every relayed call; it used to trip mission_update's
  whitelist and refuse the whole write. `routes/core/transport-keys.ts` strips a CLOSED
  list — the UNSUPPORTED_FIELD guard must keep catching real typos (the 200-noop lesson).
- **Creates are IDEMPOTENT.** `POST /backlog` takes `requestId`; a repeat (or an identical
  title+description within 10 min) resolves to the SAME item (`idempotent:true`), and
  same-key creates are serialized by a create-lock. Near-duplicate titles are *reported*
  (`possibleDuplicates`) but never refused. Pair this with the anchor's honest failure
  codes: **`ORIGIN_TIMEOUT` = may have landed, retry only with the same `requestId`;
  `ORIGIN_UNREACHABLE` = nothing written, retry freely.** (A relay 504 body used to have
  no `success` key and slipped through as a *successful* write — the worst answer here.)
