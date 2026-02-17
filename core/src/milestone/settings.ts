import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Types ──────────────────────────────────────────

export type Phase2Model = 'haiku' | 'sonnet' | 'opus';

export interface MilestoneSettings {
  enabled: boolean;               // enable/disable auto milestone processing (default: true)
  autoKnowledge: boolean;         // enable/disable auto knowledge generation from explore agents (default: false)
  scanRangeDays: number | null;   // null = scan all sessions (default)
  phase2Model: Phase2Model;       // model for Phase 2 enrichment
  architectureModel: Phase2Model; // model for architecture generation (defaults to sonnet)
  excludedPaths: string[];        // project paths to exclude from milestone processing
}

// ── Constants ──────────────────────────────────────────

const MILESTONE_DIR = path.join(os.homedir(), '.milestone');
const SETTINGS_FILE = path.join(MILESTONE_DIR, 'settings.json');

const DEFAULTS: MilestoneSettings = {
  enabled: true,
  autoKnowledge: true,
  scanRangeDays: 1,
  phase2Model: 'haiku',
  architectureModel: 'sonnet',
  excludedPaths: [MILESTONE_DIR],
};

// Legacy location for excluded projects
const LEGACY_EXCLUDED_FILE = path.join(os.homedir(), '.tier-agent', 'milestones', 'excluded-projects.json');

// ── Mtime Cache ──────────────────────────────────────────

let settingsCache: MilestoneSettings | null = null;
let settingsMtime = 0;
let legacyMigrated = false;
let autoExcludeRan = false;

// ── Directory Management ──────────────────────────────────────────

export function getMilestoneDataDir(): string {
  if (!fs.existsSync(MILESTONE_DIR)) {
    fs.mkdirSync(MILESTONE_DIR, { recursive: true });
  }
  return MILESTONE_DIR;
}

// ── Read Settings ──────────────────────────────────────────

export function getMilestoneSettings(): MilestoneSettings {
  // Ensure dir exists
  getMilestoneDataDir();

  // Migrate legacy excluded-projects.json on first load
  if (!legacyMigrated) {
    migrateLegacyExcludedProjects();
    legacyMigrated = true;
  }

  // Auto-exclude non-git projects on first load
  if (!autoExcludeRan) {
    autoExcludeRan = true;
    autoExcludeNonGitProjects();
  }

  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      return { ...DEFAULTS };
    }
    const stat = fs.statSync(SETTINGS_FILE);
    if (settingsCache && stat.mtimeMs === settingsMtime) {
      return settingsCache;
    }
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    const settings: MilestoneSettings = {
      enabled: typeof data.enabled === 'boolean' ? data.enabled : DEFAULTS.enabled,
      autoKnowledge: typeof data.autoKnowledge === 'boolean' ? data.autoKnowledge : DEFAULTS.autoKnowledge,
      scanRangeDays: data.scanRangeDays ?? DEFAULTS.scanRangeDays,
      phase2Model: isValidModel(data.phase2Model) ? data.phase2Model : DEFAULTS.phase2Model,
      architectureModel: isValidModel(data.architectureModel) ? data.architectureModel : DEFAULTS.architectureModel,
      excludedPaths: Array.isArray(data.excludedPaths) ? data.excludedPaths : DEFAULTS.excludedPaths,
    };
    settingsCache = settings;
    settingsMtime = stat.mtimeMs;
    return settings;
  } catch {
    return { ...DEFAULTS };
  }
}

// ── Write Settings ──────────────────────────────────────────

export function saveMilestoneSettings(partial: Partial<MilestoneSettings>): MilestoneSettings {
  getMilestoneDataDir();
  const current = getMilestoneSettings();

  const excludedPaths = partial.excludedPaths !== undefined
    ? (Array.isArray(partial.excludedPaths) ? partial.excludedPaths : current.excludedPaths)
    : current.excludedPaths;

  // Always ensure MILESTONE_DIR is in excludedPaths (non-removable built-in)
  if (!excludedPaths.includes(MILESTONE_DIR)) {
    excludedPaths.unshift(MILESTONE_DIR);
  }

  const merged: MilestoneSettings = {
    enabled: typeof partial.enabled === 'boolean' ? partial.enabled : current.enabled,
    autoKnowledge: typeof partial.autoKnowledge === 'boolean' ? partial.autoKnowledge : current.autoKnowledge,
    scanRangeDays: partial.scanRangeDays !== undefined ? partial.scanRangeDays : current.scanRangeDays,
    phase2Model: partial.phase2Model !== undefined && isValidModel(partial.phase2Model)
      ? partial.phase2Model
      : current.phase2Model,
    architectureModel: partial.architectureModel !== undefined && isValidModel(partial.architectureModel)
      ? partial.architectureModel
      : current.architectureModel,
    excludedPaths,
  };

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  settingsCache = merged;
  settingsMtime = fs.statSync(SETTINGS_FILE).mtimeMs;
  return merged;
}

// ── Scan Range Check ──────────────────────────────────────────

/**
 * Check if a session timestamp falls within the configured scan range.
 * Returns true if scanRangeDays is null (no limit) or if the timestamp
 * is within the last N days.
 */
export function isSessionInScanRange(sessionTimestamp: string | number): boolean {
  const settings = getMilestoneSettings();
  if (settings.scanRangeDays === null) return true;

  const ts = typeof sessionTimestamp === 'number' ? sessionTimestamp : Date.parse(sessionTimestamp);
  if (isNaN(ts)) return true; // Can't parse → don't filter

  const cutoff = Date.now() - (settings.scanRangeDays * 24 * 60 * 60 * 1000);
  return ts >= cutoff;
}

// ── Helpers ──────────────────────────────────────────

function isValidModel(model: any): model is Phase2Model {
  return model === 'haiku' || model === 'sonnet' || model === 'opus';
}

/**
 * Migrate legacy ~/.tier-agent/milestones/excluded-projects.json paths
 * into the new ~/.milestone/settings.json excludedPaths field.
 */
function migrateLegacyExcludedProjects(): void {
  try {
    if (!fs.existsSync(LEGACY_EXCLUDED_FILE)) return;
    const data = JSON.parse(fs.readFileSync(LEGACY_EXCLUDED_FILE, 'utf-8'));
    const legacyPaths: string[] = Array.isArray(data.paths) ? data.paths : [];
    if (legacyPaths.length === 0) return;

    // Only migrate if settings file doesn't already have excludedPaths
    const current = fs.existsSync(SETTINGS_FILE)
      ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'))
      : {};

    if (Array.isArray(current.excludedPaths) && current.excludedPaths.length > 0) {
      return; // Already has excluded paths, don't overwrite
    }

    // Merge legacy paths into settings
    saveMilestoneSettings({ excludedPaths: legacyPaths });
    console.error(`[MilestoneSettings] Migrated ${legacyPaths.length} excluded paths from legacy file`);
  } catch {
    // Non-fatal migration error
  }
}

/**
 * Auto-exclude projects that are not valid git repositories.
 * Uses the ProjectsService to get accurate project paths, then checks for .git.
 * Runs once on first settings load. User can manually remove auto-excluded paths.
 */
function autoExcludeNonGitProjects(): void {
  try {
    const { createProjectsService } = require('../projects-service');
    const service = createProjectsService();
    const projects = service.listProjects({ includeSize: false });

    const current = fs.existsSync(SETTINGS_FILE)
      ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'))
      : {};
    const excludedSet = new Set<string>(
      Array.isArray(current.excludedPaths) ? current.excludedPaths : [MILESTONE_DIR]
    );
    const initialSize = excludedSet.size;

    for (const project of projects) {
      const projectPath = (project as any).path as string;
      if (!projectPath || excludedSet.has(projectPath)) continue;

      try {
        const gitDir = path.join(projectPath, '.git');
        if (!fs.existsSync(gitDir)) {
          excludedSet.add(projectPath);
        }
      } catch {
        excludedSet.add(projectPath);
      }
    }

    if (excludedSet.size > initialSize) {
      const added = excludedSet.size - initialSize;
      saveMilestoneSettings({ excludedPaths: Array.from(excludedSet) });
      console.error(`[MilestoneSettings] Auto-excluded ${added} non-git project(s)`);
    }
  } catch {
    // Non-fatal — ProjectsService may not be available in all contexts (e.g. MCP server)
  }
}
