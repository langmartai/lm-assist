import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Redaction for the harness-run surfaces.
 *
 * The provider key is handed to the child, so it can reach a transcript the
 * moment an agent runs `env`. These pin the two halves: exact configured values
 * (from EITHER mode's provider file, and the env fallback), and the generic
 * key-shaped patterns for keys that were never configured here.
 *
 * All keys below are synthetic sentinels; the store is redirected with
 * LM_ASSIST_DATA_DIR so the operator's real provider files are never read.
 */

import { collectSecrets, redactDeep, redactString, REDACTED } from '../harness/redact';

let dataDir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['LM_ASSIST_DATA_DIR', 'LM_ASSIST_PROD', 'LM_HARNESS_BASE_URL', 'LM_HARNESS_API_KEY', 'LM_HARNESS_MODEL'];

const FILE_KEY = 'gw-file-KEY-SENTINEL-0001';
const OTHER_MODE_KEY = 'gw-prodfile-KEY-SENTINEL-0002';
const ENV_KEY = 'env-KEY-SENTINEL-00000003';

function writeProviders(file: string, keys: Record<string, string>): void {
  const profiles = Object.fromEntries(
    Object.entries(keys).map(([name, apiKey]) => [name, { baseUrl: 'https://gw.example/v1', apiKey, model: 'vendor/m:free' }]),
  );
  fs.writeFileSync(path.join(dataDir, file), JSON.stringify({ defaultProfile: Object.keys(keys)[0], profiles }), { mode: 0o600 });
}

before(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-redact-'));
  process.env.LM_ASSIST_DATA_DIR = dataDir;
  // Tests run from dist-test, so this Core is "dev": its own file is the -dev one.
  writeProviders('harness-providers-dev.json', { gw: FILE_KEY, tiny: 'short7!' });
  writeProviders('harness-providers.json', { prodgw: OTHER_MODE_KEY });
});

after(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a configured key is replaced by its exact value, wherever it appears', () => {
  const out = redactString(`before ${FILE_KEY} middle ${FILE_KEY}after`);
  assert.equal(out.includes(FILE_KEY), false);
  assert.equal(out, `before ${REDACTED} middle ${REDACTED}after`);
});

test('the OTHER mode\'s provider file is redacted too — legacy run dirs are shared by both Cores', () => {
  assert.equal(redactString(`k=${OTHER_MODE_KEY}`).includes(OTHER_MODE_KEY), false);
});

test('LM_HARNESS_API_KEY is redacted even when no base URL makes it a usable profile', () => {
  process.env.LM_HARNESS_API_KEY = ENV_KEY;
  try {
    assert.ok(collectSecrets().includes(ENV_KEY));
    assert.equal(redactString(`OPENAI_API_KEY=${ENV_KEY}`), `OPENAI_API_KEY=${REDACTED}`);
  } finally {
    delete process.env.LM_HARNESS_API_KEY;
  }
});

test('a key shorter than 8 chars is ignored — too likely to be ordinary text', () => {
  assert.equal(collectSecrets().includes('short7!'), false);
  assert.equal(redactString('value short7! stays'), 'value short7! stays');
});

test('a rewritten provider file is picked up without waiting for the cache to expire', () => {
  const rotated = 'gw-rotated-KEY-SENTINEL-000000000004';
  writeProviders('harness-providers-dev.json', { gw: rotated });
  try {
    assert.equal(redactString(`x ${rotated} y`), `x ${REDACTED} y`);
  } finally {
    writeProviders('harness-providers-dev.json', { gw: FILE_KEY, tiny: 'short7!' });
  }
});

test('sk- shaped tokens are redacted even when nothing configured them', () => {
  const sentinel = 'sk-test-SENTINEL-0000000000000000';
  assert.equal(redactString(`key: ${sentinel}.`), `key: ${REDACTED}.`);
  assert.equal(redactString('sk-short stays'), 'sk-short stays', 'fewer than 20 chars after sk- is not a key shape');
});

test('Bearer credentials are redacted and the scheme word is kept', () => {
  assert.equal(
    redactString('Authorization: Bearer abcDEF123456789._~+/=-xyz'),
    `Authorization: Bearer ${REDACTED}`,
  );
  assert.equal(redactString('bearer tokenABCDEFGHIJKLMN'), `bearer ${REDACTED}`, 'case-insensitive');
  assert.equal(redactString('Bearer short'), 'Bearer short', 'under 16 chars is left alone');
});

test('redactDeep redacts nested string leaves, keeps keys and non-strings, and never mutates its input', () => {
  const when = new Date(0);
  const input = {
    a: FILE_KEY,
    nested: { list: ['ok', `x ${FILE_KEY}`, 3, null, true], deep: { b: 'sk-test-SENTINEL-0000000000000000' } },
    n: 42,
    when,
  };
  const snapshot = JSON.stringify(input);
  const out = redactDeep(input);

  assert.equal(JSON.stringify(input), snapshot, 'the input must be left as it was');
  assert.equal(out.a, REDACTED);
  assert.deepEqual(out.nested.list, ['ok', `x ${REDACTED}`, 3, null, true]);
  assert.equal(out.nested.deep.b, REDACTED);
  assert.equal(out.n, 42);
  assert.equal(out.when, when, 'a non-plain object passes through untouched');
  assert.equal(JSON.stringify(out).includes('SENTINEL'), false);
});

test('a configured key CUT by an earlier slice is still redacted at either edge of the string', () => {
  const K = 'gw-live-0123456789abcdefghij0123456789';
  const secrets = [K];
  // Head of the key at the end (a preview or field cut mid-key).
  for (const n of [12, 20, K.length - 1]) {
    const out = redactString(`OPENAI_API_KEY=${K.slice(0, n)}`, secrets);
    assert.equal(out, `OPENAI_API_KEY=${REDACTED}`, `head of ${n} chars`);
  }
  // Tail of the key at the start (a tail read that began mid-key).
  const tail = redactString(`${K.slice(10)}\nPATH=/usr/bin`, secrets);
  assert.equal(tail, `${REDACTED}\nPATH=/usr/bin`);
  // A fragment too short to be worth mangling text for is left alone — keys share
  // public prefixes, and text merely ending in one is not a leak.
  assert.equal(redactString(`prefix ${K.slice(0, 11)}`, secrets), `prefix ${K.slice(0, 11)}`);
  // Ordinary text is untouched.
  assert.equal(redactString('nothing to see here, move along', secrets), 'nothing to see here, move along');
});
