/**
 * Knowledge Scheduler
 *
 * Background timers for automatic knowledge discovery, generation, and remote sync.
 * Reads settings from knowledge/settings.json on each tick so changes take effect immediately.
 *
 * Three scheduled activities:
 *   1. Agent Discovery + Generation — discovers explore-agent candidates, optionally generates.
 *   2. Generic Discovery — discovers generic-content candidates via LLM (costs tokens).
 *   3. Remote Sync — calls sync() when remoteSyncEnabled is true.
 *
 * Singleton via getKnowledgeScheduler().
 */

import { getKnowledgeSettings } from './settings';

// ── Types ──────────────────────────────────────────

interface TimerStatus {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
  lastResult: string | null;
  isRunning: boolean;
}

export interface SchedulerStatus {
  running: boolean;
  agentDiscovery: TimerStatus;
  genericDiscovery: TimerStatus;
  generation: {
    enabled: boolean;
    lastRunAt: string | null;
    lastResult: string | null;
    isRunning: boolean;
  };
  remoteSync: TimerStatus;
}

// ── Scheduler ──────────────────────────────────────────

class KnowledgeScheduler {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private _running = false;

  // Guards
  private agentDiscoveryRunning = false;
  private genericDiscoveryRunning = false;
  private generationRunning = false;
  private syncRunning = false;

  // Status tracking — agent discovery
  private agentDiscoveryLastRunAt: string | null = null;
  private agentDiscoveryLastResult: string | null = null;

  // Status tracking — generic discovery
  private genericDiscoveryLastRunAt: string | null = null;
  private genericDiscoveryLastResult: string | null = null;

  // Status tracking — generation
  private generationLastRunAt: string | null = null;
  private generationLastResult: string | null = null;

  // Status tracking — remote sync
  private syncLastRunAt: string | null = null;
  private syncLastResult: string | null = null;

  start(): void {
    if (this._running) return;
    this._running = true;

    console.log('[Scheduler] Starting knowledge schedulers...');

    // Delay first tick by 30s to let embedder warm up
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      this.runAgentDiscoveryTick();
      this.runGenericDiscoveryTick();
      this.runSyncTick();
      // Check every minute; each tick reads settings to decide whether to run
      this.tickTimer = setInterval(() => {
        this.runAgentDiscoveryTick();
        this.runGenericDiscoveryTick();
      }, 60_000);
      this.syncTimer = setInterval(() => this.runSyncTick(), 60_000);
    }, 30_000);
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;

    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    console.log('[Scheduler] Stopped');
  }

  getStatus(): SchedulerStatus {
    const settings = getKnowledgeSettings();
    return {
      running: this._running,
      agentDiscovery: {
        enabled: settings.discoveryIntervalMinutes > 0,
        intervalMinutes: settings.discoveryIntervalMinutes,
        lastRunAt: this.agentDiscoveryLastRunAt,
        lastResult: this.agentDiscoveryLastResult,
        isRunning: this.agentDiscoveryRunning,
      },
      genericDiscovery: {
        enabled: settings.autoGenericDiscovery,
        intervalMinutes: settings.discoveryIntervalMinutes,
        lastRunAt: this.genericDiscoveryLastRunAt,
        lastResult: this.genericDiscoveryLastResult,
        isRunning: this.genericDiscoveryRunning,
      },
      generation: {
        enabled: settings.autoExploreGeneration,
        lastRunAt: this.generationLastRunAt,
        lastResult: this.generationLastResult,
        isRunning: this.generationRunning,
      },
      remoteSync: {
        enabled: settings.remoteSyncEnabled,
        intervalMinutes: settings.syncIntervalMinutes,
        lastRunAt: this.syncLastRunAt,
        lastResult: this.syncLastResult,
        isRunning: this.syncRunning,
      },
    };
  }

  // ── Agent Discovery + Generation ──────────────────────────────

  private async runAgentDiscoveryTick(): Promise<void> {
    if (!this._running) return;

    const settings = getKnowledgeSettings();
    if (settings.discoveryIntervalMinutes <= 0) return;

    // Check if enough time has passed since last run
    if (this.agentDiscoveryLastRunAt) {
      const elapsed = Date.now() - new Date(this.agentDiscoveryLastRunAt).getTime();
      if (elapsed < settings.discoveryIntervalMinutes * 60_000) return;
    }

    if (this.agentDiscoveryRunning) return;
    this.agentDiscoveryRunning = true;

    try {
      const { getProjectsService } = require('../projects-service');
      const { getKnowledgePipeline } = require('./pipeline');

      const projectsService = getProjectsService();
      const pipeline = getKnowledgePipeline();
      const projects = projectsService.listProjects({ includeSize: false });

      let totalDiscovered = 0;
      for (const project of projects) {
        try {
          const results = await pipeline.discover(project.path, 'explore-agent');
          totalDiscovered += results.length;
        } catch (err: any) {
          console.error(`[Scheduler] Agent discovery error for ${project.path}: ${err.message}`);
        }
      }

      // Check total pending candidates (including previously discovered)
      const { getIdentificationStore } = require('./identification-store');
      const idStore = getIdentificationStore();
      const pendingCandidates = idStore.list({ status: 'candidate', identifierType: 'explore-agent' });

      this.agentDiscoveryLastRunAt = new Date().toISOString();
      this.agentDiscoveryLastResult = `${totalDiscovered} new, ${pendingCandidates.length} pending across ${projects.length} projects`;
      console.log(`[Scheduler] Agent discovery: ${this.agentDiscoveryLastResult}`);

      // Chain generation if enabled and there are pending agent candidates
      if (settings.autoExploreGeneration && pendingCandidates.length > 0) {
        await this.runGeneration(projects, settings.discoveryBatchSize, 'explore-agent');
      }
    } catch (err: any) {
      this.agentDiscoveryLastRunAt = new Date().toISOString();
      this.agentDiscoveryLastResult = `Error: ${err.message}`;
      console.error(`[Scheduler] Agent discovery failed: ${err.message}`);
    } finally {
      this.agentDiscoveryRunning = false;
    }
  }

  private async runGeneration(projects: Array<{ path: string }>, batchSize: number, identifierType: 'explore-agent' | 'generic-content' = 'explore-agent'): Promise<void> {
    if (this.generationRunning) return;

    try {
      const { getKnowledgePipeline } = require('./pipeline');
      const pipeline = getKnowledgePipeline();

      // Only run if pipeline is idle
      const status = pipeline.getStatus();
      if (status.status !== 'idle') return;

      this.generationRunning = true;
      let totalGenerated = 0;
      let totalErrors = 0;
      let remaining = batchSize;

      for (const project of projects) {
        if (remaining <= 0) break;
        try {
          const result = await pipeline.generateAll(project.path, identifierType);
          totalGenerated += result.generated;
          totalErrors += result.errors;
          remaining -= result.generated;
        } catch (err: any) {
          console.error(`[Scheduler] Generation error for ${project.path}: ${err.message}`);
          totalErrors++;
        }
      }

      this.generationLastRunAt = new Date().toISOString();
      this.generationLastResult = `${totalGenerated} generated, ${totalErrors} errors`;
      if (totalGenerated > 0 || totalErrors > 0) {
        console.log(`[Scheduler] Generation: ${this.generationLastResult}`);
      }
    } catch (err: any) {
      this.generationLastRunAt = new Date().toISOString();
      this.generationLastResult = `Error: ${err.message}`;
      console.error(`[Scheduler] Generation failed: ${err.message}`);
    } finally {
      this.generationRunning = false;
    }
  }

  // ── Generic Content Discovery ──────────────────────────────

  private async runGenericDiscoveryTick(): Promise<void> {
    if (!this._running) return;

    const settings = getKnowledgeSettings();
    if (!settings.autoGenericDiscovery) return;
    if (settings.discoveryIntervalMinutes <= 0) return;

    // Check if enough time has passed since last run
    if (this.genericDiscoveryLastRunAt) {
      const elapsed = Date.now() - new Date(this.genericDiscoveryLastRunAt).getTime();
      if (elapsed < settings.discoveryIntervalMinutes * 60_000) return;
    }

    if (this.genericDiscoveryRunning) return;
    this.genericDiscoveryRunning = true;

    try {
      const { getProjectsService } = require('../projects-service');
      const { getKnowledgePipeline } = require('./pipeline');

      const projectsService = getProjectsService();
      const pipeline = getKnowledgePipeline();
      const projects = projectsService.listProjects({ includeSize: false });

      let totalDiscovered = 0;
      for (const project of projects) {
        try {
          const results = await pipeline.discover(project.path, 'generic-content');
          totalDiscovered += results.length;
        } catch (err: any) {
          console.error(`[Scheduler] Generic discovery error for ${project.path}: ${err.message}`);
        }
      }

      const { getIdentificationStore } = require('./identification-store');
      const idStore = getIdentificationStore();
      const pendingCandidates = idStore.list({ status: 'candidate', identifierType: 'generic-content' });

      this.genericDiscoveryLastRunAt = new Date().toISOString();
      this.genericDiscoveryLastResult = `${totalDiscovered} new, ${pendingCandidates.length} pending across ${projects.length} projects`;
      console.log(`[Scheduler] Generic discovery: ${this.genericDiscoveryLastResult}`);

      // Chain generation if enabled and there are pending generic candidates
      if (settings.autoExploreGeneration && pendingCandidates.length > 0) {
        await this.runGeneration(projects, settings.discoveryBatchSize, 'generic-content');
      }
    } catch (err: any) {
      this.genericDiscoveryLastRunAt = new Date().toISOString();
      this.genericDiscoveryLastResult = `Error: ${err.message}`;
      console.error(`[Scheduler] Generic discovery failed: ${err.message}`);
    } finally {
      this.genericDiscoveryRunning = false;
    }
  }

  // ── Remote Sync Timer ──────────────────────────────

  private async runSyncTick(): Promise<void> {
    if (!this._running) return;

    const settings = getKnowledgeSettings();
    if (!settings.remoteSyncEnabled || settings.syncIntervalMinutes <= 0) return;

    // Check if enough time has passed
    if (this.syncLastRunAt) {
      const elapsed = Date.now() - new Date(this.syncLastRunAt).getTime();
      if (elapsed < settings.syncIntervalMinutes * 60_000) return;
    }

    if (this.syncRunning) return;
    this.syncRunning = true;

    try {
      const { sync } = require('./remote-sync');
      await sync();
      this.syncLastRunAt = new Date().toISOString();
      this.syncLastResult = 'Completed';
      console.log('[Scheduler] Remote sync completed');
    } catch (err: any) {
      this.syncLastRunAt = new Date().toISOString();
      this.syncLastResult = `Error: ${err.message}`;
      console.error(`[Scheduler] Remote sync failed: ${err.message}`);
    } finally {
      this.syncRunning = false;
    }
  }
}

// ── Singleton ──────────────────────────────────────────

let instance: KnowledgeScheduler | null = null;

export function getKnowledgeScheduler(): KnowledgeScheduler {
  if (!instance) {
    instance = new KnowledgeScheduler();
  }
  return instance;
}
