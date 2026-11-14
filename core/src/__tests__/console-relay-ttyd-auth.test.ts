/**
 * Hub-proxied terminals: ConsoleRelayHandler dials Core's ttyd proxy over loopback, and
 * that proxy now authenticates every WS upgrade — so the relay must send the api-token.
 * Without it every hub terminal would get a 401. Compared, never printed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ttydRelayWsOptions } from '../hub-client/console-relay-handler';
import { apiTokenFilePath, __resetApiTokenState } from '../auth/api-token';

let dir = '';
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-relay-auth-'));
  process.env.LM_ASSIST_DATA_DIR = dir;
  __resetApiTokenState(); // no in-process ring → the relay reads the token FILE, like a separate process
});
after(() => {
  __resetApiTokenState();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('ttydRelayWsOptions carries the token-file value as x-api-key', () => {
  const t = 'a1'.repeat(32);
  fs.writeFileSync(apiTokenFilePath(), t + '\n', { mode: 0o600 });
  const opts = ttydRelayWsOptions();
  assert.ok(opts.headers['x-api-key'] === t, 'x-api-key must equal the token file');
});
