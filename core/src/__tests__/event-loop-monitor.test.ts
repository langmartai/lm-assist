import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLoopMonitor, timeSectionSync, getEventLoopMonitor } from '../diagnostics/event-loop-monitor';

/**
 * Event-loop lag instrumentation.
 *
 * WHY this exists: Core is single-threaded, and a synchronous block delays every
 * pending request while each handler still reports a near-zero durationMs. Measured
 * on prod 117 (300 samples against /health): client p99 5002.7ms, server durationMs
 * max 1ms. Per-handler timing is structurally blind to this; only loop lag sees it.
 *
 * These tests block the loop on purpose and assert the monitor notices.
 */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Burn the main thread synchronously — the exact thing the monitor must catch. */
function blockFor(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* deliberately blocking */ }
}

test('detects a synchronous block and surfaces it in the lag percentiles', async () => {
  const m = new EventLoopMonitor(20, 50);
  m.start();
  try {
    await sleep(60);
    blockFor(300);
    await sleep(150);

    const s = m.snapshot();
    assert.ok(s.longBlocks.count >= 1, `expected >=1 long block, got ${JSON.stringify(s.longBlocks)}`);
    assert.ok(s.longBlocks.maxMs >= 200, `expected maxMs>=200, got ${s.longBlocks.maxMs}`);
    // The histogram must independently corroborate the drift detector.
    assert.ok(s.lagMs.max >= 200, `expected lagMs.max>=200, got ${s.lagMs.max}`);
  } finally {
    m.stop();
  }
});

test('a quiet loop reports no long blocks', async () => {
  const m = new EventLoopMonitor(20, 50);
  m.start();
  try {
    await sleep(200);
    const s = m.snapshot();
    assert.equal(s.longBlocks.count, 0, `expected no blocks on an idle loop, got ${JSON.stringify(s.recentBlocks)}`);
  } finally {
    m.stop();
  }
});

test('attributes a long block to the section that caused it', async () => {
  const m = new EventLoopMonitor(20, 50);
  m.start();
  try {
    await sleep(60);
    const t0 = Date.now();
    blockFor(300);
    m.recordSection('processStatusStore.refresh', Date.now() - t0);
    await sleep(150);

    const s = m.snapshot();
    const attributed = s.recentBlocks.filter(b => b.label === 'processStatusStore.refresh');
    assert.ok(attributed.length >= 1, `expected an attributed block, got ${JSON.stringify(s.recentBlocks)}`);
    assert.equal(s.topBlockers[0]?.label, 'processStatusStore.refresh');
    assert.ok(s.topBlockers[0].longBlocks >= 1, 'section should be credited with the long block');
  } finally {
    m.stop();
  }
});

test('a block no section claims is reported as unattributed', async () => {
  const m = new EventLoopMonitor(20, 50);
  m.start();
  try {
    await sleep(60);
    blockFor(300);
    await sleep(150);

    const s = m.snapshot();
    assert.ok(
      s.recentBlocks.some(b => b.label === 'unattributed'),
      `expected an unattributed block, got ${JSON.stringify(s.recentBlocks)}`,
    );
  } finally {
    m.stop();
  }
});

test('does not blame a section that merely ran recently for a block it did not cause', async () => {
  const m = new EventLoopMonitor(20, 50);
  m.start();
  try {
    await sleep(60);
    // A cheap section, then an unrelated long block. Attribution requires the
    // section to account for most of the drift, so this must NOT be blamed.
    m.recordSection('cheap-thing', 2);
    blockFor(300);
    await sleep(150);

    const s = m.snapshot();
    assert.ok(
      !s.recentBlocks.some(b => b.label === 'cheap-thing'),
      `a 2ms section must not be blamed for a 300ms block: ${JSON.stringify(s.recentBlocks)}`,
    );
  } finally {
    m.stop();
  }
});

test('reset starts a clean measurement window', async () => {
  const m = new EventLoopMonitor(20, 50);
  m.start();
  try {
    await sleep(60);
    blockFor(200);
    await sleep(120);
    assert.ok(m.snapshot().longBlocks.count >= 1, 'precondition: a block was recorded');

    m.reset();
    const s = m.snapshot();
    assert.equal(s.longBlocks.count, 0);
    assert.equal(s.longBlocks.totalMs, 0);
    assert.equal(s.topBlockers.length, 0);
    assert.equal(s.recentBlocks.length, 0);
  } finally {
    m.stop();
  }
});

test('timeSectionSync records the section cost against the shared monitor', () => {
  const monitor = getEventLoopMonitor();
  monitor.reset();

  const out = timeSectionSync('unit-test-section', () => {
    blockFor(60);
    return 'result';
  });

  assert.equal(out, 'result', 'the wrapper must return the wrapped value through');
  const stat = monitor.snapshot().topBlockers.find(s => s.label === 'unit-test-section');
  assert.ok(stat, 'section should be recorded');
  assert.ok(stat.totalMs >= 50, `expected >=50ms recorded, got ${stat.totalMs}`);
  monitor.reset();
});

test('snapshot is well-formed before any traffic', () => {
  const m = new EventLoopMonitor();
  const s = m.snapshot();
  assert.equal(s.running, false);
  assert.equal(s.longBlocks.count, 0);
  assert.equal(typeof s.lagMs.p99, 'number');
  assert.ok(Array.isArray(s.recentBlocks));
});
