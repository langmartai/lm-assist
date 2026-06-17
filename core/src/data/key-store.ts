// core/src/data/key-store.ts
import { open, RootDatabase, Database } from 'lmdb';
import * as crypto from 'crypto';
import * as fs from 'fs';
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

  constructor(dirOverride?: string) {
    const dir = dirOverride || keysDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.env = open({ path: dir, compression: true, maxDbs: 2, mapSize: 256 * 1024 * 1024 });
    this.keys = this.env.openDB('keys', { encoding: 'msgpack' }) as Database<AccessKey, string>;
    this.audit = this.env.openDB('audit', { encoding: 'msgpack' }) as Database<AuditEntry, string>;
  }

  async put(key: AccessKey): Promise<void> { await this.keys.put(key.keyId, key); }

  get(keyId: string): AccessKey | undefined { return this.keys.get(keyId); }

  async revoke(keyId: string): Promise<boolean> {
    const k = this.keys.get(keyId);
    if (!k) return false;
    await this.keys.put(keyId, { ...k, revoked: true });
    return true;
  }

  async appendAudit(e: AuditEntry): Promise<void> {
    // monotonic-ish key: timestamp + random suffix avoids collisions within the same ms
    await this.audit.put(`${e.at}-${crypto.randomUUID()}`, e);
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
