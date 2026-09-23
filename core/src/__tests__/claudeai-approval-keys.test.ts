/**
 * Driven approvals with SEVERAL lm-assist connectors exposing the same tool names.
 *
 * discoverApprovalKeys indexed keys by tool name only, so the last connector written won and a
 * driven `/tool_approval` could go out with ANOTHER connector's key. claude.ai names every
 * tool_use `<integration>:<tool>`; the integration is the connector name, which is what picks it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexApprovalKeys, selectApprovalKey } from '../utils/claudeai-session';

const A = '8f61a74e-9d48-44b6-9ba0-a8d4873a86c2'; // "lm-assist langmart"
const B = '3b3b3b3b-0000-4000-8000-00000000000b'; // "lm-assist langmart basic"
const H1 = 'a'.repeat(32);
const H2 = 'b'.repeat(32);
// A neutral plugin name: the test only needs a tool name carrying '-' and '__'.
const PLUGIN = 'ext__demo-plugin__alerts_list';

// B written LAST — under the old flat maps, B answered for every connector.
const SETTINGS: Record<string, boolean> = {
  search: true, // legacy uuid-less key: ignored
  [`${A}:search`]: true,
  [`${A}:search-${H1}`]: true,
  [`${B}:search`]: true,
  [`${B}:search-${H2}`]: true,
  [`${B}:${PLUGIN}`]: true,
};
const ENTRY = { ...indexApprovalKeys(SETTINGS), uuidByName: { 'lm-assist langmart': A, 'lm-assist langmart basic': B } };

test("the <integration>: prefix picks THAT connector's key — not the last one written", () => {
  assert.deepEqual(selectApprovalKey(ENTRY, 'lm-assist langmart:search'), { key: `${A}:search-${H1}`, bare: `${A}:search` });
  assert.deepEqual(selectApprovalKey(ENTRY, 'lm-assist langmart basic:search'), { key: `${B}:search-${H2}`, bare: `${B}:search` });
});

test('the prefix match ignores case', () => {
  assert.equal(selectApprovalKey(ENTRY, 'LM-Assist Langmart:search').key, `${A}:search-${H1}`);
});

test('no prefix, or an unknown one: flat maps, with hash and bare from the SAME connector', () => {
  for (const name of ['search', 'someone else:search']) {
    const r = selectApprovalKey(ENTRY, name);
    assert.ok(r.key && r.bare, name);
    assert.equal(r.bare, `${r.key!.slice(0, 36)}:search`, `${name}: bare key must belong to the hash key's connector`);
  }
});

test('hyphenated plugin tool names are indexed (the old [a-zA-Z0-9_]+ pattern skipped them)', () => {
  assert.equal(ENTRY.byConnector[B].bareKeys[PLUGIN], `${B}:${PLUGIN}`);
  assert.deepEqual(selectApprovalKey(ENTRY, `lm-assist langmart basic:${PLUGIN}`), { key: `${B}:${PLUGIN}`, bare: `${B}:${PLUGIN}` });
});

test("a prefix naming a KNOWN connector never borrows another connector's key", () => {
  // Only B holds the plugin tool (e.g. A's keys have not reached the probe's inherited settings
  // yet). The tool_use names A, so B's key must not be sent: it would 4xx, and so would a bare
  // fallback taken from B.
  const r = selectApprovalKey(ENTRY, `lm-assist langmart:${PLUGIN}`);
  assert.deepEqual(r, { key: undefined, bare: undefined });
  // search-<hash> exists on both; a connector that only has the HASH key still answers from itself.
  const onlyHash = { ...indexApprovalKeys({ [`${A}:search-${H1}`]: true, [`${B}:search`]: true }), uuidByName: ENTRY.uuidByName };
  assert.deepEqual(selectApprovalKey(onlyHash, 'lm-assist langmart:search'), { key: `${A}:search-${H1}`, bare: undefined });
  assert.deepEqual(selectApprovalKey(onlyHash, 'lm-assist langmart basic:search'), { key: `${B}:search`, bare: `${B}:search` });
});

test('a known connector with NO keys at all still does not fall through to the flat maps', () => {
  const C = '4c4c4c4c-0000-4000-8000-00000000000c';
  const withC = { ...ENTRY, uuidByName: { ...ENTRY.uuidByName, 'lm-assist langmart admin': C } };
  assert.deepEqual(selectApprovalKey(withC, 'lm-assist langmart admin:search'), { key: undefined, bare: undefined });
});

test('a connector name that is an Object.prototype key is not a known connector', () => {
  const r = selectApprovalKey(ENTRY, 'constructor:search');
  assert.ok(r.key && r.bare, 'unknown prefix ⇒ the flat maps, as before');
});

test('a tool no connector exposes → no key (approveToolUse answers 204)', () => {
  assert.deepEqual(selectApprovalKey(ENTRY, 'lm-assist langmart:tool_search'), { key: undefined, bare: undefined });
});

test('uuid-less legacy keys are never indexed', () => {
  assert.ok(!Object.values(ENTRY.bareKeys).includes('search'));
});
