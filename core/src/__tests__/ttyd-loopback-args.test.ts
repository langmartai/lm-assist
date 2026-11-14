/**
 * ttyd binds loopback: every view reaches it through Core's authenticated proxy (or the
 * hub relay's loopback dial into that proxy), and ttyd 1.6.3 has no credential of its
 * own. The source guard makes sure no ttyd spawn site forgets the bind — a new arg list
 * that copies `'-p', String(port),` without the loopback args fails here.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

before(() => {
  // ttyd-manager computes its instance-store path from the data dir at import time.
  process.env.LM_ASSIST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ttyd-args-'));
});

test('ttydLoopbackArgs binds 127.0.0.1 (an address, so it also works where loopback is lo0)', () => {
  const { ttydLoopbackArgs } = require('../ttyd-manager') as typeof import('../ttyd-manager');
  assert.deepEqual(ttydLoopbackArgs(), ['-i', '127.0.0.1']);
});

test('source guard: every ttyd arg list carries the loopback bind (5 spawn sites)', () => {
  // compiled location: core/dist-test/__tests__/x.test.js → core/ is 2 dirs up
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'ttyd-manager.ts'), 'utf8');
  const ports = src.split("'-p', String(port),").length - 1;
  const binds = src.split('...ttydLoopbackArgs(),').length - 1;
  assert.equal(ports, 5, 'expected the five known ttyd spawn arg lists');
  assert.equal(binds, ports, 'each `-p` arg list must be followed by ...ttydLoopbackArgs()');
  // …and immediately after the port, so it cannot drift into a different array.
  const pairs = src.match(/'-p', String\(port\),\n\s*\.\.\.ttydLoopbackArgs\(\),/g) || [];
  assert.equal(pairs.length, 5);
});

test('checkTtydHttp / proxy dial 127.0.0.1, not localhost (which may resolve to ::1)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'ttyd-manager.ts'), 'utf8');
  assert.ok(src.includes('http.get(`http://127.0.0.1:${port}/`'));
  const proxySrc = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'ttyd-proxy.ts'), 'utf8');
  assert.ok(!/target = `http:\/\/localhost/.test(proxySrc));
  assert.ok(proxySrc.includes("hostname: '127.0.0.1'"));
});
