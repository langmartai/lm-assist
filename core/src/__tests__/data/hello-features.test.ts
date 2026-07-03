import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PeerLink } from '../../fabric/peer-link';
import { parseFabricControl } from '../../fabric/protocol';

// Capture the HELLO the PeerLink emits on open() by driving a fake channel.
function helloFeaturesFrom(features: () => string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const ch = {
      mode: 'relay' as const, via: null, rtt: null,
      sendControl: (b: Buffer) => {
        // First control frame is our hello. Parse the framed control payload.
        const { FrameReader } = require('../../file-transfer/frame');
        const fr = new FrameReader();
        for (const f of fr.push(b)) if (f.kind === 'control') {
          const msg = parseFabricControl(f.msg);
          if (msg?.kind === 'hello') resolve(msg.features ?? []);
        }
        chunks.push(b);
      },
      onData: () => {}, onClose: () => {}, close: () => {},
    };
    const link = new PeerLink('gw-b', {
      openChannel: async () => ch as any, selfNode: 'self', now: () => Date.now(), helloTimeoutMs: 1, features,
    });
    void link.open();
  });
}

test('features dep gates bus/data in the HELLO advert', async () => {
  assert.deepEqual((await helloFeaturesFrom(() => ['status', 'rpc', 'comp-gzip', 'data'])), ['status', 'rpc', 'comp-gzip', 'data']);
  assert.deepEqual((await helloFeaturesFrom(() => ['status', 'rpc', 'comp-gzip'])), ['status', 'rpc', 'comp-gzip']);
});
