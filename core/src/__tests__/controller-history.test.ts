import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  recordControllerEvent, readControllerHistory, pickResumeCandidates, latestResumableController,
  type ControllerHistoryEntry,
} from '../mission/controller-history';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-hist-'));

test('append + read round-trips and tolerates junk lines', () => {
  const dir = tmp();
  recordControllerEvent(dir, { at: 1, event: 'launched', sessionId: 'a', tmux: 'lmcc-1', node: 'gw1' });
  recordControllerEvent(dir, { at: 2, event: 'teardown', sessionId: 'a', reason: 'x' });
  fs.appendFileSync(path.join(dir, 'controller-history.jsonl'), 'not-json\n');
  recordControllerEvent(dir, { at: 3, event: 'resumed', sessionId: 'a' });
  const h = readControllerHistory(dir);
  assert.deepEqual(h.map((e) => e.event), ['launched', 'teardown', 'resumed']);
});

test('the file stays bounded (trims once past the cap)', () => {
  const dir = tmp();
  for (let i = 0; i < 520; i++) recordControllerEvent(dir, { at: i, event: 'launched', sessionId: `s${i}` });
  const lines = fs.readFileSync(path.join(dir, 'controller-history.jsonl'), 'utf-8').split('\n').filter(Boolean);
  // 520 appends: trim fires at 501 (→250), then 19 more append ⇒ 269. Assert bounded, not exact.
  assert.ok(lines.length <= 300, `expected trimmed file, got ${lines.length} lines`);
  assert.ok(lines.length < 520, 'file must not retain every append');
});

test('pickResumeCandidates: newest-in-charge first, deduped, teardown does not disqualify', () => {
  const h: ControllerHistoryEntry[] = [
    { at: 1, event: 'launched', sessionId: 'old' },
    { at: 2, event: 'teardown', sessionId: 'old' },      // teardown ≠ unusable — that's THE resume case
    { at: 3, event: 'launched', sessionId: 'new' },
    { at: 4, event: 'adopted', sessionId: 'old' },        // re-adopted later → old is newest-in-charge
  ];
  assert.deepEqual(pickResumeCandidates(h), ['old', 'new']);
});

test('pickResumeCandidates: a resume-failed AFTER the last in-charge event disqualifies', () => {
  const h: ControllerHistoryEntry[] = [
    { at: 1, event: 'launched', sessionId: 'a' },
    { at: 2, event: 'resume-failed', sessionId: 'a' },
    { at: 3, event: 'launched', sessionId: 'b' },
  ];
  assert.deepEqual(pickResumeCandidates(h), ['b']);
  // …but a later successful in-charge event re-qualifies it
  const h2 = [...h, { at: 4, event: 'adopted', sessionId: 'a' } as ControllerHistoryEntry];
  assert.deepEqual(pickResumeCandidates(h2), ['a', 'b']);
});

test('latestResumableController: verdict gates — dead+transcript+safe wins; live or missing falls through', () => {
  const dir = tmp();
  recordControllerEvent(dir, { at: 1, event: 'launched', sessionId: 'gone' });
  recordControllerEvent(dir, { at: 2, event: 'launched', sessionId: 'live-one' });
  recordControllerEvent(dir, { at: 3, event: 'launched', sessionId: 'best' });
  const verdicts: Record<string, { jsonl?: string | null; live: boolean; safeToCreateTmux: boolean }> = {
    best: { jsonl: null, live: false, safeToCreateTmux: true },        // transcript missing → skip
    'live-one': { jsonl: '/x.jsonl', live: true, safeToCreateTmux: false }, // already running → skip
    gone: { jsonl: '/y.jsonl', live: false, safeToCreateTmux: true },  // resumable ✓
  };
  assert.equal(latestResumableController(dir, (sid) => verdicts[sid]), 'gone');
  assert.equal(latestResumableController(tmp(), () => { throw new Error('no verdict'); }), null);
});
