import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as exec from '../../utils/exec';
import * as tmux from '../../terminal/tmux';
import { parseSendKeys } from '../../terminal/validate';
import { TerminalError } from '../../terminal/errors';

/**
 * tmux input delivery — byte-exact contract (bl: linux tmux api input bugs).
 *
 * Measured on tmux 3.2a (2026-08-05, raw-mode recorder pane):
 *  - an argument's TRAILING unescaped `;` is a command separator: "echo done;"
 *    delivered "echo done", ";" delivered NOTHING. Escape = insert one
 *    backslash before the final `;` (verified for `;`, `\;`, `;;` tails).
 *  - text starting with `-` errors out entirely ("unknown option") without
 *    `--` ending option parsing.
 *  - enter:true + literal:false appended 'Enter' to the SAME argv; with a
 *    trailing-`;` text the parser split turned 'Enter' into a COMMAND →
 *    "unknown command: Enter" → nothing at all was delivered.
 *  - raw \n/\r pass byte-exact but the receiving app (CC composer, a shell)
 *    treats them as Enter — multiline text submitted line-by-line. The fix
 *    delivers multiline literal text as ONE tmux paste (load-buffer stdin +
 *    paste-buffer -p, bracketed only when the app requested it).
 *
 * These tests pin the ARGV CONTRACT of sendKeysUnlocked via a mocked
 * utils/exec.execFileSync — no real tmux involved.
 */

type Call = { file: string; args: string[]; options: Record<string, unknown> | undefined };
let calls: Call[] = [];

function installExecMock(opts: { hasSession?: boolean } = {}): void {
  calls = [];
  mock.method(exec, 'execFileSync', ((file: string, args: readonly string[], options?: Record<string, unknown>) => {
    calls.push({ file, args: [...args], options });
    if (args[0] === 'has-session' && opts.hasSession === false) {
      const e = new Error('no such session') as Error & { stderr: string };
      e.stderr = "can't find session";
      throw e;
    }
    return '';
  }) as typeof exec.execFileSync);
}

afterEach(() => mock.restoreAll());

/** All calls after the has-session existence probe. */
const sent = () => calls.filter((c) => c.args[0] !== 'has-session');

// ── literal text hazards ─────────────────────────────────────────────────

test('literal text ending in `;` is escaped so the semicolon survives', () => {
  installExecMock();
  tmux.sendKeysUnlocked('s', { keys: 'echo done;', literal: true, enter: false, paneQualifier: null });
  assert.deepEqual(sent()[0].args, ['send-keys', '-t', 's', '-l', '--', 'echo done\\;']);
});

test('a lone `;` (which tmux delivered as NOTHING) is escaped', () => {
  installExecMock();
  tmux.sendKeysUnlocked('s', { keys: ';', literal: true, enter: false, paneQualifier: null });
  assert.deepEqual(sent()[0].args, ['send-keys', '-t', 's', '-l', '--', '\\;']);
});

test('literal text starting with `-` is protected by `--`', () => {
  installExecMock();
  tmux.sendKeysUnlocked('s', { keys: '-v foo', literal: true, enter: false, paneQualifier: null });
  assert.deepEqual(sent()[0].args, ['send-keys', '-t', 's', '-l', '--', '-v foo']);
});

test('non-literal single string gets the same trailing-`;` escape and `--`', () => {
  installExecMock();
  tmux.sendKeysUnlocked('s', { keys: 'trailing;', literal: false, enter: false, paneQualifier: null });
  assert.deepEqual(sent()[0].args, ['send-keys', '-t', 's', '--', 'trailing\\;']);
});

test('mid-string `;` and trailing `\\;` are escaped only at the final position', () => {
  installExecMock();
  tmux.sendKeysUnlocked('s', { keys: 'a;b\\;', literal: true, enter: false, paneQualifier: null });
  // Desired delivery "a;b\;": mid `;` untouched, one backslash inserted before the final `;`.
  assert.deepEqual(sent()[0].args, ['send-keys', '-t', 's', '-l', '--', 'a;b\\\\;']);
});

// ── Enter is always its own call ─────────────────────────────────────────

test('enter:true never rides in the same argv as the text (the fatal split)', () => {
  installExecMock();
  tmux.sendKeysUnlocked('s', { keys: 'trailing;', literal: false, enter: true, paneQualifier: null });
  const s = sent();
  assert.equal(s.length, 2);
  assert.ok(!s[0].args.includes('Enter'), 'text argv must not carry Enter');
  assert.deepEqual(s[1].args, ['send-keys', '-t', 's', 'Enter']);
});

// ── multiline literal text goes as ONE paste ─────────────────────────────

test('multiline literal text is delivered via load-buffer + paste-buffer -p, not send-keys', () => {
  installExecMock();
  tmux.sendKeysUnlocked('s', { keys: 'line1\nline2\nline3', literal: true, enter: false, paneQualifier: null });
  const s = sent();
  assert.equal(s[0].args[0], 'load-buffer');
  assert.equal(s[0].options?.input, 'line1\nline2\nline3', 'text travels on stdin, not argv');
  const bufIdx = s[0].args.indexOf('-b');
  assert.ok(bufIdx >= 0, 'load-buffer names its buffer');
  const buf = s[0].args[bufIdx + 1];
  assert.equal(s[1].args[0], 'paste-buffer');
  for (const flag of ['-d', '-p']) assert.ok(s[1].args.includes(flag), `paste-buffer carries ${flag}`);
  assert.equal(s[1].args[s[1].args.indexOf('-b') + 1], buf, 'paste uses the same buffer');
  assert.deepEqual(s[1].args.slice(-2), ['-t', 's']);
  assert.ok(!s.some((c) => c.args[0] === 'send-keys'), 'no send-keys carries the multiline text');
});

test('multiline + enter: Enter is a separate send-keys AFTER the paste', () => {
  installExecMock();
  tmux.sendKeysUnlocked('s', { keys: 'a\nb', literal: true, enter: true, paneQualifier: null });
  const s = sent();
  assert.deepEqual(s.map((c) => c.args[0]), ['load-buffer', 'paste-buffer', 'send-keys']);
  assert.deepEqual(s[2].args, ['send-keys', '-t', 's', 'Enter']);
});

test('CRLF is collapsed to LF before the paste (else it lands as a double break)', () => {
  installExecMock();
  tmux.sendKeysUnlocked('s', { keys: 'l1\r\nl2', literal: true, enter: false, paneQualifier: null });
  const load = sent().find((c) => c.args[0] === 'load-buffer');
  assert.equal(load?.options?.input, 'l1\nl2');
});

test('concurrent pastes use distinct buffer names', () => {
  installExecMock();
  tmux.sendKeysUnlocked('s', { keys: 'x\ny', literal: true, enter: false, paneQualifier: null });
  tmux.sendKeysUnlocked('s', { keys: 'p\nq', literal: true, enter: false, paneQualifier: null });
  const loads = calls.filter((c) => c.args[0] === 'load-buffer');
  const names = loads.map((c) => c.args[c.args.indexOf('-b') + 1]);
  assert.notEqual(names[0], names[1]);
});

// ── named special keys ───────────────────────────────────────────────────

test('keyNames are sent as one non-literal call with `--`', () => {
  installExecMock();
  tmux.sendKeysUnlocked('s', { keyNames: ['Escape', 'Up', 'Enter'], literal: false, enter: false, paneQualifier: null });
  assert.deepEqual(sent()[0].args, ['send-keys', '-t', 's', '--', 'Escape', 'Up', 'Enter']);
});

test('keyNames outside the allowlist are refused before anything is sent', () => {
  installExecMock();
  for (const key of ['C-c', 'C-d', 'C-z', 'kill-server', ';', 'Escape;']) {
    assert.throws(
      () => tmux.sendKeysUnlocked('s', { keyNames: [key], literal: false, enter: false, paneQualifier: null }),
      (e: unknown) => e instanceof TerminalError && e.code === 'INVALID_INPUT',
      `${key} must be refused`,
    );
  }
  assert.equal(sent().length, 0, 'nothing was sent for refused keys');
});

test('text + keyNames + enter compose in order: text, keys, Enter', () => {
  installExecMock();
  tmux.sendKeysUnlocked('s', { text: 'pick one', keyNames: ['Down', 'Down'], literal: false, enter: true, paneQualifier: null });
  const s = sent();
  assert.deepEqual(s[0].args, ['send-keys', '-t', 's', '-l', '--', 'pick one']);
  assert.deepEqual(s[1].args, ['send-keys', '-t', 's', '--', 'Down', 'Down']);
  assert.deepEqual(s[2].args, ['send-keys', '-t', 's', 'Enter']);
});

test('paneQualifier still scopes the target for every targeted sub-call', () => {
  installExecMock();
  tmux.sendKeysUnlocked('s', { text: 'a\nb', keyNames: ['Escape'], literal: false, enter: true, paneQualifier: '0.1' });
  // load-buffer has no target (it only fills the buffer); paste-buffer and
  // both send-keys calls must all aim at the qualified pane.
  const targeted = sent().filter((c) => c.args.includes('-t'));
  assert.equal(targeted.length, 3, 'paste-buffer + keys + Enter each carry -t');
  for (const c of targeted) {
    assert.equal(c.args[c.args.indexOf('-t') + 1], 's:0.1');
  }
});

test('missing session still raises SESSION_NOT_FOUND before any send', () => {
  installExecMock({ hasSession: false });
  assert.throws(
    () => tmux.sendKeysUnlocked('nope', { keys: 'x', literal: true, enter: false, paneQualifier: null }),
    (e: unknown) => e instanceof TerminalError && e.code === 'SESSION_NOT_FOUND',
  );
});

// ── validate.parseSendKeys extension ─────────────────────────────────────

test('parseSendKeys: legacy string body is unchanged', () => {
  const p = parseSendKeys({ keys: 'hello', literal: true, enter: true });
  assert.equal(p.keys, 'hello');
  assert.equal(p.literal, true);
  assert.equal(p.enter, true);
  assert.deepEqual(p.keyNames ?? [], []);
  assert.equal(p.text ?? null, null);
});

test('parseSendKeys: keys as array becomes validated keyNames', () => {
  const p = parseSendKeys({ keys: ['Escape', 'Up', 'BTab', 'M-Enter', 'F5', 'C-l'] });
  assert.deepEqual(p.keyNames, ['Escape', 'Up', 'BTab', 'M-Enter', 'F5', 'C-l']);
  assert.equal(p.keys, null);
});

test('parseSendKeys: rejects unknown key names, C-c, empty array, literal+array', () => {
  for (const body of [
    { keys: ['NotAKey'] },
    { keys: ['C-c'] },
    { keys: [] },
    { keys: ['Escape'], literal: true },
  ]) {
    assert.throws(() => parseSendKeys(body), (e: unknown) => e instanceof TerminalError && e.code === 'INVALID_INPUT');
  }
});

test('parseSendKeys: text field, enter-only, and empty bodies', () => {
  const p = parseSendKeys({ text: 'multi\nline', enter: true });
  assert.equal(p.text, 'multi\nline');
  const enterOnly = parseSendKeys({ enter: true });
  assert.equal(enterOnly.enter, true);
  assert.throws(() => parseSendKeys({}), (e: unknown) => e instanceof TerminalError && e.code === 'INVALID_INPUT');
});
