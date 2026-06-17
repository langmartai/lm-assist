// core/src/data/dataset-registry.ts
import * as fs from 'fs';
import * as path from 'path';
import type {
  DatasetDescriptor, BackendKind, BackendConfig, AclRule, NodeVisibility,
} from './types';
import { datasetsFile, thisNodeId } from './paths';

export const DATASET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface CreateDatasetInput {
  id: string;
  backend: BackendKind;
  title?: string;
  visibility?: NodeVisibility;
  readOnly?: boolean;
  sensitive?: boolean;
  config: BackendConfig;
  acl?: AclRule[];
  system?: boolean;
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
      if (this.cache && stat.mtimeMs === this.mtime) return this.cache;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      const arr: DatasetDescriptor[] = Array.isArray(data) ? data : [];
      this.cache = arr;
      this.mtime = stat.mtimeMs;
      return arr;
    } catch {
      return this.cache ?? [];
    }
  }

  private save(arr: DatasetDescriptor[]): void {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(arr, null, 2));
    this.cache = arr;
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
    const next = arr.filter((d) => d.id !== id);
    if (next.length === arr.length) return false;
    this.save(next);
    return true;
  }
}

let instance: DatasetRegistry | null = null;
export function getDatasetRegistry(): DatasetRegistry {
  if (!instance) instance = new DatasetRegistry();
  return instance;
}
