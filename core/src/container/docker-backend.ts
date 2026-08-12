/**
 * Docker backend — implements the ContainerBackend contract in types.ts.
 *
 * ── Execution model ──────────────────────────────────────────────────────────
 * Every operation is a `docker` invocation with an ARGV ARRAY (never a shell),
 * so nothing is ever re-parsed — injection-proof by construction. One binary
 * covers every platform; what differs is only HOW the daemon is reached
 * (npipe on Windows / Docker Desktop, a unix socket on Linux) and whether a
 * `sudo -n` prefix is needed, so there is one backend with a platform-aware
 * probe rather than two backends.
 *
 * ── Probing (the VM lesson, applied) ─────────────────────────────────────────
 * 🔴 Availability is decided by RUNNING `docker version` and looking for a
 * SERVER block — never by checking group membership and never by the client
 * version alone. `docker` on PATH proves nothing: on host 107 the CLI is
 * installed and exits 1 because Docker Desktop is not running. Group probes
 * lie in the other direction too — being in `docker` on paper does not mean the
 * socket answers this process (a fresh membership needs a new login session).
 * And, exactly as `virsh` access did not imply filesystem rights for the KVM
 * backend, daemon access here does not imply anything about the host paths a
 * caller wants to bind-mount: that is enforced separately in service.ts.
 *
 * Created containers carry `lm-assist=managed`; the safety gates in service.ts
 * key on it. `managed` in list() comes from a LABEL-FILTERED id query rather
 * than from parsing `docker ps`'s comma-joined label string, which is
 * ambiguous the moment a label value contains a comma.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import {
  DELETE_TIMEOUT_MS,
  GET_TIMEOUT_MS,
  IMAGES_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
  LOGS_TIMEOUT_MS,
  MANAGED_LABEL,
  MANAGED_LABEL_VALUE,
  MAX_IMAGES_LISTED,
  MAX_LOG_BYTES,
  NOTES_LABEL,
  RUN_TIMEOUT_MS,
  START_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  STOP_BASE_TIMEOUT_MS,
  STOP_MAX_TIMEOUT_MS,
  defaultEndpoint,
  dockerBin,
  dockerHost,
  elevationMode,
} from './config';
import {
  ContainerBackend,
  ContainerBackendStatus,
  ContainerDeleteResult,
  ContainerError,
  ContainerImage,
  ContainerInfo,
  ContainerLogsResult,
  ContainerRunSpec,
  ContainerState,
  PortMapping,
} from './types';

// ─── exec (argv arrays; optional sudo -n prefix on Linux) ────────────────────

interface Run {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runArgv(argv: string[], timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const host = dockerHost();
    const env = host ? { ...process.env, DOCKER_HOST: host } : process.env;
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    let done = false;
    const CAP = 4 * 1024 * 1024;
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < CAP) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < CAP) stderr += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n[killed after ${timeoutMs}ms]` });
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${e.message}` });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

/** Like runArgv, but keeps ONE combined buffer in arrival order (plus stderr
 *  separately, so a CLI error can still be reported). Used for `docker logs`,
 *  where stdout and stderr are two halves of one chronological stream. */
function runLogs(argv: string[], timeoutMs: number): Promise<{ exitCode: number | null; combined: string; stderr: string }> {
  return new Promise((resolve) => {
    const host = dockerHost();
    const env = host ? { ...process.env, DOCKER_HOST: host } : process.env;
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env });
    let combined = '';
    let stderr = '';
    let done = false;
    const CAP = 4 * 1024 * 1024;
    const onData = (d: Buffer, isErr: boolean) => {
      const s = d.toString('utf8');
      if (combined.length < CAP) combined += s;
      if (isErr && stderr.length < CAP) stderr += s;
    };
    child.stdout.on('data', (d: Buffer) => onData(d, false));
    child.stderr.on('data', (d: Buffer) => onData(d, true));
    const finish = (exitCode: number | null, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode, combined, stderr: `${stderr}${extra}` });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      finish(null, `\n[killed after ${timeoutMs}ms]`);
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (e) => finish(null, `\n${e.message}`));
    child.on('close', (code) => finish(code));
  });
}

type Prefix = 'root' | 'direct' | 'sudo' | 'unavailable';
let cachedPrefix: Prefix | null = null;
/** Why the probe failed, kept for status()'s `reason`. */
let lastProbeError = '';

/** Does this `docker version` output prove a reachable DAEMON (not just a CLI)? */
function hasServer(stdout: string): boolean {
  try {
    const v = JSON.parse(stdout) as { Server?: unknown };
    return !!v && typeof v === 'object' && !!v.Server;
  } catch {
    return false;
  }
}

/** Decide how docker runs on this host (cached per process; status() re-probes). */
async function probePrefix(): Promise<Prefix> {
  lastProbeError = '';
  const bin = dockerBin();
  const mode = elevationMode();
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const verArgs = ['version', '--format', '{{json .}}'];
  if (mode !== 'always') {
    const direct = await runArgv([bin, ...verArgs], 15_000);
    if (direct.exitCode === 0 && hasServer(direct.stdout)) return isRoot ? 'root' : 'direct';
    lastProbeError = (direct.stderr || direct.stdout).trim().split('\n').slice(0, 2).join(' ').slice(0, 300);
    if (mode === 'never') return 'unavailable';
  }
  // sudo only exists as a privileged path on POSIX hosts; on Windows the
  // equivalent gap is "Docker Desktop is not running", which no prefix fixes.
  if (process.platform === 'win32' || isRoot) return 'unavailable';
  const sudo = await runArgv(['sudo', '-n', bin, ...verArgs], 15_000);
  if (sudo.exitCode === 0 && hasServer(sudo.stdout)) return 'sudo';
  return 'unavailable';
}

async function prefix(): Promise<Prefix> {
  if (cachedPrefix === null) cachedPrefix = await probePrefix();
  return cachedPrefix;
}

/** Build the argv for a docker call under the active privilege prefix. */
async function dockerArgv(args: string[]): Promise<string[]> {
  const p = await prefix();
  if (p === 'unavailable') {
    throw new ContainerError('DOCKER_UNAVAILABLE', unavailableReason());
  }
  const base = [dockerBin(), ...args];
  return p === 'sudo' ? ['sudo', '-n', ...base] : base;
}

function unavailableReason(): string {
  const detail = lastProbeError ? ` (${lastProbeError})` : '';
  if (process.platform === 'win32') {
    return `the Docker daemon is not reachable${detail}. Start Docker Desktop on this host, or set dockerHost in the container config.`;
  }
  return `the Docker daemon is not reachable${detail}. Install Docker Engine, then either add the Core user to the docker group (and restart Core so the new group takes effect) or grant passwordless sudo for docker.`;
}

const NOT_FOUND_RE = /no such (container|object)|no such image/i;
/** Docker's NAME conflict, specifically. It must NOT be the loose
 *  /already in use/ — a host PORT collision says "bind: address already in
 *  use", and reporting that as CONTAINER_EXISTS tells a caller the name is
 *  taken when the name is fine and the PORT is not. */
const CONFLICT_RE = /conflict\.\s*the container name|is already in use by container/i;
/** Checked BEFORE the conflict rule for exactly that reason. */
const PORT_TAKEN_RE = /port is already allocated|bind: address already in use|ports are not available|address already in use/i;
const IMAGE_MISSING_RE = /no such image|manifest unknown|not found: manifest|pull access denied|unable to find image/i;

async function docker(args: string[], timeoutMs: number, op: string): Promise<string> {
  const r = await runArgv(await dockerArgv(args), timeoutMs);
  if (r.exitCode !== 0) {
    const msg = (r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' ').slice(0, 400);
    if (r.exitCode === null) throw new ContainerError('CONTAINER_TIMEOUT', `${op} timed out: ${msg}`);
    if (PORT_TAKEN_RE.test(msg)) throw new ContainerError('CONTAINER_OP_FAILED', `${op} failed — a published host port is already taken: ${msg}`);
    if (CONFLICT_RE.test(msg)) throw new ContainerError('CONTAINER_EXISTS', msg);
    if (IMAGE_MISSING_RE.test(msg)) throw new ContainerError('IMAGE_NOT_FOUND', msg);
    if (NOT_FOUND_RE.test(msg)) throw new ContainerError('CONTAINER_NOT_FOUND', msg);
    throw new ContainerError('CONTAINER_OP_FAILED', `${op} failed: ${msg}`);
  }
  return r.stdout;
}

/** Redact secret-shaped argv tokens in a container's command line.
 *
 *  Reads drop env VALUES because container env routinely carries credentials —
 *  and a command line carries exactly the same class of secret
 *  (`mysqld --password=…`, `--api-key=…`). `docker ps --no-trunc` would hand
 *  those to any read-scope caller for containers lm-assist never created, so
 *  the same rule applies here. */
const SECRET_FLAG_RE = /^(--?[A-Za-z0-9._-]*(?:password|passwd|pwd|secret|token|apikey|api[-_]?key|credential|auth)[A-Za-z0-9._-]*)=(.+)$/i;
export function redactCommand(cmd: string | null): string | null {
  if (!cmd) return cmd;
  return cmd
    .split(' ')
    .map((tok) => {
      const m = tok.match(SECRET_FLAG_RE);
      return m ? `${m[1]}=***` : tok;
    })
    .join(' ');
}

// ─── parsing helpers ─────────────────────────────────────────────────────────

const STATE_VALUES: ContainerState[] = [
  'created',
  'running',
  'paused',
  'restarting',
  'removing',
  'exited',
  'dead',
];

function mapState(raw: string): { state: ContainerState; stateRaw?: string } {
  const s = String(raw || '').trim().toLowerCase();
  if ((STATE_VALUES as string[]).includes(s)) return { state: s as ContainerState };
  return { state: 'unknown', stateRaw: String(raw).trim() };
}

function jsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* a non-JSON progress line — skip it */
    }
  }
  return out;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** `docker ps --format` renders labels as `k=v,k2=v2`; usable for a best-effort
 *  read, NEVER as the authority for `managed` (a value may contain a comma). */
function parseLabelCsv(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(v || '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** `0.0.0.0:8080->80/tcp, [::]:8080->80/tcp` (ps) → structured mappings.
 *  Contiguous publications are COLLAPSED BY DOCKER into a range
 *  (`0.0.0.0:8000-8002->8000-8002/tcp`); a parser that only accepts single
 *  ports drops them silently, and then `list()` and `get()` disagree about the
 *  same container's ports. Ranges are expanded here. */
export function parsePortsSummary(v: unknown): PortMapping[] {
  const out: PortMapping[] = [];
  const seen = new Set<string>();
  for (const part of String(v || '').split(',')) {
    const m = part.trim().match(/^(?:(.+):)?(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?\/(tcp|udp)$/);
    if (!m) continue;
    const hostLo = Number(m[2]);
    const hostHi = m[3] ? Number(m[3]) : hostLo;
    const ctrLo = Number(m[4]);
    const ctrHi = m[5] ? Number(m[5]) : ctrLo;
    const span = Math.min(hostHi - hostLo, ctrHi - ctrLo);
    if (span < 0 || span > 1024) continue; // malformed or absurd — do not expand
    for (let i = 0; i <= span; i++) {
      const host = hostLo + i;
      const container = ctrLo + i;
      const key = `${host}:${container}/${m[6]}`;
      if (seen.has(key)) continue; // v4 + v6 rows describe one mapping
      seen.add(key);
      out.push({
        host,
        container,
        protocol: m[6] as 'tcp' | 'udp',
        ...(m[1] && m[1] !== '0.0.0.0' ? { hostIp: m[1] } : {}),
      });
    }
  }
  return out;
}

/** NetworkSettings.Ports (inspect) → structured mappings. */
function parseInspectPorts(v: unknown): PortMapping[] {
  const out: PortMapping[] = [];
  const map = (v || {}) as Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  for (const [spec, binds] of Object.entries(map)) {
    if (!Array.isArray(binds)) continue;
    const [portStr, proto] = spec.split('/');
    const seen = new Set<string>();
    for (const b of binds) {
      const host = Number(b.HostPort);
      if (!Number.isFinite(host) || seen.has(String(host))) continue;
      seen.add(String(host));
      out.push({
        host,
        container: Number(portStr),
        protocol: proto === 'udp' ? 'udp' : 'tcp',
        ...(b.HostIp && b.HostIp !== '0.0.0.0' && b.HostIp !== '::' ? { hostIp: b.HostIp } : {}),
      });
    }
  }
  return out;
}

function labelsOf(labels: unknown): Record<string, string> {
  const l = (labels || {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(l)) if (typeof v === 'string') out[k] = v;
  return out;
}

// ─── backend ─────────────────────────────────────────────────────────────────

export class DockerBackend implements ContainerBackend {
  readonly engine = 'docker' as const;

  async status(): Promise<ContainerBackendStatus> {
    cachedPrefix = null; // status re-probes so a started daemon shows up at once
    const base: ContainerBackendStatus = {
      engine: 'docker',
      platform: process.platform,
      available: false,
      version: null,
      clientVersion: null,
      apiVersion: null,
      serverOs: null,
      endpoint: dockerHost() || defaultEndpoint(),
      privilege: 'unavailable',
      containersRunning: null,
      containersTotal: null,
      imagesCount: null,
      dataRootFreeGB: null,
    };
    const p = await prefix();
    base.privilege = p;
    if (p === 'unavailable') {
      // Report the CLIENT version anyway when the binary exists — "CLI present,
      // daemon down" and "docker not installed" are different problems.
      const cli = await runArgv([dockerBin(), 'version', '--format', '{{json .}}'], 10_000);
      try {
        const v = JSON.parse(cli.stdout) as { Client?: { Version?: string; ApiVersion?: string } };
        base.clientVersion = str(v.Client?.Version);
        base.apiVersion = str(v.Client?.ApiVersion);
      } catch {
        /* no parsable client info */
      }
      return { ...base, reason: unavailableReason() };
    }
    try {
      const verRaw = await docker(['version', '--format', '{{json .}}'], STATUS_TIMEOUT_MS, 'docker version');
      const v = JSON.parse(verRaw) as {
        Client?: { Version?: string; ApiVersion?: string };
        Server?: { Version?: string; ApiVersion?: string; Os?: string; Arch?: string };
      };
      base.clientVersion = str(v.Client?.Version);
      base.version = str(v.Server?.Version);
      base.apiVersion = str(v.Server?.ApiVersion) || str(v.Client?.ApiVersion);
      const os = str(v.Server?.Os);
      const arch = str(v.Server?.Arch);
      base.serverOs = os ? `${os}${arch ? `/${arch}` : ''}` : null;
    } catch (e) {
      return { ...base, reason: e instanceof Error ? e.message : String(e) };
    }
    let rootDir: string | null = null;
    try {
      const infoRaw = await docker(['info', '--format', '{{json .}}'], STATUS_TIMEOUT_MS, 'docker info');
      const info = JSON.parse(infoRaw) as Record<string, unknown>;
      base.containersTotal = num(info.Containers);
      base.containersRunning = num(info.ContainersRunning);
      base.imagesCount = num(info.Images);
      rootDir = str(info.DockerRootDir);
    } catch {
      /* counts are informational — availability was already proven */
    }
    if (rootDir && process.platform !== 'win32') {
      try {
        const df = await runArgv(['df', '-kP', rootDir], 10_000);
        const avail = Number((df.stdout.trim().split('\n').pop() || '').split(/\s+/)[3]);
        if (Number.isFinite(avail)) base.dataRootFreeGB = Math.round((avail / 1024 / 1024) * 10) / 10;
      } catch {
        /* informational */
      }
    }
    return { ...base, available: true };
  }

  async list(): Promise<ContainerInfo[]> {
    const rows = jsonLines(
      await docker(['ps', '-a', '--no-trunc', '--format', '{{json .}}'], LIST_TIMEOUT_MS, 'container list'),
    );
    // Authoritative managed set — a label-filtered id query, not CSV parsing.
    // 🔴 If that query fails, we must NOT report every container as unmanaged:
    // a caller reading "lm-assist owns nothing here" starts passing force:true,
    // which is precisely the gate this label exists to hold. Fall back to the
    // (ambiguous but present) CSV instead.
    const managedIds = new Set<string>();
    let managedQueryOk = false;
    try {
      const ids = await docker(
        ['ps', '-aq', '--no-trunc', '--filter', `label=${MANAGED_LABEL}=${MANAGED_LABEL_VALUE}`],
        LIST_TIMEOUT_MS,
        'managed filter',
      );
      for (const id of ids.split('\n').map((l) => l.trim()).filter(Boolean)) managedIds.add(id);
      managedQueryOk = true;
    } catch {
      /* fall back to the CSV hint below */
    }
    return rows.map((r) => {
      const labels = parseLabelCsv(r.Labels);
      const id = str(r.ID);
      const { state, stateRaw } = mapState(String(r.State || ''));
      return {
        name: String(r.Names || '').split(',')[0] || '',
        id,
        image: String(r.Image || ''),
        imageId: null,
        state,
        ...(stateRaw ? { stateRaw } : {}),
        status: str(r.Status),
        command: redactCommand(str(r.Command)),
        created: str(r.CreatedAt),
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        health: null,
        ports: parsePortsSummary(r.Ports),
        networks: String(r.Networks || '').split(',').map((s) => s.trim()).filter(Boolean),
        restartPolicy: null,
        mounts: [],
        envKeys: [],
        managed: managedQueryOk && id ? managedIds.has(id) : labels[MANAGED_LABEL] === MANAGED_LABEL_VALUE,
        notes: labels[NOTES_LABEL] || null,
      };
    });
  }

  async get(name: string): Promise<ContainerInfo> {
    const raw = await docker(
      ['inspect', '--type', 'container', '--format', '{{json .}}', name],
      GET_TIMEOUT_MS,
      `container get ${name}`,
    );
    const d = JSON.parse(raw.trim().split('\n')[0] || '{}') as Record<string, any>;
    const state = (d.State || {}) as Record<string, any>;
    const config = (d.Config || {}) as Record<string, any>;
    const hostConfig = (d.HostConfig || {}) as Record<string, any>;
    const netSettings = (d.NetworkSettings || {}) as Record<string, any>;
    const labels = labelsOf(config.Labels);
    const mapped = mapState(String(state.Status || ''));
    const restart = (hostConfig.RestartPolicy || {}) as Record<string, any>;
    return {
      name: String(d.Name || name).replace(/^\//, ''),
      id: str(d.Id),
      image: String(config.Image || ''),
      imageId: str(d.Image),
      state: mapped.state,
      ...(mapped.stateRaw ? { stateRaw: mapped.stateRaw } : {}),
      status: str(state.Status),
      command: redactCommand([d.Path, ...(Array.isArray(d.Args) ? d.Args : [])].filter(Boolean).join(' ') || null),
      created: str(d.Created),
      startedAt: str(state.StartedAt),
      finishedAt: str(state.FinishedAt),
      exitCode: num(state.ExitCode),
      health: str((state.Health || {}).Status),
      ports: parseInspectPorts(netSettings.Ports),
      networks: Object.keys((netSettings.Networks || {}) as Record<string, unknown>),
      restartPolicy: str(restart.Name),
      mounts: Array.isArray(hostConfig.Binds) ? hostConfig.Binds.map(String) : [],
      // Values are deliberately dropped — container env routinely holds secrets.
      envKeys: Array.isArray(config.Env)
        ? config.Env.map((e: unknown) => String(e).split('=')[0]).filter(Boolean)
        : [],
      managed: labels[MANAGED_LABEL] === MANAGED_LABEL_VALUE,
      notes: labels[NOTES_LABEL] || null,
    };
  }

  async images(): Promise<ContainerImage[]> {
    const rows = jsonLines(
      await docker(['images', '--format', '{{json .}}'], IMAGES_TIMEOUT_MS, 'image list'),
    );
    // No slice here — the service owns the cap, so `imagesTotal` can be the
    // REAL count rather than the capped one (a cap that hides the total reads
    // as completeness; see the bounded-is-not-honest rule in service.ts).
    return rows.map((r) => ({
      repository: String(r.Repository || ''),
      tag: String(r.Tag || ''),
      id: String(r.ID || ''),
      created: str(r.CreatedAt),
      sizeBytes: parseSize(r.Size),
    }));
  }

  async run(spec: ContainerRunSpec): Promise<ContainerInfo> {
    const args = ['run', '-d', '--name', spec.name, '--label', `${MANAGED_LABEL}=${MANAGED_LABEL_VALUE}`];
    if (spec.notes) args.push('--label', `${NOTES_LABEL}=${spec.notes}`);
    if (spec.autoRemove) args.push('--rm');
    if (spec.restart !== 'no' && !spec.autoRemove) args.push('--restart', spec.restart);
    if (spec.memoryMB !== null) args.push('--memory', `${spec.memoryMB}m`);
    if (spec.cpus !== null) args.push('--cpus', String(spec.cpus));
    if (spec.network === null) args.push('--network', 'none');
    else if (spec.network !== undefined) args.push('--network', spec.network);
    if (spec.workdir) args.push('--workdir', spec.workdir);
    for (const [k, v] of Object.entries(spec.env)) args.push('--env', `${k}=${v}`);
    for (const p of spec.ports) {
      args.push('--publish', `${p.hostIp ? `${p.hostIp}:` : ''}${p.host}:${p.container}/${p.protocol}`);
    }
    for (const v of spec.volumes) args.push('--volume', `${v.source}:${v.target}${v.readOnly ? ':ro' : ''}`);
    args.push('--pull', spec.pull);
    args.push(spec.image, ...spec.command);
    await docker(args, RUN_TIMEOUT_MS, `container run ${spec.name}`);
    return this.getAfterWrite(spec.name, spec);
  }

  /** `get()` for the tail of a WRITE. A container created with `--rm` is
   *  deleted by the daemon the instant it exits, so the read that confirms a
   *  successful stop/run can legitimately find nothing — reporting
   *  CONTAINER_NOT_FOUND there would tell the caller an operation FAILED that
   *  in fact completed. */
  private async getAfterWrite(name: string, spec?: ContainerRunSpec): Promise<ContainerInfo> {
    try {
      return await this.get(name);
    } catch (e) {
      if (e instanceof ContainerError && e.code === 'CONTAINER_NOT_FOUND') return autoRemovedInfo(name, spec);
      throw e;
    }
  }

  async start(name: string): Promise<ContainerInfo> {
    await docker(['start', name], START_TIMEOUT_MS, `container start ${name}`);
    return this.getAfterWrite(name);
  }

  async unpause(name: string): Promise<ContainerInfo> {
    await docker(['unpause', name], START_TIMEOUT_MS, `container unpause ${name}`);
    return this.getAfterWrite(name);
  }

  async stop(name: string, opts: { force: boolean; timeoutSec: number }): Promise<ContainerInfo> {
    const budget = Math.min(STOP_BASE_TIMEOUT_MS + opts.timeoutSec * 1000, STOP_MAX_TIMEOUT_MS);
    if (opts.force) await docker(['kill', name], STOP_BASE_TIMEOUT_MS, `container kill ${name}`);
    // `docker stop -t N` already escalates to SIGKILL after N seconds, so the
    // graceful path never hangs the way a VM ACPI shutdown can.
    else await docker(['stop', '-t', String(opts.timeoutSec), name], budget, `container stop ${name}`);
    return this.getAfterWrite(name);
  }

  async restart(name: string, opts: { timeoutSec: number }): Promise<ContainerInfo> {
    const budget = Math.min(STOP_BASE_TIMEOUT_MS + opts.timeoutSec * 1000, STOP_MAX_TIMEOUT_MS);
    await docker(['restart', '-t', String(opts.timeoutSec), name], budget, `container restart ${name}`);
    return this.getAfterWrite(name);
  }

  async logs(name: string, opts: { lines: number; since?: string; timestamps: boolean }): Promise<ContainerLogsResult> {
    const args = ['logs', '--tail', String(opts.lines)];
    if (opts.timestamps) args.push('--timestamps');
    if (opts.since) args.push('--since', opts.since);
    args.push(name);
    // Docker writes container stdout to our stdout and stderr to our stderr —
    // both are the container's log. Concatenating stdout-then-stderr would put
    // every stderr line after every stdout line regardless of when it was
    // written, so a build that logs progress to stderr and its RESULT to stdout
    // would lose the result to the tail cap. runLogs() appends both streams to
    // ONE buffer in arrival order instead, which keeps them interleaved.
    const r = await runLogs(await dockerArgv(args), LOGS_TIMEOUT_MS);
    if (r.exitCode !== 0) {
      const msg = (r.stderr || r.combined).trim().split('\n').slice(0, 3).join(' ').slice(0, 400);
      if (r.exitCode === null) throw new ContainerError('CONTAINER_TIMEOUT', `container logs ${name} timed out: ${msg}`);
      if (NOT_FOUND_RE.test(msg)) throw new ContainerError('CONTAINER_NOT_FOUND', msg);
      throw new ContainerError('CONTAINER_OP_FAILED', `container logs ${name} failed: ${msg}`);
    }
    const buf = Buffer.from(r.combined, 'utf8');
    const bytes = buf.length;
    let truncated = false;
    let text = r.combined;
    let cutMidLine = false;
    if (bytes > MAX_LOG_BYTES) {
      // Keep the TAIL — the end of a log is the part that explains a failure.
      // Cut on the BUFFER, not the string: String.slice counts UTF-16 units, so
      // a CJK or emoji log would blow straight through a byte ceiling.
      const tail = buf.subarray(bytes - MAX_LOG_BYTES);
      text = tail.toString('utf8');
      truncated = true;
      // Only a cut that landed INSIDE a line leaves a fragment to drop.
      cutMidLine = buf[bytes - MAX_LOG_BYTES - 1] !== 0x0a;
    }
    let lines = text.split('\n');
    if (cutMidLine) lines = lines.slice(1);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length > opts.lines) {
      lines = lines.slice(-opts.lines);
      truncated = true;
    }
    return { name, lines, count: lines.length, truncated, bytes };
  }

  async remove(name: string, opts: { force: boolean; removeImage: boolean }): Promise<ContainerDeleteResult> {
    const info = await this.get(name); // CONTAINER_NOT_FOUND propagates before any damage
    const running = info.state === 'running' || info.state === 'restarting' || info.state === 'paused';
    if (running && !opts.force) {
      // Stop it first so an unforced delete never needs SIGKILL.
      await docker(['stop', '-t', '10', name], STOP_MAX_TIMEOUT_MS, `container stop ${name}`);
    }
    try {
      await docker(running && opts.force ? ['rm', '-f', name] : ['rm', name], DELETE_TIMEOUT_MS, `container delete ${name}`);
    } catch (e) {
      // An --rm container auto-removes the moment the stop above lands, so
      // "no such container" here means the delete already happened.
      if (!(e instanceof ContainerError && e.code === 'CONTAINER_NOT_FOUND')) throw e;
    }
    let removedImage: string | null = null;
    let imageKeptReason: string | null = opts.removeImage ? null : 'not requested';
    if (opts.removeImage && info.image) {
      try {
        await docker(['rmi', info.image], DELETE_TIMEOUT_MS, `image delete ${info.image}`);
        removedImage = info.image;
      } catch (e) {
        // `docker rmi` refuses an image another container still references —
        // that refusal is the containment, so report it instead of forcing.
        imageKeptReason = e instanceof Error ? e.message.slice(0, 300) : String(e);
      }
    }
    return { name, deleted: true, killed: running && opts.force, removedImage, imageKeptReason };
  }
}

/** `docker images` renders sizes as "8.08MB" / "1.14GB" / "0B". */
function parseSize(v: unknown): number | null {
  const m = String(v || '').trim().match(/^([\d.]+)\s*([KMGT]?B)$/i);
  if (!m) return null;
  const mult: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };
  const f = mult[m[2].toLowerCase()];
  return f ? Math.round(Number(m[1]) * f) : null;
}

/** Shape returned for an --rm container that exited before we could inspect it.
 *
 *  `state` is 'exited' because that is TRUE — the container ran and finished;
 *  it is not mid-removal, and a consumer branching on 'removing' would poll for
 *  it forever. The explanation belongs in `status`, the human status line,
 *  never in `stateRaw`, which types.ts reserves for the engine's own state
 *  string. */
function autoRemovedInfo(name: string, spec?: ContainerRunSpec): ContainerInfo {
  return {
    name,
    id: null,
    image: spec?.image || '',
    imageId: null,
    state: 'exited',
    status: 'auto-removed (--rm): the container exited and Docker deleted it',
    command: spec ? spec.command.join(' ') || null : null,
    created: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    health: null,
    ports: [],
    networks: [],
    restartPolicy: null,
    mounts: [],
    envKeys: spec ? Object.keys(spec.env) : [],
    managed: true,
    notes: spec?.notes || null,
  };
}

/** True when `p` resolves to a location inside `root` (case-insensitive on
 *  Windows, where two spellings of one path are the same path). */
export function isUnderRoot(root: string, p: string): boolean {
  const a = path.resolve(root);
  const b = path.resolve(p);
  // The root ITSELF is inside the root. path.relative gives '' there, and
  // falling back to a raw === would compare case-SENSITIVELY on Windows —
  // where every subdirectory of the same root already compares
  // case-insensitively, so `c:\srv` would be refused while `c:\srv\x` passed.
  if (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b) return true;
  const rel = path.relative(a, b);
  return !!rel && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}

/** Test hook — forget the cached privilege probe. */
export function _resetPrefixForTests(): void {
  cachedPrefix = null;
  lastProbeError = '';
}
