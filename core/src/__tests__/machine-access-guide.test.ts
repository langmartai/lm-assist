import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE_HANDLERS, GUIDES_TEST_EXPORT } from '../mcp-server/tools/guide';

const guide = (args: Record<string, unknown>) => GUIDE_HANDLERS.guide(args);
const text = async (args: Record<string, unknown>) => (await guide(args)).content[0].text as string;

test('GUIDES_TEST_EXPORT contains a "machine-access" entry', () => {
  assert.ok('machine-access' in GUIDES_TEST_EXPORT, 'GUIDES map must have a machine-access key');
});

test('guide("machine-access") mentions the tool + import/check verbs + on-node semantic', async () => {
  const t = await text({ topic: 'machine-access' });
  assert.match(t, /machine_access/, 'must mention the machine_access tool');
  assert.match(t, /import/i, 'must mention import');
  assert.match(t, /check/i, 'must mention the reachability check');
  assert.match(t, /this node|on-node|on this/i, 'must convey commands run ON this node');
});

test('machine_access alias resolves to the machine-access topic', async () => {
  const t = await text({ topic: 'machine_access' });
  assert.match(t, /machine_access/i);
});

test('machine-access topic is listed in the index', async () => {
  const t = await text({});
  assert.match(t, /`machine-access`/, 'index must list the machine-access topic');
});

test('bootstrap includes the machine-access guide (discoverability requirement)', async () => {
  const t = (await GUIDE_HANDLERS.bootstrap({})).content[0].text as string;
  assert.match(t, /machine_access/, 'bootstrap must surface the machine_access capability');
});
