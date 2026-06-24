import { test } from 'node:test';
import assert from 'node:assert';
import { GUIDE_HANDLERS } from '../mcp-server/tools/guide';

test('guide("missions") returns mission-controller orientation', async () => {
  const res = await GUIDE_HANDLERS.guide({ topic: 'missions' });
  const text = JSON.stringify(res);
  assert.match(text, /Mission Controller/i);
  assert.match(text, /mission_create/);
  // full-feature coverage (upgraded bootstrap): native executors, connect/drive, sub-workers
  assert.match(text, /remote-control/);
  assert.match(text, /CONNECT \+ DRIVE/);
  assert.match(text, /sub-worker/i);
});

test('bootstrap includes the Mission Control playbook', async () => {
  const res = await GUIDE_HANDLERS.bootstrap({});
  const text = JSON.stringify(res);
  assert.match(text, /super Mission Controller/);
  assert.match(text, /remote-control/);
});
