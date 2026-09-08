import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * /harness/status and PUT /harness/provider/:name.
 *
 * The single property both surfaces must hold: a provider profile holds a REAL
 * credential, and neither reading the status nor writing a profile may hand it
 * back out. The write path is the riskier half — an endpoint that stores a key
 * is an obvious place to accidentally echo one — so it is asserted directly
 * against the serialised response, not merely against the fields we remembered
 * to check.
 *
 * The store is redirected with LM_ASSIST_DATA_DIR so these tests never touch the
 * operator's real ~/.lm-assist/harness-providers*.json.
 */

import { handleHarnessStatus, handleProviderPut } from '../routes/core/harness.routes';
import { registerHarness } from '../harness/registry';
import { createQwenHarness } from '../harness/qwen';
import { loadProviderConfig } from '../harness/provider-config';
import type { ParsedRequest } from '../routes/index';

let dataDir: string;
let savedDataDir: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

before(() => {
  savedDataDir = process.env.LM_ASSIST_DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-routes-'));
  process.env.LM_ASSIST_DATA_DIR = dataDir;
  // The env fallback would otherwise synthesise a profile from the operator's
  // own shell and make these assertions depend on where they are run.
  for (const k of ['LM_HARNESS_BASE_URL', 'LM_HARNESS_API_KEY', 'LM_HARNESS_MODEL']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  registerHarness(createQwenHarness());
});

after(() => {
  if (savedDataDir === undefined) delete process.env.LM_ASSIST_DATA_DIR;
  else process.env.LM_ASSIST_DATA_DIR = savedDataDir;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const SECRET = 'sk-do-not-echo-me-0123456789';

const req = (over: Partial<ParsedRequest> = {}): ParsedRequest =>
  ({ method: 'PUT', path: '/harness/provider/x', params: {}, query: {}, body: {}, clientIp: '127.0.0.1', ...over });

test('status lists every runner with its capabilities, and probes only what is probeable', async () => {
  const res = await handleHarnessStatus();
  assert.equal(res.success, true);
  const data = res.data as any;

  const ids = data.harnesses.map((h: any) => h.id);
  assert.ok(ids.includes('sdk') && ids.includes('tmux'), 'the builtins must appear');
  assert.ok(ids.includes('qwen'), 'a registered harness must appear');

  const qwen = data.harnesses.find((h: any) => h.id === 'qwen');
  assert.equal(qwen.pluggable, true);
  assert.equal(qwen.displayName, 'Qwen Code');
  assert.equal(typeof qwen.capabilities.cost, 'string');
  assert.equal(qwen.capabilities.abortable, true);
  assert.ok(qwen.probe && typeof qwen.probe.available === 'boolean', 'a probeable harness must report a probe result');

  const sdk = data.harnesses.find((h: any) => h.id === 'sdk');
  assert.equal(sdk.pluggable, false);
  assert.equal(sdk.probe, null, 'a builtin must not claim an availability nothing measured');
});

test('a write from off-box is refused before anything is stored', async () => {
  const res = await handleProviderPut('lan', req({ clientIp: '10.0.1.42', body: { baseUrl: 'https://gw.example/v1', apiKey: SECRET } }), {
    baseUrl: 'https://gw.example/v1',
    apiKey: SECRET,
  });

  assert.equal(res.success, false);
  assert.equal(res.error!.code, 'FORBIDDEN');
  assert.equal(loadProviderConfig().profiles.lan, undefined, 'a refused write must not have written');
});

test('a profile is stored 0600 and the key never comes back out', async () => {
  const res = await handleProviderPut('gw', req(), { baseUrl: 'https://gw.example/native/x/v1', apiKey: SECRET, model: 'vendor/m:free', note: 'zero-priced' });

  assert.equal(res.success, true);
  const serialised = JSON.stringify(res.data);
  assert.equal(serialised.includes(SECRET), false, 'the write response must never echo the credential');
  assert.match(serialised, /"hasKey":true/, 'it must still confirm a key is present');

  const stored = loadProviderConfig().profiles.gw;
  assert.equal(stored.apiKey, SECRET, 'the key must actually have been stored');
  assert.equal(stored.model, 'vendor/m:free');

  const file = path.join(dataDir, fs.readdirSync(dataDir).find((f) => f.startsWith('harness-providers'))!);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'a file holding a credential must not be group/world readable');
});

test('the first profile written becomes the default, else a run would be refused', async () => {
  assert.equal(loadProviderConfig().defaultProfile, 'gw');
});

test('status renders the stored profile without the key', async () => {
  const res = await handleHarnessStatus();
  const serialised = JSON.stringify(res.data);

  assert.equal(serialised.includes(SECRET), false, 'the status surface must never carry the credential');
  const p = (res.data as any).providers.profiles.find((x: any) => x.name === 'gw');
  assert.equal(p.hasKey, true);
  assert.equal(p.baseUrl, 'https://gw.example/native/x/v1');
  assert.equal((p as any).apiKey, undefined);
});

test('an update may omit the key, and the stored one survives', async () => {
  const res = await handleProviderPut('gw', req(), { model: 'vendor/other:free' });

  assert.equal(res.success, true);
  const stored = loadProviderConfig().profiles.gw;
  assert.equal(stored.model, 'vendor/other:free');
  assert.equal(stored.apiKey, SECRET, 'changing a model must not require re-sending the credential');
  assert.equal(stored.baseUrl, 'https://gw.example/native/x/v1', 'unspecified fields must be preserved');
});

test('a new profile with no key is refused with a reason that says why', async () => {
  const res = await handleProviderPut('brandnew', req(), { baseUrl: 'https://gw.example/v1' });
  assert.equal(res.success, false);
  assert.equal(res.error!.code, 'INVALID_INPUT');
  assert.match(res.error!.message, /does not exist yet/);
});

test('a non-URL, a non-http scheme and a bad name are all refused', async () => {
  const notUrl = await handleProviderPut('p1', req(), { baseUrl: 'gw.example/v1', apiKey: SECRET });
  assert.equal(notUrl.error!.code, 'INVALID_INPUT');

  const badScheme = await handleProviderPut('p2', req(), { baseUrl: 'file:///etc/passwd', apiKey: SECRET });
  assert.equal(badScheme.error!.code, 'INVALID_INPUT');

  const badName = await handleProviderPut('../escape', req(), { baseUrl: 'https://gw.example/v1', apiKey: SECRET });
  assert.equal(badName.error!.code, 'INVALID_NAME');

  const badWire = await handleProviderPut('p3', req(), { baseUrl: 'https://gw.example/v1', apiKey: SECRET, wire: 'anthropic' });
  assert.equal(badWire.error!.code, 'UNSUPPORTED_WIRE');

  for (const n of ['p1', 'p2', 'p3', '../escape']) {
    assert.equal(loadProviderConfig().profiles[n], undefined, `${n} must not have been stored`);
  }
});

test('"env" is reserved so a stored profile cannot masquerade as the environment one', async () => {
  const res = await handleProviderPut('env', req(), { baseUrl: 'https://gw.example/v1', apiKey: SECRET });
  assert.equal(res.success, false);
  assert.equal(res.error!.code, 'RESERVED_NAME');
});
