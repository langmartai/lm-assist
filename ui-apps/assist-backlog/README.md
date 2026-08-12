# assist-backlog

The backlog registry as a scoped UI pane — a plain-JS (no build, no framework) app that
lists, inspects, creates, edits and discusses backlog items through the node's `/backlog`
routes. It is the pilot pane for the lm-assist local serving tier: the same unmodified
document runs behind the hub's ui-gateway AND behind the node-local HTTP tier, because
every data call goes through the injected `assets/lmui.js` SDK helper (view token +
re-mint on 401/403), never a hard-coded origin.

## Grant

One declared grant in `lmui.config.json`, and nothing else it can reach:

```
node:/backlog [GET, POST]
```

That prefix covers list (`GET /backlog`), detail (`GET /backlog/:id`), history
(`GET /backlog/:id/history`), create (`POST /backlog`), update (`POST /backlog/:id`) and
discuss (`POST /backlog/:id/discuss`). The view token's grant is the hard ceiling —
anything outside `/backlog` 403s.

## Layout

Three panes: a client-side-filterable list (status/type chips + text filter, optional
"include removed"), a detail view (description rendered as plain text, plus edges /
discussion / reviews and edge/discussion/history counts), and a create/edit form with a
discussion-note box. Type / status / priority are select fields carrying the model enums
(`idea|feature|issue|bug|task`, `open|discussing|accepted|deferred|rejected|planned|implemented`,
`low|med|high|critical`).

## Deploy

The integrator registers it; the manual path is:

```bash
cp -r ui-apps/assist-backlog ~/.lmui/apps/assist-backlog
lm-assist restart          # (prod) — pick up the newly-served app
```

Then reach it in either tier:

- Hub gateway:  `https://<uiId>.<hub-ui-domain>/`  (relayed to this node)
- Local tier:   `http://127.0.0.1:<localUiPort>/ui/assist-backlog/`

Both honor `?embed=1&theme=light|dark` for embedding inside the app shell.
