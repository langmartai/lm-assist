/**
 * Container management — the ENGINE-FACING contract.
 *
 * 🔴 THIS FILE IS THE SHARED INTERFACE between `service.ts` (validation, safety
 * gates, model-facing shapes) and a container engine backend
 * (`docker-backend.ts`). Unlike VM management — where Hyper-V and KVM are two
 * genuinely different worlds — the Docker CLI is ONE cross-platform binary, so
 * there is a single backend whose *daemon probe* is platform-aware (npipe on
 * Windows, a unix socket on Linux/macOS). The interface stays anyway: it is
 * what keeps `docker` flags out of the service and model-facing prose out of
 * the backend, and it is where a podman backend would slot in.
 *
 * Naming convention: a container's `name` is its identity on a host. lm-assist
 * REQUIRES /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ for every name it accepts — a
 * subset of what Docker itself allows, chosen so a name can never be confused
 * for a flag and never needs quoting. Every command runs as an ARGV ARRAY
 * (never a shell string), and that regex is the belt to the argv braces: it is
 * a security boundary, not a style choice. Containers with wilder names still
 * appear in list(); they just cannot be operated on by name through here.
 */

export type ContainerEngine = 'docker';

/** Lowercase union of Docker's container states. The engine's own string is
 *  preserved in `stateRaw` when it does not map. */
export type ContainerState =
  | 'created'
  | 'running'
  | 'paused'
  | 'restarting'
  | 'removing'
  | 'exited'
  | 'dead'
  | 'unknown';

export type ContainerErrorCode =
  | 'CONTAINER_UNSUPPORTED' // no container backend for this platform
  | 'DOCKER_UNAVAILABLE' // CLI missing / daemon not running (message says which)
  | 'CONTAINER_NOT_FOUND'
  | 'CONTAINER_EXISTS'
  | 'CONTAINER_NOT_MANAGED' // disruptive op on a container lm-assist did not create (force overrides)
  | 'IMAGE_NOT_FOUND'
  | 'BAD_ARGS'
  | 'UNSAFE_PATH' // bind-mount source outside the allowed roots or unsafe charset
  | 'ELEVATION_REQUIRED' // no privileged path to the daemon (docker group / sudo)
  | 'CONTAINER_OP_FAILED'
  | 'CONTAINER_TIMEOUT'
  | 'BUSY'; // write mutex wait exceeded

/** A typed container error. Backend/service throw this; routes render {code,message}. */
export class ContainerError extends Error {
  code: ContainerErrorCode;
  constructor(code: ContainerErrorCode, message: string) {
    super(message);
    this.name = 'ContainerError';
    this.code = code;
  }
}

export type RestartPolicy = 'no' | 'always' | 'unless-stopped' | 'on-failure';

/** How `docker run` should acquire the image. */
export type PullPolicy = 'missing' | 'always' | 'never';

export interface PortMapping {
  /** Host port. */
  host: number;
  /** Port inside the container. */
  container: number;
  protocol: 'tcp' | 'udp';
  /** Host interface to bind; undefined = all interfaces. */
  hostIp?: string;
}

export interface VolumeMount {
  /** Absolute host path — validated to sit under a configured volume root. */
  source: string;
  /** Absolute path inside the container. */
  target: string;
  readOnly: boolean;
}

/** A run request AFTER service.ts validation — the backend assumes every field
 *  here is already range-checked, charset-safe and containment-checked. */
export interface ContainerRunSpec {
  name: string;
  image: string;
  /** argv for the container's entrypoint; empty = the image's own CMD. */
  command: string[];
  env: Record<string, string>;
  ports: PortMapping[];
  volumes: VolumeMount[];
  restart: RestartPolicy;
  /** Hard memory limit; null = unlimited (engine default). */
  memoryMB: number | null;
  /** CPU quota in cores (may be fractional); null = unlimited. */
  cpus: number | null;
  /** Network to attach: undefined = engine default bridge; null = --network none. */
  network?: string | null;
  /** Working directory inside the container. */
  workdir?: string;
  /** Remove the container automatically when it exits. */
  autoRemove: boolean;
  pull: PullPolicy;
  /** Free-text notes, stored in the lm-assist.notes label (pre-sanitized). */
  notes?: string;
}

export interface ContainerInfo {
  name: string;
  /** Full engine container id (never truncated). */
  id: string | null;
  image: string;
  imageId: string | null;
  state: ContainerState;
  /** The engine's own state string when it did not map cleanly. */
  stateRaw?: string;
  /** Human status line, e.g. "Up 7 days" / "Exited (0) 2 minutes ago". */
  status: string | null;
  /** The container's command line as the engine reports it. */
  command: string | null;
  created: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  /** Health-check state when the image defines one. */
  health: string | null;
  ports: PortMapping[];
  /** Attached network names. */
  networks: string[];
  restartPolicy: string | null;
  /** Bind mounts as `source:target[:ro]` (get() fills; list() may leave empty). */
  mounts: string[];
  /** Environment VARIABLE NAMES only — values are deliberately never returned,
   *  because container env routinely carries credentials. */
  envKeys: string[];
  /** True when the container carries the lm-assist managed label. */
  managed: boolean;
  /** Contents of the lm-assist.notes label; null when none. */
  notes: string | null;
}

export interface ContainerImage {
  repository: string;
  tag: string;
  id: string;
  created: string | null;
  sizeBytes: number | null;
}

export interface ContainerBackendStatus {
  engine: ContainerEngine;
  platform: string;
  available: boolean;
  /** Present only when available === false: why, and what would fix it. */
  reason?: string;
  /** Daemon (server) version — the client version alone proves nothing. */
  version: string | null;
  clientVersion: string | null;
  apiVersion: string | null;
  /** The daemon's OS/arch, e.g. "linux/amd64" (a Windows host running the
   *  Docker Desktop Linux engine reports linux here — that is not a bug). */
  serverOs: string | null;
  /** The endpoint actually dialled: npipe on Windows, a unix socket elsewhere. */
  endpoint: string;
  /** How commands reach the daemon: direct = this process already has access;
   *  sudo = passwordless sudo (Linux); root = running as root; unavailable = no
   *  working path. Determined by RUNNING a command, never by group membership. */
  privilege: 'direct' | 'sudo' | 'root' | 'unavailable';
  containersRunning: number | null;
  containersTotal: number | null;
  imagesCount: number | null;
  /** Free space on the filesystem holding the engine's data root, when known. */
  dataRootFreeGB: number | null;
}

export interface ContainerDeleteResult {
  name: string;
  deleted: boolean;
  /** True when the container had to be killed because it was still running. */
  killed: boolean;
  /** Image removed alongside it, when remove_image was requested and it was unused. */
  removedImage: string | null;
  /** Why the image was kept (still referenced, not requested, …); null when removed. */
  imageKeptReason: string | null;
}

export interface ContainerLogsResult {
  name: string;
  lines: string[];
  /** Total lines returned. */
  count: number;
  /** True when the byte cap or the line cap clipped the output. */
  truncated: boolean;
  bytes: number;
}

/**
 * The engine backend contract. `service.ts` depends ONLY on this. The backend
 * throws typed ContainerError on failure and does NO model-facing formatting.
 */
export interface ContainerBackend {
  readonly engine: ContainerEngine;
  /** Readiness/doctor. Must never throw — reports available:false + reason. */
  status(): Promise<ContainerBackendStatus>;
  list(): Promise<ContainerInfo[]>;
  /** Throws CONTAINER_NOT_FOUND when absent. */
  get(name: string): Promise<ContainerInfo>;
  images(): Promise<ContainerImage[]>;
  run(spec: ContainerRunSpec): Promise<ContainerInfo>;
  start(name: string): Promise<ContainerInfo>;
  /** Resume a PAUSED container — `docker start` refuses one. */
  unpause(name: string): Promise<ContainerInfo>;
  stop(name: string, opts: { force: boolean; timeoutSec: number }): Promise<ContainerInfo>;
  restart(name: string, opts: { timeoutSec: number }): Promise<ContainerInfo>;
  logs(name: string, opts: { lines: number; since?: string; timestamps: boolean }): Promise<ContainerLogsResult>;
  remove(name: string, opts: { force: boolean; removeImage: boolean }): Promise<ContainerDeleteResult>;
}
