import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HUB_MCP_SERVER_NAME,
  PROFILE_MCP_SERVER_PREFIX,
  PROFILE_PIN_ENV,
  deriveHubMcpUrl,
  parseMcpCliArgs,
  profileMcpServerName,
  profileMcpUrl,
  profileRequiredMessage,
  readFlagValue,
  removeProfileMcpServer,
  resolveEntryProfile,
  upsertHubMcpServer,
  upsertProfileMcpServer,
} from '../utils/claude-mcp-config';
import { connectorUrlFor } from '../mcp-server/profile-connectors';

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

// ── per-profile entries ──────────────────────────────────────────────────────────

const HUB_MCP = 'https://mcp.langmart.ai/mcp';
const hubEntry = { type: 'http', url: HUB_MCP, headers: { Authorization: 'Bearer sk-hub' } };

test('resolveEntryProfile: canonical names, the langmart alias, case, and refusals', () => {
  assert.deepEqual(resolveEntryProfile('basic'), { profile: 'basic' });
  assert.deepEqual(resolveEntryProfile(' Basic '), { profile: 'basic' });       // typed on a command line
  assert.deepEqual(resolveEntryProfile('langmart'), { profile: 'platform' });   // renamed; alias kept
  for (const bad of ['nope', 'connectors', 'hub', '__proto__', 'constructor', '', undefined, null]) {
    const r = resolveEntryProfile(bad as string | undefined | null);
    assert.ok('error' in r, `${String(bad)} must be refused`);
  }
  const r = resolveEntryProfile('nope');
  assert.ok('error' in r);
  assert.ok(r.error.includes('unknown profile "nope"'), r.error);
  assert.ok(r.error.includes('basic') && r.error.includes('langmart → platform'), r.error);
});

test('profileMcpServerName / profileMcpUrl, and the URL agrees with Core for the same hub', () => {
  assert.equal(profileMcpServerName('basic'), `${PROFILE_MCP_SERVER_PREFIX}basic`);
  assert.equal(profileMcpServerName('basic'), 'lm-assist-basic');
  const hubMcp = deriveHubMcpUrl('wss://assist-api.langmart.ai')!;
  assert.equal(profileMcpUrl(hubMcp, 'basic'), 'https://mcp.langmart.ai/mcp/basic');
  assert.equal(profileMcpUrl(`${hubMcp}/`, 'basic'), 'https://mcp.langmart.ai/mcp/basic');
  // The CLI (this file) and Core (profile-connectors.ts) must mint the SAME URL, or a Claude Code
  // entry and a claude.ai connector for one profile would be two different resources on the hub.
  for (const p of ['basic', 'platform', 'extended', 'admin']) {
    assert.equal(profileMcpUrl(hubMcp, p), connectorUrlFor(p, 'https://mcp.langmart.ai'));
  }
});

test('upsertProfileMcpServer (http): lm-assist-<p> at /mcp/<p> with the node Bearer — lm-assist-hub untouched', () => {
  const input = { userID: 'u1', mcpServers: { [HUB_MCP_SERVER_NAME]: hubEntry, github: { type: 'http', url: 'https://gh' } } };
  const frozen = JSON.stringify(input);
  const r = upsertProfileMcpServer(input, { profile: 'basic', transport: 'http', hubMcpUrl: HUB_MCP, key: 'sk-node' });
  assert.equal(r.name, 'lm-assist-basic');
  assert.equal(r.profile, 'basic');
  assert.deepEqual(servers(r.config)['lm-assist-basic'], {
    type: 'http',
    url: 'https://mcp.langmart.ai/mcp/basic',
    headers: { Authorization: 'Bearer sk-node' },
  });
  assert.deepEqual(servers(r.config)[HUB_MCP_SERVER_NAME], hubEntry);          // the hub entry, as it was
  assert.deepEqual(servers(r.config).github, { type: 'http', url: 'https://gh' });
  assert.equal(r.config.userID, 'u1');
  assert.equal(JSON.stringify(input), frozen);                                 // input not mutated
});

test('upsertProfileMcpServer (stdio): the Settings install command + LM_MCP_PROFILE, keyed by the canonical name', () => {
  const r = upsertProfileMcpServer({}, {
    profile: 'langmart', transport: 'stdio', command: 'node', args: ['/x/core/dist/mcp-server/index.js'],
  });
  assert.equal(r.name, 'lm-assist-platform');
  assert.equal(PROFILE_PIN_ENV, 'LM_MCP_PROFILE');
  assert.deepEqual(servers(r.config)['lm-assist-platform'], {
    type: 'stdio',
    command: 'node',
    args: ['/x/core/dist/mcp-server/index.js'],
    env: { LM_MCP_PROFILE: 'platform' },
  });
});

test('upsertProfileMcpServer: idempotent, and switching transport replaces the one entry', () => {
  const a = upsertProfileMcpServer({}, { profile: 'basic', transport: 'http', hubMcpUrl: HUB_MCP, key: 'k1' });
  const b = upsertProfileMcpServer(a.config, { profile: 'basic', transport: 'stdio', command: 'node', args: ['/s.js'] });
  assert.deepEqual(Object.keys(servers(b.config)), ['lm-assist-basic']);
  assert.equal(servers(b.config)['lm-assist-basic'].type, 'stdio');
});

test('upsertProfileMcpServer: refuses an unknown profile and missing transport inputs', () => {
  assert.throws(
    () => upsertProfileMcpServer({}, { profile: 'nope', transport: 'http', hubMcpUrl: HUB_MCP, key: 'k' }),
    /unknown profile "nope"/,
  );
  assert.throws(() => upsertProfileMcpServer({}, { profile: 'basic', transport: 'http', hubMcpUrl: '', key: 'k' }), /hub MCP URL/);
  assert.throws(() => upsertProfileMcpServer({}, { profile: 'basic', transport: 'http', hubMcpUrl: HUB_MCP, key: '' }), /node key/);
  assert.throws(() => upsertProfileMcpServer({}, { profile: 'basic', transport: 'stdio', command: '', args: [] }), /command/);
});

test('removeProfileMcpServer: removes only lm-assist-<p>, resolves the alias, and refuses the hub entry', () => {
  const start = {
    mcpServers: {
      [HUB_MCP_SERVER_NAME]: hubEntry,
      'lm-assist-basic': { type: 'http', url: 'x' },
      'lm-assist-platform': { type: 'http', url: 'y' },
    },
  };
  const frozen = JSON.stringify(start);
  const r1 = removeProfileMcpServer(start, 'basic');
  assert.equal(r1.removed, true);
  assert.deepEqual(Object.keys(servers(r1.config)).sort(), [HUB_MCP_SERVER_NAME, 'lm-assist-platform']);
  const r2 = removeProfileMcpServer(r1.config, 'langmart');                   // alias → lm-assist-platform
  assert.equal(r2.name, 'lm-assist-platform');
  assert.deepEqual(Object.keys(servers(r2.config)), [HUB_MCP_SERVER_NAME]);
  assert.deepEqual(servers(r2.config)[HUB_MCP_SERVER_NAME], hubEntry);
  // A well-formed name this build does not define is still removable: a later build may drop a
  // profile, and the entry it wrote must not be stranded.
  const r3 = removeProfileMcpServer({ mcpServers: { 'lm-assist-retired': { type: 'http', url: 'z' } } }, 'retired');
  assert.equal(r3.removed, true);
  assert.equal(removeProfileMcpServer({}, 'basic').removed, false);
  assert.throws(() => removeProfileMcpServer(start, 'hub'), /lm-assist-hub/);
  assert.throws(() => removeProfileMcpServer(start, 'context'), /lm-assist-context/);
  assert.throws(() => removeProfileMcpServer(start, '../x'), /not a profile name/);
  assert.equal(JSON.stringify(start), frozen);                                // input not mutated
});

test('parseMcpCliArgs: add/remove, --profile in both spellings, --stdio, and refusals', () => {
  assert.deepEqual(parseMcpCliArgs(['add', '--profile', 'basic']), { action: 'add', profile: 'basic', stdio: false });
  assert.deepEqual(parseMcpCliArgs(['add', '--profile=basic', '--stdio']), { action: 'add', profile: 'basic', stdio: true });
  assert.deepEqual(parseMcpCliArgs(['remove', '--profile', 'basic']), { action: 'remove', profile: 'basic', stdio: false });
  assert.deepEqual(parseMcpCliArgs(['add']), { action: 'add', profile: undefined, stdio: false });
  for (const bad of [[], ['list'], ['add', '--profile'], ['add', '--profile', '--stdio'], ['add', '--profile='],
    ['add', '--profile', 'basic', '--bogus'], ['remove', '--profile', 'basic', '--stdio']]) {
    assert.ok('error' in parseMcpCliArgs(bad), `${JSON.stringify(bad)} must be refused`);
  }
});

test('readFlagValue: absent, present with a value (both spellings), present without one', () => {
  assert.deepEqual(readFlagValue(['lmkp_x'], '--mcp-profile'), { present: false });
  assert.deepEqual(readFlagValue(['lmkp_x', '--mcp-profile', 'basic'], '--mcp-profile'), { present: true, value: 'basic' });
  assert.deepEqual(readFlagValue(['--mcp-profile=basic', 'lmkp_x'], '--mcp-profile'), { present: true, value: 'basic' });
  assert.deepEqual(readFlagValue(['--mcp-profile'], '--mcp-profile'), { present: true });
  assert.deepEqual(readFlagValue(['--mcp-profile', '--no-mcp'], '--mcp-profile'), { present: true });
});

test('profileRequiredMessage names the unpinned entries this command does not manage', () => {
  const m = profileRequiredMessage();
  assert.ok(m.includes(HUB_MCP_SERVER_NAME), m);
  assert.ok(m.includes("'lm-assist'"), m);
  assert.ok(m.includes('basic'), m);
});
