# assist-mcp-tools

The MCP tool registry as a scoped pluggable-UI pane — every tool this Core advertises over
MCP (286 on this node), grouped by category, with the effective description, the code
default, the advertised `inputSchema`, the registered handler source, the admin-gate state,
the revision history, and the third-party plugin review surface. Follows the
`assist-backlog` pilot and the `assist-scheduler` template: plain JS, no build step, no
dependencies, `assets/lmui.js` copied verbatim from the pilots.

Ported from `web/src/components/mcp-tools/{McpToolsPage,ToolDetail,PluginsPanel}.tsx`.

## Grant

```json
[
  { "service": "node", "pathPrefix": "/mcp-tools",              "verbs": ["GET"] },
  { "service": "node", "pathPrefix": "/mcp-tools/*",            "verbs": ["POST"], "exact": true },
  { "service": "node", "pathPrefix": "/mcp-tools/*/rollback",   "verbs": ["POST"], "exact": true },
  { "service": "node", "pathPrefix": "/mcp-plugins",            "verbs": ["GET"] },
  { "service": "node", "pathPrefix": "/mcp/access",             "verbs": ["GET"] },
  { "service": "node", "pathPrefix": "/mcp/access/tool-gate",   "verbs": ["PUT"],  "exact": true },
  { "service": "node", "pathPrefix": "/mcp/pending",            "verbs": ["GET"] },
  { "service": "node", "pathPrefix": "/mcp/pending/*/confirm",  "verbs": ["POST"], "exact": true },
  { "service": "node", "pathPrefix": "/mcp/pending/*/deny",     "verbs": ["POST"], "exact": true },
  { "service": "node", "pathPrefix": "/health",                 "verbs": ["GET"] },
  { "service": "node", "pathPrefix": "/hub/status",             "verbs": ["GET"] },
  { "service": "node", "pathPrefix": "/claude-ai/mcp/servers",  "verbs": ["GET"] }
]
```

What each prefix covers:

- `/mcp-tools` **GET** — `GET /mcp-tools` (list + orphan docs + categories + counts),
  `GET /mcp-tools/:name` (detail), `GET /mcp-tools/:name/history`, plus the read-only
  `/overlay` and `/rev`. A subtree rule is fine on a read-only verb: no write can hide in it.
- `/mcp-tools/*` and `/mcp-tools/*/rollback` **POST** — `POST /mcp-tools/:name` (description
  override, enable/disable) and `POST /mcp-tools/:name/rollback`, named as LEAF rules
  (`"exact": true` = same segment count as the rule; `*` = exactly one segment, a path
  parameter). This used to be one `node:/mcp-tools [GET, POST]` line, which grants POST on the
  whole subtree — the same two routes today, but any mutating route added under `/mcp-tools`
  later would have joined this pane's authority with no config change and no review. Both
  evaluators enforce the leaf form identically (`core/src/ui-pages/local-tier/grants.ts` and
  `LangMartDesign/ui-gateway/src/viewtoken/grant.ts`).
- `/mcp-plugins` — `GET /mcp-plugins` (list + counts + `subsystemEnabled`),
  `GET /mcp-plugins/:name`, `GET /mcp-plugins/:name/audit`. GET-only, which also denies
  `POST /mcp-plugins/call` — the route that *executes* a plugin tool.
- `/mcp/access` — `GET /mcp/access` (the gate catalog) as a subtree on a read verb, plus
  `PUT /mcp/access/tool-gate` as its own LEAF rule. The PUT names one route and one verb: a
  `PUT /mcp/access/<anything-else>` added later is not covered.
- `/mcp/pending` — `GET /mcp/pending` (the parked list), plus `POST /mcp/pending/*/confirm`
  and `POST /mcp/pending/*/deny` as two separate LEAF rules. Note what this does **not**
  grant: `POST /mcp/pending` itself, `POST /mcp/pending/<id>`, and anything deeper than the
  two named leaves — verified against the shipped evaluator, see *Verification* below.
- `/health`, `/hub/status`, `/claude-ai/mcp/servers` — the Status view's four probes.

Three prefixes are deliberately *not* the obvious shorter ones:

- **`/mcp` would not work.** Prefix matching stops at a **segment boundary**, so `/mcp`
  covers `/mcp/access` and `/mcp/pending` but **not** `/mcp-tools` or `/mcp-plugins` — the
  next character is `-`, not `/`. Hence the separate rules. (It also means `/mcp` would not
  leak `/mcp-call`.)
- **`/hub/status`, not `/hub`** — `/hub/api-key`, `/hub/config` and `/hub/user` sit next to it.
- **`/claude-ai/mcp/servers`, not `/claude-ai`** — that prefix would carry every claude.ai
  route, including conversations and cookies.

The view token's grant is the hard ceiling — anything outside these twelve rules 403s.

### Which writes are held, and why

The source page performs eight writes. Five are granted here; three are not. The line is one
rule, and it is not a matter of taste:

> **Grant a write where no server-side locality control already exists. Withhold it where one
> does — and say so ON THE PAGE.**

**Held (5).** None of these has a server-side locality control, and the shipped web page
already performs all of them over the hub relay, so granting them to the pane defeats nothing
that exists:

- ✅ `POST /mcp/pending/*/confirm` and `POST /mcp/pending/*/deny` — **the reason this pane
  exists at the moment it matters.** A parked call expires **10 minutes** after it was made,
  so a read-only banner is not a smaller feature, it is a countdown to a silent failure the
  operator watches happen. `*` + `exact` separates the two leaves cleanly; an earlier version
  of this file claimed prefix granularity "cannot separate the safe `deny` from the dangerous
  `confirm`" — that was **wrong**, and the grant-evaluator check below is what disproves it.
  Both actions ask twice, and both report the OUTCOME, because the row disappears either way
  and "it vanished" must never be mistaken for "it ran".
- ✅ `PUT /mcp/access/tool-gate` — one leaf, one verb. Turning a gate **ON** is one click (it
  only *adds* an approval step); turning it **OFF** asks twice, because that *removes* one and
  the route records no history. The pane never offers the toggle when `/mcp/access` is
  unreachable: flipping a gate you cannot read is a coin toss on a security setting.
- ✅ `POST /mcp-tools/:name` (override, enable/disable) and `/rollback` — audited, revved,
  reversible from the History tab, with an optimistic-concurrency pre-check.

**Withheld (3)** — `POST /mcp-plugins/sync-connector`, `/:name/enable`, `/:name/disable`.
These are loopback-only server-side (`requireLoopback`, `core/src/routes/core/mcp-plugins.routes.ts`).
The decisive fact is **measured, not assumed**: a pane reaches Core over a *loopback socket on
both tiers* — the local tier proxies with `http.request({host:'127.0.0.1'})` (`ui-pages/local-tier/server.ts`)
and the hub relay's `makeLocalRequest` does the same (`hub-client/api-relay-handler.ts`). On
this node:

```
POST /mcp-plugins/nosuchplugin/disable  from 127.0.0.1  → NOT_FOUND   (guard passed)
POST /mcp-plugins/nosuchplugin/disable  from 10.0.1.117 → FORBIDDEN   (guard blocked)
```

So a grant here would not *pass* that control, it would *defeat* it: an owner-at-the-console
action would become one that anything holding a 15-minute view token in a LAN browser can
fire. Enabling a plugin additionally authorises third-party code execution on the host, and
`sync-connector` mutates the user's **claude.ai account** (cached tool list, per-tool access,
auto-approve) — state no grant written here can scope.

**The disclosure lives in the pane, not in this file.** A capability gap documented only in a
README is discovered exactly when it is too late. So the pane renders a **capability ledger**
above the tabs, on every tab, listing all three withheld actions with what each does, why it
is not here, and where to run it — plus what the pane *does* hold. The Plugins tab repeats it
where the missing Sync/Enable/Disable buttons would have been. This section is the long-form
version, not the only version.

## Layout

- **Capability ledger** — above the tabs, on every tab: the three actions of the source page
  this pane cannot fire, each with what it does, why it is not here and where to run it, plus
  the six it can. Collapsed to one line by default.
- **Pending strip** — parked admin confirmations with **Confirm** and **Deny** per row, above
  the tabs so they are visible from every view. Polled every 15s (they expire in 10 minutes);
  the 286-row registry is not polled, which is what Refresh is for.
  - Rendered in **all four** states — loading, empty, rows, error — and never hidden. An
    empty strip that hides itself makes "nothing is parked" and "the poll has been failing
    for ten minutes" look identical, and under that ambiguity a real parked call dies while
    the operator watches an apparently clean pane. The three states are visually distinct
    (calm / amber / red).
  - Both actions arm on the first click and act on the second, and the armed label names the
    tool. Both then report the **outcome**: the row disappears either way, so a call that
    expired between render and click must say *the tool did NOT run* rather than let a
    vanishing row read as success. "Running…" is blue, not green.
  - An armed row that leaves the list (expired, or actioned from elsewhere) is disarmed on
    the next poll, and the poll never repaints over an in-flight decision.
- **Tools** tab — list | detail.
  - list: text filter, scope chips (read/write/admin), state chips
    (enabled/disabled/overridden/gated/protected), a category select, grouped by category in
    the server's declared order, plus an "unregistered docs" group for orphan registry docs.
  - detail: **Description** (effective / editable override / code default, with Save,
    Revert and Restore default), **Implementation** (module, tool definition incl.
    `inputSchema`, handler source — all read-only), **Settings** (enable/disable, the
    **admin-gate toggle**, scope/category/module), **History** (rev table with rollback).
- **Plugins** tab — third-party plugins: phase, pin, declared capabilities, the namespaced
  tools each would advertise, manifest errors, and the audit tail. **Review-only, and the tab
  says so**: the missing Sync / Enable / Disable are named there, with the reason, where the
  buttons would have been.
- **Status** tab — four independent probes (`/health`, `/mcp-plugins`,
  `/claude-ai/mcp/servers`, `/hub/status`), each reported separately so one failure never
  blanks the others.

Consequential actions use a two-click confirm — confirming a parked call, denying one,
disabling a tool, restoring a default, rolling back a rev, and turning an admin gate *off*.
Turning a gate *on* is one click, because it only adds an approval step. A failure of the primary list call raises the
full-screen fatal overlay carrying the server's own text; secondary failures land in the
status line. `/mcp/access` is best-effort: if it is unreachable the registry still renders
and the gate state is reported as **unavailable** rather than being guessed as "not gated",
which would misreport the security posture.

## Verification

Run from the repo with the dev Core up on :3200.

- **Grant** — the twelve rules are evaluated with the *shipped* evaluator
  (`core/dist/ui-pages/local-tier/grants.js`), not a reimplementation, over a table of
  allow/deny cases: `POST /mcp/pending/<id>/confirm|deny` and `PUT /mcp/access/tool-gate`
  allow; `POST /mcp/pending`, `POST /mcp/pending/<id>`, `.../confirm/extra`,
  `PUT /mcp/access`, `POST /mcp-plugins/*/enable|disable`, `POST /mcp-plugins/sync-connector`
  and `POST /mcp-plugins/call` deny.
- **Behaviour** — `assets/app.js` is executed in a DOM shim against the live Core, with
  `lmui.call` enforcing the real grant: a call is really parked over `POST /mcp` (by gating
  `search`, a read-only tool), then really denied and really confirmed through the pane's own
  delegated handlers; the gate is toggled on and off through the Settings tab; the gate is
  restored to its original state at the end.
- **Escaping** — the same shim is fed hostile `tool`, `summary`, `id`, response and error
  bodies. Every `<…>` the pane emits is parsed and required to be its own markup with no
  event-handler attribute. (Test the tags, not the substring: `onerror=` legitimately appears
  as inert text inside `&lt;img …&gt;` and inside a quoted `title="…"`.)

## Both tiers

Response envelopes differ between the hub relay (`{status,data}` wrapping the node's
`{success,data,meta}`) and the local tier (the node envelope passed through). `api()`
strips the outer layer when present, so this pane runs unchanged under both.

## Deploy

```bash
cp -r ui-apps/assist-mcp-tools ~/.lmui/apps/assist-mcp-tools
lm-assist restart
```

- Hub gateway: `https://ui-<ownerSlug>-assist-mcp-tools.<appDomain>/`
- Local tier: `http://<lan-ip>:<localUiPort>/ui/assist-mcp-tools/?lt=<entry token>`
  (mint with `POST /ui-pages/local-url {"uiId":"assist-mcp-tools"}`)

Both honor `?embed=1&theme=light|dark`.
