# Auth Monitor + Guided Login — Design Spec

**Date:** 2026-06-26
**Branch:** `feat/auth-monitor-login`
**Status:** approved (design signed off in chat 2026-06-26)

## Goal

Keep each node's auth credentials fresh and visible: a periodic **auth-monitor**
job that proactively refreshes the Claude Code OAuth token and tracks claude.ai
cookie health into a per-node snapshot; **bootstrap** reports that snapshot
(lightweight); and a guided **`claudeai_login`** MCP tool + `guide("login")` for
re-login when a credential is dead — covering **both** the cookie and OAuth.

## Background — what exists (verified)

- **OAuth refresh exists but is lazy/on-use:** `getValidAccessToken()`
  (`core/src/utils/claude-oauth.ts:198`) reads `~/.claude/.credentials.json`, and
  if `isTokenExpired(creds)` (default `REFRESH_BUFFER_MS` = 5 min) refreshes via the
  refresh-token grant and persists atomically (`0o600`). `getOAuthStatus()` (:241)
  is the non-throwing snapshot. No proactive/periodic refresh today.
- **claude.ai cookie has NO auto-refresh.** `getClaudeAISessionStatus()`
  (`core/src/utils/claudeai-session.ts:134`, file inspection: `present`,
  `hasSessionKey`/`hasCfClearance`/`hasCfBm`, `identity`) +
  `probeClaudeAISession()` (:179, active `/api/account_profile`, `reason ∈
  ok|session_not_configured|session_expired|cloudflare_blocked|network_error|upstream_error|unknown`).
- **Browser capture exists:** `launchAndCapture(opts)` / `captureSession(opts)`
  (`core/src/utils/claudeai-browser-launch.ts:982/533`) launch Chrome, wait for the
  user to log in, capture cookies over CDP, write `~/.claude/claudeai-session.json`.
  Routes: `POST /claude-ai/browser/launch-and-capture`, `/capture-session`.
- **Scheduled jobs:** `makeBuiltinJobs()` (`scheduler/scheduled-jobs.ts:240`) returns
  builtin `ScheduledJob`s; `stall-monitor` (:264) is the template. `registerHandler(type, fn)`
  (:317); self-register block in `registerDefaults()` (:405). 1-min poll tick; handler
  reads live `getProjectSettings()` and early-returns `status:'skipped'` when its toggle is off.
- **Per-node store:** `core/src/monitor/stall-store.ts` (atomic tmp-rename, `0o600`) is the template.
- **MCP tool registration:** import + spread into `expanded.ts` (`EXPANDED_TOOL_DEFS` +
  `EXPANDED_HANDLERS`) + a `TOOL_SCOPES` entry in `configure.ts` (else
  `assertScopesCoverTools()` fails boot). `auth_status: 'read'`, `browser_task: 'admin'`.
- **bootstrap:** `BOOTSTRAP` is computed ONCE at module load (`guide.ts:385`,
  `buildBootstrap()` concatenates static `GUIDES`); `handleBootstrap` returns it. Live
  per-node status must be appended by `handleBootstrap` per-call, not baked into `BOOTSTRAP`.
- **Connector reconnect** is composed, not a helper: `createMcpRemoteServer(opts)`
  (`claudeai-session.ts:1018`) registers; `browser_task` (`/agent/execute` with
  `chrome:true`) drives the "click Connect" step (`browser-task.ts:5` — "the same
  delegation the connector-reconnect uses").

## Hard reality (drives scope)

The cookie's `sessionKey` (`sk-ant-sid…`) **cannot be minted headlessly** — it
requires an interactive human login in a browser. `cf_clearance`/`cf_bm` are
Cloudflare anti-bot tokens, also not headless-mintable. Therefore:
- **OAuth** → fully auto-refreshable on a schedule (refresh-token grant). ✅
- **Cookie** → the periodic job can only **monitor + flag + keep the status fresh**;
  active re-login is on-demand via `claudeai_login` (needs the user's browser).
- The periodic job **never spawns a browser agent** (no scheduled `/agent/execute`).
  Active cookie/connector reauth is user/agent-triggered only.

## Global Constraints

- **No secrets in the snapshot or any output.** Store/report only presence,
  expiry, freshness flags, reason codes, identity email/uuid — never tokens or
  cookie values.
- **No-throw, best-effort everywhere.** Every probe/refresh/file op in the monitor
  and tools is wrapped; a failure degrades to `unknown`/`error` in the snapshot and
  never throws out of the job tick or the tool handler.
- **The periodic job is browser-free.** It refreshes OAuth + probes the cookie +
  writes the snapshot. It MUST NOT launch Chrome or fire `/agent/execute`.
- **Per-node, local.** OAuth/cookie are per-host. The monitor maintains only the
  LOCAL node's snapshot; the fleet view is an on-demand `auth_status(allNodes)` sweep.
- **Toggle + safe defaults.** `authMonitorEnabled` (default **true**),
  `authMonitorIntervalMin` (default **15**, clamp 1–1440). Settable via the
  project-settings PUT whitelist.
- New MCP tool needs a `TOOL_SCOPES` entry. Routes wrap results in the project's
  envelope; mission/auth routes use `ok()`/`fail()`-style bare `{success,data}`.

## Architecture

### Snapshot shape (`~/.lm-assist/auth-status.json`)

```ts
interface AuthSnapshot {
  checkedAt: number;            // Date.now()
  oauth: {
    present: boolean; expired: boolean; msUntilExpiry?: number;
    refreshedThisCheck: boolean; subscriptionType?: string; rateLimitTier?: string;
  };
  cookie: {
    configured: boolean; ok: boolean;
    reason: string;             // probe reason vocab; '' when ok
    hasSessionKey?: boolean; hasCfClearance?: boolean; hasCfBm?: boolean;
    identity?: string;          // email | full_name | uuid
    hint?: string;
  };
}
```

### Part 1 — `auth-monitor` periodic job

**Files:** `core/src/monitor/auth-monitor.ts` (NEW), `core/src/monitor/auth-store.ts`
(NEW), `core/src/scheduler/scheduled-jobs.ts` (add builtin + register),
`core/src/project-settings.ts` (+routes) (toggles).

- `buildAuthSnapshot(deps): Promise<AuthSnapshot>` — pure-ish orchestrator (injected
  deps for testability): (a) `deps.refreshOAuth()` → calls `getValidAccessToken()`
  wrapped (refreshes if within buffer; records `refreshedThisCheck`), then
  `getOAuthStatus()` for the oauth block; (b) `deps.cookieStatus()` =
  `getClaudeAISessionStatus()` + `deps.cookieProbe()` = `probeClaudeAISession()` for
  the cookie block. Never throws.
- `auth-store.ts`: `loadAuthSnapshot()/saveAuthSnapshot(s)` — clone `stall-store.ts`
  (atomic tmp-rename, `0o600`), file `~/.lm-assist/auth-status.json`.
- `registerAuthMonitor(jobs)`: `jobs.registerHandler('auth-monitor', async () => {
  if (!getProjectSettings().authMonitorEnabled) return {result:'disabled',status:'skipped'};
  const snap = await buildAuthSnapshot(defaultDeps); saveAuthSnapshot(snap);
  return { result: \`oauth=\${snap.oauth.expired?'expired':'ok'}\${snap.oauth.refreshedThisCheck?'(refreshed)':''} cookie=\${snap.cookie.ok?'ok':snap.cookie.reason}\`, status:'ok' }; })`.
- Builtin: add `{ id:'auth-monitor', type:'auth-monitor', name:'Auth monitor',
  enabled:true, intervalMinutes:15, config:{}, builtin:true, ... }` to `makeBuiltinJobs`.
- Self-register block in `registerDefaults()`: `{ const { registerAuthMonitor } =
  require('../monitor/auth-monitor'); registerAuthMonitor(this); }`.
- project-settings: `authMonitorEnabled:boolean`(default true) +
  `authMonitorIntervalMin:number`(default 15) in the interface, DEFAULTS, GET coerce,
  PUT merge; route PUT whitelist adds both (interval clamped 1–1440 like
  `missionSessionIdleCloseMin`).

### Part 2 — bootstrap reports status (lightweight)

**Files:** `core/src/mcp-server/tools/guide.ts`.

- `handleBootstrap` becomes per-call: returns `BOOTSTRAP` + a dynamic
  `## Auth status (this node)` block built from the snapshot. Read
  `loadAuthSnapshot()`; if missing or staler than `2×authMonitorIntervalMin`,
  compute one inline via `buildAuthSnapshot(defaultDeps)` (one local probe, fast — NO
  cross-node, NO browser) and persist it, so bootstrap always shows current local
  auth. Format: `OAuth: ✓ valid (expires in Xh) | ✗ EXPIRED | — none`; `claude.ai
  cookie: ✓ ok (email) | ✗ <reason> | — not configured`. When a credential is
  not-ok, append `→ run claudeai_login(which="…") to fix`. Add a one-liner: `Fleet:
  auth_status(allNodes:true)`.
- Add `GUIDES.login` topic (static walkthrough — see Part 3) + `order` includes it;
  `BLURB.login`; aliases `login/relogin/re-login/signin/sign-in → 'login'` (the
  existing `auth/oauth → account` aliases stay).

### Part 3 — `claudeai_login` tool + `auth_status` allNodes + `guide("login")`

**Files:** `core/src/mcp-server/tools/claudeai-login.ts` (NEW),
`core/src/mcp-server/tools/auth-status.ts` (allNodes), `expanded.ts` + `configure.ts`
(register+scope), `guide.ts` (the `login` topic).

- `claudeai_login` tool — `inputSchema { which: enum['cookie','oauth','all'] default
  'all', node?, browser? }`, scope **`admin`**. Handler (`workerPost`/`workerGet` via
  `_passthrough`):
  - **oauth** (which ∈ all|oauth): `workerGet('/claude-code/oauth-status')`; if
    present+refreshable it's already auto-refreshed by the monitor/lazy path → report
    "valid / refreshed"; if `present:false` or the refresh-token is dead → instruct
    "run Claude Code on node <X> to log in (OAuth re-login is interactive)."
  - **cookie** (which ∈ all|cookie): pre-check `/claude-ai/healthz`; if already ok →
    say so. Else, when `browser` is requested (or a desktop browser exists), trigger
    `workerPost('/claude-ai/browser/launch-and-capture', { loginTimeoutMs })` → returns
    "Chrome opened on node <X> — log in; capturing…" with the capture result
    (cookieCount) or the failure code; otherwise return the exact MANUAL steps
    (DevTools → copy Cookie header → write `~/.claude/claudeai-session.json`) + the
    `via-chrome` option. NEVER enter credentials — only the user logs in.
  - Always end by re-reading `/claude-ai/healthz` + `/claude-code/oauth-status` and
    reporting the resulting status.
- `auth_status` gains `allNodes` (boolean): when true, `list_nodes` → for each node
  `workerGet(node)` both sections (parallel, per-node best-effort), return a compact
  matrix. When false (default) keep current behavior.
- `guide("login")` topic: per-node cookie + OAuth re-login walkthrough — the
  `claudeai_login` tool, the browser-capture vs manual paths, the OAuth interactive
  note, the IP-pinned-cookie caveat, and the connector-reconnect pointer.

## Testing strategy

- **Pure/unit (node:test, injected deps):** `buildAuthSnapshot` — oauth
  refreshed/expired/absent × cookie ok/expired/cloudflare/not-configured; never-throws
  when a dep throws. `auth-store` round-trip. The bootstrap staleness decision
  (fresh snapshot used as-is vs recompute when stale/missing). `claudeai_login`
  branch selection (which routing; browser-vs-manual decision) via injected
  `workerGet/workerPost`. `auth_status` allNodes aggregation (injected node list +
  per-node fake).
- **Integration (live, this fleet):** the auth-monitor job runs and writes a
  snapshot with NO secrets; bootstrap shows the local auth block; `claudeai_login`
  (oauth path) reports status without launching a browser on a headless node;
  `auth_status(allNodes)` sweeps 117/123/107. Cookie browser-capture path is
  exercised only where a desktop browser exists (107) or documented as manual.
- **Boot guard:** `assertScopesCoverTools()` passes (the new tool has a scope).

## Out of scope

- Headless cookie/`cf_clearance` minting (impossible — needs human login).
- Auto-driving the browser/connector-reconnect on a schedule (the periodic job is
  browser-free; active reauth is `claudeai_login` only).
- A web Settings UI control (the toggles are REST-settable; UI is a follow-up).
- Cross-node snapshot collection in the monitor (fleet view is on-demand via `auth_status(allNodes)`).
