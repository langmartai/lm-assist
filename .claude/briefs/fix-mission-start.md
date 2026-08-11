# Fix: missions do not start

> ⚠️ **SUPERSEDED 2026-07-27 — every defect below is FIXED and deployed.** Kept only as
> the historical brief that commissioned the work; do NOT act on it. Everything from
> here down describes behaviour that no longer exists.
>
> Landed on `main` `1dbc748` · `3d2bc7a` · `887777b` (bl_28543c78) and `a03382c` ·
> `3a9bf76` · `0dbb508` · `da734b1` · `f35b1ac` (bl_1c861246 + node selection):
> missions are born `waiting`; `effort` survives the constructor; `env.repo` is refused
> unless absolute; `mission_spawn` sets `status:'active'`; unplaced schedulable work
> re-engages the controller and a starvation net places it; `mission_place` reports
> `status`/`schedulable`; default isolation is native, and `node_select`/`node_profile`
> choose the host. Proven end-to-end on prod 117 — the controller placed
> `mission_e778de32` unaided (`binding.sessionId 86afca56…`, executor `alive`).
>
> Current state lives in `guide("missions")` / `guide("nodes")` and
> `docs/superpowers/specs/2026-07-27-native-default-and-node-selection-design.md`.

Handoff from a claude.ai conversation, 2026-07-26. Pointers over prose — verify each claim yourself, do not trust this document.

## The problem in one line
A mission created through the MCP API never gets an executor. It is born in a status the controller does not schedule, and even after that is corrected it can sit in `mission_schedule.ready` indefinitely without being placed.

## Reproduction (observed live, twice)
1. `mission_create({title, objective, plan})` → record comes back `status:"active"`, `env:{isolation:"cloud", resources:[], exclusive:false}`.
2. The Mission Controller schedules from `waiting`. `active` means "an executor IS running it", so the mission is never started. `binding` stays null forever.
3. Even after `mission_update({status:"waiting"})`, the mission appeared in `mission_schedule.ready` (no dependency, no serialize conflict, not a container) across FOUR consecutive controller ticks — 12:32, 12:34, 12:37, 12:39Z — and was never placed. Supervisor reported `action=idle` each tick.
4. `mission_spawn(id)` placed it immediately and cleanly.

Two orphans already in the store prove this is not new: `mission_1a961f6f` and `mission_9be4ac60`, both `status:"active"`, both `binding:null`, never placed, tagged `ctl:readiness: duplicate-suspect`. Do NOT blindly flip them to `waiting` — they are duplicate-suspect and would spawn possibly-redundant executors. Decide deliberately.

## Four defects, and they compound
1. **`mission_create` defaults `status:"active"`.** Either default to `waiting`, or make the scheduler consider `active`. Pick one deliberately — if `active` is meant to signal "already running", `waiting` is the correct birth state and the default is simply wrong.
2. **`mission_schedule.ready` → placement is not firing.** This is the defect I understand LEAST and it may be the important one. `ready` means the deterministic gate passed; the controller then judges contention and may legitimately defer — but it deferred four times with no `ctl:deferred-contention` tag and no visible reason. Determine whether the scheduler and the placement loop disagree about what is actionable, and whether "supervisor action=idle" is even the loop that places. If this is a real bug it is separate from defect 1 and deserves its own fix.
3. **The top-level `effort` param is silently dropped.** `mission_create({effort:"max"})` does not reach `env.effort`; the record comes back with no `effort` key. No error. Reproduced on `mission_df5c1595` and `mission_79445f96`, both requiring a follow-up `mission_update`. NOTE THE CONTRADICTION: `guide("missions")` now states `effort` is accepted top-level as an alias precisely because nested `env` can be dropped on some connector paths. Either the alias is broken or the doc is aspirational. Reconcile them — do not just trust the doc.
4. **`env.repo` must be an ABSOLUTE path.** A bare name resolves against Core's install dir and `mission_spawn` dies with `git worktree add /home/ubuntu/.nvm/versions/node/v20.19.6/lib/node_modules/lm-assist/core/lm-assist/.claude/worktrees/... spawnSync git ENOENT`, which reads like a missing git binary and is actually a bad cwd. Consider validating/rejecting at the boundary instead of failing in git.

Related ergonomics, already documented: `tags` VALUES must be arrays (`{priority:["high"]}`); a bare string throws `TypeError: (vals ?? []).map is not a function` and fails the whole create.

## Reference material — read these first
- `backlog_get({id:"bl_28543c78"})` — the filed bug, plus a discussion note carrying defect 3 and the four-tick evidence. This is the root-fix item.
- `mission_workflow_get({id:"case.mission-status-waiting-not-active"})` — the operator workaround case.
- `guide("missions")` — ALREADY UPDATED with the workarounds (status table, env traps, evidence rules). When you fix the root cause, go back and DELETE the workarounds rather than leaving them to rot. The guide/bootstrap content lives in an editable registry, shipped by `mission_02694681`.
- `mission_df5c1595` (conversation_tokens + conversation_fork) and `mission_79445f96` (the guide documentation mission) — the two live missions this was learned on. Both are `status:"waiting"` and unfinished; leave them alone unless your change affects them.

## A warning about verification
Both missions above lost their workers. `mission_79445f96`'s worker `14f05a67` went GONE (`resume→gone`) and the controller bound a replacement; `mission_df5c1595`'s worker `e4e79a9b` was resumed with an `autoCloseAt` timer. See `case.resumed-session-autoclose`. If your fix appears to work but the worker vanishes, you may be looking at a SECOND unrelated problem — do not let it mask or fake your result.

## Done means
Create a REAL throwaway mission through the normal API and watch it receive an executor with NO manual `mission_spawn` and NO manual status flip. Evidence is `binding.sessionId` plus `mission_executor_status` showing `alive`. Unit tests are not evidence here — the whole bug is that the record looks fine while nothing runs. Clean up the throwaway mission afterwards.

Do not mark this done because the code looks right. Watch a mission start.
