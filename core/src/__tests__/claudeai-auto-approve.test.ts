import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoApproveMap } from '../utils/claudeai-session';

// The pure core of "enable auto-approval for a connector's tools": given the connector's tool objects
// from claude.ai's bootstrap (each with enabled_key + always_approved_key = the per-version content
// hash) and the CURRENT enabled_mcp_tools map, produce the merged map that flips the always-approved
// keys. claude.ai's PATCH replaces the whole map, so this must preserve every other key.
const TOOLS = [
  { name: 'data_catalog', enabled_key: 'SRV:data_catalog', always_approved_key: 'SRV:data_catalog-HASH1' },
  { name: 'list_nodes', enabled_key: 'SRV:list_nodes', always_approved_key: 'SRV:list_nodes-HASH2' },
  { name: 'weird', enabled_key: 'SRV:weird' }, // no always_approved_key → skipped
];

test('sets every tool\'s always_approved_key true (+ enabled_key), preserves other settings', () => {
  const cur = { 'OTHER:foo': true, 'SRV:data_catalog': false };
  const { map, changed, skipped } = buildAutoApproveMap(TOOLS, cur, true);
  assert.equal(map['SRV:data_catalog-HASH1'], true);
  assert.equal(map['SRV:list_nodes-HASH2'], true);
  assert.equal(map['SRV:data_catalog'], true); // enabled_key forced true when auto-approving
  assert.equal(map['OTHER:foo'], true);         // unrelated key preserved
  assert.deepEqual(changed.sort(), ['data_catalog', 'list_nodes']);
  assert.deepEqual(skipped, ['weird']);         // no always_approved_key
});

test('toolNames scopes to just those tools', () => {
  const { changed } = buildAutoApproveMap(TOOLS, {}, true, ['list_nodes']);
  assert.deepEqual(changed, ['list_nodes']);
});

test('enable=false removes always-approved (key false) and leaves enabled_key untouched', () => {
  const { map } = buildAutoApproveMap(TOOLS, { 'SRV:data_catalog': true }, false, ['data_catalog']);
  assert.equal(map['SRV:data_catalog-HASH1'], false);
  assert.equal(map['SRV:data_catalog'], true); // not forced on disable
});

test('does not mutate the input map', () => {
  const cur = { 'X:y': true };
  buildAutoApproveMap(TOOLS, cur, true);
  assert.deepEqual(cur, { 'X:y': true });
});
