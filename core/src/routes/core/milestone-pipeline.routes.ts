/**
 * Milestone Pipeline Routes
 *
 * Status and control endpoints for the Phase 1 → Phase 2 milestone enrichment pipeline.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RouteContext, RouteHandler } from '../index';
import { getMilestoneStore, isProjectExcluded } from '../../milestone/store';
import { getVectorStore } from '../../vector/vector-store';
import { getMilestoneSummarizer } from '../../milestone/summarizer';
import type { Milestone } from '../../milestone/types';
import { isSessionInScanRange, getMilestoneSettings, type Phase2Model } from '../../milestone/settings';
import { getSessionCache } from '../../session-cache';
import { getProjectPathForSession } from '../../search/text-scorer';
import { generateArchitectureModel } from '../../architecture-llm';
import { getDataDir } from '../../utils/path-utils';

const MILESTONES_DIR = path.join(getDataDir(), 'milestones');
const PIPELINE_STATUS_FILE = path.join(MILESTONES_DIR, 'pipeline-status.json');

// One-time flag: recalculate all sessionTimestamp values from earliest→latest semantics
let sessionTimestampMigrated = false;

// ── Verification Types & Helper ──────────────────────────────────

type ProblemType = 'stuck_phase1' | 'incomplete_phase2' | 'bad_data' | 'stale_index';

interface MilestoneProblem {
  milestoneId: string;
  milestoneIndex: number;
  problems: ProblemType[];
}

interface SessionVerification {
  sessionId: string;
  problems: MilestoneProblem[];
  indexStale: boolean;
}

interface VerificationSummary {
  sessionsScanned: number;
  sessionsWithProblems: number;
  problemCounts: Record<ProblemType, number>;
  milestonesByProblem: Record<ProblemType, number>;
}

interface VerificationResult {
  summary: VerificationSummary;
  details: SessionVerification[];
}

/**
 * Scan all sessions and classify milestone problems.
 * Yields every 100 sessions to avoid blocking the event loop.
 */
async function runVerification(filterSessionId?: string): Promise<VerificationResult> {
  const store = getMilestoneStore();
  const index = store.getIndex();

  const sessionIds = filterSessionId
    ? (index.sessions[filterSessionId] ? [filterSessionId] : [])
    : Object.keys(index.sessions);

  const details: SessionVerification[] = [];
  const problemCounts: Record<ProblemType, number> = {
    stuck_phase1: 0,
    incomplete_phase2: 0,
    bad_data: 0,
    stale_index: 0,
  };
  const milestoneCounts: Record<ProblemType, number> = {
    stuck_phase1: 0,
    incomplete_phase2: 0,
    bad_data: 0,
    stale_index: 0,
  };

  let scanned = 0;

  for (const sessionId of sessionIds) {
    const milestones = store.getMilestones(sessionId);
    const indexEntry = index.sessions[sessionId];
    const sessionProblems: MilestoneProblem[] = [];
    let indexStale = false;

    // Check each milestone
    for (const m of milestones) {
      const problems: ProblemType[] = [];

      if (m.phase === 1) {
        problems.push('stuck_phase1');
      } else if (m.phase === 2) {
        // Check for incomplete phase 2
        if (
          m.title === null || m.title === '' ||
          m.description === null || m.description === '' ||
          m.type === null ||
          m.outcome === null || m.outcome === '' ||
          m.facts === null || (Array.isArray(m.facts) && m.facts.length === 0) ||
          m.concepts === null || (Array.isArray(m.concepts) && m.concepts.length === 0)
        ) {
          problems.push('incomplete_phase2');
        }

        // Check for bad data
        if (
          (m.title && /^Milestone #\d+$/.test(m.title)) ||
          (m.title && m.title.length < 5)
        ) {
          problems.push('bad_data');
        }
      }

      if (problems.length > 0) {
        sessionProblems.push({
          milestoneId: m.id,
          milestoneIndex: m.index,
          problems,
        });
      }
    }

    // Check index staleness
    if (indexEntry) {
      const actualP1 = milestones.filter(m => m.phase === 1).length;
      const actualP2 = milestones.filter(m => m.phase === 2).length;
      const actualTotal = milestones.length;

      if (
        indexEntry.milestoneCount !== actualTotal ||
        (indexEntry.phase1Count !== undefined && indexEntry.phase1Count !== actualP1) ||
        (indexEntry.phase2Count !== undefined && indexEntry.phase2Count !== actualP2)
      ) {
        indexStale = true;
      }
    }

    if (sessionProblems.length > 0 || indexStale) {
      details.push({ sessionId, problems: sessionProblems, indexStale });

      // Tally problem types (session-level)
      const sessionProblemTypes = new Set<ProblemType>();
      for (const mp of sessionProblems) {
        for (const p of mp.problems) {
          sessionProblemTypes.add(p);
          milestoneCounts[p]++;
        }
      }
      if (indexStale) {
        sessionProblemTypes.add('stale_index');
        milestoneCounts.stale_index++; // index staleness is per-session
      }
      for (const p of sessionProblemTypes) {
        problemCounts[p]++;
      }
    }

    scanned++;
    if (scanned % 100 === 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  return {
    summary: {
      sessionsScanned: scanned,
      sessionsWithProblems: details.length,
      problemCounts,
      milestonesByProblem: milestoneCounts,
    },
    details,
  };
}

/**
 * Set up the pipeline-complete callback that triggers architecture updates.
 * Idempotent — safe to call multiple times (just replaces the callback).
 */
function setupArchitectureCallback(summarizer: ReturnType<typeof getMilestoneSummarizer>): void {
  summarizer.setOnPipelineComplete(async (projects) => {
    for (const project of projects) {
      console.log(`[MilestonePipeline] Triggering delta architecture update for ${project}`);
      try {
        const result = await generateArchitectureModel(project);
        if (result?.skipped) {
          console.log(`[MilestonePipeline] Architecture update skipped: ${result.reason}`);
        } else if (result?.deltaUpdate) {
          console.log(`[MilestonePipeline] Architecture model delta-updated for ${project} (${result.milestonesApplied} milestones applied)`);
        } else if (result) {
          console.log(`[MilestonePipeline] Architecture model fully regenerated for ${project}`);
        }
      } catch (err) {
        console.error(`[MilestonePipeline] Architecture update failed for ${project}:`, err);
      }
    }
  });
}

export function createMilestonePipelineRoutes(ctx: RouteContext): RouteHandler[] {
  return [
    // GET /milestone-pipeline/status - Pipeline status overview
    {
      method: 'GET',
      pattern: /^\/milestone-pipeline\/status$/,
      handler: async () => {
        const store = getMilestoneStore();
        const index = store.getIndex();
        const settings = getMilestoneSettings();

        // Backfill/migrate sessionTimestamp to use latest milestone endTimestamp.
        // On first call after deploy, recalculates ALL entries (migrates earliest→latest).
        // Subsequent calls only backfill entries with undefined sessionTimestamp.
        let needsIndexWrite = false;
        const migrateAll = !sessionTimestampMigrated;
        for (const [sessionId, entry] of Object.entries(index.sessions)) {
          if (migrateAll || entry.sessionTimestamp === undefined) {
            const milestones = store.getMilestones(sessionId);
            if (milestones.length > 0) {
              const latest = milestones.reduce((max, m) => {
                const ts = Date.parse(m.endTimestamp);
                return (!isNaN(ts) && ts > max) ? ts : max;
              }, 0);
              if (latest > 0 && latest !== entry.sessionTimestamp) {
                entry.sessionTimestamp = latest;
                needsIndexWrite = true;
              }
            }
          }
        }
        sessionTimestampMigrated = true;
        if (needsIndexWrite) {
          // Persist backfilled timestamps
          const idxPath = path.join(getDataDir(), 'milestones', 'index.json');
          try { fs.writeFileSync(idxPath, JSON.stringify(index, null, 2)); } catch { /* non-fatal */ }
        }

        // Count sessions by phase from index (total + in-range)
        let sessionsTotal = 0;
        let sessionsPhase1 = 0;
        let sessionsPhase2 = 0;
        let sessionsInRange = 0;
        let sessionsInRangePhase1 = 0;
        let sessionsInRangePhase2 = 0;

        for (const entry of Object.values(index.sessions)) {
          sessionsTotal++;
          if (entry.phase === 1) sessionsPhase1++;
          else if (entry.phase === 2) sessionsPhase2++;

          // Use sessionTimestamp (actual session date) for scan range, fallback to lastUpdated
          const rangeTs = entry.sessionTimestamp ?? entry.lastUpdated;
          if (isSessionInScanRange(rangeTs)) {
            sessionsInRange++;
            if (entry.phase === 1) sessionsInRangePhase1++;
            else if (entry.phase === 2) sessionsInRangePhase2++;
          }
        }

        // Count individual milestones by phase (total + in-range)
        let milestonesTotal = 0;
        let milestonesPhase1 = 0;
        let milestonesPhase2 = 0;
        let milestonesInRange = 0;
        let milestonesInRangePhase1 = 0;
        let milestonesInRangePhase2 = 0;

        for (const [sessionId, entry] of Object.entries(index.sessions)) {
          const rangeTs = entry.sessionTimestamp ?? entry.lastUpdated;
          const inRange = isSessionInScanRange(rangeTs);
          if (entry.phase1Count !== undefined && entry.phase2Count !== undefined) {
            // Fast path: use cached counts from index
            milestonesTotal += entry.milestoneCount;
            milestonesPhase1 += entry.phase1Count;
            milestonesPhase2 += entry.phase2Count;
            if (inRange) {
              milestonesInRange += entry.milestoneCount;
              milestonesInRangePhase1 += entry.phase1Count;
              milestonesInRangePhase2 += entry.phase2Count;
            }
          } else {
            // Fallback: scan milestone file
            const milestones = store.getMilestones(sessionId);
            for (const m of milestones) {
              milestonesTotal++;
              if (m.phase === 1) milestonesPhase1++;
              else if (m.phase === 2) milestonesPhase2++;
              if (inRange) {
                milestonesInRange++;
                if (m.phase === 1) milestonesInRangePhase1++;
                else if (m.phase === 2) milestonesInRangePhase2++;
              }
            }
          }
        }

        // Get vector stats
        let vectors = { totalVectors: 0, sessionVectors: 0, milestoneVectors: 0, knowledgeVectors: 0, isInitialized: false };
        try {
          const vectraStore = getVectorStore();
          vectors = await vectraStore.getStatsByType();
        } catch {
          // Vectra may not be initialized
        }

        // Read pipeline status file (includes currentBatch, throughput, vector counters)
        let pipeline: Record<string, any> = {
          status: 'idle',
          queueSize: 0,
          processed: 0,
          errors: 0,
          lastProcessedAt: null,
          startedAt: null,
          currentBatch: null,
          throughput: null,
          vectorsIndexed: 0,
          vectorErrors: 0,
          mergesApplied: 0,
          milestonesAbsorbed: 0,
        };
        try {
          if (fs.existsSync(PIPELINE_STATUS_FILE)) {
            const data = fs.readFileSync(PIPELINE_STATUS_FILE, 'utf-8');
            pipeline = { ...pipeline, ...JSON.parse(data) };
          }
        } catch {
          // Use defaults
        }

        // When idle, clear stale counters from previous runs
        if (pipeline.status === 'idle') {
          pipeline.errors = 0;
          pipeline.processed = 0;
          pipeline.vectorErrors = 0;
          pipeline.vectorsIndexed = 0;
          pipeline.currentBatch = null;
        }

        return {
          success: true,
          data: {
            sessions: {
              total: sessionsTotal,
              phase1: sessionsPhase1,
              phase2: sessionsPhase2,
              inRange: sessionsInRange,
              inRangePhase1: sessionsInRangePhase1,
              inRangePhase2: sessionsInRangePhase2,
            },
            milestones: {
              total: milestonesTotal,
              phase1: milestonesPhase1,
              phase2: milestonesPhase2,
              inRange: milestonesInRange,
              inRangePhase1: milestonesInRangePhase1,
              inRangePhase2: milestonesInRangePhase2,
            },
            vectors: {
              total: vectors.totalVectors,
              session: vectors.sessionVectors,
              milestone: vectors.milestoneVectors,
              knowledge: vectors.knowledgeVectors,
              isInitialized: vectors.isInitialized,
            },
            pipeline,
            scanRangeDays: settings.scanRangeDays,
          },
        };
      },
    },

    // POST /milestone-pipeline/start - Start Phase 2 enrichment
    {
      method: 'POST',
      pattern: /^\/milestone-pipeline\/start$/,
      handler: async (req) => {
        const store = getMilestoneStore();
        const index = store.getIndex();
        const summarizer = getMilestoneSummarizer();

        // Set concurrency from request body (default 1)
        const concurrency = req.body?.concurrency;
        if (concurrency && typeof concurrency === 'number' && concurrency > 1) {
          summarizer.setConcurrency(concurrency);
        }

        // Set model override from request body
        const model = req.body?.model as Phase2Model | undefined;
        if (model) {
          summarizer.setModel(model);
        }

        // Collect all Phase 1 milestones, sorted by most recent session first
        const sessionEntries = Object.entries(index.sessions)
          .sort((a, b) => ((b[1].sessionTimestamp || b[1].lastUpdated || 0) - (a[1].sessionTimestamp || a[1].lastUpdated || 0)));

        // Build session → project path mapping from session cache
        const sessionCache = getSessionCache();
        const allSessions = sessionCache.getAllSessionsFromCache();
        const sessionProjectMap = new Map<string, string>();
        for (const { sessionId: sid, filePath, cacheData } of allSessions) {
          const project = cacheData.cwd || getProjectPathForSession(cacheData, filePath);
          if (project) sessionProjectMap.set(sid, project);
        }

        const toEnqueue: Array<{ milestones: Milestone[]; projectPath: string }> = [];

        for (const [sessionId, entry] of sessionEntries) {
          // Skip excluded projects
          if (isProjectExcluded(sessionId)) continue;
          // Skip sessions outside scan range (use actual session timestamp)
          if (!isSessionInScanRange(entry.sessionTimestamp ?? entry.lastUpdated)) continue;

          const milestones = store.getMilestones(sessionId);
          const phase1 = milestones.filter(m => m.phase === 1);
          if (phase1.length > 0) {
            // Normalize sessionId on milestone objects to match the store key.
            // Some milestones have a different sessionId (from cacheData.sessionId) than
            // the store key (from the file path). The queue uses m.sessionId, so it must
            // match the store key for takeBatch lookups to work.
            for (const m of phase1) {
              if (m.sessionId !== sessionId) {
                m.sessionId = sessionId;
                m.id = `${sessionId}:${m.index}`;
              }
            }
            const projectPath = sessionProjectMap.get(sessionId) || '';
            toEnqueue.push({ milestones: phase1, projectPath });
          }
        }

        if (toEnqueue.length === 0) {
          return {
            success: true,
            data: { message: 'No Phase 1 milestones to process', enqueued: 0 },
          };
        }

        const totalMilestones = toEnqueue.reduce((sum, g) => sum + g.milestones.length, 0);

        // Set up Vectra embedding callback for after Phase 2 completes
        try {
          const { extractMilestoneVectors } = await import('../../vector/indexer');
          const vectra = getVectorStore();
          await vectra.init();

          summarizer.setOnPhase2Complete(async (milestone, projectPath) => {
            // Delete stale Phase 1 vectors before inserting Phase 2 enriched vectors
            await vectra.deleteMilestone(milestone.sessionId, milestone.index);
            const vectors = extractMilestoneVectors(milestone, projectPath);
            if (vectors.length > 0) {
              await vectra.addVectors(vectors);
            }
          });
        } catch (err) {
          // Vectra embedding is optional; Phase 2 summarization still works without it
          console.error('[MilestonePipeline] Vectra setup failed (embedding disabled):', err);
        }

        // Set up architecture update callback — fires only when ALL processing is truly done
        // (queue empty, no debounce timer pending). This prevents mass architecture updates
        // during catch-up; they trigger once after all Phase 2 enrichment completes.
        setupArchitectureCallback(summarizer);

        // Add all milestones to queue first (without triggering processing)
        for (const { milestones, projectPath } of toEnqueue) {
          summarizer.addToQueue(milestones, projectPath);
        }

        // Start processing with the full queue available for concurrent batching
        summarizer.processQueue().catch((err) => {
          console.error('[MilestonePipeline] processQueue error:', err);
        });

        return {
          success: true,
          data: {
            message: `Phase 2 enrichment started`,
            enqueued: totalMilestones,
            sessions: toEnqueue.length,
          },
        };
      },
    },

    // POST /milestone-pipeline/extract - Run Phase 1 heuristic extraction for unprocessed sessions
    // Also re-extracts already-indexed sessions that have grown (new turns since last extraction)
    // Body: { force?: boolean }  force=true re-extracts ALL in-range sessions (resets phase1, keeps phase2)
    {
      method: 'POST',
      pattern: /^\/milestone-pipeline\/extract$/,
      handler: async (req) => {
        const { extractMilestones, reextractMilestones } = await import('../../milestone/extractor');
        const { getSessionCache } = await import('../../session-cache');
        const cache = getSessionCache();
        const store = getMilestoneStore();
        const force: boolean = req.body?.force === true;

        const sessions = cache.getAllSessionsFromCache();
        let extracted = 0;
        let reextracted = 0;
        let skipped = 0;
        let totalMilestones = 0;

        for (const { sessionId, filePath, cacheData } of sessions) {
          if (cacheData.numTurns === 0) {
            skipped++;
            continue;
          }
          // Skip excluded projects
          if (isProjectExcluded(cacheData.cwd || '') || isProjectExcluded(filePath)) {
            skipped++;
            continue;
          }
          const isIndexed = store.isSessionIndexed(sessionId);
          const needsReExtract = isIndexed && store.needsReExtraction(sessionId, cacheData.numTurns);

          // Skip sessions outside scan range — but always allow re-extraction
          // for indexed sessions with turn count mismatch (stale data fix)
          if (!force && !needsReExtract && !isSessionInScanRange(cacheData.lastTimestamp || cacheData.fileMtime || 0)) {
            skipped++;
            continue;
          }

          // Skip if already indexed and no turn count change (unless force)
          if (!force && isIndexed && !needsReExtract) {
            skipped++;
            continue;
          }

          try {
            let milestones: Milestone[];

            if (isIndexed) {
              // Re-extract: preserve existing Phase 2 enrichment for unchanged segments
              const existing = store.getMilestones(sessionId);
              milestones = reextractMilestones(cacheData, existing);
            } else {
              // Fresh extraction
              milestones = extractMilestones(cacheData);
            }

            // Normalize sessionId to match store key (file path based)
            for (const m of milestones) {
              if (m.sessionId !== sessionId) {
                m.sessionId = sessionId;
                m.id = `${sessionId}:${m.index}`;
              }
            }
            if (milestones.length > 0) {
              store.saveMilestones(sessionId, milestones);
              const p1 = milestones.filter(m => m.phase === 1).length;
              const p2 = milestones.filter(m => m.phase === 2).length;
              const sessionPhase: 1 | 2 = p1 > 0 ? 1 : 2;
              // Store latest milestone endTimestamp for scan range
              const latestTs = milestones.reduce((max, m) => {
                const ts = Date.parse(m.endTimestamp);
                return (!isNaN(ts) && ts > max) ? ts : max;
              }, 0);
              store.updateIndex(sessionId, sessionPhase, milestones.length, p1, p2,
                cacheData.numTurns, latestTs > 0 ? latestTs : undefined);
              totalMilestones += milestones.length;
              if (isIndexed) {
                reextracted++;
              } else {
                extracted++;
              }
            }
          } catch {
            // Skip individual session errors
          }

          // Yield to event loop periodically
          if ((extracted + reextracted + skipped) % 100 === 0) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }

        return {
          success: true,
          data: {
            message: `Phase 1 extraction complete`,
            sessionsProcessed: extracted,
            sessionsReextracted: reextracted,
            sessionsSkipped: skipped,
            milestonesExtracted: totalMilestones,
          },
        };
      },
    },

    // POST /milestone-pipeline/stop - Stop Phase 2 enrichment gracefully
    {
      method: 'POST',
      pattern: /^\/milestone-pipeline\/stop$/,
      handler: async () => {
        const summarizer = getMilestoneSummarizer();

        if (!summarizer.isProcessing()) {
          return {
            success: true,
            data: { message: 'Pipeline is not running', stopped: false },
          };
        }

        const result = summarizer.stop();

        return {
          success: true,
          data: {
            message: 'Stop requested, will halt after current batch completes',
            stopped: result.stopped,
            remaining: result.remaining,
          },
        };
      },
    },

    // GET /milestone-pipeline/verify - Verify milestone data quality
    {
      method: 'GET',
      pattern: /^\/milestone-pipeline\/verify/,
      handler: async (req) => {
        const detail = req.query.detail === 'true';
        const sessionId = req.query.sessionId || undefined;

        const result = await runVerification(sessionId);

        return {
          success: true,
          data: {
            summary: result.summary,
            ...(detail ? { details: result.details } : {}),
          },
        };
      },
    },

    // POST /milestone-pipeline/reprocess - Reset and re-queue problematic milestones
    {
      method: 'POST',
      pattern: /^\/milestone-pipeline\/reprocess$/,
      handler: async (req) => {
        const summarizer = getMilestoneSummarizer();

        if (summarizer.isProcessing()) {
          return {
            success: false,
            error: 'Pipeline is currently running. Stop it first with POST /milestone-pipeline/stop',
          };
        }

        const body = req.body || {};
        const mode: string = body.mode || 'all';
        const sessionIds: string[] | undefined = body.sessionIds;
        const milestoneIds: string[] | undefined = body.milestoneIds;
        const problemTypes: ProblemType[] | undefined = body.problemTypes;
        const concurrency: number | undefined = body.concurrency;
        const model = body.model as Phase2Model | undefined;
        const resetBadPhase2: boolean = body.resetBadPhase2 !== false; // default true
        const fixIndex: boolean = body.fixIndex !== false; // default true

        if (concurrency && typeof concurrency === 'number' && concurrency > 1) {
          summarizer.setConcurrency(concurrency);
        }
        if (model) {
          summarizer.setModel(model);
        }

        const store = getMilestoneStore();

        // Build session → project path mapping from session cache
        const sessionCache = getSessionCache();
        const allCachedSessions = sessionCache.getAllSessionsFromCache();
        const sessionProjectMap = new Map<string, string>();
        for (const { sessionId: sid, filePath, cacheData } of allCachedSessions) {
          const project = cacheData.cwd || getProjectPathForSession(cacheData, filePath);
          if (project) sessionProjectMap.set(sid, project);
        }

        // Determine which sessions to scan
        let targetSessionIds: string[];
        if (mode === 'sessions' && sessionIds && sessionIds.length > 0) {
          targetSessionIds = sessionIds;
        } else if (mode === 'milestones' && milestoneIds && milestoneIds.length > 0) {
          // Extract unique session IDs from milestone IDs (format: sessionId:index)
          const sessionSet = new Set<string>();
          for (const mid of milestoneIds) {
            const colonIdx = mid.lastIndexOf(':');
            if (colonIdx > 0) sessionSet.add(mid.substring(0, colonIdx));
          }
          targetSessionIds = [...sessionSet];
        } else {
          // mode === 'all': scan everything
          targetSessionIds = Object.keys(store.getIndex().sessions);
        }

        // Build set of targeted milestone IDs for 'milestones' mode filtering
        const milestoneIdSet = mode === 'milestones' && milestoneIds
          ? new Set(milestoneIds)
          : null;

        let enqueued = 0;
        let sessionsAffected = 0;
        let indexFixed = 0;
        let phase2Reset = 0;

        const toEnqueue: Array<{ milestones: Milestone[]; projectPath: string }> = [];

        let scanned = 0;
        for (const sessionId of targetSessionIds) {
          // Skip excluded projects
          if (isProjectExcluded(sessionId)) {
            scanned++;
            continue;
          }

          const milestones = store.getMilestones(sessionId);
          if (milestones.length === 0) {
            scanned++;
            continue;
          }

          let sessionModified = false;
          const phase1Milestones: Milestone[] = [];

          for (const m of milestones) {
            // If filtering by specific milestone IDs, skip non-matching
            if (milestoneIdSet && !milestoneIdSet.has(m.id)) continue;

            // Classify problems for this milestone
            const problems: ProblemType[] = [];
            if (m.phase === 1) {
              problems.push('stuck_phase1');
            } else if (m.phase === 2 && resetBadPhase2) {
              const isIncomplete =
                m.title === null || m.title === '' ||
                m.description === null || m.description === '' ||
                m.type === null ||
                m.outcome === null || m.outcome === '' ||
                m.facts === null || (Array.isArray(m.facts) && m.facts.length === 0) ||
                m.concepts === null || (Array.isArray(m.concepts) && m.concepts.length === 0);

              const isBadData =
                (m.title && /^Milestone #\d+$/.test(m.title)) ||
                (m.title && m.title.length > 0 && m.title.length < 5);

              if (isIncomplete) problems.push('incomplete_phase2');
              if (isBadData) problems.push('bad_data');
            }

            // Apply problem type filter if specified
            if (problemTypes && problemTypes.length > 0) {
              if (!problems.some(p => problemTypes.includes(p))) continue;
            }

            if (problems.length === 0) continue;

            // For phase 2 milestones with problems, reset to phase 1
            if (m.phase === 2 && (problems.includes('incomplete_phase2') || problems.includes('bad_data'))) {
              m.title = null;
              m.description = null;
              m.type = null;
              m.outcome = null;
              m.facts = null;
              m.concepts = null;
              m.architectureRelevant = null;
              m.phase = 1;
              m.generatedAt = null;
              m.modelUsed = null;
              sessionModified = true;
              phase2Reset++;

              // Delete stale vectors for this milestone
              try {
                const vectra = getVectorStore();
                await vectra.deleteMilestone(sessionId, m.index);
              } catch {
                // Vectra may not be initialized
              }
            }

            // Collect phase 1 milestones for re-queuing
            if (m.phase === 1) {
              // Normalize sessionId
              if (m.sessionId !== sessionId) {
                m.sessionId = sessionId;
                m.id = `${sessionId}:${m.index}`;
              }
              phase1Milestones.push(m);
            }
          }

          // Save modified milestones back to disk
          if (sessionModified) {
            store.saveMilestones(sessionId, milestones);
          }

          // Fix index if requested
          if (fixIndex) {
            const indexEntry = store.getIndex().sessions[sessionId];
            if (indexEntry) {
              const actualP1 = milestones.filter(m => m.phase === 1).length;
              const actualP2 = milestones.filter(m => m.phase === 2).length;
              const actualTotal = milestones.length;

              if (
                indexEntry.milestoneCount !== actualTotal ||
                (indexEntry.phase1Count !== undefined && indexEntry.phase1Count !== actualP1) ||
                (indexEntry.phase2Count !== undefined && indexEntry.phase2Count !== actualP2)
              ) {
                const sessionPhase: 1 | 2 = actualP1 === 0 ? 2 : 1;
                store.updateIndex(sessionId, sessionPhase, actualTotal, actualP1, actualP2);
                indexFixed++;
              }
            }
          }

          if (phase1Milestones.length > 0) {
            const projectPath = sessionProjectMap.get(sessionId) || '';
            toEnqueue.push({ milestones: phase1Milestones, projectPath });
            enqueued += phase1Milestones.length;
            sessionsAffected++;
          }

          scanned++;
          if (scanned % 100 === 0) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }

        // Enqueue and start processing (same pattern as /start)
        if (toEnqueue.length > 0) {
          // Set up Vectra embedding callback
          try {
            const { extractMilestoneVectors } = await import('../../vector/indexer');
            const vectra = getVectorStore();
            await vectra.init();

            summarizer.setOnPhase2Complete(async (milestone, projectPath) => {
              // Delete stale Phase 1 vectors before inserting Phase 2 enriched vectors
              await vectra.deleteMilestone(milestone.sessionId, milestone.index);
              const vectors = extractMilestoneVectors(milestone, projectPath);
              if (vectors.length > 0) {
                await vectra.addVectors(vectors);
              }
            });
          } catch (err) {
            console.error('[MilestonePipeline] Vectra setup failed (embedding disabled):', err);
          }

          // Set up architecture update callback (fires after all processing completes)
          setupArchitectureCallback(summarizer);

          for (const { milestones, projectPath } of toEnqueue) {
            summarizer.addToQueue(milestones, projectPath);
          }

          summarizer.processQueue().catch((err) => {
            console.error('[MilestonePipeline] reprocess processQueue error:', err);
          });
        }

        return {
          success: true,
          data: {
            message: enqueued > 0
              ? `Reprocessing started: ${enqueued} milestones across ${sessionsAffected} sessions`
              : 'No milestones matched the reprocessing criteria',
            enqueued,
            sessionsAffected,
            indexFixed,
            phase2Reset,
          },
        };
      },
    },

    // POST /milestone-pipeline/enrich-phase1 - Heuristic Phase 1 enrichment (no LLM)
    // Derives title, description, type, facts from raw session data and saves to disk.
    // Milestones stay at phase=1 so Phase 2 LLM enrichment can still run later.
    // Body: { inRangeOnly?: boolean, force?: boolean }
    //   inRangeOnly: true (default) — only in-range sessions
    //   force: false (default) — re-enrich all phase=1 milestones, even those already enriched
    {
      method: 'POST',
      pattern: /^\/milestone-pipeline\/enrich-phase1$/,
      handler: async (req) => {
        const { enrichPhase1, needsPhase1Enrichment } = await import('../../milestone/phase1-enricher');
        const { extractMilestoneVectors } = await import('../../vector/indexer');
        const store = getMilestoneStore();
        const index = store.getIndex();
        const settings = getMilestoneSettings();
        const inRangeOnly: boolean = req.body?.inRangeOnly !== false; // default true
        const force: boolean = req.body?.force === true; // default false

        const vectorStore = getVectorStore();
        let vectorsReady = false;
        try {
          await vectorStore.init();
          vectorsReady = true;
        } catch { /* vector indexing optional */ }

        const sessionIds = Object.keys(index.sessions);
        let milestonesEnriched = 0;
        let milestonesSkipped = 0;
        let vectorsIndexed = 0;
        let sessionsAffected = 0;

        for (const sessionId of sessionIds) {
          if (isProjectExcluded(sessionId)) continue;

          const entry = index.sessions[sessionId];
          if (inRangeOnly && !isSessionInScanRange(entry.sessionTimestamp ?? entry.lastUpdated)) continue;

          // Fast path: skip sessions with no Phase 1 milestones
          if (entry.phase1Count === 0) continue;

          const milestones = store.getMilestones(sessionId);
          // force=true: re-enrich all phase=1 milestones (including those already heuristically enriched)
          const toEnrich = force
            ? milestones.filter(m => m.phase === 1)
            : milestones.filter(needsPhase1Enrichment);
          if (toEnrich.length === 0) {
            milestonesSkipped += milestones.filter(m => m.phase === 1).length;
            continue;
          }

          let sessionModified = false;
          const newVectors: Array<{ text: string; metadata: any }> = [];

          for (const m of toEnrich) {
            const enriched = enrichPhase1(m);
            m.title = enriched.title;
            m.description = enriched.description;
            m.type = enriched.type;
            m.facts = enriched.facts;
            // Leave phase=1, outcome=null, concepts=null, architectureRelevant=null
            // so Phase 2 LLM enrichment can still complete these fields
            sessionModified = true;
            milestonesEnriched++;

            if (vectorsReady) {
              newVectors.push(...extractMilestoneVectors(m));
            }
          }

          if (sessionModified) {
            store.saveMilestones(sessionId, milestones);
            sessionsAffected++;

            if (vectorsReady && newVectors.length > 0) {
              try {
                // Delete stale vectors (summary/assistant/thinking) before inserting
                // new enriched vectors (title/description/fact/prompt) to avoid bloat
                for (const m of toEnrich) {
                  await vectorStore.deleteMilestone(sessionId, m.index);
                }
                await vectorStore.addVectors(newVectors);
                vectorsIndexed += newVectors.length;
              } catch { /* non-fatal */ }
            }
          }

          // Yield to event loop every 50 sessions
          if (sessionsAffected % 50 === 0) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }

        return {
          success: true,
          data: {
            message: milestonesEnriched > 0
              ? `Phase 1 enrichment complete: ${milestonesEnriched} milestones enriched across ${sessionsAffected} sessions`
              : 'No unenriched Phase 1 milestones found',
            milestonesEnriched,
            milestonesSkipped,
            sessionsAffected,
            vectorsIndexed,
            inRangeOnly,
            scanRangeDays: settings.scanRangeDays,
          },
        };
      },
    },

    // POST /milestone-pipeline/fix-index - Fix stale index entries without reprocessing
    {
      method: 'POST',
      pattern: /^\/milestone-pipeline\/fix-index$/,
      handler: async () => {
        const store = getMilestoneStore();
        const index = store.getIndex();
        const sessionIds = Object.keys(index.sessions);

        let sessionsScanned = 0;
        let indexEntriesFixed = 0;

        for (const sessionId of sessionIds) {
          const milestones = store.getMilestones(sessionId);
          const indexEntry = index.sessions[sessionId];

          const actualP1 = milestones.filter(m => m.phase === 1).length;
          const actualP2 = milestones.filter(m => m.phase === 2).length;
          const actualTotal = milestones.length;
          const correctPhase: 1 | 2 = actualP1 === 0 ? 2 : 1;

          const needsFix =
            indexEntry.milestoneCount !== actualTotal ||
            indexEntry.phase !== correctPhase ||
            (indexEntry.phase1Count !== undefined && indexEntry.phase1Count !== actualP1) ||
            (indexEntry.phase2Count !== undefined && indexEntry.phase2Count !== actualP2);

          if (needsFix) {
            store.updateIndex(sessionId, correctPhase, actualTotal, actualP1, actualP2);
            indexEntriesFixed++;
          }

          sessionsScanned++;
          if (sessionsScanned % 100 === 0) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }

        return {
          success: true,
          data: {
            message: indexEntriesFixed > 0
              ? `Fixed ${indexEntriesFixed} stale index entries`
              : 'All index entries are accurate',
            sessionsScanned,
            indexEntriesFixed,
          },
        };
      },
    },
  ];
}
