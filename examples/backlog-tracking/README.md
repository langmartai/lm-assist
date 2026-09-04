# Backlog — issue & idea tracking Claude can use

A fleet-synced backlog graph: ideas, features, issues, bugs, and tasks as typed items with
statuses (`open → discussing → accepted → planned → implemented`, or `deferred`/`rejected`) and
**typed edges** — `relates-to`, `blocks`, `parent-of`, `depends-on`. It lives in the fleet data
service, so every node and every Claude session sees the same graph.

## From any Claude session

You don't call an API — you just say it, in claude.ai, Cowork, or Claude Code:

> **You:** file a bug for the flaky login test and link it to the auth-refactor idea
>
> **Claude:** *(lm-assist → backlog_create, backlog_link)* Filed **bl_4f2a91** "Flaky login test on CI" as a bug, status open, and linked it as *relates-to* the auth-refactor idea (**bl_88c210**). It'll show on the backlog graph under that cluster.

> **You:** what's open right now, and is anything blocking the release checklist?
>
> **Claude:** *(lm-assist → backlog_list, backlog_graph)* Seven open items: three bugs, two features, two tasks. One blocker in the graph — **bl_2d9e04** "Migrate settings store" *blocks* **bl_31f7a8** "Release checklist". Nothing else is connected to the release.

> **You:** accept the settings-store migration, and note we'll start after the schema freeze
>
> **Claude:** *(lm-assist → backlog_update, backlog_discuss)* **bl_2d9e04** moved open → accepted (rev 3 of the item), and I attached the discussion note "Starting after the schema freeze" with this session recorded as the author.

Tools involved: `backlog_create`, `backlog_list`, `backlog_get`, `backlog_update`, `backlog_link`, `backlog_graph`, `backlog_review`, `backlog_discuss`

Because it's a first-class MCP surface, sessions file what they find as they work — a bug
discovered mid-task becomes a linked `bl_…` item instead of a lost TODO comment — and mission
control can pick items up from the same graph (a mission carries the backlog ids it serves).

## The graph view

![The backlog graph — typed items and edges, content masked](./backlog-page-masked.png)

Filter by type and status, search by title/tag/id, cluster layout, and a legend for the edge
types. The same page ships as a standalone UI pane (see [ui-panes](../ui-panes/)).

Notes:
- Statuses rot if nobody tends them — `backlog_review` exists precisely to sweep stale items
  against reality before you trust the board.
- Items are fleet data: create on any node, read from any session, link across projects.
