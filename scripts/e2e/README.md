# live-rc-connect E2E

Cross-node / cross-platform end-to-end test for the **live-session remote-control
connect** feature (`ccr.connect` / `mission_session_resume` → `ensureRemoteControlled`).

- `live-rc-e2e.sh` — POSIX/Linux nodes
- `live-rc-e2e.ps1` — Windows nodes

## What it proves

It exercises the **safety-critical** path against a real running Core (prod
`:3100`) without launching `claude` (no onboarding, no auto-RC, no cloud/quota):

1. **TEST 1 — never resume over a live process (safety):** a *live + unreachable*
   session with no `force` → the route returns `CONFLICT` / `needs-force` (HTTP
   409) and the owner process is **never killed**.
2. **TEST 2 — kill-gated path (opt-in, `DO_FORCE=1`):** `force:true` → the owner
   **is** killed (Linux `process.kill` SIGTERM→SIGKILL; Windows `taskkill /T /F`).
   With a transcript-less fixture the subsequent resume fails fast, so this stays
   cloud-free while still proving the destructive gate fires.

## How the fixture works (no claude needed)

`sessionVerdict` reports a session *live* iff `~/.claude/sessions/<pid>.json` names
an alive pid. The harness spawns a real long-lived process **reparented out of any
tmux ancestry** (`setsid --fork` on Linux; a hidden process on Windows) and writes
a synthetic pid-file for it. With no tmux pane (Linux) / no driveable console
(Windows) the verdict is `refuse` = *live + unreachable* — the exact state that
drives the kill-gate. Each run self-cleans (kills the owner, removes the pid-file).

## Run

```bash
# local (this node's prod :3100)
bash scripts/e2e/live-rc-e2e.sh
DO_FORCE=1 bash scripts/e2e/live-rc-e2e.sh        # also exercise the force kill

# another node (fixture must be co-located with that node's Core):
ssh <node> 'LABEL=<name> bash ~/live-rc-e2e.sh'
```

```powershell
# Windows node
$env:LABEL='win'; .\scripts\e2e\live-rc-e2e.ps1
$env:DO_FORCE='1'; .\scripts\e2e\live-rc-e2e.ps1
```

Exit code is non-zero if any assertion fails.

## Not covered (cloud / quota-gated)

The **inject** path (live + *reachable* → `/remote-control` → driveable cse) and a
full **kill → resume → driveable** round-trip require a real `claude` session and
hit claude.ai (this fleet also auto-enables Remote Control on launch, which
confounds a clean inject smoke). That logic — including the 2-attempt toggle
self-correction — is covered by the unit suite (`live-rc-connect-orchestrator`)
and the route smoke; run it deliberately when quota allows.
