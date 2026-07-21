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
  assert.match(r.reason, /stayed busy/);
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
