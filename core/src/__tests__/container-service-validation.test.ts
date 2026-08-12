/**
 * Container service validation — the layer between caller args and a container
 * ENGINE that runs host processes. Everything validated here ends up inside a
 * `docker` argv array, a container label, a published host port, or — worst of
 * all — a BIND MOUNT handing a host directory to a process that is usually
 * root. The charset rules (CONTAINER_NAME_RE, IMAGE_REF_RE, ENV_KEY_RE,
 * CONTAINER_PATH_RE) and the volumeRoots containment are therefore a security
 * boundary, not a style choice: argv arrays stop re-parsing, these regexes stop
 * the pathological input from ever getting that far. These tests pin them.
 *
 * 🔴 The single most important assertion in this file is that with NO
 * volumeRoots configured — the DEFAULT on every node — every bind mount is
 * refused with UNSAFE_PATH. A regression there silently hands out the host
 * filesystem.
 *
 * No Docker daemon is touched and no file is read or written: validation is
 * pure, and the config lookup is redirected at a non-existent data dir so the
 * effective config is deterministically empty (readContainerConfig() → {}).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';

// Redirect the container config lookup at a directory that does not exist, so
// `readContainerConfig()` always falls back to {} — DEFAULT_LIMITS, no
// defaultNetwork, and (critically) NO volumeRoots — regardless of what the host
// running the suite happens to have configured in ~/.lm-assist/.
process.env.LM_ASSIST_DATA_DIR = path.join(os.tmpdir(), 'lm-assist-container-test-nonexistent');
delete process.env.LM_CONTAINER_VOLUME_ROOTS;

import { validateContainerName, validateImageRef, validateRunArgs, validateHostPath } from '../container/service';
import { isUnderRoot } from '../container/docker-backend';
import { ContainerError } from '../container/types';

const IS_WIN = process.platform === 'win32';

/** Assertion helper: throws a ContainerError carrying exactly `code`. */
function throwsCode(code: string, fn: () => unknown, msg?: string): void {
  assert.throws(fn, (e: unknown) => e instanceof ContainerError && e.code === code, msg);
}

// Volume roots are absolute host paths, so the shapes differ per platform. The
// paths are never touched on disk — only resolved and compared.
const ROOT = IS_WIN ? 'C:\\lm-container-root' : '/srv/lm-container-root';
const UNDER = IS_WIN ? 'C:\\lm-container-root\\data' : '/srv/lm-container-root/data';
const DEEPER = IS_WIN ? 'C:\\lm-container-root\\a\\b' : '/srv/lm-container-root/a/b';
const SIBLING = IS_WIN ? 'C:\\lm-container-root-evil\\data' : '/srv/lm-container-root-evil/data';
const OUTSIDE = IS_WIN ? 'C:\\Windows\\System32' : '/etc';

/** Run `fn` with LM_CONTAINER_VOLUME_ROOTS set, restoring the env afterwards. */
function withVolumeRoots(roots: string, fn: () => void): void {
  const prior = process.env.LM_CONTAINER_VOLUME_ROOTS;
  process.env.LM_CONTAINER_VOLUME_ROOTS = roots;
  try {
    fn();
  } finally {
    if (prior === undefined) delete process.env.LM_CONTAINER_VOLUME_ROOTS;
    else process.env.LM_CONTAINER_VOLUME_ROOTS = prior;
  }
}

// ─── names ───────────────────────────────────────────────────────────────────

test('validateContainerName accepts the managed charset', () => {
  assert.equal(validateContainerName('lmc-e2e-test'), 'lmc-e2e-test');
  assert.equal(validateContainerName('a'), 'a');
  assert.equal(validateContainerName('9'), '9');
  assert.equal(validateContainerName('A.b_c-9'), 'A.b_c-9');
  assert.equal(validateContainerName('  trimmed  '), 'trimmed');
  assert.equal(validateContainerName('x'.repeat(64)), 'x'.repeat(64), '64 chars is the ceiling, not 63');
});

test('validateContainerName rejects injection, flag and traversal shapes', () => {
  const bad = [
    "x'; docker rm -f '*", // quote-break
    'x"; docker rm -f "*',
    'a b', // space
    'a$(id)',
    'a`whoami`',
    'a;id',
    'a|id',
    'a&id',
    'a"b',
    "a'b",
    '-rm', // 🔴 a name that could read as a FLAG
    '--force',
    '..', // traversal
    '.',
    '.hidden', // must start alphanumeric
    '_leading',
    '',
    '   ',
    'x'.repeat(65),
    'a/b',
    'a\\b',
    'a\nb',
    null,
    undefined,
  ];
  for (const v of bad) {
    throwsCode('BAD_ARGS', () => validateContainerName(v as unknown), `should reject ${JSON.stringify(v)}`);
  }
});

// ─── image refs ──────────────────────────────────────────────────────────────

test('validateImageRef accepts the reference shapes docker actually uses', () => {
  assert.equal(validateImageRef('alpine'), 'alpine');
  assert.equal(validateImageRef('alpine:3.20'), 'alpine:3.20');
  assert.equal(validateImageRef('ghcr.io/org/app:tag'), 'ghcr.io/org/app:tag');
  assert.equal(validateImageRef('localhost:5000/x:1'), 'localhost:5000/x:1');
  const digest = `repo@sha256:${'a1b2c3d4'.repeat(8)}`; // 64 hex chars
  assert.equal(digest.split(':')[1].length, 64);
  assert.equal(validateImageRef(digest), digest);
  assert.equal(validateImageRef('  alpine:3.20  '), 'alpine:3.20');
});

test('validateImageRef rejects quoting, expansion and traversal shapes', () => {
  const bad = [
    "alpine'; docker rm -f '*",
    'alpine"x',
    'alpine 3.20', // space
    'alpine$(id)',
    'alpine`id`',
    'alpine;id',
    'alpine|id',
    'a/../../etc/passwd', // ".." SEGMENT — checked separately from the charset
    '../alpine',
    'reg.io/..:tag',
    '..',
    '-alpine', // could read as a flag
    '--rm',
    '',
    'a'.repeat(201),
    null,
    undefined,
  ];
  for (const v of bad) {
    throwsCode('BAD_ARGS', () => validateImageRef(v as unknown), `should reject ${JSON.stringify(v)}`);
  }
});

// ─── run args: defaults + scalar ranges ──────────────────────────────────────

test('validateRunArgs applies the documented defaults', () => {
  const spec = validateRunArgs({ name: 'cx', image: 'alpine' });
  assert.equal(spec.name, 'cx');
  assert.equal(spec.image, 'alpine');
  assert.equal(spec.restart, 'no');
  assert.equal(spec.pull, 'missing');
  assert.equal(spec.autoRemove, false);
  assert.equal(spec.memoryMB, null);
  assert.equal(spec.cpus, null);
  assert.deepEqual(spec.command, []);
  assert.deepEqual(spec.env, {});
  assert.deepEqual(spec.ports, []);
  assert.deepEqual(spec.volumes, []);
  assert.equal(spec.workdir, undefined);
  assert.equal(spec.notes, undefined);
  assert.equal(spec.network, undefined, 'no defaultNetwork configured ⇒ engine default bridge');
});

test('validateRunArgs range-checks memoryMB and cpus', () => {
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', memoryMB: 6 }).memoryMB, 6);
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', memoryMB: 32768 }).memoryMB, 32768);
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', cpus: 0.5 }).cpus, 0.5);
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', cpus: 2 }).cpus, 2);
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', cpus: 1.239 }).cpus, 1.24, 'cpus round to 2dp');

  for (const memoryMB of [5, 0, -1, 32769, 1.5, 'lots', NaN]) {
    throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'cx', image: 'alpine', memoryMB }), `memoryMB ${String(memoryMB)}`);
  }
  for (const cpus of [0, -1, 17, 'many', NaN, Infinity]) {
    throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'cx', image: 'alpine', cpus }), `cpus ${String(cpus)}`);
  }
});

test('validateRunArgs rejects unknown restart and pull policies', () => {
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', restart: 'unless-stopped' }).restart, 'unless-stopped');
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', restart: 'on-failure' }).restart, 'on-failure');
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', pull: 'never' }).pull, 'never');
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', autoRemove: true }).autoRemove, true);
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', autoRemove: 'yes' }).autoRemove, false, 'only literal true enables --rm');

  throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'cx', image: 'alpine', restart: 'sometimes' }));
  throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'cx', image: 'alpine', restart: 'always; id' }));
  throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'cx', image: 'alpine', pull: 'maybe' }));
});

test('validateRunArgs network: null means none, and the charset is enforced', () => {
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', network: null }).network, null);
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', network: 'lm-net' }).network, 'lm-net');
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', network: '' }).network, undefined);
  throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'cx', image: 'alpine', network: "x' -Bad" }));
  throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'cx', image: 'alpine', network: '-host' }));
});

test('validateRunArgs command is an ARGV array, bounded, control-char free', () => {
  assert.deepEqual(validateRunArgs({ name: 'cx', image: 'alpine', command: 'sleep 60' }).command, ['sleep', '60']);
  assert.deepEqual(validateRunArgs({ name: 'cx', image: 'alpine', command: ['sh', '-c', 'a && b'] }).command, ['sh', '-c', 'a && b']);
  assert.deepEqual(validateRunArgs({ name: 'cx', image: 'alpine', command: '' }).command, []);
  throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'cx', image: 'alpine', command: ['a\nb'] }));
  throwsCode('BAD_ARGS', () => validateRunArgs({ name: 'cx', image: 'alpine', command: new Array(51).fill('x') }));
});

test('validateRunArgs workdir must be an absolute container path', () => {
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', workdir: '/app' }).workdir, '/app');
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', workdir: '' }).workdir, undefined);
  throwsCode('UNSAFE_PATH', () => validateRunArgs({ name: 'cx', image: 'alpine', workdir: 'app' }));
  throwsCode('UNSAFE_PATH', () => validateRunArgs({ name: 'cx', image: 'alpine', workdir: '/app/../etc' }));
  throwsCode('UNSAFE_PATH', () => validateRunArgs({ name: 'cx', image: 'alpine', workdir: "/app'x" }));
});

// ─── ports ───────────────────────────────────────────────────────────────────

const ports = (v: unknown) => validateRunArgs({ name: 'cx', image: 'alpine', ports: v }).ports;

test('port parsing accepts the documented string and object shapes', () => {
  assert.deepEqual(ports('8080:80'), [{ host: 8080, container: 80, protocol: 'tcp' }]);
  assert.deepEqual(ports('8080:80/udp'), [{ host: 8080, container: 80, protocol: 'udp' }]);
  assert.deepEqual(ports('127.0.0.1:8080:80'), [{ host: 8080, container: 80, protocol: 'tcp', hostIp: '127.0.0.1' }]);
  assert.deepEqual(ports('127.0.0.1:8080:80/udp'), [{ host: 8080, container: 80, protocol: 'udp', hostIp: '127.0.0.1' }]);
  assert.deepEqual(ports({ host: 8080, container: 80 }), [{ host: 8080, container: 80, protocol: 'tcp' }]);
  assert.deepEqual(ports({ host: '9000', container: '90', protocol: 'udp', hostIp: '10.0.1.7' }), [
    { host: 9000, container: 90, protocol: 'udp', hostIp: '10.0.1.7' },
  ]);
  assert.deepEqual(ports(['8080:80', '8443:443/tcp']), [
    { host: 8080, container: 80, protocol: 'tcp' },
    { host: 8443, container: 443, protocol: 'tcp' },
  ]);
  assert.deepEqual(ports('1:65535'), [{ host: 1, container: 65535, protocol: 'tcp' }], 'the range edges are inclusive');
});

test('port parsing rejects out-of-range, bad protocol and malformed shapes', () => {
  for (const v of ['70000:80', '8080:70000', '0:80', '8080:0']) {
    throwsCode('BAD_ARGS', () => ports(v), `range ${v}`);
  }
  for (const v of ['8080', '8080:', ':80', 'abc:def', '8080:80/sctp', '8080:80:70', '8080-80', '8080:80 ; id', '::1:8080:80']) {
    throwsCode('BAD_ARGS', () => ports(v), `malformed ${v}`);
  }
  throwsCode('BAD_ARGS', () => ports({ host: 8080, container: 80, protocol: 'sctp' }));
  throwsCode('BAD_ARGS', () => ports({ host: 8080, container: 80, hostIp: 'not-an-ip' }));
  throwsCode('BAD_ARGS', () => ports({ host: 70000, container: 80 }));
  throwsCode('BAD_ARGS', () => ports(new Array(21).fill('8080:80')), 'maxPorts is 20');
});

test('🔴 KNOWN DEFECT: an object port with a MISSING host/container yields -1', () => {
  // intInRange() treats '' as "absent" and returns its `def`, and validatePorts
  // passes def = -1 as a sentinel it never re-checks. So an object form that
  // omits a side produces port -1 instead of BAD_ARGS. Asserted as-is so the
  // behaviour is pinned and visible; see the report accompanying this file.
  assert.deepEqual(ports({ container: 80 }), [{ host: -1, container: 80, protocol: 'tcp' }]);
  assert.deepEqual(ports({ host: 8080 }), [{ host: 8080, container: -1, protocol: 'tcp' }]);
  assert.deepEqual(ports({}), [{ host: -1, container: -1, protocol: 'tcp' }]);
});

// ─── env ─────────────────────────────────────────────────────────────────────

const envOf = (v: unknown) => validateRunArgs({ name: 'cx', image: 'alpine', env: v }).env;

test('env accepts the object form and the ["K=V"] array form', () => {
  assert.deepEqual(envOf({ FOO: 'bar', _X9: '1' }), { FOO: 'bar', _X9: '1' });
  assert.deepEqual(envOf(['FOO=bar', 'BAZ=a=b']), { FOO: 'bar', BAZ: 'a=b' }, 'only the FIRST = splits');
  assert.deepEqual(envOf(['EMPTY=']), { EMPTY: '' });
  assert.deepEqual(envOf({ N: 42 }), { N: '42' }, 'values are stringified');
  assert.deepEqual(envOf(undefined), {});
  assert.deepEqual(envOf([]), {});
  // Values are opaque on purpose — a password may legitimately contain anything
  // but control characters, and argv keeps it intact.
  assert.deepEqual(envOf({ PW: 'p$a`s\'s"w;d' }), { PW: 'p$a`s\'s"w;d' });
});

test('env rejects bad key charsets, control chars, over-length values and overflow', () => {
  for (const k of ['1BAD', 'a-b', 'a b', 'a.b', 'a$b', '', 'a;id', 'PATH=x']) {
    throwsCode('BAD_ARGS', () => envOf({ [k]: 'v' }), `key ${JSON.stringify(k)}`);
  }
  throwsCode('BAD_ARGS', () => envOf({ K: 'a\nb' }), 'newline in value');
  throwsCode('BAD_ARGS', () => envOf({ K: 'a\rb' }));
  throwsCode('BAD_ARGS', () => envOf({ K: 'a\0b' }));
  throwsCode('BAD_ARGS', () => envOf({ K: 'x'.repeat(1025) }), 'MAX_ENV_VALUE_CHARS is 1024');
  assert.equal(envOf({ K: 'x'.repeat(1024) }).K.length, 1024);
  const many: Record<string, string> = {};
  for (let i = 0; i < 51; i++) many[`K${i}`] = 'v';
  throwsCode('BAD_ARGS', () => envOf(many), 'maxEnv is 50');
});

// ─── volumes: the containment boundary ───────────────────────────────────────

test('🔴 with NO volumeRoots configured every bind mount is refused (the default)', () => {
  assert.equal(process.env.LM_CONTAINER_VOLUME_ROOTS, undefined);
  const attempts: unknown[] = [
    `${UNDER}:/data`,
    `${OUTSIDE}:/data:ro`,
    { source: UNDER, target: '/data' },
    [`${UNDER}:/data`],
    IS_WIN ? 'C:\\:/host' : '/:/host',
  ];
  for (const v of attempts) {
    throwsCode('UNSAFE_PATH', () => validateRunArgs({ name: 'cx', image: 'alpine', volumes: v }), `should refuse ${JSON.stringify(v)}`);
  }
  // An EMPTY list is not a mount request, so it is not an error.
  assert.deepEqual(validateRunArgs({ name: 'cx', image: 'alpine', volumes: [] }).volumes, []);
  assert.deepEqual(validateRunArgs({ name: 'cx', image: 'alpine', volumes: undefined }).volumes, []);
});

test('with a volumeRoot configured, sources are CONTAINED to it', () => {
  withVolumeRoots(ROOT, () => {
    const vols = (v: unknown) => validateRunArgs({ name: 'cx', image: 'alpine', volumes: v }).volumes;

    assert.deepEqual(vols(`${UNDER}:/data`), [{ source: path.resolve(UNDER), target: '/data', readOnly: false }]);
    assert.deepEqual(vols(`${DEEPER}:/data:ro`), [{ source: path.resolve(DEEPER), target: '/data', readOnly: true }]);
    assert.deepEqual(vols({ source: UNDER, target: '/data', readOnly: true }), [
      { source: path.resolve(UNDER), target: '/data', readOnly: true },
    ]);
    assert.deepEqual(vols(`${ROOT}:/data`), [{ source: path.resolve(ROOT), target: '/data', readOnly: false }], 'the root itself is mountable');
    assert.deepEqual(vols(`${UNDER}:/data:rw`), [{ source: path.resolve(UNDER), target: '/data', readOnly: false }]);

    // 🔴 A SIBLING sharing the root's textual prefix is NOT under the root.
    throwsCode('UNSAFE_PATH', () => vols(`${SIBLING}:/data`), 'sibling prefix must not pass containment');
    throwsCode('UNSAFE_PATH', () => vols(`${OUTSIDE}:/data`), 'outside the root');
    throwsCode('UNSAFE_PATH', () => vols({ source: OUTSIDE, target: '/data' }));

    // Unsafe source charsets and traversal are refused before containment runs.
    throwsCode('UNSAFE_PATH', () => vols({ source: `${ROOT}${IS_WIN ? '\\' : '/'}..${IS_WIN ? '\\' : '/'}etc`, target: '/data' }));
    throwsCode('UNSAFE_PATH', () => vols({ source: `${UNDER}'x`, target: '/data' }));
    throwsCode('UNSAFE_PATH', () => vols({ source: 'relative/path', target: '/data' }));

    // Targets are container-side POSIX paths.
    throwsCode('UNSAFE_PATH', () => vols({ source: UNDER, target: 'data' }));
    throwsCode('UNSAFE_PATH', () => vols({ source: UNDER, target: '/da"ta' }));
    throwsCode('UNSAFE_PATH', () => vols({ source: UNDER, target: '/a/../b' }));

    // Malformed string shapes.
    throwsCode('BAD_ARGS', () => vols('/data'));
    throwsCode('BAD_ARGS', () => vols(':/data'));
    throwsCode('BAD_ARGS', () => vols(new Array(11).fill(`${UNDER}:/data`)), 'maxVolumes is 10');
  });
  assert.equal(process.env.LM_CONTAINER_VOLUME_ROOTS, undefined, 'the env must be restored');
});

test('validateHostPath enforces an absolute, quote-free, traversal-free path', () => {
  if (IS_WIN) {
    assert.equal(validateHostPath('C:\\srv\\data', 'p'), 'C:\\srv\\data');
    throwsCode('UNSAFE_PATH', () => validateHostPath('/srv/data', 'p'), 'a POSIX path is not absolute on Windows');
    throwsCode('UNSAFE_PATH', () => validateHostPath('C:\\srv\\a\\..\\b', 'p'));
    throwsCode('UNSAFE_PATH', () => validateHostPath("C:\\srv\\x'y", 'p'));
    throwsCode('UNSAFE_PATH', () => validateHostPath('C:\\srv\\$(id)', 'p'));
  } else {
    assert.equal(validateHostPath('/srv/data', 'p'), '/srv/data');
    throwsCode('UNSAFE_PATH', () => validateHostPath('srv/data', 'p'));
    throwsCode('UNSAFE_PATH', () => validateHostPath('/srv/a/../b', 'p'));
    throwsCode('UNSAFE_PATH', () => validateHostPath("/srv/x'y", 'p'));
    throwsCode('UNSAFE_PATH', () => validateHostPath('/srv/$(id)', 'p'));
  }
  throwsCode('UNSAFE_PATH', () => validateHostPath('', 'p'));
  throwsCode('UNSAFE_PATH', () => validateHostPath(null, 'p'));
});

// ─── notes ───────────────────────────────────────────────────────────────────

test('notes are sanitized for embedding in a docker label', () => {
  const spec = validateRunArgs({
    name: 'cx',
    image: 'alpine',
    notes: 'line1\nline2\r\nline3, with "dq" and \'sq\' and `tick` and $var',
  });
  assert.ok(spec.notes);
  const n = spec.notes!;
  assert.ok(!/[\r\n]/.test(n), 'newlines are folded to a space');
  assert.ok(!n.includes(','), 'commas are dropped — docker ps renders labels comma-joined');
  assert.ok(!n.includes('"'));
  assert.ok(!n.includes("'"));
  assert.ok(!n.includes('`'));
  assert.ok(!n.includes('$'));
  assert.ok(n.startsWith('line1 line2'));

  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', notes: 'x'.repeat(600) }).notes!.length, 500, 'capped at MAX_NOTES_CHARS');
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', notes: '   ' }).notes, undefined, 'blank notes become undefined');
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine', notes: ',,,' }).notes, undefined, 'notes that sanitize away become undefined');
  assert.equal(validateRunArgs({ name: 'cx', image: 'alpine' }).notes, undefined);
});

// ─── containment primitive ───────────────────────────────────────────────────

test('isUnderRoot containment: the root itself and sibling prefixes are OUT', () => {
  assert.equal(isUnderRoot('/srv/data', '/srv/data/x'), true);
  assert.equal(isUnderRoot('/srv/data', '/srv/data/a/b/c'), true);
  assert.equal(isUnderRoot('/srv/data', '/srv/data'), false, 'the root itself is not "under" the root');
  // 🔴 The textual-prefix trap: /srv/data-evil starts with /srv/data.
  assert.equal(isUnderRoot('/srv/data', '/srv/data-evil'), false, 'sibling prefix must not match');
  assert.equal(isUnderRoot('/srv/data', '/srv/data-evil/x'), false);
  assert.equal(isUnderRoot('/srv/data', '/srv/other'), false);
  assert.equal(isUnderRoot('/srv/data', '/srv'), false, 'the parent is not under the child');
  assert.equal(isUnderRoot('/srv/data', '/srv/data/../data-evil'), false, 'traversal is resolved before comparison');
  assert.equal(isUnderRoot('/srv/data', '/srv/data/./x'), true);

  if (IS_WIN) {
    assert.equal(isUnderRoot('C:\\srv\\data', 'C:\\srv\\data\\x'), true);
    assert.equal(isUnderRoot('C:\\srv\\data', 'c:\\SRV\\DATA\\x'), true, 'case-insensitive on Windows');
    assert.equal(isUnderRoot('C:\\srv\\data', 'C:\\srv\\data-evil\\x'), false);
    assert.equal(isUnderRoot('C:\\srv\\data', 'C:\\srv\\data'), false);
    assert.equal(isUnderRoot('C:\\srv\\data', 'D:\\srv\\data\\x'), false, 'a different drive is never under the root');
    assert.equal(isUnderRoot('C:\\srv\\data', 'C:\\Windows\\System32'), false);
  }
});
