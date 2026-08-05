/**
 * VM management — the CROSS-PLATFORM contract.
 *
 * 🔴 THIS FILE IS THE SHARED INTERFACE between the Hyper-V backend (Windows,
 * hyperv-backend.ts) and the KVM/libvirt backend (Linux, kvm-backend.ts).
 * `service.ts` talks to a `VmBackend` and knows nothing platform-specific;
 * both backends implement THIS. Same split as desktop/types.ts and the gmail
 * config/backend separation: a PowerShell cmdlet or a virsh flag must never
 * appear outside its backend, and a model-facing string must never appear in
 * a backend.
 *
 * Naming convention: a VM's `name` is its identity on a host. lm-assist
 * REQUIRES /^[A-Za-z0-9._-]{1,64}$/ for every name it accepts, so a name can
 * be embedded verbatim in an ELEVATED PowerShell / virsh command without any
 * quoting hazard — that regex is a security boundary (the privileged exec
 * path), not a style choice. Existing VMs with wilder names still appear in
 * list(); they just cannot be operated on by name through this surface.
 */

export type VmHypervisor = 'hyperv' | 'kvm';

/** Lowercase union of both hypervisors' state vocabularies. A backend maps its
 *  native state onto these and preserves the original in `stateRaw`. */
export type VmState =
  | 'running'
  | 'off'
  | 'paused'
  | 'saved' // hyperv Saved / kvm pmsuspended
  | 'starting'
  | 'stopping'
  | 'unknown';

export type VmErrorCode =
  | 'VM_UNSUPPORTED' // this platform has no VM backend
  | 'VM_BACKEND_UNAVAILABLE' // hypervisor missing / service not running (message says why)
  | 'VM_NOT_FOUND'
  | 'VM_EXISTS'
  | 'VM_NOT_MANAGED' // destructive op on a VM lm-assist did not create (force overrides)
  | 'BAD_ARGS'
  | 'UNSAFE_PATH' // path escapes the storage root or fails the safe charset
  | 'ELEVATION_REQUIRED' // privileged path unavailable (worker down / sudo refused)
  | 'VM_OP_FAILED'
  | 'VM_TIMEOUT'
  | 'BUSY'; // write mutex wait exceeded

/** A typed VM error. Backends/service throw this; routes render {code,message}. */
export class VmError extends Error {
  code: VmErrorCode;
  constructor(code: VmErrorCode, message: string) {
    super(message);
    this.name = 'VmError';
    this.code = code;
  }
}

/** A create request AFTER service.ts validation — backends assume every field
 *  here is already range-checked and charset-safe. */
export interface VmCreateSpec {
  name: string;
  cpus: number;
  memoryMB: number;
  diskGB: number;
  /** Absolute directory VM folders live under; the VM gets `<storageRoot>/<name>/`. */
  storageRoot: string;
  /** Optional boot media (absolute, charset-checked; existence is backend-checked). */
  isoPath?: string;
  /** Network to attach: undefined = platform default; null = NO network. */
  network?: string | null;
  /** 2 (default) = hyperv Gen2; 1 = hyperv Gen1/BIOS. The KVM backend currently
   *  defines BIOS machines regardless and records the requested value. */
  generation: 1 | 2;
  /** Free-text notes stored after the managed tag (pre-sanitized by service). */
  notes?: string;
}

export interface VmInfo {
  name: string;
  /** Hypervisor-native id (Hyper-V VM GUID / libvirt UUID) when known. */
  id: string | null;
  state: VmState;
  /** The hypervisor's own state string when it did not map cleanly. */
  stateRaw?: string;
  hypervisor: VmHypervisor;
  cpus: number | null;
  memoryMB: number | null;
  /** Absolute paths of attached virtual disks (get() fills; list() may leave empty). */
  disks: string[];
  ipAddresses: string[];
  uptimeSec: number | null;
  snapshotCount: number | null;
  generation: number | null;
  /** True when the VM's notes/description carry the lm-assist managed tag. */
  managed: boolean;
  /** Notes/description with the managed tag stripped; null when none. */
  notes: string | null;
}

export interface VmSnapshot {
  name: string;
  created: string | null;
  parent: string | null;
  current: boolean;
}

export interface VmBackendStatus {
  hypervisor: VmHypervisor;
  platform: string;
  available: boolean;
  /** Present only when available === false: why, and what would fix it. */
  reason?: string;
  version: string | null;
  /** How privileged operations run on this host:
   *  direct = this process already has the rights; worker = the lm-assist
   *  elevated worker on loopback (Windows); sudo = passwordless sudo (Linux);
   *  root = running as root; unavailable = no working privileged path. */
  privilege: 'direct' | 'worker' | 'sudo' | 'root' | 'unavailable';
  storageRoot: string;
  storageFreeGB: number | null;
  defaultNetwork: string | null;
  vmCount: number | null;
}

export interface VmDeleteResult {
  name: string;
  deleted: boolean;
  /** Disk files actually removed — only ever paths under the storage root. */
  removedDisks: string[];
  /** Disks intentionally left (outside the root, unsafe charset, or deleteDisks:false). */
  keptDisks: string[];
}

/**
 * The platform backend contract. `service.ts` depends ONLY on this; each
 * platform implements it. Backends throw typed VmError on failure and do NO
 * model-facing formatting.
 */
export interface VmBackend {
  readonly hypervisor: VmHypervisor;
  /** Readiness/doctor. Must never throw — reports available:false + reason. */
  status(): Promise<VmBackendStatus>;
  list(): Promise<VmInfo[]>;
  /** Throws VM_NOT_FOUND when absent. */
  get(name: string): Promise<VmInfo>;
  create(spec: VmCreateSpec): Promise<VmInfo>;
  start(name: string): Promise<VmInfo>;
  stop(name: string, opts: { force: boolean; timeoutSec: number }): Promise<VmInfo>;
  /** Deleting disks is bounded to files under the configured storage root. */
  remove(name: string, opts: { deleteDisks: boolean }): Promise<VmDeleteResult>;
  snapshots(name: string): Promise<VmSnapshot[]>;
  snapshotCreate(name: string, snapName: string): Promise<VmSnapshot>;
  snapshotRestore(name: string, snapName: string): Promise<VmInfo>;
  snapshotDelete(name: string, snapName: string): Promise<{ name: string; snapshot: string; deleted: boolean }>;
}
