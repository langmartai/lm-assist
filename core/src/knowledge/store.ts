/**
 * Knowledge Store
 *
 * Singleton store for knowledge documents and comments.
 * Pattern: follows MilestoneStore — in-memory LRU cache, JSON index, per-document files.
 *
 * Storage layout:
 *   ~/.lm-assist/knowledge/
 *   ├── index.json           # Knowledge index (id → metadata)
 *   ├── K001.md              # Knowledge documents
 *   ├── K002.md
 *   ├── comments/
 *   │   ├── K001.json        # Comments for K001
 *   │   └── K002.json
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  Knowledge,
  KnowledgePart,
  KnowledgeComment,
  KnowledgeCommentType,
  KnowledgeIndex,
  KnowledgeCommentFile,
  KnowledgeType,
} from './types';
import { parseKnowledgeMd, renderKnowledgeMd } from './parser';
import { getDataDir } from '../utils/path-utils';

const KNOWLEDGE_DIR = path.join(getDataDir(), 'knowledge');
const COMMENTS_DIR = path.join(KNOWLEDGE_DIR, 'comments');
const REMOTE_DIR = path.join(KNOWLEDGE_DIR, 'remote');
const INDEX_FILE = path.join(KNOWLEDGE_DIR, 'index.json');

export class KnowledgeStore {
  private cache = new Map<string, { knowledge: Knowledge; lastAccessed: number; cachedMtimeMs: number }>();
  private index: KnowledgeIndex | null = null;
  private maxCacheSize = 100;

  constructor() {
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(KNOWLEDGE_DIR)) {
      fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    }
    if (!fs.existsSync(COMMENTS_DIR)) {
      fs.mkdirSync(COMMENTS_DIR, { recursive: true });
    }
    if (!fs.existsSync(REMOTE_DIR)) {
      fs.mkdirSync(REMOTE_DIR, { recursive: true });
    }
  }

  private knowledgePath(id: string, machineId?: string): string {
    if (machineId) {
      const machineDir = path.join(REMOTE_DIR, machineId);
      if (!fs.existsSync(machineDir)) {
        fs.mkdirSync(machineDir, { recursive: true });
      }
      return path.join(machineDir, `${id}.md`);
    }
    return path.join(KNOWLEDGE_DIR, `${id}.md`);
  }

  /** Build index key: local = "K001", remote = "machineId:K001" */
  private indexKey(id: string, machineId?: string): string {
    return machineId ? `${machineId}:${id}` : id;
  }

  private commentsPath(knowledgeId: string): string {
    return path.join(COMMENTS_DIR, `${knowledgeId}.json`);
  }

  private evictIfNeeded(): void {
    if (this.cache.size <= this.maxCacheSize) return;

    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    this.cache.forEach((entry, key) => {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    });
    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  // ─── Index Management ──────────────────────────────────────────────────

  getIndex(): KnowledgeIndex {
    if (this.index) return this.index;

    if (fs.existsSync(INDEX_FILE)) {
      try {
        const data = fs.readFileSync(INDEX_FILE, 'utf-8');
        this.index = JSON.parse(data);
        return this.index!;
      } catch {
        // Fall through to default
      }
    }

    this.index = { knowledges: {}, nextId: 1, lastUpdated: Date.now() };
    return this.index;
  }

  private saveIndex(): void {
    this.ensureDir();
    fs.writeFileSync(INDEX_FILE, JSON.stringify(this.index!, null, 2));
  }

  private updateIndexEntry(knowledge: Knowledge): void {
    const index = this.getIndex();
    const indexKey = this.indexKey(knowledge.id, knowledge.machineId);
    const comments = knowledge.origin === 'remote' ? [] : this.getComments(knowledge.id, false);

    index.knowledges[indexKey] = {
      title: knowledge.title,
      type: knowledge.type,
      project: knowledge.project,
      status: knowledge.status,
      partCount: knowledge.parts.length,
      unaddressedComments: comments.length,
      updatedAt: knowledge.updatedAt,
      sourceSessionId: knowledge.sourceSessionId,
      sourceAgentId: knowledge.sourceAgentId,
      sourceTimestamp: knowledge.sourceTimestamp,
      origin: knowledge.origin,
      machineId: knowledge.machineId,
      machineHostname: knowledge.machineHostname,
      machineOS: knowledge.machineOS,
    };
    index.lastUpdated = Date.now();
    this.saveIndex();
  }

  private removeIndexEntry(id: string): void {
    const index = this.getIndex();
    delete index.knowledges[id];
    index.lastUpdated = Date.now();
    this.saveIndex();
  }

  private allocateId(): string {
    const index = this.getIndex();
    const id = `K${String(index.nextId).padStart(3, '0')}`;
    index.nextId++;
    this.saveIndex();
    return id;
  }

  // ─── Knowledge CRUD ──────────────────────────────────────────────────

  getKnowledge(id: string, machineId?: string): Knowledge | null {
    const cacheKey = machineId ? `${machineId}:${id}` : id;
    const filePath = this.knowledgePath(id, machineId);

    // Check cache — but validate against file mtime so cross-process writes are picked up
    const cached = this.cache.get(cacheKey);
    if (cached) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs <= cached.cachedMtimeMs) {
          cached.lastAccessed = Date.now();
          return cached.knowledge;
        }
        // File is newer than cached version — fall through to reload
      } catch {
        // File disappeared; evict and return null
        this.cache.delete(cacheKey);
        return null;
      }
    }

    // Read from disk
    if (!fs.existsSync(filePath)) return null;

    try {
      const stat = fs.statSync(filePath);
      const md = fs.readFileSync(filePath, 'utf-8');
      const knowledge = parseKnowledgeMd(md);
      if (!knowledge) return null;

      this.cache.set(cacheKey, { knowledge, lastAccessed: Date.now(), cachedMtimeMs: stat.mtimeMs });
      this.evictIfNeeded();

      return knowledge;
    } catch {
      return null;
    }
  }

  getKnowledgePart(knowledgeId: string, partId: string): KnowledgePart | null {
    const knowledge = this.getKnowledge(knowledgeId);
    if (!knowledge) return null;
    return knowledge.parts.find(p => p.partId === partId) ?? null;
  }

  /**
   * Get all knowledge documents, optionally filtered by project, type, origin.
   * @param origin 'local' = only local, 'remote' = only remote, undefined = all
   */
  getAllKnowledge(project?: string, type?: KnowledgeType, status?: string, origin?: 'local' | 'remote'): Knowledge[] {
    const index = this.getIndex();
    const results: Knowledge[] = [];

    for (const [indexKey, meta] of Object.entries(index.knowledges)) {
      if (project && meta.project !== project) continue;
      if (type && meta.type !== type) continue;
      if (status && meta.status !== status) continue;
      if (origin === 'local' && meta.origin === 'remote') continue;
      if (origin === 'remote' && meta.origin !== 'remote') continue;

      const knowledge = meta.origin === 'remote' && meta.machineId
        ? this.getKnowledge(indexKey.replace(`${meta.machineId}:`, ''), meta.machineId)
        : this.getKnowledge(indexKey);
      if (knowledge) results.push(knowledge);
    }

    return results;
  }

  /**
   * Get a lightweight list of knowledge (summaries only, no full content).
   * @param origin 'local' = only local, 'remote' = only remote, undefined = all
   */
  getKnowledgeList(project?: string, type?: KnowledgeType, status?: string, origin?: 'local' | 'remote'): Array<{
    id: string;
    title: string;
    type: KnowledgeType;
    project: string;
    status: string;
    partCount: number;
    unaddressedComments: number;
    createdAt: string;
    updatedAt: string;
    sourceSessionId?: string;
    sourceAgentId?: string;
    sourceTimestamp?: string;
    origin?: string;
    machineId?: string;
    machineHostname?: string;
    machineOS?: string;
    parts: Array<{ partId: string; title: string; summary: string }>;
  }> {
    const index = this.getIndex();
    const results: Array<any> = [];

    for (const [indexKey, meta] of Object.entries(index.knowledges)) {
      if (project && meta.project !== project) continue;
      if (type && meta.type !== type) continue;
      if (status && meta.status !== status) continue;
      if (origin === 'local' && meta.origin === 'remote') continue;
      if (origin === 'remote' && meta.origin !== 'remote') continue;

      const knowledge = meta.origin === 'remote' && meta.machineId
        ? this.getKnowledge(indexKey.replace(`${meta.machineId}:`, ''), meta.machineId)
        : this.getKnowledge(indexKey);
      if (!knowledge) continue;

      results.push({
        id: knowledge.id,
        title: meta.title,
        type: meta.type,
        project: meta.project,
        status: meta.status,
        partCount: meta.partCount,
        unaddressedComments: meta.unaddressedComments,
        createdAt: knowledge.createdAt,
        updatedAt: meta.updatedAt,
        sourceSessionId: meta.sourceSessionId,
        sourceAgentId: meta.sourceAgentId,
        sourceTimestamp: knowledge.sourceTimestamp,
        origin: meta.origin,
        machineId: meta.machineId,
        machineHostname: meta.machineHostname,
        machineOS: meta.machineOS,
        parts: knowledge.parts.map(p => ({
          partId: p.partId,
          title: p.title,
          summary: p.summary,
        })),
      });
    }

    return results;
  }

  /**
   * Create a new knowledge document. Allocates an ID automatically.
   */
  createKnowledge(data: {
    title: string;
    type: KnowledgeType;
    project: string;
    parts: KnowledgePart[];
    status?: 'active' | 'outdated' | 'archived';
    sourceSessionId?: string;
    sourceAgentId?: string;
    sourceTimestamp?: string;
    /** Remote origin fields — when set, stores in remote/{machineId}/ subdirectory */
    id?: string;
    origin?: 'local' | 'remote';
    machineId?: string;
    machineHostname?: string;
    machineOS?: string;
    createdAt?: string;
    updatedAt?: string;
  }): Knowledge {
    // Skip dedup checks for remote knowledge (uses composite key dedup instead)
    if (data.origin !== 'remote') {
      // Atomic dedup: reject if sourceAgentId already exists (synchronous — no race window)
      if (data.sourceAgentId) {
        const existing = this.findByAgentId(data.sourceAgentId);
        if (existing) {
          throw new Error(`Duplicate: agent ${data.sourceAgentId} already generated as ${existing}`);
        }
      }

      // Dedup by title + sourceSessionId: reject if same title already exists for this session
      if (data.sourceSessionId && data.title) {
        const existing = this.findByTitleAndSession(data.title, data.sourceSessionId);
        if (existing) {
          throw new Error(`Duplicate: "${data.title}" already exists for session ${data.sourceSessionId} as ${existing}`);
        }
      }
    }

    // For remote knowledge, use the provided ID; for local, allocate a new one
    const id = (data.origin === 'remote' && data.id) ? data.id : this.allocateId();
    const now = new Date().toISOString();

    // Ensure part IDs match the knowledge ID
    const parts = data.parts.map((p, i) => ({
      ...p,
      partId: `${id}.${i + 1}`,
    }));

    const knowledge: Knowledge = {
      id,
      title: data.title,
      type: data.type,
      project: data.project,
      status: data.status || 'active',
      createdAt: data.createdAt || now,
      updatedAt: data.updatedAt || now,
      parts,
      sourceSessionId: data.sourceSessionId,
      sourceAgentId: data.sourceAgentId,
      sourceTimestamp: data.sourceTimestamp,
      origin: data.origin,
      machineId: data.machineId,
      machineHostname: data.machineHostname,
      machineOS: data.machineOS,
    };

    this.saveKnowledge(knowledge);
    return knowledge;
  }

  /**
   * Create knowledge from raw Markdown content (already formatted).
   */
  createKnowledgeFromMd(mdContent: string): Knowledge | null {
    const parsed = parseKnowledgeMd(mdContent);
    if (!parsed) return null;

    // If no ID in the MD, ID is invalid format, or ID already exists, allocate a new one
    if (!parsed.id || !/^K\d+$/.test(parsed.id) || this.getIndex().knowledges[parsed.id]) {
      parsed.id = this.allocateId();
      // Re-number parts
      parsed.parts = parsed.parts.map((p, i) => ({
        ...p,
        partId: `${parsed.id}.${i + 1}`,
      }));
    } else {
      // MD has a valid, unused ID — advance nextId past it to prevent future collisions
      const numericId = parseInt(parsed.id.slice(1), 10);
      const index = this.getIndex();
      if (!isNaN(numericId) && numericId >= index.nextId) {
        index.nextId = numericId + 1;
        this.saveIndex();
      }
    }

    this.saveKnowledge(parsed);
    return parsed;
  }

  /**
   * Update an existing knowledge document.
   */
  updateKnowledge(id: string, updates: Partial<Pick<Knowledge, 'title' | 'type' | 'project' | 'status' | 'parts' | 'sourceSessionId' | 'sourceAgentId' | 'sourceTimestamp'>>): Knowledge | null {
    const existing = this.getKnowledge(id);
    if (!existing) return null;

    // Clone to avoid corrupting cache if saveKnowledge fails
    const updated: Knowledge = { ...existing, parts: [...existing.parts] };

    if (updates.title !== undefined) updated.title = updates.title;
    if (updates.type !== undefined) updated.type = updates.type;
    if (updates.project !== undefined) updated.project = updates.project;
    if (updates.status !== undefined) updated.status = updates.status;
    if (updates.parts !== undefined) updated.parts = updates.parts;
    if (updates.sourceSessionId !== undefined) updated.sourceSessionId = updates.sourceSessionId;
    if (updates.sourceAgentId !== undefined) updated.sourceAgentId = updates.sourceAgentId;
    if (updates.sourceTimestamp !== undefined) updated.sourceTimestamp = updates.sourceTimestamp;
    updated.updatedAt = new Date().toISOString();

    this.saveKnowledge(updated);
    return updated;
  }

  /**
   * Update knowledge from raw Markdown (used by the reviewer).
   */
  updateKnowledgeFromMd(id: string, mdContent: string): Knowledge | null {
    // Verify document exists (update semantics, not create)
    if (!this.getKnowledge(id)) return null;

    const parsed = parseKnowledgeMd(mdContent);
    if (!parsed) return null;

    // Ensure the ID matches
    parsed.id = id;
    parsed.updatedAt = new Date().toISOString();

    this.saveKnowledge(parsed);
    return parsed;
  }

  /**
   * Delete a knowledge document and its comments.
   */
  deleteKnowledge(id: string): boolean {
    const filePath = this.knowledgePath(id);
    const commentsPath = this.commentsPath(id);

    let deleted = false;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      deleted = true;
    }
    if (fs.existsSync(commentsPath)) {
      fs.unlinkSync(commentsPath);
    }

    this.cache.delete(id);
    this.removeIndexEntry(id);
    return deleted;
  }

  private saveKnowledge(knowledge: Knowledge): void {
    this.ensureDir();

    const filePath = this.knowledgePath(knowledge.id, knowledge.machineId);
    const md = renderKnowledgeMd(knowledge);
    fs.writeFileSync(filePath, md);

    // Record the mtime right after writing so the cache entry is valid
    const mtimeMs = fs.statSync(filePath).mtimeMs;

    // Update cache
    const cacheKey = this.indexKey(knowledge.id, knowledge.machineId);
    this.cache.set(cacheKey, { knowledge, lastAccessed: Date.now(), cachedMtimeMs: mtimeMs });
    this.evictIfNeeded();

    // Update index
    this.updateIndexEntry(knowledge);
  }

  /**
   * Re-save a knowledge entry: updates the index without re-fetching.
   * Used to repair index entries for .md files that exist on disk
   * but are missing from the index (e.g. after a crashed sync).
   */
  resaveKnowledge(knowledge: Knowledge): void {
    this.updateIndexEntry(knowledge);
  }

  // ─── Comments ──────────────────────────────────────────────────

  private loadCommentFile(knowledgeId: string): KnowledgeCommentFile {
    const filePath = this.commentsPath(knowledgeId);
    if (!fs.existsSync(filePath)) {
      return { comments: [], nextCommentId: 1 };
    }

    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return { comments: [], nextCommentId: 1 };
    }
  }

  private saveCommentFile(knowledgeId: string, file: KnowledgeCommentFile): void {
    this.ensureDir();
    fs.writeFileSync(this.commentsPath(knowledgeId), JSON.stringify(file, null, 2));
  }

  /**
   * Get comments for a knowledge document.
   * @param includeAddressed If false (default), only returns unaddressed comments.
   */
  getComments(knowledgeId: string, includeAddressed = false): KnowledgeComment[] {
    const file = this.loadCommentFile(knowledgeId);
    if (includeAddressed) return file.comments;
    return file.comments.filter(c => c.state === 'not_addressed');
  }

  /**
   * Add a comment to a knowledge document.
   */
  addComment(data: {
    knowledgeId: string;
    partId?: string;
    type: KnowledgeCommentType;
    content: string;
    source: 'llm' | 'user' | 'reviewer';
  }): KnowledgeComment {
    const file = this.loadCommentFile(data.knowledgeId);
    const id = `C${String(file.nextCommentId).padStart(3, '0')}`;

    const comment: KnowledgeComment = {
      id,
      knowledgeId: data.knowledgeId,
      partId: data.partId,
      type: data.type,
      content: data.content,
      source: data.source,
      state: 'not_addressed',
      createdAt: new Date().toISOString(),
    };

    file.comments.push(comment);
    file.nextCommentId++;
    this.saveCommentFile(data.knowledgeId, file);

    // Update index (unaddressed count changed)
    const knowledge = this.getKnowledge(data.knowledgeId);
    if (knowledge) this.updateIndexEntry(knowledge);

    return comment;
  }

  /**
   * Update comment state (e.g., mark as addressed by reviewer).
   */
  updateCommentState(knowledgeId: string, commentId: string, state: 'not_addressed' | 'addressed', addressedBy?: string): boolean {
    const file = this.loadCommentFile(knowledgeId);
    const comment = file.comments.find(c => c.id === commentId);
    if (!comment) return false;

    comment.state = state;
    if (state === 'addressed') {
      comment.addressedAt = new Date().toISOString();
      comment.addressedBy = addressedBy;
    }

    this.saveCommentFile(knowledgeId, file);

    // Update index
    const knowledge = this.getKnowledge(knowledgeId);
    if (knowledge) this.updateIndexEntry(knowledge);

    return true;
  }

  /**
   * Get all knowledge IDs that have unaddressed comments.
   */
  getKnowledgeWithUnaddressedComments(): string[] {
    const index = this.getIndex();
    return Object.entries(index.knowledges)
      .filter(([, meta]) => meta.unaddressedComments > 0)
      .map(([id]) => id);
  }

  // ─── Utility ──────────────────────────────────────────────────

  /**
   * Refresh the unaddressed comment counts in the index for all knowledge.
   */
  refreshIndex(): void {
    const index = this.getIndex();
    for (const [indexKey, meta] of Object.entries(index.knowledges)) {
      const knowledge = meta.origin === 'remote' && meta.machineId
        ? this.getKnowledge(indexKey.replace(`${meta.machineId}:`, ''), meta.machineId)
        : this.getKnowledge(indexKey);
      if (knowledge) {
        this.updateIndexEntry(knowledge);
      }
    }
  }

  /**
   * Get all knowledge IDs.
   */
  getAllIds(): string[] {
    return Object.keys(this.getIndex().knowledges);
  }

  /**
   * Get set of all sourceAgentId values from the index (for dedup).
   */
  getGeneratedAgentIds(): Set<string> {
    const index = this.getIndex();
    const ids = new Set<string>();
    for (const meta of Object.values(index.knowledges)) {
      if (meta.sourceAgentId) ids.add(meta.sourceAgentId);
    }
    return ids;
  }

  /**
   * Get set of "title\0sessionId" keys for title+session dedup during candidate discovery.
   */
  getGeneratedTitleSessionKeys(): Set<string> {
    const index = this.getIndex();
    const keys = new Set<string>();
    for (const meta of Object.values(index.knowledges)) {
      if (meta.title && meta.sourceSessionId) {
        keys.add(`${meta.title}\0${meta.sourceSessionId}`);
      }
    }
    return keys;
  }

  /**
   * Find knowledge ID by sourceAgentId (for dedup error messages).
   */
  findByAgentId(agentId: string): string | null {
    const index = this.getIndex();
    for (const [id, meta] of Object.entries(index.knowledges)) {
      if (meta.sourceAgentId === agentId) return id;
    }
    return null;
  }

  /**
   * Find knowledge ID by title + sourceSessionId (for dedup when sourceAgentId is empty).
   */
  findByTitleAndSession(title: string, sourceSessionId: string): string | null {
    const index = this.getIndex();
    for (const [id, meta] of Object.entries(index.knowledges)) {
      if (meta.title === title && meta.sourceSessionId === sourceSessionId) return id;
    }
    return null;
  }

  // ─── Remote Knowledge Helpers ──────────────────────────────────────────

  /**
   * Find remote knowledge by machineId + knowledgeId composite key.
   */
  findRemoteKnowledge(machineId: string, knowledgeId: string): Knowledge | null {
    return this.getKnowledge(knowledgeId, machineId);
  }

  /**
   * Get all knowledge IDs synced from a specific remote machine.
   */
  getRemoteKnowledgeIds(machineId: string): string[] {
    const index = this.getIndex();
    const ids: string[] = [];
    const prefix = `${machineId}:`;
    for (const [indexKey, meta] of Object.entries(index.knowledges)) {
      if (meta.origin === 'remote' && indexKey.startsWith(prefix)) {
        ids.push(indexKey.replace(prefix, ''));
      }
    }
    return ids;
  }

  /**
   * Delete a remote knowledge entry by machineId + knowledgeId.
   */
  deleteRemoteKnowledge(machineId: string, knowledgeId: string): boolean {
    const filePath = this.knowledgePath(knowledgeId, machineId);
    const indexKey = this.indexKey(knowledgeId, machineId);

    let deleted = false;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      deleted = true;
    }

    this.cache.delete(indexKey);

    const index = this.getIndex();
    if (index.knowledges[indexKey]) {
      delete index.knowledges[indexKey];
      index.lastUpdated = Date.now();
      this.saveIndex();
    }

    return deleted;
  }

  /**
   * Find knowledge by its original ID, searching both local and remote entries.
   * Returns the first match found (local preferred over remote).
   */
  findKnowledgeByOriginalId(knowledgeId: string): Knowledge | null {
    // Try local first
    const local = this.getKnowledge(knowledgeId);
    if (local) return local;

    // Search remote entries — check each unique machineId for this knowledgeId
    const index = this.getIndex();
    const tried = new Set<string>();
    for (const [indexKey, meta] of Object.entries(index.knowledges)) {
      if (meta.origin !== 'remote' || !meta.machineId) continue;
      if (tried.has(meta.machineId)) continue;
      // Check if this index key matches the requested knowledgeId
      if (indexKey !== `${meta.machineId}:${knowledgeId}`) continue;
      tried.add(meta.machineId);
      const remote = this.getKnowledge(knowledgeId, meta.machineId);
      if (remote) return remote;
    }

    return null;
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let instance: KnowledgeStore | null = null;
export function getKnowledgeStore(): KnowledgeStore {
  if (!instance) instance = new KnowledgeStore();
  return instance;
}
