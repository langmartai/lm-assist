import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildColabArgs,
  buildGlobalArgs,
  redactColabText,
  validateGpu,
  validatePackageSpec,
  validateRemotePath,
  validateSessionName,
  validateTpu,
} from '../../colab/colab-service';

test('buildGlobalArgs, buildColabArgs, validators, and redactColabText enforce Colab CLI contracts', () => {
  assert.deepEqual(
    buildGlobalArgs({ auth: 'ADC', oauthConfig: '/home/yi/.colab.json', config: '/home/yi/sessions.json' }),
    ['--auth', 'adc', '-c', '/home/yi/.colab.json', '--config', '/home/yi/sessions.json'],
  );
  assert.throws(() => buildGlobalArgs({ auth: 'invalid-auth' }), /oauth2.*adc/i);

  assert.equal(validateSessionName('trainer_1.gpu-a'), 'trainer_1.gpu-a');
  assert.throws(() => validateSessionName('bad session!'), /session/);
  assert.equal(validateGpu('a100'), 'A100');
  assert.throws(() => validateGpu('V100'), /gpu must be one of/);
  assert.equal(validateTpu('V5E1'), 'v5e1');
  assert.throws(() => validateTpu('v3-8'), /tpu must be one of/);
  assert.equal(validateRemotePath('/content/out.txt'), '/content/out.txt');
  assert.throws(() => validateRemotePath('--recursive'), /must not start with/);
  assert.equal(validatePackageSpec('torch>=2.4.0'), 'torch>=2.4.0');
  assert.throws(() => validatePackageSpec('--index-url=http://bad'), /Invalid package spec/);

  const builtNew = buildColabArgs('new', { session: 'ml1', gpu: 't4', highMem: true });
  assert.deepEqual(builtNew.args, ['new', '-s', 'ml1', '--gpu', 'T4', '--high-mem']);
  assert.throws(() => buildColabArgs('new', { gpu: 'T4', tpu: 'v5e1' }), /at most one/);

  const builtExec = buildColabArgs('exec', { session: 'ml1', code: 'print(123)' });
  assert.deepEqual(builtExec.args, ['exec', '-s', 'ml1']);
  assert.equal(builtExec.stdin, 'print(123)');
  assert.throws(() => buildColabArgs('exec', {}), /requires exactly one/);

  const allowedScript = path.join(os.homedir(), 'colab-scripts', 'train.py');
  const builtRun = buildColabArgs('run', {
    script: allowedScript,
    gpu: 'L4',
    keep: true,
    args: ['--epochs', '3'],
  });
  assert.deepEqual(builtRun.args, ['run', '--gpu', 'L4', '--keep', path.resolve(allowedScript), '--epochs', '3']);

  const forbiddenPath = path.join(path.parse(os.homedir()).root, '__forbidden_colab_root__', 'secret.py');
  assert.throws(() => buildColabArgs('run', { script: forbiddenPath }), /outside allowed directories/);

  const builtInstall = buildColabArgs('install', { session: 'ml1', packages: ['numpy', 'pandas==2.2.0'] });
  assert.deepEqual(builtInstall.args, ['install', '-s', 'ml1', 'numpy', 'pandas==2.2.0']);

  const builtSsh = buildColabArgs('ssh-exec', { session: 'ml1', command: ['nvidia-smi', '-L'] });
  assert.deepEqual(builtSsh.args, ['ssh', '-s', 'ml1', '--', 'nvidia-smi', '-L']);

  const builtLog = buildColabArgs('log', { session: 'ml1', n: 999 });
  assert.deepEqual(builtLog.args, ['log', '-s', 'ml1', '-n', '200']);

  const redacted = redactColabText(
    'Authorization: Bearer abcdef1234567890 token=ya29.a0AfB_test_token_1234 key=AIzaSyTestKey123456789012345 ref=1//09TestRefreshToken12345',
  );
  assert.ok(!redacted.includes('abcdef1234567890'));
  assert.ok(!redacted.includes('a0AfB_test_token_1234'));
  assert.ok(!redacted.includes('SyTestKey123456789012345'));
  assert.ok(!redacted.includes('09TestRefreshToken12345'));
});
