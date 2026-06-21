import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HUB_MCP_SERVER_NAME,
  deriveHubMcpUrl,
  upsertHubMcpServer,
} from '../utils/claude-mcp-config';

// upsertHubMcpServer returns a heterogeneous config (Record<string, unknown>);
// this view types the mcpServers map for assertions.
const servers = (c: Record<string, unknown>): Record<string, any> =>
  c.mcpServers as Record<string, any>;

test('deriveHubMcpUrl: assist-api.<domain> (ws/wss) -> https://mcp.<domain>/mcp', () => {
  assert.equal(deriveHubMcpUrl('wss://assist-api.langmart.ai'), 'https://mcp.langmart.ai/mcp');
  assert.equal(deriveHubMcpUrl('wss://assist-api.xeenhub.com'), 'https://mcp.xeenhub.com/mcp');
  assert.equal(deriveHubMcpUrl('ws://assist-api.langmart.ai'), 'https://mcp.langmart.ai/mcp');
  // tolerates a trailing path/port on the hub url — only the host matters
  assert.equal(deriveHubMcpUrl('wss://assist-api.langmart.ai:443/ws'), 'https://mcp.langmart.ai/mcp');
});

test('deriveHubMcpUrl: junk / non-assist-api host -> null', () => {
  assert.equal(deriveHubMcpUrl(''), null);
  assert.equal(deriveHubMcpUrl(undefined), null);
  assert.equal(deriveHubMcpUrl(null), null);
  assert.equal(deriveHubMcpUrl('not-a-url'), null);
  assert.equal(deriveHubMcpUrl('wss://example.com'), null);          // no assist-api prefix
  assert.equal(deriveHubMcpUrl('wss://mcp.langmart.ai'), null);      // already the mcp host, not assist-api
});

test('upsertHubMcpServer: adds the http server with a Bearer header under top-level mcpServers', () => {
  const out = upsertHubMcpServer({}, { url: 'https://mcp.langmart.ai/mcp', key: 'sk-xyz' });
  assert.deepEqual(servers(out)[HUB_MCP_SERVER_NAME], {
    type: 'http',
    url: 'https://mcp.langmart.ai/mcp',
    headers: { Authorization: 'Bearer sk-xyz' },
  });
});

test('upsertHubMcpServer: preserves other top-level keys AND other mcp servers; does not mutate input', () => {
  const input = { userID: 'u1', mcpServers: { github: { type: 'http', url: 'https://gh' } } };
  const frozen = JSON.stringify(input);
  const out = upsertHubMcpServer(input, { url: 'https://mcp.langmart.ai/mcp', key: 'sk-1' });
  assert.equal(out.userID, 'u1');                                       // unrelated key preserved
  assert.deepEqual(servers(out).github, { type: 'http', url: 'https://gh' }); // other server preserved
  assert.ok(servers(out)[HUB_MCP_SERVER_NAME]);                         // ours added
  assert.equal(JSON.stringify(input), frozen);                          // input untouched
});

test('upsertHubMcpServer: idempotent — re-upsert replaces only our entry (new key) and is stable otherwise', () => {
  const first = upsertHubMcpServer({ mcpServers: { other: { type: 'http', url: 'x' } } }, { url: 'https://mcp.langmart.ai/mcp', key: 'old' });
  const second = upsertHubMcpServer(first, { url: 'https://mcp.langmart.ai/mcp', key: 'new' });
  assert.equal(servers(second)[HUB_MCP_SERVER_NAME].headers.Authorization, 'Bearer new'); // updated
  assert.deepEqual(servers(second).other, { type: 'http', url: 'x' });                     // untouched
  assert.equal(Object.keys(servers(second)).length, 2);                                    // no duplicate
});

test('upsertHubMcpServer: tolerates null/garbage config and a custom name', () => {
  const out = upsertHubMcpServer(null, { url: 'https://mcp.langmart.ai/mcp', key: 'sk', name: 'custom-hub' });
  assert.ok(servers(out)['custom-hub']);
  assert.equal(servers(out)['custom-hub'].headers.Authorization, 'Bearer sk');
});
