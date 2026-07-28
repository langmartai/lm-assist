/**
 * The executor-reaper's pane-facts read — the call that SEGFAULTED the tmux
 * server on prod every hour at :28.
 *
 * `tmux display-message -p -t '=NAME' '#{session_created}'` crashes the tmux
 * server (tmux 3.2a; `dmesg`: "tmux: server[N]: segfault at 0"). `-t` on
 * display-message is a target-PANE, but `=` is a SESSION qualifier, so the
 * target resolves to NULL and a session-scoped format dereferences it. The
 * server dies and takes every Claude Code pane on the host with it — while the
 * reaper is in DRY-RUN and correctly reaps nothing.
 *
 * Reproduced on yitest 2026-07-28:
 *   -t lmx-t   '#{session_created}'  -> ok
 *   -t =lmx-t  '#{session_created}'  -> "server exited unexpectedly", SIGSEGV
 *   -t =lmx-t  '#{pane_current_path}'-> empty (a pane format on a NULL target)
 *
 * So these tests pin the ARGV, not just the parse: the argv is the bug.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { paneFactsArgv, parsePaneFacts } from '../../scheduler/executor-reaper';

const SEP = '\x1f';

// ── the crash guard ───────────────────────────────────────────────────────

test('NEVER issues `display-message` — the command that segfaults the server', () => {
  const argv = paneFactsArgv('lmx-abc');
  assert.ok(!argv.includes('display-message'), `argv still uses display-message: ${argv.join(' ')}`);
});

test('NEVER passes a `=`-prefixed target — the null-deref trigger', () => {
  const argv = paneFactsArgv('lmx-abc');
  const t = argv.indexOf('-t');
  if (t !== -1) {
    assert.ok(!argv[t + 1].startsWith('='), `-t ${argv[t + 1]} re-introduces the segfault`);
  }
  assert.ok(!argv.some((a) => a === '=lmx-abc'), 'a bare =NAME target is present');
});

test('reads session facts via list-sessions, which takes a SESSION target', () => {
  const argv = paneFactsArgv('lmx-abc');
  assert.equal(argv[0], 'list-sessions');
});

test('matches the session EXACTLY — `lmx-a` must not pick up `lmx-abc`', () => {
  const argv = paneFactsArgv('lmx-a');
  const f = argv.indexOf('-f');
  assert.ok(f !== -1, 'expected an -f filter for exact matching');
  assert.equal(argv[f + 1], '#{==:#{session_name},lmx-a}');
});

test('still asks for the three facts the sweep needs', () => {
  const argv = paneFactsArgv('lmx-abc');
  const fmt = argv[argv.indexOf('-F') + 1];
  assert.equal(fmt, `#{session_created}${SEP}#{session_activity}${SEP}#{pane_current_path}`);
});

// ── parsing ───────────────────────────────────────────────────────────────

test('parses a well-formed row into ms', () => {
  const f = parsePaneFacts(`1785211419${SEP}1785211500${SEP}/home/yi`);
  assert.deepEqual(f, { createdMs: 1785211419000, activityMs: 1785211500000, cwd: '/home/yi' });
});

test('empty output (session gone, or an old tmux rejecting -f) => null => KEPT, never reaped', () => {
  assert.equal(parsePaneFacts(''), null);
  assert.equal(parsePaneFacts('   \n '), null);
});

test('a row with no creation time => null (never fabricate an age)', () => {
  assert.equal(parsePaneFacts(`${SEP}${SEP}/home/yi`), null);
  assert.equal(parsePaneFacts(`0${SEP}0${SEP}/home/yi`), null);
});

test('missing activity falls back to creation, so idle is never negative-infinite', () => {
  const f = parsePaneFacts(`1785211419${SEP}${SEP}/home/yi`);
  assert.equal(f!.activityMs, 1785211419000);
});

test('a missing cwd is null, not the empty string', () => {
  const f = parsePaneFacts(`1785211419${SEP}1785211419${SEP}`);
  assert.equal(f!.cwd, null);
});

test('only the FIRST row is used even if the filter somehow matched more', () => {
  const f = parsePaneFacts(`1785211419${SEP}1785211419${SEP}/home/yi\n999${SEP}999${SEP}/other`);
  assert.equal(f!.createdMs, 1785211419000);
  assert.equal(f!.cwd, '/home/yi');
});
