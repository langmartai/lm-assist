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
