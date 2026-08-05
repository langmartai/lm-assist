/**
 * The YouTube connector's MCP tools must be wired into ALL of the registries a
 * tool needs — and a missing TOOL_SCOPES entry CRASHES Core on every tools/list
 * (measured for Gmail: it reads as a hub 502 three hops from the cause). The
 * global mcp-tool-scopes / mcp-tool-catalog tests already assert parity across the
 * whole surface; this test names the youtube tools specifically so a regression
 * points straight at this connector instead of at "some tool, somewhere".
 */
import { test } from 'node:test';
import assert from 'node:assert';

import { YOUTUBE_TOOL_DEFS, YOUTUBE_HANDLERS } from '../mcp-server/tools/youtube';
import { requiredScope } from '../mcp-server/configure';
import { getToolCatalog } from '../mcp-server/registry/catalog';

const EXPECTED = [
  'youtube_status',
  'youtube_login',
  'youtube_channel_videos',
  'youtube_video',
  'youtube_transcript',
  'youtube_selfcheck',
];

test('every youtube tool has a def, a handler, a scope, and a catalog entry', () => {
  const defNames = YOUTUBE_TOOL_DEFS.map((d) => d.name);
  const catalog = getToolCatalog();

  for (const name of EXPECTED) {
    assert.ok(defNames.includes(name), `missing tool def: ${name}`);
    assert.ok(typeof YOUTUBE_HANDLERS[name] === 'function', `missing handler: ${name}`);
    // requiredScope defaults unknown tools to 'admin'; a real scope proves the
    // TOOL_SCOPES entry exists (the crash-on-tools/list guard).
    const scope = requiredScope(name);
    assert.ok(['read', 'write', 'admin'].includes(scope), `bad scope for ${name}: ${scope}`);
    assert.ok(catalog.has(name), `missing catalog entry: ${name}`);
  }
});

test('youtube read tools are scoped read; login is admin', () => {
  assert.strictEqual(requiredScope('youtube_status'), 'read');
  assert.strictEqual(requiredScope('youtube_channel_videos'), 'read');
  assert.strictEqual(requiredScope('youtube_video'), 'read');
  assert.strictEqual(requiredScope('youtube_transcript'), 'read');
  assert.strictEqual(requiredScope('youtube_selfcheck'), 'read');
  assert.strictEqual(requiredScope('youtube_login'), 'admin');
});

test('every youtube tool is catalogued under the "youtube" category', () => {
  const catalog = getToolCatalog();
  for (const name of EXPECTED) {
    const entry = catalog.get(name);
    assert.ok(entry, `not catalogued: ${name}`);
    assert.strictEqual(entry?.category, 'youtube', `${name} not in youtube category`);
  }
});
