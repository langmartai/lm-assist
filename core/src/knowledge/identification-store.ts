/**
 * Identification Store
 *
 * CRUD operations for identifications.json with lock file and backup strategy.
 *
 * Storage layout:
 *   ~/.lm-assist/knowledge/
 *   ├── identifications.json       # Main data file
 *   ├── identifications.json.lock  # Lock file (exclusive write access)
 *   └── identifications.json.bak   # Backup (written before each update)
 *
 * Lock/Backup Strategy:
 *   Write: acquire lock → backup → write → release lock
 *   Read: try main file → fall back to backup → create empty
 *   Lock timeout: 5 seconds (stale lock detection)
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IdentificationResult, IdentificationsFile, IdentifierType } from './identifier-types';
import { getDataDir } from '../utils/path-utils';

const KNOWLEDGE_DIR = path.join(getDataDir(), 'knowledge');
const IDENTIFICATIONS_FILE = path.join(KNOWLEDGE_DIR, 'identifications.json');
const LOCK_FILE = IDENTIFICATIONS_FILE + '.lock';
const BACKUP_FILE = IDENTIFICATIONS_FILE + '.bak';
const LOCK_TIMEOUT_MS = 5000;

/**
 * Create an empty identifications file structure.
 */
function createEmptyFile(): IdentificationsFile {
  return {
    identifications: [],
    nextId: 1,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Acquire an exclusive lock file. Deletes stale locks older than LOCK_TIMEOUT_MS.
 * Throws if lock cannot be acquired.
 */
function acquireLock(): void {
  // Check for stale lock
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const stat = fs.statSync(LOCK_FILE);
      const age = Date.now() - stat.mtimeMs;
      if (age > LOCK_TIMEOUT_MS) {
        // Stale lock — remove it
        fs.unlinkSync(LOCK_FILE);
      } else {
        throw new Error('identifications.json is locked by another process');
      }
    } catch (err: any) {
      if (err.message.includes('locked')) throw err;
      // stat/unlink failed — lock file may have been removed by another process
    }
  }

  // Create lock file (exclusive)
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
  } catch {
    throw new Error('identifications.json is locked by another process');
  }
}

/**
 * Release the lock file.
 */
function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    // Best effort
  }
}

export class IdentificationStore {
  private _cache: IdentificationsFile | null = null;

  constructor() {
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(KNOWLEDGE_DIR)) {
      fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    }
  }

  /**
   * Read the identifications file. Uses in-memory cache; invalidated on write.
   * Falls back to backup if main file is corrupt/missing.
   */
  read(): IdentificationsFile {
    if (this._cache) return this._cache;

    // Try main file
    if (fs.existsSync(IDENTIFICATIONS_FILE)) {
      try {
        const data = fs.readFileSync(IDENTIFICATIONS_FILE, 'utf-8');
        const parsed = JSON.parse(data) as IdentificationsFile;
        if (Array.isArray(parsed.identifications)) {
          this._cache = parsed;
          return parsed;
        }
      } catch {
        // Main file corrupt — try backup
      }
    }

    // Try backup
    if (fs.existsSync(BACKUP_FILE)) {
      try {
        const data = fs.readFileSync(BACKUP_FILE, 'utf-8');
        const parsed = JSON.parse(data) as IdentificationsFile;
        if (Array.isArray(parsed.identifications)) {
          this._cache = parsed;
          return parsed;
        }
      } catch {
        // Backup also corrupt
      }
    }

    // Both missing/corrupt — create empty
    const empty = createEmptyFile();
    this.writeUnsafe(empty);
    this._cache = empty;
    return empty;
  }

  /**
   * Write identifications file with lock + backup. Invalidates in-memory cache.
   */
  write(file: IdentificationsFile): void {
    this.ensureDir();
    acquireLock();
    try {
      // Backup current file
      if (fs.existsSync(IDENTIFICATIONS_FILE)) {
        try {
          fs.copyFileSync(IDENTIFICATIONS_FILE, BACKUP_FILE);
        } catch {
          // Best effort backup
        }
      }

      // Write new data
      file.lastUpdated = new Date().toISOString();
      fs.writeFileSync(IDENTIFICATIONS_FILE, JSON.stringify(file, null, 2));
      this._cache = file;
    } finally {
      releaseLock();
    }
  }

  /**
   * Write without locking (used for initial creation only).
   */
  private writeUnsafe(file: IdentificationsFile): void {
    this.ensureDir();
    fs.writeFileSync(IDENTIFICATIONS_FILE, JSON.stringify(file, null, 2));
    this._cache = file;
  }

  /**
   * Allocate the next identification ID ("I001", "I002", ...).
   */
  private allocateId(file: IdentificationsFile): string {
    const id = `I${String(file.nextId).padStart(3, '0')}`;
    file.nextId++;
    return id;
  }

  /**
   * Add one or more identification results. Returns the added results with assigned IDs.
   */
  add(results: Omit<IdentificationResult, 'id'>[]): IdentificationResult[] {
    if (results.length === 0) return [];

    const file = this.read();
    const added: IdentificationResult[] = [];

    for (const result of results) {
      const id = this.allocateId(file);
      const full: IdentificationResult = { ...result, id };
      file.identifications.push(full);
      added.push(full);
    }

    this.write(file);
    return added;
  }

  /**
   * Get all identification results, optionally filtered.
   */
  list(filters?: {
    identifierType?: IdentifierType;
    status?: IdentificationResult['status'];
    projectPath?: string;
    sessionId?: string;
  }): IdentificationResult[] {
    const file = this.read();
    let results = file.identifications;

    if (filters) {
      if (filters.identifierType) {
        results = results.filter(r => r.identifierType === filters.identifierType);
      }
      if (filters.status) {
        results = results.filter(r => r.status === filters.status);
      }
      if (filters.projectPath) {
        results = results.filter(r => r.projectPath === filters.projectPath);
      }
      if (filters.sessionId) {
        results = results.filter(r => r.sessionId === filters.sessionId);
      }
    }

    return results;
  }

  /**
   * Get a single identification by ID.
   */
  get(id: string): IdentificationResult | null {
    const file = this.read();
    return file.identifications.find(r => r.id === id) || null;
  }

  /**
   * Update an identification result (e.g., mark as generated with knowledgeId).
   */
  update(id: string, updates: Partial<Pick<IdentificationResult, 'knowledgeId' | 'status'>>): IdentificationResult | null {
    const file = this.read();
    const result = file.identifications.find(r => r.id === id);
    if (!result) return null;

    if (updates.knowledgeId !== undefined) result.knowledgeId = updates.knowledgeId;
    if (updates.status !== undefined) result.status = updates.status;

    this.write(file);
    return result;
  }

  /**
   * Check if a specific source has already been identified.
   * Used for dedup during discovery.
   */
  hasIdentification(identifierType: IdentifierType, sessionId: string, lineIndex: number): boolean {
    const file = this.read();
    return file.identifications.some(
      r => r.identifierType === identifierType &&
           r.sessionId === sessionId &&
           r.lineIndex === lineIndex,
    );
  }

  /**
   * Find identification by agentId (for explore-agent type).
   */
  findByAgentId(agentId: string): IdentificationResult | null {
    const file = this.read();
    return file.identifications.find(r => r.agentId === agentId) || null;
  }

  /**
   * Get all identification IDs that have been generated into knowledge.
   */
  getGeneratedIds(): Set<string> {
    const file = this.read();
    const ids = new Set<string>();
    for (const r of file.identifications) {
      if (r.status === 'generated' && r.knowledgeId) {
        ids.add(r.knowledgeId);
      }
    }
    return ids;
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let instance: IdentificationStore | null = null;
export function getIdentificationStore(): IdentificationStore {
  if (!instance) instance = new IdentificationStore();
  return instance;
}
