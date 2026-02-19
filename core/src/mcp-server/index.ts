/**
 * Session Context MCP Server
 *
 * Provides Claude Code sessions with semantic search over past work
 * and milestone-based navigation.
 *
 * Transport: stdio (spawned by Claude Code as an MCP server)
 *
 * 3 Tools:
 *   search  — Unified search across knowledge, milestones, architecture, file history
 *   detail  — Progressive disclosure for any item by ID
 *   feedback — Context quality feedback on any source
 */

// ─── Stdout Protection ──────────────────────────────────────────────────
// MCP uses stdio (JSON-RPC over stdout). Any console.log from dependencies
// (session-cache, embedder, vector-store, etc.) corrupts the protocol.
// Redirect console.log/warn/info to stderr before any imports run.
console.log = console.error.bind(console);
console.warn = console.error.bind(console);
console.info = console.error.bind(console);

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getSessionCache } from '../session-cache';
import { getVectorStore } from '../vector/vector-store';
import { getEmbedder } from '../vector/embedder';
import { getMilestoneStore, isProjectExcluded } from '../milestone/store';
import type { Milestone } from '../milestone/types';
import { isSessionInScanRange, getMilestoneSettings } from '../milestone/settings';

import { handleSearch, searchToolDef, searchToolDefExperiment } from './tools/search';
import { handleDetail, detailToolDef, detailToolDefExperiment } from './tools/detail';
import { handleFeedback, feedbackToolDef } from './tools/feedback';
import { logToolCall } from './mcp-logger';

// ─── Server Setup ──────────────────────────────────────────────────

const server = new Server(
  {
    name: 'tier-agent-context',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ─── Tool Registration ──────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Use experiment (full) descriptions only when milestone detection is enabled
  const experimentEnabled = getMilestoneSettings().enabled;
  return {
    tools: [
      experimentEnabled ? searchToolDefExperiment : searchToolDef,
      experimentEnabled ? detailToolDefExperiment : detailToolDef,
      feedbackToolDef,
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const t0 = Date.now();

  try {
    let result: { content: Array<{ type: string; text: string }>; isError?: boolean };

    switch (name) {
      case 'search':
        result = await handleSearch(args || {});
        break;
      case 'detail':
        result = await handleDetail(args || {});
        break;
      case 'feedback':
        result = await handleFeedback(args || {});
        break;
      default:
        result = {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    logToolCall(name, (args || {}) as Record<string, unknown>, Date.now() - t0, result);
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const errResult = {
      content: [{ type: 'text', text: `Error: ${msg}` }],
      isError: true as const,
    };
    logToolCall(name, (args || {}) as Record<string, unknown>, Date.now() - t0, errResult);
    return errResult;
  }
});

// ─── Background Initialization ──────────────────────────────────────────────────

async function startBackgroundInit(): Promise<void> {
  try {
    // 1. Initialize session cache (starts background warming)
    console.error('[MCP] Initializing session cache...');
    const cache = getSessionCache();

    // 2. Load embedder model
    console.error('[MCP] Loading embedding model...');
    const embedder = getEmbedder();
    await embedder.load();

    // 3. Initialize vector store
    console.error('[MCP] Initializing vector store...');
    const vectra = getVectorStore();
    await vectra.init();

    // 4. Initialize milestone store
    console.error('[MCP] Initializing milestone store...');
    getMilestoneStore();

    // 5. Wire session cache onChange to milestone re-extraction
    console.error('[MCP] Wiring session change listener...');
    wireSessionChangeListener(cache);

    // 6. Background: index milestones and knowledge (no session vectors)
    console.error('[MCP] Starting background indexing...');
    backgroundIndex().catch(err => {
      console.error('[MCP] Background indexing error:', err);
    });

    console.error('[MCP] Initialization complete');
  } catch (err) {
    console.error('[MCP] Initialization error (non-fatal):', err);
  }
}

function wireSessionChangeListener(cache: ReturnType<typeof getSessionCache>): void {
  const { handleSessionChangeForMilestones } = require('../milestone/store');
  cache.onSessionChange((sessionId: string, cacheData: any) => {
    handleSessionChangeForMilestones(sessionId, cacheData, '[MCP]');
  });
}

async function backgroundIndex(): Promise<void> {
  const { extractMilestoneVectors } = await import('../vector/indexer');
  const { extractMilestones } = await import('../milestone/extractor');
  const { getMilestoneSummarizer } = await import('../milestone/summarizer');
  const { getMilestoneSettings } = await import('../milestone/settings');
  const cache = getSessionCache();
  const vectra = getVectorStore();
  const milestoneStore = getMilestoneStore();
  const settings = getMilestoneSettings();

  // Wait for session cache to have some data
  await new Promise(resolve => setTimeout(resolve, 10_000));

  const sessions = cache.getAllSessionsFromCache();
  console.error(`[MCP] Background indexing ${sessions.length} sessions...`);

  // Collect Phase 1 milestones for Phase 2 enrichment
  const allPhase1Milestones: Array<{ milestones: Milestone[]; projectPath: string }> = [];

  // Milestone extraction — gated by settings.enabled
  if (settings.enabled) {
    // Build a set of already-indexed sessions to avoid redundant processing
    const indexedSessionIds = new Set<string>();
    const milestoneIndex = milestoneStore.getIndex();
    for (const sid of Object.keys(milestoneIndex.sessions)) {
      indexedSessionIds.add(sid);
    }

    let indexed = 0;
    let skipped = 0;
    let milestoned = 0;

    for (const { sessionId, filePath, cacheData } of sessions) {
      try {
        // Skip excluded projects
        if (isProjectExcluded(cacheData.cwd || '') || isProjectExcluded(filePath)) {
          skipped++;
          continue;
        }
        // Skip sessions outside scan range (background indexing respects the limit)
        if (!isSessionInScanRange(cacheData.lastTimestamp || cacheData.fileMtime || 0)) {
          skipped++;
          continue;
        }
        // Skip if already indexed (cheap Set lookup)
        if (indexedSessionIds.has(sessionId)) {
          skipped++;
          continue;
        }

        const projectPath = cacheData.cwd || '';
        indexed++;

        // Extract milestones — normalize sessionId to match the store key (file path based)
        // since cacheData.sessionId may differ from the file path-based sessionId
        const milestones = extractMilestones(cacheData);
        for (const m of milestones) {
          if (m.sessionId !== sessionId) {
            m.sessionId = sessionId;
            m.id = `${sessionId}:${m.index}`;
          }
        }
        if (milestones.length > 0) {
          milestoneStore.saveMilestones(sessionId, milestones);
          milestoneStore.updateIndex(sessionId, 1, milestones.length, milestones.length, 0, cacheData.numTurns);
          milestoned++;
          allPhase1Milestones.push({ milestones, projectPath });
        }
        indexedSessionIds.add(sessionId);

        // Yield to event loop periodically
        if (indexed % 50 === 0) {
          console.error(`[MCP] Indexed ${indexed}/${sessions.length - skipped} new sessions, ${milestoned} milestoned (${skipped} skipped)`);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (err) {
        // Skip individual session errors
      }
    }

    console.error(`[MCP] Background indexing complete: ${indexed} new, ${skipped} skipped, ${milestoned} milestoned`);
  } else {
    console.error(`[MCP] Milestone processing disabled — skipping background extraction`);
  }

  // Index existing knowledge documents into Vectra
  try {
    const { getKnowledgeStore } = await import('../knowledge/store');
    const { extractKnowledgeVectors } = await import('../vector/indexer');
    const knowledgeStore = getKnowledgeStore();
    const knowledgeIds = knowledgeStore.getAllIds();

    if (knowledgeIds.length > 0) {
      let knowledgeIndexed = 0;
      for (const kId of knowledgeIds) {
        const knowledge = knowledgeStore.getKnowledge(kId);
        if (!knowledge) continue;

        // Skip if already indexed
        const hasVectors = await vectra.hasKnowledge(kId);
        if (hasVectors) continue;

        const vectors = extractKnowledgeVectors(knowledge);
        if (vectors.length > 0) {
          await vectra.addVectors(vectors);
          knowledgeIndexed += vectors.length;
        }
      }
      if (knowledgeIndexed > 0) {
        console.error(`[MCP] Indexed ${knowledgeIndexed} knowledge vectors from ${knowledgeIds.length} documents`);
      }
    }
  } catch (err) {
    console.error('[MCP] Knowledge indexing error (non-fatal):', err);
  }

  // Phase 2 enrichment — also gated by settings.enabled
  if (settings.enabled) {
    // Also collect existing Phase 1 milestones from previous runs that never got Phase 2
    // Sort by most recent session first so recent work gets enriched first
    const milestoneIndex = milestoneStore.getIndex();
    const phase1Sessions = Object.entries(milestoneIndex.sessions)
      .filter(([, entry]) => entry.phase === 1)
      .filter(([, entry]) => isSessionInScanRange(entry.lastUpdated))
      .sort((a, b) => (b[1].lastUpdated || 0) - (a[1].lastUpdated || 0));

    for (const [sid] of phase1Sessions) {
      const existing = milestoneStore.getMilestones(sid);
      if (existing.length > 0) {
        const sessionData = sessions.find(s => s.sessionId === sid);
        const projectPath = sessionData?.cacheData?.cwd || '';
        allPhase1Milestones.push({ milestones: existing, projectPath });
      }
    }
  }

  // Enqueue Phase 1 milestones for Phase 2 LLM summarization
  if (settings.enabled && allPhase1Milestones.length > 0) {
    const totalMilestones = allPhase1Milestones.reduce((sum, g) => sum + g.milestones.length, 0);
    console.error(`[MCP] Enqueuing ${totalMilestones} milestones for Phase 2 summarization`);

    const summarizer = getMilestoneSummarizer();

    // Set up Vectra re-embedding after Phase 2 completes
    summarizer.setOnPhase2Complete(async (milestone, projectPath) => {
      const vectors = extractMilestoneVectors(milestone, projectPath);
      if (vectors.length > 0) {
        await vectra.addVectors(vectors);
      }
    });

    // Set up architecture update callback — fires only when ALL processing is truly done
    const { generateArchitectureModel } = await import('../architecture-llm');
    summarizer.setOnPipelineComplete(async (projects) => {
      for (const project of projects) {
        console.error(`[MCP] Triggering delta architecture update for ${project}`);
        try {
          const result = await generateArchitectureModel(project);
          if (result?.skipped) {
            console.error(`[MCP] Architecture update skipped: ${result.reason}`);
          } else if (result?.deltaUpdate) {
            console.error(`[MCP] Architecture model delta-updated for ${project} (${result.milestonesApplied} milestones applied)`);
          } else if (result) {
            console.error(`[MCP] Architecture model fully regenerated for ${project}`);
          }
        } catch (err) {
          console.error(`[MCP] Architecture update failed for ${project}:`, err);
        }
      }
    });

    // Bulk-load all milestones first, then start processing.
    // Using addToQueue (not enqueueMilestones) so the full queue is available
    // for optimal batch formation when processQueue starts.
    for (const { milestones, projectPath } of allPhase1Milestones) {
      summarizer.addToQueue(milestones, projectPath);
    }

    // Start processing with the full queue
    summarizer.processQueue().catch(err => {
      console.error('[MCP] Phase 2 processQueue error:', err);
    });
  }
}

// ─── Main ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start background initialization (non-blocking)
  startBackgroundInit();

  console.error('[MCP] tier-agent-context server started (v2 — search, detail, feedback)');
}

main().catch((err) => {
  console.error('[MCP] Fatal error:', err);
  process.exit(1);
});
