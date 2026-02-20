/**
 * Knowledge Settings
 *
 * Manages configuration for knowledge features, particularly remote knowledge sync.
 * Pattern follows core/src/milestone/settings.ts — mtime cache, partial updates, JSON storage.
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
}

// ── Constants ──────────────────────────────────────────

const KNOWLEDGE_DIR = path.join(getDataDir(), 'knowledge');
const SETTINGS_FILE = path.join(KNOWLEDGE_DIR, 'settings.json');

const DEFAULTS: KnowledgeSettings = {
  remoteSyncEnabled: false,
  syncIntervalMinutes: 0,
  lastSyncTimestamps: {},
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
  };

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  settingsCache = merged;
  settingsMtime = fs.statSync(SETTINGS_FILE).mtimeMs;
  return merged;
}
