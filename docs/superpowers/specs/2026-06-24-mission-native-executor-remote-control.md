# Mission Controller — native executor via `claude --remote-control` — Design

**Date:** 2026-06-24
**Status:** Approved (design; mechanism validated by live spikes on this host)
**Branch:** `feat/mission-controller`

**Goal:** Make the Mission Controller's **native (worktree) executor** path real: launch a LOCAL Claude Code session with `claude --remote-control` (which **auto-enables remote CCR control** — the session self-registers a cloud `cse`), then **read** it from its local transcript and **drive** it off-host through the cloud relay. This replaces the current `throw` ("native auto-start not implemented") and folds local executors into the same cloud-accessible plane as cloud CCR executors.

---

## 1. Validated mechanism (live-spiked, 2026-06-24)

Four spikes on this host proved the end-to-end path (OAuth present + valid):

- **Launch** `claude --dangerously-skip-permissions --remote-control` in a tmux pane (cwd = a worktree dir). On a fresh cwd, Claude shows a one-time **"Try the new fullscreen renderer?"** onboarding prompt (and, without `--dangerously-skip-permissions`, a trust prompt). **These block the REPL and must be dismissed** (`"2"`+Enter for the renderer; the existing `autoAcceptTrust` for trust). After dismissal the REPL footer shows **`/rc active`** + the local session UUID.
- **Registration:** the session self-registers a cloud session — a new **`cse_<suffix>`** (status `active`) appears in `cloudListAccount()` (`GET /v1/code/sessions`). No `ccr_connect`, no bridge process.
- **Drive (off-host):** `cloudDrive({ sid })` delivers a user turn through the cloud relay — but the id must be the **`session_<suffix>`** form (convert `cse_`→`session_`; same suffix). Spike result: `delivered:true`, and the session **processed** the turn (`U: …PONG… → A: PONG`, tokens/cost incurred).
- **Read:** the response lands in the **LOCAL `.jsonl`** (read via `GET /sessions/:uuid/conversation` by the local UUID). **Cloud teleport-events is empty** for an RC session — so reads are local, drives are cloud.
- **Liveness:** `sessionVerdict(uuid)` (live + in tmux → `driveable`).

These are the load-bearing facts the build depends on.

---

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Remote-control mechanism | **`claude --remote-control` launch flag** (native self-registration). NOT `ccr_connect` (attach-to-existing) and NOT a `/remote-control` slash (no such command). |
| Read channel | **Local transcript** (`/sessions/:uuid/conversation`) — cloud teleport is empty for RC sessions. |
| Drive channel | **`cloudDrive`** with the `cse_→session_`-converted sid (off-host cloud relay); same-host `POST /terminal/cc-sessions/:uuid/prompt` as a fallback. |
| `cse` discovery | **Baseline-diff** `cloudListAccount()`: snapshot account sids before launch, poll for the new sid after. |
| Worktree | `git worktree add <dir> -b mission/<id>` via the existing `checkpoint/git-utils.gitCommand(args, cwd)` runner (no helper exists). `shared` isolation uses the repo dir directly (no worktree). |
| Launch primitive | Wire `--remote-control` through the **Linux** launcher (today Windows-only) + harden onboarding-prompt dismissal — both reusable beyond missions. |

---

## 3. Architecture & components

```
 startExecutor(m, decision)
   ├─ decision.env === 'cloud'   → cloudStart (existing)
   └─ decision.env === 'worktree'/'shared'  (NEW native branch)
        1. ensureWorktree(repo, dir, branch)          [git worktree add via gitCommand]
        2. tmuxCcController.launch({ cwd, remoteControl:true, skipPermissions, autoTrust })  → local UUID
           (cc.launch now dismisses the renderer/onboarding prompt + trust)
        3. discoverCse(baselineSids)                  [poll cloudListAccount for the new cse]
        4. drive the objective (first turn)            [cloudDrive(session_form) | local prompt]
        5. return MissionBinding{ sessionId:UUID, node, kind, ccr:{ cse, sid, webUrl, tmuxSession } }

 readExecutor(m) / driveExecutor(m, text):  branch by binding shape
   ├─ binding.sessionId matches /^session_/  → cloud path (cloudStatus/cloudRead/cloudDrive)   [existing]
   └─ binding.ccr present (UUID sessionId)   → native path:
        read   = GET /sessions/:uuid/conversation → computeNewOutput
        drive  = cloudDrive({ sid: binding.ccr.sid })  (fallback: /terminal/cc-sessions/:uuid/prompt)
        live   = sessionVerdict(uuid).driveable
```

### 3.1 Launch hardening (`core/src/terminal/`) — reusable
- **Thread `--remote-control`:** add `remoteControl?: boolean` to `CCLaunchInput` (`types.ts`), parse it in `parseCCLaunch` (`validate.ts`), append `--remote-control` in `buildLaunchCmd` (`cc.ts`), and pass `opts.remoteControl` through `tmuxCcController.launch` (`tmux-backend.ts`). (Windows already emits it.)
- **Dismiss onboarding prompts:** extend `cc.launch`'s prompt handling so that, while waiting for the `ctx:`/idle footer, it detects the **"fullscreen renderer?"** prompt (and trust) and dismisses it (`"2"`+Enter / Esc), then continues. Without this, a fresh launch hangs at `ready:false`. This fixes ALL fresh local launches.
- The RC-session "ready" signal is `/rc active` in the footer (or the `cse` registering), since a `--remote-control` session may not present the normal interactive footer the same way — the launcher should treat the resolved local UUID + a dismissed prompt as launched, and the controller treats `cse` registration as the readiness gate.

### 3.2 `cse` discovery — `core/src/mission/mission-native.ts` (new) or in the controller wiring
`discoverCse(baselineSids: Set<string>, opts): Promise<{ cse: string; sid: string } | null>` — polls `cloudListAccount()` (a few times, ~5s apart, ~40s cap), returns the first sid not in `baselineSids` (prefer `status==='active'`), with `sid = cse.replace(/^cse_/, 'session_')`. If none within the cap, return `null` (bind without `ccr` and let a later tick back-fill, OR mark the mission `blocked` — see §5).

### 3.3 `MissionBinding.ccr` (additive, `mission-model.ts`)
```ts
export interface MissionBinding {
  sessionId: string | null;     // cloud session_… OR local UUID
  node: string | null;
  kind: ExecutorKind | null;
  boundAt?: number;
  ccr?: { cse: string; sid: string; webUrl?: string | null; tmuxSession?: string };  // present for native+RC
}
```
Purely additive; nothing else depends on the binding shape.

### 3.4 Read/drive/liveness branch (`mission-controller.ts`)
- A pure helper `isNativeBinding(b)` = `!!b?.ccr` (or `b.sessionId` is a 36-char UUID). Unit-testable.
- `readNativeExecutor(m)` (new wiring): liveness via `sessionVerdict`, read via the conversation API → `computeNewOutput` (reuse), no cloud `pendingQuestion` (gate detection for native is out of scope v1 — local RC sessions surface approvals differently).
- `driveExecutor` native: `cloudDrive({ sid: m.binding.ccr.sid, text })`.
- `runMissionTick`/`processMission` are unchanged — only the injected `readExecutor`/`startExecutor`/`drive` deps gain the native branch.

### 3.5 Accessibility payoff
Because the native executor now has a `cse`/`webUrl`, the **Missions UI Connect** and **MCP** reach it through the cloud path (the existing `CcrCloudView` on the `session_`-form sid, surfaced from `binding.ccr.sid`). The controller exposes `binding.ccr.sid` so the UI's existing `/^session_/` Connect branch lights up for native executors too.

---

## 4. Error handling / safety
- **Launch failure / stuck prompt:** the hardened `cc.launch` dismisses known prompts; on timeout it returns `ready:false` — the native branch treats "no local UUID resolved" as a failed start (mission stays as-is, logged; per-mission try/catch already isolates it).
- **`cse` not discovered in time:** bind with `sessionId:UUID` and **no `ccr`** (drive falls back to the same-host local prompt; a later tick re-runs discovery and back-fills `ccr`). Never spin/spawn duplicates (the binding is set once; subsequent ticks see a bound session).
- **OAuth / weekly limit:** `--remote-control` registration needs a valid Claude Code OAuth login; on this host it's valid but **near the weekly usage cap** — live verification must be minimal. A registration failure (no `cse`) → fall back to local-only drive + log.
- **Worktree conflicts:** `git worktree add` fails if the branch/dir exists → reuse the existing worktree (check first) rather than erroring.
- **No double-resume / corruption:** we LAUNCH a fresh session (new UUID) — we never `--resume` an existing transcript, so the append-only-jsonl corruption risk that `ccr_connect`'s gate guards against does not arise here.

## 5. Testing
- **Unit (pure):** `cseToSessionSid` (`cse_X`→`session_X`); `isNativeBinding`; `discoverCse` diff logic over a stubbed `cloudListAccount`; the read/drive branch selection by binding shape.
- **Launch wiring:** `buildLaunchCmd` emits `--remote-control` when `remoteControl:true`; `parseCCLaunch` accepts it.
- **Controller:** `runMissionTick` with injected native deps — a worktree mission → `startExecutor` returns a native binding with `ccr`; readExecutor(native) → computeNewOutput from a stubbed conversation; drive(native) → cloudDrive with the `ccr.sid`.
- **Live verification (minimal, quota-aware):** ONE worktree mission end-to-end on this host — launch `--remote-control`, confirm `cse` registers + `/rc active`, drive the objective via the controller, read the response from the local transcript, then stop + clean up (worktree + tmux + cse).

## 6. Out of scope (YAGNI)
- Windows native launch polish (the `--remote-control` flag is already wired on Windows).
- Cross-node native launch (a worktree executor runs on the controller's host; off-host placement stays cloud).
- Native gate/approval detection in the adjust loop (cloud `pendingQuestion` has no native equivalent yet).
- Replacing/​fixing the unused `/terminal/remote-control/:id/send` route (we drive via `cloudDrive`, which is verified).
