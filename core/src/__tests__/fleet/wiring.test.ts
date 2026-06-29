import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isApiPathAllowed } from '../../hub-client/api-relay-handler';

test('relay allow-list includes /fleet so composed fan-out can reach peers', () => {
  assert.equal(isApiPathAllowed('/fleet/session-footprints/local'), true);
});
