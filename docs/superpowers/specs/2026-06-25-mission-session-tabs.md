# Wave 6 — Mission session tabs (open + connect to a mission's sessions)

**Goal:** Each mission item surfaces its orchestrator/worker/executor sessions; clicking one opens it as a **separate tab** on the Mission Control page (alongside the Mission Controller chat), connected via the CCR/chat interface. A closed session is **auto-resumed if cloud**, **confirm-resumed if local** (with a 30-min idle auto-close).

**Why:** The Missions page only exposes the controller chat. The user wants to see + drive a mission's actual executor/worker sessions directly, as tabs, reusing the proven CCR/chat session views.

## Decisions (user-approved)
- **Multiple tabs** open at once (controller + N session tabs), switchable + closeable.
- Closed **cloud** → auto-resume; closed **local** → confirm-then-resume + **30-min idle** auto-close.

## Global Constraints
- CommonJS core; bare `{success,data}` mission envelope; worker-token gate; leader-anchoring already applies to mission CRUD.
- Reuse existing building blocks: `GET /mission/:id/sessions` (`handleSessions`), the mission session read/drive/control ops (cloud+native via the resolver), `CcrCloudView` (cloud transcript+drive), and the new collapsed-tool chat render.
- Web: Next.js/React; the session tab view reuses `CcrCloudView` for cloud sids and the mission-chat render for native sids.

## Component 1 — Session liveness + resume (backend)
- **`GET /mission/session/:sid/status`** (or extend the resolver) → `{ transport: 'cloud'|'native', alive: boolean }`. `alive` from the resolver's liveness (cloud `cloudStatus`; native `sessionVerdict(sid).inTmux`).
- **`POST /mission/session/:sid/resume`** (body `{ node?, missionId? }`) →
  - **cloud**: reactivate the suspended session (a `cloudDrive` no-op/keepalive or `cloudStatus` reactivation); return `{ resumed:true, sid, transport:'cloud' }`. If the cloud session is GONE (not just suspended), return `{ resumed:false, reason:'gone' }`.
  - **native**: relaunch the executor for `missionId` (reuse `startNativeExecutor`/the worktree launch) → a NEW sid; rebind the mission; return `{ resumed:true, sid:<new>, transport:'native', autoCloseAt:<now+30min> }`.
  - Leader-anchored (a resume on a non-leader proxies to the leader, like mission CRUD).
- **Auto-close (local, 30-min idle):** a server-side tracker `missionSessionReaper` — a map `{ sid → { lastActivityAt, missionId } }` for resumed native sessions; mission session read/drive **refresh** `lastActivityAt`; a periodic sweep (piggyback the mission-controller supervisor tick, or a small interval) closes (`tmux kill-session`) any tracked native session idle > `missionSessionIdleCloseMin` (default 30). Pure `isIdleExpired({lastActivityAt, now, idleMin})` for testing.

## Component 2 — Mission item session list (web)
On each mission item (sidebar/detail), render its sessions from `GET /mission/:id/sessions`: per row `role` (orchestrator/worker/executor/controller), `title` (`missionSessionTitle`), `status` (live/closed dot), `transport` (cloud/local badge). Each row is a **button** → `openSessionTab(session)`.

## Component 3 — Tabbed Mission Control page (web, `MissionsPage.tsx`)
- A **tab bar** above the main pane: tab 0 = **"Mission Controller"** (the existing chat). State `openTabs: Array<{ id, sid, title, transport, node }>` + `activeTab`.
- `openSessionTab(session)`: if not already open, push a tab (dedupe by sid); set active. Tabs are closeable (✕) and switchable. Multiple allowed.
- The active tab renders either the controller chat (tab 0) or a **session tab view** (Component 4).

## Component 4 — Session tab view (web)
- Resolve the session's transport. **Cloud** sid (`session_`/`cse_`) → render `CcrCloudView` (`sid`, `apiFetch`, `onClose`). **Native** sid (bare uuid) → render the mission-chat view (extract the controller-chat render into a small reusable `MissionSessionChat` that takes `{ sid, node, apiFetch }` and uses `/mission/session/:sid/read|drive` + the markdown/collapsed-tool render).
- **Closed-session handling on open:** call `GET /mission/session/:sid/status`. If `!alive`:
  - cloud → call `POST .../resume` automatically; on `gone`, show "session ended — cannot resume".
  - native → show a **confirm** prompt ("Session closed — resume it? It will auto-close after 30 min idle."); on confirm → `POST .../resume` → swap the tab's sid to the new one. On the tab, show the auto-close countdown/notice.

## Tests
- `isIdleExpired`: expired when `now - lastActivityAt > idleMin`; not before.
- `handleSessionResume` (DI): cloud-alive → no-op resumed; cloud-gone → `{resumed:false,gone}`; native → calls relaunch dep → returns new sid + autoCloseAt; leader-anchored (non-leader → proxy).
- `handleSessionStatus`: returns transport + alive from injected resolver/liveness.
- reaper sweep: a tracked native session idle > 30 min → close dep called; fresh one → not.
- Web: build-clean; tab bar opens/switches/closes; a cloud session tab renders `CcrCloudView`; a native one renders the chat; closed-native shows the confirm.

## Verification (e2e)
- Open a mission with an executor → the item lists its session(s); click → a new tab opens with the live transcript (CcrCloudView for cloud / chat for native) + drive.
- Stop the executor's session, reopen the tab → cloud auto-resumes; native asks to confirm, then relaunches + shows the 30-min auto-close notice; after 30 min idle the local session is closed (tmux gone).

## Out of scope
- Persisting open tabs across reloads (tabs reset on refresh).
- Resuming a fully-deleted cloud session (only suspended ones reactivate).
