// core/src/data/dataset-registry.ts
import * as fs from 'fs';
import * as path from 'path';
import type {
  DatasetDescriptor, BackendKind, BackendConfig, AclRule, NodeVisibility, NodeOrigin, SyncMode,
} from './types';
import { datasetsFile, thisNodeId } from './paths';

export const DATASET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// `bundles` is the /data/bundles export/import route family — a dataset by that id would
// collide with those routes exactly like the other reserved ids do.
export const RESERVED_DATASET_IDS = new Set(['sync', 'access', 'catalog', 'datasets', 'bundles']);

export interface CreateDatasetInput {
  id: string;
  backend: BackendKind;
  title?: string;
  visibility?: NodeVisibility;
  readOnly?: boolean;
  sensitive?: boolean;
  syncMode?: import('./types').SyncMode;
  scope?: 'cluster' | 'fleet';
  config: BackendConfig;
  acl?: AclRule[];
  system?: boolean;
}

export interface UpsertReplicaInput {
  id: string;
  backend: BackendKind;
  ownerNode: string;
  syncMode: SyncMode;
  scope?: 'cluster' | 'fleet';
  config: BackendConfig;
  origin: NodeOrigin;
  title?: string;
}

/** Visibility/ACL a takeover applies — the bundle's values when promoting from an import. */
export interface PromoteReplicaPatch {
  visibility?: NodeVisibility;
  acl?: AclRule[];
}

/** Registry refusal carrying a machine-readable code (NOT_FOUND / NOT_A_REPLICA / FORBIDDEN). */
function registryError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** A registry file's descriptors, or null when the text is not a descriptor array. */
function parseDescriptors(text: string): DatasetDescriptor[] | null {
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export class DatasetRegistry {
  private file: string;
  private cache: DatasetDescriptor[] | null = null;
  private mtime = 0;

  constructor(fileOverride?: string) { this.file = fileOverride || datasetsFile(); }

  private load(): DatasetDescriptor[] {
    try {
      if (!fs.existsSync(this.file)) return [];
      const stat = fs.statSync(this.file);
      if (this.cache && stat.mtimeMs === this.mtime) return [...this.cache];
      let arr = parseDescriptors(fs.readFileSync(this.file, 'utf-8'));
      if (!arr) {
        // A torn/corrupt file used to load as [] — and the next save PERSISTED the loss of
        // every owner/replica/ACL setting. Prefer what is already in memory, then the
        // one-step-back .bak that save() keeps.
        if (this.cache) return [...this.cache];
        arr = this.loadBak();
        console.warn(`[dataset-registry] ${this.file} is not a valid descriptor array — `
          + (arr.length ? `recovered ${arr.length} descriptor(s) from ${this.bakFile()}` : 'no usable .bak; starting empty'));
      }
      this.cache = arr;
      this.mtime = stat.mtimeMs;
      return [...arr];
    } catch {
      return this.cache ? [...this.cache] : [];
    }
  }

  private bakFile(): string { return `${this.file}.bak`; }

  private loadBak(): DatasetDescriptor[] {
    try {
      return parseDescriptors(fs.readFileSync(this.bakFile(), 'utf-8')) ?? [];
    } catch {
      return [];
    }
  }

  /** Atomic save: write `<file>.tmp`, fsync, rename over the file — a crash or a full disk
   *  mid-write leaves the previous file whole instead of torn. The previous file is kept as
   *  ONE `<file>.bak` generation, but only when it parses: copying a corrupt file over a
   *  good .bak would destroy the only recovery point. */
  private save(arr: DatasetDescriptor[]): void {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Per-process tmp name: Core and a CLI invocation can save the same file concurrently,
    // and a shared `<file>.tmp` would let one rename the other's half-written temp.
    const tmp = `${this.file}.${process.pid}.tmp`;
    const json = JSON.stringify(arr, null, 2);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, json);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      if (fs.existsSync(this.file) && parseDescriptors(fs.readFileSync(this.file, 'utf-8'))) {
        fs.copyFileSync(this.file, this.bakFile());
      }
    } catch { /* best effort — the .bak is a recovery aid, never a reason to fail a save */ }
    try {
      fs.renameSync(tmp, this.file);
    } catch {
      // Windows can refuse a rename over a file another process holds open (EPERM/EBUSY).
      // Fall back to the old in-place write — no worse than before, and the .bak stands.
      fs.writeFileSync(this.file, json);
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
    this.cache = [...arr];
    this.mtime = fs.statSync(this.file).mtimeMs;
  }

  list(): DatasetDescriptor[] { return this.load().map((d) => ({ ...d })); }

  get(id: string): DatasetDescriptor | undefined {
    const d = this.load().find((x) => x.id === id);
    return d ? { ...d } : undefined;
  }

  create(input: CreateDatasetInput): DatasetDescriptor {
    if (!DATASET_ID_RE.test(input.id)) {
      throw new Error(`invalid dataset id "${input.id}" (must match ${DATASET_ID_RE})`);
    }
    if (RESERVED_DATASET_IDS.has(input.id)) {
      throw new Error(`dataset id "${input.id}" is reserved (collides with a /data route)`);
    }
    const arr = this.load();
    if (arr.some((d) => d.id === input.id)) throw new Error(`dataset "${input.id}" already exists`);
    const now = new Date().toISOString();
    const d: DatasetDescriptor = {
      id: input.id,
      backend: input.backend,
      title: input.title,
      ownerNode: thisNodeId(),
      visibility: input.visibility ?? 'local-only',
      system: input.system,
      readOnly: input.readOnly,
      sensitive: input.sensitive,
      syncMode: input.syncMode ?? 'none',
      scope: input.scope ?? 'cluster',
      config: input.config,
      acl: input.acl ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.save([...arr, d]);
    return { ...d };
  }

  update(id: string, patch: Partial<Pick<DatasetDescriptor, 'title' | 'visibility' | 'readOnly' | 'sensitive' | 'acl'>>): DatasetDescriptor {
    const arr = this.load();
    const idx = arr.findIndex((d) => d.id === id);
    if (idx < 0) throw new Error(`dataset "${id}" not found`);
    const updated: DatasetDescriptor = { ...arr[idx], ...patch, updatedAt: new Date().toISOString() };
    const next = [...arr];
    next[idx] = updated;
    this.save(next);
    return { ...updated };
  }

  drop(id: string): boolean {
    const arr = this.load();
    const target = arr.find((d) => d.id === id);
    if (!target) return false;
    if (target.system) return false; // system datasets are not user-droppable
    const next = arr.filter((d) => d.id !== id);
    this.save(next);
    return true;
  }

  upsertReplica(input: UpsertReplicaInput): DatasetDescriptor {
    if (!DATASET_ID_RE.test(input.id)) {
      throw new Error(`invalid dataset id "${input.id}" (must match ${DATASET_ID_RE})`);
    }
    const arr = this.load();
    const idx = arr.findIndex((d) => d.id === input.id);

    // Guard: do not overwrite a locally-owned dataset with a replica descriptor.
    // A locally-owned dataset has no `origin` field (it is the authoritative owner).
    // Converting it to a read-only replica would lock the rightful owner out of writes.
    if (idx >= 0 && !arr[idx].origin) {
      return { ...arr[idx] };
    }

    const now = new Date().toISOString();
    const d: DatasetDescriptor = {
      id: input.id,
      backend: input.backend,
      title: input.title,
      ownerNode: input.ownerNode,
      visibility: 'local-only',
      syncMode: input.syncMode,
      scope: input.scope ?? 'cluster',
      origin: input.origin,
      config: input.config,
      acl: [],
      createdAt: idx >= 0 ? arr[idx].createdAt : now,
      updatedAt: now,
    };
    const next = [...arr];
    if (idx >= 0) {
      next[idx] = d;
    } else {
      next.push(d);
    }
    this.save(next);
    return { ...d };
  }

  /**
   * Guarded TAKEOVER primitive: turn a local replica into a locally OWNED dataset.
   * Clears `origin`, makes this node the owner, and stamps `supersedes` with the origin it
   * replaced so that node demotes itself if it ever returns (SyncEngine auto-demotion).
   * Scope, syncMode, config and title are kept. Visibility defaults to
   * 'cross-node-readable' — a replica's forced local-only / empty ACL is an artifact of
   * replication, not the owner's choice — and `patch` carries the bundle's values when the
   * takeover comes from an import. The "origin is offline" guard is the CALLER's job
   * (takeover); this only moves the descriptor.
   */
  promoteReplica(id: string, patch: PromoteReplicaPatch = {}): DatasetDescriptor {
    const arr = this.load();
    const idx = arr.findIndex((d) => d.id === id);
    if (idx < 0) throw registryError('NOT_FOUND', `dataset "${id}" not found`);
    const cur = arr[idx];
    if (!cur.origin) throw registryError('NOT_A_REPLICA', `dataset "${id}" is not a replica — it is already owned by this node`);
    const now = new Date().toISOString();
    const { origin, ...owned } = cur;
    const promoted: DatasetDescriptor = {
      ...owned,
      ownerNode: thisNodeId(),
      visibility: patch.visibility ?? 'cross-node-readable',
      acl: patch.acl ?? cur.acl ?? [],
      supersedes: { machineId: origin.machineId, hostname: origin.hostname, at: now },
      updatedAt: now,
    };
    const next = [...arr];
    next[idx] = promoted;
    this.save(next);
    return { ...promoted };
  }

  /**
   * Auto-demotion primitive: a superseded origin that came back becomes a read-only
   * replica of the node that took it over. Same shape upsertReplica gives a replica
   * (local-only, empty ACL — replicas are never re-served) plus the new owner; any
   * `supersedes` this node carried is dropped (a replica supersedes nothing).
   */
  demoteToReplica(id: string, origin: NodeOrigin, ownerNode: string): DatasetDescriptor {
    const arr = this.load();
    const idx = arr.findIndex((d) => d.id === id);
    if (idx < 0) throw registryError('NOT_FOUND', `dataset "${id}" not found`);
    if (arr[idx].system) throw registryError('FORBIDDEN', `dataset "${id}" is a system dataset`);
    const { supersedes, ...rest } = arr[idx];
    void supersedes;
    const demoted: DatasetDescriptor = {
      ...rest,
      origin,
      ownerNode,
      visibility: 'local-only',
      acl: [],
      updatedAt: new Date().toISOString(),
    };
    const next = [...arr];
    next[idx] = demoted;
    this.save(next);
    return { ...demoted };
  }
}

let instance: DatasetRegistry | null = null;
export function getDatasetRegistry(): DatasetRegistry {
  if (!instance) instance = new DatasetRegistry();
  return instance;
}
