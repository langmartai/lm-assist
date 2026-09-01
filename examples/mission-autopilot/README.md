# Mission control — Claude Code sessions that drive themselves

Missions turn "keep working on this until it's done" into infrastructure. A mission is a goal
with tags, relationships, and history; a **fleet-elected controller** session spawns worker
Claude Code sessions for it, watches them, answers their questions, and re-engages when they
stop. Workflows describe the repeatable shapes.

## Driving work

```
mission_create(title, objective, …)      → a mission (linked to backlog ids if it serves them)
mission_place / mission_spawn            → pick the right node, start the worker session
mission_sessions / mission_session_read  → what the workers are doing right now
mission_session_drive / _answer          → steer a worker or answer its question
mission_workflow_set / _get / _list      → the repeatable playbooks workers follow
mission_onboard                          → teach a fresh session its mission context
mission_graph / mission_history          → the whole picture, and how it got here
```

The controller is itself a Claude session — elected across the fleet, failing over if its node
goes down — so the "auto" in autopilot is a real agent reading executor feedback, not a cron
loop. The Missions page shows the controller conversation live, including the moments it needs
you (a question card with suggested answers):

![The Missions page — controller chat, question card, mission list, content masked](./missions-page-masked.png)

## The resilience utilities underneath

Two independent monitor passes keep long-running sessions alive — they are deliberately
separate classes and never cross:

- **Server / network interruptions → auto-resume.** Sessions stalled on 529/5xx/server rate
  limits or transient connectivity loss are resumed with `continue`. Backoff widens
  (5,5,10,10,15… min), is capped (default 30 min), and by default **never gives up** — a long
  outage recovers the moment connectivity returns. It never touches usage limits or auth.
- **Model usage limit → model fallback.** When one model is exhausted ("You've reached your …
  limit"), `continue` can't help — so the monitor sends `/model <fallback>` (default Opus) and
  verifies the **live status line** actually moved off the limited model. The banner alone is
  never trusted (it's transcript history), and an explicit human "keep model" choice is never
  overruled. Your session keeps working through the limit window instead of idling.

Check both from anywhere: `stall_status` (MCP) or `GET /monitor/stalls`. Scheduler jobs cover
the rest of the utility belt — one-time (`run_at`), recurring, or trigger-only jobs with full
run capture and guard conditions.
