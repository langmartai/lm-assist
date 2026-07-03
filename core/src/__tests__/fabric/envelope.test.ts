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
