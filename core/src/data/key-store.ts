// core/src/data/key-store.ts
import { open, RootDatabase, Database } from 'lmdb';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AccessKey, PrincipalType, DataAction } from './types';
import { keysDir } from './paths';

export interface AuditEntry {
  at: string;
  event: 'issue' | 'use' | 'revoke' | 'deny';
  keyId?: string;
  principalType: PrincipalType;
  principalId?: string;
  dataset?: string;
  action?: DataAction;
  detail?: string;
}

export class KeyStore {
  private env: RootDatabase;
  private keys: Database<AccessKey, string>;
  private audit: Database<AuditEntry, string>;
  private _closed = false;
  private auditWrites = 0;
  private readonly maxAudit: number;
  private readonly auditTrimEvery: number;

  constructor(dirOverride?: string, opts?: { maxAudit?: number; auditTrimEvery?: number }) {
    this.maxAudit = opts?.maxAudit ?? 50000;
    this.auditTrimEvery = opts?.auditTrimEvery ?? 1000;
    const dir = dirOverride || keysDir();
    const parentDir = path.dirname(dir);
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
    this.env = open({ path: dir, compression: true, maxDbs: 2, mapSize: 256 * 1024 * 1024 });
    this.keys = this.env.openDB('keys', { encoding: 'msgpack' }) as Database<AccessKey, string>;
    this.audit = this.env.openDB('audit', { encoding: 'msgpack' }) as Database<AuditEntry, string>;
  }

  async put(key: AccessKey): Promise<void> { await this.keys.put(key.keyId, key); }

  get(keyId: string): AccessKey | undefined { return this.keys.get(keyId); }

  /** All issued keys (metadata + secretHash). Callers that expose keys MUST strip secretHash. */
  list(): AccessKey[] {
    const out: AccessKey[] = [];
    for (const { value } of this.keys.getRange()) out.push(value as AccessKey);
    return out;
  }

  async revoke(keyId: string): Promise<boolean> {
    const k = this.keys.get(keyId);
    if (!k) return false;
    await this.keys.put(keyId, { ...k, revoked: true });
    return true;
  }

  async appendAudit(e: AuditEntry): Promise<void> {
    // monotonic-ish key: timestamp + random suffix avoids collisions within the same ms
    await this.audit.put(`${e.at}-${crypto.randomUUID()}`, e);
    if (++this.auditWrites % this.auditTrimEvery === 0) await this.trimAudit();
  }

  /** Ring-buffer: drop the oldest audit rows beyond maxAudit + sweep long-expired keys. Awaited so growth is bounded. */
  private async trimAudit(): Promise<void> {
    try {
      let count = 0;
      for (const _ of this.audit.getKeys()) count++;                 // portable count (runs only every auditTrimEvery)
      const over = count - this.maxAudit;
      const dels: Array<Promise<boolean>> = [];
      if (over > 0) {
        const oldest: string[] = [];
        for (const key of this.audit.getKeys({ limit: over })) oldest.push(key as string); // keys are time-ordered → oldest first
        for (const k of oldest) dels.push(this.audit.remove(k));
      }
      const nowMs = Date.now();
      for (const { key, value } of this.keys.getRange()) {
        const exp = (value as AccessKey).expiresAt;
        if (exp && Date.parse(exp) < nowMs - 86_400_000) dels.push(this.keys.remove(key as string)); // purge keys expired >1d ago
      }
      await Promise.all(dels);
    } catch { /* best-effort; never break the request path */ }
  }

  listAudit(): AuditEntry[] {
    const out: AuditEntry[] = [];
    for (const { value } of this.audit.getRange()) out.push(value as AuditEntry);
    return out;
  }

  close(): void { if (!this._closed) { this._closed = true; this.env.close(); } }
}

let instance: KeyStore | null = null;
export function getKeyStore(): KeyStore {
  if (!instance) instance = new KeyStore();
  return instance;
}
