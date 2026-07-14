import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSshProbeArgs, classifyProbe } from '../machine-access/probe';
import type { SshAccess } from '../machine-access/store';

const ssh = (over: Partial<SshAccess> = {}): SshAccess => ({ type: 'ssh', host: 'h.example', user: 'u', ...over });

describe('buildSshProbeArgs', () => {
  it('always non-interactive, never mutates known_hosts, ends with a portable exit', () => {
    const a = buildSshProbeArgs(ssh(), { connectTimeout: 8 });
    assert.ok(a.includes('-oBatchMode=yes'));
    assert.ok(a.includes('-oConnectTimeout=8'));
    assert.ok(a.includes('-oStrictHostKeyChecking=yes')); // unknown key surfaced, never trusted
    // remote command is the portable `exit` builtin (sh/cmd/PowerShell) — NOT POSIX-only `true`
    assert.equal(a[a.length - 1], 'exit');
    assert.equal(a[a.length - 2], 'u@h.example'); // target immediately before the command
    assert.equal(a.includes('true'), false);
    assert.equal(a.includes('--'), false);
  });

  it('adds -i + IdentitiesOnly only when a key is set', () => {
    assert.equal(buildSshProbeArgs(ssh(), { connectTimeout: 8 }).includes('-oIdentitiesOnly=yes'), false);
    const withKey = buildSshProbeArgs(ssh({ identityFile: '~/.ssh/k' }), { connectTimeout: 8 });
    assert.ok(withKey.includes('-oIdentitiesOnly=yes'));
    const i = withKey.indexOf('-i');
    assert.equal(withKey[i + 1], '~/.ssh/k');
  });

  it('adds -p only for a non-default port', () => {
    assert.equal(buildSshProbeArgs(ssh(), { connectTimeout: 8 }).includes('-p'), false);
    assert.equal(buildSshProbeArgs(ssh({ port: 22 }), { connectTimeout: 8 }).includes('-p'), false);
    const p = buildSshProbeArgs(ssh({ port: 2222 }), { connectTimeout: 8 });
    assert.equal(p[p.indexOf('-p') + 1], '2222');
  });
});

describe('classifyProbe', () => {
  it('exit 0 → ok', () => {
    assert.equal(classifyProbe(0, '').status, 'ok');
  });
  it('permission denied → auth-failed (host WAS reached)', () => {
    assert.equal(classifyProbe(255, 'user@h: Permission denied (publickey).').status, 'auth-failed');
  });
  it('host key verification → host-key-unverified', () => {
    assert.equal(classifyProbe(255, 'Host key verification failed.').status, 'host-key-unverified');
  });
  it('network failures → unreachable', () => {
    assert.equal(classifyProbe(255, 'ssh: Could not resolve hostname h: Name or service not known').status, 'unreachable');
    assert.equal(classifyProbe(255, 'ssh: connect to host h port 22: Connection refused').status, 'unreachable');
    assert.equal(classifyProbe(255, 'ssh: connect to host h port 22: Connection timed out').status, 'unreachable');
  });
  it('anything else → error with a trimmed detail tail', () => {
    const r = classifyProbe(1, 'some other failure');
    assert.equal(r.status, 'error');
    assert.match(r.detail ?? '', /some other failure/);
  });
});
