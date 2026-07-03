/**
 * Project Settings
 *
 * Manages project-level configuration, including excluded projects.
 * Uses mtime cache, partial updates, JSON storage.
 *
 * Storage: ~/.lm-assist/project-settings.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './utils/path-utils';

// ── Types ──────────────────────────────────────────

export interface ProjectSettings {
  excludedPaths: string[];
  /** Kill switch: disable all knowledge features (scheduler, vector store, embedder, API) */
  knowledgeEnabled: boolean;
  /** Kill switch: disable the generic data service (datasets, access keys, data routes). */
  dataServiceEnabled: boolean;
  /** How often (seconds) to flush the dirty-record queue and emit dataset_updated. Default 15. */
  dataSyncPeriodSec: number;
  /** How often (seconds) to run a full reconcile against all peers. Default 300. */
  dataReconcileSec: number;
  /** Auto-write the managed `_cross-project.md` signpost into every project's memory dir. Default true. */
  crossProjectSignpostEnabled: boolean;
  /** Cross-node memory sync: when true the autosync daemon runs in `on` mode (env MEMORY_AUTOSYNC overrides). Default true. */
  memorySyncEnabled: boolean;
  /** Auto-resume sessions stalled on server errors (529/5xx/server-rate-limit). Default true. */
  autoResumeStalledEnabled: boolean;
  /** Base interval (minutes) between `continue` nudges. Default 5. */
  autoResumeIntervalMin: number;
  /** Max nudge attempts before giving up + flagging. Default 6. */
  autoResumeMaxAttempts: number;
  /** Whether the elected monitor scans remote cloud CCRs. Default true. */
  autoResumeRemoteScan: boolean;
  /** Enable the super Mission Controller scheduled job. Default true. */
  missionControllerEnabled: boolean;
  /** Base interval (minutes) between Mission Controller ticks. Default 5. */
  missionControllerIntervalMin: number;
  /** Idle drive cadence (min) when there are no active missions. Default 15. */
  missionControllerIdleIntervalMin: number;
  /** Wave 4: long safety interval (min) — engage the controller at least this often even with no change. Default 45. */
  missionControllerSafetyIntervalMin: number;
  /** Max `continue` nudges to a parked mission before marking it blocked. Default 6. */
  missionControllerMaxNudges: number;
  /** Model for the adjust reasoning step. Default 'claude-opus-4-8[1m]'. */
  missionControllerModel: string;
  /** Idle minutes before an auto-resumed local (native) session is auto-closed. Default 30. */
  missionSessionIdleCloseMin: number;
  /** Max inline history entries kept on the mission record itself. Default 50. */
  missionHistoryInlineCap: number;
  /** Periodic auth-monitor: refresh OAuth + track cookie health into a snapshot. Default true. */
  authMonitorEnabled: boolean;
  /** Minutes between auth-monitor checks. Default 15. */
  authMonitorIntervalMin: number;
  /** Cross-node rule sync: when true the autosync daemon syncs ~/.claude/rules across fleet nodes. Default true. */
  ruleSyncEnabled: boolean;
  /** Peer fabric: managed node-to-node links over the hybrid transport. Default true. */
  fabricEnabled: boolean;
  /** Fabric RPC class: dispatch peer `req` frames into the route table. Default false — opt-in
   *  (no allow-list on the dispatch target; the RPC server is live as soon as a peer connects). */
  fabricRpcEnabled: boolean;
  /** Fabric per-frame gzip compression (path+payload aware). Default true. */
  fabricCompressionEnabled: boolean;
  /** Cap (MB/s) for the bulk class over the relay floor — gentle on the hub. Default 5. */
  fabricRelayBulkCapMBps: number;
}

// ── Constants ──────────────────────────────────────────

const SETTINGS_FILE = path.join(getDataDir(), 'project-settings.json');

export const DEFAULTS: ProjectSettings = {
  excludedPaths: [],
  knowledgeEnabled: false,
  dataServiceEnabled: false,
  dataSyncPeriodSec: 15,
  dataReconcileSec: 300,
  crossProjectSignpostEnabled: true,
  memorySyncEnabled: true,
  autoResumeStalledEnabled: true,
  autoResumeIntervalMin: 5,
  autoResumeMaxAttempts: 6,
  autoResumeRemoteScan: true,
  missionControllerEnabled: true,
  missionControllerIntervalMin: 5,
  missionControllerIdleIntervalMin: 15,
  missionControllerSafetyIntervalMin: 45,
  missionControllerMaxNudges: 6,
  missionControllerModel: 'claude-opus-4-8[1m]',
  missionSessionIdleCloseMin: 30,
  missionHistoryInlineCap: 50,
  authMonitorEnabled: true,
  authMonitorIntervalMin: 15,
  ruleSyncEnabled: true,
  fabricEnabled: true,
  fabricRpcEnabled: false,
  fabricCompressionEnabled: true,
  fabricRelayBulkCapMBps: 5,
};

// ── Mtime Cache ──────────────────────────────────────────

let settingsCache: ProjectSettings | null = null;
let settingsMtime = 0;

// ── Read Settings ──────────────────────────────────────────

export function getProjectSettings(): ProjectSettings {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      return { ...DEFAULTS };
    }
    const stat = fs.statSync(SETTINGS_FILE);
    if (settingsCache && stat.mtimeMs === settingsMtime) {
      return { ...settingsCache, excludedPaths: [...settingsCache.excludedPaths] };
    }
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    const settings: ProjectSettings = {
      excludedPaths: Array.isArray(data.excludedPaths)
        ? data.excludedPaths.filter((p: unknown) => typeof p === 'string')
        : DEFAULTS.excludedPaths,
      knowledgeEnabled: typeof data.knowledgeEnabled === 'boolean' ? data.knowledgeEnabled : DEFAULTS.knowledgeEnabled,
      dataServiceEnabled: typeof data.dataServiceEnabled === 'boolean' ? data.dataServiceEnabled : DEFAULTS.dataServiceEnabled,
      dataSyncPeriodSec: typeof data.dataSyncPeriodSec === 'number' ? data.dataSyncPeriodSec : DEFAULTS.dataSyncPeriodSec,
      dataReconcileSec: typeof data.dataReconcileSec === 'number' ? data.dataReconcileSec : DEFAULTS.dataReconcileSec,
      crossProjectSignpostEnabled: typeof data.crossProjectSignpostEnabled === 'boolean' ? data.crossProjectSignpostEnabled : DEFAULTS.crossProjectSignpostEnabled,
      memorySyncEnabled: typeof data.memorySyncEnabled === 'boolean' ? data.memorySyncEnabled : DEFAULTS.memorySyncEnabled,
      autoResumeStalledEnabled: typeof data.autoResumeStalledEnabled === 'boolean' ? data.autoResumeStalledEnabled : DEFAULTS.autoResumeStalledEnabled,
      autoResumeIntervalMin: typeof data.autoResumeIntervalMin === 'number' ? data.autoResumeIntervalMin : DEFAULTS.autoResumeIntervalMin,
      autoResumeMaxAttempts: typeof data.autoResumeMaxAttempts === 'number' ? data.autoResumeMaxAttempts : DEFAULTS.autoResumeMaxAttempts,
      autoResumeRemoteScan: typeof data.autoResumeRemoteScan === 'boolean' ? data.autoResumeRemoteScan : DEFAULTS.autoResumeRemoteScan,
      missionControllerEnabled: typeof data.missionControllerEnabled === 'boolean' ? data.missionControllerEnabled : DEFAULTS.missionControllerEnabled,
      missionControllerIntervalMin: typeof data.missionControllerIntervalMin === 'number' ? data.missionControllerIntervalMin : DEFAULTS.missionControllerIntervalMin,
      missionControllerIdleIntervalMin: typeof data.missionControllerIdleIntervalMin === 'number' ? data.missionControllerIdleIntervalMin : DEFAULTS.missionControllerIdleIntervalMin,
      missionControllerSafetyIntervalMin: typeof data.missionControllerSafetyIntervalMin === 'number' ? data.missionControllerSafetyIntervalMin : DEFAULTS.missionControllerSafetyIntervalMin,
      missionControllerMaxNudges: typeof data.missionControllerMaxNudges === 'number' ? data.missionControllerMaxNudges : DEFAULTS.missionControllerMaxNudges,
      missionControllerModel: typeof data.missionControllerModel === 'string' ? data.missionControllerModel : DEFAULTS.missionControllerModel,
      missionSessionIdleCloseMin: typeof data.missionSessionIdleCloseMin === 'number' ? data.missionSessionIdleCloseMin : DEFAULTS.missionSessionIdleCloseMin,
      missionHistoryInlineCap: typeof data.missionHistoryInlineCap === 'number' ? data.missionHistoryInlineCap : DEFAULTS.missionHistoryInlineCap,
      authMonitorEnabled: typeof data.authMonitorEnabled === 'boolean' ? data.authMonitorEnabled : DEFAULTS.authMonitorEnabled,
      authMonitorIntervalMin: typeof data.authMonitorIntervalMin === 'number' ? data.authMonitorIntervalMin : DEFAULTS.authMonitorIntervalMin,
      ruleSyncEnabled: typeof data.ruleSyncEnabled === 'boolean' ? data.ruleSyncEnabled : DEFAULTS.ruleSyncEnabled,
      fabricEnabled: typeof data.fabricEnabled === 'boolean' ? data.fabricEnabled : DEFAULTS.fabricEnabled,
      fabricRpcEnabled: typeof data.fabricRpcEnabled === 'boolean' ? data.fabricRpcEnabled : DEFAULTS.fabricRpcEnabled,
      fabricCompressionEnabled: typeof data.fabricCompressionEnabled === 'boolean' ? data.fabricCompressionEnabled : DEFAULTS.fabricCompressionEnabled,
      fabricRelayBulkCapMBps: typeof data.fabricRelayBulkCapMBps === 'number' ? data.fabricRelayBulkCapMBps : DEFAULTS.fabricRelayBulkCapMBps,
    };
    settingsCache = settings;
    settingsMtime = stat.mtimeMs;
    return settings;
  } catch {
    return { ...DEFAULTS };
  }
}

// ── Write Settings ──────────────────────────────────────────

export function saveProjectSettings(partial: Partial<ProjectSettings>): ProjectSettings {
  const current = getProjectSettings();

  const merged: ProjectSettings = {
    excludedPaths: Array.isArray(partial.excludedPaths)
      ? partial.excludedPaths.filter((p: unknown) => typeof p === 'string')
      : current.excludedPaths,
    knowledgeEnabled: typeof partial.knowledgeEnabled === 'boolean' ? partial.knowledgeEnabled : current.knowledgeEnabled,
    dataServiceEnabled: typeof partial.dataServiceEnabled === 'boolean' ? partial.dataServiceEnabled : current.dataServiceEnabled,
    dataSyncPeriodSec: typeof partial.dataSyncPeriodSec === 'number' ? partial.dataSyncPeriodSec : current.dataSyncPeriodSec,
    dataReconcileSec: typeof partial.dataReconcileSec === 'number' ? partial.dataReconcileSec : current.dataReconcileSec,
    crossProjectSignpostEnabled: typeof partial.crossProjectSignpostEnabled === 'boolean' ? partial.crossProjectSignpostEnabled : current.crossProjectSignpostEnabled,
    memorySyncEnabled: typeof partial.memorySyncEnabled === 'boolean' ? partial.memorySyncEnabled : current.memorySyncEnabled,
    autoResumeStalledEnabled: typeof partial.autoResumeStalledEnabled === 'boolean' ? partial.autoResumeStalledEnabled : current.autoResumeStalledEnabled,
    autoResumeIntervalMin: typeof partial.autoResumeIntervalMin === 'number' ? partial.autoResumeIntervalMin : current.autoResumeIntervalMin,
    autoResumeMaxAttempts: typeof partial.autoResumeMaxAttempts === 'number' ? partial.autoResumeMaxAttempts : current.autoResumeMaxAttempts,
    autoResumeRemoteScan: typeof partial.autoResumeRemoteScan === 'boolean' ? partial.autoResumeRemoteScan : current.autoResumeRemoteScan,
    missionControllerEnabled: typeof partial.missionControllerEnabled === 'boolean' ? partial.missionControllerEnabled : current.missionControllerEnabled,
    missionControllerIntervalMin: typeof partial.missionControllerIntervalMin === 'number' ? partial.missionControllerIntervalMin : current.missionControllerIntervalMin,
    missionControllerIdleIntervalMin: typeof partial.missionControllerIdleIntervalMin === 'number' ? partial.missionControllerIdleIntervalMin : current.missionControllerIdleIntervalMin,
    missionControllerSafetyIntervalMin: typeof partial.missionControllerSafetyIntervalMin === 'number' ? partial.missionControllerSafetyIntervalMin : current.missionControllerSafetyIntervalMin,
    missionControllerMaxNudges: typeof partial.missionControllerMaxNudges === 'number' ? partial.missionControllerMaxNudges : current.missionControllerMaxNudges,
    missionControllerModel: typeof partial.missionControllerModel === 'string' ? partial.missionControllerModel : current.missionControllerModel,
    missionSessionIdleCloseMin: typeof partial.missionSessionIdleCloseMin === 'number' ? partial.missionSessionIdleCloseMin : current.missionSessionIdleCloseMin,
    missionHistoryInlineCap: typeof partial.missionHistoryInlineCap === 'number' ? partial.missionHistoryInlineCap : current.missionHistoryInlineCap,
    authMonitorEnabled: typeof partial.authMonitorEnabled === 'boolean' ? partial.authMonitorEnabled : current.authMonitorEnabled,
    authMonitorIntervalMin: typeof partial.authMonitorIntervalMin === 'number' ? partial.authMonitorIntervalMin : current.authMonitorIntervalMin,
    ruleSyncEnabled: typeof partial.ruleSyncEnabled === 'boolean' ? partial.ruleSyncEnabled : current.ruleSyncEnabled,
    fabricEnabled: typeof partial.fabricEnabled === 'boolean' ? partial.fabricEnabled : current.fabricEnabled,
    fabricRpcEnabled: typeof partial.fabricRpcEnabled === 'boolean' ? partial.fabricRpcEnabled : current.fabricRpcEnabled,
    fabricCompressionEnabled: typeof partial.fabricCompressionEnabled === 'boolean' ? partial.fabricCompressionEnabled : current.fabricCompressionEnabled,
    fabricRelayBulkCapMBps: typeof partial.fabricRelayBulkCapMBps === 'number' ? partial.fabricRelayBulkCapMBps : current.fabricRelayBulkCapMBps,
  };

  // Ensure parent directory exists
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  settingsCache = merged;
  settingsMtime = fs.statSync(SETTINGS_FILE).mtimeMs;
  return merged;
}

// ── Helper ──────────────────────────────────────────

/**
 * Check if a project path is excluded.
 * Normalizes paths before comparison.
 */
export function isProjectExcluded(projectPath: string): boolean {
  const settings = getProjectSettings();
  const normalized = path.normalize(projectPath);
  return settings.excludedPaths.some(p => path.normalize(p) === normalized);
}
