# Cloud-Session Bootstrap / Self-Heal Instruction — Design

- **Date:** 2026-06-22
- **Status:** Approved design (pre-implementation)
- **Branch:** `feat/cloud-bootstrap-self-heal` (lm-assist)
- **Repos touched:** `lm-assist` only (`core/src/terminal/ccr-cloud.ts` + ccr routes + MCP tools)

## 1. Problem & Goal

A cloud CCR session (Anthropic-cloud container, `environment_kind: anthropic_cloud`) is an **ephemeral
VM**: when it goes inactive it reboots/recycles — **the disk persists but every process dies** (measured:
resume after ~20 h → uptime 0 s, lm-assist install intact at `/opt/node22/...` but Core `:3100` down).
On a full teardown even the disk is reclaimed (only git survives). So lm-assist cannot "keep running"
across cloud inactivity.

**Goal:** for cloud sessions **we start/resume**, actively send a standing **bootstrap/self-heal
instruction** that makes the agent ensure lm-assist is installed + running **locally** before its task —
**restart** if just down, **install** (clone) if missing — covering **both roles** (worker, orchestrator)
and **both repo cases** (the session's repo is lm-assist, or a different project). The knowledge lives in
the always-reachable connector (`bootstrap` → `guide("install")` / `guide("roles")`), not the container,
so a resumed/torn-down container self-heals from instruction + connector alone. No host-side hook, no
opt-in flag — we only inject into sessions we control, so a user's own machine is never touched.

## 2. The instruction (what the agent is told to do, every start/resume)

```
1. Is Core up?    curl -s localhost:3100/health  (or lm-assist status) → ok ⇒ skip to role/task.
2. Down but installed?  (resumed/rebooted container — disk kept, process lost)  → lm-assist start  (~12s, no reinstall)
3. Not installed?  install lm-assist (see the two cases below) → lm-assist start
Then: assume your ROLE (worker | orchestrator), then do the task.
```

### Two repo cases (step 3)
- **Case A — the session's working repo IS `langmartai/lm-assist`:** install from it — call the connector
  `bootstrap` then `guide("install")` (`npm install --ignore-scripts` → `./core.sh build` → start), or the
  quick `npm install -g github:langmartai/lm-assist`.
- **Case B — the session's working repo is a DIFFERENT project** (e.g. `lm-unified-trade`, `LangMartDesign`):
  lm-assist is a **separate tool**. Install it **independently of your checkout** —
  `npm install -g github:langmartai/lm-assist` (npm **clones + builds** the custom lm-assist; does NOT touch
  your `<primaryRepo>`) + `claude plugin install lm-assist@langmartai`, then `lm-assist start`. For the
  detailed from-source build, `bootstrap` → `guide("install")`. **Then return to your task on `<primaryRepo>`.**

The resume path (steps 1–2) is identical in both cases; only the *where-is-the-source* branch (step 3) differs.
No hub key is embedded — connecting this node to the user's hub stays a separate, user-confirmed step.

### Role contract (after lm-assist is up)
- **worker:** follow `guide("roles")` — `set_role`, print a `⟦WORKER-STATUS⟧` block each turn, `report_status`,
  raise an agree-gate before sensitive steps. (Names the `taskId`/`title` if given.)
- **orchestrator:** follow `guide("roles")` — read worker status (`worker_status`/`list_workers`), drive workers,
  `decide_gate`.

## 3. Components (all in `core/src/terminal/ccr-cloud.ts` + thin surface)

| Unit | What |
|------|------|
| `buildBootstrapInstruction({ role?, taskId?, title?, primaryRepo? })` | **Pure** builder of the instruction text above. Replaces/absorbs the current install-only `buildSetupPreamble()` (kept as a back-compat alias = `buildBootstrapInstruction({})`). `primaryRepo` decides Case A vs B (lm-assist repo when absent or matches `…/lm-assist`); `role` selects the role contract; `taskId`/`title` name the worker task. |
| `cloudStart({ …, role?, primaryRepo? })` | When `setup` (renamed-compatible: also accept `bootstrap`) is requested, seed = `buildBootstrapInstruction({ role, primaryRepo: repo })` + the task prompt. Defaults `primaryRepo` to `opts.repo`. |
| `cloudDrive({ sid, text, reBootstrap? })` | When `reBootstrap` is true, **prepend** `buildBootstrapInstruction({...})` to `text` — the "actively send on resume" path, so a re-engaged inactive session self-heals before the new work. |
| ccr routes (`ccr.routes.ts`) | `POST /ccr/cloud/start` gains `role`, `primaryRepo`; `POST /ccr/cloud/:sid/drive` gains `reBootstrap`. |
| MCP tools (`expanded.ts`) | `ccr_cloud_start` gains `role` (+ `primaryRepo`); `ccr_cloud_drive` gains `reBootstrap`. |

## 4. Data flow

`ccr_cloud_start(repo=X, role=worker, task)` → seed carries self-heal+install(case A/B)+worker-contract → agent
brings Core up (restart or clone+install) → `set_role` → works + `⟦WORKER-STATUS⟧`. On resume:
`ccr_cloud_drive(sid, "<next>", reBootstrap=true)` → agent re-checks Core (`status || start`) → continues.

## 5. Error handling / edge cases

- The instruction is advisory text — it never crashes anything; worst case the agent ignores a line.
- Self-heal is idempotent: `lm-assist status || lm-assist start` (start is a no-op if already up — service-manager port-check).
- Case detection is best-effort: if `primaryRepo` is unknown, default to the lm-assist-repo phrasing **plus** the
  generic "if lm-assist isn't your repo, `npm install -g github:langmartai/lm-assist`" line, so both cases are covered.
- Back-compat: existing `setup:true` callers keep working (`buildSetupPreamble()` alias preserved; `cloudStart`
  without `role` emits the no-role self-heal+install).

## 6. Testing

**Unit (TDD, pure `buildBootstrapInstruction`):**
- self-heal lines present (`status`/`/health`, `lm-assist start`) in all variants;
- Case A (no `primaryRepo` / `…/lm-assist`) → from-repo / `guide("install")` phrasing, no "separate tool" clone line;
- Case B (`primaryRepo:"owner/other"`) → the "separate tool — `npm install -g github:langmartai/lm-assist`, then return to `owner/other`" clone line present;
- role=worker → worker contract + `taskId`/`title`; role=orchestrator → orchestrator contract; no role → neither;
- never embeds a hub key/url (`assert.doesNotMatch(/apiKey|wss:\/\//)`).
- `buildSetupPreamble()` alias still returns an install instruction (back-compat).

**Integration:** `cloudStart` seed (build the create body, assert the instruction is in the first-turn content);
`cloudDrive({reBootstrap:true})` prepends it; route + tool param plumbing.

**E2E (live cloud):** drive the lm-assist cloud session (`session_017iup`) — (a) Case-A **resume**: with Core
down, the `reBootstrap` drive makes the agent `lm-assist start` and Core returns (already proven manually in
~12 s); (b) Case-B **clone** (if feasible/affordable): a session whose repo ≠ lm-assist, `npm install -g
github:langmartai/lm-assist` brings lm-assist up without touching its checkout.

## 7. Out of scope (YAGNI)

No host-side `SessionStart` hook, no opt-in config flag, no watchdog/cron, no in-instruction hub auth
(separate user-confirmed step). Purely instruction text we send to cloud sessions we start/resume.
