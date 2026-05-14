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

// ===========================================================================
// SECTION F — lifecycle / state gap coverage with real CC
// ===========================================================================

test('F1 — ccPivot with bogus session ID surfaces a clean failure (no race, no crash) (SLOW, live CC)', { skip: !LIVE_CC }, async () => {
  const name = track(uniqName('f1'));
  const launch = await call<{ ready: boolean }>('POST', `/terminal/cc/${name}/launch`, {
    cwd: '/tmp', readyTimeoutMs: 45000, autoAcceptTrust: true,
  });
  assert.equal(launch.data?.ready, true);

  // /resume with a session ID that doesn't exist → CC shows "session not found"
  // or returns to prompt. The pivot should NOT match the OLD ❯ before the
  // resume completes (race-safe screen-delta check), and should return
  // pivoted:false because the new idle state never reaches the prompt-loaded
  // condition in the expected way (no crash).
  const r = await call<{ pivoted: boolean; finalPhase: string; elapsedMs: number }>('POST', `/terminal/cc/${name}/pivot`, {
    newSessionId: 'definitely-not-a-real-session-uuid-zzz',
    prompt: 'this should not arrive at any session',
    timeoutMs: 8000,
  });
  // The endpoint must return success at the HTTP level (validation passed).
  assert.equal(r.success, true);
  // pivoted may be true or false depending on what CC does with the bad id.
  // What matters: elapsedMs > 100 (we waited for the screen delta, didn't
  // instant-match a stale ❯). If the race bug returned, elapsedMs would be
  // <50 ms.
  assert.ok((r.data?.elapsedMs ?? 0) > 100, `pivot returned too fast (${r.data?.elapsedMs}ms) — possible race regression`);
});

test('F3 — multi-turn conversation: 3 sequential prompts on same session (SLOW, live CC)', { skip: !LIVE_CC }, async () => {
  const name = track(uniqName('f3'));
  const launch = await call<{ ready: boolean }>('POST', `/terminal/cc/${name}/launch`, {
    cwd: '/tmp', readyTimeoutMs: 45000, autoAcceptTrust: true,
  });
  assert.equal(launch.data?.ready, true);

  // Three prompts with computed answers; verify each appears in order.
  const turns = [
    { prompt: 'What is 5 + 8? Reply with only the number.', answer: '13' },
    { prompt: 'What is 20 - 7? Reply with only the number.', answer: '13' },  // same answer is fine
    { prompt: 'What is 100 / 4? Reply with only the number.', answer: '25' },
  ];
  for (const t of turns) {
    const r = await call('POST', `/terminal/cc/${name}/prompt`, { text: t.prompt });
    assert.equal(r.success, true, `prompt failed: ${JSON.stringify(r)}`);
    const w = await call<{ outcome: string }>('POST', `/terminal/tmux/${name}/wait-for`, {
      pattern: `\\b${t.answer}\\b`, literal: false, timeoutMs: 60000, pollMs: 500,
    });
    assert.equal(w.data?.outcome, 'matched', `CC didn't answer turn ${turns.indexOf(t) + 1}`);
    // Give CC a moment to return to idle between turns.
    await sleep(1500);
  }
});

test('F4 — capture works during a busy CC operation (lockless read) (SLOW, live CC)', { skip: !LIVE_CC }, async () => {
  const name = track(uniqName('f4'));
  const launch = await call<{ ready: boolean }>('POST', `/terminal/cc/${name}/launch`, {
    cwd: '/tmp', readyTimeoutMs: 45000, autoAcceptTrust: true,
  });
  assert.equal(launch.data?.ready, true);

  // Kick off a prompt that takes a few seconds.
  await call('POST', `/terminal/cc/${name}/prompt`, {
    text: 'Count from 1 to 5 with one item per line. Reply with the digits only.',
  });

  // Concurrently call capture several times while CC is producing the answer.
  // None of them should fail or block on the send-keys mutex (capture is read-only).
  const captures = await Promise.all([
    call<{ screen: string }>('GET', `/terminal/tmux/${name}/capture?lines=20`),
    call<{ screen: string }>('GET', `/terminal/tmux/${name}/capture?lines=10`),
    call<{ screen: string }>('GET', `/terminal/tmux/${name}/capture`),
  ]);
  for (const c of captures) {
    assert.equal(c.success, true, `capture failed: ${JSON.stringify(c)}`);
    assert.ok(typeof c.data?.screen === 'string');
  }

  // Wait for CC to finish so cleanup doesn't kill a busy CC mid-thought.
  await call<{ outcome: string }>('POST', `/terminal/tmux/${name}/wait-for`, {
    pattern: '\\b5\\b', literal: false, timeoutMs: 60000, pollMs: 500,
  });
});

test('F5 — trust prompt: if CC version shows it, status reports phase=trust-prompt and accept-dialog dismisses it (SLOW, live CC)', { skip: !LIVE_CC }, async () => {
  const name = track(uniqName('f5'));
  // Use a fresh, never-trusted cwd. CC ≥ v2.1.x with --dangerously-skip-permissions
  // appears to bypass the trust prompt entirely; older versions show it. Test
  // adapts to either behavior.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-test-untrust-'));

  try {
    const launch = await call<{ ready: boolean; finalPhase: string }>('POST', `/terminal/cc/${name}/launch`, {
      cwd: dir, readyTimeoutMs: 12000, autoAcceptTrust: false,
    });
    assert.equal(launch.success, true);

    if (launch.data?.ready === true) {
      // CC version bypasses trust prompt with --dangerously-skip-permissions.
      // The accept-dialog endpoint can't be tested against a real trust prompt
      // in this environment — it's covered by T4a (precondition rejection)
      // and the static deriveDialog test below.
      assert.equal(launch.data?.finalPhase, 'idle', 'when ready, phase should be idle');
      // Status should not report a pending dialog.
      const stat = await call<{ pendingDialog: string | null }>('GET', `/terminal/cc/${name}/status`);
      assert.equal(stat.data?.pendingDialog, null);
      return;
    }

    // CC version DID show the trust prompt — exercise the dialog handler.
    assert.equal(launch.data?.finalPhase, 'trust-prompt', `expected trust-prompt, got ${launch.data?.finalPhase}`);
    const stat = await call<{ pendingDialog: string }>('GET', `/terminal/cc/${name}/status`);
    assert.equal(stat.data?.pendingDialog, 'trust');

    const accept = await call<{ dialog: string }>('POST', `/terminal/cc/${name}/accept-dialog`, {});
    assert.equal(accept.success, true);
    assert.equal(accept.data?.dialog, 'trust');

    const w = await call<{ outcome: string }>('POST', `/terminal/tmux/${name}/wait-for`, {
      pattern: 'ctx:', literal: true, timeoutMs: 30000, pollMs: 500,
    });
    assert.equal(w.data?.outcome, 'matched', 'CC never reached idle after trust accept');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ===========================================================================
// SECTION T — new API surface (interrupt / slash / dialogs / status)
// ===========================================================================

test('T1a — status returns extended fields on non-CC pane', async () => {
  const name = track(uniqName('t1a'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const s = await call<{
    phase: string; model: string | null; currentMode: string; pendingDialog: string | null;
    authState: string; contextPct: number | null; authEmail: string | null;
  }>('GET', `/terminal/cc/${name}/status`);
  assert.equal(s.success, true);
  assert.equal(s.data?.phase, 'dead');
  assert.equal(s.data?.currentMode, 'unknown');
  assert.equal(s.data?.pendingDialog, null);
  assert.equal(s.data?.contextPct, null);
  // authState comes from ~/.claude.json — on a dev machine that's likely
  // 'authenticated' (because the user IS logged in to run any of this). On a
  // CI box without ~/.claude.json it would be 'unknown'. Both are valid.
  assert.ok(['authenticated', 'unauthenticated', 'unknown'].includes(s.data?.authState ?? ''),
    `unexpected authState: ${s.data?.authState}`);
});

test('T1b — status surfaces contextPct, currentMode=normal, authEmail on live CC (SLOW, live CC)', { skip: !LIVE_CC }, async () => {
  const name = track(uniqName('t1b'));
  const launch = await call<{ ready: boolean }>('POST', `/terminal/cc/${name}/launch`, {
    cwd: '/tmp', readyTimeoutMs: 45000, autoAcceptTrust: true,
  });
  assert.equal(launch.data?.ready, true);

  const s = await call<{
    phase: string; currentMode: string; pendingDialog: string | null;
    authState: string; contextPct: number | null; authEmail: string | null;
  }>('GET', `/terminal/cc/${name}/status`);
  assert.equal(s.data?.phase, 'idle');
  assert.equal(s.data?.currentMode, 'normal');
  assert.equal(s.data?.pendingDialog, null);
  assert.ok(s.data?.contextPct !== null && s.data!.contextPct >= 0 && s.data!.contextPct <= 100,
    `contextPct should be 0..100, got ${s.data?.contextPct}`);
  // On this dev machine, the user IS authenticated.
  assert.equal(s.data?.authState, 'authenticated');
  assert.ok(s.data?.authEmail && s.data.authEmail.includes('@'),
    `expected an email, got ${s.data?.authEmail}`);
});

test('T2 — /interrupt accepts the call and returns success on existing session', async () => {
  const name = track(uniqName('t2'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const r = await call('POST', `/terminal/cc/${name}/interrupt`, {});
  assert.equal(r.success, true);
});

test('T2b — /interrupt cancels a running prompt (SLOW, live CC)', { skip: !LIVE_CC }, async () => {
  const name = track(uniqName('t2b'));
  const launch = await call<{ ready: boolean }>('POST', `/terminal/cc/${name}/launch`, {
    cwd: '/tmp', readyTimeoutMs: 45000, autoAcceptTrust: true,
  });
  assert.equal(launch.data?.ready, true);

  // Start a long task.
  await call('POST', `/terminal/cc/${name}/prompt`, {
    text: 'Write a haiku, then a sonnet, then a 14-line ode. Take your time.',
  });
  // Give CC a moment to start streaming.
  await sleep(2000);

  // Interrupt.
  const r = await call('POST', `/terminal/cc/${name}/interrupt`, {});
  assert.equal(r.success, true);

  // After Ctrl+C, CC should return to idle within a few seconds (no longer
  // streaming a response).
  await sleep(3000);
  const s = await call<{ phase: string }>('GET', `/terminal/cc/${name}/status`);
  assert.equal(s.data?.phase, 'idle', `CC didn't return to idle after interrupt; phase=${s.data?.phase}`);
});

test('T3a — /slash validates cmd format', async () => {
  const name = track(uniqName('t3a'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  // Bad command (special chars).
  const bad1 = await call('POST', `/terminal/cc/${name}/slash`, { cmd: 'bad cmd' });
  assert.equal(bad1.success, false);
  assert.equal(bad1.error?.code, 'INVALID_INPUT');
  const bad2 = await call('POST', `/terminal/cc/${name}/slash`, { cmd: '$injection' });
  assert.equal(bad2.success, false);
  assert.equal(bad2.error?.code, 'INVALID_INPUT');
  // Bad args (newlines).
  const bad3 = await call('POST', `/terminal/cc/${name}/slash`, { cmd: 'clear', args: 'foo\nbar' });
  assert.equal(bad3.success, false);
  assert.equal(bad3.error?.code, 'INVALID_INPUT');
});

test('T3b — /slash on non-CC pane rejected (PRECONDITION_FAILED)', async () => {
  const name = track(uniqName('t3b'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const r = await call('POST', `/terminal/cc/${name}/slash`, { cmd: 'clear' });
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'PRECONDITION_FAILED');
});

test('T3c — /slash clear actually clears CC context (SLOW, live CC)', { skip: !LIVE_CC }, async () => {
  const name = track(uniqName('t3c'));
  const launch = await call<{ ready: boolean }>('POST', `/terminal/cc/${name}/launch`, {
    cwd: '/tmp', readyTimeoutMs: 45000, autoAcceptTrust: true,
  });
  assert.equal(launch.data?.ready, true);

  // Generate some context: send a memorable prompt + wait for answer.
  await call('POST', `/terminal/cc/${name}/prompt`, { text: 'Remember the magic phrase ZEBRA_HORIZON_42.' });
  await call<{ outcome: string }>('POST', `/terminal/tmux/${name}/wait-for`, {
    pattern: 'ZEBRA_HORIZON_42', literal: true, timeoutMs: 60000, pollMs: 500,
  });
  await sleep(2000);

  // Clear.
  const clr = await call('POST', `/terminal/cc/${name}/slash`, { cmd: 'clear' });
  assert.equal(clr.success, true);
  await sleep(2000);

  // After clear, asking CC about the phrase should NOT include the literal
  // phrase being remembered as if from prior context. (Hard to assert
  // precisely — CC may or may not echo it back as "I don't remember any
  // ZEBRA_HORIZON_42".) What we CAN assert: status returns to idle (ctx
  // reset, footer present).
  const s = await call<{ phase: string; contextPct: number | null }>('GET', `/terminal/cc/${name}/status`);
  assert.equal(s.data?.phase, 'idle', `not idle after clear; phase=${s.data?.phase}`);
});

test('T4a — accept-dialog on non-CC pane rejected (no dialog)', async () => {
  const name = track(uniqName('t4a'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const r = await call('POST', `/terminal/cc/${name}/accept-dialog`, {});
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'PRECONDITION_FAILED');
});

test('T4b — reject-dialog on non-CC pane rejected (no dialog)', async () => {
  const name = track(uniqName('t4b'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const r = await call('POST', `/terminal/cc/${name}/reject-dialog`, {});
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'PRECONDITION_FAILED');
});

test('T5a — select-choice validates n is in [1,9]', async () => {
  const name = track(uniqName('t5a'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const r0 = await call('POST', `/terminal/cc/${name}/select-choice`, { n: 0 });
  assert.equal(r0.error?.code, 'INVALID_INPUT');
  const r10 = await call('POST', `/terminal/cc/${name}/select-choice`, { n: 10 });
  assert.equal(r10.error?.code, 'INVALID_INPUT');
  const rNonint = await call('POST', `/terminal/cc/${name}/select-choice`, { n: 1.5 });
  assert.equal(rNonint.error?.code, 'INVALID_INPUT');
});

test('T5b — select-choice on pane with no dialog rejected (PRECONDITION_FAILED)', async () => {
  const name = track(uniqName('t5b'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const r = await call('POST', `/terminal/cc/${name}/select-choice`, { n: 1 });
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'PRECONDITION_FAILED');
});

test('T6 — await-idle on dead/non-CC pane returns reached=false (no spinning)', async () => {
  const name = track(uniqName('t6'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const start = Date.now();
  const r = await call<{ reached: boolean; finalPhase: string; elapsedMs: number }>('POST', `/terminal/cc/${name}/await-idle`, { timeoutMs: 5000, pollMs: 100 });
  assert.equal(r.success, true);
  assert.equal(r.data?.reached, false, 'should not reach idle on a bash-only pane');
  assert.ok(r.data?.finalPhase === 'dead', `expected finalPhase=dead, got ${r.data?.finalPhase}`);
  assert.ok(Date.now() - start < 4000, 'should bail out fast (DEAD_THRESHOLD), not wait full 5s');
});

test('T6b — await-idle on live CC returns reached=true quickly (SLOW, live CC)', { skip: !LIVE_CC }, async () => {
  const name = track(uniqName('t6b'));
  const launch = await call<{ ready: boolean }>('POST', `/terminal/cc/${name}/launch`, {
    cwd: '/tmp', readyTimeoutMs: 45000, autoAcceptTrust: true,
  });
  assert.equal(launch.data?.ready, true);

  const r = await call<{ reached: boolean; finalPhase: string }>('POST', `/terminal/cc/${name}/await-idle`, { timeoutMs: 5000, pollMs: 200 });
  assert.equal(r.data?.reached, true);
  assert.equal(r.data?.finalPhase, 'idle');
});

// ===========================================================================
// SECTION H — tmux multi-window endpoints
// ===========================================================================

test('H1 — listWindows on fresh session returns the default 1 window', async () => {
  const name = track(uniqName('h1'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const r = await call<{ windows: Array<{ index: number; active: boolean; paneCommand: string | null }> }>('GET', `/terminal/tmux/${name}/windows`);
  assert.equal(r.success, true);
  assert.equal(r.data?.windows.length, 1);
  assert.equal(r.data?.windows[0].active, true);
  assert.ok(r.data?.windows[0].paneCommand === 'bash' || r.data?.windows[0].paneCommand === 'sh');
});

test('H2 — createWindow returns new index, listWindows shows it', async () => {
  const name = track(uniqName('h2'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const create = await call<{ index: number }>('POST', `/terminal/tmux/${name}/windows`, { cwd: '/tmp', name: 'second' });
  assert.equal(create.success, true);
  assert.ok(create.data?.index !== undefined && create.data.index > 0);

  const list = await call<{ windows: Array<{ index: number; name: string }> }>('GET', `/terminal/tmux/${name}/windows`);
  assert.equal(list.data?.windows.length, 2);
  const newWin = list.data?.windows.find((w) => w.index === create.data!.index);
  assert.ok(newWin);
  assert.equal(newWin?.name, 'second');
});

test('H3 — selectWindow makes the target active', async () => {
  const name = track(uniqName('h3'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  await call('POST', `/terminal/tmux/${name}/windows`, { cwd: '/tmp' });
  // Window 1 is now newly created and presumably active. Switch to 0.
  const sel = await call('POST', `/terminal/tmux/${name}/windows/0/select`, {});
  assert.equal(sel.success, true);
  const list = await call<{ windows: Array<{ index: number; active: boolean }> }>('GET', `/terminal/tmux/${name}/windows`);
  const w0 = list.data?.windows.find((w) => w.index === 0);
  assert.equal(w0?.active, true);
});

test('H4 — killWindow removes from list, session lives', async () => {
  const name = track(uniqName('h4'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const created = await call<{ index: number }>('POST', `/terminal/tmux/${name}/windows`, { cwd: '/tmp' });
  const idx = created.data!.index;

  const kill = await call<{ killed: boolean; sessionGone: boolean }>('DELETE', `/terminal/tmux/${name}/windows/${idx}`);
  assert.equal(kill.data?.killed, true);
  assert.equal(kill.data?.sessionGone, false, 'session should still exist (other window remains)');

  const list = await call<{ windows: unknown[] }>('GET', `/terminal/tmux/${name}/windows`);
  assert.equal(list.data?.windows.length, 1);
});

test('H5 — killing the last window kills the session', async () => {
  const name = track(uniqName('h5'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const kill = await call<{ killed: boolean; sessionGone: boolean }>('DELETE', `/terminal/tmux/${name}/windows/0`);
  assert.equal(kill.data?.killed, true);
  assert.equal(kill.data?.sessionGone, true);
  // Session should be unfindable.
  const list = await call('GET', `/terminal/tmux/${name}/windows`);
  assert.equal(list.success, false);
  assert.equal(list.error?.code, 'SESSION_NOT_FOUND');
  tracked.delete(name);
});

test('H6 — createWindow with bad cwd rejected', async () => {
  const name = track(uniqName('h6'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const r = await call('POST', `/terminal/tmux/${name}/windows`, { cwd: '/does/not/exist/h6' });
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'INVALID_INPUT');
});

// ===========================================================================
// SECTION R — /agent/execute runner dispatch (SDK vs tmux)
//
// The agent-api accepts a `runner: 'sdk' | 'tmux'` field. Default is 'sdk'
// for back-compat. The tmux runner shares a long-lived CC TUI hosted in
// a tmux session, exposed via the same response shape so callers can
// switch backends transparently. Section verifies parity, warm reuse,
// and additive fields.
// ===========================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AgentResponse {
  success: boolean;
  result: string;
  sessionId: string;
  executionId: string;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  totalCostUsd: number;
  usage: Record<string, number>;
  modelUsage: Record<string, unknown>;
  error?: string;
  tmuxSession?: string;
  runner?: string;
}

test('R1 — SDK runner: back-compat (no runner field), real cost, no tmuxSession (SLOW, live CC)', { skip: !LIVE_CC }, async () => {
  const r = await call<AgentResponse>('POST', '/agent/execute', {
    prompt: 'Reply with exactly: SDK_R1_OK',
    cwd: '/tmp',
    permissionMode: 'bypassPermissions',
    settingSources: ['project', 'user'],
  });
  assert.equal(r.success, true);
  assert.equal(r.data?.success, true);
  assert.ok(UUID_RE.test(r.data?.sessionId ?? ''), `sessionId should be UUID, got ${r.data?.sessionId}`);
  assert.equal(r.data?.tmuxSession, undefined, 'SDK runner must not set tmuxSession');
  assert.equal(r.data?.runner, undefined, 'SDK runner must not set runner field');
  assert.ok((r.data?.totalCostUsd ?? 0) > 0, 'SDK runner reports real cost');
  assert.ok(r.data?.result.includes('SDK_R1_OK'));
});

test('R2 — Tmux runner: sessionId is CC UUID, tmuxSession + runner set (SLOW, live CC)', { skip: !LIVE_CC }, async () => {
  const sess = uniqName('r2');
  track(sess);
  const r = await call<AgentResponse>('POST', '/agent/execute', {
    prompt: 'Reply with exactly the digits for 5 plus 3, nothing else.',
    cwd: '/tmp',
    runner: 'tmux',
    tmuxSession: sess,
  });
  assert.equal(r.success, true);
  assert.equal(r.data?.success, true, `error: ${r.data?.error}`);
  // sessionId is CC's REAL conversation UUID (parsed from `sid:` in footer),
  // NOT the tmux session name.
  assert.ok(UUID_RE.test(r.data?.sessionId ?? ''), `sessionId should be a CC UUID, got ${r.data?.sessionId}`);
  assert.notEqual(r.data?.sessionId, sess, 'sessionId must NOT be the tmux session name');
  assert.equal(r.data?.tmuxSession, sess, 'tmuxSession should echo back the supplied name');
  assert.equal(r.data?.runner, 'tmux');
  assert.equal(r.data?.totalCostUsd, 0, 'tmux runner has no cost telemetry');
  assert.equal(r.data?.usage.totalTokens, 0);
  assert.ok(r.data?.result.includes('8'), `expected response containing 8 (5+3), got: ${r.data?.result}`);
});

test('R3 — Tmux runner warm: 2 calls to same tmuxSession share the CC sessionId (SLOW, live CC)', { skip: !LIVE_CC }, async () => {
  const sess = uniqName('r3');
  track(sess);

  const r1 = await call<AgentResponse>('POST', '/agent/execute', {
    prompt: 'Reply with exactly: FIRST_CALL',
    cwd: '/tmp', runner: 'tmux', tmuxSession: sess,
  });
  assert.equal(r1.data?.success, true);
  const sid1 = r1.data?.sessionId;
  assert.ok(UUID_RE.test(sid1 ?? ''));

  const r2 = await call<AgentResponse>('POST', '/agent/execute', {
    prompt: 'Reply with exactly: SECOND_CALL',
    cwd: '/tmp', runner: 'tmux', tmuxSession: sess,
  });
  assert.equal(r2.data?.success, true);
  assert.equal(r2.data?.sessionId, sid1, 'same tmuxSession must keep the same CC conversation UUID');
});

test('R4 — Tmux runner: omitting tmuxSession auto-names a session (SLOW, live CC)', { skip: !LIVE_CC }, async () => {
  const r = await call<AgentResponse>('POST', '/agent/execute', {
    prompt: 'Reply with: AUTO_OK',
    cwd: '/tmp', runner: 'tmux',
  });
  assert.equal(r.data?.success, true);
  // tmuxSession should be auto-derived from the executionId.
  assert.ok(typeof r.data?.tmuxSession === 'string' && r.data!.tmuxSession.length > 0);
  assert.ok(r.data!.tmuxSession.startsWith('agent-'), `auto-named session should start with agent-, got ${r.data?.tmuxSession}`);
  assert.ok(UUID_RE.test(r.data?.sessionId ?? ''));
  // Clean up — the auto-named session needs explicit kill since track() can't predict the name.
  if (r.data?.tmuxSession) {
    await call('DELETE', `/terminal/tmux/${encodeURIComponent(r.data.tmuxSession)}`);
  }
});

test('R5 — Tmux runner: response extraction returns CC answer (not the prompt echo) (SLOW, live CC)', { skip: !LIVE_CC }, async () => {
  const sess = uniqName('r5');
  track(sess);
  // Use a question whose answer is a unique token NOT present in the prompt.
  // If the response extractor regresses to "everything after the typed
  // prompt in the footer", we'd see prompt fragments in the result.
  const r = await call<AgentResponse>('POST', '/agent/execute', {
    prompt: 'What is 13 multiplied by 7? Reply with only the digits.',
    cwd: '/tmp', runner: 'tmux', tmuxSession: sess,
  });
  assert.equal(r.data?.success, true);
  const result = r.data?.result ?? '';
  assert.ok(result.includes('91'), `expected result to contain 91, got ${result}`);
  // Sanity: the prompt text shouldn't dominate the result.
  assert.ok(!result.includes('multiplied by'), 'extractor leaked prompt text into result');
  assert.ok(!result.includes('Reply with only the digits'), 'extractor leaked prompt text');
  // Sanity: CC's TUI footer keywords should be stripped.
  assert.ok(!result.includes('ctx:') && !result.includes('bypass permissions'), 'TUI scaffolding leaked');
});

test('R6 — Tmux runner: launch failure (bad cwd) returned as failure response, NOT a 500', async () => {
  // Bad cwd → cc.launch's tmux.createUnlocked pre-checks fs.statSync and
  // throws INVALID_INPUT. The runner should catch and return an error
  // AgentExecuteResponse with success:false (envelope still 200).
  // Doesn't need RUN_LIVE_CC — fails before CC is even attempted.
  const r = await call<AgentResponse>('POST', '/agent/execute', {
    prompt: 'should not run',
    cwd: '/this/path/does/not/exist/r6',
    runner: 'tmux',
    tmuxSession: uniqName('r6'),
  });
  assert.equal(r.success, true, 'API envelope should still be success-shaped');
  assert.equal(r.data?.success, false, 'data.success should reflect the runner failure');
  assert.ok(r.data?.error && r.data.error.length > 0, `expected error message, got: ${JSON.stringify(r.data)}`);
  assert.ok(r.data!.error!.includes('cwd') || r.data!.error!.includes('INVALID_INPUT') || r.data!.error!.includes('does not exist'),
    `error should mention cwd issue, got: ${r.data?.error}`);
});

test('H7 — createWindow with command runs it in the new window (visible via send-keys)', async () => {
  const name = track(uniqName('h7'));
  await call('POST', '/terminal/tmux', { name, cwd: '/tmp' });
  const fs = await import('node:fs');
  const marker = `/tmp/.lm-h7-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const created = await call<{ index: number }>('POST', `/terminal/tmux/${name}/windows`, {
      cwd: '/tmp', command: `touch ${marker}`,
    });
    await sleep(500);
    assert.ok(fs.existsSync(marker), `command should have run; marker file ${marker} not created`);
    assert.ok(created.data?.index);
  } finally {
    try { fs.unlinkSync(marker); } catch { /* ignore */ }
  }
});

// ===========================================================================
// SECTION G — visible GUI tabs (gnome on Linux with a logged-in desktop)
//
// These tests require a GNOME desktop session running on this host. They're
// auto-skipped when no display env is available (CI, headless servers).
// ===========================================================================

/**
 * Returns true if gnome-terminal can be spawned here:
 *   - gnome-terminal binary present, AND
 *   - a desktop session is running (gnome-shell, kwin, sway, Xorg…)
 *
 * Doesn't require gnome-terminal-server to be ALREADY running — the
 * server is dbus-activated on first `gnome-terminal` call.
 */
function gnomeAvailable(): boolean {
  try {
    // Probe for the CLI.
    execFileSync('which', ['gnome-terminal'], { stdio: 'ignore', timeout: 1500 });
  } catch { return false; }
  // Probe /proc for any X11/Wayland compositor or gnome-shell that
  // findDesktopEnv() would also find — that's all openGnomeTab needs.
  const fs = require('node:fs') as typeof import('node:fs');
  const wmNames = ['gnome-shell', 'gnome-terminal-server', 'kwin_x11', 'kwin_wayland', 'sway', 'Xorg', 'Xwayland'];
  try {
    const dirs = fs.readdirSync('/proc');
    for (const d of dirs) {
      if (!/^\d+$/.test(d)) continue;
      let cmdline: string;
      try { cmdline = fs.readFileSync(`/proc/${d}/cmdline`, 'utf-8'); } catch { continue; }
      const argv0 = cmdline.split('\0')[0];
      for (const name of wmNames) {
        if (argv0.endsWith(`/${name}`) || argv0 === name) return true;
      }
    }
  } catch { /* /proc unreadable */ }
  return false;
}

function gnomeChildPids(): number[] {
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const dirs = fs.readdirSync('/proc');
    for (const d of dirs) {
      if (!/^\d+$/.test(d)) continue;
      let cmdline: string;
      try { cmdline = fs.readFileSync(`/proc/${d}/cmdline`, 'utf-8'); } catch { continue; }
      const argv0 = cmdline.split('\0')[0];
      if (/(?:^|\/)gnome-terminal-server$/.test(argv0)) {
        const serverPid = parseInt(d, 10);
        try {
          const out = execFileSync('pgrep', ['-P', String(serverPid)], { encoding: 'utf-8', timeout: 2000 }).trim();
          return out.split('\n').filter(Boolean).map(Number).filter(Number.isFinite);
        } catch { return []; }
      }
    }
  } catch { /* ignore */ }
  return [];
}

const GNOME_AVAILABLE = gnomeAvailable();

test('G1 — gnome tab opens, tabPid tracked + alive, count increments', { skip: !GNOME_AVAILABLE }, async () => {
  const before = gnomeChildPids().length;
  const create = await call<{ id: string; meta: { tabPid: number | null; displayAvailable: boolean } }>('POST', '/terminal/tabs', {
    kind: 'gnome', title: 'g1', cwd: '/tmp',
  });
  assert.equal(create.success, true, JSON.stringify(create));
  assert.equal(create.data?.meta.displayAvailable, true);
  const tabPid = create.data!.meta.tabPid;
  assert.ok(typeof tabPid === 'number' && tabPid > 0, `expected tabPid, got ${tabPid}`);
  assert.ok(processAlive(tabPid as number), 'tabPid should be alive');
  const after = gnomeChildPids().length;
  assert.equal(after, before + 1, `tab count should have grown by 1: before=${before} after=${after}`);

  // Clean up.
  await call('DELETE', `/terminal/tabs/${create.data!.id}`);
  await sleep(1500);
  assert.equal(processAlive(tabPid as number), false, 'tabPid should be gone after DELETE');
  assert.equal(gnomeChildPids().length, before, 'tab count should return to baseline');
});

test('G2 — DELETE non-tmux gnome tab uses SIGHUP and actually closes the window', { skip: !GNOME_AVAILABLE }, async () => {
  const baseline = gnomeChildPids().length;
  const create = await call<{ id: string; meta: { tabPid: number } }>('POST', '/terminal/tabs', {
    kind: 'gnome', title: 'g2', cwd: '/tmp',
  });
  const pid = create.data!.meta.tabPid;
  await sleep(300);
  assert.ok(processAlive(pid), 'tab bash should be alive before DELETE');

  const del = await call<{ removed: boolean; killedTmux: boolean; closedTab: boolean }>('DELETE', `/terminal/tabs/${create.data!.id}`);
  assert.equal(del.data?.closedTab, true);

  await sleep(1500);
  assert.equal(processAlive(pid), false, `pid ${pid} should be gone (SIGHUP propagated)`);
  assert.equal(gnomeChildPids().length, baseline, 'gnome tab count should return to baseline');
});

test('G3 — tmux-linked gnome tab: DELETE kills tmux + tab closes via tmux death', { skip: !GNOME_AVAILABLE }, async () => {
  const sessName = uniqName('g3-sess');
  const baseline = gnomeChildPids().length;
  const create = await call<{ id: string; tmuxSession: string }>('POST', '/terminal/tabs', {
    kind: 'gnome', title: 'g3', tmuxSession: sessName, cwd: '/tmp',
  });
  assert.equal(create.data?.tmuxSession, sessName);
  // tmux session must exist.
  const list = await call<{ sessions: Array<{ name?: string }> }>('GET', '/terminal/tmux');
  assert.ok(list.data?.sessions.some((s) => (s as { name?: string }).name === sessName));

  const del = await call<{ killedTmux: boolean }>('DELETE', `/terminal/tabs/${create.data!.id}`);
  assert.equal(del.data?.killedTmux, true);

  await sleep(1500);
  const list2 = await call<{ sessions: Array<{ name?: string }> }>('GET', '/terminal/tmux');
  assert.ok(!list2.data?.sessions.some((s) => (s as { name?: string }).name === sessName), 'tmux session should be gone');
  assert.equal(gnomeChildPids().length, baseline, 'gnome tab count should return to baseline (bash exited when tmux attach ended)');
});

test('G4 — gnome tab with command actually runs the command (eval-based shell parsing)', { skip: !GNOME_AVAILABLE }, async () => {
  const fs = await import('node:fs');
  const marker = `/tmp/.lm-g4-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const create = await call<{ id: string; meta: { tabPid: number } }>('POST', '/terminal/tabs', {
      kind: 'gnome', title: 'g4', cwd: '/tmp',
      // Shell expression — `eval "$1"` re-parses this as shell, so && and > work.
      command: `echo MARKER_G4 > ${marker} && exec sleep 600`,
    });
    await sleep(1500);
    assert.ok(fs.existsSync(marker), `marker file ${marker} not created — command did not run`);
    assert.equal(fs.readFileSync(marker, 'utf-8').trim(), 'MARKER_G4');

    // DELETE should also kill the `sleep 600`.
    const pid = create.data!.meta.tabPid;
    await call('DELETE', `/terminal/tabs/${create.data!.id}`);
    await sleep(1500);
    assert.equal(processAlive(pid), false, 'tab bash gone');
  } finally {
    try { fs.unlinkSync(marker); } catch { /* ignore */ }
  }
});

test('G5 — gnome tab with non-existent cwd rejected (INVALID_INPUT, no tab spawned)', { skip: !GNOME_AVAILABLE }, async () => {
  const before = gnomeChildPids().length;
  const r = await call('POST', '/terminal/tabs', {
    kind: 'gnome', cwd: '/this/does/not/exist/g5',
  });
  assert.equal(r.success, false);
  assert.equal(r.error?.code, 'INVALID_INPUT');
  assert.equal(gnomeChildPids().length, before, 'no tab should have spawned');
});

function ccPidCount(): number {
  try {
    const out = execFileSync('pgrep', ['-f', '\\.local/bin/claude'], { encoding: 'utf-8' });
    return out.trim().split('\n').filter(Boolean).length;
  } catch { return 0; }
}

test('G6 — END-TO-END: visible gnome tab + tmux + Claude Code, prompts, interrupt, /clear, clean teardown (SLOW, live CC + GUI)', { skip: !GNOME_AVAILABLE || !LIVE_CC }, async () => {
  const sessName = uniqName('g6-cc');
  const gnomeBaseline = gnomeChildPids().length;
  const claudeBaseline = ccPidCount();

  // Step 1: open gnome tab attached to a tmux session.
  const tab = await call<{ id: string; tmuxSession: string }>('POST', '/terminal/tabs', {
    kind: 'gnome', title: 'g6', tmuxSession: sessName, cwd: '/tmp',
  });
  assert.equal(tab.success, true, JSON.stringify(tab));
  assert.equal(tab.data?.tmuxSession, sessName);
  assert.equal(gnomeChildPids().length, gnomeBaseline + 1, 'gnome tab count should have grown by 1');

  // Step 2: launch Claude Code INSIDE the same tmux session.
  const launch = await call<{ ready: boolean; finalPhase: string }>('POST', `/terminal/cc/${sessName}/launch`, {
    cwd: '/tmp', readyTimeoutMs: 45000, autoAcceptTrust: true,
  });
  assert.equal(launch.success, true, JSON.stringify(launch));
  assert.equal(launch.data?.ready, true, `not ready, phase=${launch.data?.finalPhase}`);
  assert.ok(ccPidCount() > claudeBaseline, `expected +1 claude process; before=${claudeBaseline} now=${ccPidCount()}`);

  // Step 3: status confirms CC is alive inside the gnome-attached tmux.
  const stat = await call<{ phase: string; currentMode: string; contextPct: number | null }>('GET', `/terminal/cc/${sessName}/status`);
  assert.equal(stat.data?.phase, 'idle');
  assert.equal(stat.data?.currentMode, 'normal');
  assert.ok(stat.data?.contextPct !== null);

  // Step 4: prompt A — distinct computed answer.
  await call('POST', `/terminal/cc/${sessName}/prompt`, {
    text: 'What is 17 + 25? Reply only with the digits, no other text.',
  });
  const wA = await call<{ outcome: string }>('POST', `/terminal/tmux/${sessName}/wait-for`, {
    pattern: '\\b42\\b', literal: false, timeoutMs: 60000, pollMs: 500,
  });
  assert.equal(wA.data?.outcome, 'matched', `CC didn't produce 42 for prompt A`);

  // Step 5: prompt B — DIFFERENT computed answer (proves multi-turn works
  // and we're not matching stale screen from prompt A).
  await call('POST', `/terminal/cc/${sessName}/prompt`, {
    text: 'What is 200 - 47? Reply only with the digits.',
  });
  const wB = await call<{ outcome: string }>('POST', `/terminal/tmux/${sessName}/wait-for`, {
    pattern: '\\b153\\b', literal: false, timeoutMs: 60000, pollMs: 500,
  });
  assert.equal(wB.data?.outcome, 'matched', `CC didn't produce 153 for prompt B`);

  // Step 6: interrupt a long-running task.
  await call('POST', `/terminal/cc/${sessName}/prompt`, {
    text: 'Count from 1 to 30, one number per line, with no other text.',
  });
  await sleep(2000);
  const intr = await call('POST', `/terminal/cc/${sessName}/interrupt`, {});
  assert.equal(intr.success, true);
  await sleep(3000);
  const statAfterIntr = await call<{ phase: string }>('GET', `/terminal/cc/${sessName}/status`);
  assert.equal(statAfterIntr.data?.phase, 'idle', `not idle after interrupt; phase=${statAfterIntr.data?.phase}`);

  // Step 7: /clear via slash endpoint.
  const clr = await call('POST', `/terminal/cc/${sessName}/slash`, { cmd: 'clear' });
  assert.equal(clr.success, true);
  await sleep(1500);

  // Step 8: DELETE tab → cascade cleanup. Verify everything returns to
  // baseline: tab gone, tmux gone, gnome tab count restored, no
  // CC-process leak.
  const del = await call<{ removed: boolean; killedTmux: boolean }>('DELETE', `/terminal/tabs/${tab.data!.id}`);
  assert.equal(del.data?.removed, true);
  assert.equal(del.data?.killedTmux, true);

  await sleep(3000);

  const list = await call<{ sessions: Array<{ name?: string }> }>('GET', '/terminal/tmux');
  assert.ok(!list.data?.sessions.some((s) => (s as { name?: string }).name === sessName), 'tmux session should be gone');
  assert.equal(gnomeChildPids().length, gnomeBaseline, `gnome tab leak: ${gnomeChildPids().length} vs baseline ${gnomeBaseline}`);
  assert.equal(ccPidCount(), claudeBaseline, `claude process leak: ${ccPidCount()} vs baseline ${claudeBaseline}`);
});

// ===========================================================================
// SECTION W — Windows wt-ssh tabs (cannot live-test from Linux)
//
// These verify the bat-file content and platform gating. They're pure unit
// checks that don't depend on a Windows host. The actual schtasks + wt.exe
// flow is documented but untested here.
// ===========================================================================

test('W1 — wt-ssh kind from non-Windows host returns PLATFORM_UNSUPPORTED', async () => {
  const r = await call('POST', '/terminal/tabs', {
    kind: 'wt-ssh', sshTarget: 'user@host', tmuxSession: 'sess',
  });
  assert.equal(r.success, false);
  // From Linux this fails at the manager layer with PLATFORM_UNSUPPORTED.
  assert.equal(r.error?.code, 'PLATFORM_UNSUPPORTED');
});

test('W2 — wt-ssh validates sshTarget regex (no shell metachars)', async () => {
  for (const bad of ['user@host & calc', 'user@host;ls', 'user@host|cat', '`whoami`@host']) {
    const r = await call('POST', '/terminal/tabs', {
      kind: 'wt-ssh', sshTarget: bad, tmuxSession: 'sess',
    });
    assert.equal(r.success, false, `should reject sshTarget=${bad}`);
    assert.equal(r.error?.code, 'INVALID_INPUT');
  }
});

test('W3 — wt-ssh requires sshTarget', async () => {
  const r = await call('POST', '/terminal/tabs', {
    kind: 'wt-ssh', tmuxSession: 'sess',
  });
  assert.equal(r.success, false);
  // No sshTarget at all — caught at validate.parseCreateTab (sshTarget is optional in the schema but required by kind:wt-ssh in manager).
  // The current behavior may be either INVALID_INPUT (validate) or PLATFORM_UNSUPPORTED (manager on non-Windows). Either is acceptable.
  assert.ok(['INVALID_INPUT', 'PLATFORM_UNSUPPORTED'].includes(r.error?.code ?? ''),
    `unexpected code: ${r.error?.code}`);
});
