import { test } from 'node:test';
import assert from 'node:assert';
import { GUIDE_HANDLERS } from '../mcp-server/tools/guide';

test('guide("missions") returns mission-controller orientation', async () => {
  const res = await GUIDE_HANDLERS.guide({ topic: 'missions' });
  const text = JSON.stringify(res);
  assert.match(text, /Mission Controller/i);
  assert.match(text, /mission_create/);
});
