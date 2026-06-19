import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { sensitiveReadReason, readFileAbs } from '../fs-inspect';

/**
 * fs_read security gate: reading file CONTENTS over the connector must never
 * expose credentials. sensitiveReadReason returns a non-null reason for a
 * blocked path, null for an allowed one. The blacklist must catch SSH keys,
 * API keys/tokens, lm-assist's own keys, and known-risk files — WITHOUT
 * blocking ordinary source files.
 */

const BLOCKED: Array<[string, RegExp]> = [
  ['/home/ubuntu/.ssh/id_rsa', /ssh|credential/i],
  ['/home/ubuntu/.ssh/id_ed25519', /ssh|credential/i],
  ['/home/ubuntu/.ssh/authorized_keys', /credential|ssh/i],
  ['/home/ubuntu/.lm-assist/hub.json', /credential|lm-assist/i],
  ['/home/ubuntu/.lm-assist/hub-dev.json', /credential|lm-assist/i],
  ['/home/ubuntu/.claude/.credentials.json', /credential|secret/i],
  ['/home/ubuntu/.lm-oandaproxy/config.json', /credential|lm-oandaproxy/i],
  ['/home/ubuntu/.config/gh/hosts.yml', /token|gh/i],
  ['/home/ubuntu/.aws/credentials', /credential|aws/i],
  ['/home/ubuntu/.git-credentials', /credential|secret/i],
  ['/home/ubuntu/.netrc', /credential|secret/i],
  ['/home/ubuntu/project/.env', /env|secret/i],
  ['/home/ubuntu/project/.env.production', /env|secret/i],
  ['/home/ubuntu/certs/server.pem', /key|keystore/i],
  ['/home/ubuntu/certs/tls.key', /key|keystore/i],
  ['/etc/shadow', /credential|secret/i],
  ['/home/ubuntu/backup/my_id_rsa.bak', /ssh|key/i],
];

const ALLOWED = [
  '/home/ubuntu/lm-assist/core/src/service-manager.ts',
  '/home/ubuntu/lm-assist/core/src/mcp-server/tools/fs-inspect.ts',
  '/home/ubuntu/project/.env.example',          // template, not a real secret
  '/home/ubuntu/project/.env.sample',
  '/home/ubuntu/lm-assist/README.md',
  '/home/ubuntu/lm-assist/package.json',
  '/home/ubuntu/src/apikey.ts',                 // source ABOUT keys, not a key
  '/home/ubuntu/src/grid_rsa.ts',               // contains "id_rsa" substring but is source
  '/home/ubuntu/.ssh.notes.txt',                // not inside a .ssh dir
];

test('sensitiveReadReason: blocks every known credential/key path', () => {
  for (const [p, re] of BLOCKED) {
    const reason = sensitiveReadReason(p);
    assert.ok(reason, `expected ${p} to be BLOCKED`);
    assert.match(reason!, re, `reason for ${p}: ${reason}`);
  }
});

test('sensitiveReadReason: allows ordinary source/doc files', () => {
  for (const p of ALLOWED) {
    assert.equal(sensitiveReadReason(p), null, `expected ${p} to be ALLOWED`);
  }
});

test('readFileAbs: reads a bounded slice of a normal file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsread-'));
  try {
    const f = path.join(dir, 'hello.txt');
    fs.writeFileSync(f, 'ABCDEFGHIJ');
    const all = await readFileAbs(f);
    assert.equal(all.exists, true);
    assert.equal(all.isFile, true);
    assert.equal(all.content, 'ABCDEFGHIJ');
    assert.equal(all.size, 10);
    assert.equal(all.eof, true);

    const slice = await readFileAbs(f, { offset: 2, maxBytes: 3 });
    assert.equal(slice.content, 'CDE');
    assert.equal(slice.offset, 2);
    assert.equal(slice.bytesReturned, 3);
    assert.equal(slice.eof, false);
    assert.equal(slice.truncated, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readFileAbs: a blocked path returns blocked reason and NO content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsread-'));
  try {
    // A real file that LOOKS like a secret by name — must be refused even though it exists.
    const f = path.join(dir, '.env');
    fs.writeFileSync(f, 'SECRET_TOKEN=abc123');
    const r = await readFileAbs(f);
    assert.ok(r.blocked, 'must be blocked');
    assert.equal(r.content, '', 'no content for a blocked file');
    assert.doesNotMatch(JSON.stringify(r), /abc123/, 'secret bytes must never appear');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readFileAbs: a missing path returns exists:false (not a throw)', async () => {
  const r = await readFileAbs('/home/ubuntu/definitely-not-here-xyz.txt');
  assert.equal(r.exists, false);
});

test('readFileAbs: binary content is flagged, not dumped as garbage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsread-'));
  try {
    const f = path.join(dir, 'blob.bin');
    fs.writeFileSync(f, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
    const r = await readFileAbs(f);
    assert.equal(r.exists, true);
    assert.equal(r.binary, true);
    assert.equal(r.content, '', 'binary content not returned as text');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
