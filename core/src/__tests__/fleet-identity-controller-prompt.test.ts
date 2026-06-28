import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildControllerLaunchExtras } from '../mission/mission-controller';

test('controller launch prompt leads with the fleet/connector identity', () => {
  let captured = '';
  const extras = buildControllerLaunchExtras({
    hubUrl: null,
    apiKey: null,
    writeFile: (name, body) => { if (name === 'mission-controller-sp.txt') captured = body; return '/tmp/' + name; },
  });
  assert.ok(extras.appendSystemPromptFile, 'must produce a system-prompt file path');
  assert.match(captured, /FLEET \/ CONNECTOR IDENTITY/, 'controller prompt must carry the fleet identity');
  assert.match(captured, /OTHER lm-assist MCP connectors/, 'must carry the multi-connector caveat');
  assert.match(captured, /Mission Controller/i, 'must still contain the controller instructions');
});
