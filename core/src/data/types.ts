// core/src/data/types.ts
// Shared contracts for the generic data service. CommonJS-safe (types only).

export type BackendKind = 'vector' | 'sql' | 'cache';
export type DataAction = 'read' | 'query' | 'search' | 'write' | 'delete' | 'manage';
export type NodeVisibility = 'local-only' | 'synced' | 'cross-node-readable';
export type PrincipalType = 'local' | 'cloud';

export interface Principal {
  type: PrincipalType;
  userId?: string; // present for cloud principals when the hub supplies one
}

export interface NodeOrigin {
  machineId: string;
  hostname: string;
  os: string;
}

export interface AclRule {
  // a principal class, a specific cloud user, or any authed caller
  principal: PrincipalType | { userId: string } | '*';
  actions: DataAction[];
}

export interface CacheConfig { kind: 'cache'; }
export interface VectorConfig { kind: 'vector'; } // v1 placeholder (M2)
export interface SqlConfig {
  kind: 'sql';
  indexedFields?: Array<{ path: string; type: 'text' | 'number' }>; // M3
}
export type BackendConfig = CacheConfig | VectorConfig | SqlConfig;

export interface DatasetDescriptor {
  id: string;                 // ^[a-z0-9][a-z0-9_-]{0,63}$
  backend: BackendKind;
  title?: string;
  ownerNode: string;          // machineId that owns it
  visibility: NodeVisibility; // governs CLOUD principals
  system?: boolean;           // reserved datasets (M2) — not user-deletable
  readOnly?: boolean;         // HARD cap to read/query/search for EVERY principal
  sensitive?: boolean;        // never exposed to cloud; never synced
  syncMode?: SyncMode;        // 'none' (default) | 'full' | 'partial'
  origin?: NodeOrigin;        // when set, this is a remote replica (read-only; written by sync engine)
  config: BackendConfig;
  acl: AclRule[];
  createdAt: string;
  updatedAt: string;
}

export interface DataRecord {
  id: string;
  version: number;
  fields: Record<string, unknown>;
  text?: string;
  metadata?: Record<string, unknown>;
  origin?: NodeOrigin;        // stamped on sync landing (M5); absent = local
  createdAt: string;
  updatedAt: string;
}

export type SyncMode = 'none' | 'full' | 'partial';

/** LWW order: version desc, then updatedAt desc, then ownerNode desc. True iff `incoming` should win. */
export function isNewer(incoming: { version: number; updatedAt: string; origin?: NodeOrigin },
                        local: { version: number; updatedAt: string; origin?: NodeOrigin } | null): boolean {
  if (!local) return true;
  if (incoming.version !== local.version) return incoming.version > local.version;
  if (incoming.updatedAt !== local.updatedAt) return incoming.updatedAt > local.updatedAt;
  return (incoming.origin?.machineId || '') > (local.origin?.machineId || '');
}

export interface QueryFilter {
  field: string;
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';
  value: unknown;
}
export interface QuerySpec {
  filter?: QueryFilter[];
  fts?: string;
  sort?: Array<{ field: string; dir: 'asc' | 'desc' }>;
  limit?: number;
  offset?: number;
}
export interface SearchSpec { query: string; limit?: number; filter?: QueryFilter[]; }

export interface Grant { dataset: string; actions: DataAction[]; }

export interface AccessKey {
  keyId: string;
  secretHash: string;         // sha256 hex of the secret; secret itself is never stored
  principalType: PrincipalType;
  principalId?: string;
  node: string;               // machineId this key is valid on
  grants: Grant[];
  label?: string;             // requester's stated intent (audited)
  issuedAt: string;
  expiresAt: string;
  revoked?: boolean;
}

export interface AccessRequest {
  intent?: string;
  grants: Array<{ dataset: string; actions: DataAction[] }>;
  ttlSeconds?: number;
}

// M1 backend contract. Sync hooks (exportSince/importBatch) added in M5-T2.
export interface StorageBackend {
  readonly kind: BackendKind;
  createDataset(d: DatasetDescriptor): Promise<void>;
  dropDataset(id: string): Promise<void>;
  put(dataset: string, record: DataRecord): Promise<{ id: string }>;
  get(dataset: string, id: string): Promise<DataRecord | null>;
  query(dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }>;
  search?(dataset: string, s: SearchSpec): Promise<Array<DataRecord & { score: number }>>;
  delete(dataset: string, id: string): Promise<boolean>;
  // M5 sync hooks ----------------------------------------------------------------
  /** Returns records with updatedAt >= since (or all if no since), ascending by updatedAt. */
  exportSince(dataset: string, since?: string): Promise<DataRecord[]>;
  /** LWW-guarded batch import: stamps origin on each record applied. */
  importBatch(dataset: string, records: DataRecord[], origin: NodeOrigin): Promise<{ applied: number; skipped: number }>;
}
