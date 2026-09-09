/**
 * ccr_restart native resume — the pure half. Guards the 2026-09 incident where
 * every restart spawned ccr-bridge.js and MINTED a new claude.ai session URL,
 * killing the operator's existing links (three sessions on 117).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nativeResumeCommand, bridgeWebUrl, bridgeKey, describeReclaim, waitForNativeBridge,
} from '../terminal/ccr-native-resume';

test('nativeResumeCommand: claude --resume <sid> --remote-control + recorded permission flags', () => {
  assert.equal(nativeResumeCommand('abc-123', ''), 'claude --resume abc-123 --remote-control');
  assert.equal(nativeResumeCommand('abc-123', ' --dangerously-skip-permissions'), 'claude --resume abc-123 --remote-control --dangerously-skip-permissions');
  // the id goes into a shell command line — anything but the uuid charset is refused
  assert.throws(() => nativeResumeCommand('x; rm -rf /', ''), /refusing/);
});

test('bridgeWebUrl / bridgeKey: session_ and cse_ spellings map to ONE claude.ai/code link', () => {
  assert.equal(bridgeWebUrl('session_01HYu7QUmitd8F6pTKv4yunJ'), 'https://claude.ai/code/session_01HYu7QUmitd8F6pTKv4yunJ');
  assert.equal(bridgeWebUrl('cse_01HYu7QUmitd8F6pTKv4yunJ'), 'https://claude.ai/code/session_01HYu7QUmitd8F6pTKv4yunJ');
  assert.equal(bridgeWebUrl(null), null);
  assert.equal(bridgeWebUrl('garbage'), null);
  assert.equal(bridgeKey('https://claude.ai/code/session_ABC'), 'ABC');
  assert.equal(bridgeKey('cse_ABC'), 'ABC');
});

test('describeReclaim: same bridge before/after = reclaimed; a different one is called out, never hidden', () => {
  assert.equal(describeReclaim('session_A', 'session_A'), 'reclaimed');
  assert.equal(describeReclaim('session_A', 'cse_A'), 'reclaimed');
  assert.equal(describeReclaim('session_A', 'session_B'), 'new-bridge');
  assert.equal(describeReclaim(null, 'session_B'), 'first-bridge');
  assert.equal(describeReclaim('session_A', null), 'none');
  assert.equal(describeReclaim(null, null), 'none');
});

test('waitForNativeBridge: returns once the resumed session records a bridge id', async () => {
  let t = 0;
  const seq: Array<{ pid: number | null; bridgeSessionId?: string | null } | null> = [null, { pid: 9 }, { pid: 9, bridgeSessionId: null }, { pid: 9, bridgeSessionId: 'session_Z' }];
  let i = 0;
  const r = await waitForNativeBridge('sid', {
    lookup: () => seq[Math.min(i++, seq.length - 1)],
    sleep: async (ms) => { t += ms; },
    now: () => t,
  }, { timeoutMs: 10_000, pollMs: 100 });
  assert.deepEqual(r, { pid: 9, bridgeSessionId: 'session_Z' });
});

test('waitForNativeBridge: live pid but no bridge by the deadline → reports the pid with a NULL bridge (never invents a URL)', async () => {
  let t = 0;
  const r = await waitForNativeBridge('sid', {
    lookup: () => ({ pid: 7, bridgeSessionId: null }),
    sleep: async (ms) => { t += ms; },
    now: () => t,
  }, { timeoutMs: 1000, pollMs: 250 });
  assert.deepEqual(r, { pid: 7, bridgeSessionId: null });
});

test('waitForNativeBridge: session never comes up → null', async () => {
  let t = 0;
  const r = await waitForNativeBridge('sid', {
    lookup: () => { throw new Error('registry unreadable'); },
    sleep: async (ms) => { t += ms; },
    now: () => t,
  }, { timeoutMs: 500, pollMs: 250 });
  assert.equal(r, null);
});
