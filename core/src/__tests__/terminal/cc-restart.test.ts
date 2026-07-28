/**
 * Restart-in-place decisions.
 *
 * The safety property under test: a resume must NEVER start while the previous
 * writer might still be alive. Two live `claude --resume` processes on one JSONL
 * corrupt it, which is exactly why a live session is `connectStrategy: refuse`
 * today. A restart is only safe because it removes the other writer first — so
 * "we asked it to die" is not good enough, and neither is "close() said ok".
 *
 * Pure; no processes touched.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { planCcRestart, safeToResume, type RestartFacts } from '../../terminal/cc-restart';

function facts(over: Partial<RestartFacts> = {}): RestartFacts {
  return { live: true, busy: false, force: false, hasTranscript: true, cwd: 'C:\\home\\lm-assist', ...over };
}

// ── the gate that matters ─────────────────────────────────────────────────

test('🔴 resume is BLOCKED while the old process is still alive', () => {
  const v = safeToResume(true);
  assert.equal(v.ok, false);
  assert.match(v.reason, /double-write|still alive/i);
});

test('🔴 UNKNOWN liveness is treated as alive — a transcript beats a fast restart', () => {
  const v = safeToResume(null);
  assert.equal(v.ok, false);
  assert.match(v.reason, /could not determine/i);
});

test('resume proceeds only on a CONFIRMED-dead old process', () => {
  const v = safeToResume(false);
  assert.equal(v.ok, true);
});

// ── the plan ──────────────────────────────────────────────────────────────

test('live + idle => restart', () => {
  assert.equal(planCcRestart(facts()).action, 'restart');
});

test('live + BUSY => refuse (would lose the in-flight turn)', () => {
  const d = planCcRestart(facts({ busy: true }));
  assert.equal(d.action, 'refuse');
  assert.match(d.reason, /mid-turn/i);
  assert.match(d.reason, /force/i, 'must tell the caller how to override');
});

test('live + busy + force => restart', () => {
  assert.equal(planCcRestart(facts({ busy: true, force: true })).action, 'restart');
});

test('NOT live => restart (a plain resume, nothing to kill)', () => {
  const d = planCcRestart(facts({ live: false }));
  assert.equal(d.action, 'restart');
  assert.match(d.reason, /not live/i);
});

test('no transcript => refuse — a restart would END the session, not resume it', () => {
  const d = planCcRestart(facts({ hasTranscript: false }));
  assert.equal(d.action, 'refuse');
  assert.match(d.reason, /transcript/i);
});

test('no transcript refuses even when force is set', () => {
  // force overrides the busy guard, never the nothing-to-resume-into guard.
  assert.equal(planCcRestart(facts({ hasTranscript: false, force: true })).action, 'refuse');
});

test('no cwd => refuse rather than relaunch in the wrong directory', () => {
  const d = planCcRestart(facts({ cwd: null }));
  assert.equal(d.action, 'refuse');
  assert.match(d.reason, /cwd/i);
});

test('every refusal explains itself', () => {
  for (const f of [facts({ busy: true }), facts({ hasTranscript: false }), facts({ cwd: null })]) {
    const d = planCcRestart(f);
    assert.equal(d.action, 'refuse');
    assert.ok(d.reason.length > 20, `unhelpful refusal: ${d.reason}`);
  }
});
