# assist-scheduler

lm-assist's internal job scheduler (`core/src/scheduler/scheduled-jobs.ts` — the in-Core cron
replacement) as a scoped UI pane. A plain-JS app (no build, no framework) that lists the
scheduled jobs and, for the selected one, shows its config, most-recent run, full run history,
and a safe test-run button — all through the node's `/scheduler` routes.

It follows the `assist-knowledge` / `assist-backlog` pilots exactly: the same unmodified
document runs behind the hub's ui-gateway AND behind the node-local HTTP tier, because every
data call goes through the injected `assets/lmui.js` SDK helper (view token + re-mint on
401/403), never a hard-coded origin. `assets/lmui.js` is copied verbatim from the pilots.

## Grant

Four leaf rules in `lmui.config.json`, and nothing else it can reach:

```
node:/scheduler/jobs        [GET]   exact
node:/scheduler/jobs/*      [GET]   exact
node:/scheduler/jobs/*/logs [GET]   exact
node:/scheduler/jobs/*/run  [POST]  exact
```

🔴 **The write is one leaf route, not the `/scheduler` prefix it used to be.** `node:/scheduler
[GET, POST]` granted `POST /scheduler/jobs` (create a scheduled job) and
`POST /scheduler/jobs/:id` (reconfigure one — interval, enabled, command) on top of the run
button. A pane that can create a scheduled job can run arbitrary work on this node forever; that
authority now sits outside the ceiling, and the prose below ("no create/arm is ever issued") is
enforced by the grant rather than by the app's good behaviour.
The narrowing uses the leaf/exact rule form in `core/src/ui-pages/local-tier/grants.ts`:
`"exact": true` means the request path must have the SAME NUMBER OF SEGMENTS as the rule
(a leaf, not a subtree), and a whole-segment `*` matches exactly one segment — how a rule
names a path parameter. The hub's ui-gateway enforces both identically
(`LangMartDesign/ui-gateway/src/viewtoken/grant.ts`), so a pane narrowed here is narrowed
on both serving tiers.

The four rules cover everything this pane calls (paths + shapes mirror
`core/src/routes/core/scheduler.routes.ts`):

- `GET /scheduler/jobs` — the job list. `data` is a **wrapper `{ jobs:[...], count }`** (not a
  bare array); the pane reads `data.jobs`.
- `GET /scheduler/jobs/:id` — one job (bare `ScheduledJobView`), for the detail pane.
- `GET /scheduler/jobs/:id/logs` — run history, `data = { id, logs:[...], count }`, newest first.
- `POST /scheduler/jobs/:id/run` with body `{ test:true }` — the **only write**: it runs the job
  now and captures full output, but `test` mode does **not** advance the schedule clock or the
  run count. No `PUT`/`DELETE`/create/arm is ever issued, so a job can never be enabled, armed,
  reconfigured or deleted from this pane.

The view token's grant is the hard ceiling — anything outside these four rules 403s.

## Layout

Two panes:

- **List** — a text filter (name / id / type / description) and an enabled/disabled/all state
  filter, then the job rows: name, enabled + running + built-in/custom pills, interval, a last-run
  summary (status · exit · duration · when) and the next-run time.
- **Detail** — the selected job's pills + description + metadata (interval, next run, last run, run
  count, created/updated), its **config** as plain-text JSON, its **last run** record, a **Logs**
  toggle (the run history, each entry's status/exit/duration plus stdout/stderr in monospace
  blocks), and a **Test run** button whose result is shown clearly labeled as a non-advancing test.

A hard failure of the primary list call surfaces the server's own error text full-screen —
nothing is swallowed.

## Deploy

The integrator registers it; the manual path is:

```bash
cp -r ui-apps/assist-scheduler ~/.lmui/apps/assist-scheduler
lm-assist restart          # (prod) — pick up the newly-served app
```

Then reach it in either tier:

- Hub gateway:  `https://<uiId>.<hub-ui-domain>/`  (relayed to this node)
- Local tier:   `http://127.0.0.1:<localUiPort>/ui/assist-scheduler/`

Both honor `?embed=1&theme=light|dark` for embedding inside the app shell.
