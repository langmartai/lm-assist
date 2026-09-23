/**
 * onNodeDefaultProfileChanged — the ONE hook both node-default write paths call (registry/
 * profile-report.ts's setNodeDefaultProfile, behind `mcp_profile set` and POST /mcp-tools/profile).
 * A node-default change re-shapes what the UNPINNED claude.ai connectors advertise, and claude.ai
 * caches tools/list, so the hook refreshes them: fire-and-forget, never throwing, and never —
 * under node --test — against the operator's live claude.ai account.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _setUnpinnedRefresherForTests, onNodeDefaultProfileChanged } from '../mcp-server/profile-connectors';

// With a hub base configured, the REAL refresh reaches fetch at once. The guard tests below
// therefore prove something; with no base it would return before any network call.
process.env.MCP_PUBLIC_BASE = 'https://mcp.langmart.ai';

const settle = () => new Promise((r) => setImmediate(r));

afterEach(() => { _setUnpinnedRefresherForTests(null); });

/** Record every loopback call instead of making it (each one fails, so the refresh defers). */
async function withFetchSpy(run: () => Promise<void>): Promise<string[]> {
  const realFetch = global.fetch;
  const paths: string[] = [];
  global.fetch = (async (url: string | URL | Request) => {
    paths.push(new URL(String(url)).pathname);
    throw new Error('stubbed: no network in unit tests');
  }) as typeof fetch;
  try {
    await run();
  } finally {
    global.fetch = realFetch;
  }
  return paths;
}

test('an installed refresher runs once, AFTER the call returns (the caller never waits on claude.ai)', async () => {
  let calls = 0;
  _setUnpinnedRefresherForTests(async () => { calls++; });
  onNodeDefaultProfileChanged('mcp_profile');
  assert.equal(calls, 0, 'nothing ran synchronously');
  await settle();
  assert.equal(calls, 1);
});

test('setBy is optional', async () => {
  let calls = 0;
  _setUnpinnedRefresherForTests(() => { calls++; });
  onNodeDefaultProfileChanged();
  await settle();
  assert.equal(calls, 1);
});

test('a refresher that throws or rejects never reaches the caller', async () => {
  _setUnpinnedRefresherForTests(() => { throw new Error('boom'); });
  assert.doesNotThrow(() => onNodeDefaultProfileChanged('test'));
  await settle();
  _setUnpinnedRefresherForTests(() => Promise.reject(new Error('claude.ai 500')));
  assert.doesNotThrow(() => onNodeDefaultProfileChanged('test'));
  await settle();
});

test('under node --test with no refresher installed, the REAL refresh never runs', async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'this suite must run under node --test');
  const paths = await withFetchSpy(async () => {
    onNodeDefaultProfileChanged('test');
    await settle();
    await settle();
  });
  assert.deepEqual(paths, [], "the operator's live claude.ai connectors are never touched");
});

test('…and that guard is what stops it: with NODE_TEST_CONTEXT cleared, the real refresh does run', async () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  let paths: string[] = [];
  try {
    delete process.env.NODE_TEST_CONTEXT;
    paths = await withFetchSpy(async () => {
      onNodeDefaultProfileChanged('test');
      await settle();
    });
  } finally {
    process.env.NODE_TEST_CONTEXT = saved;
  }
  assert.deepEqual(paths, ['/claude-ai/mcp/servers'], 'it lists the connectors (and, with the fetch failing, defers)');
});
