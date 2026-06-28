# MCP Fleet / Connector Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the lm-assist MCP surfaces (bootstrap, session_status, guide) and the Mission-Controller prompt dynamically state which fleet this connector serves (hub URL + node + cluster) and warn that other connectors are other fleets — so an LLM with multiple connectors stops cross-routing node-targeted calls.

**Architecture:** One pure-ish helper `fleetIdentity()` derives the block from `getHubConfig()` + `getMyCluster()` (no network, never throws); four surfaces embed it; the bootstrap copy drops the hardcoded "langmart" name.

**Tech Stack:** TypeScript (CommonJS), `node:test` + `node:assert/strict`. Build: `cd core && npx tsc --noEmit`; tests `cd core && npm run build:test && node --test dist-test/__tests__/<file>.js`.

## Global Constraints

- Tests use `node:test` + `node:assert/strict` (NOT vitest).
- **No hardcoded connector names** in any emitted instruction. The hub URL is derived at runtime from `getHubConfig().hubUrl`; the helper template must contain no literal "langmart" / "xeenhub".
- `fleetIdentity()` must NEVER throw — guard every lookup; degrade to a minimal block.
- Reuse the ONE helper in every surface (DRY) — do not re-write the block text per surface.
- `git add <specific files>` only — never `git add -A`/`.` (untracked session strays exist).

---

### Task 1: `fleetIdentity()` helper + tests

**Files:**
- Create: `core/src/mcp-server/fleet-identity.ts`
- Test: `core/src/__tests__/fleet-identity.test.ts`

**Interfaces:**
- Consumes: `getHubConfig()` from `../hub-client/hub-config` (`{ hubUrl: string; hostname: string; gatewayId: string | null }`); `getMyCluster()` from `../cluster/cluster-config` (sync, returns string).
- Produces: `hubHostOf(hubUrl?: string|null): string|null`; `formatFleetIdentity(p: FleetIdentityParts): string`; `fleetIdentity(): string`; `interface FleetIdentityParts { hubHost: string|null; hostname: string; gatewayId: string|null; cluster: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
// core/src/__tests__/fleet-identity.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubHostOf, formatFleetIdentity } from '../mcp-server/fleet-identity';

test('hubHostOf normalizes wss URL to bare host', () => {
  assert.equal(hubHostOf('wss://assist-api.langmart.ai'), 'assist-api.langmart.ai');
  assert.equal(hubHostOf('wss://assist-api.xeenhub.com/ws'), 'assist-api.xeenhub.com');
  assert.equal(hubHostOf(''), null);
  assert.equal(hubHostOf(undefined), null);
});

test('formatFleetIdentity emits hub host, cluster + the multi-connector caveat', () => {
  const block = formatFleetIdentity({ hubHost: 'assist-api.langmart.ai', hostname: 'ubuntu-Virtual-Machine', gatewayId: 'gw4-332c6620-92db', cluster: 'default' });
  assert.match(block, /assist-api\.langmart\.ai/);
  assert.match(block, /cluster: default/);
  assert.match(block, /ubuntu-Virtual-Machine/);
  assert.match(block, /OTHER lm-assist MCP connectors/);
  assert.match(block, /BAD_NODE/);
  assert.match(block, /list_nodes/);
});

test('formatFleetIdentity with no hub falls back to local-only but keeps the caveat', () => {
  const block = formatFleetIdentity({ hubHost: null, hostname: 'h', gatewayId: null, cluster: 'default' });
  assert.match(block, /local-only/);
  assert.match(block, /OTHER lm-assist MCP connectors/);
});

test('the helper template hardcodes NO connector name', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../src/mcp-server/fleet-identity.ts', import.meta.url), 'utf8')).catch(() => '');
  // (run from dist-test; the source guard is also covered by the bootstrap test in Task 2)
  const block = formatFleetIdentity({ hubHost: 'X', hostname: 'h', gatewayId: 'g', cluster: 'c' });
  assert.doesNotMatch(block, /langmart|xeenhub/);
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found): `cd core && npm run build:test` will error on the missing import.

- [ ] **Step 3: Implement `fleet-identity.ts`**

```ts
// core/src/mcp-server/fleet-identity.ts
// Dynamic "which fleet does THIS connector serve" identity, surfaced to the LLM
// so multi-connector accounts don't cross-route node-targeted calls. No hardcoded names.
import { getHubConfig } from '../hub-client/hub-config';
import { getMyCluster } from '../cluster/cluster-config';

export interface FleetIdentityParts {
  hubHost: string | null;
  hostname: string;
  gatewayId: string | null;
  cluster: string;
}

/** Normalize a hub URL (wss://host/path) to its bare host, or null. */
export function hubHostOf(hubUrl: string | undefined | null): string | null {
  if (!hubUrl) return null;
  try {
    const u = new URL(hubUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:'));
    return u.host || null;
  } catch {
    const bare = hubUrl.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0];
    return bare || null;
  }
}

/** PURE — build the fleet-identity instruction block from resolved parts. */
export function formatFleetIdentity(p: FleetIdentityParts): string {
  const hub = p.hubHost ?? '(no hub configured — local-only)';
  const gw = p.gatewayId ? `${p.gatewayId.slice(0, 12)}…` : '?';
  return [
    'FLEET / CONNECTOR IDENTITY — this lm-assist MCP connector serves ONE fleet:',
    `  hub: ${hub}   ·   this node: ${p.hostname} (${gw}) · cluster: ${p.cluster}`,
    "  Reachable nodes = THIS connector's `list_nodes` only.",
    '  If you have OTHER lm-assist MCP connectors, EACH serves a DIFFERENT fleet (a different hub):',
    "  their nodes are NOT in this connector's `list_nodes`, and hostnames can COLLIDE across fleets.",
    '  A node-targeted call routes to THIS fleet. Before a node-scoped WRITE, confirm the target appears',
    "  in this `list_nodes`; a BAD_NODE error = the node isn't in this fleet → you're on the wrong connector for it.",
  ].join('\n');
}

/** Resolve the fleet identity from lm-assist's own runtime config. NEVER throws. */
export function fleetIdentity(): string {
  let parts: FleetIdentityParts = { hubHost: null, hostname: 'this node', gatewayId: null, cluster: 'default' };
  try {
    const cfg = getHubConfig();
    parts = { hubHost: hubHostOf(cfg.hubUrl), hostname: cfg.hostname || 'this node', gatewayId: cfg.gatewayId, cluster: 'default' };
  } catch { /* config unavailable — minimal block */ }
  try { parts.cluster = getMyCluster(); } catch { /* default */ }
  return formatFleetIdentity(parts);
}
```

- [ ] **Step 4: Run — expect PASS**: `cd core && npm run build:test && node --test dist-test/__tests__/fleet-identity.test.js`
- [ ] **Step 5: Commit** — `git add core/src/mcp-server/fleet-identity.ts core/src/__tests__/fleet-identity.test.ts && git commit -m "feat(mcp): fleetIdentity() dynamic fleet/connector identity helper"`

---

### Task 2: Wire into `bootstrap` + drop the hardcoded "langmart"

**Files:**
- Modify: `core/src/mcp-server/tools/guide.ts` (the `BOOTSTRAP`/index copy ~line 411 + the `bootstrap` assembly ~line 509-510)
- Test: `core/src/__tests__/fleet-identity-bootstrap.test.ts`

**Interfaces:** Consumes `fleetIdentity()` from Task 1.

- [ ] **Step 1: Find the hardcode.** In `guide.ts`, the index instruction begins `'You are connected to lm-assist over the langmart MCP connector. …'`. Change `the langmart MCP connector` → `the lm-assist MCP connector` (verbatim, that exact phrase). Scan the whole file for any other literal `langmart MCP connector` and apply the same change.

- [ ] **Step 2: Prepend the block in `bootstrap`.** At the assembly (`const [auth, cluster] = await Promise.all([...]); return ok(BOOTSTRAP + auth + cluster);`), add `import { fleetIdentity } from '../fleet-identity';` and change the return to `return ok(fleetIdentity() + '\n\n' + BOOTSTRAP + auth + cluster);`.

- [ ] **Step 3: Test** — assert bootstrap output starts with the fleet block and the copy no longer hardcodes the name:

```ts
// core/src/__tests__/fleet-identity-bootstrap.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fleetIdentity } from '../mcp-server/fleet-identity';

test('fleetIdentity is non-empty + carries the caveat', () => {
  assert.match(fleetIdentity(), /FLEET \/ CONNECTOR IDENTITY/);
});

test('guide.ts no longer hardcodes "langmart MCP connector"', () => {
  const src = fs.readFileSync(__dirname + '/../../src/mcp-server/tools/guide.ts', 'utf8');
  assert.doesNotMatch(src, /langmart MCP connector/);
});
```
(Note: `__dirname` in `dist-test/__tests__` → resolve up to repo `core/src`. If the relative path differs, compute it from `process.cwd()` — the test runs from `core/`.)

- [ ] **Step 4: Run** `npx tsc --noEmit` (clean) + the new test (PASS).
- [ ] **Step 5: Commit** — `git add core/src/mcp-server/tools/guide.ts core/src/__tests__/fleet-identity-bootstrap.test.ts && git commit -m "feat(mcp): bootstrap prepends fleet identity + drop hardcoded connector name"`

---

### Task 3: `guide("connectors")` topic + cross-node pointer

**Files:** Modify: `core/src/mcp-server/tools/guide.ts` (topics map + index list + the `cross-node` topic).

**Interfaces:** Consumes `fleetIdentity()`.

- [ ] **Step 1: Add the topic.** In the topic registry (where `clusters`, `cross-node` topics are defined), add a `connectors` entry whose body is:

```
fleetIdentity() output, then:

CONNECTORS (multi-fleet): Each lm-assist MCP connector = ONE fleet (one hub). `list_nodes`
is the authoritative membership for THIS fleet. Other connectors you have are OTHER fleets —
you cannot reach their nodes from here, and a hostname may exist in more than one fleet.
RULE: a node-targeted tool routes to THIS fleet; before a node-scoped WRITE (cluster_assign,
agent_execute@node, terminal on a node, transfer), confirm the node is in this `list_nodes`.
A BAD_NODE / "no online node matches" error means it's NOT in this fleet — switch to that
fleet's connector. Cluster ops (cluster_assign/list/unassign) only affect THIS fleet.
```

Build the body as `fleetIdentity() + '\n\n' + '<the CONNECTORS text above>'`.

- [ ] **Step 2: Index + cross-node pointer.** Add `connectors` to the topic index list (next to `cross-node`/`nodes`) with a one-line summary ("which fleet this connector serves; multi-connector disambiguation"). In the `cross-node` topic body, append one line: `Multiple lm-assist connectors? Each is a separate fleet — see guide("connectors").`

- [ ] **Step 3: Test:**

```ts
// core/src/__tests__/fleet-identity-guide.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGuide } from '../mcp-server/tools/guide'; // use the real guide entry (match existing guide tests' import)

test('guide("connectors") returns the fleet identity + multi-fleet rule', async () => {
  const out = await runGuide({ topic: 'connectors' }); // adapt to the actual guide handler signature
  const text = typeof out === 'string' ? out : JSON.stringify(out);
  assert.match(text, /FLEET \/ CONNECTOR IDENTITY/);
  assert.match(text, /CONNECTORS \(multi-fleet\)/);
  assert.match(text, /BAD_NODE|no online node matches/);
});
```
(Adapt the import/handler name to how the existing `cluster-guide.test.ts` calls the guide — read it first and mirror it.)

- [ ] **Step 4: Run** tsc + the test (PASS).
- [ ] **Step 5: Commit** — `git add core/src/mcp-server/tools/guide.ts core/src/__tests__/fleet-identity-guide.test.ts && git commit -m "feat(mcp): guide(\"connectors\") topic + cross-node pointer"`

---

### Task 4: `session_status` embeds the fleet identity

**Files:** Modify: `core/src/mcp-server/mcp-session-resolver.ts` (`handleSessionStatus` ~line 234-240, which already merges `clusterInfo`).

**Interfaces:** Consumes `fleetIdentity()`.

- [ ] **Step 1:** Add `import { fleetIdentity } from './fleet-identity';`.
- [ ] **Step 2:** In the session-status assembly that already prepends `identityHeader(c)` and includes `clusterInfo`, also include the fleet block — prepend `fleetIdentity() + '\n\n'` to the returned text (so a session sees its fleet first, then identity, then cluster). Keep it additive; do not remove the existing identity/cluster output.
- [ ] **Step 3: Test:**

```ts
// core/src/__tests__/fleet-identity-session-status.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fleetIdentity } from '../mcp-server/fleet-identity';

test('fleetIdentity usable in session_status (smoke — non-empty, has caveat)', () => {
  assert.match(fleetIdentity(), /OTHER lm-assist MCP connectors/);
});
```
(Plus: if `mcp-session-resolver` has an existing unit test for `handleSessionStatus`, add an assertion there that the output contains `FLEET / CONNECTOR IDENTITY`. Otherwise the tsc build + the smoke test suffice — note this is the `_passthrough`-to-:3100 caveat: route-level session_status is best validated on a running prod, but the text embedding is pure.)

- [ ] **Step 4: Run** tsc (clean) + the smoke test (PASS).
- [ ] **Step 5: Commit** — `git add core/src/mcp-server/mcp-session-resolver.ts core/src/__tests__/fleet-identity-session-status.test.ts && git commit -m "feat(mcp): session_status reports the fleet/connector identity"`

---

### Task 5: Mission-Controller system prompt carries the fleet identity

**Files:** Modify: `core/src/mission/mission-controller.ts` (`CONTROLLER_SYSTEM_PROMPT` + the controller-launch path that already calls `getMyCluster()` for the label, ~line 857).

**Interfaces:** Consumes `fleetIdentity()`.

- [ ] **Step 1:** Add `import { fleetIdentity } from '../mcp-server/fleet-identity';`.
- [ ] **Step 2:** Where the controller's system prompt is assembled for launch (the same place the label `Mission Controller · <host> · <cluster>` is built), prepend `fleetIdentity() + '\n\n'` to the system prompt text passed to the executor (so the controller knows its fleet + cluster boundary). If `CONTROLLER_SYSTEM_PROMPT` is a module const, inject at launch (concatenate `fleetIdentity()` + the const) rather than mutating the const. Keep the existing cluster-placement instructions intact.
- [ ] **Step 3: Test:** assert the launch-time prompt builder includes the fleet block. If the controller prompt is assembled by a pure function, test it directly:

```ts
// core/src/__tests__/fleet-identity-controller-prompt.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fleetIdentity } from '../mcp-server/fleet-identity';

test('controller prompt can carry the fleet identity', () => {
  const prompt = fleetIdentity() + '\n\n' + 'CONTROLLER...';
  assert.match(prompt, /FLEET \/ CONNECTOR IDENTITY/);
});
```
(If the controller-prompt assembly is inline in the launch call, a pure unit test is not available — rely on tsc + the existing `mission-controller` prompt test if present; mirror its style. Note the cluster line added earlier proves the launch path can read `getMyCluster()`, so `fleetIdentity()` is safe there.)

- [ ] **Step 4: Run** tsc (clean) + the test (PASS).
- [ ] **Step 5: Commit** — `git add core/src/mission/mission-controller.ts core/src/__tests__/fleet-identity-controller-prompt.test.ts && git commit -m "feat(mission): controller system prompt carries the fleet/connector identity"`

---

## Self-Review

- **Spec coverage:** helper (Task 1) ✓; bootstrap + drop-hardcode (Task 2) ✓; guide connectors topic (Task 3) ✓; session_status (Task 4) ✓; mission-controller prompt (Task 5) ✓; awareness+verify-on-write rule = the helper/topic text ✓; no-hardcoded-name = Task 1 + Task 2 guard tests ✓.
- **Deviation from spec:** `fleetIdentity()` is **sync** (not async) — the node-count was dropped (YAGNI; `list_nodes` is the membership source), and `getHubConfig`/`getMyCluster` are sync, so no network/await is needed. This simplifies wiring into the sync controller-launch path.
- **Type consistency:** `fleetIdentity(): string`, `formatFleetIdentity(FleetIdentityParts): string`, `hubHostOf(string|null|undefined): string|null` — used identically in Tasks 2-5.
- **Reviewer note:** the test convention is `node:test` (NOT vitest) — do not "fix" that.
