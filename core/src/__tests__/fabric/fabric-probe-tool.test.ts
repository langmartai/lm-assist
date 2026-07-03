// core/src/__tests__/fabric/fabric-probe-tool.test.ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FABRIC_PROBE_TOOL_DEFS, formatProbe } from '../../mcp-server/tools/fabric-probe';
import { TOOL_SCOPES } from '../../mcp-server/configure';

test('def is registered read-only and scoped (else /mcp crashes)', () => {
  assert.equal(FABRIC_PROBE_TOOL_DEFS.length, 1);
  assert.equal(FABRIC_PROBE_TOOL_DEFS[0].name, 'fabric_probe');
  assert.equal(FABRIC_PROBE_TOOL_DEFS[0].annotations.readOnlyHint, true);
  assert.equal(TOOL_SCOPES['fabric_probe'], 'read');
});

test('formatter renders measured throughput + rtt + path', () => {
  const s = formatProbe({ node: 'gw4-b', rttMs: 3, mbps: 187.4, path: 'direct' });
  assert.match(s, /gw4-b/);
  assert.match(s, /3\s*ms/);
  assert.match(s, /187/);
  assert.match(s, /direct/);
  assert.match(formatProbe({ node: 'x', rttMs: null, mbps: null, path: 'none' }), /no fabric link|not connected/i);
});
