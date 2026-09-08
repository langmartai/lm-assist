import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * GET /harness/status.
 *
 * The property that matters: a provider profile holds a REAL credential, and the
 * status surface must render it without ever handing the key back out. That is
 * asserted against the SERIALISED response, not against the fields we remembered
 * to check, because a leak is most likely through a field nobody thought about.
 *
 * The store is redirected with LM_ASSIST_DATA_DIR so these tests never touch the
 * operator's real ~/.lm-assist/harness-providers*.json.
 */

import { handleHarnessStatus } from '../routes/core/harness.routes';
import { registerHarness } from '../harness/registry';
import { createQwenHarness } from '../harness/qwen';
import { saveProviderConfig } from '../harness/provider-config';

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

test('status renders a stored profile without the key', async () => {
  saveProviderConfig({
    defaultProfile: 'gw',
    profiles: { gw: { baseUrl: 'https://gw.example/native/x/v1', apiKey: SECRET, model: 'vendor/m:free', wire: 'openai-chat' } },
  });

  const res = await handleHarnessStatus();
  const serialised = JSON.stringify(res.data);

  assert.equal(serialised.includes(SECRET), false, 'the status surface must never carry the credential');
  const p = (res.data as any).providers.profiles.find((x: any) => x.name === 'gw');
  assert.equal(p.hasKey, true);
  assert.equal(p.baseUrl, 'https://gw.example/native/x/v1');
  assert.equal((p as any).apiKey, undefined);
});

