# Wave 3 — Controller Bootstrap + Meaningful Chat + Send UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Launch the Mission Controller with a guarded system prompt + explicit hub-MCP; keep auto-driving but show only meaningful chat (filter heartbeat) at a reduced idle cadence; fix the composer (Send button + Enter-to-send + surfaced errors).

**Architecture:** Thread two optional file-path launch options through the existing shared launcher (`cc.ts`/`tmux-backend.ts`); the mission-controller builds a system-prompt tmpfile + hub-MCP tmpfile and passes them at launch. Supervisor drive-gating gains an idle interval. The web filters heartbeat turns and adds a Send button.

**Tech Stack:** TS (core, CJS), node:test; Next.js/React.

## Global Constraints
- CommonJS; bare `{success,data}` mission envelope; worker-token gate.
- New launch options are **optional**; unset → argv unchanged (no behavior change for existing callers: executors, CCR controller).
- `buildLaunchCmd` returns a shell string → pass **file paths only**, shell-quoted (never inline the prompt).
- Test (single file): `cd /home/ubuntu/lm-assist/core && export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/<file>.test.js`. Full core: `./core.sh build`. Web: `cd /home/ubuntu/lm-assist && export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" && (cd web && npx next build 2>&1 | tail -15)`.

---

### Task 1: Launcher — optional `appendSystemPromptFile` + `mcpConfigPath`

**Files:** Modify `core/src/terminal/backend.ts` (`CcLaunchOpts`), `core/src/terminal/types.ts` (`CCLaunchInput`), `core/src/terminal/tmux-backend.ts` (`launch`), `core/src/terminal/cc.ts` (`buildLaunchCmd`). Test: `core/src/__tests__/cc-launch-cmd.test.ts`.

**Interfaces:**
- Produces: `buildLaunchCmd(opts)` honoring `opts.appendSystemPromptFile?: string` → `--append-system-prompt-file <path>`, `opts.mcpConfigPath?: string` → `--mcp-config <path>`.
- `CcLaunchOpts` + `CCLaunchInput` both gain `appendSystemPromptFile?: string; mcpConfigPath?: string`.

- [ ] **Step 1: test** — `buildLaunchCmd` is a non-exported helper in `cc.ts`; if not exported, export it (or test via the smallest exported wrapper). Assert:
```ts
import { buildLaunchCmd } from '../terminal/cc';
test('no extras → no new flags', () => {
  const cmd = buildLaunchCmd({ cwd:'/x', model:null, extraFlags:[], skipPermissions:true, remoteControl:true, cols:200, rows:50, readyPattern:'ctx:', readyTimeoutMs:1, autoAcceptTrust:true } as any);
  assert.ok(!cmd.includes('--append-system-prompt-file'));
  assert.ok(!cmd.includes('--mcp-config'));
});
test('extras → both flags, paths quoted', () => {
  const cmd = buildLaunchCmd({ cwd:'/x', model:null, extraFlags:[], skipPermissions:true, remoteControl:true, cols:200, rows:50, readyPattern:'ctx:', readyTimeoutMs:1, autoAcceptTrust:true, appendSystemPromptFile:'/tmp/sp.txt', mcpConfigPath:'/tmp/mcp.json' } as any);
  assert.ok(cmd.includes('--append-system-prompt-file'));
  assert.ok(cmd.includes('/tmp/sp.txt'));
  assert.ok(cmd.includes('--mcp-config'));
  assert.ok(cmd.includes('/tmp/mcp.json'));
});
```
- [ ] **Step 2:** run → fail.
- [ ] **Step 3: implement** — add the two optional fields to `CCLaunchInput` (`types.ts`) and `CcLaunchOpts` (`backend.ts`); in `buildLaunchCmd` (`cc.ts`) append to the `flags` array after `remoteControlFlags`:
```ts
...(opts.appendSystemPromptFile ? ['--append-system-prompt-file', opts.appendSystemPromptFile] : []),
...(opts.mcpConfigPath ? ['--mcp-config', opts.mcpConfigPath] : []),
```
(they pass through `shellQuote` already). In `tmux-backend.ts` `launch`, forward `appendSystemPromptFile: opts.appendSystemPromptFile, mcpConfigPath: opts.mcpConfigPath` into the `cc.launch({...})` object.
- [ ] **Step 4:** run → pass.
- [ ] **Step 5: commit** `feat(terminal): optional --append-system-prompt-file + --mcp-config launch flags`.

---

### Task 2: Controller bootstrap extras (system prompt + hub-MCP keystone)

**Files:** Modify `core/src/mission/mission-controller.ts` (add `CONTROLLER_SYSTEM_PROMPT`, a pure `buildControllerLaunchExtras`, and call it in the `launch` dep). Test: `core/src/__tests__/mission-controller-bootstrap.test.ts`.

**Interfaces:**
- Produces: `CONTROLLER_SYSTEM_PROMPT: string` (exported); `buildControllerLaunchExtras(args: { hubUrl: string|null; apiKey: string|null; writeFile: (name:string, body:string)=>string }): { appendSystemPromptFile: string; mcpConfigPath?: string }` (exported, pure — `writeFile` returns the path it wrote). Uses `deriveHubMcpUrl` + `upsertHubMcpServer` from `utils/claude-mcp-config.ts`.
- Consumes (Task 1): `tmuxCcController.launch({..., appendSystemPromptFile, mcpConfigPath})`.

- [ ] **Step 1: test**
```ts
import { CONTROLLER_SYSTEM_PROMPT, buildControllerLaunchExtras } from '../mission/mission-controller';
test('system prompt names role + heartbeat marker', () => {
  assert.match(CONTROLLER_SYSTEM_PROMPT, /Mission Controller/);
  assert.match(CONTROLLER_SYSTEM_PROMPT, /⟦HEARTBEAT⟧/);
});
test('extras write prompt file always, mcp file only with apiKey', () => {
  const written: Record<string,string> = {};
  const wf = (n:string,b:string) => { const p = '/tmp/'+n; written[p]=b; return p; };
  const withKey = buildControllerLaunchExtras({ hubUrl:'wss://assist-api.langmart.ai', apiKey:'sk-x', writeFile:wf });
  assert.ok(withKey.appendSystemPromptFile);
  assert.ok(written[withKey.appendSystemPromptFile].includes('Mission Controller'));
  assert.ok(withKey.mcpConfigPath);
  const mcp = JSON.parse(written[withKey.mcpConfigPath!]);
  assert.ok(mcp.mcpServers['lm-assist-hub']);
  assert.match(mcp.mcpServers['lm-assist-hub'].url, /^https:\/\/mcp\.langmart\.ai\/mcp$/);
  assert.equal(mcp.mcpServers['lm-assist-hub'].headers.Authorization, 'Bearer sk-x');
  const noKey = buildControllerLaunchExtras({ hubUrl:'wss://assist-api.langmart.ai', apiKey:null, writeFile:wf });
  assert.equal(noKey.mcpConfigPath, undefined);
});
```
- [ ] **Step 2:** run → fail.
- [ ] **Step 3: implement** — add `CONTROLLER_SYSTEM_PROMPT` (the guarded role text from the spec, including the `⟦HEARTBEAT⟧` rule and "never edit code yourself / only mission_* tools" scope). Implement `buildControllerLaunchExtras`: always `writeFile('mission-controller-sp-<n>.txt', CONTROLLER_SYSTEM_PROMPT)`; if `apiKey`, build `cfg = upsertHubMcpServer({}, deriveHubMcpUrl(hubUrl), apiKey)` (or assemble the `{mcpServers:{'lm-assist-hub':{type:'http',url,headers}}}` object directly) and `writeFile('mission-controller-mcp-<n>.json', JSON.stringify(cfg))`. In the `launch` dep, read hub config (`~/.lm-assist/hub.json` or `hub-dev.json` per `IS_DEV_REPO`), call `buildControllerLaunchExtras` with a real `writeFile` (os.tmpdir + fs.writeFileSync, mode 0600 for the mcp file since it holds the key), and pass the two paths into `tmuxCcController.launch`. Non-fatal: wrap in try/catch; on failure launch without extras (preserve current behavior).
- [ ] **Step 4:** run → pass.
- [ ] **Step 5: commit** `feat(mission): launch controller with guarded system prompt + hub-MCP keystone`.

---

### Task 3: Reduced idle heartbeat cadence

**Files:** Modify `core/src/project-settings.ts` (add `missionControllerIdleIntervalMin`), `core/src/mission/mission-controller.ts` (`isDriveDue` + wire into `runSupervisorTick`). Test: extend `core/src/__tests__/mission-supervisor.test.ts`.

**Interfaces:**
- Produces: `isDriveDue(args: { lastDriveAt: number|null; now: number; activeCount: number; activeMin: number; idleMin: number }): boolean` (exported, pure). `activeCount>0` → interval `activeMin`, else `idleMin`. `lastDriveAt==null` → true.
- `ProjectSettings` gains `missionControllerIdleIntervalMin?: number` (default 15).

- [ ] **Step 1: test**
```ts
import { isDriveDue } from '../mission/mission-controller';
const now = 1_000_000_000_000;
test('idle: 6min since drive, 0 missions, idle=15 → not due', () => {
  assert.equal(isDriveDue({ lastDriveAt: now-6*60_000, now, activeCount:0, activeMin:5, idleMin:15 }), false);
});
test('active: 6min since drive, 1 mission, active=5 → due', () => {
  assert.equal(isDriveDue({ lastDriveAt: now-6*60_000, now, activeCount:1, activeMin:5, idleMin:15 }), true);
});
test('never driven → due', () => {
  assert.equal(isDriveDue({ lastDriveAt:null, now, activeCount:0, activeMin:5, idleMin:15 }), true);
});
```
- [ ] **Step 2:** run → fail.
- [ ] **Step 3: implement** — add `isDriveDue`; in `runSupervisorTick`, replace the existing `driveDue` computation with `isDriveDue({ lastDriveAt: cs?.lastDriveAt ?? null, now: Date.now(), activeCount: <active missions count already available in the tick>, activeMin: missionControllerIntervalMin, idleMin: missionControllerIdleIntervalMin })`. Add the setting + default 15 to `project-settings.ts`. (The tick already loads missions for placement — reuse that count; if not, `listActiveMissions(port).length`.)
- [ ] **Step 4:** run → pass (existing supervisor tests still green — `driveDue` inputs may need updating to keep them valid).
- [ ] **Step 5: commit** `feat(mission): reduced idle heartbeat cadence (missionControllerIdleIntervalMin, default 15)`.

---

### Task 4: Web — meaningful-only chat + Send UX

**Files:** Modify `web/src/components/missions/MissionsPage.tsx`. Verify: `next build` + browser.

**Interfaces:** Consumes `chatMessages: SessionMessage[]` ({role,text}). A pure `isHeartbeatMsg(msg)` + `splitMeaningful(msgs)` helper near the render.

- [ ] **Step 1: heartbeat filter** — before rendering `chatMessages`, compute the visible list: drop msgs where text (resolved via the existing `msg.text ?? content` logic) (a) starts with `Run a controller pass now:`, (b) starts with `⟦HEARTBEAT⟧`, (c) is empty or matches `^\[\d+ tool call\(s\)\]$`. Count the dropped ones; if >0, render a subtle muted chip above/below the transcript: `· controller idle (N background passes)`.
- [ ] **Step 2: Send button** — add a visible **Send** button in the composer row (calls the same `sendControllerChat(sid, leader)`), `disabled={chatSendBusy || !chatDraft.trim()}`. Keep the existing Ctrl/Cmd+Enter handler.
- [ ] **Step 3: Enter-to-send** — in the textarea `onKeyDown`: `if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendControllerChat(sid, leader); }` (Shift+Enter = newline; Ctrl/Cmd+Enter still works). Update the placeholder to `Type a message… (Enter to send, Shift+Enter for newline)`.
- [ ] **Step 4: surface send errors** — add `const [chatSendError, setChatSendError] = useState<string|null>(null)`; in `sendControllerChat` set it on failure (and clear on success/typing); render it as a small red line under the composer. (Stop silently swallowing.)
- [ ] **Step 5: build** — `cd /home/ubuntu/lm-assist && export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH" && (cd web && npx next build 2>&1 | tail -15)` clean.
- [ ] **Step 6: commit** `feat(web): meaningful-only mission chat (filter heartbeat) + Send button + Enter-to-send + error surface`.

---

## Final verification (pre-deploy)
- [ ] `node --test "dist-test/__tests__/mission-*.test.js"` + `cc-launch-cmd` → green. `./core.sh build` + web build clean.
- [ ] Bump version, build tgz, GitHub release, deploy fleet (123 leader first — it runs the controller launch; then 117/107). Direct `npm install -g <tgz>` (NOT `lm-assist upgrade` — the deployed build ignores `--from`).
- [ ] Restart the controller so it relaunches with the new bootstrap; confirm the launched argv has `--append-system-prompt-file` + `--mcp-config`, idle replies are single `⟦HEARTBEAT⟧` lines, `mission_*` tools work.
- [ ] 117 web: chat shows only meaningful msgs + idle chip; Send button + Enter send a message that reaches the controller; auto-connects.

## Self-Review notes
- Spec coverage: launcher (T1), bootstrap (T2), cadence (T3), web (T4). Optional launch opts → no change for existing callers. File-path-only flags (no inline prompt in the shell string). Heartbeat marker `⟦HEARTBEAT⟧` is produced by the system prompt (T2) and filtered by the web (T4) + the directive prefix `Run a controller pass now:` matches `CONTROLLER_PASS_DIRECTIVE` (T2/existing).
- Types: `appendSystemPromptFile`/`mcpConfigPath` consistent across T1; `buildControllerLaunchExtras`/`isDriveDue` pure + exported for tests.
