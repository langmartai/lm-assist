# Auth Monitor + Guided Login — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A periodic auth-monitor job that proactively refreshes OAuth + tracks claude.ai cookie health into a per-node snapshot; bootstrap reports it; a `claudeai_login` MCP tool + `guide("login")` for re-login (cookie + OAuth).

**Architecture:** New `core/src/monitor/auth-monitor.ts` (`buildAuthSnapshot` orchestrator, `registerAuthMonitor` job) + `auth-store.ts` (snapshot persistence). Wired as a builtin scheduled job (browser-free). `handleBootstrap` appends a live local-auth block. New `claudeai_login` tool + `auth_status(allNodes)` + `guide("login")`.

**Tech Stack:** TypeScript (CommonJS), `node:test`, existing `claude-oauth.ts` / `claudeai-session.ts` / `claudeai-browser-launch.ts` / scheduler.

## Global Constraints

- **No secrets** in the snapshot or any tool/bootstrap output — only presence, expiry, freshness flags, reason codes, identity (email/uuid).
- **No-throw, best-effort** in the monitor + tools: every probe/refresh/file op wrapped; failure → `unknown`/`error`, never throws out of a job tick or handler.
- **The periodic job is browser-free** — refresh OAuth + probe cookie + write snapshot ONLY. No Chrome, no `/agent/execute`. Active cookie/connector reauth is `claudeai_login` (user-triggered) only.
- **bootstrap's auth block is NETWORK-FREE** — it reads the monitor's snapshot, or a file-only light fallback (`lightAuthSnapshot()`: `getOAuthStatus()` + `getClaudeAISessionStatus()`, both local file reads). It MUST NOT do the active cookie probe or an OAuth refresh inline (those belong to the monitor) — bootstrap stays fast.
- **Per-node, local** — monitor maintains only THIS node's snapshot; fleet view = on-demand `auth_status(allNodes)`.
- `authMonitorEnabled` default **true**; `authMonitorIntervalMin` default **15**, clamp **1–1440**.
- Any new MCP tool advertised in `EXPANDED_TOOL_DEFS` MUST have a `TOOL_SCOPES` entry or `assertScopesCoverTools()` fails boot.
- **Test runner — `tsx` is NOT installed:** `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/<file>.test.js`. RED for a missing module/symbol surfaces as a tsc compile error — that's the expected failing state. After TS edits, `cd /home/ubuntu/lm-assist && ./core.sh build` must be clean.

---

### Task 1: Snapshot store + `buildAuthSnapshot` orchestrator

**Files:**
- Create: `core/src/monitor/auth-store.ts`, `core/src/monitor/auth-monitor.ts`
- Test: `core/src/__tests__/auth-snapshot.test.ts`

**Interfaces:**
- Produces: `AuthSnapshot` (shape below), `loadAuthSnapshot()/saveAuthSnapshot(s)`, `buildAuthSnapshot(deps: AuthSnapshotDeps): Promise<AuthSnapshot>`, `AuthSnapshotDeps`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/auth-snapshot.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { buildAuthSnapshot, type AuthSnapshotDeps } from '../monitor/auth-monitor';

function deps(over: Partial<AuthSnapshotDeps>): AuthSnapshotDeps {
  return {
    refreshOAuth: async () => ({ refreshed: false }),
    oauthStatus: () => ({ present: true, expired: false, msUntilExpiry: 3600_000, subscriptionType: 'max', rateLimitTier: 't1' }),
    cookieStatus: () => ({ present: true, hasSessionKey: true, hasCfClearance: true, hasCfBm: true, identity: 'a@b.c' }),
    cookieProbe: async () => ({ ok: true, reason: 'ok' }),
    now: () => 1_000,
    ...over,
  };
}

test('healthy: oauth ok + cookie ok', async () => {
  const s = await buildAuthSnapshot(deps({}));
  assert.strictEqual(s.oauth.present, true);
  assert.strictEqual(s.oauth.expired, false);
  assert.strictEqual(s.cookie.ok, true);
  assert.strictEqual(s.cookie.reason, 'ok');
  assert.strictEqual(s.cookie.identity, 'a@b.c');
  assert.strictEqual(s.checkedAt, 1_000);
});

test('oauth refreshed flag propagates', async () => {
  const s = await buildAuthSnapshot(deps({ refreshOAuth: async () => ({ refreshed: true }) }));
  assert.strictEqual(s.oauth.refreshedThisCheck, true);
});

test('cookie expired → ok:false carries reason, no identity leak of secrets', async () => {
  const s = await buildAuthSnapshot(deps({
    cookieStatus: () => ({ present: true, hasSessionKey: true }),
    cookieProbe: async () => ({ ok: false, reason: 'session_expired', hint: 'recapture' }),
  }));
  assert.strictEqual(s.cookie.ok, false);
  assert.strictEqual(s.cookie.reason, 'session_expired');
  assert.strictEqual(s.cookie.hint, 'recapture');
});

test('oauth absent', async () => {
  const s = await buildAuthSnapshot(deps({ oauthStatus: () => ({ present: false, expired: false }) }));
  assert.strictEqual(s.oauth.present, false);
});

test('cookie not configured', async () => {
  const s = await buildAuthSnapshot(deps({
    cookieStatus: () => ({ present: false }),
    cookieProbe: async () => ({ ok: false, reason: 'session_not_configured' }),
  }));
  assert.strictEqual(s.cookie.configured, false);
  assert.strictEqual(s.cookie.ok, false);
});

test('never throws when a dep throws → degrades', async () => {
  const s = await buildAuthSnapshot(deps({
    refreshOAuth: async () => { throw new Error('net'); },
    oauthStatus: () => { throw new Error('boom'); },
    cookieProbe: async () => { throw new Error('429'); },
  }));
  assert.strictEqual(s.oauth.present, false);   // degraded
  assert.strictEqual(s.cookie.ok, false);
  assert.ok(typeof s.checkedAt === 'number');
});

test('snapshot contains NO token/cookie secret fields', async () => {
  const s = await buildAuthSnapshot(deps({}));
  const json = JSON.stringify(s);
  for (const k of ['accessToken', 'refreshToken', 'sessionKey', 'cf_clearance', 'sk-ant']) {
    assert.ok(!json.includes(k), `snapshot leaked ${k}`);
  }
});
```

- [ ] **Step 2: Run → RED** (tsc: cannot find `../monitor/auth-monitor`).
Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/auth-snapshot.test.js`

- [ ] **Step 3: Implement.** Create `core/src/monitor/auth-store.ts` (clone `stall-store.ts` verbatim, retargeted):

```ts
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/path-utils';
import type { AuthSnapshot } from './auth-monitor';

function storeFile(): string { return path.join(getDataDir(), 'auth-status.json'); }

export function loadAuthSnapshot(): AuthSnapshot | null {
  try { const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8')); return raw && typeof raw === 'object' ? raw as AuthSnapshot : null; }
  catch { return null; }
}

export function saveAuthSnapshot(snap: AuthSnapshot): void {
  const f = storeFile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
    try { fs.chmodSync(f, 0o600); } catch { /* ignore */ }
  } catch { /* best-effort */ }
}
```

Create `core/src/monitor/auth-monitor.ts` (snapshot types + the orchestrator; `registerAuthMonitor` + `defaultDeps` added in Task 2):

```ts
export interface AuthSnapshot {
  checkedAt: number;
  oauth: { present: boolean; expired: boolean; msUntilExpiry?: number; refreshedThisCheck: boolean; subscriptionType?: string; rateLimitTier?: string };
  cookie: { configured: boolean; ok: boolean; reason: string; hasSessionKey?: boolean; hasCfClearance?: boolean; hasCfBm?: boolean; identity?: string; hint?: string };
}

export interface AuthSnapshotDeps {
  refreshOAuth: () => Promise<{ refreshed: boolean }>;           // wraps getValidAccessToken()
  oauthStatus: () => { present: boolean; expired: boolean; msUntilExpiry?: number; subscriptionType?: string; rateLimitTier?: string }; // getOAuthStatus()
  cookieStatus: () => { present: boolean; hasSessionKey?: boolean; hasCfClearance?: boolean; hasCfBm?: boolean; identity?: string };     // getClaudeAISessionStatus()
  cookieProbe: () => Promise<{ ok: boolean; reason: string; hint?: string }>; // probeClaudeAISession()
  now: () => number;
}

export async function buildAuthSnapshot(deps: AuthSnapshotDeps): Promise<AuthSnapshot> {
  let refreshed = false;
  try { refreshed = (await deps.refreshOAuth()).refreshed; } catch { /* best-effort */ }

  let oauth: AuthSnapshot['oauth'] = { present: false, expired: false, refreshedThisCheck: refreshed };
  try {
    const o = deps.oauthStatus();
    oauth = { present: !!o.present, expired: !!o.expired, msUntilExpiry: o.msUntilExpiry, refreshedThisCheck: refreshed, subscriptionType: o.subscriptionType, rateLimitTier: o.rateLimitTier };
  } catch { /* degraded */ }

  let cookie: AuthSnapshot['cookie'] = { configured: false, ok: false, reason: 'unknown' };
  try {
    const cs = deps.cookieStatus();
    let probe: { ok: boolean; reason: string; hint?: string };
    try { probe = await deps.cookieProbe(); } catch { probe = { ok: false, reason: 'network_error' }; }
    cookie = {
      configured: !!cs.present, ok: !!probe.ok, reason: probe.ok ? 'ok' : (probe.reason || 'unknown'),
      hasSessionKey: cs.hasSessionKey, hasCfClearance: cs.hasCfClearance, hasCfBm: cs.hasCfBm,
      identity: cs.identity, hint: probe.hint,
    };
  } catch { /* degraded */ }

  return { checkedAt: deps.now(), oauth, cookie };
}
```

- [ ] **Step 4: Run → GREEN** (all 7 pass). Then `cd /home/ubuntu/lm-assist && ./core.sh build` (clean).

- [ ] **Step 5: Commit** — `git add core/src/monitor/auth-store.ts core/src/monitor/auth-monitor.ts core/src/__tests__/auth-snapshot.test.ts && git commit -m "feat(auth): AuthSnapshot store + buildAuthSnapshot orchestrator (no-throw, no secrets)"`

---

### Task 2: Scheduled `auth-monitor` job + project-settings toggles

**Files:**
- Modify: `core/src/monitor/auth-monitor.ts` (append `defaultDeps` + `registerAuthMonitor`)
- Modify: `core/src/scheduler/scheduled-jobs.ts` (builtin + register block)
- Modify: `core/src/project-settings.ts`, `core/src/routes/core/project-settings.routes.ts`
- Test: `core/src/__tests__/auth-monitor-settings.test.ts`

**Interfaces:** Consumes `buildAuthSnapshot`, `saveAuthSnapshot`. Produces `registerAuthMonitor(jobs)`, `defaultDeps`, settings `authMonitorEnabled`/`authMonitorIntervalMin`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/auth-monitor-settings.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { getProjectSettings, saveProjectSettings, DEFAULTS } from '../project-settings';

test('authMonitor defaults: enabled true, interval 15', () => {
  assert.strictEqual(DEFAULTS.authMonitorEnabled, true);
  assert.strictEqual(DEFAULTS.authMonitorIntervalMin, 15);
});

test('authMonitor settings round-trip + clamp', () => {
  const prev = getProjectSettings();
  try {
    let s = saveProjectSettings({ authMonitorEnabled: false, authMonitorIntervalMin: 9999 });
    assert.strictEqual(s.authMonitorEnabled, false);
    // interval is clamped at the route layer (1..1440); the store itself accepts the number
    assert.strictEqual(typeof s.authMonitorIntervalMin, 'number');
  } finally {
    saveProjectSettings({ authMonitorEnabled: prev.authMonitorEnabled, authMonitorIntervalMin: prev.authMonitorIntervalMin });
  }
});
```

(The job handler is integration-verified live in Task 5; its disabled→skip + snapshot-write logic is exercised there. The pure snapshot logic is Task 1.)

- [ ] **Step 2: Run → RED** (`DEFAULTS.authMonitorEnabled` missing).

- [ ] **Step 3a: project-settings** (`core/src/project-settings.ts`) — add to the interface (after `autoResumeIntervalMin`), DEFAULTS, the GET coerce block, and the `saveProjectSettings` merge block, mirroring `autoResumeStalledEnabled`/`autoResumeIntervalMin` exactly:

```ts
// interface:
  /** Periodic auth-monitor: refresh OAuth + track cookie health into a snapshot. Default true. */
  authMonitorEnabled: boolean;
  /** Minutes between auth-monitor checks. Default 15. */
  authMonitorIntervalMin: number;
// DEFAULTS:
  authMonitorEnabled: true,
  authMonitorIntervalMin: 15,
// getProjectSettings() coerce:
  authMonitorEnabled: typeof data.authMonitorEnabled === 'boolean' ? data.authMonitorEnabled : DEFAULTS.authMonitorEnabled,
  authMonitorIntervalMin: typeof data.authMonitorIntervalMin === 'number' ? data.authMonitorIntervalMin : DEFAULTS.authMonitorIntervalMin,
// saveProjectSettings() merge:
  authMonitorEnabled: typeof partial.authMonitorEnabled === 'boolean' ? partial.authMonitorEnabled : current.authMonitorEnabled,
  authMonitorIntervalMin: typeof partial.authMonitorIntervalMin === 'number' ? partial.authMonitorIntervalMin : current.authMonitorIntervalMin,
```

- [ ] **Step 3b: PUT whitelist** (`project-settings.routes.ts`) — clamp interval (like `missionSessionIdleCloseMin`) and add both to the `saveProjectSettings({...})` call:

```ts
let authMonitorIntervalMin: number | undefined;
if (body.authMonitorIntervalMin !== undefined) {
  const n = Number(body.authMonitorIntervalMin);
  if (Number.isFinite(n)) authMonitorIntervalMin = Math.max(1, Math.min(1440, Math.round(n)));
}
// ...in the saveProjectSettings({...}) call add:
  authMonitorEnabled: body.authMonitorEnabled,
  authMonitorIntervalMin,
```

- [ ] **Step 3c: auth-monitor `defaultDeps` + `registerAuthMonitor`** (append to `core/src/monitor/auth-monitor.ts`):

```ts
export function defaultDeps(): AuthSnapshotDeps {
  const oauth = require('../utils/claude-oauth') as typeof import('../utils/claude-oauth');
  const cookie = require('../utils/claudeai-session') as typeof import('../utils/claudeai-session');
  return {
    refreshOAuth: async () => {
      try { const before = oauth.readClaudeOAuth(); await oauth.getValidAccessToken();
            const after = oauth.readClaudeOAuth();
            return { refreshed: !!(before && after && before.accessToken !== after.accessToken) }; }
      catch { return { refreshed: false }; }
    },
    oauthStatus: () => { const s = oauth.getOAuthStatus(); return { present: s.present, expired: s.expired, msUntilExpiry: s.msUntilExpiry, subscriptionType: s.subscriptionType, rateLimitTier: s.rateLimitTier }; },
    cookieStatus: () => { const s = cookie.getClaudeAISessionStatus(); const id = s.identity?.email || s.identity?.full_name || s.identity?.uuid; return { present: s.present, hasSessionKey: s.hasSessionKey, hasCfClearance: s.hasCfClearance, hasCfBm: s.hasCfBm, identity: id }; },
    cookieProbe: async () => { const p = await cookie.probeClaudeAISession(); return { ok: p.ok, reason: p.reason, hint: p.hint }; },
    now: () => Date.now(),
  };
}

export function registerAuthMonitor(jobs: { registerHandler: (t: string, fn: (config: any, ctx: any) => Promise<any>) => void }): void {
  jobs.registerHandler('auth-monitor', async () => {
    const { getProjectSettings } = require('../project-settings') as typeof import('../project-settings');
    if (!getProjectSettings().authMonitorEnabled) return { result: 'auth-monitor disabled', status: 'skipped' };
    const { saveAuthSnapshot } = require('./auth-store') as typeof import('./auth-store');
    const snap = await buildAuthSnapshot(defaultDeps());
    saveAuthSnapshot(snap);
    const o = snap.oauth.present ? (snap.oauth.expired ? 'expired' : 'ok') + (snap.oauth.refreshedThisCheck ? '(refreshed)' : '') : 'none';
    const c = snap.cookie.configured ? (snap.cookie.ok ? 'ok' : snap.cookie.reason) : 'none';
    return { result: `oauth=${o} cookie=${c}`, status: 'ok' };
  });
}
```

- [ ] **Step 3d: scheduled-jobs builtin + register** (`core/src/scheduler/scheduled-jobs.ts`): add to the `makeBuiltinJobs` returned array (next to `stall-monitor`):

```ts
{ id: 'auth-monitor', name: 'Auth monitor', description: 'Refresh Claude Code OAuth + track claude.ai cookie health into a per-node snapshot (browser-free).', type: 'auth-monitor', enabled: true, intervalMinutes: 15, config: {}, lastRunAt: null, lastResult: null, lastStatus: null, builtin: true, createdAt: at, updatedAt: at },
```
and in `registerDefaults()`, after the stall-monitor block:
```ts
{ const { registerAuthMonitor } = require('../monitor/auth-monitor'); registerAuthMonitor(this); }
```

- [ ] **Step 4:** Run the settings test → GREEN; `./core.sh build` clean.

- [ ] **Step 5: Commit** — `feat(auth): periodic auth-monitor scheduled job + project-settings toggles`

---

### Task 3: bootstrap reports the local auth status

**Files:**
- Modify: `core/src/mcp-server/tools/guide.ts` (`handleBootstrap` dynamic block + a pure staleness helper)
- Test: `core/src/__tests__/bootstrap-auth.test.ts`

**Interfaces:** Consumes `AuthSnapshot`, `loadAuthSnapshot`, `buildAuthSnapshot`. Produces a pure `authSnapshotIsStale(snap, now, intervalMin)` + `formatAuthBlock(snap, nodeLabel)` + per-call `handleBootstrap`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/bootstrap-auth.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { authSnapshotIsStale, formatAuthBlock } from '../mcp-server/tools/guide';
import type { AuthSnapshot } from '../monitor/auth-monitor';

const snap = (over: Partial<AuthSnapshot> = {}): AuthSnapshot => ({
  checkedAt: 1000,
  oauth: { present: true, expired: false, msUntilExpiry: 3600_000, refreshedThisCheck: false },
  cookie: { configured: true, ok: true, reason: 'ok', identity: 'a@b.c' },
  ...over,
});

test('isStale: null → stale', () => assert.strictEqual(authSnapshotIsStale(null, 0, 15), true));
test('isStale: fresh within 2x interval → not stale', () => {
  assert.strictEqual(authSnapshotIsStale(snap({ checkedAt: 0 }), 10 * 60_000, 15), false);
});
test('isStale: older than 2x interval → stale', () => {
  assert.strictEqual(authSnapshotIsStale(snap({ checkedAt: 0 }), 31 * 60_000, 15), true);
});
test('formatAuthBlock: healthy shows valid + ok, no secrets, no fix hint', () => {
  const b = formatAuthBlock(snap(), 'node-A');
  assert.match(b, /OAuth:.*valid/i);
  assert.match(b, /cookie:.*ok/i);
  assert.ok(!/claudeai_login/.test(b));
});
test('formatAuthBlock: dead cookie shows reason + claudeai_login hint', () => {
  const b = formatAuthBlock(snap({ cookie: { configured: true, ok: false, reason: 'session_expired' } }), 'node-A');
  assert.match(b, /session_expired/);
  assert.match(b, /claudeai_login/);
});
test('formatAuthBlock: absent oauth shows none', () => {
  const b = formatAuthBlock(snap({ oauth: { present: false, expired: false, refreshedThisCheck: false } }), 'node-A');
  assert.match(b, /OAuth:.*(none|—)/i);
});
```

- [ ] **Step 2: Run → RED** (`authSnapshotIsStale`/`formatAuthBlock` not exported).

- [ ] **Step 3: Implement** in `guide.ts`. Add the pure helpers (exported) + make `handleBootstrap` async/per-call:

```ts
import type { AuthSnapshot } from '../../monitor/auth-monitor';

export function authSnapshotIsStale(snap: AuthSnapshot | null, now: number, intervalMin: number): boolean {
  if (!snap || typeof snap.checkedAt !== 'number') return true;
  return (now - snap.checkedAt) > 2 * intervalMin * 60_000;
}

export function formatAuthBlock(snap: AuthSnapshot, nodeLabel: string): string {
  const o = snap.oauth;
  const oauthLine = !o.present ? 'OAuth: — none (no ~/.claude/.credentials.json)'
    : o.expired ? 'OAuth: ✗ EXPIRED — run Claude Code on this node, or claudeai_login(which="oauth")'
    : `OAuth: ✓ valid${typeof o.msUntilExpiry === 'number' ? ` (expires in ${Math.max(0, Math.round(o.msUntilExpiry / 3600_000))}h)` : ''}${o.refreshedThisCheck ? ', refreshed' : ''}`;
  const c = snap.cookie;
  const cookieLine = !c.configured ? 'claude.ai cookie: — not configured — claudeai_login(which="cookie")'
    : c.ok ? `claude.ai cookie: ✓ ok${c.identity ? ` (${c.identity})` : ''}`
    : `claude.ai cookie: ✗ ${c.reason} — claudeai_login(which="cookie")`;
  return [`## Auth status — ${nodeLabel}`, oauthLine, cookieLine, 'Fleet: auth_status(allNodes:true) · re-login: guide("login")'].join('\n');
}
```

Also add a NETWORK-FREE `lightAuthSnapshot()` to `auth-monitor.ts` (file inspection only — no probe, no refresh; for bootstrap's fast fallback):

```ts
export function lightAuthSnapshot(): AuthSnapshot {
  const d = defaultDeps();
  let oauth: AuthSnapshot['oauth'] = { present: false, expired: false, refreshedThisCheck: false };
  try { const o = d.oauthStatus(); oauth = { present: o.present, expired: o.expired, msUntilExpiry: o.msUntilExpiry, refreshedThisCheck: false, subscriptionType: o.subscriptionType, rateLimitTier: o.rateLimitTier }; } catch { /* degraded */ }
  let cookie: AuthSnapshot['cookie'] = { configured: false, ok: false, reason: 'unprobed' };
  try { const cs = d.cookieStatus(); cookie = { configured: !!cs.present, ok: !!cs.hasSessionKey, reason: cs.present ? 'unprobed' : 'session_not_configured', hasSessionKey: cs.hasSessionKey, hasCfClearance: cs.hasCfClearance, hasCfBm: cs.hasCfBm, identity: cs.identity }; } catch { /* degraded */ }
  return { checkedAt: Date.now(), oauth, cookie };
}
```

In `handleBootstrap` (change from returning the static `BOOTSTRAP` to per-call), append the auth block — read the snapshot; if stale/absent use the light (network-free) fallback. NEVER `buildAuthSnapshot` (network) inline:

```ts
async function authBlock(): Promise<string> {
  try {
    const { loadAuthSnapshot } = require('../../monitor/auth-store') as typeof import('../../monitor/auth-store');
    const { lightAuthSnapshot } = require('../../monitor/auth-monitor') as typeof import('../../monitor/auth-monitor');
    const { getProjectSettings } = require('../../project-settings') as typeof import('../../project-settings');
    const os = require('os') as typeof import('os');
    const intervalMin = getProjectSettings().authMonitorIntervalMin ?? 15;
    let snap = loadAuthSnapshot();
    if (authSnapshotIsStale(snap, Date.now(), intervalMin)) snap = lightAuthSnapshot(); // file-only, no network
    return '\n' + sep + '\n' + formatAuthBlock(snap!, os.hostname());
  } catch { return ''; }
}
// handleBootstrap: return ok(BOOTSTRAP + await authBlock());
```
(Reuse the existing `sep` constant; keep `BOOTSTRAP` static and only append the dynamic block. `formatAuthBlock` should treat `cookie.reason === 'unprobed'` as "configured (not live-checked) — auth_status to verify", not a hard failure.)

- [ ] **Step 4:** Run the test → GREEN; `./core.sh build` clean.

- [ ] **Step 5: Commit** — `feat(auth): bootstrap appends live per-node auth status (snapshot-backed, browser-free)`

---

### Task 4: `claudeai_login` MCP tool

**Files:**
- Create: `core/src/mcp-server/tools/claudeai-login.ts`
- Modify: `core/src/mcp-server/tools/expanded.ts` (import + 2 spreads), `core/src/mcp-server/configure.ts` (scope)
- Test: `core/src/__tests__/claudeai-login.test.ts`

**Interfaces:** Produces `CLAUDEAI_LOGIN_TOOL_DEFS`, `CLAUDEAI_LOGIN_HANDLERS`, and a pure `decideCookieAction({ healthy, browserRequested, hasDesktopBrowser })` → `'already-ok' | 'launch' | 'manual'`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/claudeai-login.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { decideCookieAction } from '../mcp-server/tools/claudeai-login';

test('cookie already healthy → already-ok (no browser)', () => {
  assert.strictEqual(decideCookieAction({ healthy: true, browserRequested: false, hasDesktopBrowser: true }), 'already-ok');
});
test('unhealthy + browser requested + desktop browser → launch', () => {
  assert.strictEqual(decideCookieAction({ healthy: false, browserRequested: true, hasDesktopBrowser: true }), 'launch');
});
test('unhealthy + desktop browser, no explicit request → launch (auto)', () => {
  assert.strictEqual(decideCookieAction({ healthy: false, browserRequested: false, hasDesktopBrowser: true }), 'launch');
});
test('unhealthy + NO desktop browser → manual', () => {
  assert.strictEqual(decideCookieAction({ healthy: false, browserRequested: false, hasDesktopBrowser: false }), 'manual');
});
test('unhealthy + browser requested but NO desktop browser → manual (cannot launch)', () => {
  assert.strictEqual(decideCookieAction({ healthy: false, browserRequested: true, hasDesktopBrowser: false }), 'manual');
});
```

- [ ] **Step 2: Run → RED.**

- [ ] **Step 3: Implement** `core/src/mcp-server/tools/claudeai-login.ts` (model on `browser-task.ts`; uses `workerGet`/`workerPost` from `./_passthrough`):

```ts
import { ok, err, workerGet, workerPost, type McpToolResult } from './_passthrough';

export function decideCookieAction(i: { healthy: boolean; browserRequested: boolean; hasDesktopBrowser: boolean }): 'already-ok' | 'launch' | 'manual' {
  if (i.healthy) return 'already-ok';
  if (i.hasDesktopBrowser) return 'launch';
  return 'manual';
}

const MANUAL_COOKIE = [
  'Manual cookie capture (no desktop browser on this node):',
  '1. In a browser logged into claude.ai, open DevTools → Network → any /api/... request → Copy → Copy as cURL.',
  '2. Grab the `Cookie:` header value (must include the sk-ant-sid… sessionKey).',
  '3. Write ~/.claude/claudeai-session.json per docs/claude-ai-routes.md (cookie capture workflow).',
  'Then re-run auth_status. (The cookie is IP-pinned to the host that captured it.)',
].join('\n');

export const claudeaiLoginToolDef = {
  name: 'claudeai_login',
  description: 'Guided re-login for a node\'s credentials — the claude.ai WEB cookie and/or the Claude Code OAuth token (which="cookie"|"oauth"|"all", default all). For the cookie on a node with a desktop browser it launches Chrome for YOU to log in (it never enters credentials) and captures the session; headless → returns exact manual steps. For OAuth it reports/uses the refresh-token path and otherwise tells you to run Claude Code to re-login. Targets a node (cookie is IP-pinned). Returns the resulting auth status.',
  inputSchema: { type: 'object' as const, properties: {
    which: { type: 'string', enum: ['cookie', 'oauth', 'all'], description: 'Credential to fix (default all).' },
    node: { type: 'string', description: 'Target node (hostId/hostname from list_nodes); omit for default.' },
    browser: { type: 'boolean', description: 'Force the browser-capture path for the cookie (default: auto when a desktop browser exists).' },
  } },
};

async function handleClaudeaiLogin(args: Record<string, unknown>): Promise<McpToolResult> {
  const which = ['cookie', 'oauth', 'all'].includes(String(args.which)) ? String(args.which) : 'all';
  const browserRequested = args.browser === true || args.browser === 'true';
  const out: string[] = [];
  try {
    if (which === 'oauth' || which === 'all') {
      const o = await workerGet<{ present?: boolean; expired?: boolean }>('/claude-code/oauth-status').catch(() => ({}));
      if (!o || !o.present) out.push('OAuth: not present — run Claude Code on this node to log in (OAuth login is interactive).');
      else if (o.expired) out.push('OAuth: expired — it auto-refreshes via the refresh token on next use / auth-monitor; if it stays expired, run Claude Code to re-login.');
      else out.push('OAuth: valid.');
    }
    if (which === 'cookie' || which === 'all') {
      const h = await workerGet<{ ok?: boolean; reason?: string }>('/claude-ai/healthz').catch(() => ({}));
      const healthy = !!(h && h.ok);
      // hasDesktopBrowser: best-effort — the launch route itself reports if no browser; treat a non-Windows headless server as no-browser unless browser:true forces a try.
      const action = decideCookieAction({ healthy, browserRequested, hasDesktopBrowser: browserRequested });
      if (action === 'already-ok') out.push('claude.ai cookie: already valid.');
      else if (action === 'launch') {
        const r = await workerPost<{ ok?: boolean; capture?: { cookieCount?: number }; code?: string; message?: string }>('/claude-ai/browser/launch-and-capture', { loginTimeoutMs: 300000 }).catch((e: any) => ({ ok: false, message: String(e?.message || e) }));
        out.push(r && r.ok ? `claude.ai cookie: captured (${r.capture?.cookieCount ?? '?'} cookies) — log-in completed.` : `claude.ai cookie: browser capture did not complete (${(r as any)?.code || (r as any)?.message || 'unknown'}). ${MANUAL_COOKIE}`);
      } else out.push('claude.ai cookie: ' + (healthy ? 'valid.' : 'needs re-login.\n' + MANUAL_COOKIE));
    }
    // re-report
    const post = await workerGet<{ ok?: boolean; reason?: string }>('/claude-ai/healthz').catch(() => ({}));
    out.push(`\nNow: claude.ai cookie ${post && post.ok ? 'OK' : 'NOT usable' + (post && post.reason ? ` (${post.reason})` : '')}. (auth_status for full detail.)`);
    return ok(out.join('\n'));
  } catch (e) { return err((e as Error).message); }
}

export const CLAUDEAI_LOGIN_TOOL_DEFS = [claudeaiLoginToolDef];
export const CLAUDEAI_LOGIN_HANDLERS: Record<string, (a: Record<string, unknown>) => Promise<McpToolResult>> = { claudeai_login: handleClaudeaiLogin };
```

(Confirm the exact `_passthrough` exports — `ok/err/workerGet/workerPost/McpToolResult` — against `auth-status.ts`/`browser-task.ts` imports and match them.)

Register in `expanded.ts`: `import { CLAUDEAI_LOGIN_TOOL_DEFS, CLAUDEAI_LOGIN_HANDLERS } from './claudeai-login';` + `...CLAUDEAI_LOGIN_TOOL_DEFS,` in `EXPANDED_TOOL_DEFS` + `...CLAUDEAI_LOGIN_HANDLERS,` in `EXPANDED_HANDLERS`. Add `claudeai_login: 'admin',` to `TOOL_SCOPES` in `configure.ts`.

- [ ] **Step 4:** Run the decision test → GREEN; `./core.sh build` clean (confirms registration + `assertScopesCoverTools()` passes).

- [ ] **Step 5: Commit** — `feat(auth): claudeai_login MCP tool (cookie browser-capture/manual + OAuth) + scope`

---

### Task 5: `auth_status(allNodes)` + `guide("login")` + version/docs/integration

**Files:**
- Modify: `core/src/mcp-server/tools/auth-status.ts` (allNodes), `core/src/mcp-server/tools/guide.ts` (login topic + alias + blurb)
- Modify: `CHANGELOG.md`, `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Test: `core/src/__tests__/auth-status-allnodes.test.ts`

- [ ] **Step 1: Write the failing test** — exercise the pure aggregation. Add an exported `formatAllNodes(rows)` to `auth-status.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { formatAllNodes } from '../mcp-server/tools/auth-status';

test('formatAllNodes: one line per node with both creds', () => {
  const s = formatAllNodes([
    { node: 'A', oauth: 'valid', cookie: 'ok' },
    { node: 'B', oauth: 'EXPIRED', cookie: 'session_expired' },
  ]);
  assert.match(s, /A/); assert.match(s, /B/);
  assert.match(s, /EXPIRED/); assert.match(s, /session_expired/);
});
test('formatAllNodes: empty → a clear message', () => {
  assert.match(formatAllNodes([]), /no nodes|none/i);
});
```

- [ ] **Step 2: Run → RED.**

- [ ] **Step 3a:** `auth-status.ts` — add `allNodes` to the input schema, the pure `formatAllNodes(rows: Array<{node:string;oauth:string;cookie:string}>): string`, and an `allNodes` branch in `handleAuthStatus` that calls `workerGet('/list-nodes' or the nodes API)` then per node `workerGet(healthz/oauth-status, { node })` best-effort, builds rows, returns `formatAllNodes`. (Use the same node-list source `list_nodes` uses; per-node calls are best-effort — a failed node → `oauth:'?', cookie:'?'`.)

- [ ] **Step 3b:** `guide.ts` — add `GUIDES.login`:

```
login: `# Guide: log in / re-login for a node (cookie + OAuth)
Two credentials per host (see auth_status): the claude.ai WEB cookie and the Claude Code OAuth token.
• Status: \`auth_status\` (this node) · \`auth_status(allNodes:true)\` (fleet) · bootstrap shows the local node.
• Fix either: \`claudeai_login(which="cookie"|"oauth"|"all", node=…)\`.
  - cookie: on a node WITH a desktop browser it opens Chrome for YOU to log in, then captures the session (it never types your password); headless → it returns the exact manual steps (DevTools → copy Cookie header → ~/.claude/claudeai-session.json). The cookie is IP-PINNED to the host that captured it.
  - oauth: auto-refreshes via the refresh token (auth-monitor / on use); if it stays expired, run Claude Code on that host to re-login (interactive).
• The auth-monitor job keeps OAuth fresh + the cookie status current automatically (browser-free); it can't mint a dead cookie — that needs your login.
• Connector down but cookie valid? reconnect the claude.ai MCP connector (see the connector-reconnect recipe).`
```
Add `'login'` to the `order` array in `buildBootstrap`, a `BLURB.login`, and aliases `login/relogin/'re-login'/signin/'sign-in' → 'login'`.

- [ ] **Step 3c:** Version bump `0.1.105 → 0.1.106` in all three files; CHANGELOG entry under `## [0.1.106]`:
```
### Added
- Auth monitor: a browser-free periodic job refreshes the Claude Code OAuth token and tracks claude.ai cookie health into a per-node snapshot (`~/.lm-assist/auth-status.json`); `authMonitorEnabled`/`authMonitorIntervalMin` settings.
- bootstrap now reports the local node's auth status; `auth_status(allNodes:true)` sweeps the fleet.
- `claudeai_login` MCP tool + `guide("login")` — guided cookie (browser-capture/manual) + OAuth re-login, per node.
```

- [ ] **Step 4:** Run the allNodes test → GREEN; `./core.sh build` clean; run the full new suite (`auth-snapshot`, `auth-monitor-settings`, `bootstrap-auth`, `claudeai-login`, `auth-status-allnodes`).

- [ ] **Step 5: Commit** — `feat(auth): auth_status allNodes + guide(login) + 0.1.106`

---

## Notes for the executor

- After every task `./core.sh build` must be clean. The new modules use `require()` of existing files (no ESM-only deps).
- The periodic job MUST stay browser-free (Global Constraints) — only `claudeai_login` may hit `/claude-ai/browser/*`.
- No secrets in the snapshot/outputs — the Task-1 test enforces this; keep it true in Tasks 3–5 formatting.
- Live integration (Task 5, this fleet) + deploy follow the live-rc procedure (npm pack Node 20 → direct `npm install -g <tgz>`; 123=systemd; 107=Windows static-copy + scheduled task) — out of scope for the task commits.
