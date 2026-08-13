# assist-sessions

The Claude Code **session browser** as a scoped UI pane — a plain-JS (no build, no framework)
port of `web/src/app/(dashboard)/sessions/` and its
`web/src/components/sessions/{SessionBrowser,SessionSidebar,SessionDetail}.tsx` components.
It lists every session on the node and opens any one of them in a tabbed detail view. Like its
siblings, the same unmodified document runs behind the hub's ui-gateway AND behind the
node-local HTTP tier, because every data call goes through the injected `assets/lmui.js` SDK
helper (view token + re-mint on 401/403), never a hard-coded origin.

It exists because three panes from the previous batch already link here
(`assist-projects` → `{session}` and `{project}`, `assist-skills` → `{session,parent}` and the
legacy `{id}`). Every one of those buttons used to dead-end on a 404 pane chooser.

## Grant

Four leaf rules in `lmui.config.json`, all **GET**, and nothing else it can reach:

```
node:/projects              [GET]  exact
node:/projects/sessions     [GET]  exact
node:/projects/*/sessions   [GET]  exact
node:/sessions/*            [GET]  exact
```

The pane is strictly read-only — there is no write path to request. Verified against the real
matcher (`core/src/ui-pages/local-tier/grants.ts`): all 5 calls the app makes are granted, and
21 probes are denied, including `POST /sessions/:id/rename`, `DELETE /sessions/:id/summary`,
`POST /sessions/batch-check`, `GET /sessions/:id/subagents`, `GET /sessions/:id/conversation`,
`GET /projects/:p/tasks`, `GET /health` and every sibling pane's subtree.

🔴 **Why `exact` on all four, including the reads.** `node:/sessions` as a subtree would also
carry `GET /sessions/:id/conversation`, `/messages/last/:n`, `/from/:line`, `/queue` and the
whole `/monitor/*` neighbourhood — routes this pane never calls. `/sessions/*` + `exact` is the
smallest rule that expresses "one session's detail and nothing deeper". Same reasoning for
`/projects/*/sessions`: without `exact` it would swallow that project's `/tasks`, `/costs` and
`/size` too.

🔴 **The project path is passed dash-encoded, never percent-encoded.** Both grant evaluators
**refuse** a path containing `%2f` — they do not decode, they deny (measured:
`GET /projects/%2Fhome%2Fubuntu/sessions` → denied). So the pane never builds
`/projects/<url-encoded-abs-path>/sessions`; it reads `encodedPath` off `GET /projects`
(`-home-ubuntu-lm-assist`) and uses that single safe segment. That encoding is also *not* a
mechanical slash→dash transform of the path (`/home/ubuntu/.nvm/…/lm-assist/core` is keyed
`-home-ubuntu--lm-assist-mission-control`), so it genuinely has to be looked up, not computed.

## What was NOT ported, and why

| dropped | why |
|---|---|
| **Console tab** (`tabs/ConsoleTab.tsx`) | It is a live terminal — ttyd/WebSocket attach to a running PID. **Streaming across the pane data plane is a separate, still-blocked backlog item.** Nothing here opens a socket. |
| **The unified batch poll loop** (`SessionBrowser.tsx`) + the staleness watchdog | Live-refresh machinery. It also needs `POST /sessions/batch-check` — a write verb for a read, which would widen a deliberately GET-only grant. Replaced by explicit **refresh** buttons on the list and the detail. |
| **Plans, Skills, Commands, FlowGraph tabs** | Each needs a route outside this grant (`/plans/*`, `/skills/*`, `/sessions/:id/dag`). Deliberately not requested — a tab is not worth a wider ceiling. |
| **Raw-message JSON** (`includeRawMessages=true`) | Measured 2.1 MB vs 253 KB on the same 245-turn session, for text the pre-parsed arrays already carry. The JSON tab dumps the *fetched* detail instead (capped at 240 000 chars, and says so). |
| Machine picker / multi-node | A pane is served **by one node** and its data plane targets that node. There is no `machineId` to pick. |
| Mobile stack navigation, fullscreen, localStorage tab memory | Shell concerns; the pane is a two-column grid that collapses to one column under 900 px. |

Everything the detail route actually returns **is** rendered: eleven tabs — Chat, Thinking,
Tools, Files, Git, DB, Tasks, Agents, Team, Meta, JSON.

## Inbound params (read on load from `location.search`)

Pinned cross-pane vocabulary — the entity's singular noun, unqualified:

| param | meaning | behaviour |
|---|---|---|
| `session` | a session id | Fetched and opened **immediately**, in parallel with the list — see below. |
| `project` | a project path | Switches the list to that project's **complete** session list. |
| `tab` | a named sub-view | One of `chat · thinking · tools · files · git · db · tasks · agents · team · meta · json`. An unknown value (e.g. the excluded `console`) falls back to `chat` rather than rendering nothing. |
| `q` | search prefill | Fills the filter box and applies it. |

Two non-pinned names are also accepted, because callers emit them **today**:

- **`id`** — legacy alias for `session`, still emitted by `assist-skills` (app.js:644). Accepted
  so that button lands today; `session` wins if both are present.
- **`parent`** — emitted by `assist-skills` (app.js:640) alongside a subagent's `session`. Used
  only as a display hint: the detail shows a "Parent session …" back-link that opens it.

🔴 **`project` accepts a path OR a bare name.** The pinned vocabulary says `project` is a
project *path*, but `assist-projects` currently emits `projName(p.path)` — the **basename**
(app.js:480). Both resolve to the identical per-project call, so the button works before *and*
after that caller is fixed. If the name is ambiguous or unknown the pane falls back to the
all-projects list filtered client-side **and says so in a banner** — it never silently shows an
empty list.

🔴 **A deep-linked `session` never depends on the list containing it.** `assist-skills` links to
*subagent* sessions (`agent-a008bd1.jsonl`), which never appear in the session list at all, and
a plain session may simply be older than the loaded slice. So the detail fetch is fired
independently at boot and the pane flags the case ("Opened by link — this session is not in the
loaded list"). Verified: `?session=a008bd1` renders.

## Outbound params (emitted via `lmui.goto`, never a hand-built URL)

- `assist-projects` ← `{ project: <absolute project path> }` — the "Open project" button in the
  detail header. Pinned vocabulary, full path.

That is the only cross-pane emission. Its landing depends on `assist-projects` reading
`project`, which it does **not** do at the time of writing (it reads no params at all) — that is
the parallel half of this round.

## Caps — always visible, never silent

This node holds **6 583** sessions; the unlimited list is a **9.9 MB** response. So:

- The all-projects list fetches the **newest 300** (`?limit=300`, 458 KB) and the counts line
  reads `loaded newest 300 of 6,583 on this node — CAPPED, older sessions are not loaded`, with
  **fetch 300 more** and **fetch all 6,583** buttons beside it.
- A **project** filter uses `GET /projects/:key/sessions`, which takes no limit and returns that
  project's complete list (1 045 sessions / 1.5 MB for `lm-assist`) — the counts line then says
  `loaded ALL 1,045 sessions in lm-assist`.
- Rows paint 50 at a time with a `show +100 rows (N hidden)` button.
- The detail fetches `lastNUserPrompts=25` by default (selector: 10/25/50/100/200). When the
  route reports `hasMore`, a banner says which turns are **not** loaded.

🔴 **One honest gap.** `GET /projects/:key/sessions` is **not** process-enriched — only
`GET /projects/sessions` joins the process-status store — so in project view there is no
`running` object and no pid/ttyd/tmux badge. The pane prints that as a banner instead of showing
an empty badge column, which would read as "nothing is running".

## Verification

`node --check` on both JS files; every route curled against a live `:3200`; and the app driven
end-to-end against real payloads through a DOM stub
(`lmui.call` → real HTTP), which is how the `*/`-inside-a-block-comment bug and the
percent-encoding denial were caught. Escaping was checked on real data: session text containing
`<command-message>` renders as `&lt;command-message&gt;`, and stripping the pane's own markup
from a 137 KB detail render leaves **no** raw tags.

## Deploy

The integrator registers it; the manual path is:

```bash
cp -r ui-apps/assist-sessions ~/.lmui/apps/assist-sessions
lm-assist restart          # (prod) — pick up the newly-served app
```

Then reach it in either tier:

- Hub gateway:  `https://<uiId>.<hub-ui-domain>/`  (relayed to this node)
- Local tier:   `http://127.0.0.1:<localUiPort>/ui/assist-sessions/`

Both honor `?embed=1&theme=light|dark` for embedding inside the app shell.
