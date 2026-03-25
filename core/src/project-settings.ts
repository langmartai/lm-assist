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
}

// ── Constants ──────────────────────────────────────────

const SETTINGS_FILE = path.join(getDataDir(), 'project-settings.json');

const DEFAULTS: ProjectSettings = {
  excludedPaths: [],
  knowledgeEnabled: true,
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
