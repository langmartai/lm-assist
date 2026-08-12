/**
 * Container management — THE single import surface (vm/service.ts pattern).
 *
 * Routes and MCP tools import from HERE and nowhere else. This module:
 *   - selects the engine backend (Docker, on every platform that has a daemon),
 *   - VALIDATES every caller argument BEFORE it can reach the engine (names,
 *     image refs, env keys, ports, mount paths, numbers against configured
 *     limits),
 *   - CONTAINS bind mounts to the configured volume roots — empty by default,
 *     so a mount is refused unless an operator opted in,
 *   - enforces the MANAGED-CONTAINER safety gate: delete, stop and restart
 *     refuse a container lm-assist did not create unless force:true,
 *   - serializes container WRITES behind a bounded single-flight mutex,
 *   - keeps reads (status/list/get/logs/images) lock-free.
 *
 * 🔴 Why stop/restart are gated when the VM feature left power ungated: this
 * fleet's Linux nodes run REAL services in containers (a Postgres, a proxy).
 * `stop` on the wrong name is an outage, and a container name is a much easier
 * thing to typo into than a VM name. `start` stays ungated — starting a stopped
 * container is not destructive.
 *
 * A docker flag must never appear here; a model-facing string must never
 * appear in the backend.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CONTAINER_NAME_RE,
  CONTAINER_PATH_RE,
  DEFAULT_LOG_LINES,
  DEFAULT_PULL,
  DEFAULT_RESTART,
  ENV_KEY_RE,
  IMAGE_REF_RE,
  MAX_CONTAINERS_LISTED,
  MAX_IMAGES_LISTED,
  MAX_ENV_VALUE_CHARS,
  MAX_LOG_LINES,
  MAX_STOP_TIMEOUT_SEC,
  MAX_NOTES_CHARS,
  MUTEX_WAIT_MS,
  NETWORK_NAME_RE,
  STOP_DEFAULT_TIMEOUT_SEC,
  defaultNetwork,
  effectiveLimits,
  volumeRoots,
} from './config';
import { DockerBackend, isUnderRoot } from './docker-backend';
import {
  ContainerBackend,
  ContainerBackendStatus,
  ContainerDeleteResult,
  ContainerError,
  ContainerImage,
  ContainerInfo,
  ContainerLogsResult,
  ContainerRunSpec,
  PortMapping,
  PullPolicy,
  RestartPolicy,
  VolumeMount,
} from './types';

// ─── backend selection (cached per process) ──────────────────────────────────

let cached: ContainerBackend | null = null;
export function containerBackend(): ContainerBackend {
  if (cached) return cached;
  // One binary, every platform — the daemon probe inside the backend is what
  // varies, not the backend itself.
  cached = new DockerBackend();
  return cached;
}

/** Test hook — lets the validation tests run without a real engine. */
export function _setBackendForTests(b: ContainerBackend | null): void {
  cached = b;
}

// ─── bounded single-flight mutex for container WRITES (vm/service.ts pattern) ─

let writeChain: Promise<unknown> = Promise.resolve();
async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prior = writeChain;
  let release!: () => void;
  const slot = new Promise<void>((r) => (release = r));
  // 🔴 Chain the new slot BEHIND `prior` rather than replacing it. Replacing it
  // means a caller that gives up on the wait (BUSY) resolves the chain while
  // the operation it was waiting for is STILL RUNNING — and the next caller
  // then acquires instantly and runs concurrently with it. One 30s timeout
  // would silently unserialize every write after it, which is the opposite of
  // what a BUSY refusal promises. Any `docker run` that pulls for >30s reaches
  // this, because RUN_TIMEOUT_MS (110s) is far longer than MUTEX_WAIT_MS.
  writeChain = prior.then(() => slot).catch(() => slot);
  let timer: NodeJS.Timeout | undefined;
  const waited = await Promise.race([
    prior.then(() => true).catch(() => true),
    new Promise<false>((r) => {
      timer = setTimeout(() => r(false), MUTEX_WAIT_MS);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer); // the losing race timer must not keep a handle alive
  if (!waited) {
    release(); // our slot never ran; the chain still waits on `prior` first
    throw new ContainerError('BUSY', `another container operation is in progress (waited ${MUTEX_WAIT_MS}ms). Retry shortly.`);
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

// ─── validation (exported for tests) ─────────────────────────────────────────

export function validateContainerName(name: unknown, label = 'name'): string {
  const n = String(name ?? '').trim();
  if (!CONTAINER_NAME_RE.test(n)) {
    throw new ContainerError(
      'BAD_ARGS',
      `${label} must match ${String(CONTAINER_NAME_RE)} (start alphanumeric; letters, digits, dot, underscore, hyphen; max 64) — got "${String(name ?? '').slice(0, 80)}"`,
    );
  }
  return n;
}

export function validateImageRef(image: unknown): string {
  const s = String(image ?? '').trim();
  if (!IMAGE_REF_RE.test(s) || s.split(/[/:]/).some((seg) => seg === '..')) {
    throw new ContainerError(
      'BAD_ARGS',
      `image must be a reference like "alpine:3.20", "ghcr.io/org/app:tag" or "repo@sha256:…" without quote/expansion characters — got "${s.slice(0, 120)}"`,
    );
  }
  return s;
}

function intInRange(v: unknown, def: number, lo: number, hi: number, label: string): number {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new ContainerError('BAD_ARGS', `${label} must be an integer in [${lo}, ${hi}] — got ${String(v)}`);
  }
  return n;
}

/** An absolute HOST path safe to embed in a mount spec. Rejects ".." on the RAW
 *  input — path.resolve would silently normalize it away, and a caller writing
 *  ".." is a caller to refuse (the vm/service.ts rule). */
export function validateHostPath(p: unknown, label: string): string {
  const s = String(p ?? '').trim();
  const winOk = /^[A-Za-z]:[\\/][^'"`$\r\n:]*$/.test(s);
  const posixOk = /^\/[^'"`$\r\n:]*$/.test(s);
  if (!(process.platform === 'win32' ? winOk : posixOk)) {
    throw new ContainerError(
      'UNSAFE_PATH',
      `${label} must be an absolute path without quote/expansion characters or colons — got "${s.slice(0, 120)}"`,
    );
  }
  if (s.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new ContainerError('UNSAFE_PATH', `${label} must not contain ".." segments`);
  }
  return path.resolve(s);
}

function validateContainerPath(p: unknown, label: string): string {
  const s = String(p ?? '').trim();
  if (!CONTAINER_PATH_RE.test(s) || s.split('/').some((seg) => seg === '..')) {
    throw new ContainerError('UNSAFE_PATH', `${label} must be an absolute path inside the container (POSIX, no quotes, no "..") — got "${s.slice(0, 120)}"`);
  }
  return s;
}

function sanitizeNotes(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  // Notes become a LABEL VALUE. Commas are dropped because `docker ps` renders
  // labels as a comma-joined string — a comma in a value makes that rendering
  // ambiguous for anything that parses it.
  const s = String(v)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[,'"`$]/g, '')
    .trim()
    .slice(0, MAX_NOTES_CHARS);
  return s || undefined;
}

/** `"8080:80"`, `"8080:80/udp"`, `"127.0.0.1:8080:80"`, or `{host,container}`. */
function validatePorts(v: unknown, max: number): PortMapping[] {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  if (arr.length > max) throw new ContainerError('BAD_ARGS', `at most ${max} port mappings (got ${arr.length})`);
  return arr.map((raw) => {
    let hostIp: string | undefined;
    let hostStr: string;
    let contStr: string;
    let proto = 'tcp';
    if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      hostStr = String(o.host ?? '');
      contStr = String(o.container ?? '');
      proto = String(o.protocol || 'tcp');
      if (o.hostIp !== undefined && o.hostIp !== null) hostIp = String(o.hostIp);
    } else {
      const s = String(raw ?? '').trim();
      const m = s.match(/^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/);
      if (!m) {
        throw new ContainerError('BAD_ARGS', `port must look like "8080:80", "8080:80/udp" or "127.0.0.1:8080:80" — got "${s.slice(0, 60)}"`);
      }
      hostIp = m[1];
      hostStr = m[2];
      contStr = m[3];
      proto = m[4] || 'tcp';
    }
    // Both sides are REQUIRED. Passing a default to intInRange would let an
    // omitted `host` fall through as the sentinel and reach docker as
    // `--publish -1:80/tcp` — an opaque engine error instead of the typed
    // BAD_ARGS that names the missing field.
    if (!String(hostStr).trim() || !String(contStr).trim()) {
      throw new ContainerError('BAD_ARGS', `a port mapping needs both a host and a container port — got host="${hostStr}", container="${contStr}"`);
    }
    const host = intInRange(hostStr, NaN, 1, 65535, 'port host');
    const container = intInRange(contStr, NaN, 1, 65535, 'port container');
    if (proto !== 'tcp' && proto !== 'udp') throw new ContainerError('BAD_ARGS', `port protocol must be tcp or udp — got "${proto}"`);
    if (hostIp !== undefined && !/^\d{1,3}(\.\d{1,3}){3}$/.test(hostIp)) {
      throw new ContainerError('BAD_ARGS', `port hostIp must be an IPv4 address — got "${hostIp.slice(0, 40)}"`);
    }
    return { host, container, protocol: proto as 'tcp' | 'udp', ...(hostIp ? { hostIp } : {}) };
  });
}

/**
 * Resolve SYMLINKS before a containment decision.
 *
 * 🔴 Lexical containment is not containment. `path.resolve` normalizes `..`
 * and separators but never follows a link, so a symlink sitting inside a
 * configured volumeRoot — `/srv/data/current -> /` — passes an
 * `isUnderRoot('/srv/data', …)` string test while the DAEMON follows it and
 * bind-mounts the host root into the container. A container can even create
 * that link itself through an earlier, entirely legal mount. The check must
 * therefore run on the real path, on BOTH sides (a root may itself be a link).
 *
 * A path that does not exist yet resolves as far as it can and keeps the
 * remainder: the containment test still sees through any link on the existing
 * prefix, which is the part an attacker controls.
 */
function realpathForContainment(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p; // reached the root without resolving
    try {
      return path.join(realpathForContainment(parent), path.basename(p));
    } catch {
      return p;
    }
  }
}

/** `"/srv/data:/data"`, `"/srv/data:/data:ro"`, or `{source,target,readOnly}`.
 *  Sources are CONTAINED to the configured volume roots — empty roots ⇒ refuse. */
function validateVolumes(v: unknown, max: number): VolumeMount[] {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  if (!arr.length) return [];
  const roots = volumeRoots();
  if (!roots.length) {
    throw new ContainerError(
      'UNSAFE_PATH',
      'bind mounts are disabled on this node: no volumeRoots are configured. A bind mount hands a host directory to a container process that is often root, so it must be opted into explicitly — set volumeRoots (absolute paths) via PUT /container/config or LM_CONTAINER_VOLUME_ROOTS.',
    );
  }
  if (arr.length > max) throw new ContainerError('BAD_ARGS', `at most ${max} volumes (got ${arr.length})`);
  return arr.map((raw) => {
    let source: unknown;
    let target: unknown;
    let readOnly = false;
    if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      source = o.source;
      target = o.target;
      readOnly = o.readOnly === true || o.ro === true;
    } else {
      const s = String(raw ?? '').trim();
      // Split off an optional trailing :ro/:rw, then on the LAST remaining
      // colon — a Windows source ("C:\srv") legitimately contains one.
      const mode = s.match(/:(ro|rw)$/i);
      const body = mode ? s.slice(0, -3) : s;
      const i = body.lastIndexOf(':');
      if (i <= 0) throw new ContainerError('BAD_ARGS', `volume must look like "/host/path:/container/path[:ro]" — got "${s.slice(0, 80)}"`);
      source = body.slice(0, i);
      target = body.slice(i + 1);
      readOnly = !!mode && mode[1].toLowerCase() === 'ro';
    }
    const src = realpathForContainment(validateHostPath(source, 'volume source'));
    if (!roots.some((r) => isUnderRoot(realpathForContainment(r), src))) {
      throw new ContainerError(
        'UNSAFE_PATH',
        `volume source "${src}" is outside the configured volumeRoots (${roots.join(', ')}) — mounts are contained to those roots.`,
      );
    }
    return { source: src, target: validateContainerPath(target, 'volume target'), readOnly };
  });
}

function validateEnv(v: unknown, max: number): Record<string, string> {
  if (v === undefined || v === null) return {};
  const out: Record<string, string> = {};
  const entries: Array<[string, unknown]> = Array.isArray(v)
    ? v.map((e) => {
        const s = String(e ?? '');
        const i = s.indexOf('=');
        return [i > 0 ? s.slice(0, i) : s, i > 0 ? s.slice(i + 1) : ''] as [string, unknown];
      })
    : Object.entries(v as Record<string, unknown>);
  if (entries.length > max) throw new ContainerError('BAD_ARGS', `at most ${max} environment variables (got ${entries.length})`);
  for (const [k, raw] of entries) {
    if (!ENV_KEY_RE.test(k)) {
      throw new ContainerError('BAD_ARGS', `environment variable name must match ${String(ENV_KEY_RE)} — got "${String(k).slice(0, 60)}"`);
    }
    const val = String(raw ?? '');
    if (val.length > MAX_ENV_VALUE_CHARS) {
      throw new ContainerError('BAD_ARGS', `environment value for ${k} exceeds ${MAX_ENV_VALUE_CHARS} characters`);
    }
    if (/[\r\n\0]/.test(val)) throw new ContainerError('BAD_ARGS', `environment value for ${k} must not contain newlines or NUL`);
    out[k] = val;
  }
  return out;
}

function validateCommand(v: unknown, max: number): string[] {
  if (v === undefined || v === null || v === '') return [];
  // A string command is split on whitespace: this is an ARGV array, not a
  // shell line, so "sh -c 'a && b'" would have to be passed as an array.
  const arr = Array.isArray(v) ? v : String(v).trim().split(/\s+/).filter(Boolean);
  if (arr.length > max) throw new ContainerError('BAD_ARGS', `command may have at most ${max} arguments (got ${arr.length})`);
  return arr.map((a) => {
    const s = String(a ?? '');
    if (/[\r\n\0]/.test(s)) throw new ContainerError('BAD_ARGS', 'command arguments must not contain newlines or NUL');
    return s;
  });
}

/** Docker modes that LOOK like network names but are not. See validateRunArgs. */
const RESERVED_NETWORKS = ['host', 'container'];

const RESTART_POLICIES: RestartPolicy[] = ['no', 'always', 'unless-stopped', 'on-failure'];
const PULL_POLICIES: PullPolicy[] = ['missing', 'always', 'never'];

export interface ContainerRunArgs {
  name: unknown;
  image: unknown;
  command?: unknown;
  env?: unknown;
  ports?: unknown;
  volumes?: unknown;
  restart?: unknown;
  memoryMB?: unknown;
  cpus?: unknown;
  network?: unknown; // string | null (null = --network none)
  workdir?: unknown;
  autoRemove?: unknown;
  pull?: unknown;
  notes?: unknown;
}

export function validateRunArgs(args: ContainerRunArgs): ContainerRunSpec {
  const limits = effectiveLimits();
  const name = validateContainerName(args.name);
  const image = validateImageRef(args.image);
  const restart = args.restart === undefined || args.restart === null ? DEFAULT_RESTART : String(args.restart);
  if (!(RESTART_POLICIES as string[]).includes(restart)) {
    throw new ContainerError('BAD_ARGS', `restart must be one of ${RESTART_POLICIES.join('|')} — got "${restart.slice(0, 40)}"`);
  }
  const pull = args.pull === undefined || args.pull === null ? DEFAULT_PULL : String(args.pull);
  if (!(PULL_POLICIES as string[]).includes(pull)) {
    throw new ContainerError('BAD_ARGS', `pull must be one of ${PULL_POLICIES.join('|')} — got "${pull.slice(0, 40)}"`);
  }
  let network: string | null | undefined;
  if (args.network === null) network = null;
  else if (args.network !== undefined && args.network !== '') {
    const n = String(args.network).trim();
    if (!NETWORK_NAME_RE.test(n)) throw new ContainerError('BAD_ARGS', `network must match ${String(NETWORK_NAME_RE)} — got "${n.slice(0, 80)}"`);
    // 🔴 `host` is a MAGIC value, not a network: it drops the container into
    // the host's network namespace, which defeats the published-port model
    // entirely and exposes every loopback-bound service on the node (Core's own
    // API, the elevated worker on 127.0.0.1:3110, a local database) to the
    // container. That is the same "reaches back out of the sandbox" hazard that
    // keeps bind mounts off by default, so it is refused here too. Use
    // network:null for no networking.
    if (RESERVED_NETWORKS.includes(n.toLowerCase())) {
      throw new ContainerError(
        'BAD_ARGS',
        `network "${n}" is a reserved Docker mode, not a network. "host" would put the container in the host's network namespace (every 127.0.0.1 service on this node becomes reachable) — lm-assist does not hand that out. Use a named network, or network:null for none.`,
      );
    }
    network = n;
  } else {
    const d = defaultNetwork();
    network = d === null ? undefined : d;
  }
  const autoRemove = args.autoRemove === true;
  // Docker itself refuses `--restart` with `--rm`. Dropping one of them in the
  // backend would hand back a container that quietly does not match what was
  // asked for — the same silent-drop the config route refuses by name.
  if (autoRemove && restart !== 'no') {
    throw new ContainerError('BAD_ARGS', `restart:"${restart}" and autoRemove are mutually exclusive — Docker refuses --restart together with --rm. Pick one.`);
  }
  return {
    name,
    image,
    command: validateCommand(args.command, limits.maxCommandArgs),
    env: validateEnv(args.env, limits.maxEnv),
    ports: validatePorts(args.ports, limits.maxPorts),
    volumes: validateVolumes(args.volumes, limits.maxVolumes),
    restart: restart as RestartPolicy,
    // `''` counts as "unset" here, not as a value: letting it through to
    // intInRange would return the default (0) and emit `--memory 0m`.
    memoryMB:
      args.memoryMB === undefined || args.memoryMB === null || args.memoryMB === ''
        ? null
        : intInRange(args.memoryMB, NaN, 6, limits.maxMemoryMB, 'memoryMB'),
    cpus: args.cpus === undefined || args.cpus === null || args.cpus === '' ? null : validateCpus(args.cpus, limits.maxCpus),
    network,
    workdir: args.workdir === undefined || args.workdir === null || args.workdir === '' ? undefined : validateContainerPath(args.workdir, 'workdir'),
    autoRemove,
    pull: pull as PullPolicy,
    notes: sanitizeNotes(args.notes),
  };
}

/** CPU quota may be fractional (0.5 = half a core).
 *  Round FIRST, then range-check: rounding afterwards turns cpus:0.004 into
 *  exactly 0, and `--cpus 0` means "no limit" to the engine — silently removing
 *  the cap the caller asked for. */
function validateCpus(v: unknown, max: number): number {
  const n = Number(v);
  const r = Math.round(n * 100) / 100;
  if (!Number.isFinite(r) || r <= 0 || r > max) {
    throw new ContainerError('BAD_ARGS', `cpus must be a number in (0, ${max}] with at most 2 decimals — got ${String(v)}`);
  }
  return r;
}

// ─── reads ───────────────────────────────────────────────────────────────────

export async function containerStatus(
  name?: unknown,
  opts: { images?: unknown } = {},
): Promise<{
  status: ContainerBackendStatus;
  container?: ContainerInfo;
  containers?: ContainerInfo[];
  total?: number;
  truncated?: boolean;
  images?: ContainerImage[];
  imagesTotal?: number;
  imagesTruncated?: boolean;
}> {
  const status = await containerBackend().status();
  if (name !== undefined && name !== null && name !== '') {
    const container = await containerBackend().get(validateContainerName(name));
    // `images` is an independent modifier, as the tool description says — so
    // honour it here too rather than silently dropping it when a name is given.
    if (opts.images !== true) return { status, container };
    const imgs = await containerImages().catch(() => null);
    return imgs ? { status, container, ...imgs } : { status, container };
  }
  if (!status.available) return { status };
  // No name → doctor + bounded inventory (the MCP surface's list view).
  const list = await containerList().catch(() => null);
  const base = list ? { status, ...list } : { status };
  if (opts.images !== true) return base;
  const imgs = await containerImages().catch(() => null);
  return imgs ? { ...base, ...imgs } : base;
}

export async function containerList(): Promise<{ containers: ContainerInfo[]; total: number; truncated: boolean }> {
  const all = await containerBackend().list();
  const truncated = all.length > MAX_CONTAINERS_LISTED;
  return { containers: truncated ? all.slice(0, MAX_CONTAINERS_LISTED) : all, total: all.length, truncated };
}

export async function containerImages(): Promise<{ images: ContainerImage[]; imagesTotal: number; imagesTruncated: boolean }> {
  const all = await containerBackend().images();
  const imagesTruncated = all.length > MAX_IMAGES_LISTED;
  return {
    images: imagesTruncated ? all.slice(0, MAX_IMAGES_LISTED) : all,
    imagesTotal: all.length, // the REAL count, not the capped one
    imagesTruncated,
  };
}

export async function containerLogs(
  name: unknown,
  opts: { lines?: unknown; since?: unknown; timestamps?: unknown } = {},
): Promise<ContainerLogsResult> {
  const n = validateContainerName(name);
  const lines = intInRange(opts.lines, DEFAULT_LOG_LINES, 1, MAX_LOG_LINES, 'lines');
  let since: string | undefined;
  if (opts.since !== undefined && opts.since !== null && opts.since !== '') {
    const s = String(opts.since).trim();
    // A duration ("10m", "2h") or an RFC3339 timestamp — nothing else reaches docker.
    if (!/^\d+[smhd]$/.test(s) && !/^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) {
      throw new ContainerError('BAD_ARGS', `since must be a duration like "10m"/"2h" or an RFC3339 timestamp — got "${s.slice(0, 60)}"`);
    }
    since = s;
  }
  return containerBackend().logs(n, { lines, since, timestamps: opts.timestamps === true });
}

// ─── writes (mutex-guarded) ──────────────────────────────────────────────────

export async function containerRun(args: ContainerRunArgs): Promise<ContainerInfo> {
  const spec = validateRunArgs(args);
  return withWriteLock(async () => {
    const b = containerBackend();
    const { total } = await containerList().catch(() => ({ total: 0 }));
    const limits = effectiveLimits();
    if (total >= limits.maxContainers) {
      throw new ContainerError(
        'BAD_ARGS',
        `host already has ${total} containers (limit ${limits.maxContainers}) — raise limits.maxContainers in the container config to run more`,
      );
    }
    return b.run(spec);
  });
}

export type ContainerPowerAction = 'start' | 'stop' | 'restart';

export async function containerPower(
  action: unknown,
  name: unknown,
  opts: { force?: unknown; timeoutSec?: unknown } = {},
): Promise<ContainerInfo> {
  const act = String(action ?? '') as ContainerPowerAction;
  if (!['start', 'stop', 'restart'].includes(act)) {
    throw new ContainerError('BAD_ARGS', `action must be one of start|stop|restart — got "${String(action).slice(0, 40)}"`);
  }
  const n = validateContainerName(name);
  const force = opts.force === true;
  // The accepted range is what the spawn budget can actually HONOUR. Accepting
  // 600s while the backend kills the CLI at STOP_MAX_TIMEOUT_MS would report a
  // perfectly normal graceful shutdown as CONTAINER_TIMEOUT while the daemon
  // quietly finished it.
  const timeoutSec = intInRange(opts.timeoutSec, STOP_DEFAULT_TIMEOUT_SEC, 1, MAX_STOP_TIMEOUT_SEC, 'timeoutSec');
  return withWriteLock(async () => {
    const b = containerBackend();
    const cur = await b.get(n); // CONTAINER_NOT_FOUND propagates before any action
    if (act === 'start') {
      if (cur.state === 'running') return cur; // idempotent
      // A paused container cannot be started — the daemon says "try unpause
      // instead", which would surface as an opaque CONTAINER_OP_FAILED and
      // leave a paused container unrecoverable through this surface.
      if (cur.state === 'paused') return b.unpause(n);
      return b.start(n);
    }
    // stop/restart interrupt a service — refuse on containers lm-assist does
    // not own unless the caller says so explicitly.
    if (!cur.managed && !force) {
      throw new ContainerError(
        'CONTAINER_NOT_MANAGED',
        `container "${n}" was not created by lm-assist (no ${'managed label'}), and ${act} would interrupt whatever it is serving. Pass force:true to ${act} it anyway.`,
      );
    }
    if (act === 'restart') return b.restart(n, { timeoutSec });
    if (cur.state === 'exited' || cur.state === 'created' || cur.state === 'dead') return cur; // idempotent
    return b.stop(n, { force, timeoutSec });
  });
}

export async function containerDelete(
  name: unknown,
  opts: { force?: unknown; removeImage?: unknown } = {},
): Promise<ContainerDeleteResult> {
  const n = validateContainerName(name);
  const force = opts.force === true;
  const removeImage = opts.removeImage === true;
  return withWriteLock(async () => {
    const b = containerBackend();
    const cur = await b.get(n); // CONTAINER_NOT_FOUND propagates before any damage
    if (!cur.managed && !force) {
      throw new ContainerError(
        'CONTAINER_NOT_MANAGED',
        `container "${n}" was not created by lm-assist (no ${'managed label'}). Pass force:true to delete it anyway.`,
      );
    }
    return b.remove(n, { force, removeImage });
  });
}
