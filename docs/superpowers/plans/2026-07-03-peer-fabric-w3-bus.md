# Peer Fabric — Wave 3 (The Bus) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the durable cross-node message bus (spec §5 S1) on top of the shipped W2 fabric — an append-only per-node topic log (`bus.lmdb`) with per-origin monotonic sequence, idempotent replica ingest, `pub` fan-out to bus-capable peers over the fabric, durable in-process subscriber cursors, catch-up on link recovery, retention/compaction, a long-poll `bus_*` MCP surface, an SSE bridge, a status provider, and a `busEnabled` kill-switch.

**Architecture:** A new `core/src/bus/` subsystem. `BusStore` wraps LMDB (`bus.lmdb`, dev/prod-separated) with three sub-dbs — `events` keyed `[topic, origin, seq]`, `heads` keyed `[topic, origin]→seq` (monotonic sequence + fast max-cursor), and `cursors` keyed `[subscriberId, topic]→{origin→seq}` (durable subscriber position). The `Bus` singleton owns publish (local append → fan-out), idempotent `ingest`, in-process `subscribe` with durable cursor advance, a stateless long-poll `read`, `since` catch-up, and a local `EventEmitter` (drives SSE + long-poll wakeups). W3 is the **first production fabric client**: it wires the dormant `pub` path — `fabric-link.ts` inbound `pub` frames now dispatch to a `Bus.ingestFromWire` handler; a `fabricPublish` helper fires `pub` envelopes fire-and-forget to `peerHasFeature('bus')` peers; and catch-up rides `fabricRequestManaged` to a `POST /bus/:topic/since` route (reachable under `busEnabled` via a scoped rpc-server allow-list, so the bus never depends on the default-off general RPC class). Spec: `docs/superpowers/specs/2026-07-02-peer-fabric-bus-data-design.md` (§5 S1 + the W3 row of §6). Builds on shipped `core/src/fabric/` (`FabricLink`, `fabricRequestManaged`, `peerHasFeature`, `attachFabricLink`).

**Tech Stack:** TypeScript (CommonJS build), `node:test` + `assert/strict`, `lmdb@^3.5.1` (already a dep; array/tuple keys via default ordered-binary key encoding, `encoding:'msgpack'` values — the exact idiom in `core/src/memory-cache-store.ts`). No new dependencies. Fabric envelope bodies use the existing `@msgpack/msgpack` codec via `encodeBody`/`decodeBody` (already loaded through W2's ESM import trap).

## Global Constraints

- Branch: `feat/peer-fabric-w3-bus` (already checked out; work on it).
- **`busEnabled` kill-switch** (spec W3 row) — new `getProjectSettings().busEnabled`, **default `true`**. It is wire-additive and capability-gated (fan-out only reaches peers that advertised the `bus` HELLO feature, which only W3+ nodes do), nothing publishes until a caller invokes `bus_publish`/the API, and the W3 live e2e needs it on — so `true` is the safe default (mirrors `fabricEnabled: true`). It gates publish, fan-out, inbound ingest, subscribe, and catch-up. Flip to `false` to fully silence the bus.
- **NO hub (LangMartDesign) changes. NO `core/src/transport/` changes** — reuse the frozen `Channel` and the shipped W2 `FabricLink`.
- **Reuse the W2 fabric for reliable delivery:** cross-node catch-up MUST call `fabricRequestManaged` (NOT bare `fabricRequest` — it has no retry). Outbound fan-out + catch-up MUST gate on the peer feature (`peerHasFeature('bus')`) so a peer without the bus feature is simply not contacted (no regression). This is where the dormant W2 fabric client gets wired.
- **Every new MCP tool MUST get a `TOOL_SCOPES` entry** in `core/src/mcp-server/configure.ts` or Core crashes on the first `/mcp` request (`assertScopesCoverTools`). W3 adds exactly three: `bus_publish: 'write'`, `bus_read: 'read'`, `bus_topics: 'read'`.
- **Fan-out is CLUSTER-scoped by default.** W1's peer list (`listOnlineNodeIds()`) is already cluster-filtered, so `fabricLinks` only ever holds same-cluster peers — cluster scoping is inherited by construction. `scope:'fleet'` is threaded onto the event for fleet topics; true cross-cluster delivery is deferred (see Deferred) since W1 establishes no cross-cluster links.
- **Dev/prod-separated `bus.lmdb`** via `getCacheDir('bus')` (`~/.lm-assist/bus` prod, `~/.lm-assist/bus-dev` dev — the exact rule `getCacheDir` already applies). **Env-tunable retention with safe defaults:** `LM_BUS_RETENTION_EVENTS` (default `10000` per topic), `LM_BUS_RETENTION_DAYS` (default `7`). **Payload cap 64KB** — a larger inline payload is rejected; the event carries a `ref` (`{kind:'dataset'|'bulk', id}`) instead.
- **Wire-additive / mixed-version interop:** the `bus` HELLO feature + `pub` frame are opt-in. A W1/W2/legacy peer that did not advertise `bus` is never fanned-out-to and never catch-up-queried. The W3 e2e MUST include one non-bus peer to prove no regression.
- **Build:** `cd /home/ubuntu/lm-assist && ./core.sh build` (core TS → `core/dist`).
- **Tests:** `cd /home/ubuntu/lm-assist/core && npm run build:test` compiles `tsconfig.test.json` → `dist-test/`; run a single file with the FULL node path:
  `~/.nvm/versions/node/v20.19.6/bin/node --test --test-reporter=spec dist-test/__tests__/bus/<name>.test.js`
- Commit after every task. End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## File Structure (what W3 creates/modifies)

```
core/src/bus/types.ts                 NEW  BusEvent/BusRef/BusCursor + globalId + cursor encode/decode/merge + payload cap
core/src/bus/bus-store.ts             NEW  LMDB store: events[topic,origin,seq] + heads + durable cursors; append/ingest/nextSeq/readSince/maxCursor/topics
core/src/bus/retention.ts             NEW  pure retention decision (cap + age) — consumed by BusStore.sweep()
core/src/bus/bus.ts                   NEW  Bus singleton: publish/ingest/subscribe/read(long-poll)/since/topics + delivery + cursor advance + local EventEmitter + status provider
core/src/bus/index.ts                 NEW  public surface re-export (getBus, types) for `require('../bus')`
core/src/fabric/fabric-link.ts        MOD  dispatch: inbound `pub` → onBus dep (was ignored in W2)
core/src/fabric/peer-link.ts          MOD  advertise the `bus` HELLO feature
core/src/fabric/rpc-server.ts         MOD  busEnabled allow-list: /bus/* dispatch under busEnabled even when fabricRpcEnabled is false
core/src/fabric/index.ts              MOD  fabricPublish + fabricBusPeers + fabricBusCatchup + fabricSelfNode + peerLinks registry; attach onBus + busEnabled
core/src/project-settings.ts          MOD  busEnabled (default true) — 4 places, mirroring fabricEnabled
core/src/routes/core/bus.routes.ts    NEW  POST /bus/publish · GET /bus/read (long-poll) · GET /bus/topics · POST /bus/:topic/since
core/src/routes/core/index.ts         MOD  register createBusRoutes
core/src/rest-server.ts               MOD  initBusEvents(): bridge bus events → /stream SSE (mirrors initMemoryCacheEvents)
core/src/status/status-registry.ts    MOD  register the `bus` status provider in registerCoreStatusProviders
core/src/mcp-server/tools/bus.ts      NEW  bus_publish / bus_read / bus_topics defs + handlers
core/src/mcp-server/tools/_passthrough.ts  MOD  workerGetLong (long-poll-safe GET timeout) for bus_read
core/src/mcp-server/tools/expanded.ts MOD  register BUS_TOOL_DEFS + BUS_HANDLERS
core/src/mcp-server/configure.ts      MOD  TOOL_SCOPES bus_publish/bus_read/bus_topics
core/src/__tests__/bus/*.test.ts      NEW  unit tests per module
```

---

### Task 1: `busEnabled` kill-switch setting

**Files:**
- Modify: `core/src/project-settings.ts` (4 places, mirroring `fabricEnabled`)
- Test: `core/src/__tests__/bus/settings.test.ts`

**Interfaces:**
- Produces: `getProjectSettings().busEnabled: boolean` (default `true`) — read by Tasks 5, 7, 9, 12.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/bus/settings.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULTS } from '../../project-settings';

test('busEnabled defaults on', () => {
  assert.equal((DEFAULTS as Record<string, unknown>).busEnabled, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && ~/.nvm/versions/node/v20.19.6/bin/node --test --test-reporter=spec dist-test/__tests__/bus/settings.test.js`
Expected: FAIL (`busEnabled` undefined).

- [ ] **Step 3: Implement — add `busEnabled` in all four places** (follow the exact `fabricEnabled` pattern).

In the `ProjectSettings` interface (after `fabricRelayBulkCapMBps: number;`):
```ts
  /** Message bus (spec §5 S1): durable cross-node topic log + fan-out over the fabric. Default true. */
  busEnabled: boolean;
```
In `DEFAULTS` (after `fabricRelayBulkCapMBps: 5,`):
```ts
  busEnabled: true,
```
In the load/coerce block (after the `fabricRelayBulkCapMBps:` coerce line):
```ts
      busEnabled: typeof data.busEnabled === 'boolean' ? data.busEnabled : DEFAULTS.busEnabled,
```
In the save/merge block (after the `fabricRelayBulkCapMBps:` merge line):
```ts
    busEnabled: typeof partial.busEnabled === 'boolean' ? partial.busEnabled : current.busEnabled,
```

- [ ] **Step 4: Run test to verify it passes** (same command as Step 2). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/project-settings.ts core/src/__tests__/bus/settings.test.ts && git commit -m "feat(bus): busEnabled kill-switch setting (default true)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Bus event types + cursor/id helpers

**Files:**
- Create: `core/src/bus/types.ts`
- Test: `core/src/__tests__/bus/types.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `interface BusRef { kind: 'dataset' | 'bulk'; id: string; bytes?: number }`
  - `interface BusEvent { topic: string; origin: string; seq: number; type: string; at: number; payload?: unknown; ref?: BusRef; scope?: 'cluster' | 'fleet' }`
  - `type BusCursor = Record<string, number>` (origin → last-seen seq)
  - `const BUS_PAYLOAD_CAP = 64 * 1024`
  - `globalId(e: { origin: string; seq: number }): string` (`"origin:seq"`)
  - `payloadSize(payload: unknown): number` (byte length of the JSON encoding; `undefined`/`null` → small)
  - `encodeCursor(c: BusCursor): string` (base64url of JSON — opaque, stateless for MCP callers)
  - `decodeCursor(s?: string | null): BusCursor` (empty/invalid → `{}`)
  - `mergeCursor(a: BusCursor, b: BusCursor): BusCursor` (per-origin max)

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/bus/types.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  globalId, payloadSize, encodeCursor, decodeCursor, mergeCursor, BUS_PAYLOAD_CAP, type BusCursor,
} from '../../bus/types';

test('globalId is origin:seq', () => {
  assert.equal(globalId({ origin: 'gw-a', seq: 7 }), 'gw-a:7');
});

test('payloadSize measures JSON bytes; cap is 64KB', () => {
  assert.equal(BUS_PAYLOAD_CAP, 64 * 1024);
  assert.ok(payloadSize({ a: 'x'.repeat(100) }) > 100);
  assert.ok(payloadSize(null) < 8);
});

test('cursor encode/decode round-trips and is opaque-string safe', () => {
  const c: BusCursor = { 'gw-a': 3, 'gw-b': 10 };
  const s = encodeCursor(c);
  assert.equal(typeof s, 'string');
  assert.deepEqual(decodeCursor(s), c);
  assert.deepEqual(decodeCursor(undefined), {});
  assert.deepEqual(decodeCursor('not-base64!!'), {});
});

test('mergeCursor takes the per-origin max', () => {
  assert.deepEqual(mergeCursor({ a: 1, b: 5 }, { a: 4, c: 2 }), { a: 4, b: 5, c: 2 });
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/bus/types.ts
/**
 * Bus value types + pure helpers (spec §5 S1). A BusEvent is the unit of the
 * append-only log: per-origin monotonic `seq`, global id `origin:seq`, ordering
 * guaranteed per origin. A cursor is a per-origin high-water map; it is encoded
 * to an opaque base64url string so an MCP caller can hold it statelessly and
 * hand it back on the next read.
 */
export interface BusRef {
  kind: 'dataset' | 'bulk';
  id: string;
  bytes?: number;
}

export interface BusEvent {
  topic: string;
  origin: string;   // gatewayId that first appended this event
  seq: number;      // per-(topic,origin) monotonic, 1-based
  type: string;     // application event type
  at: number;       // epoch ms
  payload?: unknown; // JSON-serializable, ≤ BUS_PAYLOAD_CAP bytes
  ref?: BusRef;     // carried instead of payload when the data was offloaded
  scope?: 'cluster' | 'fleet'; // fan-out scope, recorded on the origin node
}

/** origin → last-seen seq for a topic. */
export type BusCursor = Record<string, number>;

export const BUS_PAYLOAD_CAP = 64 * 1024;

export function globalId(e: { origin: string; seq: number }): string {
  return `${e.origin}:${e.seq}`;
}

export function payloadSize(payload: unknown): number {
  if (payload === undefined || payload === null) return 4;
  try { return Buffer.byteLength(JSON.stringify(payload)); } catch { return Number.MAX_SAFE_INTEGER; }
}

export function encodeCursor(c: BusCursor): string {
  return Buffer.from(JSON.stringify(c ?? {}), 'utf8').toString('base64url');
}

export function decodeCursor(s?: string | null): BusCursor {
  if (!s) return {};
  try {
    const obj = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out: BusCursor = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function mergeCursor(a: BusCursor, b: BusCursor): BusCursor {
  const out: BusCursor = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes** (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/bus/types.ts core/src/__tests__/bus/types.test.ts && git commit -m "feat(bus): event types + cursor/id helpers (pure)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: BusStore — LMDB log, idempotent ingest, monotonic seq, cursors

**Files:**
- Create: `core/src/bus/bus-store.ts`
- Test: `core/src/__tests__/bus/bus-store.test.ts`

**Interfaces:**
- Consumes: `BusEvent`, `BusCursor`, `mergeCursor` (Task 2); `getCacheDir` from `../utils/path-utils`; `open, RootDatabase, Database` from `lmdb`.
- Produces:
  - `interface TopicSummary { topic: string; events: number; origins: number; oldestAt: number | null; newestAt: number | null; head: BusCursor }`
  - `class BusStore`:
    - `constructor(dir?: string)` (default `getCacheDir('bus')`; dev/prod-separated)
    - `nextSeq(topic: string, origin: string): number` (in-memory-cached monotonic; seeds from `heads`)
    - `append(e: BusEvent): void` (writes the event + advances `heads`; caller already assigned `seq` via `nextSeq`)
    - `ingest(e: BusEvent): boolean` (idempotent — returns `false` if `[topic,origin,seq]` already present, else writes + bumps head and returns `true`)
    - `get(topic: string, origin: string, seq: number): BusEvent | undefined`
    - `readSince(topic: string, cursor: BusCursor, limit?: number): BusEvent[]` (events with `seq > cursor[origin]`, ordered by `(origin, seq)`)
    - `maxCursor(topic: string): BusCursor` (per-origin head — the whole log head)
    - `listTopics(): TopicSummary[]`
    - `getCursor(subscriberId: string, topic: string): BusCursor` / `setCursor(subscriberId: string, topic: string, c: BusCursor): void` (durable, survive restart)
    - `allTopicNames(): string[]`
    - `close(): void`

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/bus/bus-store.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BusStore } from '../../bus/bus-store';
import type { BusEvent } from '../../bus/types';

function tmpStore(): { store: BusStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-store-'));
  return { store: new BusStore(dir), dir };
}
const ev = (o: Partial<BusEvent> & { topic: string; origin: string; seq: number }): BusEvent =>
  ({ type: 't', at: Date.now(), payload: { n: o.seq }, ...o });

test('append assigns monotonic per-origin seq and reads back', () => {
  const { store } = tmpStore();
  const s1 = store.nextSeq('mission:1', 'gw-a');
  const s2 = store.nextSeq('mission:1', 'gw-a');
  assert.equal(s1, 1);
  assert.equal(s2, 2);
  store.append(ev({ topic: 'mission:1', origin: 'gw-a', seq: s1 }));
  store.append(ev({ topic: 'mission:1', origin: 'gw-a', seq: s2 }));
  assert.equal(store.get('mission:1', 'gw-a', 1)?.seq, 1);
  assert.deepEqual(store.maxCursor('mission:1'), { 'gw-a': 2 });
  store.close();
});

test('ingest is idempotent — a re-delivered event is a no-op', () => {
  const { store } = tmpStore();
  const e = ev({ topic: 'data:missions', origin: 'gw-b', seq: 5 });
  assert.equal(store.ingest(e), true);
  assert.equal(store.ingest(e), false);          // exact replay → no-op
  assert.equal(store.ingest({ ...e, payload: { tampered: true } }), false); // same (origin,seq) → still no-op, no LWW
  assert.equal(store.get('data:missions', 'gw-b', 5)?.payload && (store.get('data:missions', 'gw-b', 5)!.payload as { n: number }).n, 5);
  store.close();
});

test('readSince returns only events after the per-origin cursor, ordered', () => {
  const { store } = tmpStore();
  for (const o of ['gw-a', 'gw-b']) for (let s = 1; s <= 3; s++) store.ingest(ev({ topic: 'app:x', origin: o, seq: s }));
  const got = store.readSince('app:x', { 'gw-a': 1 });        // gw-a>1 → 2,3 ; gw-b>0 → 1,2,3
  assert.deepEqual(got.map((e) => `${e.origin}:${e.seq}`), ['gw-a:2', 'gw-a:3', 'gw-b:1', 'gw-b:2', 'gw-b:3']);
  assert.deepEqual(store.readSince('app:x', store.maxCursor('app:x')), []); // caught up → nothing
  store.close();
});

test('durable cursors survive a store reopen (consumer restart → resume)', () => {
  const { store, dir } = tmpStore();
  store.setCursor('sub-1', 'mission:9', { 'gw-a': 4 });
  store.close();
  const reopened = new BusStore(dir);
  assert.deepEqual(reopened.getCursor('sub-1', 'mission:9'), { 'gw-a': 4 });
  assert.deepEqual(reopened.getCursor('sub-1', 'never'), {});
  reopened.close();
});

test('nextSeq resumes from the persisted head after reopen (no seq reuse)', () => {
  const { store, dir } = tmpStore();
  store.append(ev({ topic: 't', origin: 'self', seq: store.nextSeq('t', 'self') })); // seq 1
  store.close();
  const reopened = new BusStore(dir);
  assert.equal(reopened.nextSeq('t', 'self'), 2); // seeded from heads, not restarting at 1
  reopened.close();
});

test('listTopics reports counts + head', () => {
  const { store } = tmpStore();
  store.ingest(ev({ topic: 'a', origin: 'gw-a', seq: 1 }));
  store.ingest(ev({ topic: 'a', origin: 'gw-b', seq: 1 }));
  const t = store.listTopics().find((x) => x.topic === 'a')!;
  assert.equal(t.events, 2);
  assert.equal(t.origins, 2);
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/bus/bus-store.ts
/**
 * Bus storage (spec §5 S1) — LMDB, mirroring memory-cache-store.ts's open/keying
 * idiom. Three sub-dbs under a dev/prod-separated `bus.lmdb`:
 *   events  key [topic, origin, seq]        → BusEvent      (the append-only log)
 *   heads   key [topic, origin]             → seq (number)  (per-origin high-water)
 *   cursors key [subscriberId, topic]       → BusCursor     (durable subscriber pos)
 * Array keys use LMDB's default ordered-binary key encoding (element-wise sort),
 * so a `[topic]`-prefixed getRange walks a topic in (origin, seq) order. Ingest
 * is idempotent: a key that already exists is a no-op (no LWW, no conflicts).
 */
import { open, RootDatabase, Database } from 'lmdb';
import * as fs from 'fs';
import { getCacheDir } from '../utils/path-utils';
import type { BusEvent, BusCursor } from './types';
import { mergeCursor } from './types';

export interface TopicSummary {
  topic: string;
  events: number;
  origins: number;
  oldestAt: number | null;
  newestAt: number | null;
  head: BusCursor;
}

type EventKey = [string, string, number];
type HeadKey = [string, string];
type CursorKey = [string, string];

export class BusStore {
  private env: RootDatabase;
  private events: Database<BusEvent, EventKey>;
  private heads: Database<number, HeadKey>;
  private cursors: Database<BusCursor, CursorKey>;
  private seqCache = new Map<string, number>(); // `${topic} ${origin}` → last seq
  private _closed = false;

  constructor(dir?: string) {
    const d = dir || getCacheDir('bus');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    this.env = open({ path: d, compression: true, maxDbs: 4, mapSize: 2 * 1024 * 1024 * 1024 });
    this.events = this.env.openDB('events', { encoding: 'msgpack' });
    this.heads = this.env.openDB('heads', { encoding: 'msgpack' });
    this.cursors = this.env.openDB('cursors', { encoding: 'msgpack' });
  }

  private hk(topic: string, origin: string): string { return `${topic} ${origin}`; }

  private storedHead(topic: string, origin: string): number {
    const k = this.hk(topic, origin);
    const cached = this.seqCache.get(k);
    if (cached !== undefined) return cached;
    const h = this.heads.get([topic, origin]) ?? 0;
    this.seqCache.set(k, h);
    return h;
  }

  /** Reserve the next per-origin seq (monotonic, cached so rapid publishes don't collide). */
  nextSeq(topic: string, origin: string): number {
    const next = this.storedHead(topic, origin) + 1;
    this.seqCache.set(this.hk(topic, origin), next);
    return next;
  }

  private bumpHead(topic: string, origin: string, seq: number): void {
    const k = this.hk(topic, origin);
    const cur = this.seqCache.get(k) ?? this.heads.get([topic, origin]) ?? 0;
    if (seq > cur) this.seqCache.set(k, seq);
    // persist the max; lmdb put is async-batched but ordered — read-back after
    // reopen returns the last committed value, which is all `storedHead` needs.
    void this.heads.put([topic, origin], Math.max(cur, seq));
  }

  append(e: BusEvent): void {
    void this.events.put([e.topic, e.origin, e.seq], e);
    this.bumpHead(e.topic, e.origin, e.seq);
  }

  /** Idempotent merge: returns false if (topic,origin,seq) already exists. */
  ingest(e: BusEvent): boolean {
    if (this.events.get([e.topic, e.origin, e.seq]) !== undefined) return false;
    void this.events.put([e.topic, e.origin, e.seq], e);
    this.bumpHead(e.topic, e.origin, e.seq);
    return true;
  }

  get(topic: string, origin: string, seq: number): BusEvent | undefined {
    return this.events.get([topic, origin, seq]);
  }

  readSince(topic: string, cursor: BusCursor, limit = 10_000): BusEvent[] {
    const out: BusEvent[] = [];
    for (const { key, value } of this.events.getRange({ start: [topic] })) {
      const k = key as EventKey;
      if (!Array.isArray(k) || k[0] !== topic) break; // left the topic prefix
      if (k[2] > (cursor[k[1]] ?? 0)) out.push(value);
      if (out.length >= limit) break;
    }
    return out;
  }

  maxCursor(topic: string): BusCursor {
    const out: BusCursor = {};
    for (const { key, value } of this.heads.getRange({ start: [topic] })) {
      const k = key as HeadKey;
      if (!Array.isArray(k) || k[0] !== topic) break;
      out[k[1]] = value;
    }
    return out;
  }

  allTopicNames(): string[] {
    const seen = new Set<string>();
    for (const { key } of this.heads.getRange({})) {
      const k = key as HeadKey;
      if (Array.isArray(k) && typeof k[0] === 'string') seen.add(k[0]);
    }
    return [...seen];
  }

  listTopics(): TopicSummary[] {
    return this.allTopicNames().map((topic) => {
      let events = 0;
      let oldestAt: number | null = null;
      let newestAt: number | null = null;
      const origins = new Set<string>();
      for (const { key, value } of this.events.getRange({ start: [topic] })) {
        const k = key as EventKey;
        if (!Array.isArray(k) || k[0] !== topic) break;
        events++;
        origins.add(k[1]);
        oldestAt = oldestAt === null ? value.at : Math.min(oldestAt, value.at);
        newestAt = newestAt === null ? value.at : Math.max(newestAt, value.at);
      }
      return { topic, events, origins: origins.size, oldestAt, newestAt, head: this.maxCursor(topic) };
    });
  }

  getCursor(subscriberId: string, topic: string): BusCursor {
    return this.cursors.get([subscriberId, topic]) ?? {};
  }

  setCursor(subscriberId: string, topic: string, c: BusCursor): void {
    void this.cursors.put([subscriberId, topic], mergeCursor(this.getCursor(subscriberId, topic), c));
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.env.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes** (6 tests).

> Note: LMDB `put` is async-batched. The tests above never assert cross-instance reads without an intervening `close()` (which flushes), so the reads are deterministic. Production readers are same-process (they see the in-memory write map immediately).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/bus/bus-store.ts core/src/__tests__/bus/bus-store.test.ts && git commit -m "feat(bus): LMDB BusStore — log + idempotent ingest + monotonic seq + durable cursors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Retention + compaction sweep (env-tunable)

**Files:**
- Create: `core/src/bus/retention.ts`
- Modify: `core/src/bus/bus-store.ts` (add `sweep()` using the pure policy)
- Test: `core/src/__tests__/bus/retention.test.ts`

**Interfaces:**
- Consumes: `BusEvent` (Task 2); `BusStore` internals (Task 3).
- Produces:
  - `interface RetentionPolicy { maxEvents: number; maxAgeMs: number }`
  - `retentionFromEnv(now?: () => number): RetentionPolicy` (reads `LM_BUS_RETENTION_EVENTS` default `10000`, `LM_BUS_RETENTION_DAYS` default `7`)
  - `eventsToEvict(events: Array<{ origin: string; seq: number; at: number }>, policy: RetentionPolicy, nowMs: number): Array<{ origin: string; seq: number }>` — pure: everything older than `maxAgeMs` PLUS, once past `maxEvents`, the oldest surplus (by `at`, then origin/seq).
  - `BusStore.sweep(policy?: RetentionPolicy): number` — deletes evicted events per topic, returns the count removed.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/bus/retention.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { retentionFromEnv, eventsToEvict } from '../../bus/retention';
import { BusStore } from '../../bus/bus-store';
import type { BusEvent } from '../../bus/types';

test('retentionFromEnv has safe defaults and honors env', () => {
  const d = retentionFromEnv();
  assert.equal(d.maxEvents, 10000);
  assert.equal(d.maxAgeMs, 7 * 24 * 3600 * 1000);
  process.env.LM_BUS_RETENTION_EVENTS = '3';
  process.env.LM_BUS_RETENTION_DAYS = '1';
  const e = retentionFromEnv();
  assert.equal(e.maxEvents, 3);
  assert.equal(e.maxAgeMs, 24 * 3600 * 1000);
  delete process.env.LM_BUS_RETENTION_EVENTS;
  delete process.env.LM_BUS_RETENTION_DAYS;
});

test('eventsToEvict drops aged-out AND oldest surplus over the cap', () => {
  const now = 1_000_000_000_000;
  const evs = [
    { origin: 'a', seq: 1, at: now - 10_000 },
    { origin: 'a', seq: 2, at: now - 9_000 },
    { origin: 'a', seq: 3, at: now - 8_000 },
    { origin: 'a', seq: 4, at: now - 1_000 },
  ];
  const evict = eventsToEvict(evs, { maxEvents: 2, maxAgeMs: 9_500 }, now);
  // seq1 is aged out (>9.5s); then cap=2 over 4 events → drop the 2 oldest remaining (seq2, seq3)
  assert.deepEqual(evict.map((e) => e.seq).sort(), [1, 2, 3]);
});

test('sweep removes evicted events from the store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-ret-'));
  const store = new BusStore(dir);
  const now = Date.now();
  for (let s = 1; s <= 5; s++) {
    const e: BusEvent = { topic: 'app:x', origin: 'a', seq: s, type: 't', at: now - (5 - s) * 1000, payload: {} };
    store.ingest(e);
  }
  const removed = store.sweep({ maxEvents: 2, maxAgeMs: 3_500 });
  assert.ok(removed >= 3);
  assert.equal(store.get('app:x', 'a', 1), undefined); // oldest gone
  assert.ok(store.get('app:x', 'a', 5));               // newest kept
  store.close();
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement the pure policy**

```ts
// core/src/bus/retention.ts
/**
 * Retention policy (spec §5 S1: default 10k events / 7 days, per topic). Pure
 * decision so it is unit-testable without LMDB; BusStore.sweep() applies it.
 * Env-tunable with safe defaults.
 */
export interface RetentionPolicy { maxEvents: number; maxAgeMs: number; }

export function retentionFromEnv(): RetentionPolicy {
  const events = Number(process.env.LM_BUS_RETENTION_EVENTS);
  const days = Number(process.env.LM_BUS_RETENTION_DAYS);
  return {
    maxEvents: Number.isFinite(events) && events > 0 ? Math.floor(events) : 10_000,
    maxAgeMs: (Number.isFinite(days) && days > 0 ? days : 7) * 24 * 3600 * 1000,
  };
}

/** Which events (of ONE topic) to drop: aged-out first, then oldest surplus over the cap. */
export function eventsToEvict(
  events: Array<{ origin: string; seq: number; at: number }>,
  policy: RetentionPolicy,
  nowMs: number,
): Array<{ origin: string; seq: number }> {
  const drop = new Set<string>();
  const key = (e: { origin: string; seq: number }) => `${e.origin} ${e.seq}`;
  for (const e of events) if (nowMs - e.at > policy.maxAgeMs) drop.add(key(e));
  const survivors = events.filter((e) => !drop.has(key(e)));
  const surplus = survivors.length - policy.maxEvents;
  if (surplus > 0) {
    const byAge = [...survivors].sort((a, b) => a.at - b.at || a.origin.localeCompare(b.origin) || a.seq - b.seq);
    for (let i = 0; i < surplus; i++) drop.add(key(byAge[i]));
  }
  return events.filter((e) => drop.has(key(e))).map((e) => ({ origin: e.origin, seq: e.seq }));
}
```

- [ ] **Step 4: Add `sweep()` to `BusStore`** — in `core/src/bus/bus-store.ts`, add the import and method:

Import (top of file, after the types import):
```ts
import { eventsToEvict, retentionFromEnv, type RetentionPolicy } from './retention';
```
Method (inside the class, before `close()`):
```ts
  /** Apply retention to every topic; returns the number of events removed. */
  sweep(policy: RetentionPolicy = retentionFromEnv()): number {
    const now = Date.now();
    let removed = 0;
    for (const topic of this.allTopicNames()) {
      const evs: Array<{ origin: string; seq: number; at: number }> = [];
      for (const { key, value } of this.events.getRange({ start: [topic] })) {
        const k = key as [string, string, number];
        if (!Array.isArray(k) || k[0] !== topic) break;
        evs.push({ origin: k[1], seq: k[2], at: value.at });
      }
      for (const e of eventsToEvict(evs, policy, now)) {
        void this.events.remove([topic, e.origin, e.seq]);
        removed++;
      }
    }
    return removed;
  }
```

- [ ] **Step 5: Run test to verify it passes** (3 tests). Then `cd /home/ubuntu/lm-assist && ./core.sh build`.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/bus/retention.ts core/src/bus/bus-store.ts core/src/__tests__/bus/retention.test.ts && git commit -m "feat(bus): env-tunable retention + compaction sweep (10k events / 7 days)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Bus service core — publish/ingest/subscribe/read/since (fabric injected)

**Files:**
- Create: `core/src/bus/bus.ts`
- Create: `core/src/bus/index.ts`
- Test: `core/src/__tests__/bus/bus.test.ts`

**Interfaces:**
- Consumes: `BusStore` (Task 3), types + `BUS_PAYLOAD_CAP`/`payloadSize`/`encodeCursor`/`decodeCursor`/`mergeCursor`/`globalId` (Task 2).
- Produces:
  - `interface BusDeps { store: BusStore; selfNode: string; fanout?: (e: BusEvent) => void; enabled?: () => boolean; now?: () => number }`
  - `interface ReadResult { events: BusEvent[]; nextCursor: string }`
  - `class Bus`:
    - `publish(topic: string, type: string, payload: unknown, opts?: { scope?: 'cluster' | 'fleet'; ref?: BusRef }): BusEvent` (throws `Error` when disabled or payload > cap)
    - `ingest(e: BusEvent): boolean` (idempotent; delivers to local subs on first sight; no re-fanout)
    - `ingestFromWire(payload: Uint8Array): boolean` (decode a `pub` frame body → `ingest`)
    - `subscribe(subscriberId: string, topic: string, handler: (e: BusEvent) => void | Promise<void>): () => void` (replays from durable cursor, then live; advances cursor after each handler)
    - `read(topic: string, from?: string, waitMs?: number): Promise<ReadResult>` (long-poll; stateless — never persists a cursor)
    - `since(topic: string, cursor: BusCursor): BusEvent[]`
    - `topics(): Array<TopicSummary & { subscribers: number; lag: number }>`
    - `onLocalEvent(cb: (e: BusEvent) => void): () => void` (SSE + wakeups)
    - `statusReport(): { verdict: 'ok' | 'warn' | 'error'; summary: string; detail: unknown }`
  - `getBus(): Bus` (singleton — real store, `selfNode` from fabric, real fabric fanout, `enabled` from settings)
  - `__setBusForTest(b: Bus | null): void`
  - `core/src/bus/index.ts` re-exports `getBus`, `Bus`, `__setBusForTest`, and the Task-2 types.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/bus/bus.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Bus } from '../../bus/bus';
import { BusStore } from '../../bus/bus-store';
import type { BusEvent } from '../../bus/types';

function mk(over: Partial<{ enabled: boolean }> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-svc-'));
  const fanned: BusEvent[] = [];
  const bus = new Bus({
    store: new BusStore(dir), selfNode: 'gw-self',
    fanout: (e) => fanned.push(e), enabled: () => over.enabled ?? true,
  });
  return { bus, fanned };
}

test('publish appends with self origin + monotonic seq and fans out', () => {
  const { bus, fanned } = mk();
  const e1 = bus.publish('mission:1', 'created', { id: 1 });
  const e2 = bus.publish('mission:1', 'updated', { id: 1 });
  assert.equal(e1.origin, 'gw-self');
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(fanned.length, 2);
  assert.equal(fanned[1].seq, 2);
});

test('publish rejects an over-cap payload (must use a ref)', () => {
  const { bus } = mk();
  assert.throws(() => bus.publish('t', 'big', { blob: 'x'.repeat(70 * 1024) }), /64KB|cap|ref/i);
  // a ref-carrying event is fine
  const e = bus.publish('t', 'big', undefined, { ref: { kind: 'bulk', id: 'xfer-1' } });
  assert.equal(e.ref?.id, 'xfer-1');
});

test('disabled bus refuses to publish and ignores ingest', () => {
  const { bus, fanned } = mk({ enabled: false });
  assert.throws(() => bus.publish('t', 'x', {}), /disabled/i);
  assert.equal(bus.ingest({ topic: 't', origin: 'gw-x', seq: 1, type: 'x', at: Date.now() }), false);
  assert.equal(fanned.length, 0);
});

test('subscribe delivers live events and advances a durable cursor; ingest is idempotent', async () => {
  const { bus } = mk();
  const seen: string[] = [];
  bus.subscribe('sub-A', 'app:y', (e) => { seen.push(`${e.origin}:${e.seq}`); });
  assert.equal(bus.ingest({ topic: 'app:y', origin: 'gw-b', seq: 1, type: 'x', at: Date.now() }), true);
  assert.equal(bus.ingest({ topic: 'app:y', origin: 'gw-b', seq: 1, type: 'x', at: Date.now() }), false); // dup no-op
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, ['gw-b:1']); // delivered once
});

test('a new subscriber replays missed events from its durable cursor', async () => {
  const { bus } = mk();
  bus.ingest({ topic: 'm', origin: 'gw-b', seq: 1, type: 'x', at: Date.now() });
  bus.ingest({ topic: 'm', origin: 'gw-b', seq: 2, type: 'x', at: Date.now() });
  const seen: number[] = [];
  bus.subscribe('sub-Z', 'm', (e) => { seen.push(e.seq); }); // subscribes AFTER the events landed
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, [1, 2]); // replayed from cursor {} → both
});

test('read is stateless: from-cursor → events + nextCursor; long-poll wakes on a new event', async () => {
  const { bus } = mk();
  bus.ingest({ topic: 'q', origin: 'gw-b', seq: 1, type: 'x', at: Date.now() });
  const r1 = await bus.read('q');
  assert.deepEqual(r1.events.map((e) => e.seq), [1]);
  const r2 = await bus.read('q', r1.nextCursor); // caught up → empty immediately (no wait)
  assert.deepEqual(r2.events, []);
  const waiting = bus.read('q', r1.nextCursor, 1000); // long-poll
  setTimeout(() => bus.ingest({ topic: 'q', origin: 'gw-b', seq: 2, type: 'x', at: Date.now() }), 20);
  const r3 = await waiting;
  assert.deepEqual(r3.events.map((e) => e.seq), [2]);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/bus/bus.ts
/**
 * Bus service (spec §5 S1). Owns publish (local append → fan-out), idempotent
 * ingest (+ local delivery), in-process subscribe with durable cursor advance,
 * a stateless long-poll read, since (catch-up), and a local EventEmitter that
 * feeds the SSE bridge + long-poll wakeups. Fabric fan-out + catch-up are
 * injected (getBus wires them lazily to `../fabric` — see Tasks 7/9) so this
 * core is unit-testable without a live 2-node fabric.
 */
import { EventEmitter } from 'events';
import { BusStore, type TopicSummary } from './bus-store';
import {
  BUS_PAYLOAD_CAP, payloadSize, encodeCursor, decodeCursor, mergeCursor,
  type BusEvent, type BusRef, type BusCursor,
} from './types';

// decodeBody is the msgpack body codec the fabric already loaded (W2). Lazy to
// avoid pulling the fabric graph into a pure bus unit test.
function decodeWireBody(payload: Uint8Array): unknown {
  const { decodeBody } = require('../fabric/envelope') as typeof import('../fabric/envelope');
  return decodeBody(payload);
}

export interface BusDeps {
  store: BusStore;
  selfNode: string;
  fanout?: (e: BusEvent) => void;
  enabled?: () => boolean;
  now?: () => number;
}

export interface ReadResult { events: BusEvent[]; nextCursor: string; }

interface Sub { subscriberId: string; topic: string; handler: (e: BusEvent) => void | Promise<void>; }

export class Bus {
  private store: BusStore;
  private selfNode: string;
  private fanout: (e: BusEvent) => void;
  private enabled: () => boolean;
  private now: () => number;
  private subs = new Set<Sub>();
  private emitter = new EventEmitter();

  constructor(deps: BusDeps) {
    this.store = deps.store;
    this.selfNode = deps.selfNode;
    this.fanout = deps.fanout ?? (() => {});
    this.enabled = deps.enabled ?? (() => true);
    this.now = deps.now ?? (() => Date.now());
    this.emitter.setMaxListeners(0);
  }

  publish(topic: string, type: string, payload: unknown, opts?: { scope?: 'cluster' | 'fleet'; ref?: BusRef }): BusEvent {
    if (!this.enabled()) throw new Error('bus: disabled (busEnabled=false)');
    if (opts?.ref === undefined && payloadSize(payload) > BUS_PAYLOAD_CAP) {
      throw new Error(`bus: payload exceeds ${BUS_PAYLOAD_CAP}-byte cap — offload it and publish a ref {kind,id} instead`);
    }
    const seq = this.store.nextSeq(topic, this.selfNode);
    const e: BusEvent = {
      topic, origin: this.selfNode, seq, type, at: this.now(),
      ...(opts?.ref ? { ref: opts.ref } : { payload }),
      scope: opts?.scope ?? 'cluster',
    };
    this.store.append(e);
    this.deliverLocal(e);
    this.emitter.emit('event', e);
    try { this.fanout(e); } catch { /* fan-out is fire-and-forget; catch-up heals */ }
    return e;
  }

  /** Idempotent replica merge. Delivers locally + emits ONLY on first sight. No re-fanout (origin fans out; star topology). */
  ingest(e: BusEvent): boolean {
    if (!this.enabled()) return false;
    const isNew = this.store.ingest(e);
    if (isNew) { this.deliverLocal(e); this.emitter.emit('event', e); }
    return isNew;
  }

  ingestFromWire(payload: Uint8Array): boolean {
    const e = decodeWireBody(payload) as BusEvent;
    if (!e || typeof e.topic !== 'string' || typeof e.origin !== 'string' || typeof e.seq !== 'number') return false;
    return this.ingest(e);
  }

  subscribe(subscriberId: string, topic: string, handler: (e: BusEvent) => void | Promise<void>): () => void {
    const sub: Sub = { subscriberId, topic, handler };
    this.subs.add(sub);
    // Replay everything after the durable cursor (restart resumes exactly).
    const missed = this.store.readSince(topic, this.store.getCursor(subscriberId, topic));
    for (const e of missed) void this.dispatchTo(sub, e);
    return () => { this.subs.delete(sub); };
  }

  private deliverLocal(e: BusEvent): void {
    for (const sub of this.subs) {
      if (sub.topic !== e.topic) continue;
      if (e.seq <= (this.store.getCursor(sub.subscriberId, e.topic)[e.origin] ?? 0)) continue; // already past
      void this.dispatchTo(sub, e);
    }
  }

  private async dispatchTo(sub: Sub, e: BusEvent): Promise<void> {
    try {
      await sub.handler(e);
      this.store.setCursor(sub.subscriberId, e.topic, { [e.origin]: e.seq }); // advance only after success (at-least-once)
    } catch { /* leave the cursor; a later delivery / catch-up re-attempts */ }
  }

  since(topic: string, cursor: BusCursor): BusEvent[] {
    return this.store.readSince(topic, cursor);
  }

  async read(topic: string, from?: string, waitMs = 0): Promise<ReadResult> {
    const cursor = decodeCursor(from);
    let events = this.store.readSince(topic, cursor);
    if (events.length === 0 && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const off = this.onLocalEvent((e) => { if (e.topic === topic) { cleanup(); resolve(); } });
        const timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(waitMs, 25_000));
        timer.unref?.();
        const cleanup = () => { clearTimeout(timer); off(); };
      });
      events = this.store.readSince(topic, cursor);
    }
    let next = cursor;
    for (const e of events) next = mergeCursor(next, { [e.origin]: e.seq });
    return { events, nextCursor: encodeCursor(next) };
  }

  topics(): Array<TopicSummary & { subscribers: number; lag: number }> {
    return this.store.listTopics().map((t) => {
      const subs = [...this.subs].filter((s) => s.topic === t.topic);
      const headTotal = Object.values(t.head).reduce((a, b) => a + b, 0);
      let lag = 0;
      for (const s of subs) {
        const cur = this.store.getCursor(s.subscriberId, t.topic);
        lag = Math.max(lag, headTotal - Object.values(cur).reduce((a, b) => a + b, 0));
      }
      return { ...t, subscribers: subs.length, lag };
    });
  }

  onLocalEvent(cb: (e: BusEvent) => void): () => void {
    this.emitter.on('event', cb);
    return () => this.emitter.off('event', cb);
  }

  statusReport(): { verdict: 'ok' | 'warn' | 'error'; summary: string; detail: unknown } {
    if (!this.enabled()) return { verdict: 'ok', summary: 'bus disabled', detail: { enabled: false } };
    const topics = this.topics();
    const backlog = topics.reduce((a, t) => a + t.events, 0);
    const maxLag = topics.reduce((a, t) => Math.max(a, t.lag), 0);
    return {
      verdict: maxLag > 1000 ? 'warn' : 'ok',
      summary: `${topics.length} topics · ${backlog} events · maxLag ${maxLag}`,
      detail: { topics },
    };
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────
let singleton: Bus | null = null;

/** Production Bus: real store, self node + fanout + catch-up from the live fabric. */
export function getBus(): Bus {
  if (singleton) return singleton;
  const fab = require('../fabric') as {
    fabricSelfNode?: () => string;
    fabricBusPeers?: () => string[];
    fabricPublish?: (node: string, e: BusEvent) => void;
  };
  const { getProjectSettings } = require('../project-settings') as typeof import('../project-settings');
  const os = require('os') as typeof import('os');
  const store = new BusStore();
  singleton = new Bus({
    store,
    selfNode: fab.fabricSelfNode?.() || os.hostname(),
    enabled: () => { try { return getProjectSettings().busEnabled; } catch { return true; } },
    fanout: (e) => {
      // Cluster-scoped by construction: fabricBusPeers() are same-cluster,
      // bus-capable, connected peers (fleet cross-cluster delivery deferred).
      for (const peer of fab.fabricBusPeers?.() ?? []) fab.fabricPublish?.(peer, e);
    },
  });
  return singleton;
}

export function __setBusForTest(b: Bus | null): void { singleton = b; }
```

```ts
// core/src/bus/index.ts
/** Public bus surface for `require('../bus')`. */
export { getBus, Bus, __setBusForTest, type BusDeps, type ReadResult } from './bus';
export {
  type BusEvent, type BusRef, type BusCursor,
  BUS_PAYLOAD_CAP, globalId, encodeCursor, decodeCursor, mergeCursor, payloadSize,
} from './types';
export { BusStore, type TopicSummary } from './bus-store';
```

- [ ] **Step 4: Run test to verify it passes** (6 tests). Then `cd /home/ubuntu/lm-assist && ./core.sh build` (the `getBus()` fabric access is via untyped `require`, so this compiles before Tasks 7/9 add the fabric exports).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/bus/bus.ts core/src/bus/index.ts core/src/__tests__/bus/bus.test.ts && git commit -m "feat(bus): Bus service core — publish/ingest/subscribe/read/since (fabric injected)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Wire the inbound `pub` frame + advertise the `bus` feature

**Files:**
- Modify: `core/src/fabric/fabric-link.ts` (dispatch `pub` → `onBus`)
- Modify: `core/src/fabric/peer-link.ts` (advertise `bus` in the HELLO)
- Test: `core/src/__tests__/bus/fabric-link-pub.test.ts`

**Interfaces:**
- Consumes: `FabricLink`, `FabricChannel`, `Envelope` (W2).
- Produces: `FabricLinkDeps.onBus?: (env: Envelope) => void` — invoked for every inbound `pub` frame; the HELLO `features` now include `'bus'`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/bus/fabric-link-pub.test.ts
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { initEnvelopeCodec, encodeBody, type Envelope } from '../../fabric/envelope';
import { FabricLink, type FabricChannel } from '../../fabric/fabric-link';

before(async () => { await initEnvelopeCodec(); });

function pair() {
  let onA: ((d: Buffer) => void) | null = null;
  let onB: ((d: Buffer) => void) | null = null;
  const chA: FabricChannel = {
    peer: 'B', policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => onB?.(b), sendControl: (b) => onB?.(b), onData: (cb) => { onA = cb; },
  };
  const chB: FabricChannel = {
    peer: 'A', policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => onA?.(b), sendControl: (b) => onA?.(b), onData: (cb) => { onB = cb; },
  };
  return { chA, chB };
}

test('an inbound pub frame is dispatched to onBus (not dropped)', async () => {
  const { chA, chB } = pair();
  const got: Envelope[] = [];
  new FabricLink(chB, { onBus: (env) => got.push(env) }); // receiver
  const sender = new FabricLink(chA, {});
  await sender.sendEnvelope({ kind: 'pub', id: 'p1', headers: { cls: 'bus' }, payload: encodeBody({ topic: 'm', origin: 'A', seq: 1 }) });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'pub');
  assert.deepEqual(encodeBody ? (require('../../fabric/envelope').decodeBody(got[0].payload)) : null, { topic: 'm', origin: 'A', seq: 1 });
});
```

- [ ] **Step 2: Run test to verify it fails** (`onBus` not a dep; `pub` is ignored).

- [ ] **Step 3: Implement — dispatch the `pub` frame.** In `core/src/fabric/fabric-link.ts`:

Add to `FabricLinkDeps` (after the `onServer?: ServerHandler;` line):
```ts
  /** Inbound `pub` (bus class) frames — W3 wires this to Bus.ingestFromWire. */
  onBus?: (env: import('./envelope').Envelope) => void;
```
Replace the W2 ignore line in `dispatch()`:
```ts
    // pub/xfer are W3/W4 — ignore in W2
```
with:
```ts
    if (env.kind === 'pub') { this.deps.onBus?.(env); return; }
    // xfer is W4 — ignore
```

- [ ] **Step 4: Advertise the `bus` feature.** In `core/src/fabric/peer-link.ts`, in the `hello()` method, change:
```ts
    return encodeFabricControl({ type: FABRIC_TAG, kind, version: FABRIC_VERSION, features: ['status', 'rpc', 'comp-gzip'], node: this.deps.selfNode, ...(tcp ? { tcp } : {}) });
```
to:
```ts
    return encodeFabricControl({ type: FABRIC_TAG, kind, version: FABRIC_VERSION, features: ['status', 'rpc', 'comp-gzip', 'bus'], node: this.deps.selfNode, ...(tcp ? { tcp } : {}) });
```

- [ ] **Step 5: Run test to verify it passes** (1 test). Then `./core.sh build`.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/fabric-link.ts core/src/fabric/peer-link.ts core/src/__tests__/bus/fabric-link-pub.test.ts && git commit -m "feat(bus): wire inbound pub frame → onBus + advertise the bus HELLO feature

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Fabric fan-out helpers + attach the bus to live links

**Files:**
- Modify: `core/src/fabric/index.ts` (fanout/peers/self helpers + peerLinks registry + attach `onBus`)
- Test: `core/src/__tests__/bus/fabric-fanout.test.ts`

**Interfaces:**
- Consumes: `fabricLinks`, `FabricLink`, `PeerLink`, `attachFabricLink`, `encodeBody` (W2/index).
- Produces (all exported from `core/src/fabric/index.ts`):
  - `fabricSelfNode(): string` (this node's gatewayId, `self.node`)
  - `fabricBusPeers(): string[]` (connected peers whose HELLO advertised `bus`)
  - `fabricPublish(node: string, event: unknown): void` (fire-and-forget `pub` frame; no-op if no link)
  - attach change: `attachFabricLink` now registers the PeerLink in a `peerLinks` map and passes `onBus` (→ `getBus().ingestFromWire`) + `busEnabled` (→ rpc-server, Task 9) to the link.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/bus/fabric-fanout.test.ts
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { initEnvelopeCodec, decodeBody } from '../../fabric/envelope';
import { FabricLink, type FabricChannel } from '../../fabric/fabric-link';
import { fabricPublish, fabricBusPeers, __setFabricLinkForTest } from '../../fabric';

before(async () => { await initEnvelopeCodec(); });

test('fabricPublish sends a pub frame over the peer link; missing link is a no-op', async () => {
  const sent: Buffer[] = [];
  const ch: FabricChannel = {
    peer: 'gw-x', policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => sent.push(b), sendControl: (b) => sent.push(b), onData: () => {},
  };
  __setFabricLinkForTest('gw-x', new FabricLink(ch, {}));
  fabricPublish('gw-x', { topic: 'm', origin: 'gw-self', seq: 1 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1); // one pub frame on the wire
  fabricPublish('gw-absent', { topic: 'm', origin: 'gw-self', seq: 1 }); // no throw
  __setFabricLinkForTest('gw-x', null as unknown as FabricLink);
});

test('fabricBusPeers is empty without registered peer links', () => {
  assert.ok(Array.isArray(fabricBusPeers()));
});
```

- [ ] **Step 2: Run test to verify it fails** (`fabricPublish`/`fabricBusPeers` not exported).

- [ ] **Step 3: Implement.** In `core/src/fabric/index.ts`:

Add `encodeBody` to the envelope import:
```ts
import { initEnvelopeCodec, decodeBody, encodeBody } from './envelope';
```
Add the peer-link registry next to `fabricLinks` (after its declaration):
```ts
/** node → its PeerLink, for feature checks (peerHasFeature('bus')) during fan-out. */
const peerLinks = new Map<string, PeerLink>();
```
In `stopFabric()`, clear it (after `fabricLinks.clear();`):
```ts
  peerLinks.clear();
```
In `attachFabricLink()`, register the link (right after `fabricLinks.set(peer, fl);`):
```ts
  peerLinks.set(peer, link);
```
In the `createRpcServer({ ... })` deps inside `attachFabricLink`, add `busEnabled` next to `rpcEnabled`:
```ts
    rpcEnabled: () => settings().fabricRpcEnabled,
    busEnabled: () => settings().busEnabled,
```
In the `new FabricLink(facade, { ... })` deps inside `attachFabricLink`, add `onBus` next to `onServer`:
```ts
    onBus: (env) => {
      // Deliver an inbound bus `pub` frame into the local bus (idempotent).
      try { (require('../bus') as typeof import('../bus')).getBus().ingestFromWire(env.payload); } catch { /* bus off / not ready */ }
    },
```
Also, when a link connects, trigger catch-up from that peer (Task 9 defines `catchupPeer`). Append inside `attachFabricLink`, after the `link.onChannel(...)` block:
```ts
  // First-time bus catch-up from this peer (heals a partition / a boot gap).
  try { void (require('../bus') as typeof import('../bus')).getBus().catchupPeer(peer).catch(() => {}); } catch { /* bus off */ }
```
Add the exported helpers near `getFabricLink` (end of file):
```ts
/** This node's gatewayId (fabric self), or '' before initFabric. */
export function fabricSelfNode(): string { return self.node; }

/** Connected peers whose HELLO advertised the `bus` feature (mixed-version safe). */
export function fabricBusPeers(): string[] {
  const out: string[] = [];
  for (const [peer, link] of peerLinks) {
    if (fabricLinks.has(peer) && link.peerHasFeature('bus')) out.push(peer);
  }
  return out;
}

/** Fire-and-forget a bus event as a `pub` frame to one peer (spec: fan-out fire-and-forget, catch-up heals). */
export function fabricPublish(node: string, event: unknown): void {
  const link = fabricLinks.get(node);
  if (!link) return;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  void link.sendEnvelope({ kind: 'pub', id, headers: { cls: 'bus' }, payload: encodeBody(event) }).catch(() => {});
}
```

- [ ] **Step 4: Run test to verify it passes** (2 tests). Then `./core.sh build`.

> The `catchupPeer` call in `attachFabricLink` references a method added in Task 9. It is invoked through an untyped `require('../bus')` cast to the `../bus` module type — `catchupPeer` must exist on `Bus` by then. Task 5's `getBus()` already exists; Task 9 adds `catchupPeer`. If building this task standalone before Task 9, the call is present but `Bus.catchupPeer` is added in Task 9 — so run Task 9 immediately after (the two-line `catchupPeer` invocation compiles because `getBus()` returns the `Bus` type which gains the method in Task 9's edit to the same class).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/index.ts core/src/__tests__/bus/fabric-fanout.test.ts && git commit -m "feat(bus): fabric fan-out helpers (fabricPublish/fabricBusPeers/fabricSelfNode) + attach onBus

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Bus HTTP routes (publish / read / topics / since)

**Files:**
- Create: `core/src/routes/core/bus.routes.ts`
- Modify: `core/src/routes/core/index.ts` (import + register)
- Test: `core/src/__tests__/bus/bus-routes.test.ts`

**Interfaces:**
- Consumes: `getBus` (Task 5); `wrapResponse`, `wrapError` from `../../api/helpers`; `RouteHandler`, `RouteContext` from `../index`.
- Produces (routes):
  - `POST /bus/publish` body `{topic, type, payload?, scope?, ref?}` → `{id, topic, origin, seq, at}`
  - `GET /bus/read?topic=&from=&wait=` → `{events, nextCursor}` (long-poll, server cap 25s)
  - `GET /bus/topics` → `{topics: [...]}`
  - `POST /bus/:topic/since` body `{cursors}` → `{events, head}` (the catch-up target; reached over the fabric by Task 9)

- [ ] **Step 1: Write the failing test** (pure handler shapes against the injected bus)

```ts
// core/src/__tests__/bus/bus-routes.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createBusRoutes } from '../../routes/core/bus.routes';
import { Bus, __setBusForTest } from '../../bus';
import { BusStore } from '../../bus/bus-store';
import type { RouteHandler } from '../../routes/index';

function routes(): { handlers: RouteHandler[]; bus: Bus } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-rt-'));
  const bus = new Bus({ store: new BusStore(dir), selfNode: 'gw-self' });
  __setBusForTest(bus);
  return { handlers: createBusRoutes({} as never), bus };
}
const find = (hs: RouteHandler[], method: string, p: string) => hs.find((h) => h.method === method && h.pattern.test(p))!;

test('POST /bus/publish appends and returns the event id', async () => {
  const { handlers } = routes();
  const h = find(handlers, 'POST', '/bus/publish');
  const res = await h.handler({ method: 'POST', path: '/bus/publish', query: {}, body: { topic: 'm', type: 'x', payload: { a: 1 } } } as never, {} as never);
  assert.equal(res.success, true);
  assert.equal((res.data as { seq: number }).seq, 1);
});

test('GET /bus/read returns events + nextCursor; POST /bus/:topic/since catches up', async () => {
  const { handlers, bus } = routes();
  bus.publish('m', 'x', { a: 1 });
  const read = find(handlers, 'GET', '/bus/read');
  const r = await read.handler({ method: 'GET', path: '/bus/read', query: { topic: 'm' } } as never, {} as never);
  assert.equal((r.data as { events: unknown[] }).events.length, 1);
  const since = find(handlers, 'POST', '/bus/m/since');
  const s = await since.handler({ method: 'POST', path: '/bus/m/since', query: {}, body: { cursors: {} } } as never, {} as never);
  assert.equal((s.data as { events: unknown[] }).events.length, 1);
});

test('GET /bus/read requires topic', async () => {
  const { handlers } = routes();
  const read = find(handlers, 'GET', '/bus/read');
  const r = await read.handler({ method: 'GET', path: '/bus/read', query: {} } as never, {} as never);
  assert.equal(r.success, false);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/routes/core/bus.routes.ts
/**
 * Bus routes (spec §5 S1). Local surface for publish / long-poll read / topics,
 * PLUS the `/bus/:topic/since` catch-up endpoint the fabric reaches cross-node
 * (Task 9 gates it under busEnabled via the rpc-server bus allow-list). Every
 * handler wraps its result in wrapResponse / wrapError (repo API rule).
 */
import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import { getBus } from '../../bus';
import { globalId, type BusCursor, type BusRef } from '../../bus/types';

export function createBusRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'POST',
      pattern: /^\/bus\/publish$/,
      handler: async (req) => {
        const start = Date.now();
        const b = (req.body ?? {}) as { topic?: string; type?: string; payload?: unknown; scope?: string; ref?: BusRef };
        if (!b.topic || typeof b.topic !== 'string') return wrapError('BAD_REQUEST', 'topic is required', start);
        if (!b.type || typeof b.type !== 'string') return wrapError('BAD_REQUEST', 'type is required', start);
        try {
          const scope = b.scope === 'fleet' ? 'fleet' : 'cluster';
          const e = getBus().publish(b.topic, b.type, b.payload, { scope, ...(b.ref ? { ref: b.ref } : {}) });
          return wrapResponse({ id: globalId(e), topic: e.topic, origin: e.origin, seq: e.seq, at: e.at }, start);
        } catch (e) {
          return wrapError('BUS_PUBLISH_FAILED', (e as Error).message, start);
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/bus\/read$/,
      handler: async (req) => {
        const start = Date.now();
        const topic = typeof req.query?.topic === 'string' ? req.query.topic : '';
        if (!topic) return wrapError('BAD_REQUEST', 'topic query param required', start);
        const from = typeof req.query?.from === 'string' ? req.query.from : undefined;
        const waitMs = Math.max(0, Math.min(25_000, Number(req.query?.wait) || 0));
        const result = await getBus().read(topic, from, waitMs);
        return wrapResponse(result, start);
      },
    },
    {
      method: 'GET',
      pattern: /^\/bus\/topics$/,
      handler: async () => {
        const start = Date.now();
        return wrapResponse({ topics: getBus().topics() }, start);
      },
    },
    {
      // Catch-up: subscriber sends its per-origin cursors, gets missed events + the current head.
      method: 'POST',
      pattern: /^\/bus\/([^/]+)\/since$/,
      handler: async (req) => {
        const start = Date.now();
        const m = req.path.match(/^\/bus\/([^/]+)\/since$/);
        const topic = m ? decodeURIComponent(m[1]) : '';
        if (!topic) return wrapError('BAD_REQUEST', 'topic required', start);
        const cursors = ((req.body as { cursors?: BusCursor })?.cursors ?? {}) as BusCursor;
        const events = getBus().since(topic, cursors);
        return wrapResponse({ events, head: getBus().topics().find((t) => t.topic === topic)?.head ?? {} }, start);
      },
    },
  ];
}
```

- [ ] **Step 4: Register the routes.** In `core/src/routes/core/index.ts`:
- Import (next to `createFabricRoutes`): `import { createBusRoutes } from './bus.routes';`
- Spread (next to `...createFabricRoutes(ctx),`): `...createBusRoutes(ctx),`

- [ ] **Step 5: Run test to verify it passes** (3 tests). Then `./core.sh build`.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/routes/core/bus.routes.ts core/src/routes/core/index.ts core/src/__tests__/bus/bus-routes.test.ts && git commit -m "feat(bus): HTTP routes — publish / read (long-poll) / topics / :topic/since

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Catch-up over the fabric — rpc-server bus allow-list + reconcile

**Files:**
- Modify: `core/src/fabric/rpc-server.ts` (busEnabled allow-list for `/bus/*`)
- Modify: `core/src/fabric/index.ts` (`fabricBusCatchup`)
- Modify: `core/src/bus/bus.ts` (`catchupPeer`, `reconcile`, `start`/`stop`, interval)
- Test: `core/src/__tests__/bus/rpc-bus-allowlist.test.ts`, `core/src/__tests__/bus/catchup.test.ts`

**Interfaces:**
- Consumes: `createRpcServer`, `IdempotencyCache`, `fabricRequestManaged`, `getBus`, `BusStore.maxCursor`.
- Produces:
  - `RpcServerDeps.busEnabled?: () => boolean` — `/bus/*` req dispatches even when `rpcEnabled()` is false, gated on `busEnabled()` instead.
  - `fabricBusCatchup(node: string, topic: string, cursor: BusCursor): Promise<FabricResponse>` (via `fabricRequestManaged` — reliable delivery).
  - `Bus.catchupPeer(peer: string): Promise<void>`, `Bus.reconcile(): Promise<void>`, `Bus.start(): void`, `Bus.stop(): void`.

- [ ] **Step 1: Write the failing tests**

```ts
// core/src/__tests__/bus/rpc-bus-allowlist.test.ts
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { initEnvelopeCodec, encodeBody, decodeBody, type Envelope } from '../../fabric/envelope';
import { createRpcServer } from '../../fabric/rpc-server';
import { IdempotencyCache } from '../../fabric/idempotency';

before(async () => { await initEnvelopeCodec(); });

function req(path: string): Envelope {
  return { kind: 'req', id: 'r1', headers: { method: 'POST', path, reqId: 'r1', cls: 'rpc' }, payload: encodeBody({ body: { cursors: {} }, query: {} }) };
}

test('a /bus/* req dispatches under busEnabled even when rpcEnabled is false', async () => {
  const seen: string[] = [];
  const server = createRpcServer({
    dispatch: async (r) => { seen.push(r.path); return { status: 200, data: { events: [] } }; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => false, busEnabled: () => true,
    peerNodeOf: () => 'gw-a',
  });
  const res = await new Promise<Envelope>((resolve) => server(req('/bus/m/since'), resolve));
  assert.equal(res.headers.status, 200);
  assert.deepEqual(seen, ['/bus/m/since']);
});

test('a non-bus req is still refused when rpcEnabled is false', async () => {
  const server = createRpcServer({
    dispatch: async () => ({ status: 200, data: {} }),
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => false, busEnabled: () => true,
    peerNodeOf: () => 'gw-a',
  });
  const res = await new Promise<Envelope>((resolve) => server(req('/data/x/export'), resolve));
  assert.equal(res.headers.status, 503);
  assert.equal(res.headers.code, 'rpc_disabled');
});
```

```ts
// core/src/__tests__/bus/catchup.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Bus } from '../../bus/bus';
import { BusStore } from '../../bus/bus-store';
import type { BusEvent } from '../../bus/types';

test('catchupPeer ingests the events the peer returns for each known topic', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-cu-'));
  const store = new BusStore(dir);
  // Seed one topic so catchup has something to ask about.
  store.ingest({ topic: 'm', origin: 'gw-self', seq: 1, type: 'x', at: Date.now() });
  const missed: BusEvent[] = [{ topic: 'm', origin: 'gw-peer', seq: 1, type: 'x', at: Date.now() }];
  const bus = new Bus({ store, selfNode: 'gw-self' });
  // Inject the fabric catch-up call (production wires this to fabricBusCatchup).
  (bus as unknown as { catchupCall: (peer: string, topic: string, cursor: unknown) => Promise<BusEvent[]> }).catchupCall =
    async () => missed;
  await bus.catchupPeer('gw-peer');
  assert.ok(store.get('m', 'gw-peer', 1)); // the peer's event is now local
});
```

- [ ] **Step 2: Run tests to verify they fail** (`busEnabled` dep + `catchupPeer` missing).

- [ ] **Step 3: Implement the rpc-server allow-list.** In `core/src/fabric/rpc-server.ts`:

Add to `RpcServerDeps` (after `rpcEnabled: () => boolean;`):
```ts
  /** When true, `/bus/*` requests dispatch even if rpcEnabled() is false (spec §5 S1
   *  catch-up is gated by busEnabled, not the general RPC class — the first scoped
   *  allow-list entry; W4 generalizes it). */
  busEnabled?: () => boolean;
```
Replace the kill-switch block:
```ts
      if (env.kind !== 'req') return;
      // Kill-switch is checked BEFORE begin() — a disabled rpc class never
      // touches idempotency (nothing was claimed, so nothing needs settling).
      if (!deps.rpcEnabled()) { reply(errRes(503, 'rpc_disabled', 'fabric rpc class disabled')); return; }
```
with:
```ts
      if (env.kind !== 'req') return;
      const reqPath = env.headers.path ?? '/';
      // Kill-switch is checked BEFORE begin() — a disabled class never touches
      // idempotency. Bus catch-up (/bus/*) rides busEnabled, not the general RPC
      // class, so the bus works without opening arbitrary peer RPC.
      const allowed = deps.rpcEnabled() || (reqPath.startsWith('/bus/') && (deps.busEnabled?.() ?? false));
      if (!allowed) { reply(errRes(503, 'rpc_disabled', 'fabric rpc class disabled')); return; }
```

- [ ] **Step 4: Implement `fabricBusCatchup`.** In `core/src/fabric/index.ts`, add near `fabricPublish` (import the retry entry lazily to avoid a cycle):
```ts
/** Reliable cross-node bus catch-up (spec: fabricRequestManaged, NOT bare fabricRequest). */
export async function fabricBusCatchup(node: string, topic: string, cursor: Record<string, number>): Promise<FabricResponse> {
  const { fabricRequestManaged } = require('./retry') as typeof import('./retry');
  return fabricRequestManaged({ node }, { method: 'POST', path: `/bus/${encodeURIComponent(topic)}/since`, body: { cursors: cursor } });
}
```

- [ ] **Step 5: Implement catch-up + reconcile in the bus.** In `core/src/bus/bus.ts`:

Add a private catch-up call seam + methods (inside `class Bus`, before `statusReport()`):
```ts
  /** How a catch-up RPC is issued to a peer for a topic (prod → fabricBusCatchup).
   *  Overridable in tests. Returns the events the peer had beyond our cursor. */
  private catchupCall: (peer: string, topic: string, cursor: BusCursor) => Promise<BusEvent[]> = async (peer, topic, cursor) => {
    const { fabricBusCatchup } = require('../fabric') as typeof import('../fabric');
    const res = await fabricBusCatchup(peer, topic, cursor);
    const data = res.data as { events?: BusEvent[] } | undefined;
    return Array.isArray(data?.events) ? data!.events : [];
  };

  /** Pull everything this peer has that we are missing, across every known topic. */
  async catchupPeer(peer: string): Promise<void> {
    if (!this.enabled()) return;
    for (const topic of this.store.allTopicNames()) {
      try {
        const events = await this.catchupCall(peer, topic, this.store.maxCursor(topic));
        for (const e of events) this.ingest(e);
      } catch { /* peer unreachable / not bus-capable — the interval retries */ }
    }
  }

  /** Slow safety net (spec ~5 min): catch up from every connected bus peer. */
  async reconcile(): Promise<void> {
    if (!this.enabled()) return;
    let peers: string[] = [];
    try { peers = (require('../fabric') as typeof import('../fabric')).fabricBusPeers(); } catch { peers = []; }
    for (const peer of peers) await this.catchupPeer(peer);
  }

  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.reconcileTimer) return;
    const ms = Math.max(30_000, Number(process.env.LM_BUS_RECONCILE_MS) || 5 * 60 * 1000);
    this.reconcileTimer = setInterval(() => { void this.reconcile(); }, ms);
    this.reconcileTimer.unref?.();
  }

  stop(): void {
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null; }
  }
```

Then, in `getBus()` (after the `singleton = new Bus({...})` assignment, before `return singleton;`), start the reconcile net + register status (Task 11 relies on the provider being registered at boot; starting here covers the runtime path):
```ts
  singleton.start();
```

- [ ] **Step 6: Run both test files to verify they pass.** Then `./core.sh build`.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/rpc-server.ts core/src/fabric/index.ts core/src/bus/bus.ts core/src/__tests__/bus/rpc-bus-allowlist.test.ts core/src/__tests__/bus/catchup.test.ts && git commit -m "feat(bus): fabric catch-up — rpc-server bus allow-list + fabricBusCatchup + reconcile

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: SSE bridge — bus events → `/stream`

**Files:**
- Modify: `core/src/rest-server.ts` (add `initBusEvents()`, call it in the constructor)
- Test: `core/src/__tests__/bus/sse-bridge.test.ts`

**Interfaces:**
- Consumes: `getBus().onLocalEvent` (Task 5); `broadcastEvent` (rest-server, private).
- Produces: every locally-published/ingested bus event is broadcast to `/stream` as `{ type: 'bus_event', timestamp, tier: 'system', data: { topic, origin, seq, eventType, at, id } }` (the `as any` TierEvent idiom `initMemoryCacheEvents` already uses).

- [ ] **Step 1: Write the failing test** (assert the pure mapping the bridge uses)

```ts
// core/src/__tests__/bus/sse-bridge.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { busEventToSse } from '../../rest-server';
import type { BusEvent } from '../../bus/types';

test('busEventToSse maps a BusEvent to a stream-safe payload', () => {
  const e: BusEvent = { topic: 'mission:1', origin: 'gw-a', seq: 4, type: 'updated', at: 1720000000000, payload: { x: 1 } };
  const s = busEventToSse(e);
  assert.equal(s.type, 'bus_event');
  assert.equal(s.tier, 'system');
  assert.equal(s.data.topic, 'mission:1');
  assert.equal(s.data.id, 'gw-a:4');
  assert.equal(s.data.eventType, 'updated');
  assert.equal(s.data.seq, 4);
});
```

- [ ] **Step 2: Run test to verify it fails** (`busEventToSse` not exported).

- [ ] **Step 3: Implement.** In `core/src/rest-server.ts`:

Add the exported pure mapper near the top (module scope, after imports):
```ts
import type { BusEvent } from './bus/types';

/** Map a bus event to a /stream-safe payload (broadcast as a generic TierEvent). */
export function busEventToSse(e: BusEvent): { type: 'bus_event'; timestamp: Date; tier: 'system'; data: { topic: string; origin: string; seq: number; eventType: string; at: number; id: string } } {
  return {
    type: 'bus_event', timestamp: new Date(), tier: 'system',
    data: { topic: e.topic, origin: e.origin, seq: e.seq, eventType: e.type, at: e.at, id: `${e.origin}:${e.seq}` },
  };
}
```
Add the wiring method (next to `initMemoryCacheEvents`):
```ts
  /** Bridge bus events to the SSE /stream (mirrors initMemoryCacheEvents). */
  private initBusEvents(): void {
    try {
      const { getBus } = require('./bus') as typeof import('./bus');
      getBus().onLocalEvent((e) => {
        try { this.broadcastEvent(busEventToSse(e) as any); } catch { /* swallow */ }
      });
    } catch { /* bus disabled / not ready */ }
  }
```
Call it in the constructor, right after `this.initMemoryCacheEvents();` (with its own profiler bracket to match the surrounding style):
```ts
    profiler.start('busEvents', 'BusEvents', 'Server Constructor');
    this.initBusEvents();
    profiler.end('busEvents');
```

- [ ] **Step 4: Run test to verify it passes** (1 test). Then `./core.sh build`.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/rest-server.ts core/src/__tests__/bus/sse-bridge.test.ts && git commit -m "feat(bus): SSE bridge — bus events to /stream (bus_event)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Bus status provider

**Files:**
- Modify: `core/src/status/status-registry.ts` (register the `bus` provider in `registerCoreStatusProviders`)
- Test: `core/src/__tests__/bus/status-provider.test.ts`

**Interfaces:**
- Consumes: `registerStatusProvider`, `getStatusSnapshot` (status-registry); `getBus().statusReport()` (Task 5).
- Produces: a `bus` section in `GET /status/full` / `node_status` — `{verdict, summary, detail:{topics}}`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/bus/status-provider.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerCoreStatusProviders, getStatusSnapshot } from '../../status/status-registry';
import { Bus, __setBusForTest } from '../../bus';
import { BusStore } from '../../bus/bus-store';

test('the bus status provider reports topics + backlog', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-st-'));
  const bus = new Bus({ store: new BusStore(dir), selfNode: 'gw-self' });
  bus.publish('mission:1', 'x', { a: 1 });
  __setBusForTest(bus);
  registerCoreStatusProviders();
  const snap = await getStatusSnapshot('bus');
  assert.ok(snap.bus);
  assert.match(snap.bus.summary, /topics/);
  assert.equal(snap.bus.verdict, 'ok');
});
```

- [ ] **Step 2: Run test to verify it fails** (`snap.bus` undefined).

- [ ] **Step 3: Implement.** In `core/src/status/status-registry.ts`, inside `registerCoreStatusProviders()` (after the `fabric` provider block):
```ts
  registerStatusProvider('bus', () => {
    const { getBus } = require('../bus') as typeof import('../bus');
    return getBus().statusReport();
  });
```

- [ ] **Step 4: Run test to verify it passes** (1 test). Then `./core.sh build`.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/status/status-registry.ts core/src/__tests__/bus/status-provider.test.ts && git commit -m "feat(bus): status provider — topics/backlog/cursor-lag in /status/full + node_status

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: `bus_*` MCP tools

**Files:**
- Modify: `core/src/mcp-server/tools/_passthrough.ts` (`workerGetLong` for the long-poll read)
- Create: `core/src/mcp-server/tools/bus.ts`
- Modify: `core/src/mcp-server/tools/expanded.ts` (register defs + handlers)
- Modify: `core/src/mcp-server/configure.ts` (`TOOL_SCOPES`)
- Test: `core/src/__tests__/bus/bus-tool.test.ts`

**Interfaces:**
- Consumes: `ok`, `err`, `workerGet`, `workerPost` from `./_passthrough`; loopback routes from Task 8.
- Produces:
  - `workerGetLong<T>(routePath: string, timeoutMs: number): Promise<T>` (a GET with a caller-set timeout — the 15s default in `workerGet` is too short for a ≤25s long-poll).
  - `BUS_TOOL_DEFS` (3 defs: `bus_publish`, `bus_read`, `bus_topics`), `BUS_HANDLERS`, and pure `formatTopics`.
  - `TOOL_SCOPES`: `bus_publish: 'write'`, `bus_read: 'read'`, `bus_topics: 'read'`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/bus/bus-tool.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BUS_TOOL_DEFS, formatTopics } from '../../mcp-server/tools/bus';
import { TOOL_SCOPES } from '../../mcp-server/configure';

test('three bus tools are defined and scoped (else /mcp crashes)', () => {
  const names = BUS_TOOL_DEFS.map((d) => d.name).sort();
  assert.deepEqual(names, ['bus_publish', 'bus_read', 'bus_topics']);
  assert.equal(BUS_TOOL_DEFS.find((d) => d.name === 'bus_read')!.annotations.readOnlyHint, true);
  assert.equal(BUS_TOOL_DEFS.find((d) => d.name === 'bus_publish')!.annotations.readOnlyHint, false);
  assert.equal(TOOL_SCOPES['bus_publish'], 'write');
  assert.equal(TOOL_SCOPES['bus_read'], 'read');
  assert.equal(TOOL_SCOPES['bus_topics'], 'read');
});

test('formatTopics renders a topic table', () => {
  const s = formatTopics([{ topic: 'mission:1', events: 3, origins: 2, subscribers: 1, lag: 0, oldestAt: null, newestAt: null, head: {} }]);
  assert.match(s, /mission:1/);
  assert.match(s, /3/);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found + scopes missing).

- [ ] **Step 3: Add `workerGetLong`.** In `core/src/mcp-server/tools/_passthrough.ts`, after `workerGet`:
```ts
/** GET with a caller-set timeout (long-poll reads exceed workerGet's 15s default). */
export async function workerGetLong<T = unknown>(routePath: string, timeoutMs: number): Promise<T> {
  const res = await fetch(`${BASE_URL}${routePath}`, {
    headers: { ...lmAuthHeaders() },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return unwrapEnvelope<T>(res, routePath);
}
```

- [ ] **Step 4: Implement the tools**

```ts
// core/src/mcp-server/tools/bus.ts
/**
 * bus_publish / bus_read / bus_topics (spec §5 S1). Thin wrappers over the /bus
 * routes on loopback. bus_read is a stateless long-poll: pass the `from` cursor
 * you last received; it returns events + the next cursor. Connector args arrive
 * as STRINGS (data-service lesson) — coerce wait/from. Each MUST have a
 * TOOL_SCOPES entry (bus_publish=write, bus_read/bus_topics=read).
 */
import { ok, err, workerGet, workerGetLong, workerPost, type McpToolResult } from './_passthrough';

export const busPublishToolDef = {
  name: 'bus_publish',
  description:
    'Publish an event to a bus topic (durable, fanned out to same-cluster peers). ' +
    'topic (e.g. "mission:<id>", "data:<dataset>", "app:<name>"), type (event type), payload (JSON ≤64KB). ' +
    'Optional scope="fleet" for fleet-wide topics. Returns the event id (origin:seq).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      topic: { type: 'string', description: 'Topic name (required).' },
      type: { type: 'string', description: 'Application event type (required).' },
      payload: { type: 'object', description: 'JSON payload (≤64KB). Omit for a pure signal.' },
      scope: { type: 'string', enum: ['cluster', 'fleet'], description: 'Fan-out scope (default cluster).' },
    },
    required: ['topic', 'type'],
  },
};

export const busReadToolDef = {
  name: 'bus_read',
  description:
    'Read events from a bus topic since a cursor (stateless long-poll). Pass topic and the `from` cursor ' +
    'you last received (omit for the start of retained history). `wait` (ms, ≤25000) long-polls for new events. ' +
    'Returns { events, nextCursor } — pass nextCursor as `from` next time.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      topic: { type: 'string', description: 'Topic name (required).' },
      from: { type: 'string', description: 'Opaque cursor from a previous read (optional).' },
      wait: { type: 'number', description: 'Long-poll up to this many ms (≤25000, default 0).' },
    },
    required: ['topic'],
  },
};

export const busTopicsToolDef = {
  name: 'bus_topics',
  description: 'List bus topics with event counts, origins, subscribers, and cursor lag. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const BUS_TOOL_DEFS = [busPublishToolDef, busReadToolDef, busTopicsToolDef];

interface TopicRow { topic: string; events: number; origins: number; subscribers: number; lag: number; oldestAt: number | null; newestAt: number | null; head: Record<string, number>; }

export function formatTopics(rows: TopicRow[]): string {
  if (rows.length === 0) return 'bus: no topics yet.';
  return rows.map((t) => `• ${t.topic} — ${t.events} events · ${t.origins} origins · ${t.subscribers} subs · lag ${t.lag}`).join('\n');
}

export const BUS_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  bus_publish: async (args) => {
    const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
    const type = typeof args.type === 'string' ? args.type.trim() : '';
    if (!topic || !type) return err('bus_publish: topic and type are required');
    const scope = args.scope === 'fleet' ? 'fleet' : 'cluster';
    try {
      const r = await workerPost<{ id: string; seq: number }>('/bus/publish', { topic, type, payload: args.payload ?? null, scope });
      return ok(`published ${r.id} to ${topic}`);
    } catch (e) { return err(`bus_publish failed: ${(e as Error).message}`); }
  },
  bus_read: async (args) => {
    const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
    if (!topic) return err('bus_read: topic is required');
    const from = typeof args.from === 'string' ? args.from : '';
    const wait = Math.max(0, Math.min(25_000, Number(args.wait) || 0)); // connector sends numbers as strings → coerce
    const qs = `topic=${encodeURIComponent(topic)}${from ? `&from=${encodeURIComponent(from)}` : ''}${wait ? `&wait=${wait}` : ''}`;
    try {
      const r = await workerGetLong<{ events: unknown[]; nextCursor: string }>(`/bus/read?${qs}`, wait + 5_000);
      return ok(JSON.stringify(r, null, 2));
    } catch (e) { return err(`bus_read failed: ${(e as Error).message}`); }
  },
  bus_topics: async () => {
    try {
      const r = await workerGet<{ topics: TopicRow[] }>('/bus/topics');
      return ok(formatTopics(r.topics ?? []));
    } catch (e) { return err(`bus_topics failed: ${(e as Error).message}`); }
  },
};
```

- [ ] **Step 5: Register.** In `core/src/mcp-server/tools/expanded.ts`:
- Import (next to the fabric-probe import): `import { BUS_TOOL_DEFS, BUS_HANDLERS } from './bus';`
- Defs (next to `...FABRIC_PROBE_TOOL_DEFS,`): `...BUS_TOOL_DEFS,`
- Handlers (next to `...FABRIC_PROBE_HANDLERS,`): `...BUS_HANDLERS,`

In `core/src/mcp-server/configure.ts` `TOOL_SCOPES` (next to `fabric_probe: 'read',`):
```ts
  bus_publish: 'write',
  bus_read: 'read',
  bus_topics: 'read',
```

- [ ] **Step 6: Run the new test + build** (the build boots `assertScopesCoverTools`, which throws if a bus tool lacks a scope).

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && ~/.nvm/versions/node/v20.19.6/bin/node --test --test-reporter=spec dist-test/__tests__/bus/bus-tool.test.js && cd /home/ubuntu/lm-assist && ./core.sh build`
Expected: PASS + clean compile.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/mcp-server/tools/_passthrough.ts core/src/mcp-server/tools/bus.ts core/src/mcp-server/tools/expanded.ts core/src/mcp-server/configure.ts core/src/__tests__/bus/bus-tool.test.ts && git commit -m "feat(bus): bus_publish/bus_read/bus_topics MCP tools + TOOL_SCOPES

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 13: Full verification + dev boot + fleet e2e checklist

**Files:**
- Test: none new (runs the whole `dist-test/__tests__/bus/` suite + a live dev boot)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Run the whole bus unit suite**

Run:
```bash
cd /home/ubuntu/lm-assist/core && npm run build:test && \
~/.nvm/versions/node/v20.19.6/bin/node --test --test-reporter=spec dist-test/__tests__/bus/
```
Expected: all Task 1–12 test files PASS.

- [ ] **Step 2: Full build + regression of the fabric suite** (W3 modified fabric-link/peer-link/rpc-server/index — prove no W2 regression)

Run:
```bash
cd /home/ubuntu/lm-assist && ./core.sh build && \
cd core && ~/.nvm/versions/node/v20.19.6/bin/node --test --test-reporter=spec dist-test/__tests__/fabric/
```
Expected: clean compile + the W2 fabric tests still PASS.

- [ ] **Step 3: Dev boot smoke test**

Run:
```bash
cd /home/ubuntu/lm-assist && ./core.sh restart && sleep 3 && \
curl -s localhost:3200/health && \
curl -s -XPOST localhost:3200/bus/publish -H 'content-type: application/json' -d '{"topic":"app:smoke","type":"hello","payload":{"n":1}}' && \
curl -s 'localhost:3200/bus/read?topic=app:smoke' && \
curl -s localhost:3200/bus/topics && \
curl -s 'localhost:3200/status/full?section=bus'
```
Expected: health ok; publish returns `{id:"<self>:1", seq:1}`; read returns the event + a `nextCursor`; topics lists `app:smoke`; the `bus` status section reports `1 topics · 1 events`.

- [ ] **Step 4: Verify the kill-switch**

Run:
```bash
curl -s -XPUT localhost:3200/project-settings -H 'content-type: application/json' -d '{"busEnabled":false}' && \
curl -s -XPOST localhost:3200/bus/publish -H 'content-type: application/json' -d '{"topic":"app:smoke","type":"x"}'
```
Expected: the publish returns `success:false` with a `BUS_PUBLISH_FAILED` / "disabled" message. Re-enable: `curl -s -XPUT localhost:3200/project-settings -H 'content-type: application/json' -d '{"busEnabled":true}'`.

- [ ] **Step 5: Commit the checklist run notes (if any transient fix was needed); otherwise no-op.**

- [ ] **Step 6: Fleet e2e checklist (deploy-time — the W3 row of the spec's §6; NOT part of this coding session unless the user asks).** Deploy per the deploy-gotchas memory (SYNC `core/dist`+`core/scripts`, or build a tgz + `npm install -g <tgz>`; never `lm-assist upgrade` without `--from`). Use **two nodes in the SAME cluster with a confirmed `via:host` fabric link** (the peer-fabric program proved 123⇄107 live; if using 117⇄123 they must be co-clustered for a link to exist — W1's peer list is cluster-filtered). Then:

1. **Live publish → consume <1s:** on the publisher, `POST /bus/publish {topic:"app:e2e", type:"ping", payload:{t:<now>}}`. On the consumer, `GET /bus/read?topic=app:e2e&wait=5000` (started first). Expect the event within ~1s (`node_status(section="bus")` on the consumer shows the topic with the publisher as an origin; `node_status(section="network")` shows the link `via:host`).
2. **Consumer restart → cursor resume:** register a durable in-process subscriber (or note the consumer's persisted cursor via `GET /status/full?section=bus`), restart the consumer Core, publish 2 more events during the downtime, and confirm on restart the consumer catches up EXACTLY those 2 (no dupes, no loss) via the on-connect `catchupPeer` + durable cursor.
3. **Partition → catch-up:** `forceMode:'relay'` or drop the link mid-run, publish N events on the publisher, restore the link, and confirm the consumer converges to the publisher's head within one reconcile (~5 min ceiling; on-connect catch-up should heal in seconds).
4. **Mixed-version safety:** include one non-bus peer (a W1/W2 node, no `bus` feature). Confirm the publisher's `fabricBusPeers()` excludes it, it is never sent a `pub` frame, and nothing errors.

---

## Self-Review (run after writing; fixed inline)

**1. Spec coverage (§5 S1 + §6 W3 row):**
- **Topic = named append-only log; resource-vocabulary names** — free-form topic strings; `data:`/`mission:`/`session:`/`node:`/`app:` are conventions surfaced in the `bus_publish` description (Task 12). ✓
- **Event `{topic, origin, seq, type, payload, at}`, per-origin monotonic seq, global id `origin:seq`, idempotent ingest keyed `(origin,seq)`, no LWW** — `BusEvent` (T2), `nextSeq`/`append`/idempotent `ingest` (T3), `globalId` (T2). ✓
- **Storage `bus.lmdb` keyed `(topic,origin,seq)`, dev/prod-separated** — `BusStore` array keys + `getCacheDir('bus')` (T3). ✓
- **Retention (10k/7d) + compaction sweep** — `retention.ts` + `BusStore.sweep()`, env-tunable (T4). ✓
- **Payload cap 64KB → ref** — `BUS_PAYLOAD_CAP` + publish guard + `BusEvent.ref` (T2/T5). ✓
- **Publish: local append → `pub` fan-out to subscribed peers (cluster default; fleet)** — `Bus.publish` + `fabricPublish`/`fabricBusPeers` + `pub` frame (T5/T6/T7). Cluster-scope inherited from W1's cluster-filtered `fabricLinks`; `scope` threaded (fleet cross-cluster deferred — see below). ✓
- **Subscribe in-process + durable cursor `{subscriberId, topic→origin→seq}`; restart resumes exactly** — `Bus.subscribe` + `cursors` sub-db (T3/T5); e2e step 2 (T13). ✓
- **Catch-up `bus/:topic/since {cursors}` on link recovery/boot + slow ~5min reconcile** — `POST /bus/:topic/since` route (T8), `fabricBusCatchup` via `fabricRequestManaged` (T9), on-connect `catchupPeer` in `attachFabricLink` (T7), `reconcile` interval (T9). ✓
- **MCP `bus_publish`/`bus_read`(long-poll ≤25s, events+nextCursor, stateless)/`bus_topics` + TOOL_SCOPES** — Task 12. ✓
- **Topics bridge to `/stream` SSE** — `initBusEvents`/`busEventToSse` (T10). ✓
- **Status provider: topics, backlog, cursor lags, fan-out failures** — `Bus.statusReport` + registry (T5/T11). (Fan-out failures: fan-out is fire-and-forget; the provider surfaces backlog + max cursor lag, which is how a fan-out gap manifests. A dedicated fan-out-failure counter is noted as a refinement.) ✓
- **Kill-switch `busEnabled`** — Task 1, gates publish/ingest/subscribe/fan-out/catch-up. ✓
- **§6 W3 e2e (117 pub→123 consume <1s; consumer restart→cursor resume; partition→catch-up; `busEnabled`)** — Task 13 checklist. ✓
- **Global constraints** — reuse W2 fabric via `fabricRequestManaged` for catch-up + `peerHasFeature('bus')` gating (T7/T9); NO hub/transport changes; TOOL_SCOPES for all 3 tools (T12); dev/prod-separated `bus.lmdb` + env retention (T3/T4); wire-additive mixed-version incl. a non-bus peer (T6/T7 + e2e 13.6.4); CJS build; full-node-path test command. ✓

**2. Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to Task N". Every code step carries complete code. The fleet e2e (13.6) is deploy-time verification (explicitly out of the coding session, matching the W1/W2 house style), not a code placeholder.

**3. Type consistency (checked across tasks):** `BusEvent`/`BusRef`/`BusCursor`/`BUS_PAYLOAD_CAP`/`globalId`/`encodeCursor`/`decodeCursor`/`mergeCursor`/`payloadSize` defined in T2, consumed identically in T3/T5/T8/T10/T12. `BusStore` methods (`nextSeq`/`append`/`ingest`/`get`/`readSince`/`maxCursor`/`listTopics`/`getCursor`/`setCursor`/`sweep`/`allTopicNames`) defined T3/T4, consumed in T5/T9. `Bus` surface (`publish`/`ingest`/`ingestFromWire`/`subscribe`/`read`/`since`/`topics`/`onLocalEvent`/`statusReport`/`catchupPeer`/`reconcile`/`start`/`stop`) defined T5/T9, consumed in T8/T9/T10/T11 + `getBus()` singleton. `getBus`/`__setBusForTest` (T5) used in T8/T9/T10/T11/rest-server. Fabric additions `fabricSelfNode`/`fabricBusPeers`/`fabricPublish` (T7) + `fabricBusCatchup` (T9) consumed by `getBus()` fanout + `Bus.catchupCall` (both via untyped `require('../fabric')` to avoid a compile cycle) and the `../bus` type on the fabric side (`getBus().ingestFromWire`/`.catchupPeer`). `FabricLinkDeps.onBus` (T6) supplied in T7's `attachFabricLink`. `RpcServerDeps.busEnabled` (T9) supplied in T7's `createRpcServer` deps — note the ordering: T7 adds the `busEnabled` dep line and T9 adds the field it satisfies; run T9 right after T7 (both touch `attachFabricLink`/`rpc-server.ts`), and `./core.sh build` at the end of T9 is the first point the two must compile together (a standalone build after T7 alone would flag the unknown `busEnabled` dep — acceptable as a mid-task state; the T9 build closes it). `workerGetLong` (T12) added to `_passthrough` and used only in `bus.ts`. `busEventToSse` (T10) pure + exported for its test.

**Resolved spec ambiguities:**
- **"fan-out to SUBSCRIBED peers" vs replica broadcast** — resolved as: fan out to in-scope bus-capable connected peers; the RECEIVER durably ingests regardless and only *delivers* to its local subscribers (idempotent-replica semantics). A cross-node subscription-interest registry is deferred (the S3 first-consumers — missions — are wanted on every in-cluster node anyway).
- **Catch-up reliability vs the default-off general RPC** — `fabricRpcEnabled` defaults **false** with no route allow-list; rather than force it on (unsafe, unscoped), the bus reaches its own `/bus/:topic/since` over `fabricRequestManaged` through a **scoped rpc-server allow-list** gated by `busEnabled` (the first entry of the allow-list W4 generalizes). So the bus is self-contained under `busEnabled` alone. Fan-out (`pub`) never touches the RPC server at all.
- **`busEnabled` default** — chosen `true` (wire-additive, capability-gated, no publishers until used, needed for live e2e; mirrors `fabricEnabled`).

**Deliberately deferred out of W3:**
- **Cross-cluster `fleet`-topic delivery** — W1 establishes only same-cluster fabric links, so live fleet fan-out reaches same-cluster peers today; `scope:'fleet'` is threaded on the event for the future cross-cluster hop (hub relay or cross-cluster links). Cluster-scope (the default + the S3 use case) is fully live.
- **Auto-offload of >64KB payloads** — W3 enforces the cap and carries a caller-supplied `ref`; automatic dataset/bulk-handle offload of an oversized payload is a follow-up (the `ref` field + guard are in place).
- **Data-service change-notify → bus + the first real consumers (missions/mission-workflows)** — that is **W4** (§6). W3 ships the bus and its `bus_*`/API surface; W4 wires producers/consumers.
- **A dedicated fan-out-failure counter** and a cross-node subscription-interest registry — refinements; the status provider surfaces backlog + cursor lag today.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-03-peer-fabric-w3-bus.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. Note the T7→T9 coupling (both touch `attachFabricLink`/`rpc-server.ts`): run them back-to-back and let T9's `./core.sh build` be the joint compile gate.
2. **Inline Execution** — execute tasks in this session with checkpoints (superpowers:executing-plans).
