# assist-missions

lm-assist's **mission control** — the mission list, the Mission Controller (chat, trace, tick,
session actions) and every mission's **detail view** — as a scoped UI pane. A plain-JS app (no
build, no framework, no dependencies) that migrates `web/src/app/(dashboard)/missions/` and its
components (`MissionsPage`, `MissionDetailView`, `MissionSessionChat`, `ControllerTracePanel`).

It follows the `assist-backlog` / `assist-knowledge` / `assist-scheduler` pilots exactly: the same
unmodified document runs behind the hub's ui-gateway AND behind the node-local HTTP tier, because
every data call goes through the injected `assets/lmui.js` SDK helper (view token + re-mint on
401/403), never a hard-coded origin. `assets/lmui.js` is copied **verbatim** from
`ui-apps/assist-backlog/assets/lmui.js`, the canonical copy
(md5 `3c5a56aad07af262b4fb326b034ce668`, 10620 B; `core/src/__tests__/lmui-shim-identity.test.ts`
fails the suite if any copy drifts) — never hand-edit it, re-copy it.

## Cross-pane params — the pinned vocabulary

A param name is the entity's **singular noun, unqualified** — `session`, `project`, `mission`,
`task`, `cluster`, `tool`, `dataset`, `skill`, `unit`, `doc` — plus exactly two generic modifiers,
`tab` (a named sub-view) and `q` (a search prefill). Never `sessionId`, `id`, `missionId` or
`highlight`. Both halves of the rule matter: a pane must **emit** only these, and must **read**
the ones naming entities it can display. A param the target does not read is not a broken URL,
it is a *silently broken button* — the link opens, the pane loads, and it ignores what you asked.

**Inbound — what this pane accepts** (`assets/app.js`, boot block):

| param | value | what it does |
|---|---|---|
| `mission` | a mission id | opens that mission's **detail view** (a tab of this pane) |
| `session` | a session id | opens that session's view (liveness → resume → chat) |
| `q` | free text | prefills the sidebar search box, applied to the **first** paint |
| `tab` | `controller` | lands on the Mission Controller view |

An entity param beats `tab` (`mission=` names something concrete to show; `tab=` only names where
to look); `q` is orthogonal and applies in every case. Anything else is ignored on purpose —
silently honouring an off-list spelling is how four names for one idea happened in the first place.
`embed` / `theme` are not part of this vocabulary: they are the shell's embedding contract, and
`lmui.goto` refuses them (`NAV_RESERVED`) because the serving tier sets them itself.

`mission` / `session` / `q` are also what the pane writes **back** into its own address bar as you
navigate (`syncUrl()`), so a reload — or a copied link — reproduces the view you were looking at,
under the same names a sibling would have sent.

**Outbound — everything this pane emits.** Both go through the shim's one navigation helper; a
pane never builds a sibling URL:

```js
lmui.goto('assist-mission-graph',     { mission: id })   // "Graph ↗"     (header + each row + detail)
lmui.goto('assist-mission-processes', { mission: id })   // "Processes ↗" (header + detail)
```

## The mission detail is an INTERNAL route, not a sibling pane

`?mission=<id>` is the pane's own deep link as well as the inbound one. The Mission Graph pane
sends it via `lmui.goto('assist-missions', { mission: id })`; on load the pane opens that mission's
detail **view of this pane** (a tab next to "Mission Controller"). There is no page reload and no
second pane.

## Grant

Fifteen rules in `lmui.config.json` — one per route this pane actually calls, and nothing else
it can reach. Every one is `"exact": true`, so each names a LEAF, not a subtree. The right-hand
column is the audit: the function in `assets/app.js` that makes the call.

```
node:/mission                              [GET]    exact   loadMissions()        the mission list
node:/mission                              [POST]   exact   submitCreate()        "New mission" form
node:/mission/*                            [GET]    exact   loadDetail() · loadController() · loadAllSessions()
node:/mission/*                            [PATCH]  exact   patchMission()        Save · status · binding:null
node:/mission/*/sessions                   [GET]    exact   loadDetailSessions()
node:/mission/controller/trace             [GET]    exact   loadTrace()
node:/mission/session/*/status             [GET]    exact   checkSession()
node:/mission/session/*/read               [POST]   exact   chatRead()
node:/mission/session/*/drive              [POST]   exact   chatSend()
node:/mission/session/*/answer             [POST]   exact   chatAnswer()
node:/mission/session/*/control            [POST]   exact   ctlControl() · sessControl()
node:/mission/session/*/resume             [POST]   exact   resumeSession()
node:/scheduler/jobs/mission-controller/run [POST]  exact   runTick()             the "Tick" button
node:/ccr/cloud/repos                      [GET]    exact   loadRepos()
node:/ccr/cloud/branches                   [GET]    exact   loadBranches()
node:/ccr/remote                           [GET]    exact   lookupBridgeUrl()
```

(The first two rules are one JSON object with `"verbs": ["GET","POST"]`; they are split above
because they serve different callers.) A **query string is not part of the grant check** — the
serving tier splits it off before matching — so `?node=` and `?repo=` need no rule of their own.

🔴 **Why this is not `node:/mission [GET, POST]` any more.** It used to be, and a bare prefix rule
is a **subtree** rule: it matches the path and everything below it. `POST` on `/mission` therefore
carried every mutating route in `core/src/routes/core/mission.routes.ts` — including
`POST /mission/workflows/:id` and `POST /mission/workflows/:id/rollback`, which **rewrite and roll
back the Mission-Controller playbooks**. The Mission Processes pane next door declares
`node:/mission/workflows [GET]` precisely so that nobody edits a playbook from a browser; this
pane silently held the write authority that pane had given up, plus `/mission/:id/spawn`,
`/:id/tags`, `/:id/neighbors`, `/views/:id/delete`, `/controller/adopt` and `/onboard`, none of
which it ever calls.

The fix is the **leaf form** of the grant language (`core/src/ui-pages/local-tier/grants.ts`):

- `"exact": true` — the request path must have the **same number of segments** as the rule, so
  `POST /mission` grants creating a mission and nothing under `/mission/…`;
- `*` as a whole segment — matches exactly one segment, never a `/`. It is how a rule addresses a
  **path parameter**: `/mission/session/*/read` is `POST /mission/session/:sid/read` and no other
  session verb.

Both forms are backwards compatible — a rule with no `exact` still means "and everything below" —
and both are enforced identically by the hub's ui-gateway
(`LangMartDesign/ui-gateway/src/viewtoken/grant.ts`), which is the whole point: this pane is
served by BOTH tiers from this one file, so a rule the gateway did not understand would leave the
hub wide open while the node looked narrow.

What the rules map to (paths + shapes mirror `mission.routes.ts`):

- `GET /mission` — the list. `data` is a **BARE ARRAY**, *not* `{missions:[…]}`. The
  `Array.isArray()` hedge in `loadMissions()` is load-bearing.
- `GET /mission/:id`, `POST /mission`, `PATCH /mission/:id` — `data` is the mission object
  **directly**, with no `{mission}` wrapper. `/mission/*` is one wildcard segment, so
  `/mission/workflows/<id>` (two segments) is out of reach in every verb.
- `GET /mission/:id/sessions` → `{sessions:[…]}` · `GET /mission/sessions` → `{sessions:[…]}`
  (the latter is a one-segment path, so `/mission/*` covers it)
- `GET /mission/controller` → `{election, job, controllerSession, leader}` (also `/mission/*`)
- `GET /mission/controller/trace` → `{election, record, live, lineage[], journal[]}`
- `GET /mission/session/:sid/status?node=` → `{transport, alive}`
- `POST /mission/session/:sid/read|drive|control|answer|resume` — five separate rules on purpose.
  `/read` — reading a session transcript — is a `POST` route, so a GET-only grant would silently
  kill every chat; enumerating the five means a sixth verb added to that family later does not
  join this pane's authority for free.

🔴 **Why `patchMission()` sends `PATCH`, not `POST`** — a grant decision, not a style one, and the
one place where narrowing the rule required touching `app.js`. `/mission/*` is one wildcard
segment, so a `POST` rule covering `POST /mission/:id` cannot help also admitting its one-segment
*literal* siblings — `POST /mission/query`, `/graph`, `/schedule`, `/changes`, `/views` and
`/onboard` (two of those are writes this pane has no business making) — because a path parameter
and a literal occupy the same position and the rule language, correctly, has no way to tell them
apart. `PATCH /mission/:id` is routed to the **same handler** (`handlePatch`, `mission.routes.ts`)
and is the only `PATCH` route under `/mission` on the node, so `PATCH /mission/*` grants exactly
that one call. Measured on `:3200`: `PATCH /mission/zz_does_not_exist` → `400
{"code":"NOT_FOUND","message":"no mission zz_does_not_exist"}` (the handler ran) versus a genuine
route miss `404 Route not found`, and `PATCH` with an unknown field returns the same
`UNSUPPORTED_FIELD` envelope `POST` does, so the body is parsed identically. Both grant evaluators
compare verbs case-insensitively and the gateway's registration allow-list
(`ui-gateway/src/registry/scope.ts`) includes `PATCH`, so the rule is valid on both tiers.
**If you ever move this call back to `POST`, widen the rule in the same commit** — otherwise the
Save button silently 403s.

The rest are minimal on purpose:

- `/scheduler/jobs/mission-controller/run [POST]` is the **Tick** button and nothing else. It is
  the full path now, not a prefix, so `POST /scheduler/jobs` (create) **and**
  `POST /scheduler/jobs/mission-controller` (edit that job's schedule) are both outside the grant.
  That route hand-builds its own envelope: a refusal is
  `{success:false,error:{code:'ENV_DISABLED'|'NOT_FOUND'}}`, surfaced verbatim.
- `/ccr/cloud/repos` and `/ccr/cloud/branches` are the create form's repo/branch pickers — two
  exact paths, GET only, so no `/ccr/cloud/:sid/...` session route is reachable.
- `/ccr/remote [GET]` resolves the live bridge `webUrl` for the "Claude app" deep link when a
  resumed controller's `cse` has not been discovered yet. GET only, so `POST …/stop` is blocked.

The view token's grant is the hard ceiling — anything outside those prefixes 403s. `/auth/me` is
the one raw `fetch` (the signed-in badge); every other call goes through `lmui.call`.

## Writes this pane can make

Mission lifecycle: create (`POST /mission`), patch (`PATCH /mission/:id` — title / objective /
plan / nextSteps / status / `binding:null`).
Session operation: `drive` (types into a live Claude Code session), `control`
(interrupt / stop / restart), `answer` (answers a pending AskUserQuestion), `resume`, and the
controller `tick`. These are the page's purpose, not incidental. Two guards are reproduced from
the old page: stopping the user's **own onboarded** session is refused server-side with
`ONBOARDED_PROTECTED` and prompts an explicit confirm-and-retry with `force:true` rather than
dropping the click; and `binding:null` ("Start fresh worker") is offered only when a resume came
back `reason:'gone'`, never on `reason:'conflict'`.

## Layout

Two columns — the **stage** (the active internal route) and the **missions sidebar**.

- **Stage / Mission Controller** — live-or-offline badge, leader + controller sid, the job's
  interval and last run, **Tick**, **Trace**, **Claude app** deep link, an **Actions** menu
  (interrupt / stop / restart), and the controller **chat**. When the controller session is stale
  relative to the elected leader it shows the *failover* banner with "Force tick now"; with no
  controller at all, the offline banner with "Run tick now".
- **Trace** — the tractability cockpit: a one-line plain-language health summary, "What the
  control loop did" (journal) and "Controller identity history" (lineage), refreshed every 10 s
  while open.
- **Stage / Mission detail** (internal route) — editable Title / Objective / Plan / Next steps
  with dirty-tracking and Save, status actions (Pause / Resume / Done), tags, parent, deps, env,
  executor binding, progress, results and the **audit trail**; the mission's **Sessions** with
  liveness dots, transport icons, executor badge and a Claude-app link; and a **mission chat** to
  the controller, prefixed `[mission <id> "<title>"] ` so it knows what the message is about.
  The audit trail is **paged, 25 at a time, newest first**, and its header always states what is
  actually on screen — `audit — showing 25 of 137, newest first:` with a `Show 25 more (25/137)`
  button, and `audit (137, all shown):` once you reach the end. It used to render
  `.reverse().slice(0, 25)` under a header printing the *true* total, so a mission with 137
  changes said `audit (137)` and showed 25, with nothing admitting the other 112 existed or any
  way to reach them — a cap contradicting its own header is worse than no cap, because the reader
  has no reason to doubt the count. Nothing pages this server-side either
  (`recordAdjustment()` in `core/src/mission/mission-store.ts` pushes uncapped), so there is
  deliberately no "Show all": that would just move the blow-up to one click.
- **Stage / Session** — liveness check on open, then: cloud sessions auto-resume, native sessions
  ask first, and `gone` / `conflict` get their own dead-ends. Alive sessions get the same chat.
- **Chat** (shared) — 4 s poll, "Only user ↔ assistant" filter (span-aware: it hides an injected
  directive *and* the assistant turns answering it), grouped tool-call lines that expand,
  "Load earlier" paging (120 → +400 → 2000), pending-question options plus a free-text answer, and
  a composer (Enter sends, Shift+Enter newlines). Message text is markdown rendered as **plain
  text, pre-wrap** — no markdown library, per the self-hosted/CSP rule.
- **Sidebar** — keyword search (space = AND over title / objective / id / status / tags), status,
  transport (cloud/native) and recency filters, sorted by recency, 50 per page with "Load more";
  each row carries status/onboarded/MANUAL/binding badges, interim progress, an **inline editable
  objective** with Save/Discard, a progress bar, tags, provenance, status actions, Open and Graph.
  Plus an **All sessions** panel (fleet-wide, with per-session interrupt/stop/restart) and a
  **New mission** form (title, objective, isolation, repo + branch pickers, projects, dependsOn).

A repaint never wipes what you are typing: the 5 s poll skips any region holding a focused
input, drafts live in state, and the chat poll rewrites only the transcript — never the composer.

A hard failure of the primary list call surfaces the server's own error text full-screen
(`textContent`, so it is inert) — nothing is swallowed. Because the pane is multi-view, that
overlay is cleared on every view change, so a fatal from one view can never stay pinned over another.

## Known differences from the old page

- The controller/session views render the transcript through this pane's own chat rather than
  embedding `CcrCloudView`; read / drive / answer / control work the same for cloud and native.
- Voice dictation (`MicButton`) is dropped — it needs the web app's voice stack.
- Markdown is shown as plain text (no `react-markdown`), matching every sibling pane.

## Deploy

The integrator registers it; the manual path is:

```bash
cp -r ui-apps/assist-missions ~/.lmui/apps/assist-missions
lm-assist restart          # (prod) — pick up the newly-served app
```

Then reach it in either tier:

- Hub gateway:  `https://<uiId>.<hub-ui-domain>/`  (relayed to this node)
- Local tier:   `http://127.0.0.1:<localUiPort>/ui/assist-missions/`

Both honor `?embed=1&theme=light|dark` for embedding inside the app shell, and the pinned inbound
params `?mission=<id>` / `?session=<sid>` / `?q=<text>` / `?tab=controller` documented above.
