/**
 * The BOOTSTRAP_REQUIRED gate under per-connector profiles.
 *
 * A narrowed profile's bootstrap delivers only that profile's playbooks, so its marker is
 * keyed `<id>#<profile>`. A full bootstrap keeps the bare id. The gate passes on the bare
 * key OR the call's own key. So a full bootstrap satisfies every profile, and a narrowed
 * one satisfies only itself. The key is a plain string through the in-memory registry,
 * the persist file and the fleet dataset.
 *
 * The pure core takes the registry as a lookup fn (as in bootstrap-gate.test.ts). The
 * persistence cases go through the REAL registry seams (as in bootstrap-persistence.test.ts).
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  gateKeyFor, evaluateBootstrapGate, recordBootstrapped, isBootstrappedFor, identityHeader, bootstrapGateCheck,
  __registryLookupForTest, __resetBootstrapRegistryForTest, type CallerCandidates,
} from '../mcp-server/mcp-session-resolver';
import { bootstrapMarkerFile, __flushPersistForTest, __resetPersistForTest } from '../mcp-server/bootstrap-persist';
import { publishBootstrapToFleet, fleetBootstrappedAt, type FleetBootstrapStore } from '../mcp-server/bootstrap-registry';
import { resolveEffectiveProfile, _resetProfileCacheForTests, type EffectiveProfile } from '../mcp-server/registry/profiles';
import { playbookTopicForTool } from '../mcp-server/tool-topics';
import type { McpToolResult } from '../mcp-server/configure';
import { stopSessionCache } from '../session-cache';

// The seam test at the bottom runs the live identity resolver (as session-resolver.test.ts
// does). Release the session-cache watcher it starts, or the runner never exits.
after(() => stopSessionCache());

process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bgp-'));

const BASIC = resolveEffectiveProfile('basic');
const EXTENDED = resolveEffectiveProfile('extended');
const ADMIN_PIN = resolveEffectiveProfile('admin');
/** No pin, fresh data dir with no profile file ⇒ the shipped default, admin. */
const NODE_DEFAULT = resolveEffectiveProfile(undefined);

type St = { bootstrappedAt?: number; gateRefusedAt?: number };
const reg = (m: Record<string, St>) => (id: string): St | undefined => m[id];
const caller = (id: string): CallerCandidates => ({ claudeAi: { id }, resolvedAt: Date.now() });
const gate = (tool: string, id: string, lookup: (id: string) => St | undefined, profile?: EffectiveProfile) =>
  evaluateBootstrapGate(tool, playbookTopicForTool(tool), caller(id), lookup, profile);

beforeEach(() => {
  process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bgp-'));
  _resetProfileCacheForTests();
  __resetPersistForTest();
  __resetBootstrapRegistryForTest();
});

test('gateKeyFor keeps the bare id for a full profile and suffixes a narrowed one', () => {
  assert.equal(NODE_DEFAULT.name, 'admin');
  assert.equal(gateKeyFor('conv-1'), 'conv-1');
  assert.equal(gateKeyFor('conv-1', NODE_DEFAULT), 'conv-1');
  assert.equal(gateKeyFor('conv-1', ADMIN_PIN), 'conv-1');
  assert.equal(gateKeyFor('conv-1', BASIC), 'conv-1#basic');
  assert.equal(gateKeyFor('conv-1', EXTENDED), 'conv-1#extended');
  // An unknown pin falls back to the node default (admin here), so its key is the bare id.
  const unknown = resolveEffectiveProfile('no-such-profile');
  assert.equal(unknown.unknownPin, true);
  assert.equal(gateKeyFor('conv-1', unknown), 'conv-1');
});

test('a full bootstrap satisfies every profile', () => {
  const full = reg({ 'conv-1': { bootstrappedAt: 1 } });
  assert.equal(gate('list_recent_sessions', 'conv-1', full, BASIC).reason, 'bootstrapped');
  assert.equal(gate('mission_list', 'conv-1', full, EXTENDED).reason, 'bootstrapped');
  assert.equal(gate('mission_list', 'conv-1', full, ADMIN_PIN).reason, 'bootstrapped');
  assert.equal(gate('mission_list', 'conv-1', full, NODE_DEFAULT).reason, 'bootstrapped');
  assert.equal(gate('mission_list', 'conv-1', full).reason, 'bootstrapped');
});

test('a basic bootstrap satisfies basic only — NOT an admin-effective or an extended call', () => {
  const basicOnly = reg({ 'conv-1#basic': { bootstrappedAt: 1 } });
  assert.equal(gate('list_recent_sessions', 'conv-1', basicOnly, BASIC).reason, 'bootstrapped');
  for (const [label, p] of [['admin pin', ADMIN_PIN], ['node default', NODE_DEFAULT], ['no profile', undefined], ['extended', EXTENDED]] as const) {
    const v = gate('mission_list', 'conv-1', basicOnly, p);
    assert.equal(v.block, true, `${label}: a basic bootstrap must not satisfy it`);
    assert.equal(v.reason, 'first-offence', label);
  }
});

test('the soft block is once per (caller, profile)', () => {
  const refusedUnderBasic = reg({ 'conv-1#basic': { gateRefusedAt: 1 } });
  assert.equal(gate('list_recent_sessions', 'conv-1', refusedUnderBasic, BASIC).reason, 'already-refused');
  assert.equal(gate('mission_list', 'conv-1', refusedUnderBasic, ADMIN_PIN).reason, 'first-offence');
  // Unpinned behaviour is unchanged: a bare refusal lets the unpinned retry through.
  assert.equal(gate('mission_list', 'conv-1', reg({ 'conv-1': { gateRefusedAt: 1 } }), NODE_DEFAULT).reason, 'already-refused');
});

test('recordBootstrapped keys by profile through the REAL registry, the persist file and a restart', async () => {
  recordBootstrapped(caller('conv-B'), BASIC);
  assert.ok(__registryLookupForTest('conv-B#basic')?.bootstrappedAt, 'recorded under the narrowed key');
  assert.equal(__registryLookupForTest('conv-B'), undefined, 'the bare key is NOT claimed by a narrowed bootstrap');
  await __flushPersistForTest();
  const onDisk = JSON.parse(fs.readFileSync(bootstrapMarkerFile(), 'utf-8')) as Record<string, unknown>;
  assert.ok(onDisk['conv-B#basic'], 'the persist file carries the key as-is');
  assert.equal(onDisk['conv-B'], undefined);
  __resetBootstrapRegistryForTest(); // simulated Core restart: reload from disk
  assert.equal(gate('list_recent_sessions', 'conv-B', __registryLookupForTest, BASIC).reason, 'bootstrapped');
  assert.equal(gate('mission_list', 'conv-B', __registryLookupForTest, ADMIN_PIN).reason, 'first-offence');
});

test('with no profile and no call context, recordBootstrapped keeps the bare key (node default admin)', () => {
  recordBootstrapped(caller('conv-A'));
  assert.ok(__registryLookupForTest('conv-A')?.bootstrappedAt);
  assert.equal(gate('list_recent_sessions', 'conv-A', __registryLookupForTest, BASIC).reason, 'bootstrapped', 'and it satisfies basic');
});

test('isBootstrappedFor answers per profile (session_status reads it)', () => {
  recordBootstrapped(caller('conv-S'), BASIC);
  assert.equal(isBootstrappedFor('conv-S', BASIC), true);
  assert.equal(isBootstrappedFor('conv-S', ADMIN_PIN), false);
  assert.equal(isBootstrappedFor('conv-S'), false, 'no context ⇒ the node default (admin)');
  recordBootstrapped(caller('conv-S'), ADMIN_PIN);
  assert.equal(isBootstrappedFor('conv-S', BASIC), true, 'a full bootstrap covers basic too');
  assert.equal(isBootstrappedFor('conv-S'), true);
});

test('a narrowed marker flows through the fleet dataset as a plain string key', async () => {
  const rows = new Map<string, { bootstrappedAt: number; node?: string }>();
  const puts: string[] = [];
  const store: FleetBootstrapStore = {
    async get(id) { return rows.get(id) ?? null; },
    async put(id, row) { puts.push(id); rows.set(id, row); },
  };
  publishBootstrapToFleet(gateKeyFor('conv-9', BASIC), 5, store);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(puts, ['conv-9#basic']);
  assert.equal((await fleetBootstrappedAt('conv-9#basic', store))?.bootstrappedAt, 5);
  assert.equal(await fleetBootstrappedAt('conv-9', store), null, 'a narrowed row never answers for the bare id');
});

test('the identity header names the profile only for a narrowed bootstrap', () => {
  const c: CallerCandidates = { claudeAi: { id: 'conv-H', label: 'x' }, resolvedAt: Date.now() };
  const today = identityHeader(c);
  assert.match(today, /This session is now recorded as BOOTSTRAPPED\.\n/);
  assert.equal(identityHeader(c, NODE_DEFAULT), today);
  assert.equal(identityHeader(c, ADMIN_PIN), today);
  assert.match(identityHeader(c, BASIC), /recorded as BOOTSTRAPPED for profile `basic` only/);
});

test('the gate seam accepts a profile and still skips uncovered tools without resolving', async () => {
  assert.equal(await bootstrapGateCheck('bootstrap', BASIC), null);
  assert.equal(await bootstrapGateCheck('search', BASIC), null);
});

test('the MCP seam records a bootstrap under the profile it was configured with', async () => {
  const { configureMcpServer } = require('../mcp-server/configure');
  const { CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const handlers = new Map<unknown, (req: unknown) => Promise<McpToolResult>>();
  const fakeServer = { setRequestHandler: (schema: unknown, fn: never) => handlers.set(schema, fn) };
  const body: McpToolResult = { content: [{ type: 'text', text: 'BOOTSTRAP_BODY_MARKER' }] };
  configureMcpServer(fakeServer, async () => body, undefined, undefined, { profile: BASIC });
  const handler = handlers.get(CallToolRequestSchema);
  assert.ok(handler, 'configureMcpServer registers a CallTool handler');
  const res = await handler({ params: { name: 'bootstrap', arguments: {} } });
  const t = String((res.content[0] as { text: string }).text);
  assert.match(t, /BOOTSTRAP_BODY_MARKER/);
  assert.match(t, /recorded as BOOTSTRAPPED for profile `basic` only/);
});
