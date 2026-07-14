# Mission Control onboarding — multi-phase / multi-subagent review (2026-07-15)

**Question asked:** can Mission Control onboard and drive a *medium-complex* mission that needs
**design → bugfix → (sub-agent) implementation → deploy**, and what's wrong with the process?

**Short answer:** the onboarding + follow-up handling worked well for *single-purpose* sessions, but
**flattened composite work into one work-type, tracked no phase, guided no sub-agent fan-out, and had
no deploy step at all** — so a mission whose definition-of-done includes "deployed" would be marked
done the moment the feature merely *worked*. All of these are now fixed at the playbook level
(validated live on staging), with the deeper ones flagged as code-level recommendations.

## How it was validated

A composite scenario repo (`~/health-svc` on staging 123) was built to genuinely require all four
phases: a **design** decision (what a `GET /health/deep` checks), a **planted bug** (`/health` returns
HTTP 200 `status:ok` even when the DB check fails), a **decomposable implementation** (three
independent sub-checks — DB / disk / upstream), and a **deploy** (`./deploy.sh` must produce a
`RELEASED` marker). A real Claude Code session stated that 4-phase goal and was onboarded into Mission
Control on the staging leader.

## What's wrong (root-caused, most-severe first)

| # | Severity | Gap | Root cause | Status |
|---|----------|-----|-----------|--------|
| **W1** | **High** | **No deploy phase → false completion.** Every `drive.*` and `wrapup.completed` end at "verify + mark done." A mission whose DoD includes *deployed* is marked done after the feature works; the deploy never runs. | `workflow-defaults.ts` — no `drive.deploy`; `wrapup.completed` step 4 = "Mark the mission done." | **Fixed** (new `drive.deploy` + completion discipline) |
| **W2** | **High** | **No phase tracking for composite work.** `onboard:state` is coarse (analyzing/in-progress/stuck/completed); `onboard:work-type` is single and immutable in routing; `progress` is just `{percent}`. A design→bugfix→deploy mission is opaque "in-progress"; the *event-driven* controller re-reads a flat doc each pass (possibly a different controller after failover) with no durable place-marker → risk of losing its place or completing early. | `mission-model.ts` has no phase field; `controller.pass` routes `drive.<work-type>` once. | **Fixed** (durable `ctl:phase` tag + `drive.multi-phase`) |
| **W3** | Med-High | **Single work-type flattening loses per-phase rigor.** `onboard.analyze` forces *exactly one* work-type; the composite became `feature`, so the bugfix sub-part lost `drive.bugfix`'s reproduce → root-cause → regression-fails-before/passes-after discipline (buried in `drive.feature`'s generic "implement→test"). | `onboard.analyze` step 2: "WORK-TYPE: exactly one of…". | **Fixed** (composite detection → `multi-phase`; per-phase docs re-fetched) |
| **W4** | Medium | **Controller can't orchestrate sub-agent fan-out for onboarded missions, and nothing guided it.** The scheduler excludes onboarded missions from the spawn-ready pool, so the controller never places executors for them. The onboarded *session* can spawn its own sub-workers (and `handleSessions` surfaces them, binding-kind-agnostic), but no playbook told it to. | `mission-scheduler.ts:75` (`origin==='onboarded' → continue`); no fan-out guidance in `drive.*`. | **Partially fixed** (in-session fan-out now guided; controller-orchestrated sub-missions = recommendation R2) |
| **W5** | Medium | **The one real multi-phase mechanism is both unguided *and discouraged*.** The controller *can* `mission_create` child missions with `parentId=<onboarded>` (children are schedulable → the epic/rollup engine exists), but no playbook uses it and `wrapup.completed` explicitly says "do not create missions unprompted." So the platform's epic capability is unreachable for onboarded work by policy. | `wrapup.completed` step 3; no epic guidance. | **By design** kept the session-drives-its-own-phases model (no contradiction added); epic mode = R2 |
| **W6** | Medium (ops) | **The fleet-scoped registry can't stage a process change.** `mission_workflow_set` is immediately live *fleet-wide, including prod* — no canary / draft / cluster-scope for a *process* change. Safety is versioning + rollback only. | `workflow-store.ts` dataset `scope:'fleet'` (design decision D5). | **Recommendation R3** (edits here were additive + backward-compatible, so prod's single-type behavior was unchanged) |
| — | Low | **onboarded + epic-container interplay untested.** If a controller ever makes children of an onboarded parent, that parent becomes a "container"; the onboarded exclusion precedes the container check so it's skipped from ready either way, but rollups compute for it and "an onboarded mission that is also an epic with a live session" is novel. | `mission-scheduler.ts:75-76`. | Kept out of scope by the chosen model |

### The empirical "before"

The controller was *smart* — it narrated all four phases in the mission's objective/plan/nextSteps
(even numbering them "P1…P4"). But the **structured routing collapsed to `onboard:work-type: feature`
with no `ctl:phase`**, so it would follow the flat `drive.feature` doc: bugfix rigor lost (W3),
no phase marker (W2), and **"feature works → status done" with the deploy never run (W1)** — a mission
marked complete while its actual definition-of-done (the `RELEASED` marker) was unmet.

## What was changed (playbook-level, live + codified)

The workflow registry is *designed* to be edited live (versioned, attributed, rollback-able), so the
fixes are playbook edits, not code rewrites:

- **NEW `drive.multi-phase`** — composes the existing per-phase docs. Reads the durable `ctl:phase`
  tag first, drives *only* the current phase with that phase's own doc (`drive.design` / `drive.bugfix`
  / `drive.direct-impl` / `drive.deploy`), records evidence, advances `ctl:phase`, and **never completes
  until the final phase is verified.** For a decomposable impl phase it directs the *session* to fan out
  to its own parallel sub-agents (the session orchestrates its sub-agents; the controller monitors via
  `mission_session_read` / `mission_sessions`).
- **NEW `drive.deploy`** — the missing ship step: verify-before-deploy, a **human gate for prod /
  irreversible targets** (never auto-deploy to prod — aligns with the invariant "never auto-approve a
  material action"), and **verify the release actually landed** (not just "exit 0").
- **`onboard.analyze`** — detects composite work → sets `onboard:work-type=multi-phase`, writes an
  ordered phase plan, sets `ctl:phase` to the first phase.
- **`controller.pass`** — routes `multi-phase → drive.multi-phase` and states the final-phase completion rule.
- **`wrapup.completed`** — won't complete a multi-phase mission until every phase (incl. a *verified*
  deploy) is done.

Applied to the **live fleet registry** first (validated), then **codified in `workflow-defaults.ts`**
(branch `feat/mission-multi-phase-playbooks`, commit `bb76792`, 486/486 mission+workflow tests) so the
improvement survives a registry reseed and reaches fresh nodes — 11 default docs now, was 9.

### The empirical "after"

The *same* composite mission, re-analyzed with the improved playbooks:

- `onboard:work-type: feature` → **`multi-phase`**; `ctl:phase: (none)` → **`design`**, plus an ordered
  phase plan written to the mission.
- The controller followed **"Per `drive.multi-phase` → `drive.design`"**, drove the design phase
  specifically, and the session produced a real `DESIGN-health-deep.md` (115 lines: a "failure
  isolation" design decision + the three sub-checks with pass/fail criteria).
- **Phase advanced `design → bugfix`** — the progression that did not exist before (the bugfix phase now
  gets `drive.bugfix`'s reproduce→regression rigor). The `⟦MISSION-CONTROL⟧` marker rail worked live.

## What remains (code-level recommendations)

These need a branch + tests + deploy, not just a playbook edit:

- **R1 — First-class `phase` on the Mission model** (vs. the ad-hoc `ctl:phase` tag). The tag is durable
  and works today, but a real field gives validation, dashboard rendering, and clean rollup.
- **R2 — A "controller-owned decomposed epic" mode for onboarded missions.** Optionally let the
  controller decompose an onboarded mission into *scheduled child missions with separate executors* (the
  existing epic/`dependsOn`/rollup engine) for genuinely parallel multi-agent work beyond the session's
  own sub-agents. Requires resolving the onboarded+container interplay and relaxing the wrapup
  "don't create missions" rule for controller-planned phases (W5).
- **R3 — Process-staging for the fleet-scoped registry (W6).** A per-doc `draft`/`status` or a
  cluster-scoped process channel so a playbook change can be validated on staging before it steers
  prod's controller. Today the only safety is version + rollback.
- **R4 — Deploy-target awareness.** `drive.deploy`'s prod-gate relies on the agent judging "prod vs
  scratch." A structured deploy-target/safety signal (via `machine_access` + an explicit target) would
  harden it.

## Operating notes

- **Live vs durable:** the improvements are live on the fleet registry now; commit `bb76792` codifies
  them so a reseed/fresh node matches. Merge + deploy that branch to align the code defaults, or leave
  it — the running fleet already has the behavior.
- **Rollback:** any doc reverts via `mission_workflow_rollback(id, toRev)` (edited docs are at rev 2;
  the two new docs at rev 1). `mission_workflow_history(id)` shows the trail.
- **Scenario artifacts on staging 123** (all inspectable, deletable): repo `~/health-svc`
  (+ `DESIGN-health-deep.md`), mission `mission_de47f6ef` (left in standby).
