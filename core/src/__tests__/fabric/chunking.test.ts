import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { splitEnvelope, ChunkAssembler, CHUNK_THRESHOLD, type Env } from '../../fabric/chunking';
import type { Envelope } from '../../fabric/envelope';

const base = (payload: Uint8Array, id: string = 'r1'): Envelope =>
  ({ kind: 'res', id, headers: { status: 200, cls: 'rpc' }, payload });

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

// ---------------------------------------------------------------------------
// Idle-TTL eviction (Task 16 finalize fix): a peer that sends frame 0 and then
// never `fin`s (dies mid-send, drops the link, etc.) used to leak its Partial
// in `open` forever. evictStale() runs at the top of every accept() and drops
// any entry untouched for >= ttlMs — proven here with an injected clock so
// the test doesn't need to sleep in real time.
// ---------------------------------------------------------------------------
test('idle-TTL evicts a stale partial after ttlMs (injected clock)', () => {
  let t = 0;
  const asm = new ChunkAssembler(32 * 1024 * 1024, 1000, () => t);
  const frames = splitEnvelope(base(new Uint8Array(200), 'stale-1'), 32);
  assert.ok(frames.length >= 3);

  assert.equal(asm.accept(frames[0]), null); // opens the partial (seq 0), touched at t=0

  t = 5000; // advance well past the 1000ms TTL
  // evictStale() runs at the top of every accept() — this drops the stale
  // 'stale-1' entry (its frame 0, which carries kind/headers, is now gone),
  // so feeding the rest of the sequence (including the fin frame) can never
  // complete a reassembly for this id again.
  let result: Envelope | null = null;
  for (const f of frames.slice(1)) { const r = asm.accept(f); if (r) result = r; }
  assert.equal(result, null, 'seq 0 was evicted — this id can never reassemble again');
});

test('idle-TTL does not evict a partial touched within ttlMs', () => {
  let t = 0;
  const asm = new ChunkAssembler(32 * 1024 * 1024, 1000, () => t);
  const payload = new Uint8Array(200);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  const frames = splitEnvelope(base(payload, 'fresh-1'), 32);

  assert.equal(asm.accept(frames[0]), null); // touched at t=0
  t = 500; // well under the 1000ms TTL
  let done: Envelope | null = null;
  for (const f of frames.slice(1)) { const r = asm.accept(f); if (r) done = r; }
  assert.ok(done, 'a recently-touched partial reassembles normally, not evicted');
  assert.deepEqual([...done!.payload], [...payload]);
});
