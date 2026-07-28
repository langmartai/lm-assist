/**
 * git/clone credential resolution.
 *
 * Measured 2026-07-28 on node yitest: `github_mutate git/clone` of the PUBLIC
 * repo langmartai/lm-assist failed with AUTH_MISSING because that host holds
 * no token and no SSH key. An anonymous https clone would have succeeded — the
 * URL is identical to the token URL, only the auth header differs.
 *
 * The fail-closed rule this collided with ("an unresolved account never falls
 * back") is about IMPERSONATION: if you ask to act as account X and X has no
 * credential, using someone else's is wrong. An anonymous clone asserts no
 * identity at all, so that rule does not apply to it. Requesting a specific
 * `account` that cannot be resolved is still refused elsewhere.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  resolveCloneRemote,
  classifyCloneError,
} from '../github/github-service';

const REPO = { owner: 'langmartai', repo: 'lm-assist' };

test('ssh uses the git@ remote and sets no auth header', () => {
  const r = resolveCloneRemote({ ...REPO, ssh: true });
  assert.strictEqual(r.url, 'git@github.com:langmartai/lm-assist.git');
  assert.deepStrictEqual(r.env, {});
  assert.strictEqual(r.anonymous, false);
});

test('ssh honours a custom host', () => {
  const r = resolveCloneRemote({ ...REPO, ssh: true, sshHost: 'github.example.com' });
  assert.strictEqual(r.url, 'git@github.example.com:langmartai/lm-assist.git');
});

test('a token uses https and carries an auth header', () => {
  const r = resolveCloneRemote({ ...REPO, token: 'ghp_example' });
  assert.strictEqual(r.url, 'https://github.com/langmartai/lm-assist.git');
  assert.strictEqual(r.anonymous, false);
  assert.ok(Object.keys(r.env).length > 0, 'expected an auth env');
  assert.ok(
    JSON.stringify(r.env).includes('Authorization'),
    'expected an Authorization header in the git config env',
  );
});

test('no credential still yields a usable https remote (the fix)', () => {
  const r = resolveCloneRemote({ ...REPO });
  assert.strictEqual(r.url, 'https://github.com/langmartai/lm-assist.git');
});

test('no credential sends NO auth header and is flagged anonymous', () => {
  const r = resolveCloneRemote({ ...REPO });
  assert.deepStrictEqual(r.env, {}, 'must not leak an empty/garbage credential');
  assert.strictEqual(r.anonymous, true);
});

test('an empty-string token is treated as no credential, not as a credential', () => {
  const r = resolveCloneRemote({ ...REPO, token: '' });
  assert.strictEqual(r.anonymous, true);
  assert.deepStrictEqual(r.env, {});
});

test('ssh takes precedence over a token', () => {
  const r = resolveCloneRemote({ ...REPO, ssh: true, token: 'ghp_example' });
  assert.ok(r.url.startsWith('git@'));
  assert.deepStrictEqual(r.env, {});
});

// --- error classification --------------------------------------------------

test('an auth failure classifies as AUTH_INVALID', () => {
  const r = classifyCloneError('remote: Authentication failed for ...', false);
  assert.strictEqual(r.code, 'AUTH_INVALID');
});

test('a missing repo classifies as NOT_FOUND', () => {
  const r = classifyCloneError("remote: Repository not found.", false);
  assert.strictEqual(r.code, 'NOT_FOUND');
});

test('an authenticated NOT_FOUND is not blamed on a missing credential', () => {
  const r = classifyCloneError('remote: Repository not found.', false);
  assert.ok(!/anonymous/i.test(r.message), 'must not mention anonymity when authenticated');
});

test('an anonymous NOT_FOUND explains that a private repo looks identical', () => {
  // Otherwise dropping the AUTH_MISSING refusal would make diagnostics WORSE:
  // "not found" alone reads as "this repo does not exist".
  const r = classifyCloneError('remote: Repository not found.', true);
  assert.strictEqual(r.code, 'NOT_FOUND');
  assert.match(r.message, /private|credential/i);
});

test('anything else classifies as GIT_ERROR and keeps the original text', () => {
  const r = classifyCloneError('fatal: unable to access: Could not resolve host', false);
  assert.strictEqual(r.code, 'GIT_ERROR');
  assert.ok(r.message.includes('Could not resolve host'));
});

test('a long stderr is truncated rather than echoed whole', () => {
  const r = classifyCloneError('x'.repeat(5000), false);
  assert.ok(r.message.length <= 400, `message was ${r.message.length} chars`);
});
