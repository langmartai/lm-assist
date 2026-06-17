import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-m5id-'));
import { thisNodeId } from '../../data/paths';
import { getHubConfig } from '../../hub-client/hub-config';
import { DATA_HANDLERS } from '../../mcp-server/tools/data-tools';
import { runWithMcpContext } from '../../mcp-server/principal-context';
import { getDataService } from '../../data/data-service';

test('thisNodeId returns the canonical fleet id (gatewayId || machineId)', () => {
  const cfg = getHubConfig();
  const expected = cfg.gatewayId || cfg.machineId || os.hostname() || 'local';
  assert.equal(thisNodeId(), expected);
  assert.equal(typeof thisNodeId(), 'string');
  assert.ok(thisNodeId().length > 0);
});

test('data_catalog reports servedBy (node + platform)', async () => {
  (getDataService() as any).enabledOverride = true;
  const r = await runWithMcpContext({ principal: { type: 'local' } }, () => DATA_HANDLERS.data_catalog({}));
  const text = r.content.map((c: any) => c.text).join('\n');
  const obj = JSON.parse(text);
  assert.ok(obj.servedBy && typeof obj.servedBy.node === 'string' && obj.servedBy.node.length > 0);
  assert.equal(obj.servedBy.platform, os.platform());
  assert.ok(Array.isArray(obj.datasets));
});
