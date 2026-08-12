/**
 * Container hardening — regression guards for defects an adversarial review of
 * the feature confirmed. Every test here corresponds to a bug that WAS in the
 * first cut of this code; the comment on each says what it was, because that is
 * the part a future reader cannot reconstruct from the assertion.
 *
 * Pure: no Docker daemon. The two tests that need a backend use a stub, and the
 * containment test uses a real temp directory + a real symlink (a junction on
 * Windows, which needs no privileges) because the whole point is that LEXICAL
 * containment is not containment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env.LM_ASSIST_DATA_DIR = path.join(os.tmpdir(), 'lm-assist-container-hardening-nonexistent');
delete process.env.LM_CONTAINER_VOLUME_ROOTS;

import {
  _setBackendForTests,
  containerDelete,
  containerPower,
  validateRunArgs,
} from '../container/service';
import { isUnderRoot, parsePortsSummary, redactCommand } from '../container/docker-backend';
import { MAX_STOP_TIMEOUT_SEC } from '../container/config';
import { ContainerBackend, ContainerError, ContainerInfo } from '../container/types';

function throwsCode(code: string, fn: () => unknown, msg?: string): void {
  assert.throws(fn, (e: unknown) => e instanceof ContainerError && e.code === code, msg);
}
async function rejectsCode(code: string, p: Promise<unknown>, msg?: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof ContainerError && e.code === code, msg);
}

// ─── the security boundary ───────────────────────────────────────────────────

test('network:"host" is refused — it is a namespace escape, not a network name', () => {
  // WAS: `host` passed NETWORK_NAME_RE like any other name, so --network host
  // reached the engine and the container joined the HOST network namespace —
  // every 127.0.0.1-bound service on the node (Core's own API, the elevated
  // worker on :3110, a local database) instantly reachable from inside it.
  throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'c', image: 'alpine', network: 'host' }));
  throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'c', image: 'alpine', network: 'HOST' }), 'case does not launder it');
  throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'c', image: 'alpine', network: 'container' }));
  // A real named network is still fine, and null still means "no networking".
  assert.equal(validateRunArgs({ name: 'c', image: 'alpine', network: 'mynet' }).network, 'mynet');
  assert.equal(validateRunArgs({ name: 'c', image: 'alpine', network: null }).network, null);
});

test('a symlink inside a volumeRoot cannot smuggle a mount out of it', (t) => {
  // WAS: containment was decided on path.resolve()'d STRINGS, which never
  // follow a link. A symlink under the root — one a previous, entirely legal
  // container could create through its own mount — pointed anywhere, passed the
  // string test, and the daemon then bind-mounted the real target.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ctr-root-'));
  const root = path.join(base, 'allowed');
  const outside = path.join(base, 'secret');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const escape = path.join(root, 'escape');
  try {
    fs.symlinkSync(outside, escape, 'junction'); // 'junction' needs no privileges on Windows
  } catch {
    t.skip('symlink/junction creation is not permitted in this environment');
    return;
  }
  const prior = process.env.LM_CONTAINER_VOLUME_ROOTS;
  process.env.LM_CONTAINER_VOLUME_ROOTS = root;
  try {
    // A genuine directory under the root is still accepted.
    const inside = path.join(root, 'data');
    fs.mkdirSync(inside);
    assert.equal(validateRunArgs({ name: 'c', image: 'alpine', volumes: [`${inside}:/data`] }).volumes.length, 1);
    // The symlink resolves OUT of the root, so it is refused.
    throwsCode('UNSAFE_PATH', () => validateRunArgs({ name: 'c', image: 'alpine', volumes: [`${escape}:/data`] }), 'symlink to a sibling');
    throwsCode(
      'UNSAFE_PATH',
      () => validateRunArgs({ name: 'c', image: 'alpine', volumes: [`${path.join(escape, 'deeper')}:/data`] }),
      'a path THROUGH the symlink',
    );
  } finally {
    if (prior === undefined) delete process.env.LM_CONTAINER_VOLUME_ROOTS;
    else process.env.LM_CONTAINER_VOLUME_ROOTS = prior;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('secret-shaped argv tokens are redacted from a container command line', () => {
  // WAS: reads dropped env VALUES ("container env routinely carries
  // credentials") but returned the argv verbatim, and `docker ps --no-trunc`
  // shows the full command of containers lm-assist never created — the same
  // class of secret, handed to any read-scope caller.
  assert.equal(redactCommand('mysqld --password=hunter2 --datadir=/var/lib'), 'mysqld --password=*** --datadir=/var/lib');
  assert.equal(redactCommand('app --api-key=abc --API_TOKEN=xyz'), 'app --api-key=*** --API_TOKEN=***');
  assert.equal(redactCommand('svc --db-secret=s --auth-token=t'), 'svc --db-secret=*** --auth-token=***');
  // Non-secret flags are left alone — the command stays useful.
  assert.equal(redactCommand('nginx -g daemon off; --port=8080'), 'nginx -g daemon off; --port=8080');
  assert.equal(redactCommand(null), null);
});

// ─── honesty of results ──────────────────────────────────────────────────────

test('published port RANGES from `docker ps` are expanded, not dropped', () => {
  // WAS: the summary regex demanded a single numeric port, so docker's own
  // range collapsing (0.0.0.0:8000-8002->8000-8002/tcp) matched nothing and the
  // ports vanished — list() and get() then disagreed about the same container,
  // and a caller checking for a port conflict saw the ports as free.
  assert.deepEqual(parsePortsSummary('0.0.0.0:8000-8002->8000-8002/tcp'), [
    { host: 8000, container: 8000, protocol: 'tcp' },
    { host: 8001, container: 8001, protocol: 'tcp' },
    { host: 8002, container: 8002, protocol: 'tcp' },
  ]);
  assert.deepEqual(parsePortsSummary('0.0.0.0:8080->80/tcp, [::]:8080->80/tcp'), [
    { host: 8080, container: 80, protocol: 'tcp' },
  ], 'the v4 and v6 rows are one mapping');
  assert.deepEqual(parsePortsSummary('127.0.0.1:5432->5432/tcp'), [
    { host: 5432, container: 5432, protocol: 'tcp', hostIp: '127.0.0.1' },
  ]);
  assert.deepEqual(parsePortsSummary('53->53/udp'), [{ host: 53, container: 53, protocol: 'udp' }]);
  assert.deepEqual(parsePortsSummary(''), []);
  assert.deepEqual(parsePortsSummary('80/tcp'), [], 'an EXPOSED but unpublished port is not a mapping');
});

test('isUnderRoot treats the root itself as inside it, on both platforms', () => {
  // WAS: the equality case was handled by a case-SENSITIVE `===` in the caller,
  // so on Windows a mount of `c:\srv\shared` was refused against a configured
  // `C:\srv\shared` while every SUBDIRECTORY of it was allowed.
  assert.equal(isUnderRoot('/srv/data', '/srv/data'), true);
  assert.equal(isUnderRoot('/srv/data', '/srv/data-evil'), false, 'the textual-prefix trap');
});

// ─── argument contracts ──────────────────────────────────────────────────────

test('restart and autoRemove are refused together instead of one being dropped', () => {
  // WAS: the backend silently suppressed --restart when --rm was set (Docker
  // refuses the pair), so a caller asking for an always-restarting service got
  // a one-shot container back and had to diff the echo to notice.
  throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'c', image: 'alpine', restart: 'always', autoRemove: true }));
  assert.equal(validateRunArgs({ name: 'c', image: 'alpine', autoRemove: true }).restart, 'no');
  assert.equal(validateRunArgs({ name: 'c', image: 'alpine', restart: 'always' }).restart, 'always');
});

test('cpus is rounded BEFORE the range check, so a tiny quota cannot become "unlimited"', () => {
  // WAS: Math.round(n*100)/100 ran AFTER the (0, max] check, mapping cpus:0.004
  // to exactly 0 — and `--cpus 0` means NO LIMIT to the engine, silently
  // removing the cap that was asked for.
  throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'c', image: 'alpine', cpus: 0.004 }));
  throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'c', image: 'alpine', cpus: 0 }));
  throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'c', image: 'alpine', cpus: -1 }));
  assert.equal(validateRunArgs({ name: 'c', image: 'alpine', cpus: 0.5 }).cpus, 0.5);
  assert.equal(validateRunArgs({ name: 'c', image: 'alpine', cpus: 1.567 }).cpus, 1.57, 'rounded to 2 decimals');
  assert.equal(validateRunArgs({ name: 'c', image: 'alpine' }).cpus, null, 'omitted = no quota');
});

test('an empty-string memoryMB means "unset", not 0 (which the engine reads as unlimited)', () => {
  assert.equal(validateRunArgs({ name: 'c', image: 'alpine', memoryMB: '' }).memoryMB, null);
  assert.equal(validateRunArgs({ name: 'c', image: 'alpine' }).memoryMB, null);
  assert.equal(validateRunArgs({ name: 'c', image: 'alpine', memoryMB: 64 }).memoryMB, 64);
  throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'c', image: 'alpine', memoryMB: 2 }), 'below docker floor');
});

// ─── backend-facing behaviour (stub backend, no daemon) ──────────────────────

function stubInfo(over: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    name: 'c', id: 'id', image: 'alpine', imageId: null, state: 'running', status: null, command: null,
    created: null, startedAt: null, finishedAt: null, exitCode: null, health: null, ports: [], networks: [],
    restartPolicy: null, mounts: [], envKeys: [], managed: true, notes: null, ...over,
  };
}

/** Records call order so a test can prove writes did not overlap. */
class StubBackend implements ContainerBackend {
  readonly engine = 'docker' as const;
  inFlight = 0;
  maxInFlight = 0;
  calls: string[] = [];
  info: ContainerInfo = stubInfo();
  delayMs = 0;
  private async work<T>(label: string, v: T): Promise<T> {
    this.calls.push(label);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    this.inFlight--;
    return v;
  }
  async status() { return { engine: 'docker' as const, platform: 'linux', available: true, version: '1', clientVersion: '1', apiVersion: '1', serverOs: 'linux', endpoint: 'x', privilege: 'direct' as const, containersRunning: 0, containersTotal: 0, imagesCount: 0, dataRootFreeGB: null }; }
  async list() { return [this.info]; }
  async get(_n: string) { return this.info; }
  async images() { return []; }
  async run() { return this.work('run', this.info); }
  async start() { return this.work('start', stubInfo({ state: 'running' })); }
  async unpause() { return this.work('unpause', stubInfo({ state: 'running' })); }
  async stop() { return this.work('stop', stubInfo({ state: 'exited' })); }
  async restart() { return this.work('restart', stubInfo({ state: 'running' })); }
  async logs() { return { name: 'c', lines: [], count: 0, truncated: false, bytes: 0 }; }
  async remove() { return this.work('remove', { name: 'c', deleted: true, killed: false, removedImage: null, imageKeptReason: null }); }
}

test('start on a PAUSED container unpauses it instead of failing opaquely', async () => {
  // WAS: only `running` was special-cased, so a paused container fell through to
  // `docker start`, which the daemon refuses ("try unpause instead") — a message
  // matching none of the error regexes, so it surfaced as CONTAINER_OP_FAILED
  // and a paused container could not be resumed through this surface at all.
  const b = new StubBackend();
  b.info = stubInfo({ state: 'paused' });
  _setBackendForTests(b);
  try {
    const r = await containerPower('start', 'c');
    assert.equal(r.state, 'running');
    assert.deepEqual(b.calls, ['unpause']);
  } finally {
    _setBackendForTests(null);
  }
});

test('stop timeoutSec is bounded by what the spawn budget can honour', async () => {
  // WAS: the range was [1, 600] while the backend kills `docker stop -t N` at
  // STOP_MAX_TIMEOUT_MS — so a 300s graceful stop was reported as a TIMEOUT
  // while the daemon was completing it perfectly normally.
  const b = new StubBackend();
  _setBackendForTests(b);
  try {
    await rejectsCode('BAD_ARGS', containerPower('stop', 'c', { timeoutSec: 600 }));
    assert.ok(MAX_STOP_TIMEOUT_SEC >= 30 && MAX_STOP_TIMEOUT_SEC <= 120, `sane bound, got ${MAX_STOP_TIMEOUT_SEC}`);
    const ok = await containerPower('stop', 'c', { timeoutSec: MAX_STOP_TIMEOUT_SEC });
    assert.equal(ok.state, 'exited');
  } finally {
    _setBackendForTests(null);
  }
});

test('concurrent writes are serialized by the mutex — never two in flight', async () => {
  // WAS (and the reason this guard exists): the BUSY path released the slot it
  // had already installed as the chain head, so one timed-out waiter resolved
  // the chain while the operation it waited for was still running, and every
  // later write ran unserialized. This asserts the property that failure broke.
  const b = new StubBackend();
  b.delayMs = 40;
  _setBackendForTests(b);
  try {
    await Promise.all([
      containerPower('stop', 'c'),
      containerDelete('c'),
      containerPower('restart', 'c'),
      containerDelete('c'),
    ]);
    assert.equal(b.maxInFlight, 1, `writes overlapped (max in flight ${b.maxInFlight})`);
    assert.equal(b.calls.length, 4);
  } finally {
    _setBackendForTests(null);
  }
});

test('the managed gate refuses stop/restart/delete and force:true overrides — via the service', async () => {
  const b = new StubBackend();
  b.info = stubInfo({ managed: false });
  _setBackendForTests(b);
  try {
    await rejectsCode('CONTAINER_NOT_MANAGED', containerPower('stop', 'c'));
    await rejectsCode('CONTAINER_NOT_MANAGED', containerPower('restart', 'c'));
    await rejectsCode('CONTAINER_NOT_MANAGED', containerDelete('c'));
    assert.deepEqual(b.calls, [], 'nothing reached the engine');
    // start is deliberately UNGATED — starting a stopped container is not destructive.
    b.info = stubInfo({ managed: false, state: 'exited' });
    await containerPower('start', 'c');
    assert.deepEqual(b.calls, ['start']);
    // force:true is the documented override.
    await containerDelete('c', { force: true });
    assert.deepEqual(b.calls, ['start', 'remove']);
  } finally {
    _setBackendForTests(null);
  }
});
