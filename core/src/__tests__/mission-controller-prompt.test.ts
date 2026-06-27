import { test } from 'node:test';
import assert from 'node:assert';
import { CONTROLLER_SYSTEM_PROMPT, CONTROLLER_PASS_DIRECTIVE } from '../mission/mission-controller';

test('the system prompt teaches the scheduling-intelligence tools + ctl namespace', () => {
  for (const needle of ['mission_schedule', 'mission_changes', 'ctl:']) {
    assert.ok(CONTROLLER_SYSTEM_PROMPT.includes(needle), `system prompt must mention ${needle}`);
  }
});

test('the pass directive tells the controller to start from mission_schedule and react to mission_changes', () => {
  assert.ok(CONTROLLER_PASS_DIRECTIVE.includes('mission_schedule'));
  assert.ok(CONTROLLER_PASS_DIRECTIVE.includes('mission_changes'));
});
