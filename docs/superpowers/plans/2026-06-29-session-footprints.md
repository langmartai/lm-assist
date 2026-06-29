# session_footprints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cross-fleet, server-composed `session_footprints` MCP tool + `GET /fleet/session-footprints` REST endpoint that returns every recent session and what it occupies (node/repo/branch/worktree/open-changes/ports), which the Mission Controller consults (advisory) before placing a worker.

**Architecture:** A per-node collector builds an in-memory `NodeFootprint` snapshot in a background refresher (all git/port subprocesses run off the request path); the REST/MCP handlers only ever read that snapshot synchronously. A composed endpoint fans out over the hub relay to peers' already-warm `/local` snapshots and merges. The controller's pass directive is extended to call the tool and defer on conflict.

**Tech Stack:** TypeScript (CommonJS, `module: commonjs`), Node's built-in test runner (`node --test`, tests compiled to `dist-test/`), `node:child_process.execFile` (promisified), the existing route system (`RouteHandler`/`wrapResponse`) and hub relay (`proxyGet`/`listOnlineNodeIds`).

## Global Constraints

- **Never block the `:3100` event loop or the request path.** All subprocesses use promisified `execFile` (never any `*Sync`). The REST/MCP handler MUST NOT `await` a git/ss subprocess — it reads the in-memory snapshot and returns synchronously; refresh is always background + single-flight.
- **Git is read-only.** Every git command runs with `GIT_OPTIONAL_LOCKS=0` in env AND `--no-optional-locks` as the first arg, so the survey never takes/refreshes the index lock.
- **Per-command timeout ~2000 ms; per-peer relay timeout ~2500 ms.** A timed-out/failed command yields empty fields; the snapshot still publishes (best-effort, never throws).
- **openChanges** = uncommitted ∪ untracked ∪ committed-but-unpushed file paths, deduped, capped at 20 (set `openChangesTruncated` when more).
- **Listening ports only** (port + proto + pid + proc); no docker/db/k8s.
- **Advisory only** — do NOT modify `mission/mission-model.ts` `place()` or the scheduler.
- **Default scope = `cluster`** (the controller's placement boundary); `fleet` is opt-in.
- Tests live at `core/src/__tests__/fleet/*.test.ts` so `npm test`'s glob (`dist-test/__tests__/**/*.test.js`) discovers them. Use `import { test } from 'node:test'; import { strict as assert } from 'node:assert';`.
- Run one test file: `cd core && npm run build:test && node --test dist-test/__tests__/fleet/<name>.test.js`.
- TOOL_SCOPES: every advertised MCP tool MUST have a scope in `core/src/mcp-server/configure.ts` or Core crashes on the next `/mcp` call (`assertScopesCoverTools`).

## File Structure

- Create `core/src/fleet/footprint-types.ts` — shared interfaces.
- Create `core/src/fleet/run-cmd.ts` — `runCmd` (promisified execFile) + `RunCmd` type.
- Create `core/src/fleet/git-survey.ts` — pure git parsers + `collectGitState`.
- Create `core/src/fleet/port-survey.ts` — pure port parsers + `collectPorts`.
- Create `core/src/fleet/session-footprint-collector.ts` — `buildSnapshot` + `createLocalFootprintCache` (background refresher, never-await `get()`) + a module singleton `getLocalSnapshot`.
- Create `core/src/fleet/footprint-compose.ts` — `mergeComposed` (pure) + `getComposed` (fan-out + cache).
- Create `core/src/routes/core/fleet.routes.ts` — `createFleetRoutes`.
- Modify `core/src/routes/core/index.ts` — register `createFleetRoutes`.
- Modify `core/src/hub-client/api-relay-handler.ts` — add `'/fleet'` to the allow-list.
- Create `core/src/mcp-server/tools/session-footprints.ts` — `handleSessionFootprints` + `sessionFootprintsToolDef`.
- Modify `core/src/mcp-server/tools/expanded.ts` — add the def to `EXPANDED_TOOL_DEFS`.
- Modify `core/src/mcp-server/configure.ts` — `session_footprints: 'read'`.
- Modify `core/src/mcp-server/index.ts` — stdio dispatch case.
- Modify `core/src/routes/core/mcp.routes.ts` — connector dispatch case.
- Modify `core/src/mission/mission-controller.ts` — extend `CONTROLLER_PASS_DIRECTIVE` + `CONTROLLER_SYSTEM_PROMPT`.

Tests: `core/src/__tests__/fleet/{git-survey,port-survey,collector,compose,wiring}.test.ts`.

---

### Task 1: Types + runCmd + git survey

**Files:**
- Create: `core/src/fleet/footprint-types.ts`, `core/src/fleet/run-cmd.ts`, `core/src/fleet/git-survey.ts`
- Test: `core/src/__tests__/fleet/git-survey.test.ts`

**Interfaces:**
- Produces:
  - `GitState`, `SessionFootprint`, `PortHold`, `NodeFootprint`, `ComposedFootprints` (footprint-types.ts).
  - `type RunCmd = (cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; env?: Record<string,string> }) => Promise<{ stdout: string; code: number }>` (run-cmd.ts) + `runCmd: RunCmd`.
  - `parseStatusV2(stdout: string): { branch: string | null; upstream: string | null; ahead: number; files: string[] }`
  - `collectGitState(dir: string, run: RunCmd): Promise<{ git: GitState; openChanges: string[]; openChangesTruncated: boolean; repo: string | null }>`

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/fleet/git-survey.test.ts`

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseStatusV2, collectGitState } from '../../fleet/git-survey';
import type { RunCmd } from '../../fleet/run-cmd';

test('parseStatusV2 — branch, upstream, ahead, and changed/untracked/renamed paths', () => {
  const stdout = [
    '# branch.head feature-x',
    '# branch.upstream origin/feature-x',
    '# branch.ab +2 -0',
    '1 .M N... 100644 100644 100644 aaa bbb src/a.ts',
    '2 R. N... 100644 100644 100644 ccc ddd R100 src/new.ts\tsrc/old.ts',
    '? untracked.txt',
    'u UU N... 100644 100644 100644 100644 eee fff ggg src/conflict.ts',
  ].join('\n');
  const r = parseStatusV2(stdout);
  assert.equal(r.branch, 'feature-x');
  assert.equal(r.upstream, 'origin/feature-x');
  assert.equal(r.ahead, 2);
  assert.deepEqual(r.files.sort(), ['src/a.ts', 'src/conflict.ts', 'src/new.ts', 'untracked.txt'].sort());
});

test('parseStatusV2 — no upstream → upstream null, ahead 0', () => {
  const r = parseStatusV2('# branch.head mission/123\n? a.txt\n');
  assert.equal(r.branch, 'mission/123');
  assert.equal(r.upstream, null);
  assert.equal(r.ahead, 0);
  assert.deepEqual(r.files, ['a.txt']);
});

test('collectGitState — pushed branch with upstream: status + show-toplevel + diff', async () => {
  const calls: string[][] = [];
  const run: RunCmd = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.includes('status')) return { stdout: '# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -0\n1 .M N... 0 0 0 a b dirty.ts\n', code: 0 };
    if (args.includes('rev-parse') && args.includes('--show-toplevel')) return { stdout: '/repo\n', code: 0 };
    if (args.includes('diff')) return { stdout: 'committed-unpushed.ts\n', code: 0 };
    return { stdout: '', code: 0 };
  };
  const r = await collectGitState('/repo/sub', run);
  assert.equal(r.git.branch, 'main');
  assert.equal(r.git.upstream, 'origin/main');
  assert.equal(r.git.ahead, 1);
  assert.equal(r.git.dirty, 1);
  assert.equal(r.git.pushed, true);
  assert.equal(r.git.worktree, '/repo');
  assert.deepEqual(r.openChanges.sort(), ['committed-unpushed.ts', 'dirty.ts'].sort());
  // read-only guard present on every git call
  for (const c of calls) assert.ok(c.includes('--no-optional-locks'), `missing --no-optional-locks in ${c.join(' ')}`);
});

test('collectGitState — non-git dir (status exits non-zero) → nulls, no throw', async () => {
  const run: RunCmd = async () => ({ stdout: '', code: 128 });
  const r = await collectGitState('/tmp/not-a-repo', run);
  assert.equal(r.git.branch, null);
  assert.equal(r.repo, null);
  assert.deepEqual(r.openChanges, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/fleet/git-survey.test.js`
Expected: FAIL — `Cannot find module '../../fleet/git-survey'`.

- [ ] **Step 3: Write `core/src/fleet/footprint-types.ts`**

```ts
export interface GitState {
  branch: string | null;
  worktree: string | null;
  upstream: string | null;
  ahead: number;
  dirty: number;
  pushed: boolean;
}

export interface SessionFootprint {
  cluster: string;
  node: string;
  host: string;
  sessionId: string;
  title?: string;
  transport: 'native' | 'cloud';
  managed: string | null;       // missionId if bound, else null
  cwd: string;
  repo: string | null;
  git: GitState;
  openChanges: string[];
  openChangesTruncated: boolean;
  lastActiveRel: string;
  isActive: boolean;
}

export interface PortHold {
  port: number;
  proto: 'tcp' | 'udp';
  pid: number | null;
  proc: string | null;
}

export interface NodeFootprint {
  node: string;
  cluster: string;
  host: string;
  snapshotAgeSec: number;
  reachable: boolean;
  warming: boolean;
  stale: boolean;
  sessions: SessionFootprint[];
  ports: PortHold[];
}

export interface ComposedFootprints {
  generatedAt: number;
  scope: 'cluster' | 'fleet';
  nodes: NodeFootprint[];
  unreachable: string[];
  partial: boolean;
}
```

- [ ] **Step 4: Write `core/src/fleet/run-cmd.ts`**

```ts
import { execFile } from 'child_process';

export type RunCmd = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; env?: Record<string, string> },
) => Promise<{ stdout: string; code: number }>;

/** Promisified execFile that never rejects on a non-zero exit — returns { stdout, code }.
 *  killSignal+timeout bound a hung command; maxBuffer caps runaway output. */
export const runCmd: RunCmd = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, env: { ...process.env, ...(opts.env || {}) }, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        const code = err && typeof (err as NodeJS.ErrnoException).code === 'number' ? (err as any).code : err ? 1 : 0;
        resolve({ stdout: stdout?.toString() ?? '', code });
      },
    );
  });
```

- [ ] **Step 5: Write `core/src/fleet/git-survey.ts`**

```ts
import type { GitState } from './footprint-types';
import type { RunCmd } from './run-cmd';

const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' };
const RO = '--no-optional-locks';
const TIMEOUT = 2000;
const CAP = 20;

export function parseStatusV2(stdout: string): { branch: string | null; upstream: string | null; ahead: number; files: string[] } {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  const files: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const v = line.slice('# branch.head '.length).trim();
      branch = v === '(detached)' ? null : v;
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim() || null;
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-\d+/);
      if (m) ahead = parseInt(m[1], 10);
    } else if (line.startsWith('1 ')) {
      files.push(line.split(' ').slice(8).join(' '));
    } else if (line.startsWith('2 ')) {
      files.push(line.split(' ').slice(9).join(' ').split('\t')[0]);
    } else if (line.startsWith('? ')) {
      files.push(line.slice(2));
    } else if (line.startsWith('u ')) {
      files.push(line.split(' ').slice(10).join(' '));
    }
  }
  return { branch, upstream, ahead, files: files.filter(Boolean) };
}

export async function collectGitState(
  dir: string,
  run: RunCmd,
): Promise<{ git: GitState; openChanges: string[]; openChangesTruncated: boolean; repo: string | null }> {
  const opts = { cwd: dir, timeoutMs: TIMEOUT, env: GIT_ENV };
  const status = await run('git', ['-C', dir, RO, 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'], opts);
  if (status.code !== 0) {
    return {
      git: { branch: null, worktree: null, upstream: null, ahead: 0, dirty: 0, pushed: false },
      openChanges: [], openChangesTruncated: false, repo: null,
    };
  }
  const s = parseStatusV2(status.stdout);
  const top = await run('git', ['-C', dir, RO, 'rev-parse', '--show-toplevel'], opts);
  const worktree = top.code === 0 ? top.stdout.trim() || null : null;

  const uncommitted = s.files;
  let unpushed: string[] = [];
  let pushed = true;
  if (s.upstream && s.ahead > 0) {
    const d = await run('git', ['-C', dir, RO, 'diff', '--name-only', `${s.upstream}..HEAD`], opts);
    if (d.code === 0) unpushed = d.stdout.split('\n').filter(Boolean);
  } else if (!s.upstream) {
    pushed = false; // branch's work is not on a remote at all
    const base = await run('git', ['-C', dir, RO, 'rev-parse', '--abbrev-ref', 'origin/HEAD'], opts);
    const baseRef = base.code === 0 && base.stdout.trim() ? base.stdout.trim() : null;
    if (baseRef) {
      const d = await run('git', ['-C', dir, RO, 'diff', '--name-only', `${baseRef}...HEAD`], opts);
      if (d.code === 0) unpushed = d.stdout.split('\n').filter(Boolean);
    }
  }

  const union = Array.from(new Set([...uncommitted, ...unpushed]));
  const openChanges = union.slice(0, CAP);
  return {
    git: { branch: s.branch, worktree, upstream: s.upstream, ahead: s.ahead, dirty: uncommitted.length, pushed },
    openChanges,
    openChangesTruncated: union.length > CAP,
    repo: worktree,
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/fleet/git-survey.test.js`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add core/src/fleet/footprint-types.ts core/src/fleet/run-cmd.ts core/src/fleet/git-survey.ts core/src/__tests__/fleet/git-survey.test.ts
git commit -m "feat(fleet): footprint types + read-only git survey collector"
```

---

### Task 2: Port survey

**Files:**
- Create: `core/src/fleet/port-survey.ts`
- Test: `core/src/__tests__/fleet/port-survey.test.ts`

**Interfaces:**
- Consumes: `RunCmd` (Task 1), `PortHold` (Task 1).
- Produces:
  - `parseSs(stdout: string): PortHold[]`
  - `parseWinPorts(stdout: string): PortHold[]`
  - `collectPorts(run: RunCmd, platform: NodeJS.Platform): Promise<PortHold[]>`

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/fleet/port-survey.test.ts`

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseSs, parseWinPorts, collectPorts } from '../../fleet/port-survey';
import type { RunCmd } from '../../fleet/run-cmd';

test('parseSs — extracts port, pid, proc from ss -H -tlnp lines', () => {
  const stdout = [
    'LISTEN 0 511 0.0.0.0:3100 0.0.0.0:* users:(("node",pid=1234,fd=18))',
    'LISTEN 0 4096 [::]:5432 [::]:* users:(("postgres",pid=99,fd=7))',
    'LISTEN 0 128 127.0.0.1:6379 0.0.0.0:*',
  ].join('\n');
  const r = parseSs(stdout);
  assert.deepEqual(r, [
    { port: 3100, proto: 'tcp', pid: 1234, proc: 'node' },
    { port: 5432, proto: 'tcp', pid: 99, proc: 'postgres' },
    { port: 6379, proto: 'tcp', pid: null, proc: null },
  ]);
});

test('parseWinPorts — "port,pid" CSV lines (header skipped)', () => {
  const stdout = '"LocalPort","OwningProcess"\n"3848","4021"\n"3100","777"\n';
  assert.deepEqual(parseWinPorts(stdout), [
    { port: 3848, proto: 'tcp', pid: 4021, proc: null },
    { port: 3100, proto: 'tcp', pid: 777, proc: null },
  ]);
});

test('collectPorts — POSIX uses ss; failure → []', async () => {
  const run: RunCmd = async (cmd) => (cmd === 'ss' ? { stdout: 'LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("x",pid=5,fd=1))', code: 0 } : { stdout: '', code: 1 });
  assert.deepEqual(await collectPorts(run, 'linux'), [{ port: 8080, proto: 'tcp', pid: 5, proc: 'x' }]);
  const bad: RunCmd = async () => ({ stdout: '', code: 1 });
  assert.deepEqual(await collectPorts(bad, 'linux'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/fleet/port-survey.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `core/src/fleet/port-survey.ts`**

```ts
import type { PortHold } from './footprint-types';
import type { RunCmd } from './run-cmd';

const TIMEOUT = 2000;

export function parseSs(stdout: string): PortHold[] {
  const out: PortHold[] = [];
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[3]; // State Recv-Q Send-Q Local …
    const portStr = local.slice(local.lastIndexOf(':') + 1);
    const port = parseInt(portStr, 10);
    if (!Number.isFinite(port)) continue;
    const procMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    out.push({ port, proto: 'tcp', pid: procMatch ? parseInt(procMatch[2], 10) : null, proc: procMatch ? procMatch[1] : null });
  }
  return out;
}

export function parseWinPorts(stdout: string): PortHold[] {
  const out: PortHold[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/"?(\d+)"?\s*,\s*"?(\d+)"?/);
    if (!m) continue; // skips the header row
    out.push({ port: parseInt(m[1], 10), proto: 'tcp', pid: parseInt(m[2], 10), proc: null });
  }
  return out;
}

export async function collectPorts(run: RunCmd, platform: NodeJS.Platform): Promise<PortHold[]> {
  try {
    if (platform === 'win32') {
      const r = await run('powershell', ['-NoProfile', '-Command',
        'Get-NetTCPConnection -State Listen | Select-Object LocalPort,OwningProcess | ConvertTo-Csv -NoTypeInformation'],
        { timeoutMs: TIMEOUT });
      return r.code === 0 ? parseWinPorts(r.stdout) : [];
    }
    const r = await run('ss', ['-H', '-tlnp'], { timeoutMs: TIMEOUT });
    return r.code === 0 ? parseSs(r.stdout) : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/fleet/port-survey.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/fleet/port-survey.ts core/src/__tests__/fleet/port-survey.test.ts
git commit -m "feat(fleet): listening-port survey collector (ss / Get-NetTCPConnection)"
```

---

### Task 3: Local collector — assembly + background refresher (never-await)

**Files:**
- Create: `core/src/fleet/session-footprint-collector.ts`
- Test: `core/src/__tests__/fleet/collector.test.ts`

**Interfaces:**
- Consumes: `collectGitState` (Task 1), `collectPorts` (Task 2), `NodeFootprint`/`SessionFootprint` (Task 1).
- Produces:
  - `interface BuildDeps { sessions: () => Array<{ sessionId: string; cacheData: { cwd?: string; fileMtime?: number; isActive?: boolean; title?: string } }>; bound: () => Promise<Map<string, string>>; identity: () => { node: string; host: string; cluster: string }; gitFor: (cwd: string) => Promise<Awaited<ReturnType<typeof import('./git-survey').collectGitState>>>; ports: () => Promise<import('./footprint-types').PortHold[]>; now: () => number }`
  - `buildSnapshot(deps: BuildDeps): Promise<NodeFootprint>`
  - `createLocalFootprintCache(build: () => Promise<NodeFootprint>, identity: () => {node:string;host:string;cluster:string}, opts?: { ttlMs?: number; warmMs?: number; now?: () => number }): { get(): NodeFootprint; kickRefresh(): void; dispose(): void }`
  - `getLocalSnapshot(): NodeFootprint` (module singleton used by routes/MCP)

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/fleet/collector.test.ts`

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildSnapshot, createLocalFootprintCache } from '../../fleet/session-footprint-collector';
import type { NodeFootprint } from '../../fleet/footprint-types';

const IDENT = () => ({ node: 'gw-1', host: 'h1', cluster: 'prod' });
const GIT_OK = async () => ({ git: { branch: 'main', worktree: '/r', upstream: 'origin/main', ahead: 0, dirty: 1, pushed: true }, openChanges: ['a.ts'], openChangesTruncated: false, repo: '/r' });

test('buildSnapshot — assembles sessions, tags managed, attaches git + ports', async () => {
  const snap = await buildSnapshot({
    sessions: () => [
      { sessionId: 'sess-A', cacheData: { cwd: '/r', fileMtime: 1000, isActive: true, title: 'A' } },
      { sessionId: 'session_cloud1', cacheData: { cwd: '/r', fileMtime: 900 } },
    ],
    bound: async () => new Map([['sess-A', 'mission-7']]),
    identity: IDENT,
    gitFor: GIT_OK,
    ports: async () => [{ port: 5432, proto: 'tcp', pid: 9, proc: 'postgres' }],
    now: () => 2000,
  });
  assert.equal(snap.node, 'gw-1');
  assert.equal(snap.warming, false);
  assert.equal(snap.sessions.length, 2);
  const a = snap.sessions.find((s) => s.sessionId === 'sess-A')!;
  assert.equal(a.managed, 'mission-7');
  assert.equal(a.transport, 'native');
  assert.deepEqual(a.openChanges, ['a.ts']);
  const c = snap.sessions.find((s) => s.sessionId === 'session_cloud1')!;
  assert.equal(c.managed, null);
  assert.equal(c.transport, 'cloud');
  assert.deepEqual(snap.ports, [{ port: 5432, proto: 'tcp', pid: 9, proc: 'postgres' }]);
});

test('createLocalFootprintCache.get() — NEVER awaits the collector: returns warming synchronously while build hangs', () => {
  let resolveBuild!: (s: NodeFootprint) => void;
  const build = () => new Promise<NodeFootprint>((res) => { resolveBuild = res; }); // never settles during the test
  const cache = createLocalFootprintCache(build, IDENT, { now: () => 0 });
  const first = cache.get(); // must return synchronously, no await
  assert.equal(first.warming, true);
  assert.equal(first.sessions.length, 0);
  cache.dispose();
});

test('createLocalFootprintCache — single-flight: concurrent get()s trigger ONE build; serves cache once ready', async () => {
  let builds = 0;
  const build = async (): Promise<NodeFootprint> => { builds++; return { node: 'gw-1', host: 'h1', cluster: 'prod', snapshotAgeSec: 0, reachable: true, warming: false, stale: false, sessions: [], ports: [] }; };
  let clock = 0;
  const cache = createLocalFootprintCache(build, IDENT, { now: () => clock, ttlMs: 10_000 });
  cache.get(); cache.get(); cache.get();             // cold → one kick
  await new Promise((r) => setTimeout(r, 0));          // let the build microtask settle
  const warm = cache.get();
  assert.equal(warm.warming, false);
  assert.equal(builds, 1, 'single-flight should have built once');
  clock = 20_000;                                      // now stale
  cache.get();                                         // stale → kicks a refresh
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(builds, 2, 'stale read should trigger exactly one more build');
  cache.dispose();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/fleet/collector.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `core/src/fleet/session-footprint-collector.ts`**

```ts
import type { NodeFootprint, SessionFootprint, PortHold } from './footprint-types';
import { collectGitState } from './git-survey';
import { collectPorts } from './port-survey';
import { runCmd } from './run-cmd';

const RECENT_MS = 30 * 60 * 1000;
const CAP_SESSIONS = 15;
const GIT_PARALLEL = 4;

function relAge(ms: number, now: number): string {
  const age = now - ms;
  if (age < 60_000) return 'just now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return `${Math.floor(age / 86_400_000)}d ago`;
}

export interface BuildDeps {
  sessions: () => Array<{ sessionId: string; cacheData: { cwd?: string; fileMtime?: number; isActive?: boolean; title?: string } }>;
  bound: () => Promise<Map<string, string>>;                 // sessionId/cse/sid → missionId
  identity: () => { node: string; host: string; cluster: string };
  gitFor: (cwd: string) => Promise<Awaited<ReturnType<typeof collectGitState>>>;
  ports: () => Promise<PortHold[]>;
  now: () => number;
}

export async function buildSnapshot(deps: BuildDeps): Promise<NodeFootprint> {
  const id = deps.identity();
  const now = deps.now();
  const recent = deps.sessions()
    .filter((s) => s.cacheData?.isActive || (s.cacheData?.fileMtime ?? 0) >= now - RECENT_MS)
    .sort((a, b) => (b.cacheData?.fileMtime ?? 0) - (a.cacheData?.fileMtime ?? 0))
    .slice(0, CAP_SESSIONS);

  const [boundMap, ports] = await Promise.all([deps.bound().catch(() => new Map<string, string>()), deps.ports().catch(() => [] as PortHold[])]);

  // Dedupe git scans by cwd, bounded parallelism.
  const cwds = Array.from(new Set(recent.map((s) => s.cacheData?.cwd).filter((c): c is string => !!c)));
  const gitByCwd = new Map<string, Awaited<ReturnType<typeof collectGitState>>>();
  for (let i = 0; i < cwds.length; i += GIT_PARALLEL) {
    const batch = cwds.slice(i, i + GIT_PARALLEL);
    const res = await Promise.all(batch.map((c) => deps.gitFor(c).catch(() => null)));
    batch.forEach((c, j) => { if (res[j]) gitByCwd.set(c, res[j]!); });
  }

  const sessions: SessionFootprint[] = recent.map((s) => {
    const cwd = s.cacheData?.cwd ?? '';
    const g = (cwd && gitByCwd.get(cwd)) || { git: { branch: null, worktree: null, upstream: null, ahead: 0, dirty: 0, pushed: false }, openChanges: [], openChangesTruncated: false, repo: null };
    const cloud = /^(session_|cse_)/.test(s.sessionId);
    return {
      cluster: id.cluster, node: id.node, host: id.host,
      sessionId: s.sessionId, title: s.cacheData?.title,
      transport: cloud ? 'cloud' : 'native',
      managed: boundMap.get(s.sessionId) ?? null,
      cwd, repo: g.repo, git: g.git,
      openChanges: g.openChanges, openChangesTruncated: g.openChangesTruncated,
      lastActiveRel: relAge(s.cacheData?.fileMtime ?? now, now), isActive: !!s.cacheData?.isActive,
    };
  });

  return { node: id.node, cluster: id.cluster, host: id.host, snapshotAgeSec: 0, reachable: true, warming: false, stale: false, sessions, ports };
}

export function createLocalFootprintCache(
  build: () => Promise<NodeFootprint>,
  identity: () => { node: string; host: string; cluster: string },
  opts: { ttlMs?: number; warmMs?: number; now?: () => number } = {},
) {
  const ttlMs = opts.ttlMs ?? 10_000;
  const warmMs = opts.warmMs ?? 120_000;
  const now = opts.now ?? Date.now;
  let snapshot: NodeFootprint | null = null;
  let snapshotAt = 0;
  let inFlight: Promise<void> | null = null;
  let lastAccess = 0;
  let timer: NodeJS.Timeout | null = null;

  function kickRefresh(): void {
    if (inFlight) return; // single-flight
    inFlight = build()
      .then((s) => { snapshot = s; snapshotAt = now(); })
      .catch(() => { /* best-effort; keep last snapshot */ })
      .finally(() => { inFlight = null; });
  }

  function ensureWarm(): void {
    if (timer) return;
    timer = setInterval(() => {
      if (now() - lastAccess > warmMs) { if (timer) { clearInterval(timer); timer = null; } return; }
      if (!snapshot || now() - snapshotAt >= ttlMs) kickRefresh();
    }, Math.max(1000, Math.floor(ttlMs * 1.5)));
    if (timer.unref) timer.unref();
  }

  function get(): NodeFootprint {
    lastAccess = now();
    ensureWarm();
    const id = identity();
    if (!snapshot) { kickRefresh(); return { node: id.node, cluster: id.cluster, host: id.host, snapshotAgeSec: 0, reachable: true, warming: true, stale: true, sessions: [], ports: [] }; }
    const ageSec = Math.floor((now() - snapshotAt) / 1000);
    const stale = now() - snapshotAt >= ttlMs;
    if (stale) kickRefresh();
    return { ...snapshot, snapshotAgeSec: ageSec, stale, warming: false };
  }

  return { get, kickRefresh, dispose: () => { if (timer) { clearInterval(timer); timer = null; } } };
}

// ── Module singleton wired at runtime (real deps) ──
let _cache: ReturnType<typeof createLocalFootprintCache> | null = null;
export function getLocalSnapshot(): NodeFootprint {
  if (!_cache) {
    const { getSessionCache } = require('../session-cache') as typeof import('../session-cache');
    const { getHubConfig } = require('../hub-client/hub-config') as typeof import('../hub-client/hub-config');
    const { getMyCluster } = require('../cluster/cluster-config') as typeof import('../cluster/cluster-config');
    const { thisNode } = require('../data/paths') as typeof import('../data/paths');
    const { listActiveMissions } = require('../mission/mission-store') as typeof import('../mission/mission-store');
    const gitCache = new Map<string, { at: number; v: Awaited<ReturnType<typeof collectGitState>> }>();
    const build = () => buildSnapshot({
      sessions: () => getSessionCache().getAllSessionsFromCache(),
      bound: async () => {
        const map = new Map<string, string>();
        for (const m of await listActiveMissions().catch(() => [])) {
          const b = m.binding; if (!b) continue;
          if (b.sessionId) map.set(b.sessionId, m.id);
          const ccr = (b as any).ccr; if (ccr?.cse) map.set(ccr.cse, m.id); if (ccr?.sid) map.set(ccr.sid, m.id);
        }
        return map;
      },
      identity: () => ({ node: thisNode(), host: getHubConfig().hostname || thisNode(), cluster: getMyCluster() }),
      gitFor: async (cwd) => {
        const hit = gitCache.get(cwd); const t = Date.now();
        if (hit && t - hit.at < 10_000) return hit.v;
        const v = await collectGitState(cwd, runCmd); gitCache.set(cwd, { at: t, v }); return v;
      },
      ports: () => collectPorts(runCmd, process.platform),
      now: Date.now,
    });
    _cache = createLocalFootprintCache(build, () => ({ node: thisNode(), host: getHubConfig().hostname || thisNode(), cluster: getMyCluster() }));
  }
  return _cache.get();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/fleet/collector.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/fleet/session-footprint-collector.ts core/src/__tests__/fleet/collector.test.ts
git commit -m "feat(fleet): local footprint snapshot + non-blocking background refresher"
```

---

### Task 4: Composed fan-out

**Files:**
- Create: `core/src/fleet/footprint-compose.ts`
- Test: `core/src/__tests__/fleet/compose.test.ts`

**Interfaces:**
- Consumes: `NodeFootprint`/`ComposedFootprints` (Task 1), `getLocalSnapshot` (Task 3).
- Produces:
  - `mergeComposed(self: NodeFootprint, peers: Array<{ node: string; snap: NodeFootprint | null }>, scope: 'cluster' | 'fleet', now: number): ComposedFootprints`
  - `interface ComposeDeps { getLocal: () => NodeFootprint; listOnline: () => Promise<string[]>; clusterOf: () => Promise<Map<string, string>>; myCluster: () => string; selfId: () => string; proxyGet: (node: string, path: string) => Promise<unknown>; now: () => number }`
  - `getComposed(scope: 'cluster' | 'fleet', deps: ComposeDeps): Promise<ComposedFootprints>`

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/fleet/compose.test.ts`

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mergeComposed, getComposed } from '../../fleet/footprint-compose';
import type { NodeFootprint } from '../../fleet/footprint-types';

const node = (over: Partial<NodeFootprint>): NodeFootprint => ({ node: 'x', cluster: 'prod', host: 'h', snapshotAgeSec: 0, reachable: true, warming: false, stale: false, sessions: [], ports: [], ...over });

test('mergeComposed — self + reachable peer; unreachable peer (no snap) → unreachable[] + partial', () => {
  const r = mergeComposed(node({ node: 'self' }), [{ node: 'p1', snap: node({ node: 'p1' }) }, { node: 'p2', snap: null }], 'cluster', 5);
  assert.equal(r.nodes.length, 2);
  assert.deepEqual(r.unreachable, ['p2']);
  assert.equal(r.partial, true);
  assert.equal(r.scope, 'cluster');
});

test('mergeComposed — all fresh & reachable → partial false', () => {
  const r = mergeComposed(node({ node: 'self' }), [{ node: 'p1', snap: node({ node: 'p1' }) }], 'fleet', 5);
  assert.equal(r.partial, false);
  assert.deepEqual(r.unreachable, []);
});

test('getComposed — scope=cluster filters peers to my cluster; self never fetched over relay', async () => {
  const fetched: string[] = [];
  const r = await getComposed('cluster', {
    getLocal: () => node({ node: 'self', cluster: 'prod' }),
    listOnline: async () => ['self', 'peerProd', 'peerStage'],
    clusterOf: async () => new Map([['self', 'prod'], ['peerProd', 'prod'], ['peerStage', 'stage']]),
    myCluster: () => 'prod',
    selfId: () => 'self',
    proxyGet: async (n) => { fetched.push(n); return { data: node({ node: n, cluster: 'prod' }) }; },
    now: () => 1000,
  });
  assert.deepEqual(fetched, ['peerProd']);                 // only in-cluster peer, not self, not peerStage
  assert.deepEqual(r.nodes.map((n) => n.node).sort(), ['peerProd', 'self']);
});

test('getComposed — a peer that throws → reachable:false, never rejects', async () => {
  const r = await getComposed('fleet', {
    getLocal: () => node({ node: 'self' }),
    listOnline: async () => ['self', 'bad'],
    clusterOf: async () => new Map([['self', 'prod'], ['bad', 'prod']]),
    myCluster: () => 'prod', selfId: () => 'self',
    proxyGet: async () => { throw new Error('relay down'); },
    now: () => 1,
  });
  assert.deepEqual(r.unreachable, ['bad']);
  assert.equal(r.partial, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/fleet/compose.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `core/src/fleet/footprint-compose.ts`**

```ts
import type { NodeFootprint, ComposedFootprints } from './footprint-types';

const COMPOSED_TTL_MS = 5000;

export function mergeComposed(
  self: NodeFootprint,
  peers: Array<{ node: string; snap: NodeFootprint | null }>,
  scope: 'cluster' | 'fleet',
  now: number,
): ComposedFootprints {
  const nodes: NodeFootprint[] = [self];
  const unreachable: string[] = [];
  for (const p of peers) {
    if (p.snap) nodes.push(p.snap);
    else unreachable.push(p.node);
  }
  const partial = unreachable.length > 0 || nodes.some((n) => n.warming || n.stale || !n.reachable);
  return { generatedAt: now, scope, nodes, unreachable, partial };
}

export interface ComposeDeps {
  getLocal: () => NodeFootprint;
  listOnline: () => Promise<string[]>;
  clusterOf: () => Promise<Map<string, string>>;
  myCluster: () => string;
  selfId: () => string;
  proxyGet: (node: string, path: string) => Promise<unknown>;
  now: () => number;
}

let _cache: { at: number; scope: string; value: ComposedFootprints } | null = null;

export async function getComposed(scope: 'cluster' | 'fleet', deps: ComposeDeps): Promise<ComposedFootprints> {
  const t = deps.now();
  if (_cache && _cache.scope === scope && t - _cache.at < COMPOSED_TTL_MS) return _cache.value;

  const self = deps.getLocal();
  const [online, clusterMap] = await Promise.all([deps.listOnline().catch(() => [] as string[]), deps.clusterOf().catch(() => new Map<string, string>())]);
  const selfId = deps.selfId();
  const mine = deps.myCluster();
  const peerIds = online.filter((n) => n !== selfId).filter((n) => scope === 'fleet' || clusterMap.get(n) === mine);

  const peers = await Promise.all(peerIds.map(async (n) => {
    try {
      const res = (await deps.proxyGet(n, '/fleet/session-footprints/local')) as { data?: NodeFootprint } | NodeFootprint;
      const snap = (res as any)?.data ?? res;
      return { node: n, snap: snap && (snap as NodeFootprint).node ? (snap as NodeFootprint) : null };
    } catch {
      return { node: n, snap: null };
    }
  }));

  const value = mergeComposed(self, peers, scope, deps.now());
  _cache = { at: t, scope, value };
  return value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/fleet/compose.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/fleet/footprint-compose.ts core/src/__tests__/fleet/compose.test.ts
git commit -m "feat(fleet): composed cross-fleet merge + relay fan-out"
```

---

### Task 5: REST routes + relay allow-list

**Files:**
- Create: `core/src/routes/core/fleet.routes.ts`
- Modify: `core/src/routes/core/index.ts` (register `createFleetRoutes` — follow the `createClusterRoutes` import+registration already in that file)
- Modify: `core/src/hub-client/api-relay-handler.ts` (add `'/fleet'` to the allow-list array near `'/cluster'`, ~line 126)
- Test: `core/src/__tests__/fleet/wiring.test.ts`

**Interfaces:**
- Consumes: `getLocalSnapshot` (Task 3), `getComposed` (Task 4), `wrapResponse` (`core/src/api/helpers.ts`), `proxyGet`/`listOnlineNodeIds` (`core/src/data/peer-client.ts`), `getClusterRecords` (`core/src/cluster/cluster-store.ts`), `getMyCluster` (`core/src/cluster/cluster-config.ts`), `thisNode` (`core/src/data/paths.ts`).
- Produces: `createFleetRoutes(ctx: RouteContext): RouteHandler[]`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/fleet/wiring.test.ts`

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isApiPathAllowed } from '../../hub-client/api-relay-handler';

test('relay allow-list includes /fleet so composed fan-out can reach peers', () => {
  assert.equal(isApiPathAllowed('/fleet/session-footprints/local'), true);
});
```

(`isApiPathAllowed(requestPath)` is the standalone allow-check exported at `api-relay-handler.ts:515`; it delegates to `ApiRelayHandler.isApiPathAllowed`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/fleet/wiring.test.js`
Expected: FAIL — `isApiPathAllowed('/fleet/...')` returns false (`/fleet` not yet in the allow-list).

- [ ] **Step 3: Add `'/fleet'` to the relay allow-list**

In `core/src/hub-client/api-relay-handler.ts`, in the allowed-prefixes array (where `'/data'`, `'/node'`, `'/cluster'` are listed ~line 123-126), add:

```ts
    '/fleet',         // cross-node session/resource survey (session_footprints composes peers' /fleet/session-footprints/local)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/fleet/wiring.test.js`
Expected: PASS.

- [ ] **Step 5: Write `core/src/routes/core/fleet.routes.ts`**

```ts
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse } from '../../api/helpers';
import { getLocalSnapshot } from '../../fleet/session-footprint-collector';
import { getComposed, type ComposeDeps } from '../../fleet/footprint-compose';
import { proxyGet, listOnlineNodeIds } from '../../data/peer-client';
import { getClusterRecords } from '../../cluster/cluster-store';
import { getMyCluster } from '../../cluster/cluster-config';
import { thisNode } from '../../data/paths';

function composeDeps(): ComposeDeps {
  return {
    getLocal: getLocalSnapshot,
    listOnline: listOnlineNodeIds,
    clusterOf: async () => {
      const recs = await getClusterRecords();
      return new Map(recs.map((r) => [r.gatewayId, r.cluster]));
    },
    myCluster: getMyCluster,
    selfId: thisNode,
    proxyGet,
    now: Date.now,
  };
}

export function createFleetRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/fleet\/session-footprints\/local$/,
      handler: async () => {
        const start = Date.now();
        return wrapResponse(getLocalSnapshot(), start); // sync read — never awaits a collector
      },
    },
    {
      method: 'GET',
      pattern: /^\/fleet\/session-footprints$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const scope = (req.query?.scope === 'fleet' ? 'fleet' : 'cluster') as 'cluster' | 'fleet';
        return wrapResponse(await getComposed(scope, composeDeps()), start);
      },
    },
  ];
}
```

- [ ] **Step 6: Register the routes** in `core/src/routes/core/index.ts`

Mirror the existing `createClusterRoutes` lines: add `import { createFleetRoutes } from './fleet.routes';` with the other imports, and add `...createFleetRoutes(ctx),` (or `createFleetRoutes(ctx)` in the spread/concat list) exactly where `createClusterRoutes(ctx)` is referenced.

- [ ] **Step 7: Build core + smoke-test the local route**

```bash
cd core && npm run build && npm run build:test && node --test dist-test/__tests__/fleet/wiring.test.js
```
Expected: build succeeds; wiring test PASS. (Functional curl smoke happens at deploy: `curl -s localhost:3200/fleet/session-footprints/local` → JSON with `warming` then populated.)

- [ ] **Step 8: Commit**

```bash
git add core/src/routes/core/fleet.routes.ts core/src/routes/core/index.ts core/src/hub-client/api-relay-handler.ts core/src/__tests__/fleet/wiring.test.ts
git commit -m "feat(fleet): /fleet/session-footprints REST routes + relay allow-list"
```

---

### Task 6: MCP tool `session_footprints`

**Files:**
- Create: `core/src/mcp-server/tools/session-footprints.ts`
- Modify: `core/src/mcp-server/tools/expanded.ts` (add `sessionFootprintsToolDef` to `EXPANDED_TOOL_DEFS`)
- Modify: `core/src/mcp-server/configure.ts` (`session_footprints: 'read'` in `TOOL_SCOPES`, ~line 124+)
- Modify: `core/src/mcp-server/index.ts` (stdio dispatch: add a `case` near line 57)
- Modify: `core/src/routes/core/mcp.routes.ts` (connector dispatch: add a `case` near line 54)
- Test: `core/src/__tests__/fleet/mcp-tool.test.ts`

**Interfaces:**
- Consumes: `getComposed` (Task 4), the `composeDeps()` shape (replicate the small factory from `fleet.routes.ts`, or export it — prefer exporting `composeDeps` from `fleet.routes.ts` and importing it here to stay DRY).
- Produces: `handleSessionFootprints(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }>` and `sessionFootprintsToolDef`.

- [ ] **Step 1: Export `composeDeps` from `fleet.routes.ts`** (change `function composeDeps()` to `export function composeDeps()`), so the MCP handler reuses it (DRY — one fan-out wiring).

- [ ] **Step 2: Write the failing test** — `core/src/__tests__/fleet/mcp-tool.test.ts`

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { sessionFootprintsToolDef } from '../../mcp-server/tools/session-footprints';
import { TOOL_SCOPES } from '../../mcp-server/configure';

test('session_footprints tool def is read-only and scoped', () => {
  assert.equal(sessionFootprintsToolDef.name, 'session_footprints');
  assert.equal(sessionFootprintsToolDef.annotations.readOnlyHint, true);
  assert.equal((TOOL_SCOPES as Record<string, string>).session_footprints, 'read');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/fleet/mcp-tool.test.js`
Expected: FAIL — module not found / `session_footprints` scope undefined.

- [ ] **Step 4: Write `core/src/mcp-server/tools/session-footprints.ts`**

```ts
import { getComposed } from '../../fleet/footprint-compose';
import { composeDeps } from '../../routes/core/fleet.routes';

export const sessionFootprintsToolDef = {
  name: 'session_footprints',
  description:
    'Cross-fleet survey of RECENT sessions and what each one OCCUPIES — node, repo, branch, ' +
    'worktree, open changes (uncommitted + committed-but-unpushed), and listening ports — composed ' +
    'server-side in ONE call. Each session is tagged `managed` (a missionId if it is a mission ' +
    'executor, else null = UNMANAGED). The Mission Controller calls this BEFORE placing a worker to ' +
    'avoid colliding with unmanaged in-flight work on a node/repo/branch/port. Read-only; non-blocking ' +
    '(may return `warming`/`partial` right after boot, fills within seconds). scope: "cluster" (default) or "fleet".',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      scope: { type: 'string', enum: ['cluster', 'fleet'], description: 'cluster (default — your placement boundary) or fleet (all online nodes).' },
    },
    required: [] as string[],
  },
};

export async function handleSessionFootprints(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  const scope = args.scope === 'fleet' ? 'fleet' : 'cluster';
  const composed = await getComposed(scope, composeDeps());
  return { content: [{ type: 'text', text: JSON.stringify(composed, null, 2) }] };
}
```

- [ ] **Step 5: Add the scope** in `core/src/mcp-server/configure.ts` `TOOL_SCOPES` (with the other `read` tools):

```ts
  session_footprints: 'read',
```

- [ ] **Step 6: Advertise the def** in `core/src/mcp-server/tools/expanded.ts` — import `sessionFootprintsToolDef` and add it to the `EXPANDED_TOOL_DEFS` array (mirror how the other tool defs are listed).

- [ ] **Step 7: Dispatch — stdio** (`core/src/mcp-server/index.ts`, near line 57): add, importing the handler:

```ts
    case 'session_footprints':           return handleSessionFootprints(args);
```

- [ ] **Step 8: Dispatch — connector** (`core/src/routes/core/mcp.routes.ts`, near line 54): add, importing the handler:

```ts
    case 'session_footprints':           return handleSessionFootprints(args);
```

- [ ] **Step 9: Run the tool test + the FULL scopes test**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/fleet/mcp-tool.test.js && node --test dist-test/__tests__/data/mcp-tool-scopes.test.js`
Expected: both PASS (the scopes test proves every advertised tool — now incl. `session_footprints` — has a scope, so Core won't crash on `/mcp`).

- [ ] **Step 10: Build + commit**

```bash
cd core && npm run build
git add core/src/mcp-server/tools/session-footprints.ts core/src/mcp-server/tools/expanded.ts core/src/mcp-server/configure.ts core/src/mcp-server/index.ts core/src/routes/core/mcp.routes.ts core/src/routes/core/fleet.routes.ts core/src/__tests__/fleet/mcp-tool.test.ts
git commit -m "feat(mcp): session_footprints tool (def + handler + dispatch + scope)"
```

---

### Task 7: Controller advisory directive

**Files:**
- Modify: `core/src/mission/mission-controller.ts` (`CONTROLLER_PASS_DIRECTIVE` ~line 431; `CONTROLLER_SYSTEM_PROMPT` array ~line 451)
- Test: `core/src/__tests__/fleet/controller-directive.test.ts`

**Interfaces:**
- Consumes: nothing new (string constants).
- Produces: updated exported constants `CONTROLLER_PASS_DIRECTIVE`, `CONTROLLER_SYSTEM_PROMPT`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/fleet/controller-directive.test.ts`

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CONTROLLER_PASS_DIRECTIVE, CONTROLLER_SYSTEM_PROMPT } from '../../mission/mission-controller';

test('controller pass directive tells it to survey footprints before placing + defer on conflict', () => {
  assert.match(CONTROLLER_PASS_DIRECTIVE, /session_footprints/);
  assert.match(CONTROLLER_PASS_DIRECTIVE, /ctl:deferred-contention/);
  assert.match(CONTROLLER_PASS_DIRECTIVE, /unmanaged/i);
});

test('controller system prompt names the survey tool', () => {
  assert.match(CONTROLLER_SYSTEM_PROMPT, /session_footprints/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/fleet/controller-directive.test.js`
Expected: FAIL — strings absent.

- [ ] **Step 3: Extend `CONTROLLER_PASS_DIRECTIVE`**

In `core/src/mission/mission-controller.ts`, the directive string currently ends `…Then await the next pass.';`. Insert this sentence immediately BEFORE `Then await the next pass.` (so it runs as part of acting on `ready`):

```
 BEFORE you place/spawn an executor for a `ready` mission, call session_footprints (your cluster) and AVOID a node/repo/branch/worktree an UNMANAGED recent session occupies — especially one whose openChanges overlap the mission repo/branch or whose branch is pushed:false — and any port an exclusive service holds; mission-managed sessions (managed set) are your own, never a conflict. If the only placement collides, DEFER: leave the mission ready, tag ctl:deferred-contention with the conflicting session, and revisit next pass. If the survey is partial/warming, treat unknown nodes as clear and re-check next pass.
```

- [ ] **Step 4: Add a line to `CONTROLLER_SYSTEM_PROMPT`**

In the `CONTROLLER_SYSTEM_PROMPT = [ … ]` array (~line 451), add one element:

```ts
  'CONTENTION: before placing an executor, call session_footprints to see what unmanaged sessions across your cluster occupy (node/repo/branch/worktree/open-changes/ports); do not spawn into a conflict — defer and retag instead.',
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd core && npm run build:test && node --test dist-test/__tests__/fleet/controller-directive.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full fleet suite + build**

```bash
cd core && npm run build && node --test dist-test/__tests__/fleet/*.test.js
```
Expected: all fleet tests PASS, core builds clean.

- [ ] **Step 7: Commit**

```bash
git add core/src/mission/mission-controller.ts core/src/__tests__/fleet/controller-directive.test.ts
git commit -m "feat(mission): controller surveys session_footprints before placing (advisory, defer on conflict)"
```

---

## Deployment (after all tasks reviewed + merged)

Core-only change. Per the established core-only fleet rollout: `rsync core/dist` to each install (117/123 Linux, 107 Windows zip+Expand-Archive) + restart; then on the connector run `refresh_connector_tools` + `set_connector_auto_approve` so `session_footprints` surfaces (verify in a FRESH session). Smoke each node: `curl -s localhost:3100/fleet/session-footprints/local` → JSON (`warming:true` first, populated within seconds), then `…/session-footprints?scope=cluster` → composed with peers.

## Self-Review notes

- Spec coverage: collector (T1–3), compose/hybrid (T3–4), REST+relay (T5), MCP (T6), directive (T7), non-blocking guarantee (T3 test), open-changes git (T1), ports-only (T2), managed tag (T3), advisory-only/no place() change (T7 only touches strings). ✓
- Types consistent across tasks: `GitState`/`SessionFootprint`/`PortHold`/`NodeFootprint`/`ComposedFootprints` defined once in T1 and imported everywhere; `RunCmd`, `BuildDeps`, `ComposeDeps` signatures match their consumers. ✓
- Cross-file names verified against source: relay allow-check = `isApiPathAllowed` (`api-relay-handler.ts:515`); tool-defs array = `EXPANDED_TOOL_DEFS` (`expanded.ts:844`, bare def identifiers — add `sessionFootprintsToolDef,` + its import); `ParsedRequest.query: Record<string,string>` (`routes/index.ts:22`); stdio dispatch `mcp-server/index.ts:57`; connector dispatch `mcp.routes.ts:54`; `TOOL_SCOPES` `configure.ts:123`. All concrete — no open names.
