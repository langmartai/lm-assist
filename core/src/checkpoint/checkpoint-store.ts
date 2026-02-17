/**
 * Checkpoint Store
 *
 * Persistent storage for checkpoint metadata using JSONL format.
 * Provides in-memory caching with LRU eviction.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import type {
  Checkpoint,
  CheckpointStatus,
  CheckpointStoreOptions,
  CheckpointQueryOptions,
  CheckpointListResponse,
} from '../types/checkpoint';

const DEFAULT_MAX_CHECKPOINTS = 100;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Checkpoint store events
 */
export interface CheckpointStoreEvents {
  checkpoint_created: { checkpoint: Checkpoint };
  checkpoint_updated: { checkpoint: Checkpoint; previousStatus: CheckpointStatus };
  checkpoint_deleted: { checkpointId: string };
  checkpoints_cleaned: { count: number; reason: 'expired' | 'max_limit' };
}

/**
 * In-memory cache entry with access tracking
 */
interface CacheEntry {
  checkpoint: Checkpoint;
  lastAccess: number;
}

/**
 * Checkpoint store for persisting checkpoint metadata
 */
export class CheckpointStore extends EventEmitter {
  private readonly projectPath: string;
  private readonly storePath: string;
  private readonly persist: boolean;
  private readonly maxCheckpoints: number;
  private readonly defaultTtlMs: number;

  // In-memory cache with LRU tracking
  private cache: Map<string, CacheEntry> = new Map();
  private loaded = false;

  constructor(options: CheckpointStoreOptions) {
    super();
    this.projectPath = options.projectPath;
    this.persist = options.persist ?? true;
    this.maxCheckpoints = options.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;

    // Store path in .tier-agent directory
    const tierAgentDir = path.join(this.projectPath, '.tier-agent');
    this.storePath = path.join(tierAgentDir, 'checkpoints.jsonl');

    // Ensure directory exists
    if (this.persist && !fs.existsSync(tierAgentDir)) {
      fs.mkdirSync(tierAgentDir, { recursive: true });
    }
  }

  /**
   * Load checkpoints from disk into cache
   */
  private load(): void {
    if (this.loaded || !this.persist) {
      this.loaded = true;
      return;
    }

    if (!fs.existsSync(this.storePath)) {
      this.loaded = true;
      return;
    }

    try {
      const content = fs.readFileSync(this.storePath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);

      for (const line of lines) {
        try {
          const checkpoint = JSON.parse(line) as Checkpoint;
          this.cache.set(checkpoint.id, {
            checkpoint,
            lastAccess: Date.now(),
          });
        } catch {
          // Skip invalid lines
          console.warn('Skipping invalid checkpoint line:', line.substring(0, 50));
        }
      }

      this.loaded = true;
    } catch (error) {
      console.error('Failed to load checkpoints:', error);
      this.loaded = true;
    }
  }

  /**
   * Persist all checkpoints to disk
   */
  private persistToDisk(): void {
    if (!this.persist) return;

    try {
      const lines = Array.from(this.cache.values())
        .map(entry => JSON.stringify(entry.checkpoint))
        .join('\n');

      // Ensure directory exists
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.storePath, lines + '\n', 'utf-8');
    } catch (error) {
      console.error('Failed to persist checkpoints:', error);
    }
  }

  /**
   * Evict least recently used entries if over limit
   */
  private evictIfNeeded(): void {
    if (this.cache.size <= this.maxCheckpoints) return;

    // Sort by last access time (oldest first)
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);

    // Evict oldest entries
    const toEvict = entries.slice(0, this.cache.size - this.maxCheckpoints);
    for (const [id] of toEvict) {
      this.cache.delete(id);
    }

    if (toEvict.length > 0) {
      this.emit('checkpoints_cleaned', { count: toEvict.length, reason: 'max_limit' });
    }
  }

  /**
   * Save a checkpoint
   */
  save(checkpoint: Checkpoint): void {
    this.load();

    const isNew = !this.cache.has(checkpoint.id);
    const previousStatus = this.cache.get(checkpoint.id)?.checkpoint.status;

    // Set expiration if not set
    if (!checkpoint.expiresAt) {
      checkpoint.expiresAt = new Date(Date.now() + this.defaultTtlMs).toISOString();
    }

    // Update timestamp
    checkpoint.updatedAt = new Date().toISOString();

    this.cache.set(checkpoint.id, {
      checkpoint,
      lastAccess: Date.now(),
    });

    this.evictIfNeeded();
    this.persistToDisk();

    if (isNew) {
      this.emit('checkpoint_created', { checkpoint });
    } else if (previousStatus && previousStatus !== checkpoint.status) {
      this.emit('checkpoint_updated', { checkpoint, previousStatus });
    }
  }

  /**
   * Get checkpoint by ID
   */
  get(id: string): Checkpoint | null {
    this.load();

    const entry = this.cache.get(id);
    if (!entry) return null;

    // Update access time
    entry.lastAccess = Date.now();

    return entry.checkpoint;
  }

  /**
   * Query checkpoints with filters
   */
  query(options: CheckpointQueryOptions = {}): CheckpointListResponse {
    this.load();

    let checkpoints = Array.from(this.cache.values()).map(e => e.checkpoint);

    // Filter by execution ID
    if (options.executionId) {
      checkpoints = checkpoints.filter(c => c.executionId === options.executionId);
    }

    // Filter by tier
    if (options.tier) {
      checkpoints = checkpoints.filter(c => c.tier === options.tier);
    }

    // Filter by status
    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      checkpoints = checkpoints.filter(c => statuses.includes(c.status));
    }

    // Filter by trigger
    if (options.trigger) {
      const triggers = Array.isArray(options.trigger) ? options.trigger : [options.trigger];
      checkpoints = checkpoints.filter(c => triggers.includes(c.trigger));
    }

    // Filter expired
    if (!options.includeExpired) {
      const now = new Date().toISOString();
      checkpoints = checkpoints.filter(c => !c.expiresAt || c.expiresAt > now);
    }

    // Sort
    const sortOrder = options.sortOrder ?? 'desc';
    checkpoints.sort((a, b) => {
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      return sortOrder === 'desc' ? bTime - aTime : aTime - bTime;
    });

    // Get total before pagination
    const total = checkpoints.length;

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    checkpoints = checkpoints.slice(offset, offset + limit);

    return {
      checkpoints,
      total,
      hasMore: offset + checkpoints.length < total,
    };
  }

  /**
   * Update checkpoint status
   */
  updateStatus(id: string, status: CheckpointStatus): boolean {
    this.load();

    const entry = this.cache.get(id);
    if (!entry) return false;

    const previousStatus = entry.checkpoint.status;
    entry.checkpoint.status = status;
    entry.checkpoint.updatedAt = new Date().toISOString();
    entry.lastAccess = Date.now();

    this.persistToDisk();

    if (previousStatus !== status) {
      this.emit('checkpoint_updated', {
        checkpoint: entry.checkpoint,
        previousStatus,
      });
    }

    return true;
  }

  /**
   * Delete a checkpoint
   */
  delete(id: string): boolean {
    this.load();

    const existed = this.cache.has(id);
    if (existed) {
      this.cache.delete(id);
      this.persistToDisk();
      this.emit('checkpoint_deleted', { checkpointId: id });
    }

    return existed;
  }

  /**
   * Get checkpoint by execution ID
   */
  getByExecutionId(executionId: string): Checkpoint | null {
    this.load();

    for (const entry of this.cache.values()) {
      if (entry.checkpoint.executionId === executionId) {
        entry.lastAccess = Date.now();
        return entry.checkpoint;
      }
    }

    return null;
  }

  /**
   * Get all checkpoints for a tier
   */
  getByTier(tier: string): Checkpoint[] {
    return this.query({ tier }).checkpoints;
  }

  /**
   * Cleanup expired checkpoints
   */
  cleanupExpired(): number {
    this.load();

    const now = new Date().toISOString();
    const toDelete: string[] = [];

    for (const [id, entry] of this.cache.entries()) {
      if (entry.checkpoint.expiresAt && entry.checkpoint.expiresAt < now) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.cache.delete(id);
    }

    if (toDelete.length > 0) {
      this.persistToDisk();
      this.emit('checkpoints_cleaned', { count: toDelete.length, reason: 'expired' });
    }

    return toDelete.length;
  }

  /**
   * Get statistics
   */
  getStats(): {
    total: number;
    byStatus: Record<CheckpointStatus, number>;
    byTier: Record<string, number>;
  } {
    this.load();

    const byStatus: Record<string, number> = {};
    const byTier: Record<string, number> = {};

    for (const entry of this.cache.values()) {
      const { status, tier } = entry.checkpoint;
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      if (tier) {
        byTier[tier] = (byTier[tier] ?? 0) + 1;
      }
    }

    return {
      total: this.cache.size,
      byStatus: byStatus as Record<CheckpointStatus, number>,
      byTier,
    };
  }

  /**
   * Clear all checkpoints (for testing)
   */
  clear(): void {
    this.cache.clear();
    if (this.persist && fs.existsSync(this.storePath)) {
      fs.unlinkSync(this.storePath);
    }
  }
}

/**
 * Create a checkpoint store instance
 */
export function createCheckpointStore(options: CheckpointStoreOptions): CheckpointStore {
  return new CheckpointStore(options);
}
