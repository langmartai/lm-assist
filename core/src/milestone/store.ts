import * as fs from 'fs';
import * as path from 'path';
import { Milestone, MilestoneIndex } from './types';
import { getMilestoneSettings, isSessionInScanRange } from './settings';
import { getDataDir } from '../utils/path-utils';

const MILESTONES_DIR = path.join(getDataDir(), 'milestones');
const INDEX_FILE = path.join(MILESTONES_DIR, 'index.json');

/**
 * Excluded project paths for milestone processing.
 * Sessions whose cwd or file path matches any excluded pattern are skipped
 * in Phase 1 extraction, Phase 2 enrichment, and real-time re-extraction.
 *
 * Config source: ~/.lm-assist/milestone/settings.json `excludedPaths` field
 *
 * Supports exact match and trailing glob (*) for prefix matching.
 */
function loadExcludedProjects(): string[] {
  try {
    return getMilestoneSettings().excludedPaths;
  } catch {
    return [];
  }
}

/**
 * Check if a project path or session file path should be excluded from milestone processing.
 * Pass cwd (project working directory) or the session file path.
 */
export function isProjectExcluded(projectPathOrCwd: string): boolean {
  const excluded = loadExcludedProjects();
  if (excluded.length === 0) return false;

  for (const pattern of excluded) {
    if (pattern.endsWith('*')) {
      // Prefix match: "/home/ubuntu/test-*" matches "/home/ubuntu/test-project"
      const prefix = pattern.slice(0, -1);
      if (projectPathOrCwd.startsWith(prefix)) return true;
      // Also check project key form (slashes replaced with dashes)
      const prefixKey = prefix.replace(/\//g, '-');
      if (projectPathOrCwd.includes(prefixKey)) return true;
    } else {
      // Exact match on real paths
      if (projectPathOrCwd === pattern) return true;
      // Check project key form in file path: /home/ubuntu/foo → -home-ubuntu-foo
      // Must match at a boundary (followed by / or end) to avoid partial matches
      // e.g. key "-home-ubuntu" should NOT match path containing "-home-ubuntu-tier-agent"
      const patternKey = pattern.replace(/\//g, '-');
      const keyIdx = projectPathOrCwd.indexOf(patternKey);
      if (keyIdx !== -1) {
        const afterKey = projectPathOrCwd[keyIdx + patternKey.length];
        if (afterKey === undefined || afterKey === '/') return true;
      }
    }
  }

  return false;
}

export class MilestoneStore {
  private cache = new Map<string, { milestones: Milestone[]; lastAccessed: number }>();
  private index: MilestoneIndex | null = null;
  private maxCacheSize = 200;

  constructor() {
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(MILESTONES_DIR)) {
      fs.mkdirSync(MILESTONES_DIR, { recursive: true });
    }
  }

  private sessionPath(sessionId: string): string {
    return path.join(MILESTONES_DIR, `${sessionId}.json`);
  }

  private evictIfNeeded(): void {
    if (this.cache.size <= this.maxCacheSize) return;

    // Find least recently accessed entry
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

  getMilestones(sessionId: string): Milestone[] {
    // Check cache first
    const cached = this.cache.get(sessionId);
    if (cached) {
      cached.lastAccessed = Date.now();
      return cached.milestones;
    }

    // Read from disk
    const filePath = this.sessionPath(sessionId);
    if (!fs.existsSync(filePath)) {
      return [];
    }

    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      const milestones: Milestone[] = JSON.parse(data);

      // Add to cache
      this.cache.set(sessionId, { milestones, lastAccessed: Date.now() });
      this.evictIfNeeded();

      return milestones;
    } catch {
      return [];
    }
  }

  saveMilestones(sessionId: string, milestones: Milestone[]): void {
    this.ensureDir();

    const filePath = this.sessionPath(sessionId);

    if (milestones.length === 0) {
      // All milestones deleted — clean up file and cache
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      this.cache.delete(sessionId);
      // Preserve index entry with count=0 to retain lastTurnCount
      // (prevents infinite re-extraction loops for all-thin sessions)
      const existing = this.getIndex().sessions[sessionId];
      if (existing) {
        this.updateIndex(sessionId, 2, 0, 0, 0, existing.lastTurnCount, existing.sessionTimestamp);
      }
      return;
    }

    fs.writeFileSync(filePath, JSON.stringify(milestones, null, 2));

    // Update cache
    this.cache.set(sessionId, { milestones, lastAccessed: Date.now() });
    this.evictIfNeeded();
  }

  removeFromIndex(sessionId: string): void {
    const index = this.getIndex();
    if (sessionId in index.sessions) {
      delete index.sessions[sessionId];
      index.lastUpdated = Date.now();
      this.index = index;
      this.ensureDir();
      fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
    }
  }

  getMilestoneById(id: string): Milestone | null {
    const colonIndex = id.lastIndexOf(':');
    if (colonIndex === -1) return null;

    const sessionId = id.substring(0, colonIndex);
    const index = parseInt(id.substring(colonIndex + 1), 10);
    if (isNaN(index)) return null;

    const milestones = this.getMilestones(sessionId);
    return milestones.find(m => m.index === index) ?? null;
  }

  /** Note: index is cached in memory per-process. Safe for single-process MCP server. */
  getIndex(): MilestoneIndex {
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

    this.index = { sessions: {}, lastUpdated: Date.now() };
    return this.index;
  }

  updateIndex(sessionId: string, phase: 1 | 2, count: number,
              phase1Count?: number, phase2Count?: number, lastTurnCount?: number,
              sessionTimestamp?: number): void {
    const index = this.getIndex();
    const existing = index.sessions[sessionId];
    index.sessions[sessionId] = {
      phase,
      milestoneCount: count,
      phase1Count: phase1Count ?? existing?.phase1Count,
      phase2Count: phase2Count ?? existing?.phase2Count,
      lastTurnCount: lastTurnCount ?? existing?.lastTurnCount,
      lastUpdated: Date.now(),
      sessionTimestamp: sessionTimestamp ?? existing?.sessionTimestamp,
    };
    index.lastUpdated = Date.now();
    this.index = index;

    this.ensureDir();
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  }

  needsReExtraction(sessionId: string, currentTurnCount: number): boolean {
    const entry = this.getIndex().sessions[sessionId];
    if (!entry) return true;
    return currentTurnCount !== (entry.lastTurnCount || 0);
  }

  isSessionIndexed(sessionId: string): boolean {
    const index = this.getIndex();
    return sessionId in index.sessions;
  }

  getSessionPhase(sessionId: string): 1 | 2 | null {
    const index = this.getIndex();
    const entry = index.sessions[sessionId];
    return entry ? entry.phase : null;
  }
}

let instance: MilestoneStore | null = null;
export function getMilestoneStore(): MilestoneStore {
  if (!instance) instance = new MilestoneStore();
  return instance;
}

/**
 * Shared session-change handler for milestone auto-extraction.
 * Used by both REST server and MCP server to avoid logic duplication.
 *
 * On session change: checks if new turns were added, re-extracts milestones
 * (preserving Phase 2 enrichment), updates the index with latest timestamp,
 * and auto-enqueues new Phase 1 milestones for Phase 2 enrichment.
 */
export function handleSessionChangeForMilestones(
  sessionId: string,
  cacheData: {
    numTurns: number;
    cwd?: string;
    filePath?: string;
    responses?: Array<{ turnIndex: number; text: string; isApiError?: boolean }>;
    thinkingBlocks?: Array<{ turnIndex: number; thinking: string }>;
  },
  logPrefix = '[Milestone]'
): void {
  const settings = getMilestoneSettings();

  // Skip subagent sessions — check both content sessionId and filename
  if (sessionId.startsWith('agent-')) return;
  const filename = path.basename(cacheData.filePath || '');
  if (filename.startsWith('agent-')) return;
  // Skip excluded projects
  if (isProjectExcluded(cacheData.cwd || '') || isProjectExcluded(cacheData.filePath || '')) return;

  // Milestone auto-extraction (gated by settings.enabled)
  if (settings.enabled) {
    const store = getMilestoneStore();
    if (store.needsReExtraction(sessionId, cacheData.numTurns)) {
      try {
        const { reextractMilestones } = require('./extractor');
        const existing = store.getMilestones(sessionId);
        const updated = reextractMilestones(cacheData, existing);

        if (updated.length > 0) {
          for (const m of updated) {
            if (m.sessionId !== sessionId) {
              m.sessionId = sessionId;
              m.id = `${sessionId}:${m.index}`;
            }
          }
          store.saveMilestones(sessionId, updated);

          // Async vector indexing for NEW Phase 1 milestones only (fire-and-forget)
          // Phase 2 vectors are handled separately by setOnPhase2Complete callback.
          // Only index milestones with indexes not present in `existing` to prevent
          // duplicate vectors accumulating on every session change.
          const existingIndexes = new Set(existing.map((m: any) => m.index));
          const newPhase1ForVectors = updated.filter(
            (m: any) => m.phase === 1 && !existingIndexes.has(m.index)
          );
          if (newPhase1ForVectors.length > 0) {
            (async () => {
              try {
                const { extractMilestoneVectors } = require('../vector/indexer');
                const { getVectraStore } = require('../vector/vectra-store');
                const vectra = getVectraStore();
                const vectors = newPhase1ForVectors.flatMap((m: any) =>
                  extractMilestoneVectors(m, cacheData.cwd || '', cacheData)
                );
                if (vectors.length > 0) await vectra.addVectors(vectors);
              } catch { /* non-fatal — vectra may not be initialized yet */ }
            })();
          }

          const p1 = updated.filter((m: any) => m.phase === 1).length;
          const p2 = updated.filter((m: any) => m.phase === 2).length;
          const sessionPhase: 1 | 2 = p1 === 0 ? 2 : 1;
          const latestTs = updated.reduce((max: number, m: any) => {
            const ts = Date.parse(m.endTimestamp);
            return (!isNaN(ts) && ts > max) ? ts : max;
          }, 0);
          store.updateIndex(sessionId, sessionPhase, updated.length, p1, p2,
            cacheData.numTurns, latestTs > 0 ? latestTs : undefined);

          console.error(`${logPrefix} Re-extracted milestones for ${sessionId}: ${updated.length} total (${p1} P1, ${p2} P2)`);

          const newPhase1 = updated.filter((m: any) => m.phase === 1);
          if (newPhase1.length > 0 && settings.autoEnrich) {
            // Only auto-enqueue sessions within the configured scan range
            if (latestTs === 0 || isSessionInScanRange(latestTs)) {
              const { getMilestoneSummarizer } = require('./summarizer');
              const summarizer = getMilestoneSummarizer();
              summarizer.enqueueMilestones(newPhase1, cacheData.cwd || '');
            }
          }
        } else {
          store.updateIndex(sessionId, 2, 0, 0, 0, cacheData.numTurns);
        }
      } catch (err) {
        console.error(`${logPrefix} Re-extraction error for ${sessionId}:`, err);
      }
    }
  }

  // Auto knowledge generation from explore agents (independent of milestone enabled)
  // Debounced: schedule a single generation run after a quiet period to avoid
  // spamming "Generation already in progress" errors during bulk milestone scans.
  if (settings.autoKnowledge && cacheData.cwd) {
    scheduleKnowledgeGeneration(cacheData.cwd, logPrefix);
  }
}

// ─── Knowledge generation deduplication ──────────────────────────────────────
// Instead of firing an async generation for every single session change,
// we debounce: accumulate unique cwds and run once after a 2s quiet period.
let _knowledgeGenTimer: ReturnType<typeof setTimeout> | null = null;
const _knowledgeGenPending = new Map<string, string>(); // cwd → logPrefix

function scheduleKnowledgeGeneration(cwd: string, logPrefix: string): void {
  _knowledgeGenPending.set(cwd, logPrefix);

  if (_knowledgeGenTimer) clearTimeout(_knowledgeGenTimer);
  _knowledgeGenTimer = setTimeout(async () => {
    _knowledgeGenTimer = null;
    const pending = new Map(_knowledgeGenPending);
    _knowledgeGenPending.clear();

    for (const [pendingCwd, prefix] of pending) {
      try {
        const { getKnowledgeGenerator } = require('../knowledge/generator');
        const generator = getKnowledgeGenerator();
        if (generator.getStatus().status !== 'idle') {
          // Already running — skip, will be picked up on next trigger
          continue;
        }
        const candidates = await generator.discoverExploreSessions(pendingCwd);
        if (candidates.length > 0) {
          console.log(`${prefix} Auto-generating knowledge for ${candidates.length} explore candidates`);
          await generator.generateAll(pendingCwd);
        }
      } catch (err: any) {
        // Only log if it's not the expected "already in progress" error
        if (!err?.message?.includes('already in progress')) {
          console.warn(`${prefix} Auto knowledge generation error:`, err);
        }
      }
    }
  }, 2000);
}
