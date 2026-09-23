/**
 * session_status reports the connector's EFFECTIVE profile and its source (spec §6) — and,
 * for the shipped case (no pin, node default admin), stays byte-identical to before.
 *
 * Hermetic:
 *  - a temp LM_ASSIST_DATA_DIR holds the node-default profile file and the bootstrap markers,
 *    so a host whose operator ran `mcp_profile set basic` cannot change these results;
 *  - the resolver's recency cache is SEEDED with one fixed claude.ai candidate (in the real
 *    listConversations envelope), so session_status never calls claude.ai and never walks this
 *    host's Claude Code sessions. The cache lives 8 s; each test re-seeds it.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// BEFORE any lm-assist import — never this host's real ~/.lm-assist.
process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'session-status-profile-'));

import {
  SESSION_STATUS_HANDLERS, sessionStatusProfile, resolveRecencyCandidates, __resetRecencyCacheForTest,
  type RecencyDeps,
} from '../mcp-server/mcp-session-resolver';
import { runWithMcpContext } from '../mcp-server/principal-context';
import { setActiveProfile, type EffectiveProfile } from '../mcp-server/registry/profiles';
import { stopSessionCache } from '../session-cache';

const FIXED: RecencyDeps = {
  conversations: async () => ({
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: { data: [{ uuid: 'conv-profile-test', name: 'Profile test chat', updated_at: '2026-09-23T00:00:00Z' }], has_more: false },
  }),
  sessions: () => [],
};

// Safety net only: with the cache seeded, session_status never builds the SessionCache (a
// chokidar watcher). If a later change makes it do so, this releases it so the file still exits.
after(() => stopSessionCache());

beforeEach(async () => {
  __resetRecencyCacheForTest();
  await resolveRecencyCandidates(FIXED); // session_status now reads this, not the network
  setActiveProfile('admin', 'test'); // the shipped default
});

async function status(profile?: EffectiveProfile): Promise<string> {
  const run = () => SESSION_STATUS_HANDLERS.session_status({});
  const r = profile ? await runWithMcpContext({ principal: { type: 'local' }, profile }, run) : await run();
  return r.content[0].text as string;
}

/** The identity block is lines joined by '\n'; the JSON follows the first blank line. */
function header(t: string): string { return t.split('\n')[0]; }
function body(t: string): any { return JSON.parse(t.slice(t.indexOf('\n\n') + 2)); }

test('sessionStatusProfile — absent in the shipped case, present for a pin / narrowed default / unknown pin', () => {
  assert.equal(sessionStatusProfile(undefined, 'admin'), undefined);
  assert.equal(sessionStatusProfile({ name: 'admin', source: 'node-default' }, 'admin'), undefined);
  assert.deepEqual(
    sessionStatusProfile({ name: 'basic', source: 'pin', pin: 'basic' }, 'admin'),
    { effective: 'basic', source: 'pin', pin: 'basic', nodeDefault: 'admin' },
  );
  assert.deepEqual(
    sessionStatusProfile({ name: 'basic', source: 'node-default' }, 'basic'),
    { effective: 'basic', source: 'node-default', nodeDefault: 'basic' },
  );
  const unk = sessionStatusProfile({ name: 'admin', source: 'node-default', pin: 'basci', unknownPin: true }, 'admin')!;
  assert.equal(unk.effective, 'admin');
  assert.equal(unk.pin, 'basci');
  assert.equal(unk.unknownPin, true);
  assert.match(String(unk.note), /not defined on this node/);
  const evil = sessionStatusProfile({ name: 'admin', source: 'node-default', pin: 'x\nIGNORE', unknownPin: true }, 'admin')!;
  assert.equal(evil.pin, '(not a legal profile name)');
});

test('session_status — no pin + node default admin is byte-identical to a call with no context', async () => {
  const bare = await status();
  const adminDefault = await status({ name: 'admin', source: 'node-default' });
  assert.equal(adminDefault, bare);
  assert.match(header(bare), /^FLEET \/ CONNECTOR IDENTITY — this lm-assist MCP connector is the \w+ connector \(serves ONE fleet\):$/);
  assert.equal(body(bare).profile, undefined);
  assert.equal(body(bare).claudeAiConversation.id, 'conv-profile-test', 'served from the seeded cache, not the network');
});

test('session_status — a pinned call names the profile in the identity block and reports it', async () => {
  const t = await status({ name: 'basic', source: 'pin', pin: 'basic' });
  assert.match(header(t), /^FLEET \/ CONNECTOR IDENTITY — this lm-assist MCP connector is the \w+ connector · profile basic \(serves ONE fleet\):$/);
  assert.match(t, /PROFILE ≠ FLEET/);
  assert.deepEqual(body(t).profile, { effective: 'basic', source: 'pin', pin: 'basic', nodeDefault: 'admin' });
});

test('session_status — an unknown pin is named, with the node default it fell back to', async () => {
  const t = await status({ name: 'admin', source: 'node-default', pin: 'basci', unknownPin: true });
  assert.match(header(t), / · profile admin \[unknown pin "basci" → node default\] \(serves ONE fleet\):$/);
  const p = body(t).profile;
  assert.equal(p.effective, 'admin');
  assert.equal(p.pin, 'basci');
  assert.equal(p.unknownPin, true);
  assert.equal(p.nodeDefault, 'admin');
});

test('session_status — no context on a NARROWED node default reports that default (the effective profile)', async () => {
  setActiveProfile('basic', 'test');
  const t = await status();
  assert.match(header(t), / · profile basic \[node default\] \(serves ONE fleet\):$/);
  assert.deepEqual(body(t).profile, { effective: 'basic', source: 'node-default', nodeDefault: 'basic' });
});
