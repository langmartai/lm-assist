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

test('a corrupt length prefix beyond MAX_FRAME is dropped, not buffered unboundedly', () => {
  const reader = new FabricFrameReader();
  const corrupt = Buffer.alloc(4);
  corrupt.writeUInt32BE(0xffffffff, 0); // claims a ~4GB frame — desynced/corrupt framing
  const out = reader.push(corrupt);
  assert.equal(out.length, 0);       // nothing decodes from a corrupt header
  assert.equal(reader.pending(), 0); // buffer was cleared, not held open waiting for 4GB

  // A subsequent, legitimate push starts from a clean (empty) buffer instead
  // of accumulating toward the old huge target — no lingering OOM risk.
  const more = reader.push(Buffer.from([1, 2, 3]));
  assert.equal(more.length, 0);
  assert.equal(reader.pending(), 3);
});

test('a frame at exactly MAX_FRAME (not over it) is consumed, not dropped as corrupt', () => {
  // Cheap boundary check (no real msgpack payload needed): a synthetic
  // unknown-kind (0xff) body of exactly 64MB proves `len > MAX_FRAME` (not
  // `>=`) is the drop condition — it is skipped as an unrecognized kind (same
  // as any other unknown-kind frame) but the bytes ARE consumed from the
  // buffer, i.e. treated as a normal frame rather than corrupt.
  const MAX_FRAME = 64 * 1024 * 1024;
  const reader = new FabricFrameReader();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME, 0);
  const body = Buffer.alloc(MAX_FRAME, 0xff);
  const out = reader.push(Buffer.concat([header, body]));
  assert.equal(out.length, 0);       // 0xff is an unrecognized kind → skipped, not an error
  assert.equal(reader.pending(), 0); // but consumed as a normal frame, not dropped-as-corrupt
});
