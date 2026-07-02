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
