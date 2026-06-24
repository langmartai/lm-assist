import { test } from 'node:test';
import assert from 'node:assert';

// We can't import the handler directly without setting up all MCP infra,
// so we test via the GUIDES export.
import { GUIDES_TEST_EXPORT } from '../mcp-server/tools/guide';

test('guide("mission-controller") text matches /mission_place/', () => {
  const text = GUIDES_TEST_EXPORT['mission-controller'];
  assert.ok(text, 'mission-controller guide should exist');
  assert.match(text, /mission_place/);
});

test('guide("mission-controller") text matches /never auto-approve/i', () => {
  const text = GUIDES_TEST_EXPORT['mission-controller'];
  assert.ok(text);
  assert.match(text, /never auto-approve/i);
});

test('guide("mission-controller") text matches /await the next pass/i', () => {
  const text = GUIDES_TEST_EXPORT['mission-controller'];
  assert.ok(text);
  assert.match(text, /await the next pass/i);
});
