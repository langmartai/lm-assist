/**
 * Knowledge Settings
 *
 * Manages configuration for knowledge features, particularly remote knowledge sync.
 * Uses mtime cache, partial updates, JSON storage.
 *
 * Storage: ~/.lm-assist/knowledge/settings.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../utils/path-utils';

// ── Types ──────────────────────────────────────────

export interface KnowledgeSettings {
  remoteSyncEnabled: boolean;                        // master toggle (default: false)
  syncIntervalMinutes: number;                       // 0 = manual only (default: 0)
  lastSyncTimestamps: Record<string, string>;        // machineId → ISO timestamp
  reviewModel: 'haiku' | 'sonnet' | 'opus';         // model for LLM quality review (default: opus)
  autoReview: boolean;                               // auto-trigger LLM review after generation (default: false)
  autoExploreGeneration: boolean;                    // auto-generate from explore agents (default: true)
  autoGenericDiscovery: boolean;                     // auto-discover generic content via LLM (default: false, costs tokens)
  genericValidationModel: 'haiku' | 'sonnet' | 'opus'; // model for generic content validation (default: sonnet)
}

// ── Constants ──────────────────────────────────────────

const KNOWLEDGE_DIR = path.join(getDataDir(), 'knowledge');
const SETTINGS_FILE = path.join(KNOWLEDGE_DIR, 'settings.json');

const DEFAULTS: KnowledgeSettings = {
  remoteSyncEnabled: false,
  syncIntervalMinutes: 0,
  lastSyncTimestamps: {},
  reviewModel: 'opus',
  autoReview: false,
  autoExploreGeneration: true,
  autoGenericDiscovery: false,
  genericValidationModel: 'sonnet',
};

// ── Mtime Cache ──────────────────────────────────────────

let settingsCache: KnowledgeSettings | null = null;
let settingsMtime = 0;

// ── Directory Management ──────────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  }
}

// ── Read Settings ──────────────────────────────────────────

export function getKnowledgeSettings(): KnowledgeSettings {
  ensureDir();

  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      return { ...DEFAULTS };
    }
    const stat = fs.statSync(SETTINGS_FILE);
    if (settingsCache && stat.mtimeMs === settingsMtime) {
      return settingsCache;
    }
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    const settings: KnowledgeSettings = {
      remoteSyncEnabled: typeof data.remoteSyncEnabled === 'boolean' ? data.remoteSyncEnabled : DEFAULTS.remoteSyncEnabled,
      syncIntervalMinutes: typeof data.syncIntervalMinutes === 'number' && data.syncIntervalMinutes >= 0
        ? Math.floor(data.syncIntervalMinutes)
        : DEFAULTS.syncIntervalMinutes,
      lastSyncTimestamps: typeof data.lastSyncTimestamps === 'object' && data.lastSyncTimestamps !== null
        ? data.lastSyncTimestamps
        : DEFAULTS.lastSyncTimestamps,
      reviewModel: ['haiku', 'sonnet', 'opus'].includes(data.reviewModel) ? data.reviewModel : DEFAULTS.reviewModel,
      autoReview: typeof data.autoReview === 'boolean' ? data.autoReview : DEFAULTS.autoReview,
      autoExploreGeneration: typeof data.autoExploreGeneration === 'boolean' ? data.autoExploreGeneration : DEFAULTS.autoExploreGeneration,
      autoGenericDiscovery: typeof data.autoGenericDiscovery === 'boolean' ? data.autoGenericDiscovery : DEFAULTS.autoGenericDiscovery,
      genericValidationModel: ['haiku', 'sonnet', 'opus'].includes(data.genericValidationModel) ? data.genericValidationModel : DEFAULTS.genericValidationModel,
    };
    settingsCache = settings;
    settingsMtime = stat.mtimeMs;
    return settings;
  } catch {
    return { ...DEFAULTS };
  }
}

// ── Write Settings ──────────────────────────────────────────

export function saveKnowledgeSettings(partial: Partial<KnowledgeSettings>): KnowledgeSettings {
  ensureDir();
  const current = getKnowledgeSettings();

  const merged: KnowledgeSettings = {
    remoteSyncEnabled: typeof partial.remoteSyncEnabled === 'boolean' ? partial.remoteSyncEnabled : current.remoteSyncEnabled,
    syncIntervalMinutes: typeof partial.syncIntervalMinutes === 'number' && partial.syncIntervalMinutes >= 0 && partial.syncIntervalMinutes <= 1440
      ? Math.floor(partial.syncIntervalMinutes)
      : current.syncIntervalMinutes,
    lastSyncTimestamps: partial.lastSyncTimestamps !== undefined
      ? { ...current.lastSyncTimestamps, ...partial.lastSyncTimestamps }
      : current.lastSyncTimestamps,
    reviewModel: partial.reviewModel && ['haiku', 'sonnet', 'opus'].includes(partial.reviewModel)
      ? partial.reviewModel
      : current.reviewModel,
    autoReview: typeof partial.autoReview === 'boolean' ? partial.autoReview : current.autoReview,
    autoExploreGeneration: typeof partial.autoExploreGeneration === 'boolean' ? partial.autoExploreGeneration : current.autoExploreGeneration,
    autoGenericDiscovery: typeof partial.autoGenericDiscovery === 'boolean' ? partial.autoGenericDiscovery : current.autoGenericDiscovery,
    genericValidationModel: partial.genericValidationModel && ['haiku', 'sonnet', 'opus'].includes(partial.genericValidationModel)
      ? partial.genericValidationModel
      : current.genericValidationModel,
  };

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  settingsCache = merged;
  settingsMtime = fs.statSync(SETTINGS_FILE).mtimeMs;
  return merged;
}
