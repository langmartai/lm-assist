/**
 * Remote Knowledge Sync Service
 *
 * Fetches knowledge from remote machines connected via Hub that share
 * the same git repository. Stores as .md files with origin metadata
 * and indexes into the local vector DB.
 *
 * Design principles:
 * - No-delete: remote knowledge flagged stale, never deleted automatically
 * - No-loop: always fetches with ?origin=local to avoid syncing back re-synced content
 * - Non-blocking: sync runs in background, status polled by UI
 */

import { getHubConfig, isHubConfigured } from '../hub-client/hub-config';
import { getKnowledgeStore } from './store';
import { getKnowledgeSettings, saveKnowledgeSettings } from './settings';
import type { Knowledge, KnowledgeType } from './types';
import { KNOWLEDGE_TYPES } from './types';

// ── Types ──────────────────────────────────────────

export interface SyncStatus {
  status: 'idle' | 'running' | 'done' | 'error';
  machinesChecked: number;
  machinesMatched: number;
  entriesSynced: number;
  entriesSkipped: number;
  entriesFlaggedStale: number;
  errors: string[];
  startedAt: string | null;
  completedAt: string | null;
}

// ── Status Tracker ──────────────────────────────────────────

let _syncStatus: SyncStatus = {
  status: 'idle',
  machinesChecked: 0,
  machinesMatched: 0,
  entriesSynced: 0,
  entriesSkipped: 0,
  entriesFlaggedStale: 0,
  errors: [],
  startedAt: null,
  completedAt: null,
};

export function getSyncStatus(): SyncStatus {
  return { ..._syncStatus, errors: [..._syncStatus.errors] };
}

function resetStatus(): void {
  _syncStatus = {
    status: 'running',
    machinesChecked: 0,
    machinesMatched: 0,
    entriesSynced: 0,
    entriesSkipped: 0,
    entriesFlaggedStale: 0,
    errors: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
}

// ── Git URL Normalization ──────────────────────────────────────────

/**
 * Normalize a git remote URL for comparison.
 * git@github.com:org/repo.git → github.com/org/repo
 * https://github.com/org/repo.git → github.com/org/repo
 */
function normalizeGitUrl(url: string): string {
  let normalized = url.trim();

  // SSH format: git@github.com:org/repo.git → github.com/org/repo
  const sshMatch = normalized.match(/^(?:ssh:\/\/)?(?:[^@]+@)?([^:/]+)[:/](.+)$/);
  if (sshMatch) {
    normalized = `${sshMatch[1]}/${sshMatch[2]}`;
  }

  // HTTPS format: https://github.com/org/repo.git → github.com/org/repo
  try {
    const parsed = new URL(normalized);
    normalized = `${parsed.hostname}${parsed.pathname}`;
  } catch {
    // Not a valid URL, use as-is after SSH normalization
  }

  // Strip trailing .git
  normalized = normalized.replace(/\.git$/, '');
  // Strip trailing slash
  normalized = normalized.replace(/\/$/, '');
  // Lowercase for comparison
  return normalized.toLowerCase();
}

// ── Hub HTTP Helper ──────────────────────────────────────────

function getHubHttpUrl(): string {
  const config = getHubConfig();
  return (config.hubUrl || '')
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:');
}

async function hubFetch(path: string): Promise<any> {
  const config = getHubConfig();
  const hubHttpUrl = getHubHttpUrl();

  const res = await fetch(`${hubHttpUrl}${path}`, {
    headers: { 'Authorization': `Bearer ${config.apiKey}` },
  });

  if (!res.ok) {
    throw new Error(`Hub returned ${res.status} for ${path}`);
  }

  return res.json();
}

/**
 * Make a proxied request to a remote machine's local API via the hub.
 * Uses the hub's API relay proxy endpoint.
 */
async function proxyFetch(machineId: string, path: string): Promise<any> {
  const config = getHubConfig();
  const hubHttpUrl = getHubHttpUrl();

  // Use the hub's proxy endpoint to reach the remote machine
  const res = await fetch(`${hubHttpUrl}/api/tier-agent/machines/${machineId}/proxy${path}`, {
    headers: { 'Authorization': `Bearer ${config.apiKey}` },
  });

  if (!res.ok) {
    throw new Error(`Proxy request to ${machineId}${path} returned ${res.status}`);
  }

  return res.json();
}

// ── Sync Implementation ──────────────────────────────────────────

/**
 * Run the remote knowledge sync.
 * This is called from the route handler and runs in a fire-and-forget async IIFE.
 */
export async function sync(projectPath?: string): Promise<void> {
  if (_syncStatus.status === 'running') {
    throw new Error('Sync already in progress');
  }

  resetStatus();

  try {
    // 1. Check prerequisites
    if (!isHubConfigured()) {
      throw new Error('Hub not configured');
    }

    const { getHubClient } = require('../hub-client/index');
    const hubClient = getHubClient();
    const hubStatus = hubClient.getStatus();
    if (!hubStatus.connected) {
      throw new Error('Hub not connected');
    }

    // 2. Get local git remote URL for project matching
    const { createProjectsService } = require('../projects-service');
    const projectsService = createProjectsService();
    const effectivePath = projectPath || process.cwd();

    const gitInfo = projectsService.getGitInfo(effectivePath);
    if (!gitInfo || !gitInfo.remotes || gitInfo.remotes.length === 0) {
      throw new Error('No git remotes found for project');
    }

    const localRemotes = gitInfo.remotes
      .filter((r: any) => r.type === 'fetch')
      .map((r: any) => normalizeGitUrl(r.url));

    if (localRemotes.length === 0) {
      throw new Error('No fetch remotes found');
    }

    // 3. Discover remote machines
    const machinesJson = await hubFetch('/api/tier-agent/machines');
    const machines: any[] = Array.isArray(machinesJson) ? machinesJson : machinesJson.machines || machinesJson.data || [];

    const hubConfig = getHubConfig();
    const localMachineId = hubConfig.machineId || '';
    const localGatewayId = hubConfig.gatewayId || '';

    // 4. For each remote machine, find matching projects and sync knowledge
    for (const machine of machines) {
      const remoteMachineId = machine.machineId || machine.gatewayId || machine.id;
      if (!remoteMachineId || typeof remoteMachineId !== 'string') continue;

      // Skip self — compare against both machineId and gatewayId
      if ((localMachineId && remoteMachineId === localMachineId) ||
          (localGatewayId && remoteMachineId === localGatewayId)) continue;

      _syncStatus.machinesChecked++;

      try {
        // Get remote machine's projects
        let remoteProjects: any[];
        try {
          const projJson = await proxyFetch(remoteMachineId, '/projects');
          const projData = projJson.data?.projects || projJson.data || projJson;
          remoteProjects = Array.isArray(projData) ? projData : [];
        } catch (err: any) {
          _syncStatus.errors.push(`${remoteMachineId}: Failed to get projects: ${err.message}`);
          continue;
        }

        // Find projects with matching git remote
        let matchedProjectPath: string | null = null;
        for (const rp of remoteProjects) {
          const rpGit = rp.git;
          if (!rpGit || !rpGit.remotes) continue;
          const rpRemotes = rpGit.remotes
            .filter((r: any) => r.type === 'fetch')
            .map((r: any) => normalizeGitUrl(r.url));

          for (const rpRemote of rpRemotes) {
            if (localRemotes.includes(rpRemote)) {
              matchedProjectPath = rp.path;
              break;
            }
          }
          if (matchedProjectPath) break;
        }

        if (!matchedProjectPath) continue;
        _syncStatus.machinesMatched++;

        // Fetch knowledge from remote machine — only local origin to prevent sync loops
        let remoteKnowledge: any[];
        try {
          const knJson = await proxyFetch(
            remoteMachineId,
            `/knowledge?origin=local&status=active`
          );
          const knData = knJson.data || knJson;
          remoteKnowledge = Array.isArray(knData) ? knData : [];
        } catch (err: any) {
          _syncStatus.errors.push(`${remoteMachineId}: Failed to get knowledge: ${err.message}`);
          continue;
        }

        // Sync each knowledge entry
        const store = getKnowledgeStore();
        const remoteHostname = machine.hostname || machine.machineHostname || '';
        const remoteOS = machine.platform || machine.machineOS || machine.os || '';
        const remoteKnowledgeIds = new Set<string>();

        for (const rk of remoteKnowledge) {
          const knowledgeId = rk.id;
          if (!knowledgeId) continue;
          remoteKnowledgeIds.add(knowledgeId);

          // Check if already synced
          const existing = store.findRemoteKnowledge(remoteMachineId, knowledgeId);

          if (existing) {
            // Compare updatedAt — if remote is newer, update
            if (rk.updatedAt && existing.updatedAt && rk.updatedAt > existing.updatedAt) {
              // Delete old vectors, will re-index below
              try {
                const { getVectorStore } = require('../vector/vector-store');
                const vectra = getVectorStore();
                await vectra.deleteRemoteKnowledgeVectors(remoteMachineId, knowledgeId);
              } catch { /* best-effort */ }

              // Update the stored file
              store.deleteRemoteKnowledge(remoteMachineId, knowledgeId);
              // Fall through to create below
            } else {
              _syncStatus.entriesSkipped++;
              continue;
            }
          }

          // Fetch full knowledge entry with content
          let fullEntry: any;
          try {
            const fullJson = await proxyFetch(remoteMachineId, `/knowledge/${knowledgeId}`);
            fullEntry = fullJson.data || fullJson;
          } catch (err: any) {
            _syncStatus.errors.push(`${remoteMachineId}:${knowledgeId}: Failed to fetch full entry: ${err.message}`);
            continue;
          }

          // Create remote knowledge entry
          try {
            const parts = (fullEntry.parts || rk.parts || []).map((p: any, i: number) => ({
              partId: p.partId || `${knowledgeId}.${i + 1}`,
              title: p.title || '',
              summary: p.summary || '',
              content: p.content || '',
            }));

            const created = store.createKnowledge({
              id: knowledgeId,
              title: rk.title || 'Untitled',
              type: (KNOWLEDGE_TYPES.includes(rk.type) ? rk.type : 'algorithm') as KnowledgeType,
              project: effectivePath, // Map to local project path
              parts,
              status: rk.status || 'active',
              sourceSessionId: rk.sourceSessionId,
              sourceAgentId: rk.sourceAgentId,
              sourceTimestamp: rk.sourceTimestamp,
              origin: 'remote',
              machineId: remoteMachineId,
              machineHostname: remoteHostname,
              machineOS: remoteOS,
              createdAt: rk.createdAt,
              updatedAt: rk.updatedAt,
            });

            // Index vectors
            try {
              const { getVectorStore } = require('../vector/vector-store');
              const { extractKnowledgeVectors } = require('../vector/indexer');
              const vectra = getVectorStore();
              const vectors = extractKnowledgeVectors(created, effectivePath, {
                machineId: remoteMachineId,
                machineHostname: remoteHostname,
                machineOS: remoteOS,
              });
              if (vectors.length > 0) {
                await vectra.addVectors(vectors);
              }
            } catch (err: any) {
              _syncStatus.errors.push(`${remoteMachineId}:${knowledgeId}: Vector indexing failed: ${err.message}`);
            }

            _syncStatus.entriesSynced++;
          } catch (err: any) {
            _syncStatus.errors.push(`${remoteMachineId}:${knowledgeId}: ${err.message}`);
          }
        }

        // Flag stale entries — locally stored remote knowledge from this machine
        // whose ID is NOT in the current remote response
        const localRemoteIds = store.getRemoteKnowledgeIds(remoteMachineId);
        for (const localId of localRemoteIds) {
          if (!remoteKnowledgeIds.has(localId)) {
            // Flag as archived (stale) — never delete
            const existing = store.findRemoteKnowledge(remoteMachineId, localId);
            if (existing && existing.status !== 'archived') {
              // Re-save with archived status (preserves machineId for correct path)
              existing.status = 'archived';
              existing.updatedAt = new Date().toISOString();
              // Use createKnowledge to re-save (it will overwrite since path is the same)
              try {
                store.deleteRemoteKnowledge(remoteMachineId, localId);
                store.createKnowledge({
                  ...existing,
                  id: existing.id,
                  origin: 'remote',
                  machineId: remoteMachineId,
                  machineHostname: existing.machineHostname,
                  machineOS: existing.machineOS,
                  status: 'archived',
                });
                _syncStatus.entriesFlaggedStale++;
              } catch { /* best-effort */ }
            }
          }
        }

      } catch (err: any) {
        _syncStatus.errors.push(`${remoteMachineId}: ${err.message}`);
      }
    }

    // 5. Update sync timestamps
    const timestamps: Record<string, string> = {};
    const now = new Date().toISOString();
    for (const machine of machines) {
      const mid = machine.machineId || machine.id;
      if (mid && mid !== localMachineId) {
        timestamps[mid] = now;
      }
    }
    saveKnowledgeSettings({ lastSyncTimestamps: timestamps });

    // 6. Rebuild FTS index
    try {
      const { getVectorStore } = require('../vector/vector-store');
      const vectra = getVectorStore();
      await vectra.rebuildFtsIndex();
    } catch { /* best-effort */ }

    _syncStatus.status = 'done';
    _syncStatus.completedAt = new Date().toISOString();
    console.log(`[RemoteSync] Done: ${_syncStatus.entriesSynced} synced, ${_syncStatus.entriesSkipped} skipped, ${_syncStatus.entriesFlaggedStale} stale`);

  } catch (err: any) {
    _syncStatus.status = 'error';
    _syncStatus.errors.push(err.message);
    _syncStatus.completedAt = new Date().toISOString();
    console.error('[RemoteSync] Error:', err.message);
  }
}
