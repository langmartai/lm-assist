import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { runColabAction, type ColabExecFn } from '../../colab/colab-service';

test('runColabAction handles doctor, session lifecycle, exec, install, ssh-exec, and error mapping', async () => {
  const calls: Array<{ cmd: string; args: string[]; stdin?: string }> = [];
  const mockExec: ColabExecFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, stdin: opts?.stdin });
    if (args[0] === 'version') {
      return { code: 0, stdout: 'google-colab-cli 0.2.1\n', stderr: '' };
    }
    return { code: 0, stdout: `OK:${args.join(' ')}`, stderr: '' };
  };

  const doc = await runColabAction('doctor', {}, { execFn: mockExec, platform: 'linux', bin: '/home/yi/.local/bin/colab' });
  assert.equal(doc.ok, true);
  if (doc.ok) {
    assert.equal(doc.data.supportedPlatform, true);
    assert.equal(doc.data.installed, true);
    assert.equal(doc.data.version, 'google-colab-cli 0.2.1');
  }

  const sessRes = await runColabAction('sessions', {}, { execFn: mockExec, platform: 'linux', bin: 'colab' });
  assert.equal(sessRes.ok, true);

  const newRes = await runColabAction(
    'new',
    { auth: 'adc', session: 'g1', gpu: 'A100' },
    { execFn: mockExec, platform: 'linux', bin: 'colab' },
  );
  assert.equal(newRes.ok, true);
  assert.deepEqual(calls.at(-1)?.args, ['--auth', 'adc', 'new', '-s', 'g1', '--gpu', 'A100']);

  const execRes = await runColabAction(
    'exec',
    { session: 'g1', code: 'import torch\nprint(1)' },
    { execFn: mockExec, platform: 'linux', bin: 'colab' },
  );
  assert.equal(execRes.ok, true);
  assert.deepEqual(calls.at(-1)?.args, ['exec', '-s', 'g1']);
  assert.equal(calls.at(-1)?.stdin, 'import torch\nprint(1)');

  const installRes = await runColabAction(
    'install',
    { session: 'g1', packages: ['torch'] },
    { execFn: mockExec, platform: 'linux', bin: 'colab' },
  );
  assert.equal(installRes.ok, true);
  assert.deepEqual(calls.at(-1)?.args, ['install', '-s', 'g1', 'torch']);

  const sshRes = await runColabAction(
    'ssh-exec',
    { session: 'g1', command: ['nvidia-smi'] },
    { execFn: mockExec, platform: 'linux', bin: 'colab' },
  );
  assert.equal(sshRes.ok, true);
  assert.deepEqual(calls.at(-1)?.args, ['ssh', '-s', 'g1', '--', 'nvidia-smi']);

  const stopRes = await runColabAction('stop', { session: 'g1' }, { execFn: mockExec, platform: 'linux', bin: 'colab' });
  assert.equal(stopRes.ok, true);
  assert.deepEqual(calls.at(-1)?.args, ['stop', '-s', 'g1']);

  const forbiddenRes = await runColabAction(
    'run',
    { script: path.join(path.parse(os.homedir()).root, '__forbidden__', 'bad.py') },
    { execFn: mockExec, platform: 'linux', bin: 'colab' },
  );
  assert.equal(forbiddenRes.ok, false);
  if (!forbiddenRes.ok) assert.equal(forbiddenRes.error.code, 'FORBIDDEN');

  const missingExec: ColabExecFn = async () => ({ code: -1, stdout: '', stderr: 'spawn colab ENOENT', errno: 'ENOENT' });
  const linuxMissing = await runColabAction('sessions', {}, { execFn: missingExec, platform: 'linux', bin: 'colab' });
  assert.equal(linuxMissing.ok, false);
  if (!linuxMissing.ok) assert.equal(linuxMissing.error.code, 'CLI_NOT_INSTALLED');

  const winMissing = await runColabAction('sessions', {}, { execFn: missingExec, platform: 'win32', bin: 'colab' });
  assert.equal(winMissing.ok, false);
  if (!winMissing.ok) assert.equal(winMissing.error.code, 'UNSUPPORTED_PLATFORM');

  const authExec: ColabExecFn = async () => ({
    code: 1,
    stdout: '',
    stderr: 'Error: OAuth2 credentials expired (Bearer ya29.secret_token_should_redact)',
  });
  const authRes = await runColabAction('sessions', {}, { execFn: authExec, platform: 'linux', bin: 'colab' });
  assert.equal(authRes.ok, false);
  if (!authRes.ok) {
    assert.equal(authRes.error.code, 'AUTH_REQUIRED');
    assert.ok(!authRes.error.message.includes('secret_token_should_redact'));
  }
});
