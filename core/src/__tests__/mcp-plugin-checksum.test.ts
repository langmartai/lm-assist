/**
 * Payload checksum + manifest digest (contract §4) — the pin that makes a swapped
 * payload un-executable. The algorithm is PUBLISHED, so this also guards against
 * drifting away from what plugin authors compute on their side.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { payloadChecksum, manifestDigest } from '../mcp-server/plugins/checksum';

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-plugin-ck-'));
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'server.js'), 'console.error("hi");\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# plugin\n');
  fs.writeFileSync(path.join(dir, 'mcp-plugin.json'), JSON.stringify({ name: 'x', checksum: 'sha256:' + '0'.repeat(64) }));
  return dir;
}

test('payload checksum is sha256-prefixed and deterministic', () => {
  const dir = fixture();
  const a = payloadChecksum(dir);
  const b = payloadChecksum(dir);
  assert.match(a, /^sha256:[a-f0-9]{64}$/);
  assert.equal(a, b);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mcp-plugin.json is EXCLUDED from the payload hash (it carries the field)', () => {
  const dir = fixture();
  const before = payloadChecksum(dir);
  fs.writeFileSync(path.join(dir, 'mcp-plugin.json'), JSON.stringify({ name: 'x', version: '9.9.9' }));
  assert.equal(payloadChecksum(dir), before, 'editing the manifest must not move the payload hash');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ANY payload byte change moves the checksum (this is the auto-revert trigger)', () => {
  const dir = fixture();
  const before = payloadChecksum(dir);
  fs.appendFileSync(path.join(dir, 'dist', 'server.js'), '// backdoor\n');
  assert.notEqual(payloadChecksum(dir), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('adding a new payload file moves the checksum', () => {
  const dir = fixture();
  const before = payloadChecksum(dir);
  fs.writeFileSync(path.join(dir, 'dist', 'extra.js'), 'x\n');
  assert.notEqual(payloadChecksum(dir), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renaming a file moves the checksum (path is hashed, not just content)', () => {
  const dir = fixture();
  const before = payloadChecksum(dir);
  fs.renameSync(path.join(dir, 'dist', 'server.js'), path.join(dir, 'dist', 'server2.js'));
  assert.notEqual(payloadChecksum(dir), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('symlinks are REJECTED, never silently skipped', () => {
  const dir = fixture();
  fs.symlinkSync('/etc/passwd', path.join(dir, 'link.txt'));
  assert.throws(() => payloadChecksum(dir), /symlink/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('.git metadata is excluded (not payload)', () => {
  const dir = fixture();
  const before = payloadChecksum(dir);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(payloadChecksum(dir), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('node_modules IS included — vendored dependencies are executable payload', () => {
  const dir = fixture();
  const before = payloadChecksum(dir);
  fs.mkdirSync(path.join(dir, 'node_modules', 'evil'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'evil', 'index.js'), 'process.exit(1)\n');
  assert.notEqual(payloadChecksum(dir), before, 'a dependency swap must trip the pin');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checksum matches the published reference algorithm exactly', () => {
  // Independent re-implementation of contract §4, byte for byte.
  const crypto = require('crypto') as typeof import('crypto');
  const dir = fixture();
  const rels: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      if (e.isDirectory()) { if (rel !== '.git') walk(abs); continue; }
      if (rel === 'mcp-plugin.json') continue;
      rels.push(rel);
    }
  };
  walk(dir);
  rels.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  const h = crypto.createHash('sha256');
  for (const rel of rels) {
    const fh = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex');
    h.update(rel + '\n' + fh + '\n', 'utf8');
  }
  assert.equal(payloadChecksum(dir), 'sha256:' + h.digest('hex'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- manifest digest: capability edits must also trip re-approval -----------------
test('manifest digest ignores the self-referential checksum field but catches everything else', () => {
  const base = { manifestVersion: 1, name: 'x', capabilities: { network: ['a.example.com'], fs: [], env: [] }, checksum: 'sha256:' + '0'.repeat(64) };
  const d1 = manifestDigest(base);
  const d2 = manifestDigest({ ...base, checksum: 'sha256:' + 'f'.repeat(64) });
  assert.equal(d1, d2, 'the checksum field cannot cover itself');

  const escalated = { ...base, capabilities: { network: ['a.example.com', 'evil.example.com'], fs: [], env: [] } };
  assert.notEqual(manifestDigest(escalated), d1, 'a capability escalation MUST trip re-approval');
});

test('manifest digest is key-order independent (canonical serialisation)', () => {
  const a = manifestDigest({ manifestVersion: 1, name: 'x', version: '1.0.0' });
  const b = manifestDigest({ version: '1.0.0', name: 'x', manifestVersion: 1 });
  assert.equal(a, b);
});
