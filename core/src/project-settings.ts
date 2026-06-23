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
}

// ── Constants ──────────────────────────────────────────

const SETTINGS_FILE = path.join(getDataDir(), 'project-settings.json');

const DEFAULTS: ProjectSettings = {
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
