/**
 * ccr_restart safety-gate tests — the corruption contract:
 *   - a BUSY session is refused without force (nothing destructive runs),
 *   - the owner kill must VERIFY dead, and an INDEPENDENT re-verdict must agree,
 *     else ABORT (never resume over a live process),
 *   - resume happens ONLY after the session is verified ownerless.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restartLocal, type RestartDeps } from '../../terminal/ccr-restart';

const NOW = 100 * 60_000;

function mkDeps(overrides: Partial<RestartDeps> & {
  verdicts?: Array<{ live: boolean; connectStrategy: string; pid: number | null; tmuxSession: string | null; updatedAt: string | undefined }>;
} = {}) {
  const calls: string[] = [];
  const verdicts = overrides.verdicts ?? [
    { live: true, connectStrategy: 'attach-existing', pid: 4242, tmuxSession: 'claude-abc', updatedAt: new Date(NOW - 60 * 60_000).toISOString() }, // idle 1h
    { live: false, connectStrategy: 'create-tmux', pid: null, tmuxSession: null, updatedAt: undefined }, // post-kill re-verdict: dead
  ];
  let vi = 0;
  const deps: RestartDeps = {
    now: () => NOW,
    verdict: () => { calls.push('verdict'); return verdicts[Math.min(vi++, verdicts.length - 1)]; },
    stopExistingRemotes: async () => { calls.push('stopRemotes'); return 1; },
    killOwner: async () => { calls.push('kill'); return { killed: true, wasAlive: true, method: 'sigterm' }; },
    killStaleCcrTmux: async () => { calls.push('killStaleTmux'); },
    resume: async () => { calls.push('resume'); return { webUrl: 'https://claude.ai/code/x' }; },
    ...overrides,
  };
  return { deps, calls };
}

test('idle live session: stop-remotes → kill → re-verify → resume, in that order', async () => {
  const { deps, calls } = mkDeps();
  const r = await restartLocal('sid-1', {}, deps);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'restarted');
  assert.equal(r.oldPid, 4242);
  assert.deepEqual(calls, ['verdict', 'stopRemotes', 'kill', 'verdict', 'killStaleTmux', 'resume'],
    'destructive order must be: verdict, stop remotes, kill, INDEPENDENT re-verdict, stale-tmux clear, resume');
});

test('BUSY session without force and waiting disabled → needs-force and NOTHING destructive runs', async () => {
  const { deps, calls } = mkDeps({
    verdicts: [{ live: true, connectStrategy: 'attach-existing', pid: 4242, tmuxSession: 't', updatedAt: new Date(NOW - 10_000).toISOString() }], // active 10s ago
  });
  const r = await restartLocal('sid-1', { waitMs: 0 }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'needs-force');
  assert.deepEqual(calls, ['verdict'], 'no stop/kill/resume on a busy session without force');
});

test('BUSY is refused IMMEDIATELY by default — no wait, nothing destructive (the 120s default outlived the connector timeout)', async () => {
  let slept = 0;
  const { deps, calls } = mkDeps({
    verdicts: [{ live: true, connectStrategy: 'attach-existing', pid: 4242, tmuxSession: 't', updatedAt: new Date(NOW - 10_000).toISOString() }],
  });
  deps.phase = () => 'busy';
  deps.sleep = async () => { slept++; };
  const r = await restartLocal('sid-1', {}, deps); // NO waitMs → default
  assert.equal(r.ok, false);
  assert.equal(r.state, 'needs-force');
  assert.equal(r.busy, true, 'the refusal says WHY: it read as busy');
  assert.equal(slept, 0, 'the default must not wait for an in-flight turn');
  assert.ok(!calls.includes('kill') && !calls.includes('resume'));
});

test('BUSY session WITH force → killed and resumed', async () => {
  const { deps, calls } = mkDeps({
    verdicts: [
      { live: true, connectStrategy: 'attach-existing', pid: 4242, tmuxSession: 't', updatedAt: new Date(NOW - 10_000).toISOString() },
      { live: false, connectStrategy: 'create-tmux', pid: null, tmuxSession: null, updatedAt: undefined },
    ],
  });
  const r = await restartLocal('sid-1', { force: true }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'restarted');
  assert.ok(calls.includes('kill') && calls.includes('resume'));
});

test('kill does not verify dead → kill-failed, resume NEVER called', async () => {
  const { deps, calls } = mkDeps({
    killOwner: async () => ({ killed: false, wasAlive: true, method: 'sigkill' }),
  });
  const r = await restartLocal('sid-1', {}, deps);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'kill-failed');
  assert.ok(!calls.includes('resume'), 'must NOT resume over a live process');
});

test('kill ok but INDEPENDENT re-verdict still reports live → kill-failed, resume NEVER called', async () => {
  const { deps, calls } = mkDeps({
    verdicts: [
      { live: true, connectStrategy: 'attach-existing', pid: 4242, tmuxSession: 't', updatedAt: new Date(NOW - 60 * 60_000).toISOString() },
      { live: true, connectStrategy: 'attach-existing', pid: 9999, tmuxSession: 't2', updatedAt: undefined }, // ANOTHER owner appeared
    ],
  });
  const r = await restartLocal('sid-1', {}, deps);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'kill-failed');
  assert.match(r.reason, /ABORTING/);
  assert.ok(!calls.includes('resume'), 'second owner detected — must abort, not resume');
});

test('dead session: straight to resume, no kill', async () => {
  const { deps, calls } = mkDeps({
    verdicts: [{ live: false, connectStrategy: 'create-tmux', pid: null, tmuxSession: null, updatedAt: undefined }],
  });
  const r = await restartLocal('sid-1', {}, deps);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'restarted');
  assert.ok(!calls.includes('kill'), 'nothing to kill for a dead session');
  assert.ok(calls.includes('resume'));
});

test('no transcript and no live process → gone', async () => {
  const { deps } = mkDeps({
    verdicts: [{ live: false, connectStrategy: 'none', pid: null, tmuxSession: null, updatedAt: undefined }],
  });
  const r = await restartLocal('sid-1', {}, deps);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'gone');
});

test('resume failure after a successful kill → state error with a clear reason (old process IS dead)', async () => {
  const { deps } = mkDeps({ resume: async () => { throw new Error('tmux spawn failed'); } });
  const r = await restartLocal('sid-1', {}, deps);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'error');
  assert.match(r.reason, /resume failed: tmux spawn failed/);
});

// ── wait-for-idle: a busy session is WAITED for, not just refused ─────────────

test('busy phase + wait: polls until the turn finishes, then kills and resumes (waitedMs reported)', async () => {
  let clock = NOW;
  let phaseCalls = 0;
  const { deps, calls } = mkDeps({
    verdicts: [
      { live: true, connectStrategy: 'attach-existing', pid: 4242, tmuxSession: 't', updatedAt: new Date(NOW - 5_000).toISOString() },
      { live: true, connectStrategy: 'attach-existing', pid: 4242, tmuxSession: 't', updatedAt: undefined }, // post-wait refresh
      { live: false, connectStrategy: 'create-tmux', pid: null, tmuxSession: null, updatedAt: undefined },   // post-kill re-verdict
    ],
  });
  deps.now = () => clock;
  deps.phase = () => { phaseCalls++; return phaseCalls <= 3 ? 'busy' : 'idle'; }; // 3 busy polls, then idle
  deps.sleep = async (ms) => { clock += ms; };
  const r = await restartLocal('sid-1', { waitMs: 60_000 }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'restarted');
  assert.ok((r.waitedMs ?? 0) > 0, 'waitedMs must be reported');
  assert.ok(calls.includes('kill') && calls.includes('resume'));
});

test('busy phase + wait TIMEOUT: needs-force, nothing destructive, waitedMs reported', async () => {
  let clock = NOW;
  const { deps, calls } = mkDeps({
    verdicts: [{ live: true, connectStrategy: 'attach-existing', pid: 4242, tmuxSession: 't', updatedAt: new Date(NOW - 5_000).toISOString() }],
  });
  deps.now = () => clock;
  deps.phase = () => 'busy'; // never finishes
  deps.sleep = async (ms) => { clock += ms; };
  const r = await restartLocal('sid-1', { waitMs: 10_000 }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'needs-force');
  assert.ok((r.waitedMs ?? 0) >= 10_000);
  assert.match(r.reason, /still read as busy after the full wait window/);
  assert.ok(!calls.includes('kill') && !calls.includes('resume'), 'timeout must be non-destructive');
});

test('IDLE AT PROMPT restarts immediately without force — even with a recent transcript (fixes the false-busy)', async () => {
  const { deps, calls } = mkDeps({
    verdicts: [
      { live: true, connectStrategy: 'attach-existing', pid: 4242, tmuxSession: 't', updatedAt: new Date(NOW - 5_000).toISOString() }, // active 5s ago
      { live: false, connectStrategy: 'create-tmux', pid: null, tmuxSession: null, updatedAt: undefined },
    ],
  });
  deps.phase = () => 'idle'; // but the TUI is at its prompt
  const r = await restartLocal('sid-1', {}, deps);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'restarted');
  assert.equal(r.waitedMs, 0, 'no waiting needed for an idle prompt');
  assert.ok(calls.includes('kill') && calls.includes('resume'));
});

test('force skips waiting entirely (no sleep, immediate kill)', async () => {
  let slept = 0;
  const { deps, calls } = mkDeps({
    verdicts: [
      { live: true, connectStrategy: 'attach-existing', pid: 4242, tmuxSession: 't', updatedAt: new Date(NOW - 5_000).toISOString() },
      { live: false, connectStrategy: 'create-tmux', pid: null, tmuxSession: null, updatedAt: undefined },
    ],
  });
  deps.phase = () => 'busy';
  deps.sleep = async () => { slept++; };
  const r = await restartLocal('sid-1', { force: true }, deps);
  assert.equal(r.ok, true);
  assert.equal(slept, 0, 'force must not wait');
  assert.ok(calls.includes('kill'));
});

test('phase unknown + waitMs:0 falls back to the transcript-age gate (old behavior preserved)', async () => {
  const { deps, calls } = mkDeps({
    verdicts: [{ live: true, connectStrategy: 'attach-existing', pid: 4242, tmuxSession: null, updatedAt: new Date(NOW - 5_000).toISOString() }],
  });
  deps.phase = () => 'unknown';
  const r = await restartLocal('sid-1', { waitMs: 0 }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'needs-force');
  assert.ok(!calls.includes('kill'));
});

// ── return the SCREEN, don't classify it (prod incident 117, 2026-08-15) ─────
//
// The tool used to report state:'restarted', ok:true for a session that came back
// parked on a blocking modal, and to classify a FROZEN modal as actively-busy —
// then sit in a 120s wait until the MCP connector timed out first. Both are fixed
// by handing the caller the pane and letting it judge.

const MODAL = [
  'Resume from summary (recommended)',
  '❯ 1. Yes, switch to opus',
  '  2. No, go back',
  'Enter to confirm · Esc to cancel',
].join('\n');

test('a busy refusal carries the SCREEN, the pane name, and busy:true — one round trip, nothing killed', async () => {
  const { deps, calls } = mkDeps({
    verdicts: [{ live: true, connectStrategy: 'attach-existing', pid: 4242, tmuxSession: 'claude-abc', updatedAt: new Date(NOW - 10_000).toISOString() }],
  });
  deps.phase = () => 'busy';
  deps.sleep = async () => { /* screen poll */ };
  deps.captureScreen = (_sid, hint) => ({ tmuxSession: hint || 'claude-abc', screen: MODAL });
  const r = await restartLocal('sid-1', {}, deps);
  assert.equal(r.state, 'needs-force');
  assert.equal(r.busy, true);
  assert.equal(r.screen, MODAL, 'the caller gets the bytes terminal_capture would give');
  assert.equal(r.screenSource, 'pre-restart');
  assert.equal(r.screenStable, true, 'two identical captures ⇒ frozen, not working');
  assert.equal(r.tmuxSession, 'claude-abc', 'so terminal_send can act on it with no extra lookup');
  assert.ok(!calls.includes('kill') && !calls.includes('resume'), 'a refusal stays non-destructive');
});

test('a successful restart carries the POST-restart screen, read from the FRESH pane', async () => {
  const seen: Array<string | null | undefined> = [];
  const { deps } = mkDeps({
    resume: async () => ({ webUrl: 'https://claude.ai/code/x', tmuxSession: 'ccr-sid-1' }),
  });
  deps.sleep = async () => { /* screen poll */ };
  deps.captureScreen = (_sid, hint) => { seen.push(hint); return { tmuxSession: hint || 'stale-tmux', screen: MODAL }; };
  const r = await restartLocal('sid-1', {}, deps);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'restarted');
  assert.equal(r.screen, MODAL, '"restarted" is not "usable" — the pane says which');
  assert.equal(r.screenSource, 'post-restart');
  assert.equal(r.tmuxSession, 'ccr-sid-1');
  assert.ok(seen.every((h) => h === 'ccr-sid-1'), 'the fresh resume record\'s pane is the hint, not the dead one');
  assert.match(r.reason, /RE-OPENS modals/i, 'the reason tells the caller to expect a dialog chain');
});

test('an unstable pane reports screenStable:false — still repainting is itself evidence', async () => {
  let n = 0;
  const { deps } = mkDeps();
  deps.phase = () => 'busy';
  deps.sleep = async () => { /* screen poll */ };
  deps.captureScreen = () => ({ tmuxSession: 't', screen: `✽ Infusing… (${n++}s · ↓ 650 tokens)` });
  const r = await restartLocal('sid-1', {}, deps);
  assert.equal(r.state, 'needs-force');
  assert.equal(r.screenStable, false, 'never matched twice — the TUI is actually painting');
  assert.match(r.screen ?? '', /Infusing/);
});

test('no readable pane → NO screen field and the restart still completes (an unreadable screen never fails a restart)', async () => {
  const { deps } = mkDeps();
  deps.sleep = async () => { /* screen poll */ };
  deps.captureScreen = () => null;
  const r = await restartLocal('sid-1', {}, deps);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'restarted');
  assert.equal(r.screen, undefined, 'absent, not empty-string — we never guess a screen');
  assert.equal(r.screenSource, undefined);
});

test('a throwing capture never fails the restart', async () => {
  const { deps } = mkDeps();
  deps.sleep = async () => { /* screen poll */ };
  deps.captureScreen = () => { throw new Error('tmux session not found'); };
  const r = await restartLocal('sid-1', {}, deps);
  assert.equal(r.ok, true);
  assert.equal(r.screen, undefined);
});

test('an oversized pane is TAIL-bounded and says so (modals render at the bottom)', async () => {
  const { deps } = mkDeps();
  const big = Array.from({ length: 4000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n') + '\n❯ 1. Yes';
  deps.sleep = async () => { /* screen poll */ };
  deps.captureScreen = () => ({ tmuxSession: 't', screen: big });
  const r = await restartLocal('sid-1', {}, deps);
  assert.equal(r.screenTruncated, true);
  assert.ok(Buffer.byteLength(r.screen ?? '', 'utf8') <= 8192, 'bounded to the 8KB budget');
  assert.match(r.screen ?? '', /❯ 1\. Yes$/, 'the TAIL is kept — that is where the modal is');
});

test('kill-failed carries the screen of the process that would not die', async () => {
  const { deps } = mkDeps({
    killOwner: async () => ({ killed: false, wasAlive: true, method: 'sigkill' }),
  });
  deps.sleep = async () => { /* screen poll */ };
  deps.captureScreen = () => ({ tmuxSession: 'claude-abc', screen: MODAL });
  const r = await restartLocal('sid-1', {}, deps);
  assert.equal(r.state, 'kill-failed');
  assert.equal(r.screen, MODAL);
  assert.equal(r.screenSource, 'pre-restart');
});

test('a wait TIMEOUT carries the screen too — before you retry with a longer wait, look at the pane', async () => {
  let clock = NOW;
  const { deps, calls } = mkDeps({
    verdicts: [{ live: true, connectStrategy: 'attach-existing', pid: 4242, tmuxSession: 't', updatedAt: new Date(NOW - 5_000).toISOString() }],
  });
  deps.now = () => clock;
  deps.phase = () => 'busy';
  deps.sleep = async (ms) => { clock += ms; };
  deps.captureScreen = () => ({ tmuxSession: 't', screen: MODAL });
  const r = await restartLocal('sid-1', { waitMs: 10_000 }, deps);
  assert.equal(r.state, 'needs-force');
  assert.equal(r.busy, true);
  assert.equal(r.screen, MODAL);
  assert.equal(r.screenStable, true, 'frozen for the whole wait window');
  assert.ok(!calls.includes('kill') && !calls.includes('resume'));
});

// ── resume-fidelity: permission-mode restoration (found live 2026-07-22) ──────
import { resumePermissionFlags } from '../../terminal/ccr-manager';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

test('resumePermissionFlags maps the LAST recorded mode to the right claude flags', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpf-'));
  const j = (lines: string[]) => { const p = path.join(tmp, `${Math.random().toString(36).slice(2)}.jsonl`); fs.writeFileSync(p, lines.join('\n')); return p; };
  assert.equal(resumePermissionFlags(j(['{"permissionMode":"bypassPermissions"}'])), ' --dangerously-skip-permissions');
  assert.equal(resumePermissionFlags(j(['{"permissionMode":"acceptEdits"}'])), ' --permission-mode acceptEdits');
  assert.equal(resumePermissionFlags(j(['{"permissionMode":"default"}'])), '', 'default mode adds no flag');
  assert.equal(resumePermissionFlags(j(['{"x":1}'])), '', 'no recorded mode adds no flag');
  // LAST occurrence wins (the session's current operating mode)
  assert.equal(resumePermissionFlags(j(['{"permissionMode":"bypassPermissions"}', '{"permissionMode":"dontAsk"}'])), ' --permission-mode dontAsk');
  assert.equal(resumePermissionFlags('/nonexistent/x.jsonl'), '', 'unreadable jsonl adds no flag');
  // SECURITY (allowlist): an unknown/tampered mode — even purely alphabetic — restores NOTHING
  assert.equal(resumePermissionFlags(j(['{"permissionMode":"sneakyEvilMode"}'])), '', 'unknown mode is NOT passed to the CLI');
  assert.equal(resumePermissionFlags(j(['{"permissionMode":"bypassPermissionsX"}'])), '', 'near-miss of the bypass name restores nothing');
});
