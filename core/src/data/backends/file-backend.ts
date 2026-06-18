// core/src/data/backends/file-backend.ts
// Read-only adapter exposing an allow-listed file's content as DataRecords. The owning script
// is the only writer (put/delete/admin/search are NOT_SUPPORTED); content is scrubbed for inline
// AND named secrets on read; credential paths are refused at registration. Never walks the FS —
// only the explicitly registered config.path is read.
import * as fs from 'fs';
import type {
  StorageBackend, BackendKind, DatasetDescriptor, DataRecord, QuerySpec, NodeOrigin, FileConfig,
} from '../types';
import { applyQuery } from './query-filter';
import { scrubRecordContent, isHardExcludedPath } from '../redaction';
import { getDatasetRegistry } from '../dataset-registry';

export class FileBackend implements StorageBackend {
  readonly kind: BackendKind = 'file';
  private getDescriptor: (id: string) => DatasetDescriptor | undefined;

  constructor(getDescriptor?: (id: string) => DatasetDescriptor | undefined) {
    this.getDescriptor = getDescriptor || ((id) => getDatasetRegistry().get(id));
  }

  private cfg(dataset: string): FileConfig | null {
    const d = this.getDescriptor(dataset);
    if (!d || d.config.kind !== 'file') return null;
    return d.config as FileConfig;
  }

  /** Read + parse the file into scrubbed records. Returns [] if the file/config is missing. */
  private read(dataset: string): DataRecord[] {
    const c = this.cfg(dataset);
    if (!c || !fs.existsSync(c.path)) return [];
    let raw: string;
    try { raw = fs.readFileSync(c.path, 'utf8'); } catch { return []; }
    let records: DataRecord[];
    if (c.format === 'log') {
      records = this.parseLog(raw, c.maxLines);
    } else {
      records = this.parseJson(raw);
    }
    return records.map(scrubRecordContent);
  }

  private parseJson(raw: string): DataRecord[] {
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return []; }
    const mk = (id: string, value: unknown): DataRecord => ({
      id, version: 1,
      fields: (value && typeof value === 'object' && !Array.isArray(value)) ? (value as Record<string, unknown>) : { value },
      text: typeof value === 'string' ? value : undefined,
      createdAt: '', updatedAt: '',
    });
    if (Array.isArray(data)) {
      return data.map((item, i) => mk(String((item && typeof item === 'object' && 'id' in (item as object)) ? (item as Record<string, unknown>).id : i), item));
    }
    if (data && typeof data === 'object') {
      return Object.entries(data as Record<string, unknown>).map(([k, v]) => mk(k, v));
    }
    return [mk('0', data)];
  }

  protected parseLog(raw: string, maxLines?: number): DataRecord[] {
    const limit = maxLines && maxLines > 0 ? maxLines : 500;
    const allLines = raw.split('\n');
    // drop a trailing empty element from a final newline
    if (allLines.length && allLines[allLines.length - 1] === '') allLines.pop();
    const start = Math.max(0, allLines.length - limit);
    const tail = allLines.slice(start);
    return tail.map((line, i) => ({
      id: String(start + i),         // stable line number across the file
      version: 1,
      fields: { line: start + i },
      text: line,                    // scrubRecordContent (applied in read()) runs redactText on this
      createdAt: '', updatedAt: '',
    }));
  }

  async createDataset(d: DatasetDescriptor): Promise<void> {
    const c = d.config as FileConfig;
    if (c.kind !== 'file') throw new Error('FileBackend.createDataset: not a file dataset');
    if (isHardExcludedPath(c.path)) throw new Error(`refused: "${c.path}" is an excluded credential path`);
    // existence is NOT required at registration (a log may not exist yet) — reads tolerate absence.
  }
  async dropDataset(_id: string): Promise<void> { /* nothing to delete — the file is owned by its script */ }

  async get(dataset: string, id: string): Promise<DataRecord | null> {
    return this.read(dataset).find((r) => r.id === id) ?? null;
  }
  async query(dataset: string, q: QuerySpec): Promise<{ records: DataRecord[]; total?: number }> {
    return applyQuery(this.read(dataset), q);
  }

  async put(_dataset: string, _record: DataRecord): Promise<{ id: string }> {
    throw new Error('NOT_SUPPORTED: tracked file datasets are read-only (the owning script is the writer)');
  }
  async delete(_dataset: string, _id: string): Promise<boolean> {
    throw new Error('NOT_SUPPORTED: tracked file datasets are read-only');
  }
  async exportSince(_dataset: string, _since?: string): Promise<DataRecord[]> {
    throw new Error('SYNC_NOT_SUPPORTED: tracked file datasets are local read-only');
  }
  async importBatch(_dataset: string, _records: DataRecord[], _origin: NodeOrigin): Promise<{ applied: number; skipped: number }> {
    throw new Error('SYNC_NOT_SUPPORTED: tracked file datasets are local read-only');
  }
}
