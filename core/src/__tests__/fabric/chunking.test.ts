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
