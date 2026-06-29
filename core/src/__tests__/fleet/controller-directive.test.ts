import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CONTROLLER_PASS_DIRECTIVE, CONTROLLER_SYSTEM_PROMPT } from '../../mission/mission-controller';

test('controller pass directive tells it to survey footprints before placing + defer on conflict', () => {
  assert.match(CONTROLLER_PASS_DIRECTIVE, /session_footprints/);
  assert.match(CONTROLLER_PASS_DIRECTIVE, /ctl:deferred-contention/);
  assert.match(CONTROLLER_PASS_DIRECTIVE, /unmanaged/i);
});

test('controller system prompt names the survey tool', () => {
  assert.match(CONTROLLER_SYSTEM_PROMPT, /session_footprints/);
});
