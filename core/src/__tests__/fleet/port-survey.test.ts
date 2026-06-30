import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseSs, parseNetstat, collectPorts, dedupePorts } from '../../fleet/port-survey';
import type { RunCmd } from '../../fleet/run-cmd';

test('dedupePorts — collapses (proto,port) duplicates, prefers the entry carrying a pid', () => {
  assert.deepEqual(dedupePorts([
    { port: 80, proto: 'tcp', pid: null, proc: null },     // v4, no pid
    { port: 80, proto: 'tcp', pid: 5, proc: 'nginx' },     // v6, has pid → wins
    { port: 80, proto: 'tcp', pid: 9, proc: 'other' },     // later pid ignored (first non-null wins)
    { port: 22, proto: 'tcp', pid: 7, proc: 'sshd' },
  ]), [
    { port: 80, proto: 'tcp', pid: 5, proc: 'nginx' },
    { port: 22, proto: 'tcp', pid: 7, proc: 'sshd' },
  ]);
});

test('collectPorts — dedups IPv4+IPv6 listeners on the same port (ss + netstat)', async () => {
  const ssRun: RunCmd = async (cmd) => (cmd === 'ss' ? { stdout: [
    'LISTEN 0 511 0.0.0.0:3100 0.0.0.0:* users:(("node",pid=12,fd=1))',
    'LISTEN 0 511 [::]:3100 [::]:* users:(("node",pid=12,fd=2))',   // dup (v6)
    'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*',                            // no pid
    'LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=7,fd=3))',      // dup (v6) WITH pid → preferred
  ].join('\n'), code: 0 } : { stdout: '', code: 1 });
  const r = (await collectPorts(ssRun, 'linux')).sort((a, b) => a.port - b.port);
  assert.deepEqual(r, [
    { port: 22, proto: 'tcp', pid: 7, proc: 'sshd' },
    { port: 3100, proto: 'tcp', pid: 12, proc: 'node' },
  ]);

  const nsRun: RunCmd = async (cmd) => (cmd === 'netstat' ? { stdout: [
    '  TCP    0.0.0.0:3100   0.0.0.0:0   LISTENING   100',
    '  TCP    [::]:3100      [::]:0      LISTENING   100',           // dup (v6)
  ].join('\n'), code: 0 } : { stdout: '', code: 1 });
  assert.deepEqual(await collectPorts(nsRun, 'win32'), [{ port: 3100, proto: 'tcp', pid: 100, proc: null }]);
});

test('parseSs — extracts port, pid, proc from ss -H -tlnp lines', () => {
  const stdout = [
    'LISTEN 0 511 0.0.0.0:3100 0.0.0.0:* users:(("node",pid=1234,fd=18))',
    'LISTEN 0 4096 [::]:5432 [::]:* users:(("postgres",pid=99,fd=7))',
    'LISTEN 0 128 127.0.0.1:6379 0.0.0.0:*',
  ].join('\n');
  const r = parseSs(stdout);
  assert.deepEqual(r, [
    { port: 3100, proto: 'tcp', pid: 1234, proc: 'node' },
    { port: 5432, proto: 'tcp', pid: 99, proc: 'postgres' },
    { port: 6379, proto: 'tcp', pid: null, proc: null },
  ]);
});

test('parseNetstat — listening TCP rows → {port,pid}; IPv6 + non-LISTENING/UDP skipped', () => {
  const stdout = [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:3100           0.0.0.0:0              LISTENING       178680',
    '  TCP    [::]:3848              [::]:0                 LISTENING       4021',
    '  TCP    10.0.1.107:58007       172.67.158.86:443      ESTABLISHED     161104',
    '  UDP    0.0.0.0:5353           *:*                                    1234',
  ].join('\n');
  assert.deepEqual(parseNetstat(stdout), [
    { port: 3100, proto: 'tcp', pid: 178680, proc: null },
    { port: 3848, proto: 'tcp', pid: 4021, proc: null },
  ]);
});

test('collectPorts — POSIX uses ss; Windows uses netstat; failure → []', async () => {
  const ssRun: RunCmd = async (cmd) => (cmd === 'ss' ? { stdout: 'LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("x",pid=5,fd=1))', code: 0 } : { stdout: '', code: 1 });
  assert.deepEqual(await collectPorts(ssRun, 'linux'), [{ port: 8080, proto: 'tcp', pid: 5, proc: 'x' }]);

  const nsRun: RunCmd = async (cmd) => (cmd === 'netstat' ? { stdout: '  TCP    0.0.0.0:9000   0.0.0.0:0   LISTENING   42', code: 0 } : { stdout: '', code: 1 });
  assert.deepEqual(await collectPorts(nsRun, 'win32'), [{ port: 9000, proto: 'tcp', pid: 42, proc: null }]);

  const bad: RunCmd = async () => ({ stdout: '', code: 1 });
  assert.deepEqual(await collectPorts(bad, 'linux'), []);
  assert.deepEqual(await collectPorts(bad, 'win32'), []);
});
