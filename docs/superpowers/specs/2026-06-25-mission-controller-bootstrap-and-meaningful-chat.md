# Wave 3 — Controller Bootstrap + Meaningful Chat + Send UX

**Goal:** Make the Mission Controller a properly-bootstrapped, guarded agent and make the chat usable: (1) launch it with a guarded **system prompt** + an explicit **hub-MCP keystone** so its role and tools are reliable on any node; (2) keep auto-driving but show **only meaningful messages** in the chat (filter the heartbeat ping-pong) and run idle heartbeats **less often**; (3) fix the chat composer (**Send button + Enter-to-send + surfaced errors**).

**Evidence (live, 123 leader, session `0485c0cc`):** the controller already responds to user input ("PONG", "What's mcp" → answered) and has the lm-assist tools via claude.ai-connector inheritance — but it launches with **no system prompt** (`claude --dangerously-skip-permissions --remote-control` only) and **no `--mcp-config`**, and the supervisor drives a `CONTROLLER_PASS_DIRECTIVE` every interval even with **0 missions** → 34+ consecutive "nothing to do" turns flooding the chat. The web composer has **no Send button** (only Ctrl/Cmd+Enter), and the render previously read only `content` (the read API returns `{role,text}`) → "(no text)" (already fixed, 0.1.80).

## Global Constraints
- CommonJS core; bare `{success,data}` mission-route envelope; worker-token gate; Wave-1 provenance applies.
- The shared launcher (`cc.ts` / `tmux-backend.ts`) is used by executors + the CCR controller too — new launch options MUST be **optional** and add nothing to argv when unset (no behavior change for existing callers).
- `buildLaunchCmd` returns a **shell command string** → never inline a multi-line system prompt; pass **file paths** only (`--append-system-prompt-file`, `--mcp-config <path>`), shell-quoted.
- Test (single file): `cd /home/ubuntu/lm-assist/core && export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/<file>.test.js`. Full: `./core.sh build`; web: `cd web && npx next build`.

## Component 1 — Launcher: optional system-prompt-file + mcp-config

Thread two optional fields end-to-end through the existing launch path:
- `CcLaunchOpts` (`core/src/terminal/backend.ts`): add `appendSystemPromptFile?: string`, `mcpConfigPath?: string`.
- `CCLaunchInput` (`core/src/terminal/types.ts`): add the same two.
- `tmuxCcController.launch` (`core/src/terminal/tmux-backend.ts`): pass them into `cc.launch`.
- `buildLaunchCmd` (`core/src/terminal/cc.ts`): when set, append `--append-system-prompt-file <path>` and `--mcp-config <path>` to `flags` (shell-quoted). When unset, append nothing.

**Verify:** `buildLaunchCmd` with neither → unchanged argv; with both → includes both flags + quoted paths.

## Component 2 — Controller bootstrap (system prompt + hub-MCP) at launch

In `mission-controller.ts` `launch` dep:
- Build the **guarded system prompt** (a module constant `CONTROLLER_SYSTEM_PROMPT`) describing role/scope/constraints (below); write it to a temp file (reuse the `materializeAppendSystemPrompt` tmpfile pattern from `runners/tmux-runner.ts`).
- Build the **hub-MCP keystone** config `{ mcpServers: { 'lm-assist-hub': { type:'http', url: deriveHubMcpUrl(hubUrl), headers:{ Authorization: 'Bearer <sk-key>' } } } }` using `deriveHubMcpUrl`/`upsertHubMcpServer` (`utils/claude-mcp-config.ts`) + the node's `apiKey` from `~/.lm-assist/hub.json` (`hub-dev.json` in dev); write to a temp file. If no hub key is configured, skip the mcp-config (non-fatal — connector inheritance still applies).
- Pass `appendSystemPromptFile` + `mcpConfigPath` into `tmuxCcController.launch`.

**`CONTROLLER_SYSTEM_PROMPT` (guarded scope):** "You are the **Mission Controller**, a fleet-elected agent. Your sole job is to drive *missions* to completion through the `mission_*` tools and the executor sessions you spawn — never edit code or touch unrelated systems yourself. Each pass: `mission_list`; for every active mission assess its executor (`mission_executor_status`), place/spawn/drive/adapt (`mission_place`, session drive), and mark done when complete. **Heartbeat:** when a pass finds no actionable work, reply with EXACTLY one line beginning `⟦HEARTBEAT⟧` and nothing else. When you take real action or answer the user, narrate normally and DO NOT use that marker. The user may message you directly here — treat their messages as authoritative (create/pause/adjust missions, answer questions) and reply substantively. The mission store is cross-node shared; you run on the elected leader."

**Verify:** a pure builder `buildControllerLaunchExtras({hubUrl, apiKey, writeFile})` returns `{appendSystemPromptFile, mcpConfigPath}` with the prompt file containing the role text and the mcp file containing the `lm-assist-hub` http entry with the Bearer key; with no `apiKey` → `mcpConfigPath` undefined.

## Component 3 — Reduced idle heartbeat cadence

The supervisor keeps auto-driving (autonomous), but **less often when idle**:
- Add `missionControllerIdleIntervalMin` (default **15**) to project-settings (keep `missionControllerIntervalMin` default 5 for the active cadence).
- `runSupervisorTick` drive-gating: `driveDue` uses the **active** interval when ≥1 active mission exists, else the **idle** interval. (Pure `isDriveDue({lastDriveAt, now, activeCount, activeMin, idleMin})` for testing.)

**Verify:** with 0 active missions, a drive 6 min ago is NOT due (idle=15); with ≥1 active mission, 6 min ago IS due (active=5).

## Component 4 — Web: meaningful-only chat + Send UX

`web/src/components/missions/MissionsPage.tsx`:
- **Heartbeat filter (the chat shows only meaningful msgs):** drop from the rendered chat (a) user-turns whose text starts with the directive prefix `Run a controller pass now:`, (b) assistant-turns whose text starts with `⟦HEARTBEAT⟧`, (c) empty/tool-only turns (`[N tool call(s)]` / blank). Show a subtle muted chip `· controller idle (N passes)` when heartbeats were collapsed, so the user knows it's alive.
- **Send button:** add a visible **Send** button next to the composer (disabled while busy/empty); keep Ctrl/Cmd+Enter.
- **Enter-to-send:** plain **Enter** sends; **Shift+Enter** inserts a newline.
- **Surface errors:** on drive failure, show a brief inline error (e.g. "Send failed — controller busy, retry") instead of silently swallowing.

**Verify (build + browser):** composer has a Send button; Enter sends; heartbeat ping-pong is hidden, the idle chip shows; a typed message reaches the controller and its reply appears.

## Out of scope
- Replacing native with cloud BYOC (native is the substrate).
- Changing the drive transport (cloud-relay vs tmux) — unchanged.
- Multi-controller / multiple chats.

## Verification (e2e, on deploy)
- Restart the controller (UI Restart, or supervisor relaunch) → its session launches with the system-prompt file + mcp-config; `mission_*` tools work; idle replies are single `⟦HEARTBEAT⟧` lines.
- 117 web (non-leader) Missions: chat shows only meaningful exchanges + an idle chip (no ping-pong flood); the Send button + Enter send a message that reaches the controller and shows its reply; page auto-connects to the live controller.
