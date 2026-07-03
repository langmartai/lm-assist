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
