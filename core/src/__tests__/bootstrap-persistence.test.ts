/**
 * Durable bootstrap markers — the per-session BOOTSTRAP flag must survive a Core
 * restart (bl_5169a15c).
 *
 * Symptom: the resolver's REGISTRY was module-level memory only, so after every
 * Core restart the first playbook-governed call from a long-lived session (e.g.
 * the Mission Controller) was refused with BOOTSTRAP_REQUIRED and had to re-pull
 * the ~55KB bootstrap. These tests drive the registry through its exported seams
 * only — no live resolver, no network — because the live gate seam resolves the
 * caller for real (the hang class bootstrap-gate.test.ts documents).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The marker file path is computed lazily from getDataDir() on every access, so
// assigning LM_ASSIST_DATA_DIR here (after import, before any registry access)
// is honored — same pattern as memory-sync-routes.test.ts.
import {
  recordBootstrapped,
  evaluateBootstrapGate,
  __registryLookupForTest,
  __resetBootstrapRegistryForTest,
  type CallerCandidates,
} from '../mcp-server/mcp-session-resolver';
import {
  bootstrapMarkerFile,
  pruneMarkers,
  loadPersistedMarkers,
  MAX_PERSISTED_MARKERS,
  MAX_MARKER_AGE_MS,
  __flushPersistForTest,
  __resetPersistForTest,
  type PersistedMarker,
} from '../mcp-server/bootstrap-persist';
import { playbookTopicForTool } from '../mcp-server/tool-topics';

const TOPIC = playbookTopicForTool('mission_list');
const caller = (id: string): CallerCandidates => ({ claudeAi: { id }, resolvedAt: Date.now() });
const gateFor = (id: string) => evaluateBootstrapGate('mission_list', TOPIC, caller(id), __registryLookupForTest);

beforeEach(() => {
  process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-'));
  __resetPersistForTest();
  __resetBootstrapRegistryForTest();
});

test('bootstrapped marker survives a simulated Core restart', async () => {
  // Never bootstrapped → the gate blocks (today's behavior, pre-restart).
  assert.equal(gateFor('conv-A').reason, 'first-offence');
  recordBootstrapped(caller('conv-A'));
  assert.equal(gateFor('conv-A').reason, 'bootstrapped');
  await __flushPersistForTest();
  // Simulated restart: fresh module state, reload from disk on next access.
  __resetBootstrapRegistryForTest();
  const v = gateFor('conv-A');
  assert.equal(v.block, false, 'a bootstrapped session must NOT be re-refused after a Core restart');
  assert.equal(v.reason, 'bootstrapped');
});

test('recording is write-behind — no file appears synchronously on the call path', () => {
  recordBootstrapped(caller('conv-B'));
  assert.equal(fs.existsSync(bootstrapMarkerFile()), false, 'the write must be debounced, not per-call');
});

test('the file on disk is bounded even when more sessions bootstrap than the cap', async () => {
  for (let i = 0; i < MAX_PERSISTED_MARKERS + 20; i++) recordBootstrapped(caller(`sess-${i}`));
  await __flushPersistForTest();
  const onDisk = JSON.parse(fs.readFileSync(bootstrapMarkerFile(), 'utf-8')) as Record<string, unknown>;
  assert.ok(
    Object.keys(onDisk).length <= MAX_PERSISTED_MARKERS,
    `wrote ${Object.keys(onDisk).length} entries — the file must stay bounded at ${MAX_PERSISTED_MARKERS}`,
  );
});

test('pruneMarkers drops entries beyond the age cap', () => {
  const now = Date.now();
  const m: Record<string, PersistedMarker> = {
    fresh: { bootstrappedAt: now - 1000, lastSeen: now - 1000 },
    stale: { bootstrappedAt: now - MAX_MARKER_AGE_MS - 1, lastSeen: now - MAX_MARKER_AGE_MS - 1 },
  };
  assert.deepEqual(Object.keys(pruneMarkers(m, now)), ['fresh']);
});

test('pruneMarkers caps the count, keeping the most recent', () => {
  const now = Date.now();
  const m: Record<string, PersistedMarker> = {};
  for (let i = 0; i < MAX_PERSISTED_MARKERS + 50; i++) m[`s${i}`] = { bootstrappedAt: now - i, lastSeen: now - i };
  const out = pruneMarkers(m, now);
  assert.equal(Object.keys(out).length, MAX_PERSISTED_MARKERS);
  assert.ok(out['s0'], 'the newest entry must survive the cap');
  assert.equal(out[`s${MAX_PERSISTED_MARKERS + 49}`], undefined, 'the oldest entry must be dropped');
});

test('a corrupt marker file fails open exactly like today — gate soft-refuses once, no throw', () => {
  fs.mkdirSync(path.dirname(bootstrapMarkerFile()), { recursive: true });
  fs.writeFileSync(bootstrapMarkerFile(), '{not json');
  __resetBootstrapRegistryForTest();
  const v = gateFor('conv-C');
  assert.equal(v.block, true);
  assert.equal(v.reason, 'first-offence');
});

test('a missing file loads as empty (fresh install)', () => {
  assert.equal(loadPersistedMarkers().size, 0);
});

test('malformed entries inside a valid JSON file are skipped, valid ones kept', () => {
  const now = Date.now();
  fs.mkdirSync(path.dirname(bootstrapMarkerFile()), { recursive: true });
  fs.writeFileSync(
    bootstrapMarkerFile(),
    JSON.stringify({ good: { bootstrappedAt: now, lastSeen: now }, bad: { bootstrappedAt: 'x' }, worse: 42 }),
  );
  assert.deepEqual([...loadPersistedMarkers().keys()], ['good']);
});

test('a persisted marker past the age cap is pruned at load — the session simply re-bootstraps', async () => {
  const old = Date.now() - MAX_MARKER_AGE_MS - 60_000;
  fs.mkdirSync(path.dirname(bootstrapMarkerFile()), { recursive: true });
  fs.writeFileSync(bootstrapMarkerFile(), JSON.stringify({ 'conv-old': { bootstrappedAt: old, lastSeen: old } }));
  __resetBootstrapRegistryForTest();
  assert.equal(gateFor('conv-old').reason, 'first-offence');
});
