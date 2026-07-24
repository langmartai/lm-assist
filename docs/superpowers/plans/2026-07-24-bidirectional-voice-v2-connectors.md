# Bidirectional Voice v2 — Connector / MCP Approval Loop (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add claude.ai's voice **connector/MCP agentic loop** to the bidirectional voice mode built in Plan A — render `tool_use`/connector cards, stream `connector_text`, drive the in-band **approval handshake** (Once / For this chat / Always), surface `mcp_auth_required`/`mcp_elicitation`, and return `tool_result` for the bounded set of client-executed builtins.

**Architecture:** MCP connectors execute **server-side** (claude.ai holds the MCP connection). The lm-assist client's job is **render + approve**, not execute. All connector/tool frames arrive inside `message_sse` on the existing `/voice/claude/ws` transport (Plan A), and client→claude.ai control frames (approvals, `tool_result`) already flow through the relay's control-frame forwarding (Plan A commit `c2283cc`). So Plan B is almost entirely **web-side** (demux + hook + overlay); no Core transport change is expected.

**Tech Stack:** Next.js 16 / React 19, vitest (web tests), the Plan-A `useClaudeVoice` hook + `claude-voice-demux.ts` + `ClaudeVoiceOverlay.tsx`. Design basis: `docs/superpowers/specs/2026-07-24-bidirectional-voice-v2-design.md` §7. Protocol: `/home/yi/lm-assist/docs/claude-ai-voice-protocol.md` (node 123) §3 + the fleet memory `bidirectional-voice-v2-protocol.md`.

## Global Constraints

- **Plan A is merged on `main`** (`f9e9507`); branch Plan B from `main`. The transport, the hook's `demuxMessageSse` (which already routes `tool_use`/`connector_text`/`input_json_delta`/`message_delta`/`message_stop` to `acc.passthrough`), and the relay control-forwarding are DONE — build on them, don't re-do them.
- **Recovered connector schema (verbatim — the baseline; Task 1 confirms the live specifics).** A connector/tool arrives as a `message_sse` `content_block_start` of `type:"tool_use"`:
  `{ type:"tool_use", id, name, input, message, integration_name, integration_icon_url, icon_name, context, display_content, approval_options, approval_key, is_mcp_app, mcp_server_url }` — for a **connector/MCP** tool the server populates `integration_name`/`is_mcp_app`/`mcp_server_url`/`approval_key`/`approval_options` (built-ins like `web_search` leave them null). Connector output streams as a distinct `connector_text` content-block. An MCP tool is detected client-side by `name.startsWith("mcp_")` or `name.includes(":")`. Approval reply carries `{tool_use_id, is_approved, approval_key, approval_option}` with `approval_option ∈ {"once","perChat","always"}`. Connector auth surfaces via `mcp_auth_required` / `mcp_elicitation`. Client returns `{type:"tool_result", tool_use_id, name, is_error, content:[]}` + `{type:"turn_end"}` for client-executed tools.
- **RESIDUAL GAP → Task 1 closes it:** no live capture of a *populated* connector call was taken during the research (schema known; exact WS envelope of the approval reply + the populated `tool_use`/`connector_text` frames as they appear ON THE VOICE WS need one live capture). **Task 1 captures them and every later task uses the Task-1-confirmed shapes** (falling back to the schema above only where Task 1 couldn't populate a field).
- Web tests: `cd web && npx vitest run <file>` (no React testing-library → UI verified by `next build` + reading). Core tests (if any): flat in `core/src/__tests__/`.
- NO backticks in `git commit -m` (use `git commit -F -`); end each body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and `Claude-Session: <session-url>`.
- Additive + capability-gated (Plan A): connectors render only within the voice overlay; nothing else changes.

## File Structure

- `web/src/lib/claude-voice-demux.ts` (modify) — turn the opaque `passthrough` into typed connector/tool/approval/auth events.
- `web/src/hooks/useClaudeVoice.ts` (modify) — expose `{tools, connectorTexts, pendingApprovals, mcpAuth}` + `approve(toolUseId, option)` / `denyApproval(toolUseId)`; handle client-executed builtins (`tool_result`).
- `web/src/components/voice/ConnectorCard.tsx` (new) — one tool/connector card (name + integration + status).
- `web/src/components/voice/ApprovalPrompt.tsx` (new) — the Once / For this chat / Always prompt.
- `web/src/components/voice/ClaudeVoiceOverlay.tsx` (modify) — replace the Plan-A passthrough comment-seam with the cards + approval prompt + `connector_text` render + an `mcp_auth` notice.
- `web/src/lib/claude-voice-demux.test.ts` (modify) — connector/approval cases.
- `scratchpad/voice-connector-capture.*` (Task 1) + an e2e checklist (Task 7).

---

### Task 1: Capture the live connector frames (closes the residual protocol gap)

**Files:** Create `scratchpad/voice-connector-capture.md` (+ the raw frames JSON). No product code.

**Interfaces:** none (research/capture task; its OUTPUT — the confirmed frame shapes — is the input to Tasks 2-6).

- [ ] **Step 1: Pick a connector-enabled conversation.** A fresh claude.ai conversation created via the connector already has `enabled_mcp_tools` (seen in Plan A). Confirm a real MCP connector is enabled for the account (`GET /claude-ai/org/mcp-bootstrap` or the claude.ai UI).
- [ ] **Step 2: Drive a voice turn that invokes the connector.** Extend the Plan-A e2e harness (`voice-e2e-harness.mjs`) OR the `voice-cdp-bridge-proof.mjs` to feed a spoken/synthesized turn whose content triggers the connector (e.g. "search my drive for X" for a Drive connector). Log every `message_sse` frame verbatim.
- [ ] **Step 3: Capture + save** the populated `tool_use` (with real `integration_name`/`mcp_server_url`/`approval_key`/`approval_options`), the `connector_text`, AND the exact approval-reply WS frame the real claude.ai voice client sends (drive the approval in a real Chrome and capture the outgoing frame — the one unknown envelope). Save raw JSON to `scratchpad/voice-connector-capture.json` + a shapes summary to the `.md`.
- [ ] **Step 4: Commit** the capture notes (`test(voice): capture live connector frames for the voice approval loop`). **If a populated connector cannot be triggered** (no connector on the account / credits), STOP and report — implement Tasks 2-6 against the recovered schema, and mark the approval-frame envelope as "assumed" pending a later capture.

---

### Task 2: Typed connector demux

**Files:** Modify `web/src/lib/claude-voice-demux.ts`; Test `web/src/lib/claude-voice-demux.test.ts`.

**Interfaces:**
- Produces: extend `DemuxAcc` with `tools: ToolUseView[]`, `connectorTexts: string[]`, `pendingApprovals: ApprovalReq[]`, `mcpAuth: McpAuthReq[]`. `ToolUseView = { id, name, input, isConnector, integrationName?, mcpServerUrl?, iconUrl?, status:'running'|'done'|'error' }` (isConnector = populated `is_mcp_app`/`mcp_server_url` OR `name` startsWith `mcp_` / includes `:`). `ApprovalReq = { toolUseId, approvalKey, options: ('once'|'perChat'|'always')[], name, integrationName? }`. Consumed by Task 3.

- [ ] **Step 1: Failing test** — feed a `message_sse content_block_start type:'tool_use'` with populated connector fields (use the Task-1 capture) → `acc.tools[0].isConnector===true` + integrationName set; a block carrying `approval_key`/`approval_options` → `acc.pendingApprovals[0]` populated; a `connector_text` block → `acc.connectorTexts` appended; an `mcp_auth_required` → `acc.mcpAuth`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in `demuxMessageSse`, classify the `message_sse` inner events into the typed arrays (keep the existing transcript/model/assistantText behavior). Pure, no side effects.
- [ ] **Step 4: Run → PASS** (`cd web && npx vitest run src/lib/claude-voice-demux.test.ts`).
- [ ] **Step 5: Commit** `feat(voice): typed connector/tool/approval demux`.

---

### Task 3: Expose connector state + approval from the hook

**Files:** Modify `web/src/hooks/useClaudeVoice.ts`.

**Interfaces:**
- Consumes: the typed `DemuxAcc` (Task 2).
- Produces: `useClaudeVoice(...)` additionally returns `{ tools: ToolUseView[], connectorTexts: string[], pendingApprovals: ApprovalReq[], mcpAuth: McpAuthReq[], approve(toolUseId, option:'once'|'perChat'|'always'):void, denyApproval(toolUseId):void }`. `approve`/`deny` send the approval-reply frame (exact shape from Task 1; baseline `{tool_use_id, is_approved, approval_key, approval_option}`) as a JSON control frame over the WS — the relay already forwards non-connect/non-close control frames to claude.ai (Plan A).

- [ ] **Step 1:** Wire the demux arrays into hook state (they already accumulate via `demuxMessageSse`); expose them.
- [ ] **Step 2:** Implement `approve`/`denyApproval` — look up the `approvalKey` for the `toolUseId` from `pendingApprovals`, send the approval frame, and clear it from `pendingApprovals`.
- [ ] **Step 3: Verify** `cd web && npx next build` clean; if a pure helper is extractable (the approval-frame builder), unit-test it in a `.test.ts` via vitest.
- [ ] **Step 4: Commit** `feat(voice): expose connector state + approval handshake from useClaudeVoice`.

---

### Task 4: tool_result for client-executed builtins (bounded)

**Files:** Modify `web/src/hooks/useClaudeVoice.ts`.

**Interfaces:** Produces: internal handling — for a `tool_use` whose `name` is a CLIENT-executed builtin (per the protocol §3 switch: `ask_user_question`, `memory_*`, `create_file`, etc.), the hook responds. Bounded policy: `ask_user_question` → surface via a hook callback/state for the overlay; every OTHER unsupported client-tool → send `{type:'tool_result', tool_use_id, name, is_error:true, content:[{type:'text', text:'unsupported in lm-assist voice'}]}` + `{type:'turn_end'}` so the model recovers instead of hanging. (Server-executed connectors need NO tool_result — they only need approval + render.)

- [ ] **Step 1: Failing test** (extract the client-tool policy as a pure fn `clientToolResponse(toolUse): {handled, result?}`): `ask_user_question` → `handled:false` (surfaced); an unknown client tool → `handled:true` with an `is_error` tool_result; a connector tool (`is_mcp_app`) → `handled:false` (no result — server executes).
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run → PASS.**
- [ ] **Step 5:** Wire it into the hook's message handling; `next build` clean.
- [ ] **Step 6: Commit** `feat(voice): bounded client-tool tool_result (error-recover unknowns; surface ask_user_question)`.

---

### Task 5: Overlay UI — connector cards + approval prompt + connector_text + mcp_auth

**Files:** Create `web/src/components/voice/ConnectorCard.tsx`, `web/src/components/voice/ApprovalPrompt.tsx`; Modify `web/src/components/voice/ClaudeVoiceOverlay.tsx`.

**Interfaces:** Consumes the Task-3 hook fields. `ConnectorCard({tool})` renders name + integration icon/name + `mcp_server_url` (subtle) + a running/done/error status dot. `ApprovalPrompt({req, onApprove, onDeny})` renders the tool/connector name + three buttons **Once** / **For this chat** / **Always** + Deny. The overlay replaces the Plan-A passthrough comment-seam: render `tools` as cards, `connectorTexts` as styled transcript blocks, `pendingApprovals` as an `ApprovalPrompt` (wired to `approve`/`denyApproval`), and `mcpAuth` as a "connector needs authorization" notice (v1 informational).

- [ ] **Step 1:** Build `ConnectorCard` + `ApprovalPrompt` matching the overlay's existing style (reuse the `.status-dot`/`ModelEffortSelector` idioms).
- [ ] **Step 2:** Wire them into `ClaudeVoiceOverlay` from the hook fields; remove the passthrough comment-seam.
- [ ] **Step 3: Verify** `cd web && npx next build` clean; open the overlay (dev, LM_HTTPS) and confirm no console errors when the fields are empty.
- [ ] **Step 4: Commit** `feat(voice): connector cards + approval prompt in the voice overlay`.

---

### Task 6: End-to-end validation (connector over voice)

**Files:** Create/extend the e2e checklist + harness.

- [ ] **Step 1:** With dev services + `LM_HTTPS` on the Core host, start a voice conversation on a connector-enabled claude.ai conversation.
- [ ] **Step 2:** Speak a turn that triggers the connector → assert: a connector card appears (integration_name/mcp_server_url), the approval prompt shows, choosing **Once** sends the approval frame (verify via the relay control-forward log), the connector runs server-side, `connector_text` renders AND is spoken.
- [ ] **Step 3:** Verify `perChat` persists for the session and a second invocation of the same connector auto-proceeds; verify Deny sends `is_approved:false`.
- [ ] **Step 4:** Confirm a built-in `web_search` (no connector fields) renders as a plain tool card with no approval prompt.
- [ ] **Step 5: Commit** the e2e results.

---

## Self-Review

**Spec coverage (design §7):** connector cards + metadata (T2,T5) ✓; approval handshake once/perChat/always (T2,T3,T5) ✓; connector_text render (T2,T5) ✓; mcp_auth_required/elicitation surfacing (T2,T5) ✓; tool_result for client builtins bounded (T4) ✓; residual protocol gap closed (T1) ✓; e2e (T6) ✓.

**Placeholders:** the only "confirm live" is Task 1 (by design — it captures the one unverified envelope); every other task has the recovered schema as concrete content + a test.

**Type consistency:** `ToolUseView`/`ApprovalReq`/`McpAuthReq` (T2) used by T3,T5; `approve(toolUseId, option)` (T3) used by T5; `clientToolResponse` (T4) internal.

**Dependency note:** Task 1 (capture) should run FIRST so Tasks 2-4's exact shapes are confirmed. If Task 1 can't populate a connector (no connector/credits), implement against the recovered schema and re-validate the approval envelope when a capture is possible.
