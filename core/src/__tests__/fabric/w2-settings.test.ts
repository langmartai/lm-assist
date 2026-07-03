import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULTS } from '../../project-settings';

test('W2 per-class flags default safe', () => {
  const d = DEFAULTS as unknown as Record<string, unknown>;
  assert.equal(d.fabricRpcEnabled, true);
  assert.equal(d.fabricCompressionEnabled, true);
  assert.equal(d.fabricRelayBulkCapMBps, 5);
});
