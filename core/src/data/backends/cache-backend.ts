// core/src/data/backends/cache-backend.ts
import { open, RootDatabase, Database } from 'lmdb';
import * as fs from 'fs';
import * as path from 'path';
import type {
  StorageBackend, BackendKind, DatasetDescriptor, DataRecord, QuerySpec, NodeOrigin,
} from '../types';
import { isNewer } from '../types';
import { applyQuery } from './query-filter';
import { cacheDirFor } from '../paths';

interface Env { root: RootDatabase; db: Database<DataRecord, string>; }

export class CacheBackend implements StorageBackend {
  readonly kind: BackendKind = 'cache';
  private envs = new Map<string, Env>();
  private baseDirOverride?: string;

  constructor(baseDirOverride?: string) { this.baseDirOverride = baseDirOverride; }

  private dirFor(id: string): string {
    return this.baseDirOverride ? path.join(this.baseDirOverride, `${id}.lmdb`) : cacheDirFor(id);
  }

  private envFor(id: string): Env {
    let e = this.envs.get(id);
    if (e) return e;
    const dir = this.dirFor(id);
    const parentDir = path.dirname(dir);
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
    const root = open({ path: dir, compression: true, maxDbs: 1, mapSize: 512 * 1024 * 1024 });
    const db = root.openDB('records', { encoding: 'msgpack' }) as Database<DataRecord, string>;
    e = { root, db };
    this.envs.set(id, e);
    return e;
  }

  async createDataset(d: DatasetDescriptor): Promise<void> { this.envFor(d.id); }

  async dropDataset(id: string): Promise<void> {
    const e = this.envs.get(id);
    if (e) { e.root.close(); this.envs.delete(id); }
    const dir = this.dirFor(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  async put(dataset: string, record: DataRecord): Promise<{ id: string }> {
    await this.envFor(dataset).db.put(record.id, record);
    return { id: record.id };
  }

  async get(dataset: string, id: string): Promise<DataRecord | null> {
    return this.envFor(dataset).db.get(id) ?? null;
  }

  async query(dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }> {
    const { db } = this.envFor(dataset);
    const rows: DataRecord[] = [];
    for (const { value } of db.getRange()) rows.push(value as DataRecord);
    return applyQuery(rows, q);
  }

  async delete(dataset: string, id: string): Promise<boolean> {
    const { db } = this.envFor(dataset);
    if (db.get(id) === undefined) return false;
    await db.remove(id);
    return true;
  }

  async exportSince(dataset: string, since?: string): Promise<DataRecord[]> {
    const { db } = this.envFor(dataset);
    const rows: DataRecord[] = [];
    for (const { value } of db.getRange()) {
      const r = value as DataRecord;
      if (!since || r.updatedAt >= since) rows.push(r);
    }
    rows.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
    return rows;
  }

  async importBatch(dataset: string, records: DataRecord[], origin: NodeOrigin): Promise<{ applied: number; skipped: number }> {
    const { db } = this.envFor(dataset);
    let applied = 0, skipped = 0;
    for (const incoming of records) {
      const local = (db.get(incoming.id) as DataRecord | undefined) ?? null;
      const stamped: DataRecord = { ...incoming, origin };
      if (isNewer(stamped, local)) { await db.put(incoming.id, stamped); applied++; } else skipped++;
    }
    return { applied, skipped };
  }
}
