/**
 * The tools-revision stamp and the poller's notify decision.
 *
 * Context: the MCP server is a separate stdio process from Core, so a client's
 * tool list can go stale with nobody to tell it — measured 2026-07-28, when
 * newly-added tools were invisible to every connected session until reconnect,
 * and `refresh_connector_tools` could only clear claude.ai's cache for the NEXT
 * bootstrap.
 *
 * The edges below are the ones that turn a helpful notification into a nuisance:
 * a spurious fire on the first poll, or on recovery from a failed fetch.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { bumpToolsRev, currentToolsRev, toolsRevTransition } from '../mcp-server/registry/tools-rev';

// ── the stamp ──────────────────────────────────────────────────────────────

test('the stamp moves when the tool set is invalidated', () => {
  const before = currentToolsRev();
  bumpToolsRev();
  assert.notEqual(currentToolsRev(), before);
});

test('the stamp is stable when nothing changes — polling must not look like churn', () => {
  const a = currentToolsRev();
  assert.equal(currentToolsRev(), a);
  assert.equal(currentToolsRev(), a);
});

test('the stamp carries a boot id, so a Core restart is visible as a change', () => {
  assert.match(currentToolsRev(), /^[0-9a-f]{8}\.\d+$/);
});

// ── the notify decision ────────────────────────────────────────────────────

test('🔴 the FIRST observation is a baseline, never a notification', () => {
  // Otherwise every MCP process fires list_changed at startup, moments after the
  // client already fetched the list.
  const t = toolsRevTransition(null, 'abc12345.0');
  assert.equal(t.notify, false);
  assert.equal(t.nextSeen, 'abc12345.0');
});

test('an unchanged rev does not notify', () => {
  const t = toolsRevTransition('abc12345.3', 'abc12345.3');
  assert.equal(t.notify, false);
});

test('a changed rev notifies, and names both sides', () => {
  const t = toolsRevTransition('abc12345.3', 'abc12345.4');
  assert.equal(t.notify, true);
  assert.equal(t.nextSeen, 'abc12345.4');
  assert.match(t.reason, /abc12345\.3/);
  assert.match(t.reason, /abc12345\.4/);
});

test('a Core restart (new boot id) notifies', () => {
  const t = toolsRevTransition('aaaaaaaa.9', 'bbbbbbbb.0');
  assert.equal(t.notify, true);
});

test('🔴 a FAILED fetch keeps the baseline and does not notify', () => {
  // Dropping it would make the next successful poll look like a change and fire
  // a false notification on every transient blip.
  const t = toolsRevTransition('abc12345.3', null);
  assert.equal(t.notify, false);
  assert.equal(t.nextSeen, 'abc12345.3', 'the baseline must survive a failed poll');
});

test('a failed fetch before any baseline stays baseline-less', () => {
  const t = toolsRevTransition(null, null);
  assert.equal(t.notify, false);
  assert.equal(t.nextSeen, null);
});

test('recovery after a failed poll does not fire if nothing actually changed', () => {
  let seen: string | null = 'abc12345.3';
  seen = toolsRevTransition(seen, null).nextSeen;      // blip
  const t = toolsRevTransition(seen, 'abc12345.3');    // same value returns
  assert.equal(t.notify, false, 'a blip must not manufacture a change');
});

// ── sync-driven change detection ───────────────────────────────────────────
//
// Registry writes are ORIGIN-anchored: a write lands on the origin node and
// reaches every other node by SYNC. Replicas therefore have no local write to
// hook, so the rev must also move when the overlay CONTENT changes underneath
// them — otherwise a synced-in change never reaches their clients. (Measured on
// stage: a write proxied to the origin left 123's rev untouched.)

test('the digest is stable for equal overlays, regardless of key order', async () => {
  const { overlayDigest } = await import('../mcp-server/registry/overlay-live');
  const a = { byName: { alpha: { enabled: false }, beta: { enabled: true } } };
  const b = { byName: { beta: { enabled: true }, alpha: { enabled: false } } };
  assert.equal(overlayDigest(a as never), overlayDigest(b as never),
    'key order must never manufacture a change — that would notify on every poll');
});

test('the digest moves when a tool is disabled', async () => {
  const { overlayDigest } = await import('../mcp-server/registry/overlay-live');
  const before = { byName: { alpha: { enabled: true } } };
  const after = { byName: { alpha: { enabled: false } } };
  assert.notEqual(overlayDigest(before as never), overlayDigest(after as never));
});

test('the digest moves when a description override changes', async () => {
  const { overlayDigest } = await import('../mcp-server/registry/overlay-live');
  const before = { byName: { alpha: { descriptionOverride: null } } };
  const after = { byName: { alpha: { descriptionOverride: 'new text' } } };
  assert.notEqual(overlayDigest(before as never), overlayDigest(after as never));
});

test('a null overlay (store error) is a distinct, stable digest', async () => {
  const { overlayDigest } = await import('../mcp-server/registry/overlay-live');
  assert.equal(overlayDigest(null), overlayDigest(null));
  assert.notEqual(overlayDigest(null), overlayDigest({ byName: {} } as never));
});

test('🔴 the COMPOSED rev moves on a synced-in change, with no local write', async () => {
  // The counter alone cannot see this: an origin-anchored write reaches a replica
  // by sync, so nothing local bumps. The composed rev folds in a content digest.
  const { composedToolsRev } = await import('../routes/core/mcp-tools.routes');
  const { _replaceSharedLiveOverlayForTests, createLiveOverlayProvider } =
    await import('../mcp-server/registry/overlay-live');
  let docs: unknown[] = [{ name: 'alpha', enabled: true, rev: 1 }];
  const prev = createLiveOverlayProvider({ ttlMs: 0, list: async () => docs as never });
  _replaceSharedLiveOverlayForTests(prev);
  try {
    const before = await composedToolsRev();
    docs = [{ name: 'alpha', enabled: false, rev: 2 }];   // arrives via sync
    assert.notEqual(await composedToolsRev(), before, 'a replica must notice a synced change');
  } finally {
    _replaceSharedLiveOverlayForTests(createLiveOverlayProvider());
  }
});

test('the composed rev is stable when nothing changed — no churn from polling', async () => {
  const { composedToolsRev } = await import('../routes/core/mcp-tools.routes');
  const { _replaceSharedLiveOverlayForTests, createLiveOverlayProvider } =
    await import('../mcp-server/registry/overlay-live');
  const docs = [{ name: 'alpha', enabled: true, rev: 1 }];
  _replaceSharedLiveOverlayForTests(createLiveOverlayProvider({ ttlMs: 0, list: async () => docs as never }));
  try {
    const a = await composedToolsRev();
    assert.equal(await composedToolsRev(), a);
  } finally {
    _replaceSharedLiveOverlayForTests(createLiveOverlayProvider());
  }
});
