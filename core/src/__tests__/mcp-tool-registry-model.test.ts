/**
 * Pure model for the MCP tool registry (spec §4.1) — overlay-only docs keyed by
 * tool name. Mirrors workflow-model.test coverage: id validation, override size
 * cap, changed-detection, protected set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateToolName,
  validateDescriptionOverride,
  toolRegistryChanged,
  PROTECTED_TOOLS,
  MAX_DESCRIPTION_OVERRIDE_BYTES,
  TOOL_REGISTRY_HISTORY_CAP,
  type ToolRegistryDoc,
} from '../mcp-server/registry/model';

test('validateToolName accepts real MCP tool names and the e2e scratch id', () => {
  for (const id of ['detail', 'windows_terminal_list', 'zz-e2e-probe', 'a', 'x1']) {
    assert.deepEqual(validateToolName(id), { ok: true }, id);
  }
});

test('validateToolName rejects malformed ids', () => {
  for (const id of ['', 'Detail', 'has.dot', '-leading', '_leading', 'a'.repeat(65), 'sp ace', 'semi;colon']) {
    const r = validateToolName(id);
    assert.equal(r.ok, false, `should reject "${id}"`);
    if (!r.ok) assert.equal(r.code, 'INVALID_INPUT');
  }
});

test('validateDescriptionOverride: null clears, short strings pass', () => {
  assert.deepEqual(validateDescriptionOverride(null), { ok: true });
  assert.deepEqual(validateDescriptionOverride('a fine override'), { ok: true });
});

test('validateDescriptionOverride rejects empty string (use null to clear)', () => {
  const r = validateDescriptionOverride('');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'INVALID_INPUT');
});

test('validateDescriptionOverride rejects non-strings', () => {
  const r = validateDescriptionOverride(42 as unknown as string);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'INVALID_INPUT');
});

test('validateDescriptionOverride enforces the byte cap', () => {
  const atCap = 'x'.repeat(MAX_DESCRIPTION_OVERRIDE_BYTES);
  assert.deepEqual(validateDescriptionOverride(atCap), { ok: true });
  const over = 'x'.repeat(MAX_DESCRIPTION_OVERRIDE_BYTES + 1);
  const r = validateDescriptionOverride(over);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'OVERRIDE_TOO_LARGE');
  // multi-byte: 700 × '€' (3 bytes) = 2100 bytes > 2048
  const multi = '€'.repeat(700);
  const rm = validateDescriptionOverride(multi);
  assert.equal(rm.ok, false);
});

function doc(partial: Partial<ToolRegistryDoc>): ToolRegistryDoc {
  const actor = { kind: 'user' as const, channel: 'api' as const, node: 'gw-117', at: 1 };
  return {
    name: 'detail', descriptionOverride: null, enabled: true,
    rev: 1, history: [], createdBy: actor, lastUpdatedBy: actor,
    createdAt: 1, updatedAt: 1, ...partial,
  };
}

test('toolRegistryChanged: no prior doc is always a change', () => {
  assert.equal(toolRegistryChanged(null, { descriptionOverride: null, enabled: true }), true);
});

test('toolRegistryChanged: identical state is a no-op', () => {
  assert.equal(toolRegistryChanged(doc({}), { descriptionOverride: null, enabled: true }), false);
  assert.equal(
    toolRegistryChanged(doc({ descriptionOverride: 'o', enabled: false }), { descriptionOverride: 'o', enabled: false }),
    false,
  );
});

test('toolRegistryChanged: each field flips it', () => {
  assert.equal(toolRegistryChanged(doc({}), { descriptionOverride: 'new', enabled: true }), true);
  assert.equal(toolRegistryChanged(doc({}), { descriptionOverride: null, enabled: false }), true);
});

test('protected set is exactly the documented orientation trio', () => {
  assert.deepEqual([...PROTECTED_TOOLS].sort(), ['bootstrap', 'guide', 'session_status']);
});

test('history cap constant is 20 (spec §4.1)', () => {
  assert.equal(TOOL_REGISTRY_HISTORY_CAP, 20);
});

test('validateToolName rejects reserved route-namespace names', () => {
  const r = validateToolName('overlay');
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'RESERVED_NAME');
});
