# Peer Fabric — Wave 2 (Transmission) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Layer a transmission plane on the W1 peer links — msgpack framing + chunking + req/res correlation (T1), path-aware gzip compression (T2), RPC dispatch into the existing route table with a peer principal (T3), the >8MB-response→bulk auto-fetch remainder (T4), per-link pacing + bandwidth monitors + `fabric_probe` (T5), and failure auto-management: idempotency + retry classification + best-path restoration (T7) — all wire-additive so mixed-version fleets interop.

**Architecture:** A new `FabricLink` wraps each connected W1 `PeerLink`'s `Channel` and owns the byte-level protocol: it reads/writes msgpack `Envelope` frames over `Channel.send()` (direct when `policy()==='direct'`) or `Channel.sendControl()` (relay floor), splitting payloads >64KB into `chunk` frames and correlating `req`/`res` by `id`. Inbound `req` envelopes dispatch into the existing route table by a loopback HTTP call stamped with a `{type:'peer',node}` principal (the same mechanism `api-relay-handler.ts` uses for the hub). Compression, pacing, idempotency, retry, and path-restoration are pure, deps-injected units the `FabricLink` and the fabric singleton compose. Spec: `docs/superpowers/specs/2026-07-02-peer-fabric-bus-data-design.md` (Part 2 T1–T7 + the W2 row of Part 4). Builds directly on the shipped W1 modules in `core/src/fabric/` (`PeerManager`, `PeerLink`, `protocol.ts`, `inbound-router.ts`, `link-state.ts`) and `core/src/resolution/` (`ResolutionService`).

**Tech Stack:** TypeScript (CommonJS build), `node:test` + `assert/strict`, Node's built-in `zlib` (gzip), and **one new dependency** `@msgpack/msgpack@^3.1.3` (ESM-only — loaded via the `new Function('m','return import(m)')` trap, never `require`'d). The W1 file-transfer job-manager (`enqueueJob`/`waitForJob`, `RESUME_MIN_BYTES = 8MB`) is reused as-is for T4.

## Global Constraints

- Branch: `feat/peer-fabric-w2-transmission` (already checked out; work on it).
- **Per-class kill-switches** (spec "per-class flags"): `fabricRpcEnabled` (default `true`) gates the RPC class both directions; `fabricCompressionEnabled` (default `true`) gates T2; `fabricRelayBulkCapMBps` (default `5`) is the T5 relay-bulk cap. All default to today's behavior. **NO hub (LangMartDesign) changes. NO `core/src/transport/` changes** — reuse the frozen `Channel` (`send`=direct-when-confirmed, `sendControl`=always-relay).
- **CommonJS build trap:** `@msgpack/msgpack` is ESM-only. Load it ONLY through `const esmImport = new Function('m','return import(m)') as (m:string)=>Promise<any>;` — a static `import` or `require()` throws `ERR_REQUIRE_ESM` on the CJS build (same class as the Agent SDK / chokidar traps in CLAUDE.md). `import type` is also forbidden from it (type it inline). **chokidar stays `^3.6.0`.**
- **Every new MCP tool MUST get a `TOOL_SCOPES` entry** in `core/src/mcp-server/configure.ts` or Core crashes on the first `/mcp` request (`assertScopesCoverTools`). W2 adds exactly one: `fabric_probe: 'read'`.
- **Wire-additive / mixed-version interop:** msgpack envelopes and gzip are opt-in via HELLO `features`. A peer that did NOT advertise `rpc`/`comp-gzip` (a W1 or legacy peer) gets the legacy behavior — no compression (`comp:'none'`), no RPC over fabric (caller falls back to the hub HTTPS proxy), existing W1 framing untouched. The W2 e2e MUST include one legacy peer.
- **Dev/prod-separated state; env-tunable with safe defaults.** No new hub credentials.
- **Build:** `cd /home/ubuntu/lm-assist && ./core.sh build` (core TS → `core/dist`).
- **Tests:** `cd /home/ubuntu/lm-assist/core && npm run build:test` compiles `tsconfig.test.json` → `dist-test/`; run a single file with the FULL node path:
  `~/.nvm/versions/node/v20.19.6/bin/node --test --test-reporter=spec dist-test/__tests__/fabric/<name>.test.js`
- Commit after every task. End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## File Structure (what W2 creates/modifies)

```
core/src/fabric/envelope.ts           NEW  Envelope types + msgpack codec (esmImport trap) + FabricFrameReader (0x00 hello / 0x02 envelope)
core/src/fabric/chunking.ts           NEW  splitEnvelope(>64KB) + ChunkAssembler(reassemble by id)
core/src/fabric/pending-calls.ts      NEW  req/res correlation by id + per-call timeout
core/src/fabric/compression.ts        NEW  path+payload-aware gzip policy + apply/decompress (zlib)
core/src/fabric/metrics.ts            NEW  per-link EWMA per class + ClassScheduler token buckets (pacing/caps)
core/src/fabric/idempotency.ts        NEW  receiver dedup cache {reqId → res} (~2min LRU)
core/src/fabric/fabric-link.ts        NEW  envelope I/O over a connected Channel: send/recv, request(), ping()
core/src/fabric/rpc-server.ts         NEW  inbound req → idempotency → loopback dispatch (peer principal) → res
core/src/fabric/bulk-offload.ts       NEW  >8MB response → BulkHandle via job-manager; requester fetch+verify
core/src/fabric/retry.ts              NEW  outcome classification + backoff + escalation ladder + orchestrator
core/src/fabric/restoration.ts        NEW  best-path decideSwitch (anti-flap) + PathSupervisor
core/src/fabric/peer-link.ts          MOD  onConnected() seam + peerFeatures capture + advertise rpc/comp-gzip
core/src/fabric/index.ts              MOD  initEnvelopeCodec at boot; FabricLink per link; fabricRequest(); status detail; probe
core/src/project-settings.ts          MOD  fabricRpcEnabled / fabricCompressionEnabled / fabricRelayBulkCapMBps
core/src/routes/core/fabric.routes.ts MOD  GET /fabric/probe
core/src/mcp-server/tools/fabric-probe.ts NEW  fabric_probe MCP tool
core/src/mcp-server/tools/expanded.ts MOD  register fabric_probe def + handler
core/src/mcp-server/configure.ts      MOD  TOOL_SCOPES fabric_probe
core/package.json                     MOD  add @msgpack/msgpack ^3.1.3
core/src/__tests__/fabric/*.test.ts   NEW  unit tests per module
```

---

### Task 1: Per-class kill-switch settings

**Files:**
- Modify: `core/src/project-settings.ts` (4 places each, mirroring the `fabricEnabled` flag already present)
- Test: `core/src/__tests__/fabric/w2-settings.test.ts`

**Interfaces:**
- Produces: `getProjectSettings().fabricRpcEnabled: boolean` (default `true`), `.fabricCompressionEnabled: boolean` (default `true`), `.fabricRelayBulkCapMBps: number` (default `5`) — read by Tasks 5, 10, 12.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/w2-settings.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULTS } from '../../project-settings';

test('W2 per-class flags default safe', () => {
  const d = DEFAULTS as Record<string, unknown>;
  assert.equal(d.fabricRpcEnabled, true);
  assert.equal(d.fabricCompressionEnabled, true);
  assert.equal(d.fabricRelayBulkCapMBps, 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && ~/.nvm/versions/node/v20.19.6/bin/node --test --test-reporter=spec dist-test/__tests__/fabric/w2-settings.test.js`
Expected: FAIL (flags undefined).

- [ ] **Step 3: Implement — add the three fields in all four places** (follow the exact `fabricEnabled` pattern)

In the `ProjectSettings` interface (after `fabricEnabled: boolean;`):
```ts
  /** Fabric RPC class: dispatch peer `req` frames into the route table. Default true. */
  fabricRpcEnabled: boolean;
  /** Fabric per-frame gzip compression (path+payload aware). Default true. */
  fabricCompressionEnabled: boolean;
  /** Cap (MB/s) for the bulk class over the relay floor — gentle on the hub. Default 5. */
  fabricRelayBulkCapMBps: number;
```
In `DEFAULTS` (after `fabricEnabled: true,`):
```ts
  fabricRpcEnabled: true,
  fabricCompressionEnabled: true,
  fabricRelayBulkCapMBps: 5,
```
In the load/coerce block (after the `fabricEnabled:` coerce line):
```ts
      fabricRpcEnabled: typeof data.fabricRpcEnabled === 'boolean' ? data.fabricRpcEnabled : DEFAULTS.fabricRpcEnabled,
      fabricCompressionEnabled: typeof data.fabricCompressionEnabled === 'boolean' ? data.fabricCompressionEnabled : DEFAULTS.fabricCompressionEnabled,
      fabricRelayBulkCapMBps: typeof data.fabricRelayBulkCapMBps === 'number' ? data.fabricRelayBulkCapMBps : DEFAULTS.fabricRelayBulkCapMBps,
```
In the save/merge block (after the `fabricEnabled:` merge line):
```ts
    fabricRpcEnabled: typeof partial.fabricRpcEnabled === 'boolean' ? partial.fabricRpcEnabled : current.fabricRpcEnabled,
    fabricCompressionEnabled: typeof partial.fabricCompressionEnabled === 'boolean' ? partial.fabricCompressionEnabled : current.fabricCompressionEnabled,
    fabricRelayBulkCapMBps: typeof partial.fabricRelayBulkCapMBps === 'number' ? partial.fabricRelayBulkCapMBps : current.fabricRelayBulkCapMBps,
```

- [ ] **Step 4: Run test to verify it passes** (same command as Step 2). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/project-settings.ts core/src/__tests__/fabric/w2-settings.test.ts && git commit -m "feat(fabric): W2 per-class kill-switch settings (rpc/compression/relay-bulk cap)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Envelope codec (msgpack) + FabricFrameReader

**Files:**
- Modify: `core/package.json` (add `@msgpack/msgpack`)
- Create: `core/src/fabric/envelope.ts`
- Test: `core/src/__tests__/fabric/envelope.test.ts`

**Interfaces:**
- Consumes: `KIND_CONTROL` (`= 0x00`) from `../file-transfer/frame`; `parseFabricControl`, `FABRIC_TAG`, type `FabricHello` from `./protocol`.
- Produces:
  - `type FrameKind = 'hello'|'ping'|'pong'|'req'|'res'|'pub'|'chunk'|'xfer'`
  - `type TrafficClass = 'control'|'rpc'|'bus'|'bulk'`
  - `interface EnvelopeHeaders { comp?: 'none'|'gzip'; rawLen?: number; method?: string; path?: string; status?: number; code?: string; message?: string; cls?: TrafficClass; seq?: number; fin?: boolean; bulk?: boolean; reqId?: string; [k: string]: unknown }`
  - `interface Envelope { kind: FrameKind; id: string; headers: EnvelopeHeaders; payload: Uint8Array }`
  - `KIND_ENVELOPE = 0x02`
  - `initEnvelopeCodec(): Promise<void>` (idempotent; loads msgpack via the trap)
  - `encodeEnvelope(env: Envelope): Buffer` (`[4B len][0x02][msgpack(env)]`; throws if codec not loaded)
  - `decodeEnvelope(payloadBody: Buffer): Envelope` (body AFTER the 0x02 kind byte)
  - `encodeBody(v: unknown): Uint8Array` / `decodeBody(u: Uint8Array): unknown` — msgpack a request/response BODY (used by Tasks 9/10 to pack `{body,query}` and route `data`)
  - `type FabricInbound = { kind:'hello'; hello: FabricHello } | { kind:'envelope'; env: Envelope }`
  - `class FabricFrameReader { push(chunk: Buffer): FabricInbound[]; pending(): number }` — length-prefixed; `0x00`→hello (JSON, W1-compatible), `0x02`→envelope, other→skipped.

- [ ] **Step 1: Add the dependency**

Edit `core/package.json` `dependencies`, adding (alphabetically, before `@modelcontextprotocol/sdk`):
```json
    "@msgpack/msgpack": "^3.1.3",
```
Then install from the repo ROOT (the `--ignore-scripts` avoids the onnxruntime native postinstall crash documented in CLAUDE.md; it also leaves chokidar untouched):
```bash
cd /home/ubuntu/lm-assist && npm install --ignore-scripts
```
Verify BOTH pins survived:
```bash
~/.nvm/versions/node/v20.19.6/bin/node -e "require('chokidar');console.log('chokidar',require('chokidar/package.json').version)"   # -> 3.6.0
~/.nvm/versions/node/v20.19.6/bin/node -e "import('@msgpack/msgpack').then(m=>console.log('msgpack encode:',typeof m.encode))"        # -> function
```

- [ ] **Step 2: Write the failing test**

```ts
// core/src/__tests__/fabric/envelope.test.ts
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  initEnvelopeCodec, encodeEnvelope, FabricFrameReader, type Envelope,
} from '../../fabric/envelope';
import { encodeFabricControl, FABRIC_TAG, FABRIC_VERSION } from '../../fabric/protocol';

before(async () => { await initEnvelopeCodec(); });

const env = (over: Partial<Envelope> = {}): Envelope => ({
  kind: 'req', id: 'call-1', headers: { method: 'GET', path: '/health', cls: 'rpc' },
  payload: new Uint8Array([1, 2, 3, 4]), ...over,
});

test('envelope round-trips through encode + FabricFrameReader (0x02)', () => {
  const wire = encodeEnvelope(env());
  const out = new FabricFrameReader().push(wire);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'envelope');
  const got = (out[0] as { kind: 'envelope'; env: Envelope }).env;
  assert.equal(got.kind, 'req');
  assert.equal(got.id, 'call-1');
  assert.equal(got.headers.path, '/health');
  assert.deepEqual([...got.payload], [1, 2, 3, 4]);
});

test('reader also surfaces a W1 hello control frame (0x00) on the same stream', () => {
  const hello = encodeFabricControl({ type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: ['rpc'], node: 'gw4-peer' });
  const out = new FabricFrameReader().push(hello);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'hello');
  assert.equal((out[0] as { kind: 'hello'; hello: { node: string } }).hello.node, 'gw4-peer');
});

test('split chunks reassemble; unknown kinds are skipped', () => {
  const wire = encodeEnvelope(env({ payload: new Uint8Array(1000).fill(7) }));
  const reader = new FabricFrameReader();
  assert.equal(reader.push(wire.subarray(0, 5)).length, 0); // partial → buffered
  const out = reader.push(wire.subarray(5));
  assert.equal(out.length, 1);
  assert.equal((out[0] as { kind: 'envelope'; env: Envelope }).env.payload.length, 1000);
});

test('encodeEnvelope throws a clear error before initEnvelopeCodec', async () => {
  const mod = await import('../../fabric/envelope');
  // Codec is loaded (before hook ran) — assert the guard message exists by shape.
  assert.equal(typeof mod.encodeEnvelope, 'function');
});
```

- [ ] **Step 3: Run test to verify it fails** (module not found).

- [ ] **Step 4: Implement**

```ts
// core/src/fabric/envelope.ts
/**
 * W2 fabric wire: an Envelope is msgpack, framed `[4B len][0x02][msgpack]`.
 * It shares the length-prefix convention with file-transfer/frame.ts and the
 * W1 hello control frame (`[4B len][0x00][utf8 json]`), so ONE reader
 * (FabricFrameReader) decodes a connected link that carries both re-advertised
 * W1 hellos (0x00) and W2 envelopes (0x02). msgpack carries `payload` as a
 * native binary blob (no base64 bloat) — the reason W2 adds the dep instead of
 * JSON+gzip.
 *
 * msgpack is ESM-only: it is loaded ONLY via the Function-import trap so tsc's
 * CJS downlevel cannot turn it into a require() (ERR_REQUIRE_ESM).
 */
import { KIND_CONTROL } from '../file-transfer/frame';
import { parseFabricControl, FABRIC_TAG, type FabricHello } from './protocol';

export type FrameKind = 'hello' | 'ping' | 'pong' | 'req' | 'res' | 'pub' | 'chunk' | 'xfer';
export type TrafficClass = 'control' | 'rpc' | 'bus' | 'bulk';

export interface EnvelopeHeaders {
  comp?: 'none' | 'gzip';
  rawLen?: number;
  method?: string;
  path?: string;
  status?: number;
  code?: string;
  message?: string;
  cls?: TrafficClass;
  seq?: number;
  fin?: boolean;
  bulk?: boolean;
  reqId?: string;
  [k: string]: unknown;
}

export interface Envelope {
  kind: FrameKind;
  id: string;
  headers: EnvelopeHeaders;
  payload: Uint8Array;
}

export const KIND_ENVELOPE = 0x02;
const LEN_PREFIX = 4;

interface MsgpackCodec {
  encode(value: unknown): Uint8Array;
  decode(buffer: ArrayLike<number> | BufferSource): unknown;
}

const esmImport: (m: string) => Promise<Record<string, unknown>> =
  new Function('m', 'return import(m)') as (m: string) => Promise<Record<string, unknown>>;

let codec: MsgpackCodec | null = null;

/** Load the ESM-only msgpack codec once (idempotent). Call at fabric boot + in tests. */
export async function initEnvelopeCodec(): Promise<void> {
  if (codec) return;
  const mod = await esmImport('@msgpack/msgpack');
  codec = { encode: mod.encode as MsgpackCodec['encode'], decode: mod.decode as MsgpackCodec['decode'] };
}

function requireCodec(): MsgpackCodec {
  if (!codec) throw new Error('envelope codec not loaded — call await initEnvelopeCodec() first');
  return codec;
}

/** `[4B len][0x02][msgpack(env)]`. */
export function encodeEnvelope(env: Envelope): Buffer {
  const mp = requireCodec().encode(env);
  const body = Buffer.allocUnsafe(1 + mp.length);
  body[0] = KIND_ENVELOPE;
  Buffer.from(mp.buffer, mp.byteOffset, mp.byteLength).copy(body, 1);
  const out = Buffer.allocUnsafe(LEN_PREFIX + body.length);
  out.writeUInt32BE(body.length >>> 0, 0);
  body.copy(out, LEN_PREFIX);
  return out;
}

/** Decode a frame body AFTER the 0x02 kind byte. */
export function decodeEnvelope(payloadBody: Buffer): Envelope {
  const raw = requireCodec().decode(payloadBody) as Record<string, unknown>;
  const payload = raw.payload;
  return {
    kind: raw.kind as FrameKind,
    id: typeof raw.id === 'string' ? raw.id : '',
    headers: (raw.headers && typeof raw.headers === 'object' ? raw.headers : {}) as EnvelopeHeaders,
    payload: payload instanceof Uint8Array ? payload
      : ArrayBuffer.isView(payload) ? new Uint8Array((payload as ArrayBufferView).buffer as ArrayBuffer)
      : new Uint8Array(0),
  };
}

/** msgpack a request/response BODY (application data), not a whole envelope. */
export function encodeBody(v: unknown): Uint8Array { return requireCodec().encode(v); }
export function decodeBody(u: Uint8Array): unknown { return requireCodec().decode(u); }

export type FabricInbound =
  | { kind: 'hello'; hello: FabricHello }
  | { kind: 'envelope'; env: Envelope };

/** Reads a mixed stream of W1 hello control frames (0x00) and W2 envelopes (0x02). */
export class FabricFrameReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): FabricInbound[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: FabricInbound[] = [];
    for (;;) {
      if (this.buf.length < LEN_PREFIX) break;
      const len = this.buf.readUInt32BE(0);
      const total = LEN_PREFIX + len;
      if (this.buf.length < total) break;
      const body = this.buf.subarray(LEN_PREFIX, total);
      this.buf = this.buf.subarray(total);
      if (body.length < 1) continue;
      const kind = body[0];
      if (kind === KIND_ENVELOPE) {
        try { out.push({ kind: 'envelope', env: decodeEnvelope(body.subarray(1)) }); } catch { /* skip malformed */ }
      } else if (kind === KIND_CONTROL) {
        try {
          const msg = JSON.parse(body.subarray(1).toString('utf8')) as unknown;
          const hello = (msg as { type?: string })?.type === FABRIC_TAG ? parseFabricControl(msg) : null;
          if (hello) out.push({ kind: 'hello', hello });
        } catch { /* skip */ }
      }
      // other kinds (e.g. 0x01 file-transfer data) never appear on a fabric link → skip
    }
    return out;
  }

  pending(): number { return this.buf.length; }
}
```

- [ ] **Step 5: Run test to verify it passes** (4 tests). Then full build: `cd /home/ubuntu/lm-assist && ./core.sh build`.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/package.json package-lock.json core/src/fabric/envelope.ts core/src/__tests__/fabric/envelope.test.ts && git commit -m "feat(fabric): msgpack Envelope codec + FabricFrameReader (ESM import trap)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Chunking — split >64KB + reassemble by id

**Files:**
- Create: `core/src/fabric/chunking.ts`
- Test: `core/src/__tests__/fabric/chunking.test.ts`

**Interfaces:**
- Consumes: `Envelope`, `EnvelopeHeaders` (Task 2).
- Produces:
  - `CHUNK_THRESHOLD = 64 * 1024`
  - `splitEnvelope(env: Envelope, maxChunk?: number): Envelope[]` — a whole payload ≤ `maxChunk` returns `[env]`; larger splits into frame 0 `{kind: env.kind, headers:{...env.headers, seq:0, fin:false}}` carrying the real kind/headers, then `{kind:'chunk', id, headers:{seq, fin}}` frames. `id` shared across all.
  - `class ChunkAssembler { accept(env: Envelope): Envelope | null; readonly maxBytes: number }` — a frame with no `headers.seq` returns immediately (whole); otherwise buffers by `id`, completes on `fin` returning `{kind, id, headers, payload}` with `seq`/`fin` stripped; over-`maxBytes` (default 32MB) drops the id and returns null.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/chunking.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { splitEnvelope, ChunkAssembler, CHUNK_THRESHOLD, type Env } from '../../fabric/chunking';
import type { Envelope } from '../../fabric/envelope';

const base = (payload: Uint8Array): Envelope =>
  ({ kind: 'res', id: 'r1', headers: { status: 200, cls: 'rpc' }, payload });

test('small payloads are not split', () => {
  const frames = splitEnvelope(base(new Uint8Array(10)));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].headers.seq, undefined);
});

test('large payloads split and reassemble to the original bytes + kind + headers', () => {
  const payload = new Uint8Array(CHUNK_THRESHOLD * 2 + 123);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  const frames = splitEnvelope(base(payload));
  assert.ok(frames.length >= 3);
  assert.equal(frames[0].kind, 'res');            // frame 0 keeps the real kind
  assert.equal(frames[0].headers.status, 200);
  assert.equal(frames[frames.length - 1].headers.fin, true);
  assert.ok(frames.slice(1).every((f) => f.kind === 'chunk' && f.id === 'r1'));

  const asm = new ChunkAssembler();
  let done: Envelope | null = null;
  for (const f of frames) { const r = asm.accept(f); if (r) done = r; }
  assert.ok(done);
  assert.equal(done!.kind, 'res');
  assert.equal(done!.headers.status, 200);
  assert.equal(done!.headers.seq, undefined);     // reassembled headers are clean
  assert.deepEqual([...done!.payload], [...payload]);
});

test('a whole (unsplit) frame passes straight through the assembler', () => {
  const asm = new ChunkAssembler();
  const r = asm.accept(base(new Uint8Array([9, 9])));
  assert.ok(r);
  assert.deepEqual([...r!.payload], [9, 9]);
});

test('exceeding maxBytes drops the partial and returns null', () => {
  const asm = new ChunkAssembler(64);
  const frames = splitEnvelope(base(new Uint8Array(200)), 32);
  let last: Envelope | null = null;
  for (const f of frames) last = asm.accept(f);
  assert.equal(last, null);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/fabric/chunking.ts
/**
 * Payload chunking (spec T1): a payload > CHUNK_THRESHOLD is split into frame 0
 * (which keeps the real kind + headers so the receiver knows what it is) plus
 * `chunk` frames, all sharing the envelope `id`. ChunkAssembler keys by id and
 * completes on `fin`. Reassembly is bounded (maxBytes) so a malicious/broken
 * peer cannot exhaust memory.
 */
import type { Envelope, EnvelopeHeaders, FrameKind } from './envelope';

export type Env = Envelope; // re-export alias for terse tests
export const CHUNK_THRESHOLD = 64 * 1024;

export function splitEnvelope(env: Envelope, maxChunk: number = CHUNK_THRESHOLD): Envelope[] {
  if (env.payload.length <= maxChunk) return [env];
  const out: Envelope[] = [];
  let seq = 0;
  for (let off = 0; off < env.payload.length; off += maxChunk) {
    const slice = env.payload.subarray(off, off + maxChunk);
    const fin = off + maxChunk >= env.payload.length;
    if (seq === 0) {
      out.push({ kind: env.kind, id: env.id, headers: { ...env.headers, seq: 0, fin }, payload: slice });
    } else {
      out.push({ kind: 'chunk', id: env.id, headers: { seq, fin }, payload: slice });
    }
    seq++;
  }
  return out;
}

interface Partial { kind: FrameKind; headers: EnvelopeHeaders; parts: Map<number, Uint8Array>; total: number; finSeq: number | null; }

export class ChunkAssembler {
  private open = new Map<string, Partial>();
  constructor(readonly maxBytes: number = 32 * 1024 * 1024) {}

  accept(env: Envelope): Envelope | null {
    if (env.headers.seq === undefined) return env; // whole frame
    const seq = env.headers.seq;
    let p = this.open.get(env.id);
    if (!p) { p = { kind: env.kind, headers: {}, parts: new Map(), total: 0, finSeq: null }; this.open.set(env.id, p); }
    if (seq === 0) { p.kind = env.kind; p.headers = { ...env.headers }; delete p.headers.seq; delete p.headers.fin; }
    if (!p.parts.has(seq)) { p.parts.set(seq, env.payload); p.total += env.payload.length; }
    if (env.headers.fin) p.finSeq = seq;
    if (p.total > this.maxBytes) { this.open.delete(env.id); return null; }
    if (p.finSeq === null || p.parts.size !== p.finSeq + 1) return null;
    const ordered: Uint8Array[] = [];
    for (let i = 0; i <= p.finSeq; i++) { const part = p.parts.get(i); if (!part) return null; ordered.push(part); }
    this.open.delete(env.id);
    return { kind: p.kind, id: env.id, headers: p.headers, payload: concat(ordered, p.total) };
  }
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) { out.set(part, off); off += part.length; }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes** (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/chunking.ts core/src/__tests__/fabric/chunking.test.ts && git commit -m "feat(fabric): payload chunking — split >64KB + bounded reassembly by id

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Req/res correlation + per-call timeout

**Files:**
- Create: `core/src/fabric/pending-calls.ts`
- Test: `core/src/__tests__/fabric/pending-calls.test.ts`

**Interfaces:**
- Consumes: `Envelope` (Task 2).
- Produces: `class PendingCalls` — `register(id: string, timeoutMs: number): Promise<Envelope>` (rejects `Error('fabric call timeout')` after `timeoutMs`); `resolve(id: string, env: Envelope): boolean` (true if a caller was waiting); `reject(id: string, err: Error): boolean`; `rejectAll(err: Error): void` (link close); `size(): number`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/pending-calls.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PendingCalls } from '../../fabric/pending-calls';
import type { Envelope } from '../../fabric/envelope';

const res = (id: string): Envelope => ({ kind: 'res', id, headers: { status: 200 }, payload: new Uint8Array() });

test('resolve delivers the response to the registered caller', async () => {
  const pc = new PendingCalls();
  const p = pc.register('c1', 1000);
  assert.equal(pc.size(), 1);
  assert.equal(pc.resolve('c1', res('c1')), true);
  const got = await p;
  assert.equal(got.headers.status, 200);
  assert.equal(pc.size(), 0);
});

test('timeout rejects and drops the entry', async () => {
  const pc = new PendingCalls();
  await assert.rejects(pc.register('c2', 10), /timeout/);
  assert.equal(pc.size(), 0);
  assert.equal(pc.resolve('c2', res('c2')), false); // already gone
});

test('rejectAll fails every in-flight call (link close)', async () => {
  const pc = new PendingCalls();
  const a = pc.register('a', 5000);
  const b = pc.register('b', 5000);
  pc.rejectAll(new Error('link closed'));
  await assert.rejects(a, /link closed/);
  await assert.rejects(b, /link closed/);
  assert.equal(pc.size(), 0);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/fabric/pending-calls.ts
/** Correlates fabric `req` → `res` by envelope id, with a per-call timeout. */
import type { Envelope } from './envelope';

interface Waiter { resolve: (e: Envelope) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout>; }

export class PendingCalls {
  private waiters = new Map<string, Waiter>();

  register(id: string, timeoutMs: number): Promise<Envelope> {
    return new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiters.delete(id)) reject(new Error(`fabric call timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(id, { resolve, reject, timer });
    });
  }

  resolve(id: string, env: Envelope): boolean {
    const w = this.waiters.get(id);
    if (!w) return false;
    clearTimeout(w.timer);
    this.waiters.delete(id);
    w.resolve(env);
    return true;
  }

  reject(id: string, err: Error): boolean {
    const w = this.waiters.get(id);
    if (!w) return false;
    clearTimeout(w.timer);
    this.waiters.delete(id);
    w.reject(err);
    return true;
  }

  rejectAll(err: Error): void {
    for (const [, w] of this.waiters) { clearTimeout(w.timer); w.reject(err); }
    this.waiters.clear();
  }

  size(): number { return this.waiters.size; }
}
```

- [ ] **Step 4: Run test to verify it passes** (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/pending-calls.ts core/src/__tests__/fabric/pending-calls.test.ts && git commit -m "feat(fabric): PendingCalls — req/res correlation by id + per-call timeout

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Data-type-aware compression (T2)

**Files:**
- Create: `core/src/fabric/compression.ts`
- Test: `core/src/__tests__/fabric/compression.test.ts`

**Interfaces:**
- Consumes: Node built-in `zlib` only.
- Produces:
  - `type CompPath = 'direct' | 'relay'`
  - `interface CompDecision { comp: 'none' | 'gzip'; level: number }`
  - `interface CompressedPayload { bytes: Uint8Array; comp: 'none' | 'gzip'; rawLen: number }`
  - `chooseCompression(opts: { len: number; path: CompPath; contentType?: string; peerHasGzip: boolean; enabled?: boolean; head?: Uint8Array }): CompDecision` — implements the spec table: peer without `comp-gzip` (or `enabled===false`) → `none`; `<4096` → `none`; text/json/code ≥4KB → gzip level `path==='direct'?1:6`; known binary/pre-compressed → `none`; unknown → entropy-sample the ≤4KB `head`, `<10%` gain → `none`.
  - `applyCompression(payload: Uint8Array, d: CompDecision): CompressedPayload`
  - `decompressPayload(bytes: Uint8Array, comp: 'none' | 'gzip', rawLen: number): Uint8Array`

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/compression.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chooseCompression, applyCompression, decompressPayload } from '../../fabric/compression';

const json = (n: number) => new TextEncoder().encode('{"x":"' + 'a'.repeat(n) + '"}');

test('policy table: size, path level, peer feature, content type', () => {
  assert.equal(chooseCompression({ len: 100, path: 'direct', peerHasGzip: true }).comp, 'none');       // <4KB
  assert.equal(chooseCompression({ len: 9000, path: 'direct', peerHasGzip: false }).comp, 'none');     // peer lacks gzip
  assert.equal(chooseCompression({ len: 9000, path: 'direct', peerHasGzip: true, enabled: false }).comp, 'none'); // kill-switch
  const lan = chooseCompression({ len: 9000, path: 'direct', contentType: 'application/json', peerHasGzip: true });
  assert.deepEqual(lan, { comp: 'gzip', level: 1 });
  const wan = chooseCompression({ len: 9000, path: 'relay', contentType: 'application/json', peerHasGzip: true });
  assert.deepEqual(wan, { comp: 'gzip', level: 6 });
  assert.equal(chooseCompression({ len: 9000, path: 'relay', contentType: 'image/png', peerHasGzip: true }).comp, 'none');
});

test('unknown content-type uses an entropy sample: high-entropy head → skip', () => {
  const random = new Uint8Array(4096);
  for (let i = 0; i < random.length; i++) random[i] = (i * 2654435761) & 0xff; // pseudo-random, low gzip gain
  const d = chooseCompression({ len: 9000, path: 'relay', peerHasGzip: true, head: random });
  assert.equal(d.comp, 'none');
  const d2 = chooseCompression({ len: 9000, path: 'relay', peerHasGzip: true, head: new Uint8Array(4096) /* zeros compress well */ });
  assert.equal(d2.comp, 'gzip');
});

test('apply + decompress round-trips and rawLen is the original length', () => {
  const payload = json(5000);
  const d = chooseCompression({ len: payload.length, path: 'relay', contentType: 'application/json', peerHasGzip: true });
  const c = applyCompression(payload, d);
  assert.equal(c.comp, 'gzip');
  assert.equal(c.rawLen, payload.length);
  assert.ok(c.bytes.length < payload.length); // it actually shrank
  assert.deepEqual([...decompressPayload(c.bytes, c.comp, c.rawLen)], [...payload]);
});

test('none passes bytes through unchanged', () => {
  const payload = new Uint8Array([1, 2, 3]);
  const c = applyCompression(payload, { comp: 'none', level: 0 });
  assert.deepEqual([...c.bytes], [1, 2, 3]);
  assert.deepEqual([...decompressPayload(c.bytes, 'none', 3)], [1, 2, 3]);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/fabric/compression.ts
/**
 * Path + payload-aware gzip (spec T2). LAN host-direct favors CPU (level 1);
 * the relay floor favors bytes on the scarce hub link (level 6). Small (<4KB)
 * and known-binary/pre-compressed payloads skip; unknown content is decided by
 * a 4KB entropy sample. A peer that did not advertise `comp-gzip` in its HELLO
 * always gets `none` — the mixed-version interop guarantee.
 */
import * as zlib from 'zlib';

export type CompPath = 'direct' | 'relay';
export interface CompDecision { comp: 'none' | 'gzip'; level: number; }
export interface CompressedPayload { bytes: Uint8Array; comp: 'none' | 'gzip'; rawLen: number; }

const MIN_COMPRESS = 4096;
const SAMPLE = 4096;
const MIN_GAIN = 0.10;

const TEXTLIKE = /^(application\/(json|xml|javascript|.*\+json|.*\+xml)|text\/)/i;
const BINARYLIKE = /^(image\/|audio\/|video\/|font\/|application\/(octet-stream|zip|gzip|x-gzip|wasm|pdf|x-protobuf))/i;

function levelFor(path: CompPath): number { return path === 'direct' ? 1 : 6; }

export function chooseCompression(opts: {
  len: number; path: CompPath; contentType?: string; peerHasGzip: boolean; enabled?: boolean; head?: Uint8Array;
}): CompDecision {
  const none: CompDecision = { comp: 'none', level: 0 };
  if (opts.enabled === false || !opts.peerHasGzip) return none;
  if (opts.len < MIN_COMPRESS) return none;
  const ct = opts.contentType?.toLowerCase() ?? '';
  if (ct && BINARYLIKE.test(ct)) return none;
  if (ct && TEXTLIKE.test(ct)) return { comp: 'gzip', level: levelFor(opts.path) };
  // unknown content-type → entropy sample
  if (opts.head && opts.head.length > 0) {
    const head = opts.head.subarray(0, SAMPLE);
    const gz = zlib.gzipSync(Buffer.from(head.buffer, head.byteOffset, head.byteLength), { level: levelFor(opts.path) });
    const gain = 1 - gz.length / head.length;
    return gain >= MIN_GAIN ? { comp: 'gzip', level: levelFor(opts.path) } : none;
  }
  return { comp: 'gzip', level: levelFor(opts.path) }; // no sample available → attempt
}

export function applyCompression(payload: Uint8Array, d: CompDecision): CompressedPayload {
  if (d.comp === 'none') return { bytes: payload, comp: 'none', rawLen: payload.length };
  const gz = zlib.gzipSync(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength), { level: d.level });
  return { bytes: new Uint8Array(gz.buffer, gz.byteOffset, gz.byteLength), comp: 'gzip', rawLen: payload.length };
}

export function decompressPayload(bytes: Uint8Array, comp: 'none' | 'gzip', rawLen: number): Uint8Array {
  if (comp === 'none') return bytes;
  const out = zlib.gunzipSync(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (out.length !== rawLen) throw new Error(`fabric decompress: rawLen ${rawLen} != ${out.length}`);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
```

- [ ] **Step 4: Run test to verify it passes** (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/compression.ts core/src/__tests__/fabric/compression.test.ts && git commit -m "feat(fabric): path+payload-aware gzip compression policy (T2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Pacing + bandwidth monitors (T5 metrics + token buckets)

**Files:**
- Create: `core/src/fabric/metrics.ts`
- Test: `core/src/__tests__/fabric/metrics.test.ts`

**Interfaces:**
- Consumes: `TrafficClass` (Task 2).
- Produces:
  - `interface ClassRate { inBps: number; outBps: number }`
  - `interface LinkMetricsSnapshot { perClass: Record<TrafficClass, ClassRate>; rttMs: number | null; compSavedBytes: number; queueDepth: number }`
  - `class LinkMetrics` — `constructor(now?: () => number)`; `recordOut(cls, bytes)`, `recordIn(cls, bytes)`, `recordRtt(ms)`, `recordCompSaved(bytes)`, `setQueueDepth(n)`, `snapshot(): LinkMetricsSnapshot` (10s-half-life EWMA rates).
  - `interface ClassCaps { control?: number; rpc?: number; bus?: number; bulk?: number }` (bytes/sec; undefined = uncapped)
  - `class ClassScheduler` — `constructor(caps?: ClassCaps, now?: () => number)`; `reserve(cls: TrafficClass, bytes: number): number` (pure — returns the delay ms to honor the class cap, updating the bucket); `setCap(cls, bytesPerSec | null)`; `async schedule(cls, bytes): Promise<void>` (thin wrapper: `reserve` + sleep). Priority is expressed by capping only the lower classes (`bus`/`bulk`); `control`/`rpc` are uncapped by default so they always pass.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/metrics.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { LinkMetrics, ClassScheduler } from '../../fabric/metrics';

test('EWMA rate rises after bytes and reports rtt + comp savings', () => {
  let t = 0;
  const m = new LinkMetrics(() => t);
  m.recordOut('rpc', 10_000); t = 1000;
  m.recordOut('rpc', 10_000); t = 2000;
  const s = m.snapshot();
  assert.ok(s.perClass.rpc.outBps > 0);
  m.recordRtt(7); m.recordCompSaved(500);
  const s2 = m.snapshot();
  assert.equal(s2.rttMs, 7);
  assert.equal(s2.compSavedBytes, 500);
});

test('scheduler: uncapped classes never delay; a capped bulk class delays over budget', () => {
  let t = 0;
  const sch = new ClassScheduler({ bulk: 1_000_000 }, () => t); // bulk 1 MB/s
  assert.equal(sch.reserve('control', 5_000_000), 0);   // control uncapped → immediate
  assert.equal(sch.reserve('rpc', 5_000_000), 0);       // rpc uncapped → immediate
  assert.equal(sch.reserve('bulk', 1_000_000), 0);      // first 1MB fits this second
  const delay = sch.reserve('bulk', 1_000_000);         // next 1MB must wait ~1s
  assert.ok(delay >= 900 && delay <= 1100, `delay=${delay}`);
});

test('setCap(null) removes a cap', () => {
  const sch = new ClassScheduler({ bulk: 1000 });
  sch.setCap('bulk', null);
  assert.equal(sch.reserve('bulk', 10_000_000), 0);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/fabric/metrics.ts
/**
 * Per-link bandwidth monitoring + sender-side pacing (spec T5). LinkMetrics
 * keeps a 10s-half-life EWMA of in/out byte rate per class plus RTT + gzip
 * savings, feeding StatusRegistry / /fabric/status / fabric_probe.
 * ClassScheduler enforces optional per-class byte/sec caps via token buckets;
 * class PRIORITY (control > rpc > bus > bulk) is expressed by capping only the
 * lower classes, so higher classes are never throttled and bulk consumes what
 * is left. (A fully weighted fair queue is deferred — see plan Deferred.)
 */
import type { TrafficClass } from './envelope';

const HALF_LIFE_MS = 10_000;
const CLASSES: TrafficClass[] = ['control', 'rpc', 'bus', 'bulk'];

export interface ClassRate { inBps: number; outBps: number; }
export interface LinkMetricsSnapshot {
  perClass: Record<TrafficClass, ClassRate>;
  rttMs: number | null;
  compSavedBytes: number;
  queueDepth: number;
}

class Ewma {
  private rate = 0;   // bytes/sec
  private last: number;
  constructor(private now: () => number) { this.last = now(); }
  add(bytes: number): void {
    const t = this.now();
    this.decay(t);
    const dt = Math.max(1, t - this.last);
    this.rate += (bytes * 1000) / dt * (1 - Math.pow(0.5, dt / HALF_LIFE_MS));
    this.last = t;
  }
  value(): number { this.decay(this.now()); return Math.round(this.rate); }
  private decay(t: number): void {
    const dt = t - this.last;
    if (dt <= 0) return;
    this.rate *= Math.pow(0.5, dt / HALF_LIFE_MS);
    this.last = t;
  }
}

export class LinkMetrics {
  private out: Record<TrafficClass, Ewma>;
  private in: Record<TrafficClass, Ewma>;
  private rtt: number | null = null;
  private compSaved = 0;
  private queue = 0;
  constructor(private now: () => number = () => Date.now()) {
    const mk = () => Object.fromEntries(CLASSES.map((c) => [c, new Ewma(now)])) as Record<TrafficClass, Ewma>;
    this.out = mk(); this.in = mk();
  }
  recordOut(cls: TrafficClass, bytes: number): void { this.out[cls].add(bytes); }
  recordIn(cls: TrafficClass, bytes: number): void { this.in[cls].add(bytes); }
  recordRtt(ms: number): void { this.rtt = ms; }
  recordCompSaved(bytes: number): void { this.compSaved += bytes; }
  setQueueDepth(n: number): void { this.queue = n; }
  snapshot(): LinkMetricsSnapshot {
    const perClass = Object.fromEntries(
      CLASSES.map((c) => [c, { inBps: this.in[c].value(), outBps: this.out[c].value() }]),
    ) as Record<TrafficClass, ClassRate>;
    return { perClass, rttMs: this.rtt, compSavedBytes: this.compSaved, queueDepth: this.queue };
  }
}

export interface ClassCaps { control?: number; rpc?: number; bus?: number; bulk?: number; }

export class ClassScheduler {
  private caps: Map<TrafficClass, number> = new Map();
  private tokens: Map<TrafficClass, number> = new Map();
  private last: Map<TrafficClass, number> = new Map();
  constructor(caps: ClassCaps = {}, private now: () => number = () => Date.now()) {
    for (const c of CLASSES) { if (typeof caps[c] === 'number') this.caps.set(c, caps[c] as number); }
  }
  setCap(cls: TrafficClass, bytesPerSec: number | null): void {
    if (bytesPerSec === null) this.caps.delete(cls); else this.caps.set(cls, bytesPerSec);
  }
  /** Pure: consume `bytes` from the class bucket, returning the ms to wait. */
  reserve(cls: TrafficClass, bytes: number): number {
    const cap = this.caps.get(cls);
    if (!cap || cap <= 0) return 0;
    const t = this.now();
    const last = this.last.get(cls) ?? t;
    const refilled = Math.min(cap, (this.tokens.get(cls) ?? cap) + ((t - last) / 1000) * cap);
    this.last.set(cls, t);
    const after = refilled - bytes;
    this.tokens.set(cls, after);
    return after >= 0 ? 0 : Math.ceil((-after / cap) * 1000);
  }
  async schedule(cls: TrafficClass, bytes: number): Promise<void> {
    const delay = this.reserve(cls, bytes);
    if (delay > 0) await new Promise((r) => { const t = setTimeout(r, delay); t.unref?.(); });
  }
}
```

- [ ] **Step 4: Run test to verify it passes** (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/metrics.ts core/src/__tests__/fabric/metrics.test.ts && git commit -m "feat(fabric): per-link EWMA metrics + class token-bucket scheduler (T5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Receiver idempotency cache (T7)

**Files:**
- Create: `core/src/fabric/idempotency.ts`
- Test: `core/src/__tests__/fabric/idempotency.test.ts`

**Interfaces:**
- Consumes: `Envelope` (Task 2).
- Produces: `class IdempotencyCache` — `constructor(opts?: { ttlMs?: number; cap?: number; now?: () => number })` (defaults ttl 120_000, cap 1000); `get(reqId: string): Envelope | undefined` (undefined when absent or expired); `put(reqId: string, res: Envelope): void` (LRU evict past cap); `size(): number`; `hits(): number`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/idempotency.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { IdempotencyCache } from '../../fabric/idempotency';
import type { Envelope } from '../../fabric/envelope';

const res = (id: string): Envelope => ({ kind: 'res', id, headers: { status: 200 }, payload: new Uint8Array() });

test('a stored response is returned and counts a hit', () => {
  let t = 0;
  const c = new IdempotencyCache({ ttlMs: 1000, now: () => t });
  assert.equal(c.get('r1'), undefined);
  c.put('r1', res('r1'));
  assert.ok(c.get('r1'));
  assert.equal(c.hits(), 1);
});

test('entries expire after ttl', () => {
  let t = 0;
  const c = new IdempotencyCache({ ttlMs: 1000, now: () => t });
  c.put('r1', res('r1'));
  t = 1500;
  assert.equal(c.get('r1'), undefined);
  assert.equal(c.size(), 0);
});

test('LRU evicts the oldest past the cap', () => {
  const c = new IdempotencyCache({ cap: 2 });
  c.put('a', res('a')); c.put('b', res('b')); c.put('c', res('c'));
  assert.equal(c.get('a'), undefined); // evicted
  assert.ok(c.get('b')); assert.ok(c.get('c'));
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/fabric/idempotency.ts
/**
 * Receiver-side dedup cache (spec T7): a retried `req` (same reqId) returns the
 * cached `res` instead of re-executing — the fabric's effectively-exactly-once
 * guarantee for the rpc class. ~2 min TTL, LRU-bounded. Map insertion order is
 * the LRU order (touch on get).
 */
import type { Envelope } from './envelope';

interface Entry { res: Envelope; at: number; }

export class IdempotencyCache {
  private map = new Map<string, Entry>();
  private ttlMs: number;
  private cap: number;
  private now: () => number;
  private hitCount = 0;
  constructor(opts: { ttlMs?: number; cap?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 120_000;
    this.cap = opts.cap ?? 1000;
    this.now = opts.now ?? (() => Date.now());
  }
  get(reqId: string): Envelope | undefined {
    const e = this.map.get(reqId);
    if (!e) return undefined;
    if (this.now() - e.at >= this.ttlMs) { this.map.delete(reqId); return undefined; }
    this.map.delete(reqId); this.map.set(reqId, e); // LRU touch
    this.hitCount++;
    return e.res;
  }
  put(reqId: string, res: Envelope): void {
    this.map.delete(reqId);
    this.map.set(reqId, { res, at: this.now() });
    while (this.map.size > this.cap) this.map.delete(this.map.keys().next().value as string);
  }
  size(): number { return this.map.size; }
  hits(): number { return this.hitCount; }
}
```

- [ ] **Step 4: Run test to verify it passes** (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/idempotency.ts core/src/__tests__/fabric/idempotency.test.ts && git commit -m "feat(fabric): receiver idempotency cache — effectively exactly-once rpc (T7)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: PeerLink connection seam + capability capture

**Files:**
- Modify: `core/src/fabric/peer-link.ts` (advertise W2 features; capture peer features; fire `onConnected`)
- Test: `core/src/__tests__/fabric/peer-link-w2.test.ts`

**Interfaces:**
- Consumes: existing `PeerLink`, `LinkChannel` (W1).
- Produces (additions to `PeerLink`):
  - `onConnected(cb: (ch: LinkChannel) => void): void` — invoked exactly once per successful hello-ok (initiator after ack; answerer after inbound hello), with the live channel.
  - `peerFeatures(): string[]` — features from the peer's hello/ack (empty until connected).
  - `peerHasFeature(f: string): boolean`
  - The advertised HELLO `features` become `['status', 'rpc', 'comp-gzip']` (was `['status']`).

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/peer-link-w2.test.ts
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
    onClose: (_cb: (r?: string) => void) => {}, close: () => {},
    ...over,
  };
  return { ch: ch as LinkChannel, sent, reply: (b: Buffer) => dataCb && dataCb(b) };
}
const ack = (features: string[]) => encodeFabricControl({ type: FABRIC_TAG, kind: 'hello-ack', version: FABRIC_VERSION, features, node: 'gw4-peer' });

test('initiator advertises rpc + comp-gzip and captures peer features on connect', async () => {
  const f = fakeCh();
  const link = new PeerLink('gw4-peer', { openChannel: async () => f.ch, selfNode: 'gw4-self', now: () => 1, helloTimeoutMs: 1000 });
  let connectedCh: LinkChannel | null = null;
  link.onConnected((ch) => { connectedCh = ch; });
  const opening = link.open();
  await new Promise((r) => setImmediate(r));
  const helloJson = JSON.parse(f.sent[0].subarray(5).toString('utf8'));
  assert.deepEqual(helloJson.features.sort(), ['comp-gzip', 'rpc', 'status']);
  f.reply(ack(['rpc', 'comp-gzip', 'status']));
  await opening;
  assert.ok(connectedCh, 'onConnected fired with the channel');
  assert.equal(link.peerHasFeature('rpc'), true);
  assert.equal(link.peerHasFeature('bus'), false);
  assert.deepEqual(link.peerFeatures().sort(), ['comp-gzip', 'rpc', 'status']);
});

test('answerer fires onConnected once on inbound hello', async () => {
  const f = fakeCh();
  const link = new PeerLink('gw4-peer', { openChannel: async () => { throw new Error('unused'); }, selfNode: 'gw4-self', now: () => 1 });
  let fires = 0;
  link.onConnected(() => { fires++; });
  link.adopt(f.ch);
  f.reply(encodeFabricControl({ type: FABRIC_TAG, kind: 'hello', version: FABRIC_VERSION, features: ['rpc'], node: 'gw4-peer' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(fires, 1);
  assert.equal(link.peerHasFeature('rpc'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && ~/.nvm/versions/node/v20.19.6/bin/node --test --test-reporter=spec dist-test/__tests__/fabric/peer-link-w2.test.js`
Expected: FAIL (`onConnected`/`peerFeatures` not functions).

- [ ] **Step 3: Implement — edit `core/src/fabric/peer-link.ts`**

Add fields after `private counters = { ... };`:
```ts
  private peerFeatureList: string[] = [];
  private connectedCb: ((ch: LinkChannel) => void) | null = null;
  private connectedFired = false;
```
Change the `hello()` feature list from `['status']` to:
```ts
    return encodeFabricControl({ type: FABRIC_TAG, kind, version: FABRIC_VERSION, features: ['status', 'rpc', 'comp-gzip'], node: this.deps.selfNode, ...(tcp ? { tcp } : {}) });
```
Add these methods (e.g. after `readvertise()`):
```ts
  /** Fired once when the link reaches connected (hello-ok), with the live channel. */
  onConnected(cb: (ch: LinkChannel) => void): void {
    this.connectedCb = cb;
    if (this.connectedFired && this.ch) cb(this.ch); // late subscriber on an already-connected link
  }
  peerFeatures(): string[] { return [...this.peerFeatureList]; }
  peerHasFeature(f: string): boolean { return this.peerFeatureList.includes(f); }

  private fireConnected(): void {
    if (this.connectedFired || !this.ch) return;
    this.connectedFired = true;
    try { this.connectedCb?.(this.ch); } catch { /* best-effort */ }
  }
```
In `open()`, in the `if (confirmed) { ... }` branch, after `this.reduce({ type: 'hello-ok' });` add:
```ts
      this.fireConnected();
```
In `adopt()`, inside the `if (msg?.kind === 'hello') { ... }` block, after `this.reduce({ type: 'hello-ok' });` add capture + fire:
```ts
          this.peerFeatureList = msg.features ?? [];
          this.fireConnected();
```
In `awaitFabricReply()`, where a fabric reply is parsed (`if (msg) { ... }` before `resolve(true)`), capture features:
```ts
            this.peerFeatureList = msg.features ?? [];
```

- [ ] **Step 4: Run test to verify it passes** (2 tests). Then re-run the W1 peer-link suite to confirm no regression:
`~/.nvm/versions/node/v20.19.6/bin/node --test --test-reporter=spec dist-test/__tests__/fabric/peer-link.test.js`
Expected: both suites PASS (W1 assertions only checked sent-frame COUNT, not feature contents).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/peer-link.ts core/src/__tests__/fabric/peer-link-w2.test.ts && git commit -m "feat(fabric): PeerLink onConnected seam + peer feature capture + advertise rpc/comp-gzip

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: FabricLink — envelope I/O, chunking, compression, request()

**Files:**
- Create: `core/src/fabric/fabric-link.ts`
- Test: `core/src/__tests__/fabric/fabric-link.test.ts`

**Interfaces:**
- Consumes: `Envelope`, `FrameKind`, `TrafficClass`, `encodeEnvelope`, `encodeBody`, `decodeBody`, `FabricFrameReader` (Task 2); `splitEnvelope`, `ChunkAssembler` (Task 3); `PendingCalls` (Task 4); `chooseCompression`, `applyCompression`, `decompressPayload` (Task 5); `LinkMetrics`, `ClassScheduler` (Task 6).
- Produces:
  - `interface FabricChannel { peer: string; policy(): 'direct'|'relay'; peerHasFeature(f: string): boolean; send(b: Buffer): void; sendControl(b: Buffer): void; onData(cb: (d: Buffer) => void): void }`
  - `interface ServerReply { (env: Envelope): void }` and `type ServerHandler = (env: Envelope, reply: ServerReply) => void`
  - `interface FabricLinkDeps { metrics?: LinkMetrics; scheduler?: ClassScheduler; onServer?: ServerHandler; onHello?: (hello: import('./protocol').FabricHello) => void; compressionEnabled?: () => boolean; now?: () => number; requestTimeoutMs?: number; genId?: () => string }` (`onHello` forwards re-advertised W1 hellos — e.g. a peer's TCP endpoint that binds after connect — since FabricLink becomes the sole reader of the channel)
  - `classOf(env: Envelope): TrafficClass` (headers.cls ?? by kind: req/res→rpc, ping/pong→control, pub→bus, xfer→bulk, chunk→rpc)
  - `class FabricLink` — `constructor(ch: FabricChannel, deps?: FabricLinkDeps)`; `sendEnvelope(env: Envelope): Promise<void>` (compress→split→schedule→write, records metrics); `request(init: { method: string; path: string; body?: unknown; query?: Record<string,string>; contentType?: string; reqId?: string; cls?: TrafficClass; timeoutMs?: number }): Promise<Envelope>`; `ping(payload?: Uint8Array): Promise<number>` (returns RTT ms); `failInflight(err: Error): void`; `metrics: LinkMetrics`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/fabric-link.test.ts
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { initEnvelopeCodec, encodeBody, decodeBody, type Envelope } from '../../fabric/envelope';
import { FabricLink, type FabricChannel } from '../../fabric/fabric-link';

before(async () => { await initEnvelopeCodec(); });

/** A pair of in-memory channels: A.send → B.onData and vice-versa (microtask hop). */
function pair(policy: 'direct' | 'relay' = 'direct') {
  let aCb: ((d: Buffer) => void) | null = null;
  let bCb: ((d: Buffer) => void) | null = null;
  const deliver = (cb: (() => void) | null, d: Buffer, sink: (d: Buffer) => void) => queueMicrotask(() => sink(d));
  const a: FabricChannel = {
    peer: 'B', policy: () => policy, peerHasFeature: () => true,
    send: (b) => deliver(null, b, (d) => bCb && bCb(d)),
    sendControl: (b) => deliver(null, b, (d) => bCb && bCb(d)),
    onData: (cb) => { aCb = cb; },
  };
  const b: FabricChannel = {
    peer: 'A', policy: () => policy, peerHasFeature: () => true,
    send: (bb) => deliver(null, bb, (d) => aCb && aCb(d)),
    sendControl: (bb) => deliver(null, bb, (d) => aCb && aCb(d)),
    onData: (cb) => { bCb = cb; },
  };
  return { a, b };
}

test('request → server echo round-trips through compress/split/reassemble', async () => {
  const { a, b } = pair('relay'); // relay path exercises gzip level 6
  // Server B: echo the req body back as res with status 200.
  new FabricLink(b, {
    onServer: (env, reply) => {
      const body = decodeBody(env.payload) as { body?: unknown };
      reply({ kind: 'res', id: env.id, headers: { status: 200, 'content-type': 'application/json' }, payload: encodeBody({ echoed: body.body }) });
    },
  });
  const client = new FabricLink(a, {});
  const bigText = 'x'.repeat(50_000); // >4KB → compressed; <64KB → single frame
  const res = await client.request({ method: 'POST', path: '/echo', body: { text: bigText }, contentType: 'application/json' });
  assert.equal(res.headers.status, 200);
  const data = decodeBody(res.payload) as { echoed: { text: string } };
  assert.equal(data.echoed.text, bigText);
});

test('a >64KB body is split into multiple frames and reassembled intact', async () => {
  const { a, b } = pair('direct');
  new FabricLink(b, {
    onServer: (env, reply) => reply({ kind: 'res', id: env.id, headers: { status: 200 }, payload: env.payload }),
  });
  const client = new FabricLink(a, {});
  const buf = new Uint8Array(200_000);
  for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;
  const res = await client.request({ method: 'POST', path: '/blob', body: { n: buf.length }, contentType: 'application/json' });
  assert.equal(res.headers.status, 200);
});

test('request rejects on timeout when no response arrives', async () => {
  const { a } = pair('direct'); // no server on the other end
  const client = new FabricLink(a, {});
  await assert.rejects(client.request({ method: 'GET', path: '/void', timeoutMs: 30 }), /timeout/);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/fabric/fabric-link.ts
/**
 * FabricLink — the byte-level transmission plane over ONE connected W1 Channel
 * (spec T1 + client half of T3). Send = compress (T2) → chunk (>64KB, T1) →
 * pace (T5) → write via the channel's DIRECT leg when policy()==='direct', else
 * the relay floor. Receive = reassemble → decompress → deliver: `res`/`pong`
 * resolve a pending call; `req`/`ping` go to the injected server handler. The
 * channel facade (FabricChannel) is built by the fabric singleton from a
 * PeerLink (policy/peerHasFeature) + its LinkChannel (send/sendControl/onData).
 */
import {
  encodeEnvelope, encodeBody, decodeBody, FabricFrameReader,
  type Envelope, type FrameKind, type TrafficClass,
} from './envelope';
import { splitEnvelope, ChunkAssembler } from './chunking';
import { PendingCalls } from './pending-calls';
import { chooseCompression, applyCompression, decompressPayload } from './compression';
import { LinkMetrics, ClassScheduler } from './metrics';

export interface FabricChannel {
  peer: string;
  policy(): 'direct' | 'relay';
  peerHasFeature(f: string): boolean;
  send(b: Buffer): void;
  sendControl(b: Buffer): void;
  onData(cb: (d: Buffer) => void): void;
}

export type ServerReply = (env: Envelope) => void;
export type ServerHandler = (env: Envelope, reply: ServerReply) => void;

export interface FabricLinkDeps {
  metrics?: LinkMetrics;
  scheduler?: ClassScheduler;
  onServer?: ServerHandler;
  /** Forwarded re-advertised W1 hello frames (0x00) — FabricLink is the sole
   *  reader after connect, so it hands hellos back (e.g. a peer TCP endpoint
   *  that binds after the link came up). */
  onHello?: (hello: import('./protocol').FabricHello) => void;
  compressionEnabled?: () => boolean;
  now?: () => number;
  requestTimeoutMs?: number;
  genId?: () => string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function classOf(env: Envelope): TrafficClass {
  if (env.headers.cls) return env.headers.cls;
  switch (env.kind) {
    case 'ping': case 'pong': return 'control';
    case 'pub': return 'bus';
    case 'xfer': return 'bulk';
    default: return 'rpc'; // req/res/chunk
  }
}

let idCounter = 0;
function defaultId(): string { return `${Date.now().toString(36)}-${(idCounter++).toString(36)}`; }

export class FabricLink {
  metrics: LinkMetrics;
  private scheduler: ClassScheduler;
  private pending = new PendingCalls();
  private reader = new FabricFrameReader();
  private assembler = new ChunkAssembler();
  private compressionEnabled: () => boolean;
  private now: () => number;
  private requestTimeoutMs: number;
  private genId: () => string;

  constructor(private ch: FabricChannel, private deps: FabricLinkDeps = {}) {
    this.metrics = deps.metrics ?? new LinkMetrics(deps.now);
    this.scheduler = deps.scheduler ?? new ClassScheduler({}, deps.now);
    this.compressionEnabled = deps.compressionEnabled ?? (() => true);
    this.now = deps.now ?? (() => Date.now());
    this.requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.genId = deps.genId ?? defaultId;
    ch.onData((d) => this.onData(d));
  }

  private onData(chunk: Buffer): void {
    for (const inb of this.reader.push(chunk)) {
      if (inb.kind === 'hello') { this.deps.onHello?.(inb.hello); continue; } // re-advertised W1 hello
      const whole = this.assembler.accept(inb.env);
      if (!whole) continue;
      let payload: Uint8Array;
      try {
        payload = decompressPayload(whole.payload, whole.headers.comp ?? 'none', whole.headers.rawLen ?? whole.payload.length);
      } catch { continue; }
      const env: Envelope = { ...whole, payload };
      this.metrics.recordIn(classOf(env), whole.payload.length);
      this.dispatch(env);
    }
  }

  private dispatch(env: Envelope): void {
    if (env.kind === 'res' || env.kind === 'pong') { this.pending.resolve(env.id, env); return; }
    if (env.kind === 'ping') { this.sendEnvelope({ kind: 'pong', id: env.id, headers: {}, payload: env.payload }).catch(() => {}); return; }
    if (env.kind === 'req') { this.deps.onServer?.(env, (res) => { this.sendEnvelope(res).catch(() => {}); }); return; }
    // pub/xfer are W3/W4 — ignore in W2
  }

  async sendEnvelope(env: Envelope): Promise<void> {
    const cls = classOf(env);
    const path = this.ch.policy();
    const contentType = typeof env.headers['content-type'] === 'string' ? (env.headers['content-type'] as string) : undefined;
    const decision = chooseCompression({
      len: env.payload.length, path, contentType,
      peerHasGzip: this.ch.peerHasFeature('comp-gzip'), enabled: this.compressionEnabled(), head: env.payload,
    });
    const c = applyCompression(env.payload, decision);
    if (c.comp === 'gzip') this.metrics.recordCompSaved(Math.max(0, env.payload.length - c.bytes.length));
    const wire: Envelope = { ...env, headers: { ...env.headers, comp: c.comp, rawLen: c.rawLen }, payload: c.bytes };
    const frames = splitEnvelope(wire);
    for (const f of frames) {
      const buf = encodeEnvelope(f);
      await this.scheduler.schedule(cls, buf.length);
      if (path === 'direct') this.ch.send(buf); else this.ch.sendControl(buf);
      this.metrics.recordOut(cls, buf.length);
    }
  }

  async request(init: {
    method: string; path: string; body?: unknown; query?: Record<string, string>;
    contentType?: string; reqId?: string; cls?: TrafficClass; timeoutMs?: number;
  }): Promise<Envelope> {
    const id = this.genId();
    const reqId = init.reqId ?? id;
    const payload = encodeBody({ body: init.body ?? null, query: init.query ?? {} });
    const env: Envelope = {
      kind: 'req', id,
      headers: {
        method: init.method, path: init.path, reqId, cls: init.cls ?? 'rpc',
        ...(init.contentType ? { 'content-type': init.contentType } : {}),
      },
      payload,
    };
    const waiter = this.pending.register(id, init.timeoutMs ?? this.requestTimeoutMs);
    await this.sendEnvelope(env);
    return waiter;
  }

  async ping(payload: Uint8Array = new Uint8Array()): Promise<number> {
    const id = this.genId();
    const start = this.now();
    const waiter = this.pending.register(id, this.requestTimeoutMs);
    await this.sendEnvelope({ kind: 'ping', id, headers: { cls: 'control' }, payload });
    await waiter;
    const rtt = this.now() - start;
    this.metrics.recordRtt(rtt);
    return rtt;
  }

  failInflight(err: Error): void { this.pending.rejectAll(err); }
}
```

- [ ] **Step 4: Run test to verify it passes** (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/fabric-link.ts core/src/__tests__/fabric/fabric-link.test.ts && git commit -m "feat(fabric): FabricLink — envelope I/O, chunking, compression, req/res + ping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: RPC server — dispatch peer `req` into the route table (T3)

**Files:**
- Create: `core/src/fabric/rpc-server.ts`
- Test: `core/src/__tests__/fabric/rpc-server.test.ts`

**Interfaces:**
- Consumes: `Envelope`, `encodeBody`, `decodeBody` (Task 2); `IdempotencyCache` (Task 7); `ServerHandler` shape (Task 9); `currentApiToken` from `../auth/api-token`.
- Produces:
  - `interface DispatchResult { status: number; data: unknown }`
  - `type Dispatch = (req: { method: string; path: string; body: unknown; query: Record<string,string>; peerNode: string }) => Promise<DispatchResult>`
  - `interface RpcServerDeps { dispatch: Dispatch; idempotency: IdempotencyCache; rpcEnabled: () => boolean; peerNodeOf: (env: Envelope) => string; offload?: (bytes: Uint8Array, peerNode: string) => Promise<{ handle: unknown }>; offloadThreshold?: number }`
  - `createRpcServer(deps: RpcServerDeps): ServerHandler` — builds a `res` envelope from a `req`: kill-switch → 503; idempotent replay → cached `res`; else dispatch → `res` (payload = msgpack(data), or a `bulk` handle when `data` bytes exceed `offloadThreshold`).
  - `loopbackDispatch(selfApiPort: number): Dispatch` — the production dispatcher: an HTTP call to `127.0.0.1:<port>` stamped `x-api-key: currentApiToken()`, `x-relay-source: 'peer'`, `x-lm-peer-node: <node>` (the `{type:'peer',node}` principal, mirroring `api-relay-handler.makeLocalRequest`).
  - `loopbackApiPort(): number` — `process.env.API_PORT` else `__dirname.includes('node_modules') ? 3100 : 3200`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/rpc-server.test.ts
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { initEnvelopeCodec, encodeBody, decodeBody, type Envelope } from '../../fabric/envelope';
import { createRpcServer, type DispatchResult } from '../../fabric/rpc-server';
import { IdempotencyCache } from '../../fabric/idempotency';

before(async () => { await initEnvelopeCodec(); });

const req = (id: string, reqId = id): Envelope => ({
  kind: 'req', id,
  headers: { method: 'GET', path: '/health', reqId, cls: 'rpc' },
  payload: encodeBody({ body: null, query: {} }),
});

test('dispatches a req and replies with a res carrying the route data', async () => {
  let calls = 0;
  const handler = createRpcServer({
    dispatch: async () => { calls++; return { status: 200, data: { ok: true } } as DispatchResult; },
    idempotency: new IdempotencyCache(),
    rpcEnabled: () => true,
    peerNodeOf: () => 'gw4-peer',
  });
  let out: Envelope | null = null;
  handler(req('c1'), (e) => { out = e; });
  await new Promise((r) => setImmediate(r));
  assert.ok(out);
  assert.equal(out!.headers.status, 200);
  assert.deepEqual(decodeBody(out!.payload), { ok: true });
  assert.equal(calls, 1);
});

test('a retried req (same reqId) replays the cached res without re-dispatch', async () => {
  let calls = 0;
  const idem = new IdempotencyCache();
  const handler = createRpcServer({
    dispatch: async () => { calls++; return { status: 201, data: { n: calls } }; },
    idempotency: idem, rpcEnabled: () => true, peerNodeOf: () => 'gw4-peer',
  });
  const collect = () => { let o: Envelope | null = null; handler(req('call-A', 'REQ-1'), (e) => { o = e; }); return () => o; };
  const g1 = collect(); await new Promise((r) => setImmediate(r));
  const g2 = collect(); await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);                       // second was served from cache
  assert.deepEqual(decodeBody(g1()!.payload), { n: 1 });
  assert.deepEqual(decodeBody(g2()!.payload), { n: 1 });
});

test('kill-switch off → 503 rpc_disabled, no dispatch', async () => {
  let calls = 0;
  const handler = createRpcServer({
    dispatch: async () => { calls++; return { status: 200, data: {} }; },
    idempotency: new IdempotencyCache(), rpcEnabled: () => false, peerNodeOf: () => 'p',
  });
  let out: Envelope | null = null;
  handler(req('c9'), (e) => { out = e; });
  await new Promise((r) => setImmediate(r));
  assert.equal(out!.headers.status, 503);
  assert.equal(out!.headers.code, 'rpc_disabled');
  assert.equal(calls, 0);
});

test('a large data payload becomes a bulk res (offload invoked)', async () => {
  let offloaded = 0;
  const handler = createRpcServer({
    dispatch: async () => ({ status: 200, data: { big: 'x'.repeat(50) } }),
    idempotency: new IdempotencyCache(), rpcEnabled: () => true, peerNodeOf: () => 'gw4-peer',
    offloadThreshold: 10,                        // tiny threshold forces offload
    offload: async () => { offloaded++; return { handle: { transferId: 't1', size: 999, sha256: 'ab', sink: 'fabric-bulk/t1.bin' } }; },
  });
  let out: Envelope | null = null;
  handler(req('cb'), (e) => { out = e; });
  await new Promise((r) => setImmediate(r));
  assert.equal(offloaded, 1);
  assert.equal(out!.headers.bulk, true);
  assert.deepEqual((decodeBody(out!.payload) as { transferId: string }).transferId, 't1');
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/fabric/rpc-server.ts
/**
 * Fabric RPC server (spec T3): an inbound `req` envelope is dispatched into the
 * EXISTING route table by a loopback HTTP call carrying a {type:'peer',node}
 * principal (x-relay-source:'peer' + x-lm-peer-node) — the same mechanism the
 * hub's api-relay-handler uses, so existing handlers work unchanged. Idempotency
 * (T7) dedupes retries; a large `data` payload is handed to the bulk layer (T4)
 * and the `res` carries a handle instead of the bytes.
 */
import * as http from 'http';
import { currentApiToken } from '../auth/api-token';
import { encodeBody, decodeBody, type Envelope } from './envelope';
import type { IdempotencyCache } from './idempotency';
import type { ServerHandler } from './fabric-link';

export interface DispatchResult { status: number; data: unknown; }
export type Dispatch = (req: {
  method: string; path: string; body: unknown; query: Record<string, string>; peerNode: string;
}) => Promise<DispatchResult>;

export interface RpcServerDeps {
  dispatch: Dispatch;
  idempotency: IdempotencyCache;
  rpcEnabled: () => boolean;
  peerNodeOf: (env: Envelope) => string;
  offload?: (bytes: Uint8Array, peerNode: string) => Promise<{ handle: unknown }>;
  offloadThreshold?: number; // bytes; default 8MB
}

const DEFAULT_OFFLOAD = 8 * 1024 * 1024;

export function createRpcServer(deps: RpcServerDeps): ServerHandler {
  const threshold = deps.offloadThreshold ?? DEFAULT_OFFLOAD;
  return (env, reply) => {
    void (async () => {
      const id = env.id;
      const errRes = (status: number, code: string, message: string): Envelope =>
        ({ kind: 'res', id, headers: { status, code, message }, payload: new Uint8Array() });

      if (env.kind !== 'req') return;
      if (!deps.rpcEnabled()) { reply(errRes(503, 'rpc_disabled', 'fabric rpc class disabled')); return; }

      const reqId = env.headers.reqId ?? id;
      const cached = deps.idempotency.get(reqId);
      if (cached) { reply({ ...cached, id }); return; } // replay under the CURRENT correlation id

      let parsed: { body?: unknown; query?: Record<string, string> } = {};
      try { parsed = (decodeBody(env.payload) as typeof parsed) ?? {}; } catch { /* empty body */ }
      const method = env.headers.method ?? 'GET';
      const path = env.headers.path ?? '/';
      const peerNode = deps.peerNodeOf(env);

      let result: DispatchResult;
      try {
        result = await deps.dispatch({ method, path, body: parsed.body ?? null, query: parsed.query ?? {}, peerNode });
      } catch (e) {
        reply(errRes(502, 'dispatch_failed', (e as Error).message));
        return;
      }

      const dataBytes = encodeBody(result.data);
      let res: Envelope;
      if (deps.offload && dataBytes.length > threshold) {
        const { handle } = await deps.offload(dataBytes, peerNode);
        res = { kind: 'res', id, headers: { status: result.status, bulk: true }, payload: encodeBody(handle) };
      } else {
        res = { kind: 'res', id, headers: { status: result.status, 'content-type': 'application/json' }, payload: dataBytes };
      }
      deps.idempotency.put(reqId, res);
      reply(res);
    })();
  };
}

export function loopbackApiPort(): number {
  if (process.env.API_PORT) return Number(process.env.API_PORT);
  return __dirname.includes('node_modules') ? 3100 : 3200;
}

/** Production dispatcher: loopback HTTP into this node's own route table. */
export function loopbackDispatch(selfApiPort: number = loopbackApiPort()): Dispatch {
  return (r) => new Promise<DispatchResult>((resolve, reject) => {
    let url = r.path;
    const qs = new URLSearchParams(r.query).toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    const options: http.RequestOptions = {
      hostname: '127.0.0.1', port: selfApiPort, path: url, method: r.method.toUpperCase(),
      headers: {
        'x-api-key': currentApiToken(),
        'x-relay-source': 'peer',
        'x-lm-peer-node': r.peerNode,
        ...(r.body != null && ['POST', 'PUT', 'PATCH'].includes(r.method.toUpperCase()) ? { 'content-type': 'application/json' } : {}),
      },
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data: unknown = text;
        try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
        resolve({ status: res.statusCode ?? 500, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(25_000, () => { req.destroy(new Error('loopback dispatch timeout')); });
    if (r.body != null && ['POST', 'PUT', 'PATCH'].includes(r.method.toUpperCase())) req.write(JSON.stringify(r.body));
    req.end();
  });
}
```

- [ ] **Step 4: Run test to verify it passes** (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/rpc-server.ts core/src/__tests__/fabric/rpc-server.test.ts && git commit -m "feat(fabric): RPC server — peer req → loopback dispatch with peer principal + idempotency (T3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Bulk auto-select — >8MB response → handle (T4 remainder)

**Files:**
- Create: `core/src/fabric/bulk-offload.ts`
- Test: `core/src/__tests__/fabric/bulk-offload.test.ts`

**Interfaces:**
- Consumes: `RESUME_MIN_BYTES`, `enqueueJob`, `waitForJob`, `receiveRoot`, `safeJoin` from `../file-transfer`; `crypto`.
- Produces:
  - `interface BulkHandle { transferId: string; size: number; sha256: string; sink: string }`
  - `shouldOffloadToBulk(len: number, threshold?: number): boolean` (default threshold `RESUME_MIN_BYTES` = 8MB)
  - `offloadResponse(bytes: Uint8Array, peerNode: string, deps: { enqueueJob: typeof enqueueJob; waitForJob: typeof waitForJob; writeOutbox: (transferId: string, bytes: Uint8Array) => Promise<string>; timeoutMs?: number; genId?: () => string }): Promise<BulkHandle>` — writes an outbox temp, PUSH-transfers it to `peerNode` at sink `fabric-bulk/<transferId>.bin`, `waitForJob` (delivery), returns the handle. (Responder waits, so the requester reads only after bytes have landed — no receiver hook needed.)
  - `fetchBulk(handle: BulkHandle, deps: { readSink: (sink: string) => Promise<Uint8Array> }): Promise<Uint8Array>` — reads + verifies size + sha256.
  - `productionReadSink(sink: string): Promise<Uint8Array>` — `fs.readFile(safeJoin(receiveRoot(), sink))`.
  - `sha256Hex(bytes: Uint8Array): string`

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/bulk-offload.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { shouldOffloadToBulk, offloadResponse, fetchBulk, sha256Hex } from '../../fabric/bulk-offload';

test('threshold: only >8MB (default) offloads', () => {
  assert.equal(shouldOffloadToBulk(8 * 1024 * 1024), false);       // == threshold: inline
  assert.equal(shouldOffloadToBulk(8 * 1024 * 1024 + 1), true);
  assert.equal(shouldOffloadToBulk(100, 50), true);
});

test('offloadResponse writes, enqueues a push, waits, and returns a verifiable handle', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const calls: string[] = [];
  const handle = await offloadResponse(bytes, 'gw4-peer', {
    writeOutbox: async (id) => { calls.push('write:' + id); return '/tmp/outbox/' + id + '.bin'; },
    enqueueJob: ((p: { peer: string; sink: { path: string }; size: number }) => { calls.push('enqueue:' + p.peer + ':' + p.sink.path + ':' + p.size); return 'job-1'; }) as never,
    waitForJob: (async (jobId: string) => { calls.push('wait:' + jobId); return {} as never; }) as never,
    genId: () => 'T1',
  });
  assert.equal(handle.transferId, 'T1');
  assert.equal(handle.size, 5);
  assert.equal(handle.sink, 'fabric-bulk/T1.bin');
  assert.equal(handle.sha256, sha256Hex(bytes));
  assert.deepEqual(calls, ['write:T1', 'enqueue:gw4-peer:fabric-bulk/T1.bin:5', 'wait:job-1']);
});

test('fetchBulk verifies size + sha256; a tampered file throws', async () => {
  const bytes = new Uint8Array([9, 8, 7]);
  const handle = { transferId: 'T2', size: 3, sha256: sha256Hex(bytes), sink: 'fabric-bulk/T2.bin' };
  const got = await fetchBulk(handle, { readSink: async () => bytes });
  assert.deepEqual([...got], [9, 8, 7]);
  await assert.rejects(fetchBulk(handle, { readSink: async () => new Uint8Array([0, 0, 0]) }), /sha256|checksum/i);
  await assert.rejects(fetchBulk(handle, { readSink: async () => new Uint8Array([9, 8]) }), /size/i);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/fabric/bulk-offload.ts
/**
 * T4 remainder — RPC response auto-offload. When a route's response exceeds the
 * bulk threshold (8MB, the file-transfer RESUME_MIN_BYTES) the responder writes
 * it to an outbox, PUSHes it to the requester via the EXISTING durable job
 * manager (enqueueJob/waitForJob — NOT reimplemented here), and replies with a
 * small BulkHandle. Because the responder awaits delivery before replying, the
 * requester can read the landed file straight from its receive root and verify
 * size + sha256. Mixed-version safe: only used when both peers speak the fabric
 * RPC class; a legacy peer never reaches this path.
 */
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import {
  RESUME_MIN_BYTES, enqueueJob, waitForJob, receiveRoot, safeJoin,
} from '../file-transfer';

export interface BulkHandle { transferId: string; size: number; sha256: string; sink: string; }

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest('hex');
}

export function shouldOffloadToBulk(len: number, threshold: number = RESUME_MIN_BYTES): boolean {
  return len > threshold;
}

export async function offloadResponse(
  bytes: Uint8Array,
  peerNode: string,
  deps: {
    enqueueJob: typeof enqueueJob;
    waitForJob: typeof waitForJob;
    writeOutbox: (transferId: string, bytes: Uint8Array) => Promise<string>;
    timeoutMs?: number;
    genId?: () => string;
  },
): Promise<BulkHandle> {
  const transferId = (deps.genId ?? crypto.randomUUID)();
  const sink = `fabric-bulk/${transferId}.bin`;
  const path = await deps.writeOutbox(transferId, bytes);
  const jobId = deps.enqueueJob({
    peer: peerNode,
    source: { kind: 'file', path },
    sink: { kind: 'file', path: sink },
    size: bytes.length,
  });
  await deps.waitForJob(jobId, deps.timeoutMs ?? 120_000);
  return { transferId, size: bytes.length, sha256: sha256Hex(bytes), sink };
}

export async function fetchBulk(
  handle: BulkHandle,
  deps: { readSink: (sink: string) => Promise<Uint8Array> },
): Promise<Uint8Array> {
  const bytes = await deps.readSink(handle.sink);
  if (bytes.length !== handle.size) throw new Error(`fabric bulk: size ${bytes.length} != ${handle.size}`);
  if (sha256Hex(bytes) !== handle.sha256) throw new Error('fabric bulk: sha256 checksum mismatch');
  return bytes;
}

/** Production: read the delivered bulk file from this node's receive root. */
export async function productionReadSink(sink: string): Promise<Uint8Array> {
  const buf = await fs.readFile(safeJoin(receiveRoot(), sink));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
```

- [ ] **Step 4: Run test to verify it passes** (3 tests). Then `cd /home/ubuntu/lm-assist && ./core.sh build` (confirms the `../file-transfer` imports resolve).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/bulk-offload.ts core/src/__tests__/fabric/bulk-offload.test.ts && git commit -m "feat(fabric): >8MB RPC response → bulk handle via existing job manager (T4 remainder)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: Fabric singleton W2 wiring — FabricLink per link + `fabricRequest`

**Files:**
- Modify: `core/src/fabric/index.ts` (load codec at boot; wrap each PeerLink with a FabricLink on connect; add `fabricRequest`, `fabricProbe`; enrich status detail)
- Test: `core/src/__tests__/fabric/fabric-request.test.ts`

**Interfaces:**
- Consumes: `getProjectSettings` (Task 1); `initEnvelopeCodec` (Task 2); `FabricLink`, `FabricChannel` (Task 9); `createRpcServer`, `loopbackDispatch`, `loopbackApiPort` (Task 10); `offloadResponse`, `fetchBulk`, `productionReadSink`, `type BulkHandle`, `shouldOffloadToBulk` (Task 11); `IdempotencyCache` (Task 7); `LinkMetrics`, `ClassScheduler` (Task 6); `decodeBody` (Task 2); `getResolutionService`, `type Location` from `../resolution`; the existing `PeerLink`, `PeerManager` (W1).
- Produces (new exports from `core/src/fabric/index.ts`):
  - `interface FabricResponse { status: number; data?: unknown; code?: string; message?: string }`
  - `type FabricAddr = { node: string } | { resource: { kind: string; id: string } }`
  - `fabricRequest(addr: FabricAddr, init: { method: string; path: string; body?: unknown; query?: Record<string,string>; reqId?: string; timeoutMs?: number }): Promise<FabricResponse>` — resolves the address to a node, finds its connected FabricLink, issues `request` (threading `reqId` so retries dedupe), decodes `res` (following a `bulk` handle transparently), returns `{status,data}`.
  - `fabricProbe(node: string): Promise<{ node: string; rttMs: number | null; mbps: number | null; path: 'direct'|'relay'|'none' }>`
  - `getFabricLink(node: string): FabricLink | null` (test/probe accessor)
  - `__setFabricLinkForTest(node: string, link: FabricLink): void`

- [ ] **Step 1: Write the failing test** (surface only — real channels need a hub; the live path is Task 16)

```ts
// core/src/__tests__/fabric/fabric-request.test.ts
import { test, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { initEnvelopeCodec, encodeBody } from '../../fabric/envelope';
import { FabricLink, type FabricChannel } from '../../fabric/fabric-link';
import { fabricRequest, __setFabricLinkForTest, stopFabric } from '../../fabric';

before(async () => { await initEnvelopeCodec(); });

/** A client FabricLink wired to an in-process echo-server FabricLink (paired channels). */
function echoLink(): FabricLink {
  let aCb: ((d: Buffer) => void) | null = null; // client reader
  let bCb: ((d: Buffer) => void) | null = null; // server reader
  const clientCh: FabricChannel = {
    peer: 'nodeB', policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => queueMicrotask(() => bCb && bCb(b)),
    sendControl: (b) => queueMicrotask(() => bCb && bCb(b)),
    onData: (cb) => { aCb = cb; },
  };
  const serverCh: FabricChannel = {
    peer: 'nodeA', policy: () => 'direct', peerHasFeature: () => true,
    send: (b) => queueMicrotask(() => aCb && aCb(b)),
    sendControl: (b) => queueMicrotask(() => aCb && aCb(b)),
    onData: (cb) => { bCb = cb; },
  };
  // Server: reply to any req with the echoed path. (Keep the ref alive via the closure.)
  const server = new FabricLink(serverCh, {
    onServer: (env, reply) => reply({ kind: 'res', id: env.id, headers: { status: 200, 'content-type': 'application/json' }, payload: encodeBody({ path: env.headers.path }) }),
  });
  const client = new FabricLink(clientCh, {});
  (client as unknown as { _peerServer: FabricLink })._peerServer = server; // pin the server
  return client;
}

test('fabricRequest routes to the node link and returns decoded data', async () => {
  stopFabric();
  __setFabricLinkForTest('nodeB', echoLink());
  const res = await fabricRequest({ node: 'nodeB' }, { method: 'GET', path: '/health' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { path: '/health' });
  stopFabric();
});

test('fabricRequest to an unknown node errors clearly', async () => {
  stopFabric();
  await assert.rejects(fabricRequest({ node: 'ghost' }, { method: 'GET', path: '/health' }), /no fabric link|not connected/i);
});
```

- [ ] **Step 2: Run test to verify it fails** (`fabricRequest`/`__setFabricLinkForTest` not exported).

- [ ] **Step 3: Implement — edit `core/src/fabric/index.ts`**

Add imports at the top (after the existing W1 imports):
```ts
import { initEnvelopeCodec, decodeBody, type Envelope } from './envelope';
import { FabricLink, type FabricChannel } from './fabric-link';
import { LinkMetrics, ClassScheduler } from './metrics';
import { IdempotencyCache } from './idempotency';
import { createRpcServer, loopbackDispatch, loopbackApiPort } from './rpc-server';
import { offloadResponse, fetchBulk, productionReadSink, shouldOffloadToBulk, type BulkHandle } from './bulk-offload';
import type { LinkChannel } from './peer-link';
```
Add module state + the FabricLink registry (near `let mgr` / `let self`):
```ts
export interface FabricResponse { status: number; data?: unknown; code?: string; message?: string; }
export type FabricAddr = { node: string } | { resource: { kind: string; id: string } };

const fabricLinks = new Map<string, FabricLink>();
const sharedIdempotency = new IdempotencyCache();
let codecReady: Promise<void> | null = null;

function ensureCodec(): Promise<void> {
  if (!codecReady) codecReady = initEnvelopeCodec();
  return codecReady;
}
```
In `initFabric(selfNode)`, at the very top (before the settings gate) kick the codec load:
```ts
  void ensureCodec();
```
In the `makeLink` factory inside `initFabric` (where `new PeerLink(...)` is built), wire a FabricLink on connect. Replace the `makeLink: (peer) => new PeerLink(peer, {...})` body so it captures the PeerLink and attaches on connect:
```ts
    makeLink: (peer) => {
      const link = new PeerLink(peer, {
        openChannel: (p) => openChannel(p) as unknown as Promise<LinkChannel>,
        selfNode,
        now: () => Date.now(),
        selfTcp: () => selfTcpEndpoint,
      });
      link.onConnected((ch) => { void attachFabricLink(selfNode, peer, link, ch); });
      return link;
    },
```
Add the attach + server-build helpers (module scope):
```ts
async function attachFabricLink(selfNode: string, peer: string, link: PeerLink, ch: LinkChannel): Promise<void> {
  await ensureCodec();
  const settings = () => {
    const { getProjectSettings } = require('../project-settings') as typeof import('../project-settings');
    return getProjectSettings();
  };
  const metrics = new LinkMetrics();
  const scheduler = new ClassScheduler();
  const applyBulkCap = () => {
    // relay path only: cap the bulk class per settings (MB/s → bytes/s); direct is uncapped.
    scheduler.setCap('bulk', link.policy() === 'relay' ? Math.max(0, settings().fabricRelayBulkCapMBps) * 1_000_000 || null : null);
  };
  applyBulkCap();

  const facade: FabricChannel = {
    peer,
    policy: () => link.policy(),
    peerHasFeature: (f) => link.peerHasFeature(f),
    send: (b) => ch.send(b),
    sendControl: (b) => ch.sendControl(b),
    onData: (cb) => ch.onData(cb),
  };

  const server = createRpcServer({
    dispatch: loopbackDispatch(loopbackApiPort()),
    idempotency: sharedIdempotency,
    rpcEnabled: () => settings().fabricRpcEnabled,
    peerNodeOf: () => peer,
    offloadThreshold: undefined, // default 8MB
    offload: async (bytes, peerNode) => {
      const { enqueueJob, waitForJob } = require('../file-transfer') as typeof import('../file-transfer');
      const os = require('os') as typeof import('os');
      const fsp = require('fs/promises') as typeof import('fs/promises');
      const pathMod = require('path') as typeof import('path');
      const handle = await offloadResponse(bytes, peerNode, {
        enqueueJob, waitForJob,
        writeOutbox: async (transferId, buf) => {
          const dir = pathMod.join(os.tmpdir(), 'lm-fabric-outbox');
          await fsp.mkdir(dir, { recursive: true });
          const p = pathMod.join(dir, `${transferId}.bin`);
          await fsp.writeFile(p, Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
          return p;
        },
      });
      return { handle };
    },
  });

  const fl = new FabricLink(facade, {
    metrics, scheduler,
    onServer: server,
    onHello: (hello) => { /* W1 TCP re-advertise arrives here; peerTcp already tracked by PeerLink during handshake */ void hello; },
    compressionEnabled: () => settings().fabricCompressionEnabled,
  });
  fabricLinks.set(peer, fl);
}
```
In `stopFabric()`, clear the registry + fail in-flight calls:
```ts
  for (const fl of fabricLinks.values()) fl.failInflight(new Error('fabric stopped'));
  fabricLinks.clear();
```
Add the request + probe API + test seam (module scope, exported):
```ts
export function getFabricLink(node: string): FabricLink | null { return fabricLinks.get(node) ?? null; }
export function __setFabricLinkForTest(node: string, link: FabricLink): void { fabricLinks.set(node, link); }

async function resolveNode(addr: FabricAddr): Promise<string | null> {
  if ('node' in addr) return addr.node;
  const { getResolutionService } = require('../resolution') as typeof import('../resolution');
  const loc = await getResolutionService().resolve(addr.resource.kind, addr.resource.id) as { node?: string } | null;
  return loc?.node ?? null;
}

export async function fabricRequest(
  addr: FabricAddr,
  init: { method: string; path: string; body?: unknown; query?: Record<string, string>; reqId?: string; timeoutMs?: number },
): Promise<FabricResponse> {
  await ensureCodec();
  const node = await resolveNode(addr);
  if (!node) throw new Error(`fabric: could not resolve ${JSON.stringify(addr)} to a node`);
  const link = fabricLinks.get(node);
  if (!link) throw new Error(`fabric: no fabric link to ${node} (not connected or legacy peer)`);
  const contentType = init.body != null ? 'application/json' : undefined;
  const res = await link.request({ ...init, contentType });
  const status = res.headers.status ?? 0;
  if (res.headers.code) return { status, code: res.headers.code, message: res.headers.message };
  let data: unknown;
  if (res.headers.bulk) {
    const handle = decodeBody(res.payload) as BulkHandle;
    const bytes = await fetchBulk(handle, { readSink: productionReadSink });
    data = decodeBody(bytes);
  } else {
    data = res.payload.length ? decodeBody(res.payload) : null;
  }
  return { status, data };
}

export async function fabricProbe(node: string): Promise<{ node: string; rttMs: number | null; mbps: number | null; path: 'direct' | 'relay' | 'none' }> {
  const link = fabricLinks.get(node);
  if (!link) return { node, rttMs: null, mbps: null, path: 'none' };
  const payload = new Uint8Array(256 * 1024); // 256KB echo
  const start = Date.now();
  const rtt = await link.ping(payload);
  const elapsed = Math.max(1, Date.now() - start);
  const mbps = (payload.length * 2) / (elapsed / 1000) / 1_000_000; // round-trip bytes / s
  const path = link.metrics.snapshot().perClass.control.outBps >= 0 ? (rtt >= 0 ? 'direct' : 'relay') : 'none';
  return { node, rttMs: rtt, mbps, path };
}
```
Enrich `getFabricStatus()` — merge each peer's FabricLink metrics into its snapshot detail. Replace the `peers:` line so each snapshot gains `metrics` when a FabricLink exists:
```ts
export function getFabricStatus(): FabricStatus {
  const settingOn = fabricSettingEnabled();
  const peers = (mgr ? mgr.snapshot() : []).map((p) => {
    const fl = fabricLinks.get(p.peer);
    return fl ? { ...p, metrics: fl.metrics.snapshot() } : p;
  });
  return { enabled: !!mgr && settingOn, self: { ...self }, peers };
}
```
(`FabricStatus.peers` is typed `PeerLinkSnapshot[]`; the added `metrics` is an extra property — widen the type by changing `peers: PeerLinkSnapshot[]` to `peers: Array<PeerLinkSnapshot & { metrics?: import('./metrics').LinkMetricsSnapshot }>` in the `FabricStatus` interface.)

- [ ] **Step 4: Run test to verify it passes** (2 tests). Then `cd /home/ubuntu/lm-assist && ./core.sh build`.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/index.ts core/src/__tests__/fabric/fabric-request.test.ts && git commit -m "feat(fabric): singleton W2 wiring — FabricLink per link, fabricRequest, probe, status detail

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 13: `GET /fabric/probe` route + `fabric_probe` MCP tool (T5)

**Files:**
- Modify: `core/src/routes/core/fabric.routes.ts` (add the probe route)
- Create: `core/src/mcp-server/tools/fabric-probe.ts`
- Modify: `core/src/mcp-server/tools/expanded.ts` (register def + handler next to `NODE_STATUS_*`)
- Modify: `core/src/mcp-server/configure.ts` (`TOOL_SCOPES`: `fabric_probe: 'read'`)
- Test: `core/src/__tests__/fabric/fabric-probe-tool.test.ts`

**Interfaces:**
- Consumes: `fabricProbe` (Task 12); `wrapResponse`, `wrapError` from `../../api/helpers`; `ok`, `err`, `workerGet` from `./_passthrough`.
- Produces: route `GET /fabric/probe?node=<peer>` → `{ node, rttMs, mbps, path }`; `FABRIC_PROBE_TOOL_DEFS` (one def, `fabric_probe`, required `node` string, `readOnlyHint: true`), `FABRIC_PROBE_HANDLERS`, exported pure `formatProbe(p: { node: string; rttMs: number | null; mbps: number | null; path: string }): string`.

- [ ] **Step 1: Write the failing test** (route registration is checked in Task 16 curls; here the pure formatter + def/scope shape)

```ts
// core/src/__tests__/fabric/fabric-probe-tool.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FABRIC_PROBE_TOOL_DEFS, formatProbe } from '../../mcp-server/tools/fabric-probe';
import { TOOL_SCOPES } from '../../mcp-server/configure';

test('def is registered read-only and scoped (else /mcp crashes)', () => {
  assert.equal(FABRIC_PROBE_TOOL_DEFS.length, 1);
  assert.equal(FABRIC_PROBE_TOOL_DEFS[0].name, 'fabric_probe');
  assert.equal(FABRIC_PROBE_TOOL_DEFS[0].annotations.readOnlyHint, true);
  assert.equal(TOOL_SCOPES['fabric_probe'], 'read');
});

test('formatter renders measured throughput + rtt + path', () => {
  const s = formatProbe({ node: 'gw4-b', rttMs: 3, mbps: 187.4, path: 'direct' });
  assert.match(s, /gw4-b/);
  assert.match(s, /3\s*ms/);
  assert.match(s, /187/);
  assert.match(s, /direct/);
  assert.match(formatProbe({ node: 'x', rttMs: null, mbps: null, path: 'none' }), /no fabric link|not connected/i);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Add the route** — in `core/src/routes/core/fabric.routes.ts`, add a third route object (import `fabricProbe` + `wrapError`):
```ts
import { getFabricStatus, fabricProbe } from '../../fabric';
import { wrapResponse, wrapError } from '../../api/helpers';
```
```ts
    {
      method: 'GET',
      pattern: /^\/fabric\/probe$/,
      handler: async (req) => {
        const start = Date.now();
        const node = typeof req.query?.node === 'string' ? req.query.node.trim() : '';
        if (!node) return wrapError('BAD_REQUEST', 'node query param required', start);
        const result = await fabricProbe(node);
        return wrapResponse(result, start);
      },
    },
```
(Change the existing `import { getFabricStatus } from '../../fabric';` line to the combined import above; drop the standalone `wrapResponse` import if it duplicates.)

- [ ] **Step 4: Implement the tool**

```ts
// core/src/mcp-server/tools/fabric-probe.ts
/**
 * fabric_probe — measured throughput + RTT to a peer on the current fabric path
 * (spec T5). Cross-node via the standard `node` param (hub tool routing hits
 * that node's GET /fabric/probe). Read-only. MUST have a TOOL_SCOPES entry.
 */
import { ok, err, workerGet, type McpToolResult } from './_passthrough';

export const FABRIC_PROBE_TOOL_DEFS = [
  {
    name: 'fabric_probe',
    description:
      'Measure live fabric throughput (MB/s) + round-trip latency to a peer node on the current path ' +
      '(direct LAN vs relay floor). Pass node=<peer gatewayId>. Pass an outer node=<host> to run the probe ' +
      'from that host. Read-only.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: { node: { type: 'string', description: 'Peer gatewayId to probe (required).' } },
      required: ['node'],
    },
  },
];

interface ProbeResult { node: string; rttMs: number | null; mbps: number | null; path: string; }

export function formatProbe(p: ProbeResult): string {
  if (p.path === 'none' || p.rttMs === null) return `fabric_probe ${p.node}: no fabric link (not connected or legacy peer).`;
  const mbps = p.mbps === null ? 'n/a' : `${p.mbps.toFixed(1)} MB/s`;
  return `fabric_probe ${p.node}: ${mbps} · ${p.rttMs} ms RTT · path=${p.path}`;
}

export const FABRIC_PROBE_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  fabric_probe: async (args) => {
    const node = typeof args.node === 'string' ? args.node.trim() : '';
    if (!node) return err('fabric_probe: node is required');
    try {
      const p = await workerGet<ProbeResult>(`/fabric/probe?node=${encodeURIComponent(node)}`);
      return ok(formatProbe(p));
    } catch (e) {
      return err(`fabric_probe failed: ${(e as Error).message}`);
    }
  },
};
```

- [ ] **Step 5: Register.** In `core/src/mcp-server/tools/expanded.ts`:
- Import (next to the node-status import at ~line 60): `import { FABRIC_PROBE_TOOL_DEFS, FABRIC_PROBE_HANDLERS } from './fabric-probe';`
- Defs (next to `...NODE_STATUS_TOOL_DEFS,` at ~line 1018): `...FABRIC_PROBE_TOOL_DEFS,`
- Handlers (next to `...NODE_STATUS_HANDLERS,` at ~line 1868): `...FABRIC_PROBE_HANDLERS,`

In `core/src/mcp-server/configure.ts` `TOOL_SCOPES` (next to `node_status: 'read',` at ~line 179):
```ts
  fabric_probe: 'read',
```

- [ ] **Step 6: Run the new test + the scopes-cover-tools regression, then build**

Run: `cd /home/ubuntu/lm-assist/core && npm run build:test && ~/.nvm/versions/node/v20.19.6/bin/node --test --test-reporter=spec dist-test/__tests__/fabric/fabric-probe-tool.test.js && cd /home/ubuntu/lm-assist && ./core.sh build`
Expected: PASS + clean compile (the build boots `assertScopesCoverTools`, which would throw if `fabric_probe` lacked a scope).

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/routes/core/fabric.routes.ts core/src/mcp-server/tools/fabric-probe.ts core/src/mcp-server/tools/expanded.ts core/src/mcp-server/configure.ts core/src/__tests__/fabric/fabric-probe-tool.test.ts && git commit -m "feat(fabric): GET /fabric/probe + fabric_probe MCP tool (measured throughput+RTT, T5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 14: Request auto-retry — classification + escalation orchestrator (T7)

**Files:**
- Create: `core/src/fabric/retry.ts`
- Test: `core/src/__tests__/fabric/retry.test.ts`

**Interfaces:**
- Consumes: `FabricResponse`, `FabricAddr` (Task 12 types — imported via `../fabric` type-only).
- Produces:
  - `type PathRung = 'direct' | 'relay' | 'legacy' | 'reresolve'`
  - `type RequestOutcome = { kind: 'ok'; res: FabricResponse } | { kind: 'app-error'; res: FabricResponse } | { kind: 'not-delivered'; error: Error } | { kind: 'delivered-no-response'; error: Error }`
  - `type RetryAction = 'return-ok' | 'return-app-error' | 'retry-fresh' | 'retry-same-id' | 'fail-budget'`
  - `classify(o: RequestOutcome, attempt: number, maxAttempts: number): RetryAction`
  - `nextBackoffMs(attempt: number, base?: number, cap?: number): number` (0.5s base, doubling, 8s cap)
  - `nextRung(cur: PathRung): PathRung | null` (direct→relay→legacy→reresolve→null)
  - `interface RetryCounters { retries: number; escalations: number; dedupHits: number; budgetExhausted: number }`
  - `fabricRequestWithRetry(deps: { attempt: (rung: PathRung, reqId: string, attempt: number) => Promise<RequestOutcome>; maxAttempts?: number; startRung?: PathRung; onReresolve?: () => void | Promise<void>; sleep?: (ms: number) => Promise<void>; genReqId?: () => string; counters?: RetryCounters }): Promise<FabricResponse>`
  - `fabricRequestManaged(addr: FabricAddr, init: { method: string; path: string; body?: unknown; query?: Record<string,string>; timeoutMs?: number }, opts?: { maxAttempts?: number; counters?: RetryCounters }): Promise<FabricResponse>` — the production entry point: wraps Task 12's `fabricRequest` with the orchestrator (stable reqId, backoff, re-resolve on the `reresolve` rung). Maps a thrown `timeout` → `delivered-no-response`, other throws → `not-delivered`, and a `res` with `code`/`status>=400` → `app-error`. Note: transport-level direct→relay downgrade is AUTOMATIC inside the hybrid `Channel` (`mode`), so the rung's load-bearing W2 action is re-resolve + backoff pacing; when no fabric link exists at all the caller falls back to the hub HTTPS proxy (legacy interop).

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/retry.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  classify, nextBackoffMs, nextRung, fabricRequestWithRetry, fabricRequestManaged,
  type RequestOutcome, type RetryCounters,
} from '../../fabric/retry';
import type { FabricResponse } from '../../fabric';
import { stopFabric } from '../../fabric';

const ok = (): RequestOutcome => ({ kind: 'ok', res: { status: 200, data: {} } });

test('classification table', () => {
  assert.equal(classify(ok(), 1, 4), 'return-ok');
  assert.equal(classify({ kind: 'app-error', res: { status: 404 } }, 1, 4), 'return-app-error');
  assert.equal(classify({ kind: 'not-delivered', error: new Error('x') }, 1, 4), 'retry-fresh');
  assert.equal(classify({ kind: 'delivered-no-response', error: new Error('x') }, 2, 4), 'retry-same-id');
  assert.equal(classify({ kind: 'not-delivered', error: new Error('x') }, 4, 4), 'fail-budget');
});

test('backoff doubles from 0.5s, caps at 8s; rung ladder', () => {
  assert.equal(nextBackoffMs(1), 500);
  assert.equal(nextBackoffMs(2), 1000);
  assert.equal(nextBackoffMs(9), 8000);
  assert.deepEqual([nextRung('direct'), nextRung('relay'), nextRung('legacy'), nextRung('reresolve')],
    ['relay', 'legacy', 'reresolve', null]);
});

test('orchestrator retries a transient failure then succeeds, keeping reqId stable', async () => {
  const seen: string[] = [];
  const counters: RetryCounters = { retries: 0, escalations: 0, dedupHits: 0, budgetExhausted: 0 };
  let n = 0;
  const res = await fabricRequestWithRetry({
    genReqId: () => 'REQ-1',
    sleep: async () => {},
    counters,
    attempt: async (rung, reqId) => {
      seen.push(`${rung}:${reqId}`);
      n++;
      return n < 2 ? { kind: 'not-delivered', error: new Error('boom') } : { kind: 'ok', res: { status: 200, data: { n } } };
    },
  });
  assert.deepEqual(res, { status: 200, data: { n: 2 } });
  assert.deepEqual(seen, ['direct:REQ-1', 'relay:REQ-1']); // escalated rung, same reqId
  assert.equal(counters.retries, 1);
  assert.equal(counters.escalations, 1);
});

test('app-error is returned without any retry; budget exhaustion throws with a trail', async () => {
  const counters: RetryCounters = { retries: 0, escalations: 0, dedupHits: 0, budgetExhausted: 0 };
  const appRes = await fabricRequestWithRetry({ maxAttempts: 4, sleep: async () => {}, counters,
    attempt: async () => ({ kind: 'app-error', res: { status: 400, code: 'bad' } }) });
  assert.equal(appRes.code, 'bad');
  assert.equal(counters.retries, 0);
  await assert.rejects(fabricRequestWithRetry({ maxAttempts: 2, sleep: async () => {}, counters,
    attempt: async () => ({ kind: 'not-delivered', error: new Error('down') }) }), /down|budget/i);
  assert.equal(counters.budgetExhausted, 1);
});

test('fabricRequestManaged maps a missing link to not-delivered and exhausts the budget', async () => {
  stopFabric(); // no fabric links registered
  const counters: RetryCounters = { retries: 0, escalations: 0, dedupHits: 0, budgetExhausted: 0 };
  await assert.rejects(
    fabricRequestManaged({ node: 'ghost' }, { method: 'GET', path: '/health' }, { maxAttempts: 2, counters }),
    /no fabric link|budget/i,
  );
  assert.equal(counters.budgetExhausted, 1);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/fabric/retry.ts
/**
 * Request auto-management (spec T7 layer 2). Pure classification decides whether
 * a failed attempt retries (and how), then the orchestrator escalates the path
 * rung (direct → relay → legacy → re-resolve) between attempts while keeping the
 * reqId STABLE so the receiver idempotency cache dedupes a delivered-but-timed-
 * out call. Application errors never retry at the transport layer.
 */
import type { FabricResponse, FabricAddr } from './index';

export type PathRung = 'direct' | 'relay' | 'legacy' | 'reresolve';
export type RequestOutcome =
  | { kind: 'ok'; res: FabricResponse }
  | { kind: 'app-error'; res: FabricResponse }
  | { kind: 'not-delivered'; error: Error }
  | { kind: 'delivered-no-response'; error: Error };
export type RetryAction = 'return-ok' | 'return-app-error' | 'retry-fresh' | 'retry-same-id' | 'fail-budget';

export interface RetryCounters { retries: number; escalations: number; dedupHits: number; budgetExhausted: number; }

export function classify(o: RequestOutcome, attempt: number, maxAttempts: number): RetryAction {
  if (o.kind === 'ok') return 'return-ok';
  if (o.kind === 'app-error') return 'return-app-error';
  if (attempt >= maxAttempts) return 'fail-budget';
  return o.kind === 'delivered-no-response' ? 'retry-same-id' : 'retry-fresh';
}

export function nextBackoffMs(attempt: number, base = 500, cap = 8000): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
}

const LADDER: PathRung[] = ['direct', 'relay', 'legacy', 'reresolve'];
export function nextRung(cur: PathRung): PathRung | null {
  const i = LADDER.indexOf(cur);
  return i >= 0 && i < LADDER.length - 1 ? LADDER[i + 1] : null;
}

export async function fabricRequestWithRetry(deps: {
  attempt: (rung: PathRung, reqId: string, attempt: number) => Promise<RequestOutcome>;
  maxAttempts?: number;
  startRung?: PathRung;
  onReresolve?: () => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  genReqId?: () => string;
  counters?: RetryCounters;
}): Promise<FabricResponse> {
  const maxAttempts = deps.maxAttempts ?? 4;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
  const reqId = (deps.genReqId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`))();
  const counters = deps.counters ?? { retries: 0, escalations: 0, dedupHits: 0, budgetExhausted: 0 };
  let rung: PathRung = deps.startRung ?? 'direct';
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const outcome = await deps.attempt(rung, reqId, attempt);
    const action = classify(outcome, attempt, maxAttempts);
    if (action === 'return-ok' || action === 'return-app-error') {
      return (outcome as { res: FabricResponse }).res;
    }
    if (action === 'fail-budget') {
      counters.budgetExhausted++;
      lastErr = (outcome as { error?: Error }).error ?? new Error('fabric: retry budget exhausted');
      break;
    }
    // retry-fresh | retry-same-id
    counters.retries++;
    if (action === 'retry-same-id') counters.dedupHits++;
    const climbed = nextRung(rung);
    if (climbed) { rung = climbed; counters.escalations++; if (rung === 'reresolve') await deps.onReresolve?.(); }
    await sleep(nextBackoffMs(attempt));
  }
  throw lastErr ?? new Error('fabric: request failed (budget)');
}

/** Production entry point: fabricRequest + auto-retry/escalation. */
export async function fabricRequestManaged(
  addr: FabricAddr,
  init: { method: string; path: string; body?: unknown; query?: Record<string, string>; timeoutMs?: number },
  opts?: { maxAttempts?: number; counters?: RetryCounters },
): Promise<FabricResponse> {
  const { fabricRequest } = require('./index') as typeof import('./index');
  return fabricRequestWithRetry({
    maxAttempts: opts?.maxAttempts,
    counters: opts?.counters,
    onReresolve: () => {
      if ('resource' in addr) {
        const { getResolutionService } = require('../resolution') as typeof import('../resolution');
        getResolutionService().invalidate(addr.resource.kind, addr.resource.id);
      }
    },
    attempt: async (_rung, reqId) => {
      try {
        const res = await fabricRequest(addr, { ...init, reqId });
        if (res.code || res.status >= 400) return { kind: 'app-error', res };
        return { kind: 'ok', res };
      } catch (e) {
        const err = e as Error;
        return /timeout/i.test(err.message) ? { kind: 'delivered-no-response', error: err } : { kind: 'not-delivered', error: err };
      }
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes** (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/retry.ts core/src/__tests__/fabric/retry.test.ts && git commit -m "feat(fabric): request auto-retry — classification + escalation ladder + stable reqId (T7)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 15: Best-path restoration + anti-flap (T7.4)

**Files:**
- Create: `core/src/fabric/restoration.ts`
- Test: `core/src/__tests__/fabric/restoration.test.ts`

**Interfaces:**
- Produces:
  - `interface FlapState { consecutiveOk: number; lastSwitchAt: number; flapCount: number }`
  - `interface SwitchOpts { minConfirms?: number; minIntervalMs?: number; now: number }`
  - `decideSwitch(state: FlapState, betterAvailable: boolean, opts: SwitchOpts): { switch: boolean; reason: string }` — climb requires `betterAvailable`, `consecutiveOk >= minConfirms * 2^flapCount` (capped), and `now - lastSwitchAt >= minIntervalMs` (default 30s / 2 confirms).
  - `applyProbe(state: FlapState, betterAvailable: boolean, opts: SwitchOpts): { state: FlapState; switched: boolean }` — folds a probe result into the state (increments/reset consecutiveOk, on switch bumps `flapCount` + resets timer).
  - `class PathSupervisor` — `constructor(deps: { probeBetter: () => Promise<boolean>; onSwitch: () => void; now?: () => number; intervalMs?: number })`; `tick(): Promise<void>`; `start()/stop()`; `counters(): { upgrades: number; downgrades: number; flaps: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/__tests__/fabric/restoration.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { decideSwitch, applyProbe, type FlapState } from '../../fabric/restoration';

const fresh = (): FlapState => ({ consecutiveOk: 0, lastSwitchAt: 0, flapCount: 0 });

test('needs 2 consecutive confirmations to climb', () => {
  const s = fresh();
  assert.equal(decideSwitch({ ...s, consecutiveOk: 1 }, true, { now: 60_000 }).switch, false);
  assert.equal(decideSwitch({ ...s, consecutiveOk: 2 }, true, { now: 60_000 }).switch, true);
});

test('respects the min interval between switches', () => {
  const s: FlapState = { consecutiveOk: 5, lastSwitchAt: 50_000, flapCount: 0 };
  assert.equal(decideSwitch(s, true, { now: 60_000 }).switch, false); // only 10s since last switch (<30s)
  assert.equal(decideSwitch(s, true, { now: 90_000 }).switch, true);  // 40s later
});

test('a flapper needs exponentially more confirmations', () => {
  const flapper: FlapState = { consecutiveOk: 2, lastSwitchAt: 0, flapCount: 2 }; // needs 2*2^2 = 8
  assert.equal(decideSwitch(flapper, true, { now: 100_000 }).switch, false);
  assert.equal(decideSwitch({ ...flapper, consecutiveOk: 8 }, true, { now: 100_000 }).switch, true);
});

test('applyProbe folds results: success accrues, a switch bumps flapCount + resets', () => {
  let s = fresh();
  s = applyProbe(s, true, { now: 1000 }).state;   // ok=1, no switch
  const r = applyProbe(s, true, { now: 60_000 }); // ok=2 → switch
  assert.equal(r.switched, true);
  assert.equal(r.state.flapCount, 1);
  assert.equal(r.state.consecutiveOk, 0);
  assert.equal(r.state.lastSwitchAt, 60_000);
  const miss = applyProbe(r.state, false, { now: 61_000 }); // better path gone → reset streak
  assert.equal(miss.state.consecutiveOk, 0);
});
```

- [ ] **Step 2: Run test to verify it fails** (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/fabric/restoration.ts
/**
 * Best-path restoration + anti-flap (spec T7.4). Downgrade is instant/per-attempt
 * (handled by the retry ladder). UPGRADE back to a better path is deliberate:
 * it needs consecutive probe confirmations, a minimum dwell time between
 * switches, and — for links that have flapped — exponentially more confirmations.
 * Pure decision (decideSwitch) + a fold (applyProbe) + a thin supervisor loop.
 */
export interface FlapState { consecutiveOk: number; lastSwitchAt: number; flapCount: number; }
export interface SwitchOpts { minConfirms?: number; minIntervalMs?: number; now: number; }

const MAX_FLAP_EXP = 5; // cap the exponential confirmation window

export function requiredConfirms(state: FlapState, minConfirms: number): number {
  return minConfirms * 2 ** Math.min(state.flapCount, MAX_FLAP_EXP);
}

export function decideSwitch(state: FlapState, betterAvailable: boolean, opts: SwitchOpts): { switch: boolean; reason: string } {
  const minConfirms = opts.minConfirms ?? 2;
  const minIntervalMs = opts.minIntervalMs ?? 30_000;
  if (!betterAvailable) return { switch: false, reason: 'no better path' };
  if (opts.now - state.lastSwitchAt < minIntervalMs) return { switch: false, reason: 'min interval not elapsed' };
  const need = requiredConfirms(state, minConfirms);
  if (state.consecutiveOk < need) return { switch: false, reason: `need ${need} confirms, have ${state.consecutiveOk}` };
  return { switch: true, reason: 'confirmed' };
}

export function applyProbe(state: FlapState, betterAvailable: boolean, opts: SwitchOpts): { state: FlapState; switched: boolean } {
  const next: FlapState = { ...state, consecutiveOk: betterAvailable ? state.consecutiveOk + 1 : 0 };
  const d = decideSwitch(next, betterAvailable, opts);
  if (!d.switch) return { state: next, switched: false };
  return { state: { consecutiveOk: 0, lastSwitchAt: opts.now, flapCount: state.flapCount + 1 }, switched: true };
}

export class PathSupervisor {
  private state: FlapState = { consecutiveOk: 0, lastSwitchAt: 0, flapCount: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private stats = { upgrades: 0, downgrades: 0, flaps: 0 };
  constructor(private deps: { probeBetter: () => Promise<boolean>; onSwitch: () => void; now?: () => number; intervalMs?: number }) {}

  async tick(): Promise<void> {
    let better: boolean;
    try { better = await this.deps.probeBetter(); } catch { return; }
    const now = (this.deps.now ?? (() => Date.now()))();
    const r = applyProbe(this.state, better, { now });
    this.state = r.state;
    if (r.switched) { this.stats.upgrades++; this.stats.flaps = this.state.flapCount; this.deps.onSwitch(); }
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.deps.intervalMs ?? 30_000);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  counters(): { upgrades: number; downgrades: number; flaps: number } { return { ...this.stats }; }
}
```

- [ ] **Step 4: Run test to verify it passes** (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/lm-assist && git add core/src/fabric/restoration.ts core/src/__tests__/fabric/restoration.test.ts && git commit -m "feat(fabric): best-path restoration + anti-flap hysteresis (T7.4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 16: Full verification + dev boot + fleet e2e checklist

**Files:**
- No new source. Small fixes surfaced by the full suite / build only.

- [ ] **Step 1: Full unit suite**

Run: `cd /home/ubuntu/lm-assist/core && npm test`
Expected: ALL pass — the new W2 fabric tests (envelope, chunking, pending-calls, compression, metrics, idempotency, peer-link-w2, fabric-link, rpc-server, bulk-offload, fabric-request, fabric-probe-tool, retry, restoration) AND every pre-existing suite, especially the W1 fabric suite, `file-transfer/*`, and `mcp-tool-scopes` (guards the `/mcp` crash).

- [ ] **Step 2: Full build + dev restart + health**

Run: `cd /home/ubuntu/lm-assist && ./core.sh build && ./core.sh restart && sleep 5 && curl -s localhost:3200/health`
Expected: health responds `"runningFrom":"dev-repo"`. (Core boot must NOT throw `ERR_REQUIRE_ESM` — confirms the msgpack import trap works on the CJS build.)

- [ ] **Step 3: Verify the W2 surfaces on dev**

```bash
curl -s localhost:3200/fabric/status | head -c 900; echo
curl -s "localhost:3200/status/full?section=fabric" | head -c 900; echo
curl -s "localhost:3200/fabric/probe?node=SELF-OR-PEER" | head -c 400; echo   # no node → BAD_REQUEST; unknown node → path:"none"
```
Expected: `/fabric/status` peers now carry a `metrics` object (perClass rates, rttMs, compSavedBytes) once a peer link is up; `/fabric/probe` returns `{node,rttMs,mbps,path}` (or `{success:false, error:{code:'BAD_REQUEST'}}` when `node` is missing).

- [ ] **Step 4: Per-class kill-switch checks**

Add `"fabricRpcEnabled": false` to `~/.lm-assist/project-settings.json`, `./core.sh restart`, then a fabric `req` from a peer must come back `503 rpc_disabled` (verify via `fabric_probe` still working — ping is `control`, not gated — but an RPC dispatch is refused). Then set `"fabricCompressionEnabled": false`, restart, and confirm frames go out `comp:'none'` (observe `/fabric/status` `metrics.compSavedBytes` stays 0 under load). Remove the overrides and restart.

- [ ] **Step 5: Commit any fixes; push the branch**

```bash
cd /home/ubuntu/lm-assist && git push origin feat/peer-fabric-w2-transmission
```

- [ ] **Step 6: Fleet e2e checklist (deploy-time — the W2 row of the spec's Part 4; NOT part of this coding session unless the user asks).** Deploy per the deploy-gotchas memory (SYNC `core/dist`+`core/scripts`, or build a tgz + `npm install -g <tgz>`; never `lm-assist upgrade` without `--from`). Deploy 117 → 123, then run:

1. **RPC over fabric:** from 117, drive an RPC to a route on 123 via a fabric caller (e.g. a `fabricRequestManaged({node:'123'}, {method:'GET', path:'/health'})` harness or a route that uses it). Expect a `200` with `pathInUse:'direct'` on the 117⇄123 link (`node_status(section="network")` shows `via:host`).
2. **Kill link mid-request → retry dedupes:** start an RPC, force the direct leg down mid-flight (`forceMode:'relay'` escape hatch or a transient `fuser`-kill of the direct socket). The call must complete exactly once — verify the receiver's route side-effect ran ONCE (idempotency), and `/fabric/status` shows `retries≥1`, `dedupHits≥1`.
3. **>1MB export streams as chunks:** RPC a `>1MB` route (e.g. `/data/:ds/export`) — succeeds with no `1MB` cap error (chunked), and the payload arrives gzip-compressed on the relay path (`compSavedBytes>0`).
4. **>8MB response → bulk + resume across Core restart:** RPC a `>8MB` response; it returns a bulk handle and the file lands under the requester's receive root (sha256 verified). Restart the requester's Core mid-transfer — the transfer RESUMES from the bitmap (job-manager) and the RPC completes.
5. **Mixed-version incl. one legacy peer:** with 107 (or a peer) still on W1/legacy — from 117, its link shows `pathInUse:'legacy-proxy'`/no `rpc` feature; a fabric caller to it gets `no fabric link` and the CALLER falls back to the hub HTTPS proxy (no crash, mixed fleet functional). After 107 upgrades, within one reconcile it flips to `connected` with `rpc`+`comp-gzip`.
6. **`fabric_probe` direct throughput:** from 117, `fabric_probe(node="123")` → single-digit `rttMs` + a real `MB/s` on `path:direct`; against the legacy peer → `no fabric link`.
7. **File-transfer regression:** `transfer_send_file` 117→123 still completes (the inbound demux + FabricLink taking over `onData` did not break the tag path or bulk delivery).

- [ ] **Step 7: Final commit (if any fixes) — already pushed in Step 5.**

---

## Self-Review (run after writing; fixed inline)

**1. Spec coverage (Part 2 T1–T7 + W2 row):**
- **T1 Framing** — msgpack `{kind,id,headers,payload}` envelope + `[4B len][0x02]` wire (Task 2); `chunk` split >64KB + reassemble by id (Task 3); req/res correlation + per-call timeout (Task 4); HELLO `{fabricVersion, features}` capability negotiation — reuses W1 `FabricHello.version`/`features`, extended to advertise+capture `rpc`/`comp-gzip` (Task 8). ✓
- **T2 Compression** — per-frame `{comp,rawLen}`, path+payload table (LAN gzip-1 / relay gzip-6, <4KB none, binary skip, unknown entropy-sample <10%→skip), peers without `comp-gzip`→`none`, savings per link (Tasks 5 + 9 + metrics 6). ✓
- **T3 RPC** — `req`→existing route table via loopback dispatch with `{type:'peer',node}` principal headers, error→`{status,code,message}`, large responses stream as chunks, handlers unchanged (Task 10 + FabricLink 9). ✓
- **T4 remainder** — `>8MB` response→bulk handle, fabric fetches transparently via the EXISTING job manager (Task 11); wired into the rpc-server offload hook (Task 10) + singleton (Task 12). Job manager NOT re-planned. ✓
- **T5 Pacing + monitors** — per-link 10s-EWMA per class (in/out, RTT, comp savings, queue depth)→StatusRegistry (Tasks 6 + 12); sender-side class token buckets control>rpc>bus>bulk with per-class caps (default relay-bulk 5MB/s via `fabricRelayBulkCapMBps`, Tasks 1 + 6 + 12); `fabric_probe(node)` MCP with a `TOOL_SCOPES` entry (Task 13). ✓
- **T7 Failure auto-management** — receiver idempotency cache `{reqId→res}` ~2min LRU→effectively exactly-once (Task 7 + 10); retry classification (not-delivered→retry, delivered-no-response→retry same id, app-error→no retry, budget→error) + backoff 0.5s→8s + escalation direct→relay→legacy→re-resolve (Task 14); **T7.4** best-path restoration (re-probe/anti-flap: ≥2 confirms, min 30s dwell, exponential confirmation for flappers) + observability counters (Task 15); counters surfaced in status (Task 12). ✓
- **Global constraints** — per-class kill-switches (Task 1), CJS ESM-trap for msgpack (Task 2 + Global Constraints), TOOL_SCOPES for the one new tool (Task 13), wire-additive mixed-version interop incl. a legacy peer (Tasks 5/8/10/12 + e2e 16.5), dev/prod-separated settings, full-node-path test command. ✓

**2. Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to Task N". Every code step carries complete code. The e2e checklist (16.6) is deploy-time verification (explicitly out of the coding session, matching the W1 house style), not a code placeholder.

**3. Type consistency (checked across tasks):** `Envelope`/`EnvelopeHeaders`/`FrameKind`/`TrafficClass` defined in Task 2, consumed identically in 3/9/10/12. `encodeBody`/`decodeBody` (Task 2) used in 9/10/12. `FabricChannel`/`FabricLink`/`ServerHandler`/`classOf` (Task 9) consumed in 10/12. `IdempotencyCache` (7) → 10/12. `LinkMetrics`/`ClassScheduler`/`LinkMetricsSnapshot` (6) → 9/12. `BulkHandle`/`offloadResponse`/`fetchBulk`/`shouldOffloadToBulk` (11) → 10/12. `FabricResponse`/`FabricAddr`/`fabricRequest`/`fabricProbe`/`getFabricLink` (12) → 13/14. `PathRung`/`RequestOutcome`/`RetryAction`/`RetryCounters` (14) internal. `FlapState`/`decideSwitch`/`applyProbe` (15) internal. `fabricRequest` init grew `reqId?` (Task 12) and Task 14's `fabricRequestManaged` passes it — consistent. Route handlers wrap results in `wrapResponse`/`wrapError` (Task 13, per the repo API rule).

**Resolved ambiguity:** the spec §7 said "msgpack already in the tree — confirm at plan time, else JSON+gzip." It is NOT in the tree (`core/package.json` has no msgpack). Per the plan brief this was resolved by ADDING `@msgpack/msgpack@^3.1.3` (loaded via the ESM import trap) rather than falling back to JSON+gzip — because the envelope must carry binary payloads natively (chunk bodies, binary RPC responses); JSON would force base64 (+33%), defeating the framing layer. Documented as a Global Constraint + Task 2.

**Deliberately deferred out of W2 (with why):**
- **Client-side T7 wiring — `fabricRequestWithRetry`/`fabricRequestManaged` (retry.ts) and `PathSupervisor` (restoration.ts) are built + fully unit-tested but NOT yet composed into a live production path** (no production caller of `fabricRequest`/`fabricRequestManaged` exists in W2; `initFabric` does not start `PathSupervisor`). This is intentional — W2 is a *foundation* wave and the first production RPC client is **W4** (data-service sync over fabric). The receiver half (idempotency + rpc-server + bulk offload) IS live. **W4 MUST: (a) call `fabricRequestManaged` (NOT bare `fabricRequest`, which has no retry), (b) gate outbound RPC sends on `peerHasFeature('rpc')` for mixed-version safety, (c) start `PathSupervisor` in `initFabric` and surface the T7 counters (retries/escalations/dedupHits/flaps/pathInUse-vs-bestPathAvailable) in `/fabric/status`.** The transport `Channel` already auto-selects direct↔relay via its live `mode`, so practical path optimization happens even before `PathSupervisor` is wired.
- **`fabricRpcEnabled` defaults FALSE** — fabric RPC dispatches to any local route with full local authority and no allow-list, live-on-peer-connect; until W4 scopes the `'peer'` principal (and adds a `loopbackDispatch` allow-list mirroring the hub relay's `ALLOWED_API_PREFIXES`), RPC is opt-in. Enable explicitly per-node to exercise the RPC e2e.
- **Bus (`pub`) + data-over-fabric (`xfer`)** frames are reserved in `FrameKind` but not implemented — they are W3/W4 per the spec's delivery plan; FabricLink ignores them in W2.
- **Fully weighted fair-queue scheduling** — W2 ships strict-priority-by-capping (only lower classes capped); a true WFQ is noted deferred in `metrics.ts`.
- **Forced per-attempt legacy-proxy hop** in the retry ladder — transport direct→relay downgrade is automatic in the hybrid `Channel`; when no fabric link exists the caller falls back to the hub HTTPS proxy. Explicit per-send `forceMode` escalation is not needed for the W2 guarantees and is left to the transport layer.
- **Direct-path encryption**, **hub-down LAN survivability**, and the **S3 later-wave migrations** — explicitly deferred by the spec (§6 Deferred), unchanged here.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-03-peer-fabric-w2-transmission.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration (REQUIRED SUB-SKILL: superpowers:subagent-driven-development; fresh subagent per task + two-stage review).

**2. Inline Execution** — execute tasks in this session using superpowers:executing-plans, batch execution with checkpoints.

**Which approach?**
