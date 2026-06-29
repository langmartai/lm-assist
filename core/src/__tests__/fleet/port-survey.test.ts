import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseSs, parseWinPorts, collectPorts } from '../../fleet/port-survey';
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

test('parseWinPorts — "port,pid" CSV lines (header skipped)', () => {
  const stdout = '"LocalPort","OwningProcess"\n"3848","4021"\n"3100","777"\n';
  assert.deepEqual(parseWinPorts(stdout), [
    { port: 3848, proto: 'tcp', pid: 4021, proc: null },
    { port: 3100, proto: 'tcp', pid: 777, proc: null },
  ]);
});

test('collectPorts — POSIX uses ss; failure → []', async () => {
  const run: RunCmd = async (cmd) => (cmd === 'ss' ? { stdout: 'LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("x",pid=5,fd=1))', code: 0 } : { stdout: '', code: 1 });
  assert.deepEqual(await collectPorts(run, 'linux'), [{ port: 8080, proto: 'tcp', pid: 5, proc: 'x' }]);
  const bad: RunCmd = async () => ({ stdout: '', code: 1 });
  assert.deepEqual(await collectPorts(bad, 'linux'), []);
});
