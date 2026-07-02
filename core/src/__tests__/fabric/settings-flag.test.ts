import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULTS } from '../../project-settings';

test('fabricEnabled defaults to true', () => {
  assert.equal((DEFAULTS as unknown as Record<string, unknown>).fabricEnabled, true);
});
