# Chat-First Mission Page (Wave 2.2) — Design

**Goal:** Make the Missions page a **chat with the Mission Controller agent** as the primary way to interact with the whole mission system, from any node. Per-mission create/edit/view becomes a secondary, optional surface. The chat *is* the controller session (`mission_session_read/drive` against it). A prominent leader badge shows which node is promoted.

**Architecture:** The controller agent (native `--remote-control` on the elected leader) is driven/read via the Wave-2 operability routes/tools. Its transcript is **local to the leader**, so the chat targets the **leader node** (web → hub relay to the leader; MCP → `node: <leader>`), where read/drive execute locally. No new proxy layer — reuse node-targeting + the operability routes. Builds on Wave 2 (controller-as-session) + Wave 1 (provenance).

**Tech Stack:** TypeScript (core, CJS), node:test; Next.js/React (web); existing hub relay + `list_nodes`/node-targeting; `CcrCloudView`-style live read/drive.

## Global Constraints

- CommonJS core; bare `{success,data}` mission-route envelope; worker-token gate; Wave-1 provenance applies.
- The chat must work from **any** node (targeting the leader); degrade gracefully when no controller is live (not on a leader / controller down).
- Do not break the existing Wave-1/Wave-2 surfaces (create form, repo/branch dropdowns, operate panels) — they become optional/secondary, not removed.

## Component 1 — Leader identity (`GET /mission/controller`)

Add `leader: { node: string; host: string | null; isSelf: boolean }` to the response, where `node = election.monitorNodeId`, `host` resolved from the hub machines list (`list_nodes`/`/api/tier-agent/machines` → hostname), `isSelf = monitorNodeId === selfId`. Used by the UI badge and to know which node the chat must target.

## Component 2 — Cross-node controller read/drive (target the leader)

The chat reads/drives the controller by **routing to the leader node**:
- **MCP path** (`mission_session_read/drive/control`): callers pass `node: <leader>` (the standard optional `node` arg every connector tool already accepts) → the hub relays to the leader's Core → local `getConversation` / `getCcController().prompt`. No code change beyond confirming the routes execute correctly when reached via the relay (auth is the relay's, not a per-node token).
- **Web path**: the page resolves the leader node (Component 1) and issues its controller read/drive/control fetches **to that node** via the existing hub machine-proxy the web already uses for cross-node session views (`/machines/:node/proxy` / `_coreapi`). When `leader.isSelf`, fetch locally.

**Verification gate (first implementation step):** prove `mission_session_read`/`drive` on the controller sid **from a non-leader node** returns the live transcript + delivers a message (relay auth works). If the relay drops the worker token, fall back to key-in-body (the documented data-sync pattern) or the cloud-relay `cse` drive (Component 4).

## Component 3 — Chat-first Missions UI (`MissionsPage.tsx`)

Restructure into a chat-centric two-pane layout:
- **Primary pane — "Mission Controller" chat** (the controller session): live transcript (poll `mission_session_read(controllerSid)` targeted at the leader, ~3–5s) + a message composer (`mission_session_drive`) + interrupt/stop/restart controls. This is *the* way to run the system — the user types intents ("create a mission to …", "what's blocking B?", "pause C", "hint the worker on A") and the controller acts with its tools and replies. Header shows the **leader badge** ("🟢 Leader: \<host\> · promoted") + controller liveness.
- **Secondary pane — mission items** (sidebar): the live mission list (`GET /mission`) — title/status/progress per item; click to expand an **optional** detail/operate panel (the Wave-2 per-session read/send/control for that mission's executor, and the Wave-1 provenance trail).
- **Optional create**: the existing create form + repo/branch dropdowns move behind a "＋ New mission" disclosure (kept, de-emphasized) — primary creation is via the chat.
- **No-controller state**: if no controller is live (no leader / disabled), the chat pane shows "No mission controller running — \<reason\>" and the mission list + create form still work.

## Component 4 — (Secondary) reliably bind the controller `cse`

Fix the supervisor launch discovery race (`mission-controller.ts` launch dep): capture the cloud baseline **before** `tmuxCcController.launch`, then **poll** `cloudListAccount` for the new `cse` for ~40s after; bind it (fall back to native `sessionId` if it never registers). Not required for the chat (Component 2 targets the leader), but it (a) makes the controller identifiable as a cloud session and (b) enables a relay-based drive fallback. Small, isolated.

## Tests

- Component 1: `GET /mission/controller` includes `leader` with resolved host (stub machines list + election).
- Component 2: the operability route handlers, given a `node` hint ≠ self, dispatch via the proxy dep (stub) and return its result; given self, execute locally. (Pure dispatch test; the live relay-auth is the e2e gate.)
- Component 4: launch dep binds the `cse` when `cloudListAccount` returns a new entry after launch (stub polling); falls back to native sessionId when none appears.
- Web: build-clean; chat pane renders, composer posts drive, mission sidebar lists items (browser-verified, this repo's mission-UI convention).

## Verification (e2e, on deploy)

- From a **non-leader** node (117), open Missions → leader badge shows 123; the chat shows the live controller transcript and a typed message reaches the controller (it replies). 
- "create a mission to reply DONE" typed into the chat → the controller creates + drives it; the mission appears in the sidebar; provenance attributes it to the controller session.
- The sidebar's optional operate panel reads/sends to a mission's executor.

## Out of scope

- Replacing the controller with a cloud BYOC session (native is the chosen substrate; it doesn't suspend).
- Multi-controller / multiple concurrent chats.
