# Peer Fabric — Wave 1 (Network Layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Managed peer links over the existing hybrid transport (state machine + HELLO/versioning + LAN path policy + legacy fallback), a Resolution Service (resource → node), and a general status surface (`StatusRegistry`, `GET /fabric/status`, `GET /status/full`, MCP `node_status`).

**Architecture:** A `fabric` module wraps the frozen `Channel` contract from `core/src/transport/` (no transport changes). Inbound channels are demuxed by the existing first-control-frame subsystem-tag convention (`core/src/file-transfer/protocol.ts`): file transfer sends `{"type":"lm-file-transfer/1"}` first; the fabric sends `{"type":"lm-fabric/1", kind:"hello", …}` first. A `PeerManager` keeps one outbound link per online in-cluster peer. Resolution and status are separate modules consumed by routes + one new MCP tool. Spec: `docs/superpowers/specs/2026-07-02-peer-fabric-bus-data-design.md` (Part 1 + W1 row of Part 4).

**Tech Stack:** TypeScript (CommonJS build), `node:test` + `assert/strict`, LMDB not needed in W1, no new dependencies.

## Global Constraints

- Branch: `feat/peer-fabric-bus-data` (already exists; work on it).
- Node ≥ 20.9; run every npm command from the repo ROOT or `core/` exactly as written (workspaces hoist deps).
- Do NOT touch dependency versions (chokidar stays `^3.6.0`; no new packages).
- Build: `./core.sh build` (from `/home/ubuntu/lm-assist`). Tests: `cd /home/ubuntu/lm-assist/core && npm test` (compiles `tsconfig.test.json` → runs `node --test dist-test/__tests__/**/*.test.js`). To run ONE test file: `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/fabric/<name>.test.js`.
- EVERY new MCP tool MUST get a `TOOL_SCOPES` entry in `core/src/mcp-server/configure.ts` or Core crashes on the first `/mcp` request (`assertScopesCoverTools`).
- No hub (LangMartDesign) changes. No transport-module (`core/src/transport/`) changes.
- Path trust policy: general traffic direct only when `channel.via === 'host'`; otherwise the TLS relay floor (`sendControl`). Never plaintext WAN.
- Kill-switch: `fabricEnabled` project setting, default `true`.
- Commit after every task. End commit messages with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File Structure (what W1 creates/modifies)

```
core/src/fabric/protocol.ts          NEW  fabric subsystem tag + hello frames (wire-compatible with file-transfer framing)
core/src/fabric/link-state.ts        NEW  pure link lifecycle reducer + backoff
core/src/fabric/inbound-router.ts    NEW  first-frame demux with replay wrapper
core/src/fabric/peer-link.ts         NEW  one link: hello handshake, policy, snapshot
core/src/fabric/peer-manager.ts      NEW  roster reconcile, links to online cluster peers
core/src/fabric/index.ts             NEW  singleton wiring: initFabric/getFabricStatus/acceptInboundFabric
core/src/status/status-registry.ts   NEW  general status providers + snapshot
core/src/resolution/resolution-service.ts NEW  cache + resolver registry
core/src/resolution/resolvers.ts     NEW  session/dataset/role/mission resolvers (deps-injected)
core/src/resolution/index.ts         NEW  singleton with real deps
core/src/routes/core/fabric.routes.ts NEW GET /fabric/status, GET /status/full
core/src/mcp-server/tools/node-status.ts NEW node_status MCP tool
core/src/project-settings.ts         MOD  fabricEnabled flag
core/src/hub-client/index.ts         MOD  initFabric + inbound demux (lines ~467-483)
core/src/hub-client/api-relay-handler.ts MOD  allow-list '/fabric'
core/src/routes/core/index.ts        MOD  register fabric routes + status providers
core/src/mcp-server/tools/expanded.ts MOD register tool defs/handlers
core/src/mcp-server/configure.ts     MOD  TOOL_SCOPES node_status
core/src/__tests__/fabric/*.test.ts  NEW  unit tests per module
core/src/__tests__/resolution/*.test.ts NEW
core/src/__tests__/status/*.test.ts  NEW
```

---

### Task 1: `fabricEnabled` project setting

**Files:**
- Modify: `core/src/project-settings.ts` (4 places: interface, DEFAULTS, load-coerce, save-merge)
- Test: `core/src/__tests__/fabric/settings-flag.test.ts`

**Interfaces:**
- Produces: `getProjectSettings().fabricEnabled: boolean` (default `true`) — read by Task 7 wiring.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/settings-flag.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULTS } from '../../project-settings';

test('fabricEnabled defaults to true', () => {
  assert.equal((DEFAULTS as Record<string, unknown>).fabricEnabled, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/fabric/settings-flag.test.js`
Expected: FAIL (`fabricEnabled` undefined). If `DEFAULTS` is not exported, the compile fails — check the export name first (`grep -n "export const DEFAULTS" core/src/project-settings.ts`); mission work already exports it ("DEFAULTS now exported").

- [ ] **Step 3: Implement — add the flag in all four places** (follow the exact pattern of `ruleSyncEnabled`, the most recent boolean flag)

In the `ProjectSettings` interface (after `ruleSyncEnabled: boolean;`):
```ts
  /** Peer fabric: managed node-to-node links over the hybrid transport. Default true. */
  fabricEnabled: boolean;
```
In `DEFAULTS`:
```ts
  fabricEnabled: true,
```
In the load/coerce function (same block that coerces `ruleSyncEnabled`):
```ts
      fabricEnabled: typeof data.fabricEnabled === 'boolean' ? data.fabricEnabled : DEFAULTS.fabricEnabled,
```
In the save/merge function (same block that merges `ruleSyncEnabled`):
```ts
    fabricEnabled: typeof partial.fabricEnabled === 'boolean' ? partial.fabricEnabled : current.fabricEnabled,
```

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/project-settings.ts core/src/__tests__/fabric/settings-flag.test.ts && git commit -m "feat(fabric): fabricEnabled project setting (default true)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Fabric protocol frames

**Files:**
- Create: `core/src/fabric/protocol.ts`
- Test: `core/src/__tests__/fabric/protocol.test.ts`

**Interfaces:**
- Consumes: `FrameReader`, `KIND_CONTROL` from `core/src/file-transfer/frame.ts` (wire format: `[4B len][0x00][utf8 json]`).
- Produces: `FABRIC_TAG = 'lm-fabric/1'`, `FABRIC_VERSION = 1`, `interface FabricHello { type; kind: 'hello'|'hello-ack'; version: number; features: string[]; node: string }`, `encodeFabricControl(msg): Buffer`, `parseFabricControl(msg: unknown): FabricHello | null`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/protocol.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FrameReader } from '../../file-transfer/frame';
import { FABRIC_TAG, FABRIC_VERSION, encodeFabricControl, parseFabricControl } from '../../fabric/protocol';

test('hello round-trips through the shared frame codec', () => {
  const hello = { type: FABRIC_TAG, kind: 'hello' as const, version: FABRIC_VERSION, features: ['status'], node: 'gw4-aaa' };
  const wire = encodeFabricControl(hello);
  const frames = new FrameReader().push(wire);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'control');
  const parsed = parseFabricControl((frames[0] as { kind: 'control'; msg: unknown }).msg);
  assert.ok(parsed);
  assert.equal(parsed!.kind, 'hello');
  assert.equal(parsed!.node, 'gw4-aaa');
});

test('parseFabricControl rejects non-fabric messages', () => {
  assert.equal(parseFabricControl({ type: 'lm-file-transfer/1' }), null);
  assert.equal(parseFabricControl(null), null);
  assert.equal(parseFabricControl({ type: FABRIC_TAG, kind: 'bogus' }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/fabric/protocol.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/fabric/protocol.ts
/**
 * Fabric wire protocol — W1 carries only link-setup control frames.
 *
 * Wire format is IDENTICAL to file-transfer's (frame.ts): [4B len][0x00][json],
 * so one FrameReader parses any subsystem and the first-frame demux convention
 * from file-transfer/protocol.ts applies: the first control frame's `type`
 * names the subsystem ('lm-file-transfer/1' vs 'lm-fabric/1').
 */
import { KIND_CONTROL } from '../file-transfer/frame';

export const FABRIC_TAG = 'lm-fabric/1';
export const FABRIC_VERSION = 1;

export interface FabricHello {
  type: typeof FABRIC_TAG;
  kind: 'hello' | 'hello-ack';
  version: number;
  features: string[];
  node: string; // sender's gatewayId
}

export type FabricControl = FabricHello;

/** Encode a fabric control message as a length-prefixed control frame. */
export function encodeFabricControl(msg: FabricControl): Buffer {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const payload = Buffer.allocUnsafe(1 + json.length);
  payload[0] = KIND_CONTROL;
  json.copy(payload, 1);
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32BE(payload.length >>> 0, 0);
  payload.copy(out, 4);
  return out;
}

/** Parse an already-decoded control-frame body into a FabricHello, or null. */
export function parseFabricControl(msg: unknown): FabricHello | null {
  const m = msg as Record<string, unknown> | null;
  if (!m || m.type !== FABRIC_TAG) return null;
  if (m.kind !== 'hello' && m.kind !== 'hello-ack') return null;
  return {
    type: FABRIC_TAG,
    kind: m.kind,
    version: typeof m.version === 'number' ? m.version : 0,
    features: Array.isArray(m.features) ? (m.features as string[]) : [],
    node: typeof m.node === 'string' ? m.node : '',
  };
}
```

- [ ] **Step 4: Run test to verify it passes** (same command). Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/protocol.ts core/src/__tests__/fabric/protocol.test.ts && git commit -m "feat(fabric): protocol frames (lm-fabric/1 hello) on the shared frame codec

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Link state machine (pure)

**Files:**
- Create: `core/src/fabric/link-state.ts`
- Test: `core/src/__tests__/fabric/link-state.test.ts`

**Interfaces:**
- Produces: `type LinkState = 'discovered'|'connecting'|'connected'|'legacy'|'failed'|'idle'`; `interface LinkCore { state: LinkState; since: number; attempts: number; lastError: string|null }`; `reduceLink(core, ev, now): LinkCore` with `ev.type ∈ 'open-requested'|'hello-ok'|'hello-timeout'|'open-failed'|'channel-closed'|'peer-offline'|'retry-due'`; `backoffMs(attempts): number` (30s·2^(attempts-1), cap 600s). `degraded` is DERIVED (Task 5: `connected && channel.mode === 'relay'`), not a stored state.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/link-state.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { reduceLink, backoffMs, type LinkCore } from '../../fabric/link-state';

const at = (state: LinkCore['state'], attempts = 0): LinkCore =>
  ({ state, since: 1000, attempts, lastError: null });

test('happy path: discovered → connecting → connected', () => {
  let c = at('discovered');
  c = reduceLink(c, { type: 'open-requested' }, 2000);
  assert.equal(c.state, 'connecting');
  c = reduceLink(c, { type: 'hello-ok' }, 3000);
  assert.equal(c.state, 'connected');
  assert.equal(c.attempts, 0); // reset on success
  assert.equal(c.since, 3000);
});

test('hello-timeout marks legacy; open-failed marks failed with attempts++', () => {
  assert.equal(reduceLink(at('connecting'), { type: 'hello-timeout' }, 2000).state, 'legacy');
  const f = reduceLink(at('connecting', 1), { type: 'open-failed', error: 'boom' }, 2000);
  assert.equal(f.state, 'failed');
  assert.equal(f.attempts, 2);
  assert.equal(f.lastError, 'boom');
});

test('connected channel-closed → failed; retry-due from failed → connecting; peer-offline → idle', () => {
  assert.equal(reduceLink(at('connected'), { type: 'channel-closed', error: 'ws down' }, 2000).state, 'failed');
  assert.equal(reduceLink(at('failed', 2), { type: 'retry-due' }, 2000).state, 'connecting');
  assert.equal(reduceLink(at('connected'), { type: 'peer-offline' }, 2000).state, 'idle');
});

test('backoff doubles from 30s and caps at 600s', () => {
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 60_000);
  assert.equal(backoffMs(6), 600_000);
  assert.equal(backoffMs(10), 600_000);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/fabric/link-state.ts
/** Pure link lifecycle. `degraded` is DERIVED at snapshot time (connected + relay mode). */
export type LinkState = 'discovered' | 'connecting' | 'connected' | 'legacy' | 'failed' | 'idle';

export interface LinkCore {
  state: LinkState;
  since: number;
  attempts: number;      // consecutive failed opens (reset on hello-ok)
  lastError: string | null;
}

export type LinkEvent =
  | { type: 'open-requested' }
  | { type: 'hello-ok' }
  | { type: 'hello-timeout' }
  | { type: 'open-failed'; error: string }
  | { type: 'channel-closed'; error?: string }
  | { type: 'peer-offline' }
  | { type: 'retry-due' };

export function reduceLink(c: LinkCore, ev: LinkEvent, now: number): LinkCore {
  const to = (state: LinkState, patch: Partial<LinkCore> = {}): LinkCore =>
    ({ ...c, state, since: now, ...patch });
  switch (ev.type) {
    case 'open-requested': return to('connecting');
    case 'hello-ok':       return to('connected', { attempts: 0, lastError: null });
    case 'hello-timeout':  return to('legacy', { lastError: 'no fabric hello (legacy peer)' });
    case 'open-failed':    return to('failed', { attempts: c.attempts + 1, lastError: ev.error });
    case 'channel-closed': return c.state === 'idle' ? c : to('failed', { attempts: c.attempts + 1, lastError: ev.error ?? 'channel closed' });
    case 'peer-offline':   return to('idle');
    case 'retry-due':      return c.state === 'failed' ? to('connecting') : c;
    default:               return c;
  }
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 600_000;

export function backoffMs(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
}
```

- [ ] **Step 4: Run test to verify it passes.**

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/link-state.ts core/src/__tests__/fabric/link-state.test.ts && git commit -m "feat(fabric): pure link lifecycle reducer + backoff

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Inbound first-frame router (demux with replay)

**Files:**
- Create: `core/src/fabric/inbound-router.ts`
- Test: `core/src/__tests__/fabric/inbound-router.test.ts`

**Interfaces:**
- Consumes: `FrameReader` (file-transfer/frame), `FABRIC_TAG` (Task 2). A minimal channel shape `RoutableChannel { onData(cb); onClose(cb); … }` — the transport `Channel`'s `onData`/`onClose` register a SINGLE callback (last wins), which is why the wrapper must replay buffered chunks.
- Produces: `routeInboundChannel(ch, routes, timeoutMs?)` where `routes = { fabric: (ch: ReplayedChannel) => void; fileTransfer: (ch: ReplayedChannel) => void }`. The chosen handler receives a channel whose `onData` first replays ALL buffered raw chunks (in order), then passes live chunks through — so each subsystem runs its own FrameReader from byte 0 (file-transfer already "tolerates the tag frame appearing first"; the fabric re-parses its own hello). Undecidable within `timeoutMs` (default 3000ms) → route to `fileTransfer` (today's behavior).

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/inbound-router.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { routeInboundChannel } from '../../fabric/inbound-router';
import { encodeFabricControl, FABRIC_TAG, FABRIC_VERSION } from '../../fabric/protocol';
import { FrameReader } from '../../file-transfer/frame';

function fakeChannel() {
  let dataCb: ((d: Buffer) => void) | null = null;
  let closeCb: ((r?: string) => void) | null = null;
  return {
    peerGatewayId: 'gw4-peer',
    onData: (cb: (d: Buffer) => void) => { dataCb = cb; },
    onClose: (cb: (r?: string) => void) => { closeCb = cb; },
    feed: (d: Buffer) => dataCb && dataCb(d),
    fireClose: (r?: string) => closeCb && closeCb(r),
  };
}

const helloWire = () => encodeFabricControl({ type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: [], node: 'gw4-peer' });
const ftTagWire = () => {
  const json = Buffer.from(JSON.stringify({ type: 'lm-file-transfer/1' }), 'utf8');
  const payload = Buffer.concat([Buffer.from([0x00]), json]);
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  payload.copy(out, 4);
  return out;
};

test('fabric hello routes to fabric and replays the hello to the handler', async () => {
  const ch = fakeChannel();
  const got: string[] = [];
  routeInboundChannel(ch as never, {
    fabric: (routed) => {
      const reader = new FrameReader();
      routed.onData((chunk: Buffer) => {
        for (const f of reader.push(chunk)) if (f.kind === 'control') got.push((f.msg as { kind?: string }).kind ?? '?');
      });
    },
    fileTransfer: () => got.push('WRONG'),
  });
  ch.feed(helloWire());
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, ['hello']);
});

test('file-transfer tag routes to fileTransfer with replay; split frames handled', async () => {
  const ch = fakeChannel();
  let routedTo = '';
  let replayed = 0;
  routeInboundChannel(ch as never, {
    fabric: () => { routedTo = 'fabric'; },
    fileTransfer: (routed) => {
      routedTo = 'ft';
      routed.onData((chunk: Buffer) => { replayed += chunk.length; });
    },
  });
  const wire = ftTagWire();
  ch.feed(wire.subarray(0, 3));      // split mid-prefix — must buffer, not decide
  ch.feed(wire.subarray(3));
  await new Promise((r) => setImmediate(r));
  assert.equal(routedTo, 'ft');
  assert.equal(replayed, wire.length); // every raw byte replayed
});

test('timeout with no decodable frame defaults to fileTransfer', async () => {
  const ch = fakeChannel();
  let routedTo = '';
  routeInboundChannel(ch as never, {
    fabric: () => { routedTo = 'fabric'; },
    fileTransfer: () => { routedTo = 'ft'; },
  }, 20);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(routedTo, 'ft');
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/fabric/inbound-router.ts
/**
 * First-frame subsystem demux for inbound transport channels (the convention
 * documented in file-transfer/protocol.ts). Buffers raw chunks until the first
 * control frame decodes, picks the subsystem by its `type`, then hands the
 * handler a channel whose onData REPLAYS the buffered bytes before going live
 * (Channel.onData registers a single callback — last wins — so the handler's
 * own FrameReader sees the stream from byte 0).
 */
import { FrameReader } from '../file-transfer/frame';
import { FABRIC_TAG } from './protocol';

export interface RoutableChannel {
  onData(cb: (d: Buffer) => void): void;
  onClose(cb: (r?: string) => void): void;
  [k: string]: unknown;
}

export interface InboundRoutes {
  fabric: (ch: RoutableChannel) => void;
  fileTransfer: (ch: RoutableChannel) => void;
}

export function routeInboundChannel(ch: RoutableChannel, routes: InboundRoutes, timeoutMs = 3000): void {
  const reader = new FrameReader();
  const buffered: Buffer[] = [];
  let decided = false;
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => decide('fileTransfer'), timeoutMs);

  function decide(which: keyof InboundRoutes): void {
    if (decided) return;
    decided = true;
    if (timer) { clearTimeout(timer); timer = null; }
    routes[which](makeReplayed(ch, buffered));
  }

  ch.onData((chunk: Buffer) => {
    if (decided) { buffered.push(chunk); return; } // makeReplayed drains these too
    buffered.push(chunk);
    let frames;
    try { frames = reader.push(chunk); } catch { decide('fileTransfer'); return; }
    if (!frames.length) return;
    const first = frames[0];
    const isFabric = first.kind === 'control' && (first.msg as { type?: string } | null)?.type === FABRIC_TAG;
    decide(isFabric ? 'fabric' : 'fileTransfer');
  });
}

/** Wrap `ch` so the handler's onData first receives `buffered` (in order), then live chunks. */
function makeReplayed(ch: RoutableChannel, buffered: Buffer[]): RoutableChannel {
  const wrapped: RoutableChannel = Object.create(ch);
  wrapped.onData = (cb: (d: Buffer) => void) => {
    // Take over the underlying stream: append post-decision chunks to `buffered`
    // until the microtask replay below drains it, preserving order.
    let draining = true;
    ch.onData((d: Buffer) => { if (draining) buffered.push(d); else cb(d); });
    queueMicrotask(() => {
      while (buffered.length) cb(buffered.shift() as Buffer);
      draining = false;
    });
  };
  return wrapped;
}
```

- [ ] **Step 4: Run test to verify it passes** (all 3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/inbound-router.ts core/src/__tests__/fabric/inbound-router.test.ts && git commit -m "feat(fabric): inbound first-frame demux with byte replay

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: PeerLink (hello handshake, policy, snapshot)

**Files:**
- Create: `core/src/fabric/peer-link.ts`
- Test: `core/src/__tests__/fabric/peer-link.test.ts`

**Interfaces:**
- Consumes: Task 2 protocol, Task 3 reducer. Channel-shaped dep (subset of `transport/index.ts` `Channel`): `{ mode: 'bidi'|'oneway'|'relay'; via: 'host'|'static'|'srflx'|null; rtt: number|null; sendControl(b: Buffer): void; onData(cb): void; onClose(cb): void; close(): void }`.
- Produces:
  - `class PeerLink` — `constructor(peer: string, deps: PeerLinkDeps)`; `open(): Promise<void>` (initiator); `adopt(ch): void` (answerer — channel already routed by Task 4, hello arrives via replay); `policy(): 'direct'|'relay'` (`via === 'host'` → direct); `snapshot(): PeerLinkSnapshot`; `close(reason?): void`; `core: LinkCore` (readable state).
  - `interface PeerLinkDeps { openChannel(peer: string): Promise<LinkChannel>; selfNode: string; now(): number; helloTimeoutMs?: number }` (default timeout 5000ms).
  - `interface PeerLinkSnapshot { peer; state: LinkState | 'degraded'; mode; via; rttMs; pathInUse: 'direct'|'relay-floor'|'legacy-proxy'|null; since; lastError; attempts; counters: { helloOk: number; helloTimeouts: number; inboundAdopted: number } }` — `state` reports `'degraded'` when connected with `mode === 'relay'`; `pathInUse` = connected ? (policy()==='direct'?'direct':'relay-floor') : state==='legacy' ? 'legacy-proxy' : null.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/peer-link.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PeerLink, type LinkChannel } from '../../fabric/peer-link';
import { encodeFabricControl, FABRIC_TAG, FABRIC_VERSION } from '../../fabric/protocol';

function fakeCh(over: Partial<LinkChannel> = {}) {
  const sent: Buffer[] = [];
  let dataCb: ((d: Buffer) => void) | null = null;
  const ch = {
    mode: 'bidi' as const, via: 'host' as const, rtt: 3,
    sendControl: (b: Buffer) => sent.push(b),
    onData: (cb: (d: Buffer) => void) => { dataCb = cb; },
    onClose: (_cb: (r?: string) => void) => {},
    close: () => {},
    ...over,
  };
  return { ch: ch as LinkChannel, sent, reply: (b: Buffer) => dataCb && dataCb(b) };
}
const ack = () => encodeFabricControl({ type: FABRIC_TAG, kind: 'hello-ack', version: FABRIC_VERSION, features: [], node: 'gw4-peer' });

test('initiator: open sends hello, ack confirms → connected, policy direct on host', async () => {
  const f = fakeCh();
  const link = new PeerLink('gw4-peer', { openChannel: async () => f.ch, selfNode: 'gw4-self', now: () => 1, helloTimeoutMs: 1000 });
  const opening = link.open();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.sent.length, 1); // hello went out on the relay floor
  f.reply(ack());
  await opening;
  assert.equal(link.core.state, 'connected');
  assert.equal(link.policy(), 'direct');
  assert.equal(link.snapshot().pathInUse, 'direct');
});

test('initiator: no ack within timeout → legacy, pathInUse legacy-proxy', async () => {
  const f = fakeCh();
  const link = new PeerLink('gw4-peer', { openChannel: async () => f.ch, selfNode: 'gw4-self', now: () => 1, helloTimeoutMs: 10 });
  await link.open();
  assert.equal(link.core.state, 'legacy');
  assert.equal(link.snapshot().pathInUse, 'legacy-proxy');
});

test('relay-only channel: connected reports degraded + relay policy', async () => {
  const f = fakeCh({ mode: 'relay', via: null });
  const link = new PeerLink('gw4-peer', { openChannel: async () => f.ch, selfNode: 'gw4-self', now: () => 1, helloTimeoutMs: 1000 });
  const opening = link.open();
  await new Promise((r) => setImmediate(r));
  f.reply(ack());
  await opening;
  assert.equal(link.policy(), 'relay');
  assert.equal(link.snapshot().state, 'degraded');
  assert.equal(link.snapshot().pathInUse, 'relay-floor');
});

test('answerer: adopt replies hello-ack and connects', async () => {
  const f = fakeCh();
  const link = new PeerLink('gw4-peer', { openChannel: async () => { throw new Error('unused'); }, selfNode: 'gw4-self', now: () => 1 });
  link.adopt(f.ch);
  f.reply(encodeFabricControl({ type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: [], node: 'gw4-peer' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(link.core.state, 'connected');
  assert.equal(f.sent.length, 1); // the hello-ack
  assert.equal(link.snapshot().counters.inboundAdopted, 1);
});

test('open failure → failed with attempts', async () => {
  const link = new PeerLink('gw4-peer', { openChannel: async () => { throw new Error('hub not connected'); }, selfNode: 'gw4-self', now: () => 1 });
  await link.open();
  assert.equal(link.core.state, 'failed');
  assert.equal(link.core.attempts, 1);
  assert.match(link.core.lastError ?? '', /hub not connected/);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/fabric/peer-link.ts
/**
 * One managed fabric link to a peer. The HELLO handshake rides sendControl
 * (the ALWAYS-present TLS relay floor), so it works before/without a direct
 * leg. Path policy (spec N2): general traffic direct ONLY when via==='host'
 * (same LAN); otherwise the relay floor. W1 carries no payload traffic —
 * policy() is the hook W2's framing will consult per send.
 */
import { FrameReader } from '../file-transfer/frame';
import { encodeFabricControl, parseFabricControl, FABRIC_TAG, FABRIC_VERSION, type FabricHello } from './protocol';
import { reduceLink, type LinkCore, type LinkState } from './link-state';

export interface LinkChannel {
  mode: 'bidi' | 'oneway' | 'relay';
  via: 'host' | 'static' | 'srflx' | null;
  rtt: number | null;
  sendControl(b: Buffer): void;
  onData(cb: (d: Buffer) => void): void;
  onClose(cb: (r?: string) => void): void;
  close(): void;
}

export interface PeerLinkDeps {
  openChannel(peer: string): Promise<LinkChannel>;
  selfNode: string;
  now(): number;
  helloTimeoutMs?: number;
}

export interface PeerLinkSnapshot {
  peer: string;
  state: LinkState | 'degraded';
  mode: LinkChannel['mode'] | null;
  via: LinkChannel['via'];
  rttMs: number | null;
  pathInUse: 'direct' | 'relay-floor' | 'legacy-proxy' | null;
  since: number;
  lastError: string | null;
  attempts: number;
  counters: { helloOk: number; helloTimeouts: number; inboundAdopted: number };
}

const DEFAULT_HELLO_TIMEOUT_MS = 5000;

export class PeerLink {
  core: LinkCore;
  private ch: LinkChannel | null = null;
  private counters = { helloOk: 0, helloTimeouts: 0, inboundAdopted: 0 };

  constructor(readonly peer: string, private deps: PeerLinkDeps) {
    this.core = { state: 'discovered', since: deps.now(), attempts: 0, lastError: null };
  }

  private hello(kind: FabricHello['kind']): Buffer {
    return encodeFabricControl({ type: FABRIC_TAG, kind, version: FABRIC_VERSION, features: ['status'], node: this.deps.selfNode });
  }

  private reduce(ev: Parameters<typeof reduceLink>[1]): void {
    this.core = reduceLink(this.core, ev, this.deps.now());
  }

  /** Initiator: open a channel, send hello, await any fabric reply (ack or crossed hello). */
  async open(): Promise<void> {
    this.reduce({ type: 'open-requested' });
    let ch: LinkChannel;
    try {
      ch = await this.deps.openChannel(this.peer);
    } catch (e) {
      this.reduce({ type: 'open-failed', error: (e as Error).message });
      return;
    }
    this.attach(ch);
    ch.sendControl(this.hello('hello'));
    const confirmed = await this.awaitFabricReply(ch);
    if (confirmed) {
      this.counters.helloOk++;
      this.reduce({ type: 'hello-ok' });
    } else {
      this.counters.helloTimeouts++;
      this.reduce({ type: 'hello-timeout' });
      try { ch.close(); } catch { /* best-effort */ }
      this.ch = null;
    }
  }

  /** Answerer: adopt an inbound fabric channel (Task 4 routed it; hello replays via onData). */
  adopt(ch: LinkChannel): void {
    this.counters.inboundAdopted++;
    this.attach(ch);
    const reader = new FrameReader();
    ch.onData((chunk) => {
      let frames; try { frames = reader.push(chunk); } catch { return; }
      for (const f of frames) {
        if (f.kind !== 'control') continue;
        const msg = parseFabricControl(f.msg);
        if (msg?.kind === 'hello') {
          ch.sendControl(this.hello('hello-ack'));
          this.reduce({ type: 'hello-ok' });
          this.counters.helloOk++;
        }
      }
    });
  }

  private attach(ch: LinkChannel): void {
    this.ch = ch;
    ch.onClose((reason) => {
      if (this.ch === ch) {
        this.ch = null;
        this.reduce({ type: 'channel-closed', error: reason });
      }
    });
  }

  private awaitFabricReply(ch: LinkChannel): Promise<boolean> {
    const timeoutMs = this.deps.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    return new Promise((resolve) => {
      const reader = new FrameReader();
      const timer = setTimeout(() => resolve(false), timeoutMs);
      ch.onData((chunk) => {
        let frames; try { frames = reader.push(chunk); } catch { return; }
        for (const f of frames) {
          if (f.kind === 'control' && parseFabricControl(f.msg)) {
            clearTimeout(timer);
            resolve(true);
            return;
          }
        }
      });
    });
  }

  /** Spec N2 path policy: direct ONLY on a same-LAN host candidate. */
  policy(): 'direct' | 'relay' {
    return this.ch?.via === 'host' ? 'direct' : 'relay';
  }

  markPeerOffline(): void {
    if (this.ch) { try { this.ch.close(); } catch { /* best-effort */ } this.ch = null; }
    this.reduce({ type: 'peer-offline' });
  }

  close(): void {
    this.markPeerOffline();
  }

  snapshot(): PeerLinkSnapshot {
    const connected = this.core.state === 'connected' && !!this.ch;
    const degraded = connected && this.ch!.mode === 'relay';
    return {
      peer: this.peer,
      state: degraded ? 'degraded' : this.core.state,
      mode: this.ch?.mode ?? null,
      via: this.ch?.via ?? null,
      rttMs: this.ch?.rtt ?? null,
      pathInUse: connected ? (this.policy() === 'direct' ? 'direct' : 'relay-floor')
        : this.core.state === 'legacy' ? 'legacy-proxy' : null,
      since: this.core.since,
      lastError: this.core.lastError,
      attempts: this.core.attempts,
      counters: { ...this.counters },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes** (all 5 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/peer-link.ts core/src/__tests__/fabric/peer-link.test.ts && git commit -m "feat(fabric): PeerLink hello handshake, LAN path policy, snapshot

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: PeerManager (roster reconcile + link supervision)

**Files:**
- Create: `core/src/fabric/peer-manager.ts`
- Test: `core/src/__tests__/fabric/peer-manager.test.ts`

**Interfaces:**
- Consumes: `PeerLink` (Task 5), `backoffMs` (Task 3).
- Produces: `class PeerManager` — `constructor(deps: PeerManagerDeps)`; `reconcile(): Promise<void>` (one pass: open links to new online in-cluster peers, retire offline ones, retry failed ones whose backoff elapsed); `start()/stop()` (interval, default 30s); `acceptInbound(ch): void` (adopt on the peer's link, creating one if unknown — peer id from `ch.peerGatewayId`); `snapshot(): PeerLinkSnapshot[]`.
  `interface PeerManagerDeps { listPeers(): Promise<string[]>; makeLink(peer: string): PeerLinkLike; now(): number; reconcileMs?: number }` where `PeerLinkLike = Pick<PeerLink, 'open'|'adopt'|'close'|'markPeerOffline'|'snapshot'|'core'|'peer'>` (injectable for tests). W1 keeps links open while the peer is online (no idle-close — traffic arrives in W2).

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/peer-manager.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PeerManager } from '../../fabric/peer-manager';
import type { LinkCore } from '../../fabric/link-state';

function fakeLink(peer: string) {
  const calls: string[] = [];
  const core: LinkCore = { state: 'discovered', since: 0, attempts: 0, lastError: null };
  return {
    peer, core, calls,
    open: async () => { calls.push('open'); core.state = 'connected'; },
    adopt: () => { calls.push('adopt'); core.state = 'connected'; },
    close: () => { calls.push('close'); core.state = 'idle'; },
    markPeerOffline: () => { calls.push('offline'); core.state = 'idle'; },
    snapshot: () => ({ peer, state: core.state, mode: null, via: null, rttMs: null, pathInUse: null, since: 0, lastError: core.lastError, attempts: core.attempts, counters: { helloOk: 0, helloTimeouts: 0, inboundAdopted: 0 } }),
  };
}

test('reconcile opens links to new online peers and retires offline ones', async () => {
  const links = new Map<string, ReturnType<typeof fakeLink>>();
  let online = ['gw4-b', 'gw4-c'];
  const pm = new PeerManager({
    listPeers: async () => online,
    makeLink: (p) => { const l = fakeLink(p); links.set(p, l); return l; },
    now: () => 1000,
  });
  await pm.reconcile();
  assert.deepEqual([...links.keys()].sort(), ['gw4-b', 'gw4-c']);
  assert.deepEqual(links.get('gw4-b')!.calls, ['open']);

  online = ['gw4-b'];                    // c went offline
  await pm.reconcile();
  assert.ok(links.get('gw4-c')!.calls.includes('offline'));
  assert.equal(links.get('gw4-b')!.calls.filter((c) => c === 'open').length, 1); // not reopened
});

test('failed link retries only after backoff elapses', async () => {
  let now = 0;
  const l = fakeLink('gw4-b');
  l.open = async () => { l.calls.push('open'); l.core.state = 'failed'; l.core.attempts += 1; l.core.since = now; };
  const pm = new PeerManager({ listPeers: async () => ['gw4-b'], makeLink: () => l, now: () => now });
  await pm.reconcile();                  // first open → failed, attempts=1 (backoff 30s)
  assert.equal(l.calls.filter((c) => c === 'open').length, 1);
  now = 10_000; await pm.reconcile();    // 10s < 30s → no retry
  assert.equal(l.calls.filter((c) => c === 'open').length, 1);
  now = 31_000; await pm.reconcile();    // backoff elapsed → retry
  assert.equal(l.calls.filter((c) => c === 'open').length, 2);
});

test('acceptInbound adopts on the peer link (creating it if unknown)', async () => {
  const links = new Map<string, ReturnType<typeof fakeLink>>();
  const pm = new PeerManager({ listPeers: async () => [], makeLink: (p) => { const l = fakeLink(p); links.set(p, l); return l; }, now: () => 0 });
  pm.acceptInbound({ peerGatewayId: 'gw4-z' } as never);
  assert.deepEqual(links.get('gw4-z')!.calls, ['adopt']);
  assert.equal(pm.snapshot().length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/fabric/peer-manager.ts
/**
 * Supervises one PeerLink per online in-cluster peer. W1 opens links
 * proactively on roster reconcile (keeps them while the peer is online) —
 * this exercises the fabric fleet-wide and gives /fabric/status real rows;
 * W2's traffic reuses the warm links. Retry pacing uses backoffMs(attempts)
 * measured from the link's `since`.
 */
import { backoffMs, type LinkCore } from './link-state';
import type { PeerLinkSnapshot } from './peer-link';

export interface PeerLinkLike {
  peer: string;
  core: LinkCore;
  open(): Promise<void>;
  adopt(ch: unknown): void;
  close(): void;
  markPeerOffline(): void;
  snapshot(): PeerLinkSnapshot;
}

export interface PeerManagerDeps {
  listPeers(): Promise<string[]>;     // online in-cluster gatewayIds, excluding self
  makeLink(peer: string): PeerLinkLike;
  now(): number;
  reconcileMs?: number;               // default 30s
}

export class PeerManager {
  private links = new Map<string, PeerLinkLike>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;

  constructor(private deps: PeerManagerDeps) {}

  start(): void {
    if (this.timer) return;
    const ms = this.deps.reconcileMs ?? 30_000;
    this.timer = setInterval(() => { void this.reconcile(); }, ms);
    this.timer.unref?.();
    void this.reconcile();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const l of this.links.values()) l.close();
    this.links.clear();
  }

  async reconcile(): Promise<void> {
    if (this.reconciling) return;       // reentrancy guard (interval + manual)
    this.reconciling = true;
    try {
      let online: string[];
      try { online = await this.deps.listPeers(); } catch { return; } // roster unavailable → keep current state
      const onlineSet = new Set(online);
      for (const [peer, link] of this.links) {
        if (!onlineSet.has(peer) && link.core.state !== 'idle') link.markPeerOffline();
      }
      for (const peer of online) {
        let link = this.links.get(peer);
        if (!link) {
          link = this.deps.makeLink(peer);
          this.links.set(peer, link);
          await link.open();
          continue;
        }
        const s = link.core.state;
        if (s === 'idle' || s === 'discovered') { await link.open(); continue; }
        if (s === 'failed' && this.deps.now() - link.core.since >= backoffMs(link.core.attempts)) {
          await link.open();
        }
        // 'legacy' links are NOT retried here (a legacy peer stays legacy until it
        // reconnects to the hub — the roster event path in a later wave re-HELLOs).
      }
    } finally {
      this.reconciling = false;
    }
  }

  /** Inbound fabric channel from Task 4's demux — adopt on (or create) the peer's link. */
  acceptInbound(ch: { peerGatewayId?: string }): void {
    const peer = ch.peerGatewayId || 'unknown';
    let link = this.links.get(peer);
    if (!link) {
      link = this.deps.makeLink(peer);
      this.links.set(peer, link);
    }
    link.adopt(ch);
  }

  snapshot(): PeerLinkSnapshot[] {
    return [...this.links.values()].map((l) => l.snapshot());
  }
}
```

- [ ] **Step 4: Run test to verify it passes** (all 3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/peer-manager.ts core/src/__tests__/fabric/peer-manager.test.ts && git commit -m "feat(fabric): PeerManager roster reconcile + backoff retry + inbound adoption

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Fabric singleton + hub-client wiring

**Files:**
- Create: `core/src/fabric/index.ts`
- Modify: `core/src/hub-client/index.ts` (the `authenticated` handler, currently lines ~467–483)
- Test: `core/src/__tests__/fabric/fabric-init.test.ts`

**Interfaces:**
- Consumes: `openChannel`, `onInboundChannel` from `../transport` (NOTE: `onInboundChannel` callbacks are additive — the existing file-transfer registration at `hub-client/index.ts:478` is REPLACED by the demux); `listOnlineNodeIds` from `../data/peer-client`; `getHubConfig` from `../hub-client/hub-config`; `getProjectSettings` from `../project-settings`; `getMyCluster` from `../cluster/cluster-config`; `routeInboundChannel` (Task 4); `PeerLink`/`PeerManager` (Tasks 5–6); `handleIncomingTransfer` from `../file-transfer` (already imported in hub-client/index.ts).
- Produces: `initFabric(selfNode: string): void` (idempotent; no-op + teardown when `fabricEnabled === false`); `stopFabric(): void`; `getFabricStatus(): FabricStatus`; `fabricAcceptInbound(ch): void`; `interface FabricStatus { enabled: boolean; self: { node: string; cluster: string }; peers: PeerLinkSnapshot[] }`.

- [ ] **Step 1: Write the failing test** (pure surface only — real channels need a hub; that's the fleet e2e in Task 12)

```ts
// core/src/__tests__/fabric/fabric-init.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { getFabricStatus, stopFabric, __initFabricForTest } from '../../fabric';

test('status before init reports disabled with empty peers', () => {
  stopFabric();
  const s = getFabricStatus();
  assert.equal(s.enabled, false);
  assert.deepEqual(s.peers, []);
});

test('init with injected deps exposes self + peers in status', async () => {
  __initFabricForTest({
    selfNode: 'gw4-self',
    cluster: 'default',
    listPeers: async () => [],
    makeLink: (peer) => ({ peer, core: { state: 'discovered', since: 0, attempts: 0, lastError: null }, open: async () => {}, adopt: () => {}, close: () => {}, markPeerOffline: () => {}, snapshot: () => ({ peer, state: 'connected', mode: 'bidi', via: 'host', rttMs: 2, pathInUse: 'direct', since: 0, lastError: null, attempts: 0, counters: { helloOk: 1, helloTimeouts: 0, inboundAdopted: 0 } }) }),
  });
  const s = getFabricStatus();
  assert.equal(s.enabled, true);
  assert.equal(s.self.node, 'gw4-self');
  stopFabric();
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement the singleton**

```ts
// core/src/fabric/index.ts
/**
 * Fabric singleton. initFabric(selfNode) is called from the hub-client's
 * `authenticated` handler (the same place initTransport runs, so gatewayId is
 * known). Gated on projectSettings.fabricEnabled — the W1 kill-switch.
 */
import { openChannel } from '../transport';
import { PeerLink, type PeerLinkSnapshot, type LinkChannel } from './peer-link';
import { PeerManager, type PeerLinkLike } from './peer-manager';

export interface FabricStatus {
  enabled: boolean;
  self: { node: string; cluster: string };
  peers: PeerLinkSnapshot[];
}

interface FabricTestDeps {
  selfNode: string;
  cluster: string;
  listPeers: () => Promise<string[]>;
  makeLink: (peer: string) => PeerLinkLike;
}

let mgr: PeerManager | null = null;
let self = { node: '', cluster: 'default' };

export function initFabric(selfNode: string): void {
  // Lazy requires keep boot-order safe (settings/cluster/peer-client each read files).
  const { getProjectSettings } = require('../project-settings') as typeof import('../project-settings');
  if (!getProjectSettings().fabricEnabled) { stopFabric(); return; }
  if (mgr && self.node === selfNode) return; // reconnect with same id → keep links
  stopFabric();
  const { getMyCluster } = require('../cluster/cluster-config') as typeof import('../cluster/cluster-config');
  const { listOnlineNodeIds } = require('../data/peer-client') as typeof import('../data/peer-client');
  self = { node: selfNode, cluster: safeCluster(getMyCluster) };
  mgr = new PeerManager({
    listPeers: async () => (await listOnlineNodeIds()).filter((id) => id !== selfNode),
    makeLink: (peer) => new PeerLink(peer, {
      openChannel: (p) => openChannel(p) as unknown as Promise<LinkChannel>,
      selfNode,
      now: () => Date.now(),
    }),
    now: () => Date.now(),
  });
  mgr.start();
}

function safeCluster(getMyCluster: () => string): string {
  try { return getMyCluster(); } catch { return 'default'; }
}

export function stopFabric(): void {
  mgr?.stop();
  mgr = null;
}

export function getFabricStatus(): FabricStatus {
  return { enabled: !!mgr, self: { ...self }, peers: mgr ? mgr.snapshot() : [] };
}

/** Inbound fabric channel (routed by inbound-router). */
export function fabricAcceptInbound(ch: unknown): void {
  mgr?.acceptInbound(ch as { peerGatewayId?: string });
}

/** Test seam: init with fully injected deps (no transport/hub). */
export function __initFabricForTest(deps: FabricTestDeps): void {
  stopFabric();
  self = { node: deps.selfNode, cluster: deps.cluster };
  mgr = new PeerManager({ listPeers: deps.listPeers, makeLink: deps.makeLink, now: () => Date.now() });
}
```

- [ ] **Step 4: Wire the hub-client.** In `core/src/hub-client/index.ts`, replace the inbound-channel block (currently):

```ts
        if (!this.transportInboundWired) {
          this.transportInboundWired = true;
          onInboundChannel((ch) => {
            handleIncomingTransfer(ch, {}).catch((e) =>
              console.error('[HubClient] inbound transfer failed:', e));
          });
        }
```

with:

```ts
        initFabric(data.gatewayId);
        if (!this.transportInboundWired) {
          this.transportInboundWired = true;
          onInboundChannel((ch) => {
            routeInboundChannel(ch as never, {
              fabric: (routed) => fabricAcceptInbound(routed),
              fileTransfer: (routed) => {
                handleIncomingTransfer(routed as never, {}).catch((e) =>
                  console.error('[HubClient] inbound transfer failed:', e));
              },
            });
          });
        }
```

and add the imports next to the existing `initTransport, onInboundChannel` import:

```ts
import { initFabric, fabricAcceptInbound } from '../fabric';
import { routeInboundChannel } from '../fabric/inbound-router';
```

- [ ] **Step 5: Run the new test + the existing file-transfer suite** (regression: the demux must not break transfers)

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/fabric/fabric-init.test.js && node --test --test-reporter=spec "dist-test/__tests__/file-transfer/*.test.js" 2>/dev/null; node --test --test-reporter=spec dist-test/__tests__/file-transfer 2>/dev/null || true`
Expected: fabric-init PASSes; file-transfer tests (wherever they compiled under `dist-test`) still PASS. If the file-transfer test directory differs, locate with `ls dist-test/__tests__ | grep -i transfer` and run those.

- [ ] **Step 6: Full build**

Run: `cd /home/ubuntu/lm-assist && ./core.sh build`
Expected: clean compile (no TS errors).

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/index.ts core/src/hub-client/index.ts core/src/__tests__/fabric/fabric-init.test.ts && git commit -m "feat(fabric): singleton + hub wiring — initFabric on auth, inbound demux (fabric vs file-transfer)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: StatusRegistry + core providers

**Files:**
- Create: `core/src/status/status-registry.ts`
- Test: `core/src/__tests__/status/status-registry.test.ts`

**Interfaces:**
- Produces: `type StatusVerdict = 'ok'|'warn'|'error'`; `interface StatusReport { verdict: StatusVerdict; summary: string; detail?: unknown }`; `registerStatusProvider(name: string, p: () => StatusReport | Promise<StatusReport>): void` (re-register replaces); `getStatusSnapshot(section?: string): Promise<Record<string, StatusReport>>` (per-provider 2s timeout; a throwing/slow provider yields `{verdict:'error', summary:<message>}` — one bad provider never breaks the snapshot); `registerCoreStatusProviders(): void` (idempotent; registers `services`, `hub`, `fabric`).

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/status/status-registry.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { registerStatusProvider, getStatusSnapshot } from '../../status/status-registry';

test('snapshot aggregates providers; section filters; failures become error reports', async () => {
  registerStatusProvider('alpha', () => ({ verdict: 'ok', summary: 'fine' }));
  registerStatusProvider('beta', async () => ({ verdict: 'warn', summary: 'meh', detail: { n: 2 } }));
  registerStatusProvider('broken', () => { throw new Error('kaput'); });

  const all = await getStatusSnapshot();
  assert.equal(all.alpha.verdict, 'ok');
  assert.equal(all.beta.verdict, 'warn');
  assert.equal(all.broken.verdict, 'error');
  assert.match(all.broken.summary, /kaput/);

  const one = await getStatusSnapshot('beta');
  assert.deepEqual(Object.keys(one), ['beta']);
});

test('slow provider times out into an error report', async () => {
  registerStatusProvider('slow', () => new Promise((r) => setTimeout(() => r({ verdict: 'ok', summary: 'late' }), 5000)));
  const snap = await getStatusSnapshot('slow');
  assert.equal(snap.slow.verdict, 'error');
  assert.match(snap.slow.summary, /timeout/i);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found). NOTE for the timeout test: pass a small timeout via an internal constant — see implementation (`PROVIDER_TIMEOUT_MS` is module-level; the test relies on the 2s default being < 5s sleep, so the test takes ~2s — acceptable).

- [ ] **Step 3: Implement**

```ts
// core/src/status/status-registry.ts
/**
 * General node status: each subsystem registers a provider; one snapshot
 * aggregates them (spec N4). Consumers: GET /status/full + MCP node_status.
 * Narrow tools (data_sync_status, stall_status, …) keep working; new
 * subsystems join by registering — never by inventing another status surface.
 */
export type StatusVerdict = 'ok' | 'warn' | 'error';

export interface StatusReport {
  verdict: StatusVerdict;
  summary: string;
  detail?: unknown;
}

type Provider = () => StatusReport | Promise<StatusReport>;

const providers = new Map<string, Provider>();
const PROVIDER_TIMEOUT_MS = 2000;

export function registerStatusProvider(name: string, p: Provider): void {
  providers.set(name, p);
}

export async function getStatusSnapshot(section?: string): Promise<Record<string, StatusReport>> {
  const names = section ? [section].filter((n) => providers.has(n)) : [...providers.keys()];
  const out: Record<string, StatusReport> = {};
  await Promise.all(names.map(async (name) => {
    out[name] = await runOne(providers.get(name) as Provider);
  }));
  return out;
}

async function runOne(p: Provider): Promise<StatusReport> {
  try {
    const timed = new Promise<StatusReport>((_, rej) =>
      setTimeout(() => rej(new Error('provider timeout')), PROVIDER_TIMEOUT_MS).unref?.());
    return await Promise.race([Promise.resolve(p()), timed]);
  } catch (e) {
    return { verdict: 'error', summary: (e as Error).message };
  }
}

let coreRegistered = false;

/** Idempotent registration of the W1 core providers: services, hub, fabric. */
export function registerCoreStatusProviders(): void {
  if (coreRegistered) return;
  coreRegistered = true;

  registerStatusProvider('services', () => ({
    verdict: 'ok',
    summary: `core up ${Math.round(process.uptime())}s (pid ${process.pid}, node ${process.version})`,
  }));

  registerStatusProvider('hub', () => {
    // Lazy require: avoid a hub-client import cycle at module load.
    const { getHubClient, isHubConfigured } = require('../hub-client') as typeof import('../hub-client');
    if (!isHubConfigured()) return { verdict: 'warn', summary: 'hub not configured' };
    const s = getHubClient().getStatus() as { connected?: boolean; authenticated?: boolean; hubUrl?: string };
    const okay = !!s.connected && !!s.authenticated;
    return { verdict: okay ? 'ok' : 'warn', summary: okay ? `connected+authenticated to ${s.hubUrl ?? 'hub'}` : 'hub not connected/authenticated', detail: s };
  });

  registerStatusProvider('fabric', () => {
    const { getFabricStatus } = require('../fabric') as typeof import('../fabric');
    const f = getFabricStatus();
    if (!f.enabled) return { verdict: 'ok', summary: 'fabric disabled' };
    const by = (s: string) => f.peers.filter((p) => p.state === s).length;
    const direct = f.peers.filter((p) => p.pathInUse === 'direct').length;
    const verdict: StatusVerdict = by('failed') > 0 ? 'warn' : 'ok';
    return {
      verdict,
      summary: `${f.peers.length} peers — ${direct} direct · ${by('degraded')} relay · ${by('legacy')} legacy · ${by('failed')} failed`,
      detail: f,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes** (2 tests; the second takes ~2s).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/status/status-registry.ts core/src/__tests__/status/status-registry.test.ts && git commit -m "feat(status): StatusRegistry + services/hub/fabric providers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Resolution Service + resolvers

**Files:**
- Create: `core/src/resolution/resolution-service.ts`
- Create: `core/src/resolution/resolvers.ts`
- Create: `core/src/resolution/index.ts`
- Test: `core/src/__tests__/resolution/resolution.test.ts`

**Interfaces:**
- Produces:
  - `type Location = { node: string } | { cloud: true }`
  - `interface Resolver { kind: string; resolve(id: string): Promise<Location | null> }`
  - `class ResolutionService` — `register(r: Resolver)`; `resolve(kind, id): Promise<Location | null>` (TTL cache 60s positive / 10s negative, LRU cap 500); `invalidate(kind, id)`; `counters(): { hits: number; misses: number; negatives: number; invalidations: number }`
  - `buildSessionResolver(deps: { isLocal(id): Promise<boolean>; selfNode(): string; peerNodes(): Promise<string[]>; probe(node, id): Promise<boolean> }): Resolver` — order: cloud-id pattern (`/^(session_|cse_)/` → `{cloud:true}`) → local → peer probe (first hit wins) → null
  - `buildDatasetResolver(deps: { ownerOf(id): string | null }): Resolver`
  - `buildRoleResolver(deps: { leader(): Promise<string | null> }): Resolver` (only id `'leader'`)
  - `buildMissionResolver(deps: { exists(id): Promise<boolean>; leader(): Promise<string | null> }): Resolver` (missions are leader-anchored → the leader IS the mission's operating node)
  - `getResolutionService(): ResolutionService` (index.ts singleton wired with real deps: `isLocal` = loopback `workerGet('/sessions/<id>/exists')`, `probe` = `proxyGet(node, '/sessions/<id>/exists')`, `peerNodes` = `listOnlineNodeIds()` minus self, `ownerOf` = `getDatasetRegistry().get(id)?.ownerNode ?? null`, `leader` = `amIMonitor().monitorNodeId`, mission `exists` = `getMission(id) !== null`)

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/resolution/resolution.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ResolutionService } from '../../resolution/resolution-service';
import { buildSessionResolver, buildRoleResolver } from '../../resolution/resolvers';

test('session resolver: cloud pattern → cloud; local → self; else first probing peer', async () => {
  const r = buildSessionResolver({
    isLocal: async (id) => id === 'local-uuid',
    selfNode: () => 'gw4-self',
    peerNodes: async () => ['gw4-b', 'gw4-c'],
    probe: async (node, id) => node === 'gw4-c' && id === 'remote-uuid',
  });
  assert.deepEqual(await r.resolve('session_abc123'), { cloud: true });
  assert.deepEqual(await r.resolve('local-uuid'), { node: 'gw4-self' });
  assert.deepEqual(await r.resolve('remote-uuid'), { node: 'gw4-c' });
  assert.equal(await r.resolve('nowhere-uuid'), null);
});

test('service caches positives, caches negatives briefly, invalidates', async () => {
  let calls = 0;
  const svc = new ResolutionService({ ttlMs: 60_000, negTtlMs: 10_000, cap: 10 });
  svc.register({ kind: 'thing', resolve: async (id) => { calls++; return id === 'x' ? { node: 'gw4-b' } : null; } });

  assert.deepEqual(await svc.resolve('thing', 'x'), { node: 'gw4-b' });
  assert.deepEqual(await svc.resolve('thing', 'x'), { node: 'gw4-b' });
  assert.equal(calls, 1);                          // second was a cache hit
  assert.equal(await svc.resolve('thing', 'nope'), null);
  assert.equal(await svc.resolve('thing', 'nope'), null);
  assert.equal(calls, 2);                          // negative cached too
  svc.invalidate('thing', 'x');
  await svc.resolve('thing', 'x');
  assert.equal(calls, 3);                          // invalidation forced re-resolve
  const c = svc.counters();
  assert.equal(c.hits, 2);
  assert.equal(c.invalidations, 1);
});

test('role resolver answers only "leader"', async () => {
  const r = buildRoleResolver({ leader: async () => 'gw4-b' });
  assert.deepEqual(await r.resolve('leader'), { node: 'gw4-b' });
  assert.equal(await r.resolve('controller'), null);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement the service**

```ts
// core/src/resolution/resolution-service.ts
/**
 * Resource → node resolution (spec N3). A session/mission/dataset is a
 * RESOURCE; resolvers map ids to locations; callers address resources and the
 * fabric routes. Shared semantics live HERE (cache, negative cache,
 * invalidate-on-failure, counters) — resolvers stay trivial.
 */
export type Location = { node: string } | { cloud: true };

export interface Resolver {
  kind: string;
  resolve(id: string): Promise<Location | null>;
}

interface CacheEntry { loc: Location | null; at: number }

export class ResolutionService {
  private resolvers = new Map<string, Resolver>();
  private cache = new Map<string, CacheEntry>();     // key `${kind}:${id}`, Map order = LRU
  private stats = { hits: 0, misses: 0, negatives: 0, invalidations: 0 };

  constructor(private opts: { ttlMs?: number; negTtlMs?: number; cap?: number } = {}) {}

  register(r: Resolver): void { this.resolvers.set(r.kind, r); }

  async resolve(kind: string, id: string): Promise<Location | null> {
    const key = `${kind}:${id}`;
    const now = Date.now();
    const ttl = this.opts.ttlMs ?? 60_000;
    const negTtl = this.opts.negTtlMs ?? 10_000;
    const hit = this.cache.get(key);
    if (hit && now - hit.at < (hit.loc ? ttl : negTtl)) {
      this.cache.delete(key); this.cache.set(key, hit);  // LRU touch
      this.stats.hits++;
      return hit.loc;
    }
    this.stats.misses++;
    const r = this.resolvers.get(kind);
    if (!r) return null;
    let loc: Location | null = null;
    try { loc = await r.resolve(id); } catch { loc = null; }
    if (!loc) this.stats.negatives++;
    this.cache.set(key, { loc, at: now });
    const cap = this.opts.cap ?? 500;
    while (this.cache.size > cap) this.cache.delete(this.cache.keys().next().value as string);
    return loc;
  }

  /** Delivery failed at the cached location → forget it so the next resolve re-runs. */
  invalidate(kind: string, id: string): void {
    if (this.cache.delete(`${kind}:${id}`)) this.stats.invalidations++;
  }

  counters(): { hits: number; misses: number; negatives: number; invalidations: number } {
    return { ...this.stats };
  }
}
```

```ts
// core/src/resolution/resolvers.ts
/** Deps-injected resolvers — pure decision logic, IO injected (spec N3 table). */
import type { Resolver, Location } from './resolution-service';

const CLOUD_SESSION_RE = /^(session_|cse_)/;

export function buildSessionResolver(deps: {
  isLocal(id: string): Promise<boolean>;
  selfNode(): string;
  peerNodes(): Promise<string[]>;
  probe(node: string, id: string): Promise<boolean>;
}): Resolver {
  return {
    kind: 'session',
    async resolve(id: string): Promise<Location | null> {
      if (CLOUD_SESSION_RE.test(id)) return { cloud: true };
      if (await deps.isLocal(id).catch(() => false)) return { node: deps.selfNode() };
      const peers = await deps.peerNodes().catch(() => [] as string[]);
      for (const node of peers) {
        if (await deps.probe(node, id).catch(() => false)) return { node };
      }
      return null;
    },
  };
}

export function buildDatasetResolver(deps: { ownerOf(id: string): string | null }): Resolver {
  return {
    kind: 'dataset',
    async resolve(id: string): Promise<Location | null> {
      const owner = deps.ownerOf(id);
      return owner ? { node: owner } : null;
    },
  };
}

export function buildRoleResolver(deps: { leader(): Promise<string | null> }): Resolver {
  return {
    kind: 'role',
    async resolve(id: string): Promise<Location | null> {
      if (id !== 'leader') return null;
      const n = await deps.leader().catch(() => null);
      return n ? { node: n } : null;
    },
  };
}

/** Missions are leader-anchored (mission.routes proxies writes to the leader),
 *  so a mission's operating node IS the current leader — provided it exists. */
export function buildMissionResolver(deps: { exists(id: string): Promise<boolean>; leader(): Promise<string | null> }): Resolver {
  return {
    kind: 'mission',
    async resolve(id: string): Promise<Location | null> {
      if (!(await deps.exists(id).catch(() => false))) return null;
      const n = await deps.leader().catch(() => null);
      return n ? { node: n } : null;
    },
  };
}
```

```ts
// core/src/resolution/index.ts
/** Singleton wired with real deps. Lazy requires — each dep reads files/config at call time. */
import { ResolutionService } from './resolution-service';
import { buildSessionResolver, buildDatasetResolver, buildRoleResolver, buildMissionResolver } from './resolvers';

let svc: ResolutionService | null = null;

export function getResolutionService(): ResolutionService {
  if (svc) return svc;
  svc = new ResolutionService();

  const leader = async (): Promise<string | null> => {
    const { amIMonitor } = require('../monitor/stall-election') as typeof import('../monitor/stall-election');
    return (await amIMonitor()).monitorNodeId;
  };

  svc.register(buildSessionResolver({
    isLocal: async (id) => {
      const { workerGet } = require('../mcp-server/tools/_passthrough') as typeof import('../mcp-server/tools/_passthrough');
      const res = await workerGet<{ exists?: boolean } | boolean>(`/sessions/${encodeURIComponent(id)}/exists`).catch(() => null);
      return res === true || (typeof res === 'object' && !!res && (res as { exists?: boolean }).exists === true);
    },
    selfNode: () => {
      const { getHubConfig } = require('../hub-client/hub-config') as typeof import('../hub-client/hub-config');
      return getHubConfig().gatewayId ?? 'local';
    },
    peerNodes: async () => {
      const { listOnlineNodeIds } = require('../data/peer-client') as typeof import('../data/peer-client');
      const { getHubConfig } = require('../hub-client/hub-config') as typeof import('../hub-client/hub-config');
      const self = getHubConfig().gatewayId;
      return (await listOnlineNodeIds()).filter((n) => n !== self);
    },
    probe: async (node, id) => {
      const { proxyGet } = require('../data/peer-client') as typeof import('../data/peer-client');
      const json = await proxyGet(node, `/sessions/${encodeURIComponent(id)}/exists`).catch(() => null) as { data?: { exists?: boolean }; exists?: boolean } | null;
      return json?.data?.exists === true || json?.exists === true;
    },
  }));

  svc.register(buildDatasetResolver({
    ownerOf: (id) => {
      const { getDatasetRegistry } = require('../data/dataset-registry') as typeof import('../data/dataset-registry');
      return getDatasetRegistry().get(id)?.ownerNode ?? null;
    },
  }));

  svc.register(buildRoleResolver({ leader }));

  svc.register(buildMissionResolver({
    exists: async (id) => {
      const { getMission } = require('../mission/mission-store') as typeof import('../mission/mission-store');
      return (await getMission(id)) !== null;
    },
    leader,
  }));

  return svc;
}
```

- [ ] **Step 4: Run test to verify it passes** (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/resolution/ core/src/__tests__/resolution/resolution.test.ts && git commit -m "feat(resolution): resource→node Resolution Service (session/dataset/role/mission)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: REST routes + relay allow-list

**Files:**
- Create: `core/src/routes/core/fabric.routes.ts`
- Modify: `core/src/routes/core/index.ts` (import + spread + provider registration)
- Modify: `core/src/hub-client/api-relay-handler.ts` (ALLOWED_API_PREFIXES, lines ~94–131)
- Test: `core/src/__tests__/fabric/fabric-routes.test.ts`

**Interfaces:**
- Consumes: `getFabricStatus` (Task 7), `getStatusSnapshot`/`registerCoreStatusProviders` (Task 8), `getResolutionService` (Task 9), `wrapResponse` from `../../api/helpers`, `RouteHandler`/`RouteContext` types from `../index`.
- Produces: `createFabricRoutes(ctx): RouteHandler[]` serving `GET /fabric/status` → `{ ...FabricStatus, resolution: counters }` and `GET /status/full[?section=name]` → `{ sections: Record<string, StatusReport> }`.

- [ ] **Step 1: Write the failing test** (route shape — patterns + handler wiring; the HTTP server itself is exercised in Task 12)

```ts
// core/src/__tests__/fabric/fabric-routes.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createFabricRoutes } from '../../routes/core/fabric.routes';

test('routes expose /fabric/status and /status/full and return wrapped payloads', async () => {
  const routes = createFabricRoutes({} as never);
  const byPattern = (p: string) => routes.find((r) => r.pattern.test(p));
  assert.ok(byPattern('/fabric/status'));
  assert.ok(byPattern('/status/full'));

  const res = await byPattern('/fabric/status')!.handler({ params: {}, query: {} } as never, {} as never);
  assert.equal(res.success, true);
  assert.ok('enabled' in (res.data as Record<string, unknown>));
  assert.ok('resolution' in (res.data as Record<string, unknown>));

  const full = await byPattern('/status/full')!.handler({ params: {}, query: {} } as never, {} as never);
  assert.equal(full.success, true);
  assert.ok('sections' in (full.data as Record<string, unknown>));
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement the routes**

```ts
// core/src/routes/core/fabric.routes.ts
/**
 * Fabric + general status routes (spec N4).
 *   GET /fabric/status  → this node's peer-link table + resolution counters
 *   GET /status/full    → StatusRegistry snapshot (?section=<name> filters)
 */
import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse } from '../../api/helpers';
import { getFabricStatus } from '../../fabric';
import { getStatusSnapshot, registerCoreStatusProviders } from '../../status/status-registry';
import { getResolutionService } from '../../resolution';

export function createFabricRoutes(_ctx: RouteContext): RouteHandler[] {
  registerCoreStatusProviders(); // idempotent — first registration point at boot
  return [
    {
      method: 'GET',
      pattern: /^\/fabric\/status$/,
      handler: async () => {
        const start = Date.now();
        const status = getFabricStatus();
        return wrapResponse({ ...status, resolution: getResolutionService().counters() }, start);
      },
    },
    {
      method: 'GET',
      pattern: /^\/status\/full$/,
      handler: async (req) => {
        const start = Date.now();
        const section = typeof req.query?.section === 'string' ? req.query.section : undefined;
        const sections = await getStatusSnapshot(section);
        return wrapResponse({ sections }, start);
      },
    },
  ];
}
```

- [ ] **Step 4: Register the routes.** In `core/src/routes/core/index.ts`, next to the cluster routes (line ~60 import block, line ~120 spread block):

```ts
import { createFabricRoutes } from './fabric.routes';
```
```ts
    ...createFabricRoutes(ctx),
```

- [ ] **Step 5: Allow the relay prefix.** In `core/src/hub-client/api-relay-handler.ts`, add to `ALLOWED_API_PREFIXES` (alphabetically near `/data`):

```ts
  '/fabric',        // fabric/network status (read-only) — lets node_status(node=B) reach a peer's table
```
(`/status` is NOT added — `/status/full` is served cross-node via the MCP tool's node-routing on `/mcp`, which is already allow-listed; the bare `/status` prefix already exists for the legacy status endpoint. Verify with `grep -n "'/status'" core/src/hub-client/api-relay-handler.ts` — if absent, add `'/status',` too.)

- [ ] **Step 6: Run test to verify it passes**, then full build

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/fabric/fabric-routes.test.js && cd /home/ubuntu/lm-assist && ./core.sh build`
Expected: PASS + clean compile.

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/routes/core/fabric.routes.ts core/src/routes/core/index.ts core/src/hub-client/api-relay-handler.ts core/src/__tests__/fabric/fabric-routes.test.ts && git commit -m "feat(fabric): GET /fabric/status + GET /status/full routes, relay allow-list

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: MCP `node_status` tool

**Files:**
- Create: `core/src/mcp-server/tools/node-status.ts`
- Modify: `core/src/mcp-server/tools/expanded.ts` (import at ~line 59 block; spread into defs at ~line 1012 block and handlers at ~line 1858 block — exactly like `CLUSTER_TOOL_DEFS`/`CLUSTER_HANDLERS`)
- Modify: `core/src/mcp-server/configure.ts` (`TOOL_SCOPES` map at line ~123: add `node_status: 'read',`)
- Test: `core/src/__tests__/fabric/node-status-tool.test.ts`

**Interfaces:**
- Consumes: `ok, err, workerGet` from `./_passthrough`; `GET /status/full` (Task 10).
- Produces: `NODE_STATUS_TOOL_DEFS` (array with one def, name `node_status`, optional `section` string input, `readOnlyHint: true`), `NODE_STATUS_HANDLERS: Record<string, (args) => Promise<McpToolResult>>`, and exported pure `formatStatusSections(sections: Record<string, { verdict: string; summary: string; detail?: unknown }>, section?: string): string` (one line per subsystem `[ok] name — summary`; when a single `section` is requested, append its `detail` as pretty JSON).

- [ ] **Step 1: Write the failing test** (the pure formatter + def/scope shape)

```ts
// core/src/__tests__/fabric/node-status-tool.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { NODE_STATUS_TOOL_DEFS, formatStatusSections } from '../../mcp-server/tools/node-status';
import { TOOL_SCOPES } from '../../mcp-server/configure';

test('def is registered read-only and scoped (TOOL_SCOPES or /mcp crashes)', () => {
  assert.equal(NODE_STATUS_TOOL_DEFS.length, 1);
  assert.equal(NODE_STATUS_TOOL_DEFS[0].name, 'node_status');
  assert.equal(NODE_STATUS_TOOL_DEFS[0].annotations.readOnlyHint, true);
  assert.equal(TOOL_SCOPES['node_status'], 'read');
});

test('formatter renders one line per subsystem; section view appends detail', () => {
  const sections = {
    fabric: { verdict: 'ok', summary: '2 peers — 2 direct · 0 relay · 0 legacy · 0 failed', detail: { peers: [] } },
    hub: { verdict: 'warn', summary: 'hub not connected/authenticated' },
  };
  const all = formatStatusSections(sections);
  assert.match(all, /\[ok\] fabric — 2 peers/);
  assert.match(all, /\[warn\] hub — hub not connected/);
  const one = formatStatusSections({ fabric: sections.fabric }, 'fabric');
  assert.match(one, /"peers": \[\]/);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement the tool**

```ts
// core/src/mcp-server/tools/node-status.ts
/**
 * node_status — the GENERAL per-node status endpoint (spec N4): one call
 * reports every registered subsystem (services, hub, fabric, …future: bus,
 * data-sync, scheduler). `section` narrows to one subsystem with full detail
 * (e.g. section="network" ≡ "fabric" → the peer-link table). Cross-node via
 * the standard `node` param (hub tool routing).
 * Registration: NODE_STATUS_TOOL_DEFS + NODE_STATUS_HANDLERS → expanded.ts;
 * scope 'read' → configure.ts TOOL_SCOPES.
 */
import { ok, err, workerGet, type McpToolResult } from './_passthrough';

export const NODE_STATUS_TOOL_DEFS = [
  {
    name: 'node_status',
    description:
      'General status of an lm-assist node — every subsystem in one call: services (uptime), hub ' +
      'connection, fabric/network peer links (state, direct vs relay vs legacy, RTT), and any other ' +
      'registered provider. Pass section="network" (alias of "fabric") for the full peer-link table, ' +
      'or another section name for its detail. Pass node=<host> to read another node. Read-only.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        section: { type: 'string', description: 'Optional subsystem: "network"/"fabric", "hub", "services", … Omit for the all-subsystem summary.' },
      },
    },
  },
];

interface SectionReport { verdict: string; summary: string; detail?: unknown }

export function formatStatusSections(sections: Record<string, SectionReport>, section?: string): string {
  const names = Object.keys(sections).sort();
  if (!names.length) return section ? `No status section named "${section}".` : 'No status providers registered.';
  const lines = names.map((n) => `[${sections[n].verdict}] ${n} — ${sections[n].summary}`);
  if (section && names.length === 1 && sections[names[0]].detail !== undefined) {
    lines.push('', JSON.stringify(sections[names[0]].detail, null, 2));
  }
  return lines.join('\n');
}

export const NODE_STATUS_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  node_status: async (args) => {
    const raw = typeof args.section === 'string' ? args.section.trim().toLowerCase() : '';
    const section = raw === 'network' ? 'fabric' : raw || undefined;
    try {
      const res = await workerGet<{ sections?: Record<string, SectionReport> }>(
        `/status/full${section ? `?section=${encodeURIComponent(section)}` : ''}`,
      );
      const sections = res?.sections ?? {};
      return ok(formatStatusSections(sections, section));
    } catch (e) {
      return err(`node_status failed: ${(e as Error).message}`);
    }
  },
};
```

- [ ] **Step 4: Register.** In `core/src/mcp-server/tools/expanded.ts`:
- Import block (next to the cluster import at ~line 59): `import { NODE_STATUS_TOOL_DEFS, NODE_STATUS_HANDLERS } from './node-status';`
- Defs array (next to `...CLUSTER_TOOL_DEFS,` at ~line 1012): `...NODE_STATUS_TOOL_DEFS,`
- Handlers object (next to `...CLUSTER_HANDLERS,` at ~line 1858): `...NODE_STATUS_HANDLERS,`

In `core/src/mcp-server/configure.ts` `TOOL_SCOPES` (line ~123 map, alphabetical near `node_lifecycle: 'admin',`):
```ts
  node_status: 'read',
```

- [ ] **Step 5: Run the new test + the scopes regression test**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && node --test --test-reporter=spec dist-test/__tests__/fabric/node-status-tool.test.js && node --test --test-reporter=spec "dist-test/__tests__/**/mcp-tool-scopes.test.js"`
Expected: both PASS (the scopes test guards the crash-on-`/mcp` failure mode).

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/mcp-server/tools/node-status.ts core/src/mcp-server/tools/expanded.ts core/src/mcp-server/configure.ts core/src/__tests__/fabric/node-status-tool.test.ts && git commit -m "feat(mcp): node_status tool — general per-node status over StatusRegistry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Full verification + dev boot + fleet e2e checklist

**Files:**
- No new source. Possibly small fixes surfaced by the full suite.

- [ ] **Step 1: Full unit suite**

Run: `cd /home/ubuntu/lm-assist/core && npm test`
Expected: ALL tests pass (new fabric/resolution/status tests + every pre-existing suite — especially file-transfer and mcp-tool-scopes).

- [ ] **Step 2: Full build + dev restart**

Run: `cd /home/ubuntu/lm-assist && ./core.sh build && ./core.sh restart && sleep 5 && curl -s localhost:3200/health`
Expected: health responds with `"runningFrom":"dev-repo"`.

- [ ] **Step 3: Verify the new surfaces on dev**

```bash
curl -s localhost:3200/fabric/status | head -c 600; echo
curl -s "localhost:3200/status/full" | head -c 800; echo
curl -s "localhost:3200/status/full?section=fabric" | head -c 600; echo
```
Expected: `/fabric/status` returns `{ enabled, self:{node,cluster}, peers:[…], resolution:{…} }` (peers may be empty or show the dev hub's peers; `enabled:false` is correct if the dev hub isn't authenticated yet — then re-check after `./core.sh hub start`). `/status/full` returns `sections.services`, `sections.hub`, `sections.fabric`.

- [ ] **Step 4: Kill-switch check**

Add `"fabricEnabled": false` to `~/.lm-assist/project-settings.json` (dev reads the same file; `getProjectSettings` is mtime-cached), restart core (`./core.sh restart`), and confirm `curl -s localhost:3200/fabric/status` shows `"enabled":false` with empty peers. Remove the override and restart again.

- [ ] **Step 5: Commit any fixes; push the branch**

```bash
cd /home/ubuntu/lm-assist && git push origin feat/peer-fabric-bus-data
```

- [ ] **Step 6: Fleet e2e checklist (deploy-time, per the deploy gotchas memory — NOT part of this coding session unless the user asks):**
1. Build tgz (`npm pack`), deploy 117 → 123 → 107 (direct `npm install -g <tgz>`, never `lm-assist upgrade` without `--from`).
2. On 117: `node_status(section="network")` via MCP → expect 123 + 107 rows with `via:"host"`, `pathInUse:"direct"`, single-digit `rttMs` (all three share `10.0.1.x`).
3. On 107 (Windows): same check — if `via` is null/`relay`, Windows UDP/firewall blocked host-direct (named W1 risk): confirm `pathInUse:"relay-floor"` still reports `connected/degraded`, file a follow-up, do NOT block the wave.
4. Mixed-version proof: before upgrading 107, from 117 expect 107's row `state:"legacy"`, `pathInUse:"legacy-proxy"`; after upgrading, within one reconcile (~30s) + reconnect it flips to `connected`.
5. File-transfer regression: `transfer_send_file` 117→123 still completes (inbound demux didn't break the tag path).

---

## Self-Review (run after writing, fix inline)

1. **Spec coverage (Part 1 + W1 row):** N1 roles — no hub changes anywhere ✓; N2 links/state/HELLO/policy — Tasks 3/5 ✓; legacy detection — Tasks 3/5, fleet check 12.4 ✓; N3 Resolution Service + 4 resolver kinds — Task 9 ✓; N4 self-managed state + `/fabric/status` + StatusRegistry + `node_status` + narrow-tools-unchanged — Tasks 8/10/11 ✓; N5 fail-fast, hub-down documented, flap→degraded derived — Tasks 3/5 ✓; kill-switch — Tasks 1/7/12.4 ✓. Deliberately deferred per spec: idle-close and legacy re-HELLO restoration cadence (T7.4 is W2), `fabric_probe` (W2 T5).
2. **Placeholder scan:** no TBDs; every code step carries complete code; Task 10 Step 5 contains a conditional instruction with an exact verification command (acceptable — it resolves at execution).
3. **Type consistency:** `LinkCore`/`LinkState` (T3) consumed by T5/T6 ✓; `PeerLinkSnapshot` produced T5, consumed T6/T7/T8 ✓; `FabricStatus` produced T7, consumed T8/T10 ✓; `Location`/`Resolver` T9 internal ✓; `getFabricStatus`/`getResolutionService`/`getStatusSnapshot` names match at every use site ✓.
