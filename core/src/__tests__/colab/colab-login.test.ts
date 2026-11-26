import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  clearPendingColabLogins,
  completeColabLogin,
  detectKeyringWarning,
  extractColabAuthUrl,
  parseColabWhoami,
  startColabLogin,
  type ColabChildLike,
  type ColabSpawnFn,
} from '../../colab/colab-login';
import { runColabAction, type ColabExecFn } from '../../colab/colab-service';
import { createColabRoutes } from '../../routes/core/colab.routes';

function makeMockChild(): ColabChildLike & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
} {
  const child = new EventEmitter() as ColabChildLike & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: () => boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

test('colab guided login, whoami parsing, doctor auth detection, and login routes work end-to-end', async () => {
  const whoamiSample = [
    'Auth provider: oauth2',
    'Email:         alice@example.com',
    'Audience:      764086051850',
    'Expires in:    58m',
    'Scopes:',
    '  - openid',
    '  - https://www.googleapis.com/auth/colaboratory',
  ].join('\n');

  const parsed = parseColabWhoami(whoamiSample);
  assert.equal(parsed.provider, 'oauth2');
  assert.equal(parsed.email, 'alice@example.com');
  assert.equal(parsed.expiresIn, '58m');
  assert.deepEqual(parsed.scopes, ['openid', 'https://www.googleapis.com/auth/colaboratory']);

  assert.equal(
    extractColabAuthUrl('Visit:\n  https://accounts.google.com/o/oauth2/auth?client_id=123&scope=colab\n'),
    'https://accounts.google.com/o/oauth2/auth?client_id=123&scope=colab',
  );
  assert.match(
    detectKeyringWarning('Warning: Keyring \'login\' is locked; waiting on unlock prompt for 30s.') || '',
    /is locked/,
  );

  // 1. Two-step awaiting_code -> completeColabLogin flow (with keyring warning).
  let sentCode = '';
  const twoStepSpawn: ColabSpawnFn = () => {
    const c = makeMockChild();
    c.stdin.on('data', (chunk: Buffer) => {
      sentCode += chunk.toString();
    });
    c.stdin.on('end', () => {
      c.stdout.write(whoamiSample + '\n');
      c.emit('close', 0);
    });
    setTimeout(() => {
      c.stderr.write(
        "Warning: Keyring 'Default keyring' is locked; waiting on unlock prompt for 30s (use --auth=adc if keyring can't be unlocked).\n" +
          'To authorize colab-cli, visit this URL in any browser:\n\n' +
          '  https://accounts.google.com/o/oauth2/auth?response_type=code&token_usage=remote\n\n' +
          'Enter the authorization code: ',
      );
    }, 10);
    return c;
  };

  const started = await startColabLogin({}, { bin: 'colab', platform: 'linux', spawnFn: twoStepSpawn });
  assert.equal(started.ok, true);
  if (started.ok) {
    assert.equal(started.data.status, 'awaiting_code');
    assert.equal(started.data.loggedIn, false);
    assert.equal(
      started.data.authUrl,
      'https://accounts.google.com/o/oauth2/auth?response_type=code&token_usage=remote',
    );
    assert.match(String(started.data.keyringWarning || ''), /is locked/);

    const completed = await completeColabLogin({
      loginId: String(started.data.loginId),
      code: '4/0ATX_TEST_CODE',
    });
    assert.equal(sentCode.trim(), '4/0ATX_TEST_CODE');
    assert.equal(completed.ok, true);
    if (completed.ok) {
      assert.equal(completed.data.status, 'logged_in');
      assert.equal(completed.data.loggedIn, true);
      assert.equal(completed.data.email, 'alice@example.com');
      assert.equal(completed.data.persisted, false);
    }
  }

  // 2. Clean already_logged_in flow (no keyring warning).
  const alreadySpawn: ColabSpawnFn = () => {
    const c = makeMockChild();
    setTimeout(() => {
      c.stdout.write(whoamiSample + '\n');
      c.emit('close', 0);
    }, 10);
    return c;
  };
  const already = await startColabLogin({}, { bin: 'colab', platform: 'linux', spawnFn: alreadySpawn });
  assert.equal(already.ok, true);
  if (already.ok) {
    assert.equal(already.data.status, 'already_logged_in');
    assert.equal(already.data.loggedIn, true);
    assert.equal(already.data.email, 'alice@example.com');
  }

  // 3. Doctor auth detection: signed out vs signed in.
  const signedOutExec: ColabExecFn = async (_cmd, args) => {
    if (args[0] === 'version') return { code: 0, stdout: 'Version: 0.2.1\n', stderr: '' };
    return {
      code: 1,
      stdout: '',
      stderr: 'To authorize colab-cli, visit this URL in any browser:\nEOFError: EOF when reading a line',
    };
  };
  const docOut = await runColabAction('doctor', {}, { execFn: signedOutExec, platform: 'linux', bin: 'colab' });
  assert.equal(docOut.ok, true);
  if (docOut.ok) {
    assert.equal(docOut.data.installed, true);
    assert.equal(docOut.data.loggedIn, false);
    assert.equal(docOut.data.authRequired, true);
    assert.match(String(docOut.data.loginGuide), /\/colab\/login\/start/);
  }

  const signedInExec: ColabExecFn = async (_cmd, args) => {
    if (args[0] === 'version') return { code: 0, stdout: 'Version: 0.2.1\n', stderr: '' };
    return { code: 0, stdout: whoamiSample, stderr: '' };
  };
  const docIn = await runColabAction('doctor', {}, { execFn: signedInExec, platform: 'linux', bin: 'colab' });
  assert.equal(docIn.ok, true);
  if (docIn.ok) {
    assert.equal(docIn.data.loggedIn, true);
    assert.equal(docIn.data.authRequired, false);
    assert.equal(docIn.data.email, 'alice@example.com');
  }

  // 4. Routes ordering and validation.
  const routes = createColabRoutes({} as never);
  const loginStatusIdx = routes.findIndex((r) => r.method === 'GET' && r.pattern.test('/colab/login/status'));
  const loginStartIdx = routes.findIndex((r) => r.method === 'POST' && r.pattern.test('/colab/login/start'));
  const loginCompleteIdx = routes.findIndex((r) => r.method === 'POST' && r.pattern.test('/colab/login/complete'));
  const genericPostIdx = routes.findIndex((r) => r.method === 'POST' && r.pattern.source === '^\\/colab\\/(?<action>.+)$');
  assert.ok(loginStatusIdx >= 0 && loginStartIdx >= 0 && loginCompleteIdx >= 0);
  assert.ok(loginStartIdx < genericPostIdx && loginCompleteIdx < genericPostIdx);

  const statusRes = (await routes[loginStatusIdx].handler(
    { method: 'GET', path: '/colab/login/status', params: {}, query: {}, body: {} } as never,
    undefined as never,
  )) as { success: boolean; data?: { platform: string } };
  assert.equal(statusRes.success, true);

  const badComplete = (await routes[loginCompleteIdx].handler(
    { method: 'POST', path: '/colab/login/complete', params: {}, query: {}, body: {} } as never,
    undefined as never,
  )) as { success: boolean; error?: { code: string } };
  assert.equal(badComplete.success, false);
  assert.equal(badComplete.error?.code, 'VALIDATION');

  clearPendingColabLogins();
});
