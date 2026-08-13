# assist-skills

The node's **skill inventory and usage analytics** as a scoped UI pane — the migration of the
web app's `/skills` page (`web/src/components/skills/{SkillsPage,SkillList,SkillDetail,SkillAnalytics}.tsx`).
A plain-JS app (no build, no framework, no dependencies) that lists every installed skill grouped
by plugin, and for the selected one shows its description, usage stats, the sessions that invoked
it and a per-day usage timeline — plus a fleet-wide analytics column.

It follows the `assist-scheduler` / `assist-knowledge` / `assist-backlog` pilots exactly: the same
unmodified document runs behind the hub's ui-gateway AND behind the node-local HTTP tier, because
every data call goes through the injected `assets/lmui.js` SDK helper (view token + re-mint on
401/403), never a hard-coded origin. `assets/lmui.js` is copied verbatim from the pilots.

## Grant

One declared grant in `lmui.config.json`, and nothing else it can reach:

```
node:/skills [GET]
```

**GET only.** The prefix also carries `POST /skills/reindex` and `POST /skills/refresh-inventory`
— the page never called them and this pane does not ask for `POST`, so it cannot rebuild the index
or rescan the plugin cache. It is read-only by grant, not merely by convention.

That prefix covers every call it makes (paths + shapes mirror
`core/src/routes/core/skills.routes.ts`, re-verified against the live dev API):

- `GET /skills` — the inventory. `data` is a **wrapper `{ skills:[...], total }`** (not a bare
  array); the pane reads `data.skills`. Rows carry `directInvocations`, which the detail route
  does not.
- `GET /skills/detail/:skillName` — one skill. `data` is **FLAT** — there is no `{skill}` key: the
  skill's scalar fields *plus* its own `sessions` array with `totalSessions/limit/offset/hasMore`.
  The pane passes `?limit=200&offset=…`; `hasMore` drives a Load-more button.
  ⚠️ It answers **HTTP 400 `NOT_FOUND` for a skill that has never been invoked** (21 of the 131
  installed skills here), because it is keyed on the usage index rather than the inventory. That is
  a normal outcome, so the pane falls back to the inventory row it already holds and labels it
  *no usage recorded* instead of showing an error.
- `GET /skills/analytics` — `{ top10, byPlugin, overall }`. `overall.successRate` is a **fraction
  0..1**, not a percentage.
- `GET /skills/analytics/chains` — `{ chains:[{sequence,occurrences,projects}] }`. **The route caps
  itself**: `detectChains()` keeps sequences seen ≥2 times, sorts by occurrences and ends in
  `.slice(0, 20)`. So the array is a top-20, not a total — the UI discloses that rather than
  presenting `chains.length` as the number of chains on the node.

Deliberately **not** carried over: `/sessions/:id/skills` and `/sessions/:id/commands`. They live in
the same route file and are used by `SkillTimeline.tsx` / `CommandTimeline.tsx`, but those components
belong to the session detail page, not to this one — so the grant stays off `/sessions` entirely.

The view token's grant is the hard ceiling — anything outside `/skills` 403s.

## Layout

Three panes (the analytics column drops underneath below 1280px; everything stacks below 1000px):

- **Skill list** — a text filter (skill name / short name / plugin) and an all / used / never-used
  chip row, then the skills grouped by plugin. Group headers collapse and show `skills · invocations`;
  rows show the short name, an invocation-count pill, and when the skill was last used. Never-used
  skills are dimmed. The selection is remembered across reloads, and `?skill=<skillName>` deep-links
  straight to one (see the param table below).
- **Detail** — the skill's full description (plain text, pre-wrap), the invocations / sessions /
  success-rate / direct stats, first + last use and install path, then two tabs:
  - **Sessions** — one card per session that invoked the skill: success dot, `sub` badge, project,
    short id, and whatever the session cache enriched it with (last message, model, cost, turns,
    prompts, agents, size — all optional, and absent on a node whose cache has not seen the file).
    Sessions with subagents expand into a per-agent list. Paged 20 at a time, with **Load more**
    when the server says more records exist.
  - **Usage timeline** — the same records grouped by local day, newest first, each with its clock
    time, project, tool-use count and `sub` badge.
- **Analytics** — overview cards (total skills, invocations, success rate, failures), a Top-skills
  bar chart (clicking a bar selects that skill), a by-plugin breakdown, and the detected
  common skill chains.

  **Common chains states its cap.** The web page rendered `chains.slice(0, 10)` and said nothing
  about the rest, so a 10-chain node and a 20-chain node looked identical. The pane keeps the
  10-row preview but puts `10 of 20+` beside the heading, adds a **Show all 20 / Show top 10**
  toggle, and spells the ceiling out: *showing 10 of 20 chains held — the API returns at most 20*.
  The `+` and that sentence are not decoration — `skillIndex.detectChains()` itself ends in
  `.slice(0, 20)`, so a full 20 rows means **at least** 20 and the true total is unknown to the
  client. This node returns exactly 20, i.e. it is already truncated server-side.

## Cross-pane links — the pinned param vocabulary

A param name is an interface. The rule is **the entity's singular noun, unqualified**, plus the two
generic modifiers `tab` and `q`. Both directions of that contract are listed here because a name
only works if the emitter and the reader agree; a pane that emits a name nobody reads is a silently
broken button, and a pane that ignores the name for the entity it displays is that same bug pointed
the other way.

**Emitted** — via `lmui.goto`, never a hand-built URL:

| target | params | from |
|---|---|---|
| `assist-sessions` | `session=<sessionId>` | a session card in the **Sessions** tab or a row in **Usage timeline** |
| `assist-sessions` | `session=<agentId>` | a subagent row under a session card |

Both emit the **same** name because both open the same kind of thing. A subagent's `agentId` is a
valid session identifier over there — that pane's `/sessions/:id` lookup matches an `agentId` as
well as a `sessionId` — so `session` is the honest word for it, not a second name for one entity.
⚠️ This pane previously sent `{id}` from one handler and `{session}` from the next to that one
target, plus a non-pinned `parent` hint; all three are gone.

**Accepted** — read from `location.search` on load, and landed on:

| param | effect | notes |
|---|---|---|
| `skill=<skillName>` | selects that skill and opens its detail | wins over the remembered selection. The full name, e.g. `superpowers:brainstorming`. If this node has no such skill the pane **says so by name** rather than silently showing the placeholder, and does not clobber the operator's remembered selection. |
| `tab=sessions\|timeline` | which detail sub-view opens first | validated against those two values; anything else is ignored. Applies to the **first** skill opened only — a deep link describes one arrival, not a preference. |
| `q=<text>` | prefills the list's filter box | set on the input as well as in state, so a filtered list is never one whose box looks empty. |

(`embed=1` and `theme=light\|dark` are the shell's, not this vocabulary's.)

A hard failure of the primary inventory call surfaces the server's own error text full-screen;
a detail failure stays inside the detail pane with a Retry button. In the analytics column the two
reads fail **independently**: a chains failure renders its own error card + Retry and leaves the
overview standing, and it is never flattened into the empty state — `[]` renders as *No repeated
skill chains detected*, which would report a transport failure as a fact about this node. Every
list (skills, sessions, timeline, chains) has a distinct loading, empty and error state. Nothing is
swallowed, and no server text is ever interpolated as HTML.

## Deploy

The integrator registers it; the manual path is:

```bash
cp -r ui-apps/assist-skills ~/.lmui/apps/assist-skills
lm-assist restart          # (prod) — pick up the newly-served app
```

Then reach it in either tier:

- Hub gateway:  `https://<uiId>.<hub-ui-domain>/`  (relayed to this node)
- Local tier:   `http://127.0.0.1:<localUiPort>/ui/assist-skills/`

Both honor `?embed=1&theme=light|dark` for embedding inside the app shell.
