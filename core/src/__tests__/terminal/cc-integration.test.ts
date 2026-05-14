/**
 * End-to-end integration tests for the terminal API + CC adapter.
 *
 * Requires:
 *   - lm-assist serving on TEST_API (default http://localhost:3201)
 *   - tmux installed
 *   - `claude` binary at ~/.local/bin/claude (the path getClaudeBinaryPath
 *     returns) — real CC, will make real API calls
 *
 * Each test uses a unique tmux session name and cleans up in `afterEach`.
 * Tests that exercise real CC are marked SLOW and gated by env
 * RUN_LIVE_CC=1 to avoid burning API credits in CI.
 *
 * Run:
 *   PATH=$NODE20_BIN:$PATH npx tsc
 *   PATH=$NODE20_BIN:$PATH node --test dist/__tests__/terminal/cc-integration.test.js
 *
 *   # with live CC tests:
 *   RUN_LIVE_CC=1 node --test dist/__tests__/terminal/cc-integration.test.js
 */

import { test, before, after, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';

const API = process.env.TEST_API ?? 'http://localhost:3201';
const LIVE_CC = process.env.RUN_LIVE_CC === '1';

// ---------- helpers ------------------------------------------------------

interface ApiResult<T = unknown> { success: boolean; data?: T; error?: { code: string; message: string; details?: unknown } }

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', 'x-lm-caller': 'integration-test' } : { 'x-lm-caller': 'integration-test' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return await res.json() as ApiResult<T>;
}

function uniqName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

// Sessions we've created so cleanup can kill leaks even on test failure.
const tracked = new Set<string>();
function track(s: string): string { tracked.add(s); return s; }

function tmuxCli(args: string[]): void {
  // execFileSync — no shell, args passed as argv — safe even if `args`
  // contained metacharacters (which our `uniqName` output never does).
  try { execFileSync('tmux', args, { stdio: 'ignore', timeout: 5000 }); } catch { /* ignore */ }
}

async function killSession(name: string): Promise<void> {
  try { await call('DELETE', `/terminal/tmux/${encodeURIComponent(name)}`); } catch { /* ignore */ }
  tmuxCli(['kill-session', '-t', name]);
  tracked.delete(name);
}

/** Read the pane PID of a tmux session — that's the program tmux spawned. */
function tmuxPanePid(session: string): number | null {
  try {
    const out = execFileSync('tmux', ['display-message', '-p', '-t', session, '#{pane_pid}'], { encoding: 'utf-8', timeout: 5000 });
    const pid = parseInt(out.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

/** Get all PIDs in the process tree rooted at `pid` (including descendants). */
function descendantPids(pid: number): number[] {
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf-8', timeout: 5000 });
    const direct = out.trim().split('\n').filter(Boolean).map((s) => parseInt(s, 10)).filter(Number.isFinite);
    return [pid, ...direct.flatMap(descendantPids)];
  } catch { return [pid]; }
}

function processAlive(pid: number): boolean {
  try { execFileSync('kill', ['-0', String(pid)], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- lifecycle ----------------------------------------------------

before(async () => {
  const h = await call<{ status: string; version: string }>('GET', '/health');
  assert.equal(h.success, true, 'API not healthy');
  const t = await call<{ sessions: unknown[] }>('GET', '/terminal/tmux');
  assert.equal(t.success, true, '/terminal/tmux not available');
});

afterEach(async () => {
  for (const s of Array.from(tracked)) await killSession(s);
});

after(async () => {
  for (const s of Array.from(tracked)) await killSession(s);
});

// ===========================================================================
// SECTION A — pure tmux primitives (no CC)
// ===========================================================================

test('A1 — create, send-keys, capture, kill round-trip', async () => {
  const name = track(uniqName('a1'));
  const create = await call<{ name: string; existed: boolean }>('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  assert.equal(create.success, true);
  assert.equal(create.data?.existed, false);

  const send = await call('POST', `/terminal/tmux/${name}/send-keys`, { keys: 'echo HELLO_A1_42', enter: true });
  assert.equal(send.success, true);

  await sleep(400);
  const cap = await call<{ screen: string }>('GET', `/terminal/tmux/${name}/capture?lines=10`);
  assert.ok(cap.data?.screen.includes('HELLO_A1_42'), `expected HELLO_A1_42, got: ${cap.data?.screen}`);

  const wait = await call<{ outcome: string }>('POST', `/terminal/tmux/${name}/wait-for`, { pattern: 'HELLO_A1_42', literal: true, timeoutMs: 3000 });
  assert.equal(wait.data?.outcome, 'matched');
});

test('A2 — idempotent create returns existed=true on second call', async () => {
  const name = track(uniqName('a2'));
  const first = await call<{ existed: boolean }>('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const second = await call<{ existed: boolean }>('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  assert.equal(first.data?.existed, false);
  assert.equal(second.data?.existed, true);
});

test('A3 — bad cwd is rejected with INVALID_INPUT (no zombie session)', async () => {
  const name = uniqName('a3');
  const res = await call('POST', '/terminal/tmux', { name, cwd: '/does/not/exist/xyz' });
  assert.equal(res.success, false);
  assert.equal(res.error?.code, 'INVALID_INPUT');
  const list = await call<{ sessions: Array<{ name?: string }> }>('GET', '/terminal/tmux');
  assert.ok(!list.data?.sessions.some((s) => (s as { name?: string }).name === name), 'zombie session created');
});

test('A4 — wait-for distinguishes matched / timeout / session-gone', async () => {
  const name = track(uniqName('a4'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });

  await call('POST', `/terminal/tmux/${name}/send-keys`, { keys: 'echo MARK_A4', enter: true });
  const m = await call<{ outcome: string }>('POST', `/terminal/tmux/${name}/wait-for`, { pattern: 'MARK_A4', literal: true, timeoutMs: 3000 });
  assert.equal(m.data?.outcome, 'matched');

  const t = await call<{ outcome: string }>('POST', `/terminal/tmux/${name}/wait-for`, { pattern: 'WILL_NEVER_APPEAR_XYZ', literal: true, timeoutMs: 800, pollMs: 100 });
  assert.equal(t.data?.outcome, 'timeout');

  setTimeout(() => { tmuxCli(['kill-session', '-t', name]); }, 300);
  const g = await call<{ outcome: string }>('POST', `/terminal/tmux/${name}/wait-for`, { pattern: 'WILL_NEVER_APPEAR_XYZ', literal: true, timeoutMs: 2500, pollMs: 100 });
  assert.equal(g.data?.outcome, 'session-gone');
  tracked.delete(name);
});

test('A5 — parallel send-keys are serialized (no garbled commands)', async () => {
  const name = track(uniqName('a5'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const N = 8;
  const sends = Array.from({ length: N }, (_, i) =>
    call('POST', `/terminal/tmux/${name}/send-keys`, { keys: `echo MK_A5_${i}`, enter: true }),
  );
  await Promise.all(sends);
  await sleep(1000);
  const cap = await call<{ screen: string }>('GET', `/terminal/tmux/${name}/capture?start=-200`);
  const screen = cap.data?.screen ?? '';
  for (let i = 0; i < N; i++) {
    assert.ok(screen.includes(`MK_A5_${i}`), `MK_A5_${i} missing — interleave?`);
  }
  assert.ok(!/MK_A5_\d+echo /.test(screen), `garbled command found in: ${screen}`);
});

test('A6 — target body field rejects session-name format (Bug 13 regression)', async () => {
  const sessA = track(uniqName('sessA'));
  const sessB = track(uniqName('sessB'));
  await call('POST', '/terminal/tmux', { name: sessA, cwd: '/tmp' });
  await call('POST', '/terminal/tmux', { name: sessB, cwd: '/tmp' });
  const r = await call('POST', `/terminal/tmux/${sessA}/send-keys`, { keys: 'echo X', enter: true, paneQualifier: sessB });
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'INVALID_INPUT');
  const r2 = await call('POST', `/terminal/tmux/${sessA}/send-keys`, { keys: 'echo X', enter: true, target: sessB });
  assert.equal(r2.success, false);
  assert.equal(r2.error?.code, 'INVALID_INPUT');
  const r3 = await call('POST', `/terminal/tmux/${sessA}/send-keys`, { keys: 'echo PANE_OK', enter: true, paneQualifier: '0.0' });
  assert.equal(r3.success, true);
});

// ===========================================================================
// SECTION B — registry + tab lifecycle
// ===========================================================================

test('B1 — tab create + delete kills underlying tmux + cleans registry', async () => {
  const name = track(uniqName('b1'));
  const create = await call<{ id: string; tmuxSession: string }>('POST', '/terminal/tabs', { kind: 'tmux', tmuxSession: name, cwd: '/tmp' });
  assert.equal(create.success, true);
  const id = create.data!.id;

  const list = await call<{ sessions: Array<{ name?: string }> }>('GET', '/terminal/tmux');
  assert.ok(list.data?.sessions.some((s) => (s as { name?: string }).name === name));

  const del = await call<{ removed: boolean; killedTmux: boolean }>('DELETE', `/terminal/tabs/${id}`);
  assert.equal(del.data?.removed, true);
  assert.equal(del.data?.killedTmux, true);

  const list2 = await call<{ sessions: Array<{ name?: string }> }>('GET', '/terminal/tmux');
  assert.ok(!list2.data?.sessions.some((s) => (s as { name?: string }).name === name));
  tracked.delete(name);
});

test('B2 — listTabs reports alive=false when tmux session killed externally', async () => {
  const name = track(uniqName('b2'));
  const created = await call<{ id: string }>('POST', '/terminal/tabs', { kind: 'tmux', tmuxSession: name, cwd: '/tmp' });
  const id = created.data!.id;

  tmuxCli(['kill-session', '-t', name]);

  const tabs = await call<{ tabs: Array<{ id: string; alive: boolean }> }>('GET', '/terminal/tabs');
  const our = tabs.data?.tabs.find((t) => t.id === id);
  assert.equal(our?.alive, false, 'expected alive=false for orphaned tab');

  const prune = await call<{ pruned: string[] }>('POST', '/terminal/tabs/prune-dead');
  assert.ok(prune.data?.pruned.includes(id));
  tracked.delete(name);
});

test('B3 — atomic registry survives corrupted .tmp file', async () => {
  const name = track(uniqName('b3'));
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const tmpPath = path.join(os.homedir(), '.cache', 'lm-assist', 'terminal-tabs.json.tmp');

  const created = await call<{ id: string }>('POST', '/terminal/tabs', { kind: 'tmux', tmuxSession: name, cwd: '/tmp' });
  const id = created.data!.id;

  fs.writeFileSync(tmpPath, '{ not valid json');

  const tabs = await call<{ tabs: Array<{ id: string }> }>('GET', '/terminal/tabs');
  assert.ok(tabs.data?.tabs.some((t) => t.id === id), 'corruption of .tmp wiped main registry');

  try { fs.unlinkSync(tmpPath); } catch { /* may have been cleaned by next write */ }
});

// ===========================================================================
// SECTION C — input validation
// ===========================================================================

test('C1 — session name with `:` rejected', async () => {
  const r = await call('POST', '/terminal/tmux', { name: 'bad:colon', cwd: '/tmp' });
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'INVALID_INPUT');
});

test('C2 — cwd with shell metachars rejected', async () => {
  const r = await call('POST', '/terminal/tmux', { name: 'c2', cwd: '/tmp; rm -rf /' });
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'INVALID_INPUT');
});

test('C3 — wait-for with empty pattern rejected', async () => {
  const name = track(uniqName('c3'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const r = await call('POST', `/terminal/tmux/${name}/wait-for`, { pattern: '', timeoutMs: 1000 });
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'INVALID_INPUT');
});

test('C4 — wait-for with invalid regex rejected at boundary', async () => {
  const name = track(uniqName('c4'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const r = await call('POST', `/terminal/tmux/${name}/wait-for`, { pattern: '(unclosed', timeoutMs: 500 });
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'INVALID_INPUT');
});

test('C5 — capture lines=0 rejected', async () => {
  const name = track(uniqName('c5'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const r = await call('GET', `/terminal/tmux/${name}/capture?lines=0`);
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'INVALID_INPUT');
});

test('C6 — ccPrompt rejects newline by default', async () => {
  const name = track(uniqName('c6'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const r = await call('POST', `/terminal/cc/${name}/prompt`, { text: 'line1\nline2' });
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'INVALID_INPUT');
});

test('C7 — sshTarget with shell metachars rejected', async () => {
  const r = await call('POST', '/terminal/tabs', { kind: 'wt-ssh', sshTarget: 'user@host & calc.exe', tmuxSession: 'x' });
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'INVALID_INPUT');
});

// ===========================================================================
// SECTION D — Claude Code lifecycle
// ===========================================================================

test('D1 — ccLaunch builds command with --dangerously-skip-permissions MERGED with extraFlags', async () => {
  const name = track(uniqName('d1'));
  await call('POST', `/terminal/cc/${name}/launch`, {
    cwd: '/tmp',
    extraFlags: ['--model', 'haiku'],
    readyTimeoutMs: 500,
  });
  await sleep(300);
  const cap = await call<{ screen: string }>('GET', `/terminal/tmux/${name}/capture?start=-50`);
  const screen = cap.data?.screen ?? '';
  assert.ok(screen.includes('--dangerously-skip-permissions'), `missing --dangerously-skip-permissions in: ${screen}`);
  assert.ok(screen.includes('--model haiku'), `missing --model haiku in: ${screen}`);
});

test('D2 — ccLaunch with skipPermissions=false omits the dangerous flag', async () => {
  const name = track(uniqName('d2'));
  await call('POST', `/terminal/cc/${name}/launch`, {
    cwd: '/tmp', skipPermissions: false, readyTimeoutMs: 500,
  });
  await sleep(300);
  const cap = await call<{ screen: string }>('GET', `/terminal/tmux/${name}/capture?start=-50`);
  const screen = cap.data?.screen ?? '';
  assert.ok(!screen.includes('--dangerously-skip-permissions'), `unexpected dangerous flag: ${screen}`);
});

test('D3 — full lifecycle: launch → idle → prompt → response (SLOW, live CC)', { skip: !LIVE_CC }, async () => {
  const name = track(uniqName('d3'));

  const launch = await call<{ ready: boolean; finalPhase: string; trustPromptHandled: boolean; elapsedMs: number }>('POST', `/terminal/cc/${name}/launch`, {
    cwd: '/tmp',
    readyTimeoutMs: 45000,
    autoAcceptTrust: true,
  });
  assert.equal(launch.success, true, `launch envelope: ${JSON.stringify(launch)}`);
  assert.equal(launch.data?.ready, true, `not ready, phase=${launch.data?.finalPhase}`);

  // Verify a child process is alive in THIS session's pane (more reliable
  // than counting global claude PIDs on a dev box that may host other CCs).
  await sleep(200);
  const panePid = tmuxPanePid(name);
  assert.ok(panePid !== null && processAlive(panePid), `pane pid ${panePid} not alive`);

  const stat1 = await call<{ phase: string }>('GET', `/terminal/cc/${name}/status`);
  assert.equal(stat1.data?.phase, 'idle');

  // Use a computed-answer prompt so wait-for matches CC's response, not
  // the prompt text being echoed into the input box.
  const promptText = "What is 7 + 6? Reply with only the number.";
  const sent = await call('POST', `/terminal/cc/${name}/prompt`, { text: promptText });
  assert.equal(sent.success, true);

  // The answer "13" appears only in CC's response, not in the prompt.
  const wait = await call<{ outcome: string }>('POST', `/terminal/tmux/${name}/wait-for`, {
    pattern: '\\b13\\b', literal: false, timeoutMs: 60000, pollMs: 500,
  });
  assert.equal(wait.data?.outcome, 'matched', `wait outcome: ${JSON.stringify(wait.data)}`);

  await sleep(2000);
  const stat2 = await call<{ phase: string }>('GET', `/terminal/cc/${name}/status`);
  assert.ok(['idle', 'busy'].includes(stat2.data?.phase ?? ''), `unexpected post-prompt phase: ${stat2.data?.phase}`);
});

test('D4 — ccPrompt against non-CC tmux session rejected (PRECONDITION_FAILED)', async () => {
  const name = track(uniqName('d4'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const r = await call('POST', `/terminal/cc/${name}/prompt`, { text: 'hello' });
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'PRECONDITION_FAILED', `got code ${r.error?.code}: ${r.error?.message}`);
});

test('D5 — ccStatus on non-CC pane reports phase=dead', async () => {
  const name = track(uniqName('d5'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const s = await call<{ phase: string }>('GET', `/terminal/cc/${name}/status`);
  assert.equal(s.data?.phase, 'dead');
});

test('D6 — killing tmux session terminates the CC process tree (no orphans, SLOW, live CC)', { skip: !LIVE_CC }, async () => {
  const name = track(uniqName('d6'));

  const launch = await call<{ ready: boolean }>('POST', `/terminal/cc/${name}/launch`, {
    cwd: '/tmp', readyTimeoutMs: 45000, autoAcceptTrust: true,
  });
  assert.equal(launch.data?.ready, true);

  await sleep(500);
  const panePid = tmuxPanePid(name);
  assert.ok(panePid !== null && processAlive(panePid), `pane pid ${panePid} not alive after launch`);
  // Snapshot the descendant tree (CC may spawn helper processes).
  const treeBefore = descendantPids(panePid!);

  await call('DELETE', `/terminal/tmux/${name}`);
  tracked.delete(name);

  // Give the OS a moment to reap the tree.
  await sleep(2500);

  const stillAlive = treeBefore.filter(processAlive);
  assert.equal(stillAlive.length, 0, `${stillAlive.length} processes leaked: ${stillAlive.join(',')}`);
});

// ===========================================================================
// SECTION E — concurrent / race safety with real CC
// ===========================================================================

test('E1 — two parallel prompts to same CC are serialized by mutex (both succeed, both seen by CC) (SLOW, live CC)', { skip: !LIVE_CC }, async () => {
  const name = track(uniqName('e1'));
  const launch = await call<{ ready: boolean }>('POST', `/terminal/cc/${name}/launch`, {
    cwd: '/tmp', readyTimeoutMs: 45000, autoAcceptTrust: true,
  });
  assert.equal(launch.data?.ready, true);

  // Use prompts whose answer tokens are computed by CC, not present in the
  // prompt text itself — otherwise wait-for matches the typed prompt rather
  // than CC's response.
  const p1 = call('POST', `/terminal/cc/${name}/prompt`, { text: 'What is 11 + 22? Reply with only the number.' });
  const p2 = call('POST', `/terminal/cc/${name}/prompt`, { text: 'What is 100 - 17? Reply with only the number.' });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.success, true, `p1 failed: ${JSON.stringify(r1)}`);
  assert.equal(r2.success, true, `p2 failed: ${JSON.stringify(r2)}`);

  // Wait for CC to actually compute and respond. Match on the answer
  // tokens (33, 83) which appear ONLY in CC's reply, not in the prompt.
  const w1 = await call<{ outcome: string }>('POST', `/terminal/tmux/${name}/wait-for`, {
    pattern: '\\b33\\b', literal: false, timeoutMs: 120000, pollMs: 500,
  });
  assert.equal(w1.data?.outcome, 'matched', 'CC never produced 33 (response to first prompt)');
  const w2 = await call<{ outcome: string }>('POST', `/terminal/tmux/${name}/wait-for`, {
    pattern: '\\b83\\b', literal: false, timeoutMs: 120000, pollMs: 500,
  });
  assert.equal(w2.data?.outcome, 'matched', 'CC never produced 83 (response to second prompt)');
});
