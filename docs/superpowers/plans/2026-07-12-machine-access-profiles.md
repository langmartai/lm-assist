# Machine Access Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Node-local store of machine access profiles (SSH now, extensible later) + REST routes + a `machine_access` MCP read tool, per `docs/superpowers/specs/2026-07-12-machine-access-profiles-design.md`.

**Architecture:** A plain node-local JSON file (`~/.lm-assist/machine-access[-dev].json`, cluster.json precedent) owned by `core/src/machine-access/store.ts`; routes expose a read report plus loopback-only writes; the MCP tool wraps the GET route via the `_passthrough` loopback helper (cluster_list precedent). Access methods are a discriminated union on `type` — v1 implements `ssh`; unknown types round-trip and report `supported: false`.

**Tech Stack:** TypeScript (CJS build), raw Node http route tables, node:test. No new dependencies.

## Global Constraints

- Node ≥ 20.9 for build/tests: `export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"` first in every shell (system node is v18 — `npm test` dies on `--test-timeout`).
- Run all npm commands from the worktree root or `core/` as stated; never install inside `core/` (workspace hoisting).
- Tests live in `core/src/__tests__/` (the runner glob is `dist-test/__tests__/**/*.test.js`).
- Route responses use `wrapResponse`/`wrapError` from `core/src/api/helpers.ts`; validate input before touching disk; never log credentials.
- Route path params come from **named regex groups** (`/(?<id>[^/]+)/` → `req.params.id`; `rest-server.ts:563` does `parsed.params = match.groups || {}`).
- Loopback guard = `isLoopbackAddress(req.clientIp)` from `core/src/auth/enroll-exempt.ts`.
- No secrets: `identityFile` is a path; reject values containing newlines or `PRIVATE KEY`.
- Commit after each green task; commit messages end with the session trailer used in this branch's first commit.

---

### Task 1: Store module (`machine-access/store.ts`)

**Files:**
- Create: `core/src/machine-access/store.ts`
- Test: `core/src/__tests__/machine-access-store.test.ts`

**Interfaces:**
- Produces (used by Tasks 2–3):
  - `interface SshAccess { type: 'ssh'; host: string; user: string; port?: number; identityFile?: string; notes?: string }`
  - `type AccessMethod = SshAccess | UnknownAccess` (UnknownAccess = `{ type: string; [k: string]: unknown }`)
  - `interface MachineProfile { id: string; name: string; description?: string; os?: string; tags?: string[]; enabled?: boolean; notes?: string; access: AccessMethod[]; createdAt?: string; updatedAt?: string }`
  - `machineAccessPath(): string` — honors `process.env.LM_MACHINE_ACCESS_FILE` override (test hook), else `~/.lm-assist/machine-access${IS_DEV_REPO ? '-dev' : ''}.json`
  - `validateProfile(p: unknown): string | null` — first error message, or null when valid
  - `loadMachineAccess(file?: string): MachineAccessFile` / `listMachines(file?: string): MachineProfile[]` / `getMachine(id: string, file?: string): MachineProfile | undefined`
  - `upsertMachine(profile: MachineProfile, file?: string): MachineProfile` — validates (throws `Error` with the message), stamps `createdAt` (new) / `updatedAt` (always), atomic write
  - `removeMachine(id: string, file?: string): boolean`
  - `buildSshCommand(a: SshAccess): string` / `isSshAccess(a: AccessMethod): a is SshAccess`
  - `toReportedMachine(p: MachineProfile)` — adds `command` + `supported: true` to ssh access entries, `supported: false` to unknown ones, normalizes `enabled` (`!== false`)
  - `MACHINE_ACCESS_USAGE: string` — the "run these ON this node" guidance constant

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/machine-access-store.test.ts`:

```typescript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  validateProfile,
  loadMachineAccess,
  listMachines,
  getMachine,
  upsertMachine,
  removeMachine,
  buildSshCommand,
  toReportedMachine,
  type MachineProfile,
  type SshAccess,
} from '../machine-access/store';

const ssh = (over: Partial<SshAccess> = {}): SshAccess => ({
  type: 'ssh',
  host: '192.0.2.23',
  user: 'yi',
  ...over,
});

const profile = (over: Partial<MachineProfile> = {}): MachineProfile => ({
  id: 'node-b',
  name: 'node-b VM',
  access: [ssh()],
  ...over,
});

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-store-'));
  return path.join(dir, 'machine-access.json');
}

describe('validateProfile', () => {
  it('accepts a minimal ssh profile', () => {
    assert.equal(validateProfile(profile()), null);
  });
  it('accepts full real-world shape (tags, notes, port, identityFile)', () => {
    assert.equal(
      validateProfile(profile({
        description: 'capture VM',
        os: 'linux',
        tags: ['lan', 'lm-assist-node'],
        notes: 'passwordless sudo',
        access: [ssh({ port: 22, identityFile: '~/.ssh/ssh-keys/id_rsa', notes: 'key' })],
      })),
      null,
    );
  });
  it('rejects non-objects and missing fields', () => {
    assert.match(validateProfile(null) ?? '', /object/);
    assert.match(validateProfile(profile({ id: 'Bad ID!' })) ?? '', /id/);
    assert.match(validateProfile(profile({ name: '' })) ?? '', /name/);
    assert.match(validateProfile(profile({ access: [] })) ?? '', /access/);
  });
  it('rejects bad ssh entries', () => {
    assert.match(validateProfile(profile({ access: [ssh({ host: '' })] })) ?? '', /host/);
    assert.match(validateProfile(profile({ access: [ssh({ user: '' })] })) ?? '', /user/);
    assert.match(validateProfile(profile({ access: [ssh({ port: 70000 })] })) ?? '', /port/);
    assert.match(validateProfile(profile({ access: [ssh({ port: 2.5 })] })) ?? '', /port/);
  });
  it('rejects identityFile that looks like key material (path only, never keys)', () => {
    assert.match(
      validateProfile(profile({ access: [ssh({ identityFile: '-----BEGIN PRIVATE KEY-----' })] })) ?? '',
      /identityFile/,
    );
    assert.match(
      validateProfile(profile({ access: [ssh({ identityFile: 'a\nb' })] })) ?? '',
      /identityFile/,
    );
  });
  it('accepts unknown access types (forward compat) but requires a type string', () => {
    assert.equal(validateProfile(profile({ access: [{ type: 'windows-account', host: 'h' }] })), null);
    assert.match(validateProfile(profile({ access: [{ host: 'h' } as any] })) ?? '', /type/);
  });
});

describe('store CRUD round-trip', () => {
  let file: string;
  beforeEach(() => { file = tmpFile(); });

  it('missing file → empty store', () => {
    assert.deepEqual(loadMachineAccess(file), { version: 1, machines: [] });
  });
  it('corrupt file → empty store (no throw)', () => {
    fs.writeFileSync(file, '{nope', 'utf-8');
    assert.deepEqual(loadMachineAccess(file).machines, []);
  });
  it('upsert → list → get → update → remove', () => {
    const created = upsertMachine(profile(), file);
    assert.ok(created.createdAt);
    assert.ok(created.updatedAt);
    assert.equal(listMachines(file).length, 1);
    assert.equal(getMachine('node-b', file)?.name, 'node-b VM');

    const updated = upsertMachine(profile({ name: 'node-b (123)' }), file);
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(listMachines(file).length, 1);
    assert.equal(getMachine('node-b', file)?.name, 'node-b (123)');

    assert.equal(removeMachine('node-b', file), true);
    assert.equal(removeMachine('node-b', file), false);
    assert.equal(listMachines(file).length, 0);
  });
  it('upsert of invalid profile throws and writes nothing', () => {
    assert.throws(() => upsertMachine(profile({ access: [] }), file), /access/);
    assert.equal(fs.existsSync(file), false);
  });
  it('unknown access types and unknown top-level keys survive save', () => {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      customTopLevel: { keep: true },
      machines: [profile({ id: 'win', access: [{ type: 'windows-account', host: 'h' }] })],
    }), 'utf-8');
    upsertMachine(profile(), file);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.deepEqual(raw.customTopLevel, { keep: true });
    assert.equal(raw.machines.find((m: any) => m.id === 'win').access[0].type, 'windows-account');
  });
});

describe('buildSshCommand', () => {
  it('minimal', () => {
    assert.equal(buildSshCommand(ssh()), 'ssh yi@192.0.2.23');
  });
  it('with identityFile and non-default port', () => {
    assert.equal(
      buildSshCommand(ssh({ identityFile: '~/.ssh/k', port: 2222 })),
      'ssh -i ~/.ssh/k -p 2222 yi@192.0.2.23',
    );
  });
  it('default port 22 omitted', () => {
    assert.equal(buildSshCommand(ssh({ port: 22 })), 'ssh yi@192.0.2.23');
  });
});

describe('toReportedMachine', () => {
  it('derives command for ssh, flags unknown types unsupported', () => {
    const r = toReportedMachine(profile({
      access: [ssh({ identityFile: '~/.ssh/k' }), { type: 'windows-account', host: 'h' }],
    }));
    assert.equal(r.enabled, true);
    assert.equal((r.access[0] as any).command, 'ssh -i ~/.ssh/k yi@192.0.2.23');
    assert.equal((r.access[0] as any).supported, true);
    assert.equal((r.access[1] as any).supported, false);
    assert.equal((r.access[1] as any).command, undefined);
  });
  it('enabled:false is preserved', () => {
    assert.equal(toReportedMachine(profile({ enabled: false })).enabled, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
cd core && npm run build:test
```
Expected: FAIL — `error TS2307: Cannot find module '../machine-access/store'`.

- [ ] **Step 3: Write minimal implementation**

`core/src/machine-access/store.ts`:

```typescript
/**
 * Machine access profiles — how to reach OTHER machines FROM this node.
 *
 * Node-local file (~/.lm-assist/machine-access[-dev].json), cluster.json
 * precedent: NOT a synced dataset. Profiles describe reachability that only
 * exists from this host (keys on disk, LAN routes), so they never leave the
 * node except when reported on demand (GET /machine-access, MCP machine_access).
 *
 * v1 implements `type:'ssh'`. Unknown access types round-trip verbatim
 * (forward compat for e.g. windows-account / elevated-worker) and are
 * reported with supported:false.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const IS_DEV_REPO = !__dirname.includes('node_modules');
const FILE = `machine-access${IS_DEV_REPO ? '-dev' : ''}.json`;

export interface SshAccess {
  type: 'ssh';
  host: string;
  user: string;
  port?: number;
  /** Path to the private key on THIS node — never key material. */
  identityFile?: string;
  notes?: string;
}

export interface UnknownAccess {
  type: string;
  [key: string]: unknown;
}

export type AccessMethod = SshAccess | UnknownAccess;

export interface MachineProfile {
  id: string;
  name: string;
  description?: string;
  os?: string;
  tags?: string[];
  enabled?: boolean;
  notes?: string;
  access: AccessMethod[];
  createdAt?: string;
  updatedAt?: string;
}

export interface MachineAccessFile {
  version: 1;
  machines: MachineProfile[];
  [key: string]: unknown; // unknown top-level keys are preserved on save
}

export const MACHINE_ACCESS_USAGE =
  'These profiles are NODE-LOCAL: each machine is reachable only FROM this lm-assist node ' +
  '(keys/routes exist only here). Run the reported command ON this node — a local shell, ' +
  'agent_execute, or terminal tools targeted at this node — not from elsewhere. ' +
  'identityFile values are key PATHS on this node; key material is never stored or reported. ' +
  'Manage profiles on the node itself: PUT/DELETE /machine-access/machines/<id> (loopback-only) ' +
  'or edit ~/.lm-assist/machine-access.json.';

export function machineAccessPath(): string {
  if (process.env.LM_MACHINE_ACCESS_FILE) return process.env.LM_MACHINE_ACCESS_FILE;
  return path.join(os.homedir(), '.lm-assist', FILE);
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isSshAccess(a: AccessMethod): a is SshAccess {
  return a.type === 'ssh';
}

function validateSsh(a: Record<string, unknown>, i: number): string | null {
  if (typeof a.host !== 'string' || !a.host.trim()) return `access[${i}]: ssh host is required`;
  if (typeof a.user !== 'string' || !a.user.trim()) return `access[${i}]: ssh user is required`;
  if (a.port !== undefined && (!Number.isInteger(a.port) || (a.port as number) < 1 || (a.port as number) > 65535)) {
    return `access[${i}]: port must be an integer 1-65535`;
  }
  if (a.identityFile !== undefined) {
    if (typeof a.identityFile !== 'string' || !a.identityFile.trim()) {
      return `access[${i}]: identityFile must be a non-empty path`;
    }
    if (/[\r\n]/.test(a.identityFile) || a.identityFile.includes('PRIVATE KEY')) {
      return `access[${i}]: identityFile must be a key PATH, never key material`;
    }
  }
  return null;
}

/** First validation error message, or null when the profile is valid. */
export function validateProfile(p: unknown): string | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'profile must be an object';
  const m = p as Record<string, unknown>;
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) {
    return 'id must be a slug: [a-z0-9][a-z0-9._-]*, max 64 chars';
  }
  if (typeof m.name !== 'string' || !m.name.trim()) return 'name is required';
  if (m.tags !== undefined && (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== 'string'))) {
    return 'tags must be an array of strings';
  }
  if (!Array.isArray(m.access) || m.access.length === 0) {
    return 'access must be a non-empty array of access methods';
  }
  for (let i = 0; i < m.access.length; i++) {
    const a = m.access[i] as Record<string, unknown>;
    if (!a || typeof a !== 'object' || typeof a.type !== 'string' || !a.type.trim()) {
      return `access[${i}]: type is required`;
    }
    if (a.type === 'ssh') {
      const e = validateSsh(a, i);
      if (e) return e;
    }
    // Unknown types: accepted verbatim (forward compat); reported supported:false.
  }
  return null;
}

export function loadMachineAccess(file: string = machineAccessPath()): MachineAccessFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { machines?: unknown }).machines)) {
      return { version: 1, machines: [] };
    }
    return { ...(raw as Record<string, unknown>), version: 1, machines: (raw as { machines: MachineProfile[] }).machines };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[machine-access] unreadable ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { version: 1, machines: [] };
  }
}

function saveMachineAccess(data: MachineAccessFile, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file); // atomic — no torn file if Core dies mid-write
}

export function listMachines(file: string = machineAccessPath()): MachineProfile[] {
  return loadMachineAccess(file).machines;
}

export function getMachine(id: string, file: string = machineAccessPath()): MachineProfile | undefined {
  return listMachines(file).find((m) => m.id === id);
}

/** Validated upsert. Throws Error(message) on invalid input; stamps timestamps. */
export function upsertMachine(profile: MachineProfile, file: string = machineAccessPath()): MachineProfile {
  const error = validateProfile(profile);
  if (error) throw new Error(error);
  const data = loadMachineAccess(file);
  const now = new Date().toISOString();
  const existing = data.machines.find((m) => m.id === profile.id);
  const merged: MachineProfile = {
    ...profile,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  data.machines = [...data.machines.filter((m) => m.id !== profile.id), merged];
  saveMachineAccess(data, file);
  return merged;
}

export function removeMachine(id: string, file: string = machineAccessPath()): boolean {
  const data = loadMachineAccess(file);
  const next = data.machines.filter((m) => m.id !== id);
  if (next.length === data.machines.length) return false;
  data.machines = next;
  saveMachineAccess(data, file);
  return true;
}

/** Ready-to-run command for an ssh access method (derived, never stored). */
export function buildSshCommand(a: SshAccess): string {
  const parts = ['ssh'];
  if (a.identityFile) parts.push('-i', a.identityFile);
  if (a.port && a.port !== 22) parts.push('-p', String(a.port));
  parts.push(`${a.user}@${a.host}`);
  return parts.join(' ');
}

export interface ReportedMachine extends Omit<MachineProfile, 'access' | 'enabled'> {
  enabled: boolean;
  access: Array<AccessMethod & { supported: boolean; command?: string }>;
}

/** Reporting shape: derived ssh command + supported flag per access method. */
export function toReportedMachine(p: MachineProfile): ReportedMachine {
  return {
    ...p,
    enabled: p.enabled !== false,
    access: p.access.map((a) =>
      isSshAccess(a)
        ? { ...a, supported: true, command: buildSshCommand(a) }
        : { ...a, supported: false },
    ),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/machine-access-store.test.js
```
Expected: PASS (all subtests), 0 failures.

- [ ] **Step 5: Commit**

```bash
git add core/src/machine-access/store.ts core/src/__tests__/machine-access-store.test.ts
git commit -m "feat(machine-access): node-local machine access profile store (ssh v1, forward-compat types)"
```

---

### Task 2: REST routes + registration

**Files:**
- Create: `core/src/routes/core/machine-access.routes.ts`
- Modify: `core/src/routes/core/index.ts` (import after `createCoworkRoutes` import at ~line 70; spread after `...createElevatedRoutes(ctx),` at ~line 135)
- Test: `core/src/__tests__/machine-access-routes.test.ts`

**Interfaces:**
- Consumes (Task 1): `listMachines`, `upsertMachine`, `removeMachine`, `toReportedMachine`, `MACHINE_ACCESS_USAGE`, `MachineProfile`.
- Produces:
  - `GET /machine-access` → `{ node: { hostname, gatewayId }, count, machines: ReportedMachine[], usage }`
  - `PUT /machine-access/machines/:id` (loopback-only) → `{ machine }` — body is the profile; path id wins over body id
  - `DELETE /machine-access/machines/:id` (loopback-only) → `{ removed: boolean, id }`
  - `export function createMachineAccessRoutes(ctx: RouteContext): RouteHandler[]`

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/machine-access-routes.test.ts`:

```typescript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMachineAccessRoutes } from '../routes/core/machine-access.routes';
import type { ParsedRequest, RouteHandler } from '../routes/index';

const routes: RouteHandler[] = createMachineAccessRoutes({} as never);

function findRoute(method: string, samplePath: string): RouteHandler {
  const r = routes.find((h) => h.method === method && h.pattern.test(samplePath));
  assert.ok(r, `route ${method} ${samplePath} not found`);
  return r as RouteHandler;
}

function req(method: string, reqPath: string, over: Partial<ParsedRequest> = {}): ParsedRequest {
  const r = findRoute(method, reqPath);
  const match = r.pattern.exec(reqPath);
  return {
    method,
    path: reqPath,
    params: (match?.groups as Record<string, string>) || {},
    query: {},
    body: undefined,
    clientIp: '127.0.0.1',
    ...over,
  } as ParsedRequest;
}

const PROFILE = {
  id: 'node-b',
  name: 'node-b VM',
  access: [{ type: 'ssh', host: '192.0.2.23', user: 'yi', identityFile: '~/.ssh/ssh-keys/id_rsa' }],
};

describe('machine-access routes', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-routes-'));
    process.env.LM_MACHINE_ACCESS_FILE = path.join(dir, 'machine-access.json');
  });
  after(() => { delete process.env.LM_MACHINE_ACCESS_FILE; });

  it('PUT rejects non-loopback callers', async () => {
    const h = findRoute('PUT', '/machine-access/machines/node-b');
    const res = await h.handler(req('PUT', '/machine-access/machines/node-b', { clientIp: '10.0.0.5', body: PROFILE }), {} as never);
    assert.equal(res.success, false);
    assert.equal(res.error?.code, 'FORBIDDEN');
  });

  it('DELETE rejects non-loopback callers', async () => {
    const h = findRoute('DELETE', '/machine-access/machines/node-b');
    const res = await h.handler(req('DELETE', '/machine-access/machines/node-b', { clientIp: '203.0.113.9' }), {} as never);
    assert.equal(res.success, false);
    assert.equal(res.error?.code, 'FORBIDDEN');
  });

  it('loopback PUT upserts (path id wins) and GET reports with derived command', async () => {
    const put = findRoute('PUT', '/machine-access/machines/node-b');
    const created = await put.handler(req('PUT', '/machine-access/machines/node-b', { body: { ...PROFILE, id: 'ignored' } }), {} as never);
    assert.equal(created.success, true);
    assert.equal((created.data as any).machine.id, 'node-b');

    const get = findRoute('GET', '/machine-access');
    const rep = await get.handler(req('GET', '/machine-access'), {} as never);
    assert.equal(rep.success, true);
    const data = rep.data as any;
    assert.equal(data.count, 1);
    assert.equal(data.machines[0].access[0].command, 'ssh -i ~/.ssh/ssh-keys/id_rsa yi@192.0.2.23');
    assert.ok(typeof data.node.hostname === 'string' && data.node.hostname.length > 0);
    assert.match(data.usage, /NODE-LOCAL/);
  });

  it('PUT with invalid body → INVALID_INPUT', async () => {
    const put = findRoute('PUT', '/machine-access/machines/bad');
    const res = await put.handler(req('PUT', '/machine-access/machines/bad', { body: { name: 'x', access: [] } }), {} as never);
    assert.equal(res.success, false);
    assert.equal(res.error?.code, 'INVALID_INPUT');
  });

  it('DELETE removes and reports removed:false for unknown id', async () => {
    const del = findRoute('DELETE', '/machine-access/machines/node-b');
    const res1 = await del.handler(req('DELETE', '/machine-access/machines/node-b'), {} as never);
    assert.equal((res1.data as any).removed, true);
    const res2 = await del.handler(req('DELETE', '/machine-access/machines/node-b'), {} as never);
    assert.equal((res2.data as any).removed, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd core && npm run build:test
```
Expected: FAIL — `Cannot find module '../routes/core/machine-access.routes'`.

- [ ] **Step 3: Write minimal implementation**

`core/src/routes/core/machine-access.routes.ts`:

```typescript
/**
 * Machine access profile routes — how to reach OTHER machines FROM this node.
 *
 *   GET    /machine-access                       → report (node identity + machines + usage)
 *   PUT    /machine-access/machines/:id          → loopback-only upsert
 *   DELETE /machine-access/machines/:id          → loopback-only remove
 *
 * Writes are loopback-guarded like POST /cluster/self: registering or altering
 * SSH endpoints is a node-owner action taken ON the node. Reads are normal
 * routes; the MCP tool `machine_access` wraps the GET.
 */
import * as os from 'os';
import type { RouteHandler, RouteContext, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { isLoopbackAddress } from '../../auth/enroll-exempt';
import { getHubConfig } from '../../hub-client/hub-config';
import {
  listMachines,
  upsertMachine,
  removeMachine,
  toReportedMachine,
  MACHINE_ACCESS_USAGE,
  type MachineProfile,
} from '../../machine-access/store';

export function createMachineAccessRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // GET /machine-access — full report for this node
    {
      method: 'GET',
      pattern: /^\/machine-access$/,
      handler: async () => {
        const start = Date.now();
        const machines = listMachines().map(toReportedMachine);
        const cfg = getHubConfig();
        return wrapResponse({
          node: { hostname: os.hostname(), gatewayId: cfg.gatewayId || cfg.machineId || '' },
          count: machines.length,
          machines,
          usage: MACHINE_ACCESS_USAGE,
        }, start);
      },
    },

    // PUT /machine-access/machines/:id — loopback-only upsert (path id is authoritative)
    {
      method: 'PUT',
      pattern: /^\/machine-access\/machines\/(?<id>[^/]+)$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        if (!isLoopbackAddress(req.clientIp)) {
          return wrapError('FORBIDDEN', 'local-only endpoint', start);
        }
        const id = decodeURIComponent(req.params.id || '');
        const body = (req.body || {}) as Partial<MachineProfile>;
        try {
          const machine = upsertMachine({ ...body, id } as MachineProfile);
          return wrapResponse({ machine }, start);
        } catch (e) {
          return wrapError('INVALID_INPUT', e instanceof Error ? e.message : String(e), start);
        }
      },
    },

    // DELETE /machine-access/machines/:id — loopback-only remove
    {
      method: 'DELETE',
      pattern: /^\/machine-access\/machines\/(?<id>[^/]+)$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        if (!isLoopbackAddress(req.clientIp)) {
          return wrapError('FORBIDDEN', 'local-only endpoint', start);
        }
        const id = decodeURIComponent(req.params.id || '');
        return wrapResponse({ removed: removeMachine(id), id }, start);
      },
    },
  ];
}
```

Registration in `core/src/routes/core/index.ts` — add with the other imports (after `createCoworkRoutes`):

```typescript
import { createMachineAccessRoutes } from './machine-access.routes';
```

and in the `createCoreRoutes` return array (after `...createElevatedRoutes(ctx),`):

```typescript
    ...createMachineAccessRoutes(ctx),
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/machine-access-routes.test.js
```
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add core/src/routes/core/machine-access.routes.ts core/src/routes/core/index.ts core/src/__tests__/machine-access-routes.test.ts
git commit -m "feat(machine-access): REST routes — GET report + loopback-only PUT/DELETE"
```

---

### Task 3: MCP tool `machine_access`

**Files:**
- Create: `core/src/mcp-server/tools/machine-access.ts`
- Modify: `core/src/mcp-server/tools/expanded.ts` (import after `./cluster` import at ~line 59; `...MACHINE_ACCESS_TOOL_DEFS,` after `...CLUSTER_TOOL_DEFS,` at ~line 1019; `...MACHINE_ACCESS_HANDLERS,` after `...CLUSTER_HANDLERS,` at ~line 1875)
- Modify: `core/src/mcp-server/configure.ts` (add `machine_access: 'read',` after the cluster scope block at ~line 304)
- Test: `core/src/__tests__/machine-access-mcp.test.ts`

**Interfaces:**
- Consumes (Task 2): `GET /machine-access` response shape `{ node, count, machines, usage }` via `workerGet<T>(routePath)` from `./_passthrough`.
- Produces:
  - Tool `machine_access` (read scope, `readOnlyHint: true`), args `{ id?: string; tag?: string }`
  - `export function filterMachines<T extends { id?: string; tags?: string[] }>(machines: T[], opts: { id?: string; tag?: string }): T[]` — pure, unit-tested
  - `MACHINE_ACCESS_TOOL_DEFS`, `MACHINE_ACCESS_HANDLERS` registered in `expanded.ts`

- [ ] **Step 1: Write the failing test**

`core/src/__tests__/machine-access-mcp.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterMachines, machineAccessToolDef } from '../mcp-server/tools/machine-access';

const MACHINES = [
  { id: 'sg-hub', tags: ['oracle', 'hub'] },
  { id: 'node-b', tags: ['lan'] },
  { id: 'win107', tags: ['lan', 'windows'] },
];

describe('filterMachines', () => {
  it('no filters → all', () => {
    assert.equal(filterMachines(MACHINES, {}).length, 3);
  });
  it('by id', () => {
    assert.deepEqual(filterMachines(MACHINES, { id: 'node-b' }).map((m) => m.id), ['node-b']);
  });
  it('by tag', () => {
    assert.deepEqual(filterMachines(MACHINES, { tag: 'lan' }).map((m) => m.id), ['node-b', 'win107']);
  });
  it('id + tag compose', () => {
    assert.equal(filterMachines(MACHINES, { id: 'win107', tag: 'hub' }).length, 0);
  });
  it('missing tags array tolerated', () => {
    assert.equal(filterMachines([{ id: 'x' }], { tag: 'lan' }).length, 0);
  });
});

describe('machineAccessToolDef', () => {
  it('is read-only with optional id/tag args', () => {
    assert.equal(machineAccessToolDef.name, 'machine_access');
    assert.equal(machineAccessToolDef.annotations.readOnlyHint, true);
    assert.deepEqual(Object.keys(machineAccessToolDef.inputSchema.properties).sort(), ['id', 'tag']);
    assert.equal((machineAccessToolDef.inputSchema as { required?: string[] }).required, undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd core && npm run build:test
```
Expected: FAIL — `Cannot find module '../mcp-server/tools/machine-access'`.

- [ ] **Step 3: Write minimal implementation**

`core/src/mcp-server/tools/machine-access.ts`:

```typescript
/**
 * machine_access MCP tool — report the machines reachable FROM this node.
 *
 * Read-only; wraps GET /machine-access via the loopback passthrough so the
 * route stays the single source of truth (cluster_list precedent).
 *
 * Registration: MACHINE_ACCESS_TOOL_DEFS + MACHINE_ACCESS_HANDLERS → expanded.ts.
 * Scope: machine_access:'read' → configure.ts.
 */
import { ok, err, workerGet, type McpToolResult } from './_passthrough';

export const machineAccessToolDef = {
  name: 'machine_access',
  description:
    'List machines reachable FROM this lm-assist node and exactly how to access them: SSH ' +
    'profiles (user/host/port/identity-key PATH) each with a ready-to-run `command`, plus ' +
    'per-machine notes/gotchas (OS quirks, what not to touch). Profiles are NODE-LOCAL — the ' +
    'reported commands must run ON this node (its shell/agent/terminal), not from elsewhere; ' +
    'key material is never stored or returned. Non-ssh access types may appear with ' +
    'supported:false (future: windows-account remote exec). Optional filters: `id`, `tag`. ' +
    'Read-only; manage profiles on the node via loopback REST PUT/DELETE ' +
    '/machine-access/machines/<id> or by editing ~/.lm-assist/machine-access.json.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Return only the machine with this id.' },
      tag: { type: 'string', description: 'Return only machines carrying this tag.' },
    },
  },
};

export const MACHINE_ACCESS_TOOL_DEFS = [machineAccessToolDef] as const;

/** Pure filter (exported for unit tests). */
export function filterMachines<T extends { id?: string; tags?: string[] }>(
  machines: T[],
  opts: { id?: string; tag?: string },
): T[] {
  let out = machines;
  if (opts.id) out = out.filter((m) => m.id === opts.id);
  if (opts.tag) out = out.filter((m) => Array.isArray(m.tags) && m.tags.includes(opts.tag as string));
  return out;
}

interface MachineAccessReport {
  node?: unknown;
  count?: number;
  machines?: Array<{ id?: string; tags?: string[] }>;
  usage?: string;
}

async function handleMachineAccess(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const tag = typeof args.tag === 'string' ? args.tag.trim() : '';
  try {
    const data = await workerGet<MachineAccessReport>('/machine-access');
    const all = Array.isArray(data?.machines) ? data.machines : [];
    const machines = filterMachines(all, { id: id || undefined, tag: tag || undefined });
    if (id && machines.length === 0) {
      return err(`no machine with id "${id}". Available: ${all.map((m) => m.id).join(', ') || '(none registered)'}`);
    }
    return ok(JSON.stringify({ ...data, count: machines.length, machines }, null, 2));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const MACHINE_ACCESS_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  machine_access: handleMachineAccess,
};
```

`core/src/mcp-server/tools/expanded.ts` — three edits:

```typescript
import { MACHINE_ACCESS_TOOL_DEFS, MACHINE_ACCESS_HANDLERS } from './machine-access';
```
(after the `./cluster` import)

```typescript
  // machine access profiles — how to reach other machines FROM this node (read)
  ...MACHINE_ACCESS_TOOL_DEFS,
```
(after `...CLUSTER_TOOL_DEFS,`)

```typescript
  // machine access profiles
  ...MACHINE_ACCESS_HANDLERS,
```
(after `...CLUSTER_HANDLERS,`)

`core/src/mcp-server/configure.ts` — after `cluster_describe: 'write',`:

```typescript
  // machine access profiles — node-local reachability meta (read)
  machine_access: 'read',
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/machine-access-mcp.test.js
```
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add core/src/mcp-server/tools/machine-access.ts core/src/mcp-server/tools/expanded.ts core/src/mcp-server/configure.ts core/src/__tests__/machine-access-mcp.test.ts
git commit -m "feat(machine-access): machine_access MCP read tool (stdio + /mcp)"
```

---

### Task 4: Verification + docs + seed

**Files:**
- Modify: `CLAUDE.md` (add a short section under existing feature blurbs describing the store, routes, MCP tool)
- Runtime (not committed): `~/.lm-assist/machine-access-dev.json` seeded via the dev API

- [ ] **Step 1: Full build + entire test suite**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
./core.sh build
cd core && npm test
```
Expected: build clean; suite result matches the pre-change baseline (same pass/fail set — see `scratchpad/baseline-test.log`).

- [ ] **Step 2: E2E on the dev API**

```bash
./core.sh start   # or restart; dev ports 3200/3948
curl -s -X PUT localhost:3200/machine-access/machines/node-b \
  -H 'content-type: application/json' \
  -d '{"name":"node-b VM (123)","os":"linux","tags":["lan","lm-assist-node"],"notes":"passwordless sudo; Core is systemd (sudo systemctl restart lm-assist)","access":[{"type":"ssh","host":"192.0.2.23","user":"yi","identityFile":"~/.ssh/ssh-keys/id_rsa"}]}'
curl -s localhost:3200/machine-access
```
Expected: PUT → `success:true` with stamped machine; GET → report with `command: "ssh -i ~/.ssh/ssh-keys/id_rsa yi@192.0.2.23"`. Also verify the tool is registered:

```bash
node -e "const {EXPANDED_TOOL_DEFS}=require('./core/dist/mcp-server/tools/expanded'); console.log(EXPANDED_TOOL_DEFS.some(t=>t.name==='machine_access'))"
```
Expected: `true`.

- [ ] **Step 3: Seed this node's real machines (dev file) + CLAUDE.md note + commit docs**

Seed SG hub, JP, node-b, win107 via the same PUT shape (notes from memory: SG "hub-only host — NEVER install lm-assist"; JP "LIVE tick capture — do not disturb"; 107 "PowerShell via -EncodedCommand; Session-1 restart via schtasks; elevated worker 127.0.0.1:3110").

```bash
git add CLAUDE.md
git commit -m "docs(machine-access): CLAUDE.md section for machine access profiles"
```

---

## Self-Review Notes

- Spec coverage: store (Task 1), routes + loopback guard (Task 2), MCP tool + registration + scope (Task 3), verification/seeding/docs (Task 4). Future types documented in store header + tool description — no implementation, per spec non-goals.
- Types consistent: `MachineProfile`/`AccessMethod` defined once in Task 1 and imported by name in Tasks 2–3; report shape `{ node, count, machines, usage }` identical between route (produces) and MCP (consumes).
- No placeholders: every step carries full code/commands.
