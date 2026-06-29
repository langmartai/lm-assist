import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { sessionFootprintsToolDef } from '../../mcp-server/tools/session-footprints';
import { TOOL_SCOPES } from '../../mcp-server/configure';

test('session_footprints tool def is read-only and scoped', () => {
  assert.equal(sessionFootprintsToolDef.name, 'session_footprints');
  assert.equal(sessionFootprintsToolDef.annotations.readOnlyHint, true);
  assert.equal((TOOL_SCOPES as Record<string, string>).session_footprints, 'read');
});
