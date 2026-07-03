import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { busEventToSse } from '../../rest-server';
import type { BusEvent } from '../../bus/types';

test('busEventToSse maps a BusEvent to a stream-safe payload', () => {
  const e: BusEvent = { topic: 'mission:1', origin: 'gw-a', seq: 4, type: 'updated', at: 1720000000000, payload: { x: 1 } };
  const s = busEventToSse(e);
  assert.equal(s.type, 'bus_event');
  assert.equal(s.tier, 'system');
  assert.equal(s.data.topic, 'mission:1');
  assert.equal(s.data.id, 'gw-a:4');
  assert.equal(s.data.eventType, 'updated');
  assert.equal(s.data.seq, 4);
});
