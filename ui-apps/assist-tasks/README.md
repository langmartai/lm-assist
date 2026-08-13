# assist-tasks

The Claude Code **session task lists** of this node (`~/.claude/tasks/`, read by
`core/src/tasks-service.ts`) as a scoped UI pane — the migration of the old web page
`web/src/app/(dashboard)/tasks/`. A plain-JS app (no build, no framework) that shows every
task across every session **on the one node serving the pane**, in a kanban or list view,
grouped by project or session, with a detail pane for the selected task's description,
dependencies and context.

## 🔴 Scope: THIS NODE ONLY — and that is a reduction, not a restatement

`GET /tasks/all` reads the serving node's own `~/.claude/tasks`. This pane queries no other
host, and **multi-node aggregation is not implemented here** — it is a separate, blocked
backlog item. Nothing in the UI, this file, or the source may imply otherwise.

That matters because **the page this replaces really did aggregate across hosts.**
`web/src/hooks/useTasks.ts` fans `apiClient.getTaskStoreAll(machineId)` over every online
machine with `Promise.allSettled`, stamps `machineId`/`machineHostname`/`machinePlatform` onto
each row, filters on `filters.machineId`, and offers `groupBy: 'machine'` with per-machine group
headers. So the machine filter and the machine grouping are dropped here because **this pane
only ever reads one node**, *not* because the fleet has one machine — the fleet has many. An
earlier revision of this README and of `assets/app.js` called them "degenerate (one machine)";
that was wrong and is the specific misreading this pane now works to prevent.

The UI therefore **names the node** in five places, so a fleet operator cannot mistake one
host's numbers for the fleet's:

| where | what it says | visible when embedded? |
|---|---|---|
| scope banner, top of the controls pane | `node <hostname>` + a `THIS NODE ONLY` badge + "Shows **this node's** task lists only … No other host is queried … There is no machine filter and no group-by-machine here." | ✅ yes |
| the `showing N of M` line | `showing 470 of 470 tasks on <hostname> — this node only` | ✅ yes |
| the summary box | `on <hostname> — this node only` | ✅ yes |
| detail → Context | a `node:` row on every task | ✅ yes |
| header chip + `<title>` | `node <hostname>` / `Tasks — <hostname>` | ❌ no (`body.embed header{display:none}`) |

The counts line and the summary share one helper (`onNodePhrase()`), so the two places that
describe the same figures cannot drift into saying different things.

The header is hidden in the app shell, which is exactly where a fleet operator looks — so the
authoritative statement lives in the controls pane, not the header, and **not only in this
README**. `showing 470 of 470 tasks` with no host named is the precise sentence being
eliminated.

The **"this node only" text is static markup** in `index.html`. Scope is a property of the
declared grant, so it cannot depend on a fetch succeeding: a failed `/health` blanks the
node's *name* (→ `this node (name unavailable)`, with the error in the tooltip), never the
scope statement.

It follows the `assist-backlog` / `assist-scheduler` pilots exactly: the same unmodified
document runs behind the hub's ui-gateway AND behind the node-local HTTP tier, because every
data call goes through the injected `assets/lmui.js` SDK helper (view token + re-mint on
401/403), never a hard-coded origin. `assets/lmui.js` is copied **byte-for-byte** from the
canonical `ui-apps/assist-backlog/assets/lmui.js` and is never hand-edited;
`core/src/__tests__/lmui-shim-identity.test.ts` fails the suite if any pane's copy drifts.

⚠️ Do **not** re-pin a literal hash here. This README used to claim
`md5 6cf55550268ae58bbfc75cb8284a76fa`, which is stale — the shim has since grown its
cross-pane `goto` section. Measured 2026-08-13: all 17 panes carry the same
`3c5a56aad07af262b4fb326b034ce668` (10620 B). The identity test, not a number in prose, is what
actually holds the copies together. (Six sibling READMEs still carry the stale hash; they are
outside this pane and were not touched.)

## Grant

Two declared read rules in `lmui.config.json`, both `exact` (leaf) and both `GET`, and nothing
else it can reach:

```
node:/tasks/all [GET]  exact
node:/health    [GET]  exact
```

`exact: true` means the request path must have the **same segment count** as the rule — a leaf,
not a subtree (`core/src/ui-pages/local-tier/grants.ts`). Without it a rule carries its whole
subtree, which is why `/tasks/all` is named rather than `/tasks`: a `/tasks` grant would also
cover `POST /tasks/:listId`, `PUT /tasks/:listId/:taskId` and `DELETE /tasks/:listId/:taskId` —
real task mutation. This pane never writes.

- `GET /tasks/all` — every task from every list on this node, flat. `data` is a **wrapper
  `{ tasks:[...], total }`** (not a bare array); the pane reads `data.tasks`. Each row is
  `{ id, subject, description, activeForm?, status, blocks[], blockedBy[], sessionId,
  projectPath?, projectName?, owner? }` — `projectName` arrives already derived from Core, so
  there is no client-side path munging. 🔴 There is **no** `machineId` / `machineHostname` on a
  row; the old web page synthesised those client-side from `MachineContext` after fanning out.
- `GET /health` — the node's own `{ hostname, platform, version, localIp, … }`, used for one
  thing: **naming the node in the UI**. Added because scope that is only stated in a README is
  scope a fleet operator never reads. It is the same rule `assist-projects`, `assist-mcp-tools`
  and `hello-pane` already declare for their headers, and it is the narrowest route that
  answers "which host am I looking at" — `/status` returns strictly more, and nothing narrower
  exists.

The view token's grant is the hard ceiling — anything outside those two leaves 403s.

⚠️ **Adding `/health` changes the declared grant, so an already-registered pane must be
re-registered** for its view tokens to carry it. Until then the `/health` call 403s and the pane
degrades exactly as designed: the scope statement still reads "this node only", and the name
shows `this node (name unavailable)` with the gateway's own message in the tooltip; a
background tick keeps retrying the lookup while it fails.

📌 **For the integrator:** `core/src/ui-pages/local-tier/__tests__/grants.test.ts` keeps a
per-pane call inventory, and its `assist-tasks` entry is `must: [['GET','/tasks/all']]`. That
test still **passes** with this change (see Verification — nothing in `must` was removed and
nothing in `mustNot` became allowed), but the inventory no longer lists every call the app
makes. `['GET', '/health']` should be appended to that pane's `must`. That file is outside this
pane's directory and was **not** modified here.

⚠️ `GET /tasks` (no `/all`) is a **different** route returning `{ taskLists, total, tasksDir }`,
per-session summaries rather than tasks (3461 rows on this node vs 470). It is neither called
nor granted.

The old page's `/task-store/tasks` fallback is **dropped**: it fires only when `/tasks/all`
throws, and it returns `{tasks:[],total:0}` here — carrying it would have cost a second grant
for a path that yields nothing.

## Layout

Three panes:

- **Controls** — the **scope banner** (which node, and that it is the only one), then a text
  filter (subject / id / description / project / session), a status filter
  (all · pending · in progress · completed), a group-by switch (project · session · flat),
  a kanban/list view switch, a project dropdown, the filtered summary box
  (total / pending / in progress / completed, plus `on <hostname> — this node only`), the
  `showing N of M tasks on <hostname>` line, and the live controls (auto-refresh every 10 s —
  the old page's poll interval — plus a manual Refresh and an `updated …` freshness label).
- **Board** — the filtered tasks under their group headers (label, sub-label, task count).
  In **kanban** each group renders Pending / In Progress / Completed columns of cards showing
  `#id`, the project, the subject and the dependency counts (`← blocked by`, `→ blocks`); a
  blocked, not-yet-completed task is dimmed with a red edge. In **list** each group renders
  compact rows (`#id`, subject, status, project). Both are colour-coded by status on the left
  edge, and both scroll rather than truncate.
- **Detail** — the selected task: subject, `#id`, status (plus a `blocked` pill), the full
  description as plain-text pre-wrap, its **Blocked By** and **Blocks** lists with each
  dependency resolved to its real subject and status, and a context block (**node**, project,
  path, session, active form, owner). Dependency rows are **clickable** — they open that task.

### Three behaviours that differ from the old page, on purpose

- 🔴 **Task identity is `(sessionId, id)`, not `id`.** `id` is only unique inside one task
  list: on this node 470 tasks carry 72 distinct ids and `"1"` alone appears 36 times. The old
  page resolved dependencies with `allTasks.find(t => t.id === id)`, which matches the first
  task with that id anywhere in the loaded set — and that set was fleet-wide, so a
  "Blocked By #1" routinely displayed some unrelated session's, or unrelated *host's*, task #1.
  This pane resolves `blockedBy` / `blocks` inside the owning session's list only, and keys
  selection off the pair.
- 🔴 **One node instead of the fleet — a real loss of reach, stated plainly.** The old page
  aggregated across every online machine (see the scope section above). This pane reads the one
  node that serves it. That is why there is no machine filter and no group-by-machine here:
  **not** because there is one machine, but because there is one *source*. Cross-node
  aggregation is a separate, blocked backlog item and is deliberately not attempted here.
- **The node is named everywhere the numbers are.** The detail context keeps a `node:` row (the
  old page's machine row, re-pointed at the single source) precisely so a task opened from deep
  in a scrolled board still says which host it came from.

A hard failure of the *first* list call surfaces the server's own error text full-screen, under
a heading that names the node — nothing is swallowed. A failed *background* refresh is soft: the
last good data stays on screen and the reason (plus how stale the data now is) goes to the
status line. The node-name lookup fails independently of both and never blocks the list.

## Verification

Run against the live dev Core on `:3200` (`GET /tasks/all` → 470 tasks; `GET /health` →
`hostname: ubuntu-Virtual-Machine`), with the pane served straight from this directory and its
**declared grant enforced by the real evaluator** (`core/dist/ui-pages/local-tier/grants.js`),
driven in real headless Chrome. Six scenarios, all passing:

| scenario | what it proves |
|---|---|
| happy path | node named in all five places; exactly two calls made: `GET /health`, `GET /tasks/all` |
| `/health` 403s | scope statement **survives**; name degrades to `this node (name unavailable)`, reason in the tooltip; counts read `on this node only`; the 470-task list still loads |
| `/tasks/all` 500s | fatal layer names the node, keeps the scope clause, and shows the server's own error text verbatim; no counts are claimed at all |
| empty list | `No tasks found on <hostname>. Other hosts are not queried by this pane.` |
| `?embed=1` | header hidden by `body.embed`, **scope banner and counts still visible** — the case the header alone would have missed |
| hostile API data | `<img src=x onerror=…>` in `hostname`, `subject`, `projectName` and `description` renders as inert text: 0 live nodes injected, 0 payloads executed |

The grant itself was checked directly against the same evaluator: `GET /tasks/all` and
`GET /health` allowed; `POST /tasks/all`, `GET /tasks`, `POST /tasks/:listId`,
`PUT`/`DELETE /tasks/:listId/:taskId`, `GET /tasks/all/extra`, `GET /tasks/allx`, `POST /health`,
`GET /health/deep`, `GET /healthz`, `GET /status`, `GET /sessions` and
`GET /diagnostics/event-loop` all denied.

🔴 One real defect was found by the `/tasks/all` 500 scenario and fixed: `loadNode()` and
`loadList()` race at boot, so a list failure arriving before `/health` painted the fatal
heading as "…from this node" and never corrected it. The message is now remembered
(`state.fatalMsg`) and the layer re-painted when the name lands; Retry calls `clearFatal()`
rather than removing the node, so a late `/health` cannot resurrect a dismissed error.

## Deploy

The integrator registers it; the manual path is:

```bash
cp -r ui-apps/assist-tasks ~/.lmui/apps/assist-tasks
lm-assist restart          # (prod) — pick up the newly-served app
```

Then reach it in either tier:

- Hub gateway:  `https://<uiId>.<hub-ui-domain>/`  (relayed to this node)
- Local tier:   `http://127.0.0.1:<localUiPort>/ui/assist-tasks/`

Both honor `?embed=1&theme=light|dark` for embedding inside the app shell.
