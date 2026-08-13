# assist-projects

The lm-assist **Projects** page with the **Process Dashboard** folded into it, as a single scoped
UI pane — a plain-JS (no build, no framework, no deps) app that lists this node's Claude Code
projects and the Claude processes running on it. It follows the pilot pane `assist-backlog`: the
same unmodified document runs behind the hub's ui-gateway AND behind the node-local HTTP tier,
because every data call goes through the injected `assets/lmui.js` SDK helper (view token +
re-mint on 401/403), never a hard-coded origin. `assets/lmui.js` is copied **byte-for-byte** from
the canonical copy in `ui-apps/assist-backlog/assets/lmui.js` and is never hand-edited;
`core/src/__tests__/lmui-shim-identity.test.ts` fails the suite if any pane's copy drifts. (This
line used to pin a literal md5 — it went stale the moment the canonical shim gained its
`lmui.goto` section, which is exactly why the rule is stated instead of a checksum.)

**Single-node form.** The source pages fanned out per machine (`MachineContext`, `MachineBadge`,
`machineId` on every link). A pane is served *by* one node, so all of that is gone: everything
shown is this host, and the header carries its hostname / platform / version.

## Grant

```
node:/projects              [GET]   exact
node:/ttyd/processes        [GET]   exact
node:/ttyd/process/identify [POST]  exact
node:/ttyd/process/*/kill   [POST]  exact
node:/sessions/batch-check  [GET]   exact
node:/tasks/all             [GET]   exact
node:/health                [GET]   exact
```

The narrowing uses the leaf/exact rule form in `core/src/ui-pages/local-tier/grants.ts`:
`"exact": true` means the request path must have the SAME NUMBER OF SEGMENTS as the rule
(a leaf, not a subtree), and a whole-segment `*` matches exactly one segment — how a rule
names a path parameter. The hub's ui-gateway enforces both identically
(`LangMartDesign/ui-gateway/src/viewtoken/grant.ts`), so a pane narrowed here is narrowed
on both serving tiers.

- `/projects` — the project list (`?force=true` bypasses the cache, behind the Refresh button).
  It is now a LEAF rule: the other read-only `/projects/*` routes are no longer swept in as a
  side effect of naming the parent. (This line used to say a prefix was "the narrowest form the
  grant language can express" — that stopped being true when `exact` landed.)
- `/ttyd/processes` — the process snapshot, plus its `?hash=` delta and `?forceCheck=true`.
  Note this is *not* under the `/ttyd/process/...` rules: segment comparison stops at `process`
  vs `processes`, so the rules are separate and neither widens the other.
- `/ttyd/process/identify` and `/ttyd/process/*/kill` **POST** — the two writes this pane makes,
  named individually. The old `node:/ttyd/process [POST]` subtree rule happened to cover the same
  two routes today, but any future `POST /ttyd/process/...` route would have joined this pane's
  authority with no config change and no review.
- `/sessions/batch-check` **GET** — the GET twin of the POST route, added for proxied
  environments. Using it keeps this pane's only POST grant on `/ttyd/process`.
- `/tasks/all` **GET** — the per-project task counts (see *Task counts* below). A leaf rule and
  a read verb only. 🔴 It is deliberately **not** `node:/tasks`: that subtree carries
  `POST /tasks/:listId` (create a list *or* a task), `PATCH`/`DELETE /tasks/:listId/:taskId` and
  `/tasks/:listId/graph` — i.e. authority to rewrite every task list on the node, for a feature
  that only needs to count them. Verified against the real matcher: `GET /tasks`,
  `GET /tasks/:listId`, `GET /tasks/all/x` and every non-GET verb on `/tasks/all` are all denied.
- `/health` — hostname / platform / version for the header line.

🔴 **`/ttyd/session` is deliberately NOT granted.** That prefix would also carry
`/ttyd/session/:id/start`, `/stop` and `/input` — spawning terminals and *typing into them*. The
source page killed a whole session with `POST /ttyd/session/:id/kill`; this pane reproduces that
by killing the session's PIDs through `/ttyd/process/<pid>/kill`, which is the same effect with a
much smaller reach. The view token's grant is the hard ceiling — anything outside these 403s.

## Layout

Two tabs (the pane keeps `clearFatal()` on switch, so an error raised by one tab cannot stay
pinned over the other).

**Projects** — a filterable list (text filter over name/path/branch/remote/**managedBy**, a
`git repos | all` chip that defaults to git-only exactly as the old page did, and a sort by
activity / sessions / cost / size / name) beside a detail pane showing branch or detached HEAD,
commit, worktree and `N trees` badges, storage, session count, total cost, the encoded path, the
**managed-by badge**, the **task counts**, the full last user prompt as plain text, every worktree
and every remote. Each row also shows a **live session count** derived from the process snapshot —
Core's `/projects` rows carry no such field, and the web client hard-defaulted it to `0`, so that
number was always blank in the old page.

**Processes** — system stat cards (total / managed / unmanaged, plus CPU, memory and disk with
the node's own `systemStats`), a filter, auto-refresh, and one card per session containing one
row per process: PID, identify role, the screen-turn progress bar with `T<read>/<last>` and a
Live/Stale badge, short session id, project, uptime, CPU, RSS, session-file size, pts, tmux name,
icon stats, the Kill action, and a **disabled** Open ↗ / Connect ↗ (see *Outbound* below).
Sessions are reached with
`lmui.goto('assist-sessions', …)` — this pane never builds another pane's URL.

## Cross-pane params

Pinned vocabulary — **the entity's singular noun, unqualified**, plus the two generic modifiers
`tab` and `q`. Nothing else is emitted, and nothing else is read.

### Inbound — read on load from `location.search`

| param | meaning | behaviour |
|---|---|---|
| `project` | a project path | Selects that row, opens its detail and scrolls it into view. A bare project **name** is accepted too (see below). Unknown → a warn note, full list kept. |
| `session` | a session id | Switches to **Processes** and filters the list to that session. If nothing on this node is running it, the filter is still applied and a warn note says so. |
| `tab` | a named sub-view | `projects` \| `processes`. An unknown value (`console`, say) falls back — to `processes` if a `session` was sent, otherwise `projects` — and names the tabs that do exist. |
| `q` | search prefill | Fills the active tab's filter box and applies it. |

Every one of those is reported in a note strip under the tabs, including the failures — an
inbound param that lands nowhere is the same defect as an outbound button that 404s, seen from
the other end. Anything not in this table is ignored.

🔴 **`project` accepts a path OR a bare name.** The pinned form is the absolute path, which is
what `assist-sessions` emits (`{ project: d.projectPath }`), but the basename resolves too, so a
caller holding only a name still lands. Path match wins.

🔴 **A deep link relaxes the `git repos` chip if it has to.** That chip is a *display default*,
not the caller's intent, and it would otherwise hide a non-git target (an lm-assist-managed
project is exactly that). A `q` the caller explicitly sent is intent, so it is kept — and if it
hides the target's row, the note says so and the detail is shown anyway.

🔴 **`session` beats `q` for the process filter.** They target the same box; the entity wins and
the note names the `q` that was not applied, rather than dropping it silently.

### Outbound — emitted via `lmui.goto`, never a hand-built URL

| target | params | from |
|---|---|---|
| `assist-sessions` | `{ project: <absolute path> }` | the detail panel's **Sessions →** button |
| `assist-sessions` | `{ session: <id>, project: <absolute path> }` | every session link on the Processes tab (group header and process row) |

That is the complete list. The `project` emission previously sent `projName(p.path)` — the
basename — which only worked because the target happens to accept both forms; it now sends the
path, which is what the vocabulary pins.

🔴 **`assist-console` does not exist, so nothing navigates to it.** Three controls used to:
the project detail's **+ New session**, and the Processes tab's **Open ↗** / **Connect ↗**. All
three now render **visibly disabled**, with the reason printed beside them (`.why`, not a
tooltip) — the project detail carries it under the actions row, the Processes tab above the list.
The buttons still say *which* kind of attach the process would need, because that is real
information about the process; only the navigation is gone. Attaching to a live console is a
WebSocket stream and the pane data plane is request/response, so this is blocked on streaming,
not on a missing route. The per-row session link is the working alternative and is named in the
reason text.

## The two card fields the port had dropped

### `managedBy` badge — read straight off the wire, not synthesised

`managedBy` is a real field of `GET /projects`: `projects-service.ts` sets it to
`lm-assist:knowledge-pipeline` when a project's path **is** the lm-assist data dir and leaves it
`undefined` otherwise, so `JSON.stringify` drops the key on every other row, and the route handler
spreads the object through untouched. The badge renders it with the source page's label rule —
`lm-assist:knowledge-pipeline` → **Knowledge Pipeline**, any other value → **Managed** — on the
row, as a pill in the detail, and as a `managed by:` meta line carrying the raw value.

Two behaviours came back with it, because without them the badge is decorative:

- the `git repos` filter keeps a managed row even when `isGitProject === false`
  (`p.isGitProject !== false || p.managedBy`) — managed projects live under the data dir and are
  deliberately not repos, so the plain git test hid exactly the rows the badge exists for;
- the text filter searches `managedBy` too.

The counts line reports `N lm-assist-managed` when N > 0.

🔴 **Honest state: no project on this node populates it today.** Measured against the live
`:3200` — `GET /projects` returns 85 rows and `GET /projects?includeExcluded=true` returns 104,
and `managedBy` is present on **0** of them. So on this host the badge is correct and invisible.
It was verified by splicing two rows carrying `managedBy` into the real response (one
`lm-assist:knowledge-pipeline`, one other value): both labels render, both survive the git-only
filter, and the counts line reads `2 lm-assist-managed`.

### Per-project task counts — reconstructed, and here is exactly how

`GET /projects` carries no `taskCounts`, and neither web api-client mapping ever set one, so the
source card's task row could not render from the project list alone. It is rebuilt from
**`GET /tasks/all`** — one call, every task on the node (measured: 470 tasks, 288 KB, 0.48 s) —
bucketed by status into `pending · in_progress · completed`, with any unknown status counted as
`other` so the total stays honest.

🔴 **The join is on the MANGLED path, deliberately.** `/tasks/all` stamps each task with a
`projectPath` that Core derives from the session-storage directory name by a naive dash→slash
substitution (`tasks-service.ts findSessionById`: `'/' + dir.replace(/^-/,'').replace(/-/g,'/')`),
so `-home-ubuntu-lm-assist` comes back as `/home/ubuntu/lm/assist`. Joining that against a
project's real `path` silently misses every project with a dash in its name — measured here, 324
of 329 attributable tasks would have vanished. So the pane does not try to un-mangle it: it
applies the *same* transform to the project's `encodedPath`, which **is** that directory name.
Both sides are then the same function of the same string, so the join is exact by construction.
Measured: 2/2 hyphenated keys joined, 0 collisions across all 85 project rows.

🔴 **The obvious route is unusable.** `GET /projects/<key>/tasks` is the per-project twin and is
authoritative, but it calls `getProjectSessions()`, which parses every session file in the
project. Curled against `-home-ubuntu-lm-assist` on `:3200` it had **still not answered after
120 s** — for one project, of eighty-five.

Nothing is hidden when the numbers are missing:

| state | row | counts line | detail panel |
|---|---|---|---|
| loaded, tasks exist | `Tasks: N pending · N active · N done` | `N tasks in M projects` | full breakdown + the join key used |
| loaded, none | (nothing — as the source card did) | as above | `no tasks recorded for this project` |
| still loading | (nothing) | `task counts loading…` | `loading…` |
| call failed / denied | (nothing) | `task counts unavailable — CODE: message` | the same, plus *“that call failed, so this pane does not know”* |

The loading and failed states are stated **once** in the counts line rather than on all 85 rows,
and per-project in the detail. Two more populations are named in the counts line instead of being
folded away: tasks filed under a storage key with no project row (`N in projects not listed
here` — 5 here, for `/home/ubuntu/LangMartDesign`, which `/projects` genuinely does not list) and
tasks whose list id is not a session id, so Core resolved no session and therefore no project
(`N not attributable to any project` — 141 here). `324 + 5 + 141 = 470`, the exact total.

### Things worth knowing

- **The delta poll actually works here.** `GET /ttyd/processes` hangs `hash` off the *envelope*,
  as a sibling of `data`, and `?hash=<h>` answers `{success, unchanged:true, hash}` with **no
  `data` key at all**. The web client read `hash` off the unwrapped `data`, so its conditional
  fetch never armed and every 5 s tick refetched in full. `api()` here returns the envelope
  alongside `data`, the poll sends `?hash=`, and the unchanged branch returns without touching
  the list. (On a busy host the node rescans every second, so the hash often moves anyway — the
  saving is real but not guaranteed.)
- **Rich session detail is opt-in.** The cheap `?sessions=[…]` call runs always and gives file
  size, agent count and mtime for exactly the sessions on screen (~5 KB). Turn counts come from
  `identify`. Last-user-prompt, prompt/task counts, team and model need
  `?listCheck.projectPath=…`, which returns **every** session in that project — 832 KB for
  `lm-assist` on this host. The toggle is therefore off by default; once on, the pane sends
  `knownSessionCount`/`knownLatestModified` so repeat polls cost ~330 bytes instead.
- **Kills use a two-step in-DOM confirmation, never `confirm()`.** The app shell's iframe sandbox
  is `allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox` —
  no `allow-modals`, so `window.confirm()` is silently ignored there and would have killed
  without asking. The first click arms the button (`Confirm kill?`) for 6 s; the second kills.
- **Git remote links are rebuilt, not passed through.** A remote URL is config, so the pane only
  emits an `href` when host and path match a strict charset, and it drops any `user:password@`
  (an https remote can carry a PAT). Anything else renders as inert text — and that text is
  **redacted first**: the commonest reason https parsing fails is a PAT containing `/`, which
  breaks the userinfo group, so the fallback would otherwise have printed the whole
  `https://user:PAT@host/…` string. `redactCreds()` anchors on the last `@` followed by a
  host-shaped token *and* a `/`, which is the real userinfo/host boundary even when the secret
  itself contains `/` or `@`, and which leaves a benign path-side `@` (`…/repo@v1.git`) alone.
  Inert is not the same as safe: a rendered credential is still a leaked credential.
- **Both tabs consume the process snapshot, so both keep polling.** The per-project `(N live)`
  counts have no other source, so with the Projects tab open the timer still polls
  `/ttyd/processes` — every 15 s, snapshot only (no identify, no enrichment) and never forced, so
  an unchanged snapshot answers `{unchanged:true}` in ~200 bytes. Gating the timer on the
  Processes tab alone froze those counts at their boot value until the user switched tabs. The
  list repaint preserves `scrollTop`, because it is no longer only user-initiated.
- **The process count's denominator is the enriched list.** `enriched()` synthesises a row for a
  managed ttyd instance that has no matching process in `allClaudeProcesses`, so counting the
  numerator from enriched rows and the denominator from the raw array can print `showing 17 of
  16`. Both sides come from the same list, and any synthesised surplus is named in the line.
- Process scanning is POSIX-only; on Windows the list is legitimately empty and says so.
- **`/tasks/all` lands before `/projects` and must not paint.** It is the faster call (0.48 s vs
  1.86 s), so it routinely resolves first; painting then would replace the list's `loading…` with
  `No projects found.`. Its paint is gated on `projLoaded`, the same guard the process poll
  already carried for the same reason.

## Verification

`node --check` on `assets/app.js`; every route curled against a live `:3200`; the grant checked
against the **real** matcher (`core/dist/ui-pages/local-tier/grants.js` — `readDeclaredGrant` +
`grantAllows`), 7 calls allowed and 18 probes denied; and the app driven end-to-end through a DOM
stub whose `innerHTML` really parses, with `lmui.call` wired to real HTTP and **`lmui.js` loaded
unmodified** so `lmui.goto`'s own param validation runs on what this pane emits. Covered:
default load, `?project=<path>`, `?project=<name>`, `?project=<unknown>`, `?tab=console`, `?q=`,
`?session=<running>`, `?session=<not running>`, `session`+`q` together, and a forced 403 on
`/tasks/all`. Escaping was checked by splicing a project row whose path, `encodedPath`,
`managedBy`, branch, remote name and last user message all carry `"><script>`-shaped markup:
stripping the pane's own tags from the rendered list + detail + process list leaves **0** raw
tags.

## Deploy

The integrator registers it; the manual path is:

```bash
cp -r ui-apps/assist-projects ~/.lmui/apps/assist-projects
lm-assist restart          # (prod) — pick up the newly-served app
```

Then reach it in either tier:

- Hub gateway:  `https://<uiId>.<hub-ui-domain>/`  (relayed to this node)
- Local tier:   `http://127.0.0.1:<localUiPort>/ui/assist-projects/`

Both honor `?embed=1&theme=light|dark` for embedding inside the app shell.
