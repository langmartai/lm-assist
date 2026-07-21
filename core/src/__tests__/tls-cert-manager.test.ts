import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { ensureTlsCert, discoverLanIps } from '../tls/cert-manager';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-tls-test-'));
  tmpDirs.push(d);
  return d;
}
after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// keySize 512 keeps node-forge keygen fast; the production default stays 2048.
const FAST = { keySize: 512 } as const;

test('generates key+cert+meta with expected SANs, pairing, validity and 0600 key', () => {
  const dir = tmpDir();
  const r = ensureTlsCert({ ...FAST, dir, hostnames: ['myhost'], ips: ['10.9.8.7'], validityDays: 100 });

  assert.equal(r.regenerated, true);
  assert.match(r.reason || '', /no cached certificate/);
  for (const f of ['key.pem', 'cert.pem', 'meta.json']) assert.ok(fs.existsSync(path.join(dir, f)), `${f} written`);

  const x = new crypto.X509Certificate(r.cert);
  assert.equal(x.checkPrivateKey(crypto.createPrivateKey(r.key)), true, 'key matches cert');
  const san = x.subjectAltName || '';
  for (const want of ['DNS:localhost', 'DNS:myhost', 'IP Address:127.0.0.1', 'IP Address:10.9.8.7']) {
    assert.ok(san.includes(want), `SAN has ${want} (got: ${san})`);
  }
  const remainingDays = (new Date(x.validTo).getTime() - Date.now()) / 86400000;
  assert.ok(remainingDays > 95 && remainingDays < 101, `validity ~100d (got ${remainingDays.toFixed(1)})`);

  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(dir, 'key.pem')).mode & 0o777;
    assert.equal(mode, 0o600, 'key.pem is 0600');
  }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.version, 1);
  assert.ok(meta.dns.includes('myhost'));
});

test('reuses a valid cached cert (no churn across restarts)', () => {
  const dir = tmpDir();
  const first = ensureTlsCert({ ...FAST, dir, hostnames: ['h'], ips: ['10.0.0.1'] });
  const second = ensureTlsCert({ ...FAST, dir, hostnames: ['h'], ips: ['10.0.0.1'] });
  assert.equal(second.regenerated, false);
  assert.equal(second.cert, first.cert, 'same cert bytes');
  assert.equal(second.key, first.key, 'same key bytes');
});

test('regenerates when the cert is inside the renew window', () => {
  const dir = tmpDir();
  ensureTlsCert({ ...FAST, dir, hostnames: ['h'], ips: [], validityDays: 10 });
  const r = ensureTlsCert({ ...FAST, dir, hostnames: ['h'], ips: [], validityDays: 100, renewBeforeDays: 14 });
  assert.equal(r.regenerated, true);
  assert.match(r.reason || '', /expires/);
});

test('regenerates on IP drift, then settles', () => {
  const dir = tmpDir();
  ensureTlsCert({ ...FAST, dir, hostnames: ['h'], ips: ['10.0.0.5'] });
  const drifted = ensureTlsCert({ ...FAST, dir, hostnames: ['h'], ips: ['10.0.0.5', '10.0.0.6'] });
  assert.equal(drifted.regenerated, true);
  assert.match(drifted.reason || '', /IP drift/);
  const settled = ensureTlsCert({ ...FAST, dir, hostnames: ['h'], ips: ['10.0.0.5', '10.0.0.6'] });
  assert.equal(settled.regenerated, false);
});

test('regenerates when cached files are corrupt', () => {
  const dir = tmpDir();
  ensureTlsCert({ ...FAST, dir, hostnames: ['h'], ips: [] });
  fs.writeFileSync(path.join(dir, 'cert.pem'), 'not a cert');
  const r = ensureTlsCert({ ...FAST, dir, hostnames: ['h'], ips: [] });
  assert.equal(r.regenerated, true);
  assert.match(r.reason || '', /not a valid certificate/);
});

test('discoverLanIps returns only non-internal IPv4s', () => {
  for (const ip of discoverLanIps()) {
    assert.match(ip, /^\d{1,3}(\.\d{1,3}){3}$/);
    assert.notEqual(ip, '127.0.0.1');
  }
});
