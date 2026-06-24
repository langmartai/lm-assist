# Chat-First Mission Page (Wave 2.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Missions page = a chat with the Mission Controller agent (primary), from any node, + a leader badge; per-mission create/edit/operate becomes optional/secondary.

**Architecture (verified):** The controller is a native `--remote-control` agent on the elected leader; its transcript is local there. Cross-node read/drive works by **targeting the leader node via the existing hub proxy** (`/machines/:node/proxy<path>`) — the relay injects the local worker token (`api-relay-handler.ts:392`). The only blocker was the relay path allow-list, now opened for `/mission` (done, commit pending). No internal route-proxy needed; the caller (web/MCP) targets the leader.

**Tech Stack:** TS (core, CJS), node:test; Next.js/React.

## Global Constraints
- CommonJS; bare `{success,data}` mission envelope; worker-token gate; Wave-1 provenance applies.
- Chat works from any node by targeting the leader; degrade gracefully when no controller is live.
- Keep Wave-1/2 surfaces (create form, dropdowns, operate panels) — optional/secondary, not removed.
- Test (single file): `cd /home/ubuntu/lm-assist/core && export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/<file>.test.js`. Full: `./core.sh build`.

---

### Task 1: Relay allow-list — `/mission` (DONE, add the test)

**Files:** Modified `core/src/hub-client/api-relay-handler.ts` (added `/mission` to `ALLOWED_API_PREFIXES`); Test `core/src/__tests__/relay-allowlist-mission.test.ts`.

- [ ] **Step 1: test** — assert the path-validation allows `/mission`, `/mission/sessions`, `/mission/session/x/read`, `/mission/controller`, and still rejects an unknown path. Find the public validator on `ApiRelayHandler` (the method returning the "Path not allowed" string / a boolean around lines 170-212); if it's private, test via the smallest public entry, or export a pure `isApiPathAllowed(path: string): boolean` helper built from `ALLOWED_API_PREFIXES` and call it.
```ts
import { isApiPathAllowed } from '../hub-client/api-relay-handler';
test('/mission paths are relay-allowed', () => {
  for (const p of ['/mission','/mission/sessions','/mission/session/abc/read','/mission/controller']) assert.equal(isApiPathAllowed(p), true);
  assert.equal(isApiPathAllowed('/totally-unknown'), false);
});
```
- [ ] **Step 2-4:** run (fail → export the pure helper if needed → pass).  - [ ] **Step 5: commit** `feat(relay): allow /mission paths cross-node (chat-with-leader) + test`.

---

### Task 2: Leader identity on `GET /mission/controller`

**Files:** Modify `core/src/routes/core/mission.routes.ts` (the `/mission/controller` handler); Test extend `core/src/__tests__/mission-provenance-routes.test.ts` or a new `mission-leader.test.ts`.

**Interfaces:** Adds `leader: { node: string|null; host: string|null; isSelf: boolean }` to the controller payload. `node = election.monitorNodeId`, `host` resolved from the hub machines list (a `leaderHost(node)` dep, default = fetch `/api/tier-agent/machines` and find by gatewayId → hostname; injectable, returns null on failure), `isSelf = monitorNodeId === selfId`.

- [ ] **Step 1: test** — `handleGetController` with injected `getElection` (monitorNodeId='gw-x', selfId='gw-y') + `getLeaderHost` stub ('yitest') → payload `leader = {node:'gw-x', host:'yitest', isSelf:false}`.
- [ ] **Step 2-4:** run fail → implement (add `leaderHost` dep + `leader` to the `ok({...})`; default `getLeaderHost` reads the machines list, non-fatal) → pass.
- [ ] **Step 5: commit** `feat(mission): leader {node,host,isSelf} on GET /mission/controller`.

---

### Task 3: Reliably bind the controller `cse` (launch-race fix)

**Files:** Modify `core/src/mission/mission-controller.ts` (supervisor `launch` dep, ~line 423-441); Test extend `core/src/__tests__/mission-supervisor.test.ts`.

**Interfaces:** The launch dep now binds the cloud `cse` when the `--remote-control` session registers one: capture the cloud baseline **before** `tmuxCcController.launch`, then poll `cloudListAccount` (inject as a dep for tests) up to N times (~40s) for a new sid via `pickNewSession`; set `cse` to it (and `sessionId` to the cse when found), else keep the native `sessionId` + `cse:null`.

- [ ] **Step 1: test** — a pure `discoverNewCse(baseline, snapshots, pickFn)` (or the launch dep with injected `listAccount` returning baseline first then baseline+new): returns the new sid; returns null when no new sid appears.
- [ ] **Step 2-4:** run fail → implement (baseline-before + poll-after; extract a small pure `discoverNewCse` for the test; the real launch dep calls it with `cloudListAccount`) → pass.
- [ ] **Step 5: commit** `fix(mission): supervisor launch binds controller cse (poll after launch, baseline before)`.

---

### Task 4: Chat-first Missions UI

**Files:** Modify `web/src/components/missions/MissionsPage.tsx`. Verify: `next build`.

**Interfaces:** Consumes `GET /mission/controller` (`election`, `controllerSession`, `leader`), `GET /mission` (items). For the controller chat + cross-node, target the leader: when `leader.isSelf` use local fetch; else fetch via the hub machine-proxy the page already uses for cross-node session views (`/machines/:node/proxy/mission/...`) — reuse the existing cross-node fetch helper (same as `CcrCloudView`'s `machineId` path). The controller sid = `controllerSession.cse || controllerSession.sessionId`.

- [ ] **Step 1: Leader badge + layout** — top banner: `🟢 Leader: {leader.host || leader.node} · promoted` + controller liveness dot (from `controllerSession`). Two-pane: primary chat (left/main), mission items (right sidebar).
- [ ] **Step 2: Controller chat (primary)** — live transcript: poll `POST /mission/session/{sid}/read {lastN:30}` every 4s **targeted at `leader.node`**; render messages ({role,text}); a composer textarea → `POST /mission/session/{sid}/drive {text}` (targeted at leader); interrupt/stop/restart buttons → `POST /mission/session/{sid}/control`. No-controller state: "No mission controller running — {reason}". This is the primary interaction; intents are typed in natural language.
- [ ] **Step 3: Mission items sidebar (secondary)** — `GET /mission` list (title/status/progress); each item expandable to the existing Wave-2 operate panel (read/send/control its executor) + the Wave-1 provenance trail. Move the existing create-form + repo/branch dropdowns behind a `＋ New mission` disclosure (kept, de-emphasized).
- [ ] **Step 4: build** — `cd /home/ubuntu/lm-assist && export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" && (cd web && npx next build 2>&1 | tail -20)` clean.
- [ ] **Step 5: commit** `feat(web): chat-first Missions page (controller chat primary, items+create optional, leader badge)`.

---

## Final verification (pre-deploy)
- [ ] `node --test "dist-test/__tests__/mission-*.test.js"` + the relay test → green. `./core.sh build` + web build clean.
- [ ] Deploy `0.1.77-mc.5` fleet-wide (123 first to get the allow-list + cse-bind on the leader; then 117/107).
- [ ] e2e: from a NON-leader node, `POST /machines/<leader>/proxy/mission/session/<sid>/read` returns the live transcript (allow-list works); the chat UI shows the controller + leader badge; typing "create a mission to reply DONE" makes the controller create+drive it; the item appears in the sidebar.

## Self-Review notes
- Spec coverage: allow-list (T1), leader identity (T2), cse-bind (T3), chat UI (T4). Cross-node = caller-targets-leader via hub proxy (verified) — no internal proxy.
- Types: `leader` shape (T2) consumed by the UI (T4); controller sid = cse||sessionId across T3/T4.
