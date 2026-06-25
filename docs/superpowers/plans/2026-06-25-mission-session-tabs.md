# Wave 6 — Mission session tabs — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps `- [ ]`.

**Goal:** Mission items list their sessions; click → open as a tab on the Mission Control page (CCR for cloud / chat for native); closed cloud → auto-resume, closed local → confirm-resume + 30-min idle auto-close.

**Tech:** TS (core, CJS), node:test; Next.js/React. Reuse `handleSessions`, mission session read/drive ops, `CcrCloudView`, the collapsed-tool chat render.

## Global Constraints
- CommonJS; bare `{success,data}` envelope; worker-token gate; leader-anchor resume like mission CRUD.
- Test (single): `cd /home/ubuntu/lm-assist/core && export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" && npm run build:test && node --test dist-test/__tests__/<file>.test.js`. Web: `(cd web && npx next build 2>&1 | tail -15)`.

---

### Task 1: Backend — session status + resume + idle helper

**Files:** `core/src/routes/core/mission.routes.ts` (+ register routes), `core/src/project-settings.ts` (`missionSessionIdleCloseMin` default 30). Test `core/src/__tests__/mission-session-resume.test.ts`.

**Interfaces:**
- `isIdleExpired({ lastActivityAt:number, now:number, idleMin:number }): boolean` (pure, exported).
- `handleSessionStatus(sid, deps?, node?, proxyDeps?): Promise<Envelope>` → `{ transport, alive }` (resolver liveness; cloud `cloudStatus`, native `sessionVerdict`).
- `handleSessionResume(sid, body:{missionId?}, deps?, node?, leader?): Promise<Envelope>`:
  - cloud alive → `{ resumed:true, sid, transport:'cloud' }`; cloud gone → `{ resumed:false, reason:'gone' }`.
  - native → `deps.relaunch(missionId)` → new sid → `{ resumed:true, sid:<new>, transport:'native', autoCloseAt }`.
  - leader-anchored (reuse `realLeaderAnchor`/`anchorToLeader`, failClosed).
- Routes: `GET /mission/session/:sid/status`, `POST /mission/session/:sid/resume`.

- [ ] **Step 1: test** — `isIdleExpired` (expired/not); `handleSessionStatus` with injected resolver (cloud→alive from cloudStatus stub; native→inTmux stub); `handleSessionResume` cloud-alive/cloud-gone/native(new sid + autoCloseAt). Inject all IO.
- [ ] **Step 2-4:** run fail → implement (mirror the existing `handleSessionRead`/`handleSessionControl` DI + proxy pattern; native relaunch dep defaults to `startNativeExecutor` via the mission + binding) → pass.
- [ ] **Step 5: commit** `feat(mission): session status + resume (cloud reactivate / native relaunch) + isIdleExpired`.

---

### Task 2: Backend — local-session auto-close reaper

**Files:** `core/src/mission/mission-session-reaper.ts` (new), wire a sweep into `runSupervisorTick` (or the mission-controller scheduled handler). Test `core/src/__tests__/mission-session-reaper.test.ts`.

**Interfaces:**
- `trackResumedNative(sid, missionId, now)`, `touchActivity(sid, now)` (called by read/drive), `sweepIdle({ now, idleMin, close })` → closes (and untracks) sids idle > idleMin via `close(sid)`. In-memory map (only the leader runs it).
- `handleSessionRead`/`handleSessionDrive` call `touchActivity(sid, Date.now())` for native sids (best-effort).

- [ ] **Step 1: test** — track + sweep: a sid idle > idleMin → `close` called + untracked; a fresh/touched one → not. `touchActivity` refreshes.
- [ ] **Step 2-4:** run fail → implement (pure-ish map + `sweepIdle`; `close` default = `tmuxTerminalBackend.close` of the session's tmux via the resolver). Wire `sweepIdle` into the supervisor tick with `missionSessionIdleCloseMin`. Wire `touchActivity` into read/drive (native only). → pass.
- [ ] **Step 5: commit** `feat(mission): auto-close resumed local sessions after idle timeout (reaper)`.

---

### Task 3: Web — reusable native session chat view

**Files:** `web/src/components/missions/MissionSessionChat.tsx` (new — extract the controller-chat render: read `/mission/session/:sid/read`, drive, markdown + collapsed `ToolGroupLine`). Modify `MissionsPage.tsx` to import + use it for the controller tab too (DRY). Verify `next build`.

**Interfaces:** `<MissionSessionChat sid node apiFetch />` — self-contained poll-read + composer + the markdown/collapsed-tool render (move `ToolGroupLine`, `resolveMsgText`, `meaningfulText`, the grouping into this component or a shared util).

- [ ] **Step 1:** extract the chat render + the tool-grouping into `MissionSessionChat`; have the controller chat use it (pass the controller sid + leader node). Keep behavior identical.
- [ ] **Step 2: build** clean.
- [ ] **Step 3: commit** `feat(web): extract MissionSessionChat (reusable session chat view)`.

---

### Task 4: Web — mission item sessions + tabbed page + session tab view + resume

**Files:** `web/src/components/missions/MissionsPage.tsx`. Verify `next build` + browser.

**Interfaces:** consumes `GET /mission/:id/sessions`, `GET /mission/session/:sid/status`, `POST /mission/session/:sid/resume`; renders `CcrCloudView` (cloud) or `MissionSessionChat` (native) per tab.

- [ ] **Step 1: mission item sessions** — on each mission item, fetch/show `GET /mission/:id/sessions` rows (role, title, status dot, cloud/local badge); each row → `openSessionTab({sid,title,transport,node})`.
- [ ] **Step 2: tab bar** — state `openTabs[]` + `activeTab`; tab 0 = Mission Controller; `openSessionTab` dedupes by sid, pushes, activates; tabs switch + close (✕). Render the active tab's view.
- [ ] **Step 3: session tab view + closed-handling** — cloud sid → `CcrCloudView`; native sid → `MissionSessionChat`. On open, `GET .../status`; if `!alive`: cloud → auto `POST .../resume`; native → confirm dialog → `POST .../resume` → swap tab sid to the new one + show "auto-closes in 30 min idle" notice.
- [ ] **Step 4: build** clean.
- [ ] **Step 5: commit** `feat(web): mission session tabs — list/open/connect + cloud-resume/local-confirm-resume`.

---

## Final verification (pre-deploy)
- [ ] `node --test dist-test/__tests__/mission-*.test.js` green; `./core.sh build` + web build clean.
- [ ] Bump version, release, deploy fleet (123 leader first — resume/reaper run there), direct `npm install -g <tgz>`.
- [ ] e2e: mission item lists its session(s); click → tab opens with live transcript + drive; stop session → cloud auto-resumes / native confirms+relaunches+shows the 30-min notice; idle local session auto-closes.

## Self-Review
- Coverage: status+resume+idle (T1), reaper (T2), reusable chat (T3), tabs+open+resume UI (T4). Leader-anchored resume; reaper only on leader. Cloud→CcrCloudView, native→MissionSessionChat. Multiple tabs; 30-min idle.
