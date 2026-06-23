import { test } from 'node:test';
import assert from 'node:assert';
import { GUIDE_HANDLERS } from '../mcp-server/tools/guide';
import { buildBootstrapInstruction } from '../terminal/ccr-cloud';

test('guide("install") names both OS installers + doctor', async () => {
  const res = await GUIDE_HANDLERS.guide({ topic: 'install' });
  const text = JSON.stringify(res);
  assert.ok(text.includes('install.sh'), 'mentions install.sh');
  assert.ok(text.includes('install.ps1'), 'mentions install.ps1');
  assert.ok(text.includes('lm-assist doctor'), 'mentions doctor');
});

test('buildBootstrapInstruction includes a Windows install alternative', () => {
  const s = buildBootstrapInstruction({});
  assert.ok(/install\.ps1/.test(s), 'mentions the Windows installer');
});
