import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULTS } from '../../project-settings';

test('busEnabled defaults on', () => {
  assert.equal((DEFAULTS as unknown as Record<string, unknown>).busEnabled, true);
});
