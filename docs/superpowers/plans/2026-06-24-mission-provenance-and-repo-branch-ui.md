# Mission Provenance + Repo/Branch Pickers (Wave 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp every Mission with a globally-addressable reference to who created it and who updated it (full attributed trail), and let the Mission UI pick repository + branch from dropdowns.

**Architecture:** A `MissionActor` reference (kind+id+node) captured at create/update. Resolution runs in Core via the existing session-resolver. The mission stays a lean consolidated record; actors are pointers. Repo/branch dropdowns reuse the existing `/ccr/cloud/repos` + `/ccr/cloud/branches` endpoints.

**Tech Stack:** TypeScript (core, CommonJS), node:test; Next.js 16 / React (web).

## Global Constraints

- Core build is CommonJS — no new ESM static imports.
- Mission routes use the bare `{success,data}`/`{success,error}` envelope (NOT `wrapResponse`).
- Resolution is best-effort and **non-fatal**: never throw out of create/update; fall back to a coarse actor.
- Back-compat: persisted missions may lack `createdBy`/`lastUpdatedBy` and adjustments may lack `actor` — reads must backfill, never crash.
- Test command (single file): `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/<file>.test.js`
- Full build before deploy: `./core.sh build` from repo root.

---

### Task 1: MissionActor types + model wiring

**Files:**
- Modify: `core/src/mission/mission-model.ts` (add types after line 35; change `MissionAdjustment`, `Mission`, `newMission`, `NewMissionInput`)
- Test: `core/src/__tests__/mission-model.test.ts` (extend)

**Interfaces:**
- Produces: `ActorKind`, `ActorChannel`, `MissionActor`, `coarseActor(channel, node, now)`, `Mission.createdBy`, `Mission.lastUpdatedBy`, `MissionAdjustment.actor`, `newMission(input, now, genId)` where `NewMissionInput` now requires `createdBy: MissionActor`.

- [ ] **Step 1: Write the failing test** — append to `core/src/__tests__/mission-model.test.ts`:

```ts
import { coarseActor, newMission } from '../mission/mission-model';

test('coarseActor builds a user actor for a plain channel', () => {
  const a = coarseActor('api', 'gw4-x', 1000);
  assert.equal(a.kind, 'user');
  assert.equal(a.channel, 'api');
  assert.equal(a.node, 'gw4-x');
  assert.equal(a.at, 1000);
});

test('coarseActor builds a controller actor for the controller channel', () => {
  assert.equal(coarseActor('controller', 'gw4-x', 1).kind, 'controller');
});

test('newMission stamps createdBy and mirrors it to lastUpdatedBy', () => {
  const who = coarseActor('mcp', 'gw4-n', 5);
  const m = newMission(
    { title: 't', objective: 'o', ownerNode: 'gw4-n', createdBy: who },
    5, () => 'mission_abc',
  );
  assert.deepEqual(m.createdBy, who);
  assert.deepEqual(m.lastUpdatedBy, who);
  assert.deepEqual(m.adjustments, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/mission-model.test.js`
Expected: FAIL (build error: `coarseActor` not exported / `createdBy` missing on `NewMissionInput`).

- [ ] **Step 3: Implement** — in `core/src/mission/mission-model.ts`:

Add after the `MissionAdjustment` interface (line 35):
```ts
export type ActorKind = 'local-session' | 'ccr' | 'claudeai-conversation' | 'controller' | 'user';
export type ActorChannel = 'mcp' | 'controller' | 'user' | 'api';
export interface MissionActor {
  kind: ActorKind;
  id?: string | null;
  node?: string | null;
  channel: ActorChannel;
  label?: string;
  toolUseId?: string | null;
  at: number;
}
/** Fallback actor when the caller can't be resolved to a session/conversation. */
export function coarseActor(channel: ActorChannel, node: string, now: number): MissionActor {
  return { kind: channel === 'controller' ? 'controller' : 'user', channel, node, at: now };
}
```

Change `MissionAdjustment` (line 35) to add `actor`:
```ts
export interface MissionAdjustment { at: number; trigger: string; change: string; by: 'controller' | 'user'; actor: MissionActor; }
```

Add to `Mission` (after `adjustments` line 50):
```ts
  createdBy: MissionActor;
  lastUpdatedBy: MissionActor;
```

Add to `NewMissionInput` (after `ownerNode` line 65):
```ts
  createdBy: MissionActor;
```

In `newMission` return object (after `adjustments: [],` line 94) add:
```ts
    createdBy: input.createdBy,
    lastUpdatedBy: input.createdBy,
```

- [ ] **Step 4: Run test to verify it passes** — same command as Step 2. Expected: PASS. (If other files now fail to compile because they call `newMission` without `createdBy` or push adjustments without `actor`, that is expected — later tasks fix the call sites. To keep this task's build green, also do Step 4b.)

- [ ] **Step 4b: Fix in-repo `newMission` / adjustment call sites to compile** — search `grep -rn "newMission(" core/src` and `grep -rn "adjustments.push\|trigger:" core/src`. For `mission.routes.ts handleCreate` pass `createdBy: coarseActor('api', ownerNode, Date.now())` (Task 4 refines it). For `mission-controller.ts addAdjustment` add `actor: coarseActor('controller', 'unknown', now)` (Task 6 refines it). For `mission.routes.ts handlePatch` adjustment push add `actor: coarseActor('user', 'unknown', Date.now())` (Task 4 refines it). This keeps the tree compiling; later tasks replace the coarse placeholders with real resolution.

- [ ] **Step 5: Commit**
```bash
git add core/src/mission/mission-model.ts core/src/__tests__/mission-model.test.ts core/src/mission/mission-controller.ts core/src/routes/core/mission.routes.ts
git commit -m "feat(mission): MissionActor type + createdBy/lastUpdatedBy + adjustment.actor"
```

---

### Task 2: withActorBackfill + store read path

**Files:**
- Modify: `core/src/mission/mission-model.ts` (add `withActorBackfill`)
- Modify: `core/src/mission/mission-store.ts` (apply in `recordToMission`, line 25-26)
- Test: `core/src/__tests__/mission-provenance-backfill.test.ts` (create)

**Interfaces:**
- Consumes: `MissionActor`, `Mission`, `coarseActor` (Task 1).
- Produces: `withActorBackfill(m: Mission): Mission` (pure; fills missing `createdBy`/`lastUpdatedBy`/adjustment `actor` from `ownerNode`+`by`).

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-provenance-backfill.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { withActorBackfill } from '../mission/mission-model';

test('withActorBackfill synthesizes provenance for a legacy mission', () => {
  const legacy: any = {
    id: 'mission_x', ownerNode: 'gw4-o', createdAt: 7, updatedAt: 9,
    adjustments: [{ at: 8, trigger: 'controller', change: 'c', by: 'controller' }],
  };
  const m = withActorBackfill(legacy);
  assert.equal(m.createdBy.kind, 'user');
  assert.equal(m.createdBy.node, 'gw4-o');
  assert.equal(m.createdBy.at, 7);
  assert.deepEqual(m.lastUpdatedBy, m.createdBy);
  assert.equal(m.adjustments[0].actor.kind, 'controller');
  assert.equal(m.adjustments[0].actor.node, 'gw4-o');
});

test('withActorBackfill preserves present provenance', () => {
  const who: any = { kind: 'ccr', id: 'cse_1', channel: 'mcp', at: 1 };
  const m = withActorBackfill({ id: 'm', ownerNode: 'n', createdAt: 1, updatedAt: 1,
    createdBy: who, lastUpdatedBy: who, adjustments: [] } as any);
  assert.deepEqual(m.createdBy, who);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test dist-test/__tests__/mission-provenance-backfill.test.js`. Expected: FAIL (`withActorBackfill` not exported).

- [ ] **Step 3: Implement** — add to `core/src/mission/mission-model.ts`:

```ts
/** Read-path back-compat: fill any missing provenance on a (possibly legacy) mission record. */
export function withActorBackfill(m: Mission): Mission {
  const node = m.ownerNode ?? 'unknown';
  if (!m.createdBy) m.createdBy = { kind: 'user', channel: 'api', node, at: m.createdAt ?? 0 };
  if (!m.lastUpdatedBy) m.lastUpdatedBy = m.createdBy;
  if (Array.isArray(m.adjustments)) {
    for (const a of m.adjustments) {
      if (!a.actor) {
        const k = a.by === 'controller' ? 'controller' : 'user';
        a.actor = { kind: k, channel: k === 'controller' ? 'controller' : 'user', node, at: a.at };
      }
    }
  }
  return m;
}
```

In `core/src/mission/mission-store.ts` change `recordToMission` (line 25-26):
```ts
function recordToMission(fields: Record<string, unknown>): Mission {
  return withActorBackfill(fields as unknown as Mission);
}
```
Add `withActorBackfill` to the existing import from `../mission/mission-model` (or add an import if none).

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add core/src/mission/mission-model.ts core/src/mission/mission-store.ts core/src/__tests__/mission-provenance-backfill.test.ts
git commit -m "feat(mission): withActorBackfill on the store read path (legacy provenance)"
```

---

### Task 3: resolveMcpActor (resolution seam)

**Files:**
- Create: `core/src/mission/mission-actor.ts`
- Test: `core/src/__tests__/mission-actor.test.ts`

**Interfaces:**
- Consumes: `MissionActor`, `coarseActor` (Task 1); `resolveCallerCandidates` from `../mcp-server/mcp-session-resolver`; `runWithMcpContext` from `../mcp-server/principal-context`.
- Produces: `resolveMcpActor(toolUseId: string | null | undefined, node: string, now: number, deps?: { resolve?: () => Promise<{ claudeAi?: {id:string;label?:string}; claudeCode?: {id:string;label?:string}; precise?: boolean }> }): Promise<MissionActor>`.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-actor.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { resolveMcpActor } from '../mission/mission-actor';

const D = (v: any) => ({ resolve: async () => v });

test('precise Claude Code match -> local-session with node', async () => {
  const a = await resolveMcpActor('toolu_1', 'gw4-n', 5, D({ claudeCode: { id: 'sess-1', label: 'lm-assist' }, precise: true }));
  assert.equal(a.kind, 'local-session');
  assert.equal(a.id, 'sess-1');
  assert.equal(a.node, 'gw4-n');
  assert.equal(a.toolUseId, 'toolu_1');
  assert.equal(a.channel, 'mcp');
});

test('claude.ai candidate -> claudeai-conversation (no node)', async () => {
  const a = await resolveMcpActor('toolu_2', 'gw4-n', 5, D({ claudeAi: { id: 'conv-9', label: 'planning' } }));
  assert.equal(a.kind, 'claudeai-conversation');
  assert.equal(a.id, 'conv-9');
});

test('nothing resolved -> coarse user', async () => {
  const a = await resolveMcpActor('toolu_3', 'gw4-n', 5, D({}));
  assert.equal(a.kind, 'user');
  assert.equal(a.channel, 'mcp');
});

test('resolver throwing -> coarse user, never throws', async () => {
  const a = await resolveMcpActor('toolu_4', 'gw4-n', 5, { resolve: async () => { throw new Error('boom'); } });
  assert.equal(a.kind, 'user');
});

test('no toolUseId -> coarse user without resolving', async () => {
  const a = await resolveMcpActor(undefined, 'gw4-n', 5);
  assert.equal(a.kind, 'user');
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test dist-test/__tests__/mission-actor.test.js`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — `core/src/mission/mission-actor.ts`:

```ts
/** Resolve the MCP caller's identity into a globally-addressable MissionActor. Best-effort; never throws. */
import { MissionActor } from './mission-model';
import { resolveCallerCandidates } from '../mcp-server/mcp-session-resolver';
import { runWithMcpContext } from '../mcp-server/principal-context';

interface Candidates { claudeAi?: { id: string; label?: string }; claudeCode?: { id: string; label?: string }; precise?: boolean }

export async function resolveMcpActor(
  toolUseId: string | null | undefined,
  node: string,
  now: number,
  deps: { resolve?: () => Promise<Candidates> } = {},
): Promise<MissionActor> {
  const coarse: MissionActor = { kind: 'user', channel: 'mcp', node, toolUseId: toolUseId ?? null, at: now };
  if (!toolUseId) return coarse;
  try {
    const resolve = deps.resolve
      ?? (() => runWithMcpContext({ principal: { type: 'local' }, toolUseId }, () => resolveCallerCandidates()));
    const c = await resolve();
    if (c.precise && c.claudeCode) {
      return { kind: 'local-session', id: c.claudeCode.id, node, channel: 'mcp', label: c.claudeCode.label, toolUseId, at: now };
    }
    if (c.claudeAi) {
      return { kind: 'claudeai-conversation', id: c.claudeAi.id, channel: 'mcp', label: c.claudeAi.label, toolUseId, at: now };
    }
    if (c.claudeCode) {
      return { kind: 'local-session', id: c.claudeCode.id, node, channel: 'mcp', label: c.claudeCode.label, toolUseId, at: now };
    }
    return coarse;
  } catch {
    return coarse;
  }
}
```

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS (5/5).

- [ ] **Step 5: Commit**
```bash
git add core/src/mission/mission-actor.ts core/src/__tests__/mission-actor.test.ts
git commit -m "feat(mission): resolveMcpActor — caller identity -> globally-addressable actor"
```

---

### Task 4: Routes stamp the actor

**Files:**
- Modify: `core/src/routes/core/mission.routes.ts` (`handleCreate` line 27, `handlePatch` line 56; both signatures + bodies)
- Test: `core/src/__tests__/mission-provenance-routes.test.ts` (create)

**Interfaces:**
- Consumes: `coarseActor`, `MissionActor` (Task 1); `resolveMcpActor` (Task 3); `thisNode` (mission-store).
- Produces: `handleCreate(b, ownerNode, port?, actor?)`, `handlePatch(id, b, port?, actor?)` — when `actor` omitted they derive it from `b._actor` (mcp hint → `resolveMcpActor`, else `coarseActor('user',…)`); `_actor` is stripped before field application.

- [ ] **Step 1: Write the failing test** — `core/src/__tests__/mission-provenance-routes.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { handleCreate, handlePatch } from '../routes/core/mission.routes';
import type { Mission } from '../mission/mission-model';

function memPort() {
  const db = new Map<string, Mission>();
  return { db, get: async (id: string) => db.get(id) ?? null, list: async () => [...db.values()], put: async (m: Mission) => { db.set(m.id, m); } };
}
const ccrActor = { kind: 'ccr' as const, id: 'cse_1', channel: 'mcp' as const, at: 1 };

test('create stamps the provided actor as createdBy', async () => {
  const port = memPort();
  const r = await handleCreate({ title: 't', objective: 'o' }, 'gw4-n', port as any, ccrActor);
  assert.equal((r.data as Mission).createdBy.id, 'cse_1');
  assert.equal((r.data as Mission).lastUpdatedBy.id, 'cse_1');
});

test('_actor in body never leaks into mission fields', async () => {
  const port = memPort();
  const r = await handleCreate({ title: 't', objective: 'o', _actor: { channel: 'mcp', toolUseId: 'x' } } as any, 'gw4-n', port as any, ccrActor);
  assert.ok(!('_actor' in (r.data as any)));
});

test('patch sets lastUpdatedBy and appends an attributed adjustment', async () => {
  const port = memPort();
  await handleCreate({ title: 't', objective: 'o' }, 'gw4-n', port as any, ccrActor);
  const id = (await port.list())[0].id;
  const userActor = { kind: 'user' as const, channel: 'user' as const, node: 'gw4-n', at: 2 };
  const r = await handlePatch(id, { title: 't2' }, port as any, userActor);
  const m = r.data as Mission;
  assert.equal(m.lastUpdatedBy.kind, 'user');
  assert.equal(m.adjustments[m.adjustments.length - 1].actor.kind, 'user');
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test dist-test/__tests__/mission-provenance-routes.test.js`. Expected: FAIL (signatures don't accept `actor`; `_actor` leaks / createdBy wrong).

- [ ] **Step 3: Implement** — in `core/src/routes/core/mission.routes.ts`:

Add imports: `import { coarseActor, MissionActor } from '../../mission/mission-model';` and `resolveMcpActor` from `'../../mission/mission-actor'`, and ensure `thisNode` is imported from `../../mission/mission-store`.

Add a helper near the top:
```ts
async function actorFor(b: Record<string, unknown>): Promise<MissionActor> {
  const hint = b._actor as { channel?: string; toolUseId?: string | null } | undefined;
  delete (b as any)._actor;
  if (hint && hint.channel === 'mcp') return resolveMcpActor(hint.toolUseId, thisNode(), Date.now());
  return coarseActor('user', thisNode(), Date.now());
}
```

Change `handleCreate` signature + body:
```ts
export async function handleCreate(b: Record<string, unknown>, ownerNode: string, port?: MissionDataPort, actor?: MissionActor): Promise<Envelope> {
  const who = actor ?? await actorFor(b);
  const title = str(b.title);
  const objective = str(b.objective);
  if (!title || !objective) return fail('INVALID_INPUT', 'title and objective are required');
  const env = (b.env && typeof b.env === 'object') ? b.env as Record<string, unknown> : {};
  const m = newMission({
    title, objective, ownerNode, createdBy: who,
    projects: arr(b.projects), dependsOn: arr(b.dependsOn),
    plan: str(b.plan), nextSteps: arr(b.nextSteps),
    env: { /* unchanged */ isolation: (str(env.isolation) as Isolation) ?? 'cloud', host: str(env.host), repo: str(env.repo), branch: str(env.branch), resources: arr(env.resources) ?? [], exclusive: env.exclusive === true || env.exclusive === 'true' },
  }, Date.now(), genId);
  await putMission(m, port);
  return ok(m);
}
```

Change `handlePatch` signature + the adjustment push + add lastUpdatedBy:
```ts
export async function handlePatch(id: string, b: Record<string, unknown>, port?: MissionDataPort, actor?: MissionActor): Promise<Envelope> {
  const who = actor ?? await actorFor(b);
  const m = await getMission(id, port);
  if (!m) return fail('NOT_FOUND', `no mission ${id}`);
  // ... existing field-application block unchanged ...
  m.lastUpdatedBy = who;
  m.adjustments.push({ at: Date.now(), trigger: 'user-edit', change: 'mission updated via API', by: 'user', actor: who });
  await putMission(m, port);
  return ok(m);
}
```
(Keep the existing field-application block between `getMission` and the adjustment push exactly as-is; only the signature, the `who` line, the `lastUpdatedBy` line, and the `actor:` on the pushed adjustment change.)

The route registrations (lines 105, 116, 118) keep calling `handleCreate((req.body||{})…, thisNode())` and `handlePatch(req.params.id, (req.body||{})…)` — no `actor` arg, so they derive from `_actor`. No change needed there.

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS (3/3).

- [ ] **Step 5: Commit**
```bash
git add core/src/routes/core/mission.routes.ts core/src/__tests__/mission-provenance-routes.test.ts
git commit -m "feat(mission): routes resolve + stamp createdBy/lastUpdatedBy/adjustment actor"
```

---

### Task 5: MCP tools attach the `_actor` hint

**Files:**
- Modify: `core/src/mcp-server/tools/mission.ts` (`mission_create`, `mission_update`; add `withActorHint` + `currentMcpContext` import)
- Test: `core/src/__tests__/mission-mcp.test.ts` (extend)

**Interfaces:**
- Consumes: `currentMcpContext` from `../principal-context`.
- Produces: pure `withActorHint(args, toolUseId): Record<string,unknown>` returning `{...args, _actor:{channel:'mcp', toolUseId: toolUseId ?? null}}`.

- [ ] **Step 1: Write the failing test** — append to `core/src/__tests__/mission-mcp.test.ts`:

```ts
import { withActorHint } from '../mcp-server/tools/mission';

test('withActorHint attaches an mcp _actor with the toolUseId', () => {
  const out = withActorHint({ title: 't' }, 'toolu_9');
  assert.deepEqual((out as any)._actor, { channel: 'mcp', toolUseId: 'toolu_9' });
  assert.equal((out as any).title, 't');
});

test('withActorHint tolerates a missing toolUseId', () => {
  assert.equal(((withActorHint({}, undefined) as any)._actor).toolUseId, null);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test dist-test/__tests__/mission-mcp.test.js`. Expected: FAIL (`withActorHint` not exported).

- [ ] **Step 3: Implement** — in `core/src/mcp-server/tools/mission.ts`:

Add import: `import { currentMcpContext } from '../principal-context';`

Add exported helper:
```ts
export function withActorHint(args: Record<string, unknown>, toolUseId: string | undefined): Record<string, unknown> {
  return { ...args, _actor: { channel: 'mcp', toolUseId: toolUseId ?? null } };
}
```

In `mission_create` handler, change the body:
```ts
  mission_create: async (a) => {
    try {
      return pretty(await workerPost('/mission', withActorHint(a, currentMcpContext()?.toolUseId)));
    } catch (e) { return err((e as Error).message); }
  },
```

In `mission_update` handler:
```ts
  mission_update: async (a) => {
    try {
      const id = String(a.id || '');
      if (!id) return err('id is required');
      return pretty(await workerPost(`/mission/${encodeURIComponent(id)}`, withActorHint(a, currentMcpContext()?.toolUseId)));
    } catch (e) { return err((e as Error).message); }
  },
```

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add core/src/mcp-server/tools/mission.ts core/src/__tests__/mission-mcp.test.ts
git commit -m "feat(mission): MCP create/update attach _actor caller hint"
```

---

### Task 6: Controller stamps the actor

**Files:**
- Modify: `core/src/mission/mission-controller.ts` (`addAdjustment` line 35-37; import `thisNode` + `coarseActor`)
- Test: `core/src/__tests__/mission-controller.test.ts` (extend)

**Interfaces:**
- Consumes: `Mission`, `MissionActor`, `coarseActor` (Task 1); `thisNode` (mission-store).
- Produces: `addAdjustment` now also stamps `actor` (kind `ccr` when the mission has a `binding.ccr`, else `controller`) and sets `m.lastUpdatedBy`.

- [ ] **Step 1: Write the failing test** — append to `core/src/__tests__/mission-controller.test.ts` (import `addAdjustment` if exported; if not, export it):

```ts
import { addAdjustment } from '../mission/mission-controller';

test('addAdjustment stamps a controller actor + lastUpdatedBy', () => {
  const m: any = { binding: null, adjustments: [], lastUpdatedBy: undefined };
  addAdjustment(m, 100, 'blocked', 'why');
  const adj = m.adjustments[0];
  assert.equal(adj.by, 'controller');
  assert.equal(adj.actor.kind, 'controller');
  assert.equal(adj.actor.channel, 'controller');
  assert.equal(m.lastUpdatedBy.kind, 'controller');
});

test('addAdjustment uses ccr kind when the mission has a ccr binding', () => {
  const m: any = { binding: { ccr: { sid: 'session_z' } }, adjustments: [], lastUpdatedBy: undefined };
  addAdjustment(m, 1, 'revise', 'c');
  assert.equal(m.adjustments[0].actor.kind, 'ccr');
  assert.equal(m.adjustments[0].actor.id, 'session_z');
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test dist-test/__tests__/mission-controller.test.js`. Expected: FAIL (`addAdjustment` not exported / no `actor`).

- [ ] **Step 3: Implement** — in `core/src/mission/mission-controller.ts`:

Ensure `thisNode` is imported from `./mission-store` and `MissionActor` from `./mission-model`. Replace `addAdjustment` (line 35-37):
```ts
export function addAdjustment(m: Mission, now: number, trigger: string, change: string): void {
  const node = thisNode();
  const ccr = m.binding?.ccr;
  const actor: MissionActor = ccr
    ? { kind: 'ccr', id: ccr.sid, node, channel: 'controller', at: now }
    : { kind: 'controller', id: m.binding?.sessionId ?? null, node, channel: 'controller', at: now };
  m.adjustments.push({ at: now, trigger, change, by: 'controller', actor });
  m.lastUpdatedBy = actor;
}
```

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS. Also run the full mission suite to confirm no regression: `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec "dist-test/__tests__/mission-*.test.js"`.

- [ ] **Step 5: Commit**
```bash
git add core/src/mission/mission-controller.ts core/src/__tests__/mission-controller.test.ts
git commit -m "feat(mission): controller stamps controller/ccr actor on each adjustment"
```

---

### Task 7: Web UI — repo/branch dropdowns + provenance display

**Files:**
- Modify: `web/src/components/missions/MissionsPage.tsx`
- (No unit test — web verification is `next build` + browser e2e, matching this repo's mission-UI convention.)

**Interfaces:**
- Consumes: the existing api client used elsewhere in `MissionsPage.tsx` (the same `apiFetch`/`fetchPath` the page already builds for `CcrCloudView`); endpoints `GET /ccr/cloud/repos` → `{repos: string[]}` (or `{repos:[{slug|full_name}]}` — read `repos` and map to a string label), `GET /ccr/cloud/branches?repo=<repo>` → `{branches: string[]}`. Mission fields `createdBy`, `lastUpdatedBy`, `adjustments[].actor` from `GET /mission`.

- [ ] **Step 1: Repo/branch dropdowns in the create/edit form**

Replace the `env.repo` and `env.branch` text `<input>`s with `<select>`s:
- On form open, `apiFetch('/ccr/cloud/repos')` → store `repos`. Render `<select value={env.repo} onChange=…>` with an option per repo plus a trailing `<option value="__custom__">— custom —</option>`.
- When a repo is chosen (non-custom), `apiFetch('/ccr/cloud/branches?repo=' + encodeURIComponent(repo))` → store `branches`; render the branch `<select>` similarly (plus `— custom —`).
- Selecting `— custom —` reveals the original free-text input for that field (keep the prior text-input JSX behind a `customRepo`/`customBranch` boolean).
- If the repos fetch fails or returns empty → render the text inputs (fallback). Wrap fetches in try/catch; show a small inline "couldn't load repos — type manually" note on failure.

- [ ] **Step 2: Provenance display per mission**

In the mission row/detail, render:
- `Created by {labelOf(m.createdBy)}` where `labelOf(a)` = `a.label || a.id || a.kind` prefixed with the channel (e.g. `mcp · claude.ai: planning`).
- A collapsible "Contributors (N)" section listing `m.adjustments` as `new Date(adj.at).toLocaleString() · {adj.actor.channel} · {labelOf(adj.actor)} — {adj.change}`.
- Make each actor a link when resolvable: `ccr` → reuse the existing `CcrCloudView` open path (same as the page's Connect button, using `actor.id` as the sid); `claudeai-conversation` → `<a href={\`https://claude.ai/chat/\${actor.id}\`} target="_blank">`; `local-session` → the existing session view link the page already uses (carry `actor.node`); `controller`/`user` → plain text with the node.

- [ ] **Step 3: Verify build**

Run: `cd /home/ubuntu/lm-assist && nvm use 20 >/dev/null 2>&1; (cd web && npx next build 2>&1 | tail -20)`
Expected: build completes (no type errors in `MissionsPage.tsx`).

- [ ] **Step 4: Commit**
```bash
git add web/src/components/missions/MissionsPage.tsx
git commit -m "feat(web): mission repo/branch dropdowns + provenance (created-by + contributor trail)"
```

---

## Final verification (after all tasks; pre-deploy)

- [ ] `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec "dist-test/__tests__/mission-*.test.js"` → all green.
- [ ] `./core.sh build` (full core compile) → clean.
- [ ] Web build clean (Task 7 Step 3).
- [ ] Deploy via the established GitHub-Release + `lm-assist upgrade --from` mechanism (bump to a `0.1.77-mc.2` pre-release), then e2e per the spec's Verification section on 117 prod (`missionControllerEnabled` already true; provenance is passive — no autonomous risk).

## Self-Review notes

- **Spec coverage:** data model (T1), resolution (T3), capture MCP (T5) + routes (T4), controller (T6), back-compat (T2), UI dropdowns + provenance (T7), tests (each task). All spec sections mapped.
- **Type consistency:** `MissionActor` shape identical across T1/T2/T3/T4/T6; `resolveMcpActor` signature matches its T3 def and T4 call; `withActorHint`/`_actor` shape matches T4's `actorFor` reader; `addAdjustment` signature unchanged (callers untouched).
- **Placeholder scan:** none — every code step is concrete; T1 Step 4b explicitly fixes call sites so the tree compiles between tasks.
