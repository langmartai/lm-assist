/**
 * Container management — deployment facts only (binary, labels, limits, timeouts).
 *
 * ── What lives HERE vs in the backend ────────────────────────────────────────
 * This file owns DEPLOYMENT facts: which engine binary to run, the config file,
 * the resource limits, the per-operation timeouts, how elevation is chosen, and
 * WHERE BIND MOUNTS MAY POINT. A docker flag must never appear here, and a
 * config path must never appear in the backend — same rule as vm/config.ts and
 * gmail/config.ts.
 *
 * Effective config = defaults ← `~/.lm-assist/container[-dev].json` ← env overrides.
 *
 * 🔴 BIND MOUNTS ARE OFF BY DEFAULT. `volumeRoots` starts EMPTY, which means
 * `container_run` refuses every `-v` mount. A bind mount is the one container
 * option that reaches back out of the sandbox and into the host filesystem, and
 * a container process is frequently root; mounting an arbitrary host path is
 * therefore equivalent to handing out that path with write access. An operator
 * who wants mounts names the roots explicitly (config `volumeRoots` or env
 * `LM_CONTAINER_VOLUME_ROOTS`, os-path-separator separated), and sources are
 * then contained under them — the same containment rule vm/config.ts applies to
 * disk deletion under the storage root.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/path-utils';

// Mirror the connector dev/prod split (vm/gmail/desktop pattern): a build
// running from the repo (not node_modules) uses the -dev config so dev and prod
// never collide on one host.
const IS_DEV_REPO = process.env.LM_ASSIST_PROD === 'true' ? false : !__dirname.includes('node_modules');
const DEV_SUFFIX = IS_DEV_REPO ? '-dev' : '';

export function containerConfigFile(): string {
  return path.join(getDataDir(), `container${DEV_SUFFIX}.json`);
}

/** Label stamped on every container lm-assist creates. `managed` detection —
 *  and the disruptive-op safety gate — key on it. */
export const MANAGED_LABEL = 'lm-assist';
export const MANAGED_LABEL_VALUE = 'managed';
/** Label carrying the caller's free-text notes. */
export const NOTES_LABEL = 'lm-assist.notes';

/** Container-name charset — a strict subset of Docker's own rule, chosen so a
 *  name can never look like a flag. Security boundary; see types.ts. */
export const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Image reference: repo[:tag] / registry[:port]/repo[:tag] / repo@sha256:…
 *  Deliberately charset-based (no quotes, spaces, `$`, backticks, semicolons)
 *  rather than a full grammar — argv arrays make parsing moot, this stops the
 *  pathological input from ever getting that far. `..` is rejected separately. */
export const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,199}$/;

/** Docker network names. */
export const NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Environment variable NAMES. Values are checked for control characters only
 *  (they legitimately contain almost anything, and argv keeps them intact). */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** A container-side path (mount target, workdir): absolute, POSIX, no quotes. */
export const CONTAINER_PATH_RE = /^\/[^'"`$\r\n\0]{0,255}$/;

export interface ContainerLimits {
  /** Refuse runs once this many containers exist on the host. */
  maxContainers: number;
  maxMemoryMB: number;
  maxCpus: number;
  maxPorts: number;
  maxVolumes: number;
  maxEnv: number;
  /** Max argv entries in a container command. */
  maxCommandArgs: number;
}

export const DEFAULT_LIMITS: ContainerLimits = {
  maxContainers: 100,
  maxMemoryMB: 32768,
  maxCpus: 16,
  maxPorts: 20,
  maxVolumes: 10,
  maxEnv: 50,
  maxCommandArgs: 50,
};

export interface ContainerConfig {
  /** Engine binary: `docker` (default), `podman`, or an absolute path. */
  dockerBin?: string;
  /** Engine endpoint override (becomes DOCKER_HOST for every call). */
  dockerHost?: string;
  /** How privileged engine calls run: auto (direct, fall back to passwordless
   *  sudo on Linux), always (force the sudo prefix), never. */
  elevation?: 'auto' | 'always' | 'never';
  /** Absolute host directories bind mounts may live under. EMPTY = no mounts. */
  volumeRoots?: string[];
  /** Default network for new containers; null/omitted = engine default bridge. */
  defaultNetwork?: string | null;
  limits?: Partial<ContainerLimits>;
}

/** Fields a caller may set via PUT /container/config. */
export const CONFIG_FIELDS: ReadonlyArray<keyof ContainerConfig> = [
  'dockerBin',
  'dockerHost',
  'elevation',
  'volumeRoots',
  'defaultNetwork',
  'limits',
];

export function readContainerConfig(): ContainerConfig {
  try {
    return JSON.parse(fs.readFileSync(containerConfigFile(), 'utf-8')) as ContainerConfig;
  } catch {
    return {};
  }
}

/** Merge `patch` into the saved config and persist (0600). Returns the merged config. */
export function writeContainerConfig(patch: Partial<ContainerConfig>): ContainerConfig {
  const next = { ...readContainerConfig(), ...patch };
  fs.mkdirSync(path.dirname(containerConfigFile()), { recursive: true });
  fs.writeFileSync(containerConfigFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** Engine binary. A bare command name or an absolute path; anything else is
 *  refused rather than handed to spawn(). Read on every call. */
export function dockerBin(cfg: ContainerConfig = readContainerConfig()): string {
  const raw = String(process.env.LM_CONTAINER_BIN || cfg.dockerBin || 'docker').trim();
  const bare = /^[A-Za-z0-9._-]{1,32}$/.test(raw);
  const abs = /^([A-Za-z]:[\\/]|\/)[^'"`$\r\n]{1,255}$/.test(raw);
  return bare || abs ? raw : 'docker';
}

/** DOCKER_HOST for engine calls (env > config > inherit the process env). */
export function dockerHost(cfg: ContainerConfig = readContainerConfig()): string | undefined {
  const v = process.env.LM_CONTAINER_HOST || cfg.dockerHost || process.env.DOCKER_HOST;
  return v ? String(v) : undefined;
}

/** The endpoint we report as being dialled when nothing overrides it. */
export function defaultEndpoint(): string {
  return process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
}

export function elevationMode(cfg: ContainerConfig = readContainerConfig()): 'auto' | 'always' | 'never' {
  const raw = process.env.LM_CONTAINER_ELEVATION || cfg.elevation || 'auto';
  return raw === 'always' || raw === 'never' ? raw : 'auto';
}

/** Absolute roots bind mounts must sit under. Empty ⇒ bind mounts refused. */
export function volumeRoots(cfg: ContainerConfig = readContainerConfig()): string[] {
  const raw = process.env.LM_CONTAINER_VOLUME_ROOTS
    ? process.env.LM_CONTAINER_VOLUME_ROOTS.split(path.delimiter)
    : cfg.volumeRoots || [];
  return raw
    .map((r) => String(r).trim())
    .filter(Boolean)
    .map((r) => path.resolve(r));
}

export function defaultNetwork(cfg: ContainerConfig = readContainerConfig()): string | null {
  if (cfg.defaultNetwork === undefined || cfg.defaultNetwork === null) return null;
  return cfg.defaultNetwork;
}

export function effectiveLimits(cfg: ContainerConfig = readContainerConfig()): ContainerLimits {
  return { ...DEFAULT_LIMITS, ...(cfg.limits || {}) };
}

// ─── run defaults ────────────────────────────────────────────────────────────

export const DEFAULT_RESTART: 'no' = 'no';
export const DEFAULT_PULL: 'missing' = 'missing';

/** Notes ceiling — notes become a label value on the container. */
export const MAX_NOTES_CHARS = 500;
/** Env values are opaque but bounded. */
export const MAX_ENV_VALUE_CHARS = 1024;

// ─── per-operation backend timeouts (ms) — every spawn is kill-on-expiry ─────
//
// All are held under the 120s loopback passthrough ceiling (workerPostRaw) so
// an MCP tool call never outlives its transport. The hub relay cuts connector
// calls at ~25-30s, so a slow first pull should be followed with container_status
// rather than waited on.

export const STATUS_TIMEOUT_MS = 20_000;
export const LIST_TIMEOUT_MS = 30_000;
export const GET_TIMEOUT_MS = 30_000;
export const IMAGES_TIMEOUT_MS = 30_000;
export const RUN_TIMEOUT_MS = 110_000; // includes an image pull
export const START_TIMEOUT_MS = 60_000;
export const STOP_BASE_TIMEOUT_MS = 30_000; // + timeoutSec*1000, capped below
export const STOP_MAX_TIMEOUT_MS = 110_000;
export const LOGS_TIMEOUT_MS = 30_000;
export const DELETE_TIMEOUT_MS = 60_000;

/** Default graceful-stop wait before the engine escalates to SIGKILL. */
export const STOP_DEFAULT_TIMEOUT_SEC = 10;

/** Bounded wait for the write mutex before BUSY (vm/desktop service pattern). */
export const MUTEX_WAIT_MS = 30_000;

/** Bounds on what a read may return — a capped result ALWAYS reports total +
 *  truncated, never a bare array (the bounded-is-not-honest lesson). */
export const MAX_CONTAINERS_LISTED = 100;
export const MAX_IMAGES_LISTED = 100;
export const DEFAULT_LOG_LINES = 100;
export const MAX_LOG_LINES = 1000;
export const MAX_LOG_BYTES = 100_000;
