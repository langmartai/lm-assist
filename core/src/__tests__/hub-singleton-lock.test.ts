import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { acquireHubSingletonLock, releaseHubSingletonLock } from '../hub-client/singleton-lock';

function tmp(): string {
  const d = path.join(os.tmpdir(), `hublock-${process.pid}-${Math.floor(process.hrtime()[1])}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const HUB = 'wss://assist-api.langmart.ai';

test('first acquire succeeds and records our pid', () => {
  const dir = tmp();
  try {
    const r = acquireHubSingletonLock(HUB, dir);
    assert.equal(r.acquired, true);
    assert.equal(fs.readFileSync(r.lockFile, 'utf-8').trim(), String(process.pid));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock held by a DIFFERENT live process blocks acquisition', () => {
  const dir = tmp();
  try {
    // pid 1 is always alive; process.kill(1,0) → EPERM → treated as alive, and != us.
    const r0 = acquireHubSingletonLock(HUB, dir);
    fs.writeFileSync(r0.lockFile, '1'); // simulate another live core owning it
    const r = acquireHubSingletonLock(HUB, dir);
    assert.equal(r.acquired, false, 'must refuse when another live core holds the lock');
    assert.equal(r.heldByPid, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a STALE lock (dead owner pid) is reclaimed', () => {
  const dir = tmp();
  try {
    const r0 = acquireHubSingletonLock(HUB, dir);
    fs.writeFileSync(r0.lockFile, '2147483646'); // a pid that does not exist
    const r = acquireHubSingletonLock(HUB, dir);
    assert.equal(r.acquired, true, 'a dead owner must not block');
    assert.equal(fs.readFileSync(r.lockFile, 'utf-8').trim(), String(process.pid));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('different hub URLs use different locks (dev + prod coexist)', () => {
  const dir = tmp();
  try {
    const prod = acquireHubSingletonLock('wss://assist-api.langmart.ai', dir);
    const dev = acquireHubSingletonLock('wss://assist-api.xeenhub.com', dir);
    assert.equal(prod.acquired, true);
    assert.equal(dev.acquired, true, 'a different hub must not be blocked by the prod lock');
    assert.notEqual(prod.lockFile, dev.lockFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release frees the lock so another process can take it', () => {
  const dir = tmp();
  try {
    const r = acquireHubSingletonLock(HUB, dir);
    assert.equal(r.acquired, true);
    releaseHubSingletonLock(HUB, dir);
    assert.equal(fs.existsSync(r.lockFile), false, 'lock file removed on release');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release does NOT remove a lock owned by a different process', () => {
  const dir = tmp();
  try {
    const r = acquireHubSingletonLock(HUB, dir);
    fs.writeFileSync(r.lockFile, '1'); // someone else owns it now
    releaseHubSingletonLock(HUB, dir);
    assert.equal(fs.existsSync(r.lockFile), true, 'must not delete another core\'s lock');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
