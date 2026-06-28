import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE_HANDLERS, GUIDES_TEST_EXPORT } from '../mcp-server/tools/guide';

const guide = (args: Record<string, unknown>) => GUIDE_HANDLERS.guide(args);
const text = async (args: Record<string, unknown>) => (await guide(args)).content[0].text as string;

test('GUIDES has a connectors topic', () => {
  assert.ok('connectors' in GUIDES_TEST_EXPORT, 'GUIDES map must have a connectors key');
});

test('guide("connectors") returns the LIVE fleet identity + the multi-fleet rule', async () => {
  const t = await text({ topic: 'connectors' });
  assert.match(t, /FLEET \/ CONNECTOR IDENTITY/, 'must prepend the dynamic fleet identity');
  assert.match(t, /CONNECTORS \(multi-fleet\)/, 'must carry the multi-fleet rule');
  assert.match(t, /no online node matches|BAD_NODE/, 'must explain the wrong-connector error');
  assert.match(t, /list_nodes/, 'must point at list_nodes for membership');
});

test('connectors appears in the index', async () => {
  const t = await text({ topic: 'index' });
  assert.match(t, /`connectors`/, 'index must list the connectors topic');
});

test('cross-node topic points at guide("connectors")', async () => {
  const t = await text({ topic: 'cross-node' });
  assert.match(t, /guide\("connectors"\)/, 'cross-node must reference the connectors topic');
});
