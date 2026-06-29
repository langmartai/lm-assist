import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseSs, parseNetstat, collectPorts } from '../../fleet/port-survey';
import type { RunCmd } from '../../fleet/run-cmd';

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
