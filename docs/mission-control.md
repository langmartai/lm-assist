# Mission control — auto-resume and model-limit mitigation

> Read before changing the stall monitor, the `/model` fallback, or anything in `core/src/monitor/`.
>
> Split out of the repo [CLAUDE.md](../CLAUDE.md) so it is read on demand instead of loaded into every session. Content is unchanged.

### Auto-resume stalled sessions (server / network errors)
A `scheduled-jobs` handler `stall-monitor` (5 min, on by default) resumes sessions stalled on SERVER or NETWORK errors (529/5xx/server-rate-limit, plus transient connectivity loss — `Unable to connect to API`/`Connection error` when the internet drops — NEVER user usage-limits or auth) by sending `continue`. Backoff **widens** as retries keep failing (5,5,10,10,15,15… min) but is **capped** at `autoResumeMaxIntervalMin` (default 30) so it never hammers, and by default it **never permanently gives up** (`autoResumeNeverGiveUp`, default true) — it keeps retrying at the capped interval so a long outage recovers the moment connectivity returns. Local sessions are handled per-node; remote cloud CCRs only by the single auto-elected monitor (lowest online gateway-id from the hub `/machines` list). Toggles in project-settings: `autoResumeStalledEnabled` (default true), `autoResumeIntervalMin`, `autoResumeMaxAttempts` (only bounds retries when `autoResumeNeverGiveUp` is off), `autoResumeMaxIntervalMin`, `autoResumeNeverGiveUp`, `autoResumeRemoteScan`. Status: `GET /monitor/stalls` / MCP `stall_status`. Run on demand: `POST /scheduler/jobs/stall-monitor/run`.

### Auto model-limit mitigation (`/model` fallback)

A **second, independent** class beside auto-resume. When ONE model is exhausted
(`You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.`)
the session stalls forever: `continue` cannot help — the *model* is out. The same
`stall-monitor` job runs a model-fallback pass that detects the banner and sends
`/model <fallback>` (default Opus 4.8), then verifies the status line moved off the
limited model. Local sessions per-node; cloud CCRs only on the elected monitor.

**The two classes never cross:** `model_limit` is deliberately absent from
`SERVER_STALL_STATES`, so the resume pass cannot see a model-limited session (never sends
`continue` on a usage limit) and the fallback pass only fires on a model-named
"reached your … limit" banner (never switches model on a 5xx/529/network error).

**THE invariant — you can only be blocked by the model you are actually on.** The banner
is transcript history: it scrolls, never clears, and can be on screen for reasons that
aren't a live block. So the *live status line* decides (`sid: <uuid> <Model>`, read from
the BOTTOM of the pane). This gives idempotency (post-switch the banner remains, the model
moved ⇒ no-op) and blocks false positives (a session merely displaying the text — reading
a capture, editing these tests — is never switched; observed on this feature's own dev session).

⚠️ **`/model` is not always one-shot.** A conversation already cached for the current model
raises a `Switch model?` confirm dialog (a fresh session applies it silently). The shared
`sendModelSlash()` answers only the option that both affirms AND names the target model.
Both the tick and the mission-controller guard go through it.

⚠️ **Ordering + time-box are load-bearing.** `ScheduledJobs.runJob` marks a job running for
its whole duration and skips every later tick until it returns (`scheduled-jobs.ts:543`) —
so an unbounded pass doesn't run long, it **silently disables the job forever**. The
cloud-CCR scan is sequential HTTPS per session (~55s live). Hence: auto-resume runs FIRST
and unbounded; model-fallback runs SECOND under `MODEL_FALLBACK_BUDGET_MS` (45s) with its
own `REMOTE_SCAN_BUDGET_MS` (25s), reporting `modelFallback=timeout` rather than holding
the job open. Never reorder these.

⚠️ **Never overrule an explicit human decision.** `Kept model as <limited>` (the user chose
"No, go back") more recent than the banner ⇒ `user-kept-model` no-op. A cloud CCR has no
status line, so current-model falls back to the last `/model` outcome (`Set model to X` /
`Kept model as X`) — without it the remote path runs with the invariant switched off.

Settings: `autoModelFallbackEnabled` (default true), `autoModelFallbackModel` (default
`'opus'`), `autoModelFallbackFrom` (default `['fable']`). Switches are journaled to
`~/.lm-assist/model-fallback.json` (7-day TTL) and surfaced at `GET /monitor/stalls` /
MCP `stall_status` under `modelFallback`. Modules: `core/src/monitor/model-limit.ts`
(pure detector + policy), `model-fallback.ts` (tick + actions), `model-fallback-store.ts`.
Design: [`docs/superpowers/specs/2026-07-22-auto-model-limit-mitigation-design.md`](./superpowers/specs/2026-07-22-auto-model-limit-mitigation-design.md).

### Controller session exists only while there is DEMAND (`missionControllerColdMin`)

The supervisor computes a controller **demand** every tick (`computeControllerDemand`):
`none` (no non-terminal mission), `active` (an `active` mission), `warm` (open missions, one touched
within `missionControllerColdMin`, default 60 min) or `cold` (open missions, none touched for that long).

- `none` / `cold` → a live controller is **torn down** (history reason names the cause) and a dead one is
  **not launched**. A default install therefore runs no controller session until a mission exists.
- `warm` / `active` → the normal launch / drive table applies; demand returning (a mission created,
  touched or activated) relaunches the controller on that tick — resume-first, so it keeps its identity.
- `missionControllerColdMin: 0` disables the cold verdict (open missions ⇒ warm).
- Election still outranks demand: a non-leader never tears down for demand; an indeterminate election idles.

### Controller record ownership + one-controller-per-leader guards (2026-09-07)

The controller record (`__controller__` in the fleet-synced missions dataset) carries `node`.
A **non-leader never tears down or clears a record owned by another node** — that was the
split-brain of 2026-09-07: non-leader 107 "tore down" leader 123's record every minute (a local
no-op) and wrote it back as null, so 123 launched a new controller every tick (25 piled up, each
registering a remote-control session). Journal action: `teardown-skipped-foreign`.
Before any launch the supervisor **sweeps every unrecorded local `lmcc-*` tmux**
(`prelaunch-sweep`), and a launch whose record write fails **tears the new controller down again**
(`launch-unrecorded`) — one leader can only ever hold one controller.
To stop a runaway job without a deploy: `scheduler_jobs(action="pause", id="mission-controller")`
(works on built-in jobs) or set `missionControllerEnabled:false` in `~/.lm-assist/project-settings.json`.
