import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatResultOriginTag, resultOriginTag, withOriginTag } from '../mcp-server/result-origin';
import { runWithMcpContext } from '../mcp-server/principal-context';
import { getHubConfig } from '../hub-client/hub-config';
import { hubHostOf } from '../mcp-server/fleet-identity';
import type { McpToolResult } from '../mcp-server/configure';

test('formatResultOriginTag — relayed form names the hub and carries node + cluster', () => {
  const tag = formatResultOriginTag(
    { hubHost: 'assist-api.langmart.ai', hostname: 'node-117', cluster: 'release' },
    true,
  );
  assert.equal(tag, '⟦lm-assist@assist-api.langmart.ai · node:node-117 · cluster:release⟧');
  assert.match(tag, /node:node-117/);
  assert.match(tag, /cluster:release/);
});

test('formatResultOriginTag — local form says LOCAL and carries node + cluster', () => {
  const tag = formatResultOriginTag(
    { hubHost: 'assist-api.langmart.ai', hostname: 'node-117', cluster: 'release' },
    false,
  );
  assert.equal(tag, '⟦lm-assist · LOCAL · node:node-117 · cluster:release⟧');
  assert.match(tag, /· LOCAL ·/);
  assert.match(tag, /node:node-117/);
  assert.match(tag, /cluster:release/);
});

test('formatResultOriginTag — relayed but no hubHost falls back to LOCAL form', () => {
  const tag = formatResultOriginTag(
    { hubHost: null, hostname: 'this node', cluster: 'default' },
    true,
  );
  assert.match(tag, /· LOCAL ·/);
  assert.ok(!tag.includes('@'), 'no hub host means no @hub segment');
});

test('withOriginTag — appends the tag to a plain text result, preserving the original text', () => {
  const r: McpToolResult = { content: [{ type: 'text', text: 'hello world' }] };
  const out = withOriginTag(r);
  assert.match(out.content[0].text ?? '', /^hello world/, 'original text preserved at the start');
  assert.match(out.content[0].text ?? '', /⟦lm-assist/, 'origin tag appended');
});

test('withOriginTag — leaves error results unchanged', () => {
  const r: McpToolResult = { content: [{ type: 'text', text: 'Error: boom' }], isError: true };
  const out = withOriginTag(r);
  assert.equal(out.content[0].text, 'Error: boom');
  assert.ok(!out.content[0].text.includes('⟦lm-assist'), 'no tag on error results');
});

test('withOriginTag — does not double-tag results carrying the FLEET / CONNECTOR IDENTITY block', () => {
  const text = 'FLEET / CONNECTOR IDENTITY — this lm-assist MCP connector serves ONE fleet ...';
  const r: McpToolResult = { content: [{ type: 'text', text }] };
  const out = withOriginTag(r);
  assert.equal(out.content[0].text, text, 'identity-bearing results are passed through untouched');
});

test('withOriginTag — leaves non-text results unchanged', () => {
  const r = { content: [{ type: 'image', text: '' }] } as unknown as McpToolResult;
  const out = withOriginTag(r);
  assert.equal(out, r, 'non-text first content is returned as-is');
});

test('resultOriginTag — no MCP context resolves to the LOCAL form', () => {
  const tag = resultOriginTag();
  assert.match(tag, /· LOCAL ·/, 'no principal → local/direct call');
});

test('resultOriginTag — a cloud principal selects the @hub form (or LOCAL when no hub configured)', () => {
  const tag = runWithMcpContext({ principal: { type: 'cloud' } as never }, () => resultOriginTag());
  let hubHost: string | null = null;
  try { hubHost = hubHostOf(getHubConfig().hubUrl); } catch { /* no hub */ }
  if (hubHost) {
    assert.ok(tag.startsWith(`⟦lm-assist@${hubHost} ·`), `relayed → names the hub, got: ${tag}`);
    assert.ok(!tag.includes('· LOCAL ·'), 'relayed form must not say LOCAL');
  } else {
    assert.match(tag, /· LOCAL ·/, 'relayed but no hub configured → LOCAL');
  }
});

test('wiring — both MCP dispatch surfaces append the origin tag', () => {
  // Compiled test lives at core/dist-test/__tests__/; the source tree is core/src/.
  const root = join(__dirname, '..', '..', 'src');
  const configure = readFileSync(join(root, 'mcp-server', 'configure.ts'), 'utf8');
  const mcpApi = readFileSync(join(root, 'routes', 'core', 'mcp-api.routes.ts'), 'utf8');
  // Both surfaces must pass the TOOL NAME too — that is what lets the trailer name the
  // playbook governing the tool that answered (session-start routing, layer 2).
  assert.match(configure, /withOriginTag\(result, name\)/, 'configure.ts CallTool must apply withOriginTag with the tool name');
  assert.match(mcpApi, /withOriginTag\(await handler\(body\.args \|\| \{\}\), tool\)/, '/mcp-call must apply withOriginTag with the tool name');
});
