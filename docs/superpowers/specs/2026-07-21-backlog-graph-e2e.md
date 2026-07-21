# Backlog graph — e2e evidence (mission_0656cd21, 2026-07-21)

Auto-approve mission: design → implement → test → merge → fleet deploy → e2e, no human gate.
Branch `feat/backlog-graph` → merged `main` @ `6a3ee0e` (+ attribution fix `14323c7`), pushed to origin.

## Gates before merge (rails)

| Rail | Result |
|---|---|
| `./core.sh build` | PASS (worktree + merged main) |
| web `next build` | PASS — `/backlog` route emitted; standalone assembled |
| New suites | 44 backlog tests + 3 for the attribution fallback, all green |
| Full regression (402 test files, batched `timeout`-bounded) | green except pre-existing env/infra failures **identical on the pre-merge baseline c2512f1** (verified per-file, solo, both trees): `terminal/cc-integration` (53, needs live tmux), `data/sync-engine` (2), `data/partial-mode` (1). Zero failures caused by the branch. |
| Repaired stale suites (red on main before this work) | `mission-controller-restart-adopt` (anti-flap streak), 4× `fleet-identity*` (reworded prose / `buildBootstrap` shape) |
| Env repairs while gating | built missing `better_sqlite3` native (dev `--ignore-scripts` gap) → sql-backend suite green; killed multi-day orphaned `node --test` processes (cross-process LMDB contention = the "suite deadlock") |
| chokidar `^3.6.0` + ESM-import-via-Function pins | untouched |
| Secrets | none committed |

## Fleet deploy (canonical dist-sync, §5 of build-pack-install-upgrade)

| Node | Core | Web | Verified |
|---|---|---|---|
| 117 ubuntu (nvm root) | rsync `core/dist` | static + standalone rsync incl. the REAL-dir standalone-static refresh | `/health` ok · `/backlog` 200 · NEW-ONLY chunk `5567512d3ecd1aad.js` 200 · `/backlog` page 200 · **hub reconnected** (`authenticated:true`) |
| 123 yitest (`/usr/lib`, sudo rsync) | ✓ | ✓ (web restarted as `yi`) | same checks 200/ok, hub authenticated |
| 107 Windows (`C:\nvm4w\...`) | zip+scp+`Expand-Archive` | ✓ (same zip) | health ok (fresh uptime), `/backlog` 200, chunk 200; restart via elevated worker `:3110/exec` (exit 0) |

## Connector activation (no claude.ai restart)

`refresh_connector_tools` (cache cleared) → `set_connector_auto_approve` for the 10
`backlog_*` tools ("Enabled … for 10 tool(s)" — proof the refreshed tools/list carries them).
Both MCP surfaces verified: `POST /mcp tools/list` → 10 `backlog_*`; `/mcp-call backlog_graph`
→ live graph.

## Driven conversation e2e

claude.ai conversation `0cbbc4db-913f-477f-ad1c-8b78a53e6401`
("Backlog graph e2e — mission_0656cd21"), driven via `claudeai_completion(enable_connector_tools)`.

- Turn 1 (7 tool calls, one turn): created `bl_20707419` (feature, high), `bl_e1288c1c`
  (idea), `bl_eb5918a6` (bug, critical); linked feature **depends-on** idea; reviewed the bug
  (`approve`, "Reproduced on Safari 19"); discussed the feature; fetched `backlog_graph`.
  Assistant reply: ids + "nodes: 3, edges: 1". (The driving client saw a Cloudflare 502 —
  the turn kept running server-side; never re-sent.)
- Turn 2: `backlog_discuss` + `backlog_update status:accepted` → "done — item now at version 5".
- Turn 3: asked it to self-identify via `session_status` + self-declare. `session_status`
  couldn't resolve the conversation candidate at that moment (live `listConversations`
  slower than the resolver's 2.5s budget; cookie itself healthy per `/claude-ai/healthz`) —
  the conversation **refused to fabricate** its uuid. Turn 4: uuid supplied by the driver →
  `backlog_discuss` with explicit session → "attached as 0cbbc4db-…".

**Attribution evidence on the item (`bl_20707419`)**
- note1 `api/unknown` — pre-fix behavior (web conversations carry a tool-use id that never
  matches a local session; `resolveMcpActor` returned the coarse actor). Root-caused live →
  fix `14323c7`: recency fallback via `resolveCallerCandidates` when no tool-call id match.
- note2 `code/755ae046…` (mission-controller session) — post-fix recency pick while the
  claude.ai candidate was unavailable; hierarchy: precise > conversation > code-recency.
- note3 `conversation/0cbbc4db-913f-477f-ad1c-8b78a53e6401` — **the conversation attached
  itself** (deterministic self-declared path).

## Version history + revert (prod, live)

History of `bl_20707419`: rev1 create → rev2 edges → rev3/4 discussion → rev5 status →
rev6 discussion → **rev7 = rollback to rev3** (restored `status:open`, 1 note — full-state
restore) → **rev8 = rollback to rev6** (back to `accepted`, 3 notes). `GET /backlog/:id/history`
lists all revs newest-first with per-field change summaries.

## Cross-node proofs

- **Origin-anchored write**: `POST /backlog/bl_e1288c1c/discuss` sent to **123** → response
  v2; **117 showed v2 + the note instantly** (no sync wait) — the replica proxied the write
  to the origin.
- **Fleet sync parity**: all three nodes list the same 5 items with `bl_20707419` at v8;
  graph = 5 nodes, 2 typed edges (`depends-on`, `relates-to`).

## Incident caught + resolved live: bootstrap-window dual owner

The conversation's first writes routed to 107 before 117's freshly-created descriptor had
synced there (reconcile/PULL cadence) → 107 self-created a second locally-owned `backlog`
dataset; 123 adopted 107's descriptor. Records converged both ways, but ownership was dual.
**Recovery** (minutes, no data loss): verified 117 held every record → `data_drop_dataset`
on 107 → forced `data_sync` on 107+123 → both re-pointed to the 117 origin (123's stale
replica descriptor overwritten by reconcile; its replica-drop refusal is correct behavior).
**Follow-up filed IN the backlog itself**: `bl_d5fff0f5` "Harden fleet-dataset bootstrap:
auto-demote dual owners" (relates-to the seed item, discussed by this executor session).
Operational rule until then: seed a new fleet registry from the intended origin AND force
`data_sync` on peers before exposing its write tools fleet-wide.

## Final state

5 items, 2 edges, everything rev-tracked and attributable; `/backlog` UI live on all three
nodes; tools live on both MCP surfaces + the claude.ai connector.
