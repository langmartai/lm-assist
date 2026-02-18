/**
 * project_architecture tool — On-demand project structure from milestone data
 *
 * Replaces the need for expensive always-loaded CLAUDE.md architecture sections.
 * Auto-generates a component map by aggregating file paths from milestones,
 * clustering by directory, and annotating with milestone context.
 *
 * Cached per project; invalidated when milestone count changes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getSessionCache } from '../../session-cache';
import type { CachedResource } from '../../resource-extractor';
import { getMilestoneStore } from '../../milestone/store';
import { getDataDir } from '../../utils/path-utils';
import { getProjectPathForSession } from '../../search/text-scorer';
import type { Milestone } from '../../milestone/types';
import { loadModelCache, formatArchitectureModelForMcp, computeInputHash } from '../../architecture-llm';

// ─── Tool Definition ──────────────────────────────────────────────────

export const projectArchitectureToolDef = {
  name: 'project_architecture',
  description: `Get project architecture from milestone history and LLM-discovered system model.

Progressive disclosure — start broad, drill in:
1. No params → lightweight index (~1 line per directory, stats only)
2. part="services"|"connections"|"databases"|"data_flows"|"diagram" → LLM-discovered system model section
3. part="components"|"key_files"|"resources" → session activity data section
4. directory="src/mcp-server" → full detail for that directory subtree
5. include=["components","key_files"] → multiple sections in full detail

Start with no params to get the index, then use part or directory to drill in.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      project: {
        type: 'string',
        description: 'Project path (auto-detected if omitted)',
      },
      part: {
        type: 'string',
        description: 'Return a specific part: "services", "connections", "databases", "data_flows", "diagram", "components", "key_files", "resources"',
      },
      directory: {
        type: 'string',
        description: 'Drill into a specific directory for full detail (e.g. "src/mcp-server")',
      },
      include: {
        type: 'array',
        items: { type: 'string' },
        description: 'Multiple sections to include in detail: "components", "key_files", "resources"',
      },
    },
  },
};

// ─── Cache ──────────────────────────────────────────────────

const CACHE_DIR = path.join(getDataDir(), 'architecture');

const CACHE_VERSION = 6;
const HOME_DIR = process.env.HOME || '/home/ubuntu';

export interface ExternalProject {
  projectRoot: string;      // "/home/ubuntu/langmart-assistant"
  displayName: string;      // "langmart-assistant"
  components: ComponentInfo[];
  keyFiles: KeyFileInfo[];
  totalMilestones: number;
  totalFiles: number;
}

export type Temperature = 'hot' | 'warm' | 'cold';

export interface CachedArchitecture {
  project: string;
  milestoneCount: number;
  generatedAt: number;
  cacheVersion: number;
  components: ComponentInfo[];
  keyFiles: KeyFileInfo[];
  externalProjects: ExternalProject[];
  resources: CachedResource[];
  /** Sum of all session resource accessCounts — used for cache invalidation */
  resourceAccessTotal: number;
}

export interface ComponentInfo {
  directory: string;
  purpose: string;            // Derived from milestone titles/types
  fileCount: number;
  milestoneCount: number;
  types: Record<string, number>;  // bugfix: 3, feature: 5, etc.
  recentMilestones: string[];     // Last 3 milestone titles
  temperature: Temperature;       // hot (active <7d), warm (>7d), cold (scan-only)
  lastTouched: string | null;     // ISO timestamp, null for cold
}

export interface KeyFileInfo {
  filePath: string;
  modifyCount: number;
  readCount: number;
  lastMilestoneTitle: string | null;
  lastMilestoneId: string | null;
  lastTimestamp: string | null;
  temperature: Temperature;                // hot (active <7d), warm (>7d)
}

// ─── Path Classification ──────────────────────────────────────────

type PathClassification =
  | { type: 'internal'; relativePath: string }
  | { type: 'external'; relativePath: string; projectRoot: string; displayName: string }
  | { type: 'noise' };

// Worktree pattern: {project}-wt-\d+/rest
const WORKTREE_RE = /^(.+)-wt-\d+(?:\/(.*))?$/;

// Cache .git lookups to avoid repeated fs calls
const gitRootCache = new Map<string, string | null>();

function findGitRoot(dir: string): string | null {
  if (gitRootCache.has(dir)) return gitRootCache.get(dir)!;
  let current = dir;
  for (let i = 0; i < 5; i++) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) {
        gitRootCache.set(dir, current);
        return current;
      }
    } catch { /* ignore */ }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  gitRootCache.set(dir, null);
  return null;
}

function classifyPath(filePath: string, project: string): PathClassification {
  // If it's already a relative path (within the project), keep as internal
  if (!filePath.startsWith('/')) {
    return { type: 'internal', relativePath: filePath };
  }

  // If it's inside the project directory, make relative
  if (filePath.startsWith(project + '/')) {
    return { type: 'internal', relativePath: filePath.slice(project.length + 1) };
  }

  // ─── Noise exclusion (checked first) ───

  // /tmp/ paths
  if (filePath.startsWith('/tmp/')) return { type: 'noise' };

  // /nonexistent/
  if (filePath.startsWith('/nonexistent/')) return { type: 'noise' };

  // Dotfile paths under home dir (e.g., ~/.claude/, ~/.lm-assist/)
  if (filePath.startsWith(HOME_DIR + '/')) {
    const afterHome = filePath.slice(HOME_DIR.length + 1);
    // Check if any path segment starts with '.'
    const firstSegment = afterHome.split('/')[0];
    if (firstSegment.startsWith('.')) return { type: 'noise' };
  }

  // Bare/phantom paths — just /home/ubuntu or /home with no real content below
  const barePatterns = ['/home/ubuntu', '/home', '/'];
  if (barePatterns.includes(filePath)) return { type: 'noise' };

  // ─── Worktree remapping ───

  // Extract the directory name from under HOME_DIR
  if (filePath.startsWith(HOME_DIR + '/')) {
    const afterHome = filePath.slice(HOME_DIR.length + 1); // e.g., "tier-agent-wt-5/src/foo.ts"
    const firstSlash = afterHome.indexOf('/');
    const topDir = firstSlash >= 0 ? afterHome.slice(0, firstSlash) : afterHome;
    const restPath = firstSlash >= 0 ? afterHome.slice(firstSlash + 1) : '';

    const wtMatch = topDir.match(WORKTREE_RE);
    if (wtMatch) {
      const baseProject = wtMatch[1]; // e.g., "tier-agent" or "langmart-assistant"
      const projectName = path.basename(project); // e.g., "tier-agent"

      // Self-worktree: remap to internal
      if (baseProject === projectName) {
        return { type: 'internal', relativePath: restPath || '.' };
      }

      // External worktree: remap to base external project
      const extRoot = path.join(HOME_DIR, baseProject);
      return {
        type: 'external',
        relativePath: restPath || '.',
        projectRoot: extRoot,
        displayName: baseProject,
      };
    }

    // ─── Regular external project ───

    // Try to find a git root to determine project boundary
    const fileDir = path.dirname(filePath);
    const gitRoot = findGitRoot(fileDir);
    if (gitRoot && gitRoot !== project && gitRoot.startsWith(HOME_DIR + '/')) {
      const relPath = filePath.slice(gitRoot.length + 1);
      return {
        type: 'external',
        relativePath: relPath,
        projectRoot: gitRoot,
        displayName: path.basename(gitRoot),
      };
    }

    // Fallback: first directory under HOME_DIR as external project root
    if (firstSlash >= 0 && topDir !== path.basename(project)) {
      const extRoot = path.join(HOME_DIR, topDir);
      return {
        type: 'external',
        relativePath: restPath,
        projectRoot: extRoot,
        displayName: topDir,
      };
    }
  }

  // Anything else that's absolute but outside home — noise
  return { type: 'noise' };
}

// ─── Data API (for REST endpoint) ──────────────────────────────

/**
 * Returns raw architecture data for a project.
 * Reuses the same cache + generation logic as the MCP tool.
 */
export async function getProjectArchitectureData(
  requestedProject?: string
): Promise<CachedArchitecture | null> {
  const cache = getSessionCache();
  const sessions = cache.getAllSessionsFromCache();

  let project: string | undefined = requestedProject;
  if (!project) {
    project = detectMostActiveProject(sessions) ?? undefined;
  }
  if (!project) return null;

  const milestoneStore = getMilestoneStore();
  const projectMilestones: Array<{ milestone: Milestone; sessionId: string }> = [];
  const sessionResources: CachedResource[] = [];

  for (const { sessionId, filePath, cacheData } of sessions) {
    const sessionProject = cacheData.cwd || getProjectPathForSession(cacheData, filePath);
    if (sessionProject !== project) continue;
    const milestones = milestoneStore.getMilestones(sessionId);
    for (const m of milestones) {
      projectMilestones.push({ milestone: m, sessionId });
    }
    // Collect resources from session cache (field added when resource-extractor is wired in)
    const res = (cacheData as any).resources as CachedResource[] | undefined;
    if (res && res.length > 0) {
      sessionResources.push(...res);
    }
  }

  if (projectMilestones.length === 0) return null;

  const totalResourceCount = sessionResources.reduce((sum, r) => sum + r.accessCount, 0);
  const cached = loadCache(project);
  if (cached && cached.milestoneCount === projectMilestones.length
    && cached.resourceAccessTotal === totalResourceCount) {
    return cached;
  }

  const architecture = await generateArchitecture(project, projectMilestones, sessionResources, totalResourceCount);
  saveCache(project, architecture);
  return architecture;
}

// ─── Handler ──────────────────────────────────────────────────

export async function handleProjectArchitecture(args: Record<string, unknown>): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const requestedProject = args.project as string | undefined;
  const part = args.part as string | undefined;
  const directory = args.directory as string | undefined;
  const include = args.include as string[] | undefined;

  const architecture = await getProjectArchitectureData(requestedProject);
  if (!architecture) {
    const msg = requestedProject
      ? `No milestones found for project: ${requestedProject}`
      : 'Error: No project detected. Pass project parameter.';
    return { content: [{ type: 'text', text: msg }] };
  }

  // Part-based access: return a specific section of the architecture
  if (part) {
    return { content: [{ type: 'text', text: formatPart(architecture, part) }] };
  }

  // Route to appropriate formatter
  const sections = include ? new Set(include) : null;

  if (directory) {
    // Drill-down: full detail for one directory subtree
    return { content: [{ type: 'text', text: formatDirectoryDetail(architecture, directory, sections) }] };
  }

  if (sections) {
    // Explicit section request: full detail for those sections
    return { content: [{ type: 'text', text: formatSectionsFull(architecture, sections) }] };
  }

  // Default: lightweight overview with drill-down hints
  return { content: [{ type: 'text', text: formatOverview(architecture) }] };
}

// ─── Architecture Generation ──────────────────────────────────────────

async function generateArchitecture(
  project: string,
  entries: Array<{ milestone: Milestone; sessionId: string }>,
  sessionResources?: CachedResource[],
  resourceAccessTotal?: number
): Promise<CachedArchitecture> {
  // Sort by timestamp for chronological processing
  entries.sort((a, b) => {
    const tA = new Date(a.milestone.startTimestamp).getTime() || 0;
    const tB = new Date(b.milestone.startTimestamp).getTime() || 0;
    return tA - tB;
  });

  // Aggregate file data
  const dirStats = new Map<string, {
    files: Set<string>;
    milestoneCount: number;
    types: Record<string, number>;
    recentTitles: string[];
  }>();

  const fileStats = new Map<string, {
    modifyCount: number;
    readCount: number;
    lastMilestoneTitle: string | null;
    lastMilestoneId: string | null;
    lastTimestamp: string | null;
  }>();

  for (const { milestone } of entries) {
    const modifiedSet = new Set(milestone.filesModified);
    const readOnly = milestone.filesRead.filter(f => !modifiedSet.has(f));
    const allFiles = [...milestone.filesModified, ...readOnly];
    const touchedDirs = new Set<string>();

    // Single pass: aggregate file stats and collect dir→file mappings
    const dirFiles = new Map<string, Set<string>>();

    for (const f of allFiles) {
      const rel = f.startsWith(project + '/') ? f.slice(project.length + 1) : f;
      const dir = path.dirname(rel);
      touchedDirs.add(dir);

      // Collect files per directory (for dirStats)
      let files = dirFiles.get(dir);
      if (!files) { files = new Set(); dirFiles.set(dir, files); }
      files.add(path.basename(rel));

      // File stats
      const existing = fileStats.get(rel) || {
        modifyCount: 0, readCount: 0,
        lastMilestoneTitle: null, lastMilestoneId: null, lastTimestamp: null,
      };
      if (modifiedSet.has(f)) existing.modifyCount++;
      else existing.readCount++;
      if (milestone.title) {
        existing.lastMilestoneTitle = milestone.title;
        existing.lastMilestoneId = milestone.id;
        existing.lastTimestamp = milestone.endTimestamp;
      }
      fileStats.set(rel, existing);
    }

    // Directory stats — use pre-collected dirFiles instead of re-scanning allFiles
    for (const dir of touchedDirs) {
      const stat = dirStats.get(dir) || {
        files: new Set(), milestoneCount: 0, types: {}, recentTitles: [],
      };
      const files = dirFiles.get(dir);
      if (files) { for (const f of files) stat.files.add(f); }
      stat.milestoneCount++;
      if (milestone.type) {
        stat.types[milestone.type] = (stat.types[milestone.type] || 0) + 1;
      }
      if (milestone.title) {
        stat.recentTitles.push(milestone.title);
        if (stat.recentTitles.length > 3) stat.recentTitles.shift();
      }
      dirStats.set(dir, stat);
    }
  }

  // ─── Classification pass ───
  // Classify all dirStats and fileStats into internal / external / noise buckets

  // Internal aggregation (merged with self-worktree remapped paths)
  const internalDirStats = new Map<string, {
    files: Set<string>;
    milestoneCount: number;
    types: Record<string, number>;
    recentTitles: string[];
  }>();

  const internalFileStats = new Map<string, {
    modifyCount: number;
    readCount: number;
    lastMilestoneTitle: string | null;
    lastMilestoneId: string | null;
    lastTimestamp: string | null;
  }>();

  // External aggregation grouped by project root
  const externalDirStats = new Map<string, Map<string, {
    files: Set<string>;
    milestoneCount: number;
    types: Record<string, number>;
    recentTitles: string[];
  }>>();
  const externalFileStats = new Map<string, Map<string, {
    modifyCount: number;
    readCount: number;
    lastMilestoneTitle: string | null;
    lastMilestoneId: string | null;
    lastTimestamp: string | null;
  }>>();
  const externalDisplayNames = new Map<string, string>(); // projectRoot → displayName

  // Helper: merge dir stats into a target map
  function mergeDirStat(
    targetMap: Map<string, { files: Set<string>; milestoneCount: number; types: Record<string, number>; recentTitles: string[] }>,
    dir: string,
    stat: { files: Set<string>; milestoneCount: number; types: Record<string, number>; recentTitles: string[] }
  ) {
    const existing = targetMap.get(dir);
    if (existing) {
      for (const f of stat.files) existing.files.add(f);
      existing.milestoneCount += stat.milestoneCount;
      for (const [t, n] of Object.entries(stat.types)) {
        existing.types[t] = (existing.types[t] || 0) + n;
      }
      // Merge recent titles (keep last 3)
      existing.recentTitles.push(...stat.recentTitles);
      if (existing.recentTitles.length > 3) {
        existing.recentTitles.splice(0, existing.recentTitles.length - 3);
      }
    } else {
      targetMap.set(dir, {
        files: new Set(stat.files),
        milestoneCount: stat.milestoneCount,
        types: { ...stat.types },
        recentTitles: [...stat.recentTitles],
      });
    }
  }

  // Helper: merge file stats into a target map
  function mergeFileStat(
    targetMap: Map<string, { modifyCount: number; readCount: number; lastMilestoneTitle: string | null; lastMilestoneId: string | null; lastTimestamp: string | null }>,
    filePath: string,
    stat: { modifyCount: number; readCount: number; lastMilestoneTitle: string | null; lastMilestoneId: string | null; lastTimestamp: string | null }
  ) {
    const existing = targetMap.get(filePath);
    if (existing) {
      existing.modifyCount += stat.modifyCount;
      existing.readCount += stat.readCount;
      // Keep the latest timestamp
      if (stat.lastTimestamp && (!existing.lastTimestamp || stat.lastTimestamp > existing.lastTimestamp)) {
        existing.lastMilestoneTitle = stat.lastMilestoneTitle;
        existing.lastMilestoneId = stat.lastMilestoneId;
        existing.lastTimestamp = stat.lastTimestamp;
      }
    } else {
      targetMap.set(filePath, { ...stat });
    }
  }

  // Classify dirStats
  for (const [dir, stat] of dirStats) {
    const classification = classifyPath(
      dir.startsWith('/') ? dir : (project + '/' + dir),
      project
    );

    if (classification.type === 'noise') continue;

    if (classification.type === 'internal') {
      const relDir = classification.relativePath === '' ? '.' : classification.relativePath;
      mergeDirStat(internalDirStats, relDir, stat);
    } else {
      // External
      const { projectRoot, displayName, relativePath } = classification;
      externalDisplayNames.set(projectRoot, displayName);
      if (!externalDirStats.has(projectRoot)) {
        externalDirStats.set(projectRoot, new Map());
      }
      const relDir = relativePath === '' ? '.' : relativePath;
      mergeDirStat(externalDirStats.get(projectRoot)!, relDir, stat);
    }
  }

  // Classify fileStats
  for (const [filePath, stat] of fileStats) {
    const classification = classifyPath(
      filePath.startsWith('/') ? filePath : (project + '/' + filePath),
      project
    );

    if (classification.type === 'noise') continue;

    if (classification.type === 'internal') {
      mergeFileStat(internalFileStats, classification.relativePath, stat);
    } else {
      const { projectRoot, displayName, relativePath } = classification;
      externalDisplayNames.set(projectRoot, displayName);
      if (!externalFileStats.has(projectRoot)) {
        externalFileStats.set(projectRoot, new Map());
      }
      mergeFileStat(externalFileStats.get(projectRoot)!, relativePath, stat);
    }
  }

  // ─── Temperature classification helper ───
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  function classifyTemperature(lastTimestamp: string | null): Temperature {
    if (!lastTimestamp) return 'cold';
    const ts = Date.parse(lastTimestamp);
    if (isNaN(ts)) return 'warm';
    return (now - ts) < SEVEN_DAYS_MS ? 'hot' : 'warm';
  }

  // Build internal components
  const components: ComponentInfo[] = [];
  for (const [dir, stat] of internalDirStats) {
    // Find latest timestamp across all file stats in this dir
    let latestTimestamp: string | null = null;
    for (const [fp, fStat] of internalFileStats) {
      if (path.dirname(fp) === dir || fp.startsWith(dir + '/')) {
        if (fStat.lastTimestamp && (!latestTimestamp || fStat.lastTimestamp > latestTimestamp)) {
          latestTimestamp = fStat.lastTimestamp;
        }
      }
    }
    components.push({
      directory: dir === '.' ? '(project root)' : dir,
      purpose: derivePurpose(stat.types, stat.recentTitles),
      fileCount: stat.files.size,
      milestoneCount: stat.milestoneCount,
      types: stat.types,
      recentMilestones: stat.recentTitles,
      temperature: classifyTemperature(latestTimestamp),
      lastTouched: latestTimestamp,
    });
  }
  components.sort((a, b) => b.milestoneCount - a.milestoneCount);

  // Build internal key files (most modified, top 20)
  const keyFiles: KeyFileInfo[] = Array.from(internalFileStats.entries())
    .map(([fp, stat]) => ({
      filePath: fp,
      ...stat,
      temperature: classifyTemperature(stat.lastTimestamp) as Temperature,
    }))
    .sort((a, b) => (b.modifyCount + b.readCount) - (a.modifyCount + a.readCount))
    .slice(0, 20);

  // Build external projects
  const externalProjects: ExternalProject[] = [];
  for (const [projectRoot, dirMap] of externalDirStats) {
    const displayName = externalDisplayNames.get(projectRoot) || path.basename(projectRoot);

    const extComponents: ComponentInfo[] = [];
    let totalMilestones = 0;
    let totalFiles = 0;
    const extFileMap = externalFileStats.get(projectRoot);
    for (const [dir, stat] of dirMap) {
      // Find latest timestamp for this external component
      let extLatestTs: string | null = null;
      if (extFileMap) {
        for (const [fp, fStat] of extFileMap) {
          if (path.dirname(fp) === dir || fp.startsWith(dir + '/')) {
            if (fStat.lastTimestamp && (!extLatestTs || fStat.lastTimestamp > extLatestTs)) {
              extLatestTs = fStat.lastTimestamp;
            }
          }
        }
      }
      extComponents.push({
        directory: dir === '.' ? '(project root)' : dir,
        purpose: derivePurpose(stat.types, stat.recentTitles),
        fileCount: stat.files.size,
        milestoneCount: stat.milestoneCount,
        types: stat.types,
        recentMilestones: stat.recentTitles,
        temperature: classifyTemperature(extLatestTs),
        lastTouched: extLatestTs,
      });
      totalMilestones += stat.milestoneCount;
      totalFiles += stat.files.size;
    }
    extComponents.sort((a, b) => b.milestoneCount - a.milestoneCount);

    const extKeyFiles: KeyFileInfo[] = extFileMap
      ? Array.from(extFileMap.entries())
          .map(([fp, stat]) => ({
            filePath: fp,
            ...stat,
            temperature: classifyTemperature(stat.lastTimestamp) as Temperature,
          }))
          .sort((a, b) => (b.modifyCount + b.readCount) - (a.modifyCount + a.readCount))
          .slice(0, 20)
      : [];

    externalProjects.push({
      projectRoot,
      displayName,
      components: extComponents,
      keyFiles: extKeyFiles,
      totalMilestones,
      totalFiles,
    });
  }
  externalProjects.sort((a, b) => b.totalMilestones - a.totalMilestones);

  // Aggregate resources across sessions: merge by key
  const resources = aggregateResources(sessionResources || []);

  // ─── Sort: hot first → warm → cold (within same temp, by milestoneCount desc) ───
  const tempOrder: Record<Temperature, number> = { hot: 0, warm: 1, cold: 2 };
  components.sort((a, b) => {
    const tempDiff = tempOrder[a.temperature] - tempOrder[b.temperature];
    if (tempDiff !== 0) return tempDiff;
    return b.milestoneCount - a.milestoneCount;
  });

  return {
    project,
    milestoneCount: entries.length,
    generatedAt: Date.now(),
    cacheVersion: CACHE_VERSION,
    components,
    keyFiles,
    externalProjects,
    resources,
    resourceAccessTotal: resourceAccessTotal || 0,
  };
}

/**
 * Merge resources from multiple sessions into a single deduplicated list.
 * Resources with the same key get merged: access counts sum, arrays union.
 */
function aggregateResources(sessionResources: CachedResource[]): CachedResource[] {
  const merged = new Map<string, CachedResource>();

  for (const r of sessionResources) {
    const existing = merged.get(r.key);
    if (existing) {
      existing.accessCount += r.accessCount;
      // Merge commands
      for (const cmd of r.commands) {
        if (!existing.commands.includes(cmd)) existing.commands.push(cmd);
      }
      // Merge timestamps
      if (r.firstSeen && (!existing.firstSeen || r.firstSeen < existing.firstSeen)) {
        existing.firstSeen = r.firstSeen;
      }
      if (r.lastSeen && (!existing.lastSeen || r.lastSeen > existing.lastSeen)) {
        existing.lastSeen = r.lastSeen;
      }
      // Merge db tables
      if (r.dbTables) {
        if (!existing.dbTables) existing.dbTables = [];
        for (const t of r.dbTables) {
          if (!existing.dbTables.includes(t)) existing.dbTables.push(t);
        }
      }
      // Merge db operations
      if (r.dbOperations) {
        if (!existing.dbOperations) existing.dbOperations = [];
        for (const op of r.dbOperations) {
          if (!existing.dbOperations.includes(op)) existing.dbOperations.push(op);
        }
      }
    } else {
      merged.set(r.key, { ...r, commands: [...r.commands], dbTables: r.dbTables ? [...r.dbTables] : undefined, dbOperations: r.dbOperations ? [...r.dbOperations] : undefined });
    }
  }

  // Sort by access count descending
  return Array.from(merged.values()).sort((a, b) => b.accessCount - a.accessCount);
}

function derivePurpose(types: Record<string, number>, titles: string[]): string {
  // Prefer the most recent milestone title — it's more descriptive than type names
  if (titles.length > 0) {
    const latest = titles[titles.length - 1];
    // Append dominant type tag if available
    const sorted = Object.entries(types).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) {
      return `${latest} (${sorted[0][0]})`;
    }
    return latest;
  }
  // Fallback to dominant type names
  const sorted = Object.entries(types).sort((a, b) => b[1] - a[1]);
  const dominant = sorted.slice(0, 2).map(([t]) => t).join(', ');
  return dominant || 'unknown';
}

// ─── Output Formatting ──────────────────────────────────────────

/**
 * Part-based access: return a specific section of the architecture.
 */
export function formatPart(arch: CachedArchitecture, part: string): string {
  const lines: string[] = [];

  // LLM model parts
  const modelCache = loadModelCache(arch.project);
  const model = modelCache?.model;

  switch (part) {
    case 'services':
      if (!model || model.services.length === 0) {
        return emptyPartResponse('No services discovered yet. Architecture model has not been generated.', part);
      }
      lines.push(`## Services (${model.services.length})`);
      lines.push('');
      for (const svc of model.services) {
        const portStr = svc.port ? `:${svc.port}` : '';
        const techStr = svc.technologies.length > 0 ? ` [${svc.technologies.join(', ')}]` : '';
        lines.push(`- **${svc.name}** (${svc.type}${portStr})${techStr}`);
        lines.push(`  ${svc.description}`);
        if (svc.responsibilities.length > 0) {
          for (const r of svc.responsibilities) {
            lines.push(`  - ${r}`);
          }
        }
      }
      break;

    case 'connections':
      if (!model || model.connections.length === 0) {
        return emptyPartResponse('No connections discovered yet. Architecture model has not been generated.', part);
      }
      lines.push(`## Connections (${model.connections.length})`);
      lines.push('');
      for (const conn of model.connections) {
        const portStr = conn.port ? ` :${conn.port}` : '';
        lines.push(`- ${conn.from} → ${conn.to} (${conn.type}${portStr}) — ${conn.label}`);
      }
      break;

    case 'databases':
      if (!model || model.databases.length === 0) {
        return emptyPartResponse('No databases discovered yet. Architecture model has not been generated.', part);
      }
      lines.push(`## Databases (${model.databases.length})`);
      lines.push('');
      for (const db of model.databases) {
        lines.push(`- **${db.name}** (${db.system})`);
        if (db.tables.length > 0) {
          lines.push(`  Tables: ${db.tables.join(', ')}`);
        }
        if (db.usedBy.length > 0) {
          lines.push(`  Used by: ${db.usedBy.join(', ')}`);
        }
      }
      break;

    case 'data_flows':
      if (!model || model.dataFlows.length === 0) {
        return emptyPartResponse('No data flows discovered yet. Architecture model has not been generated.', part);
      }
      lines.push(`## Data Flows (${model.dataFlows.length})`);
      lines.push('');
      for (const flow of model.dataFlows) {
        lines.push(`**${flow.name}**: ${flow.description}`);
        for (const step of flow.steps) {
          lines.push(`  ${step}`);
        }
        lines.push('');
      }
      break;

    case 'diagram':
      if (!model || !model.mermaidDiagram) {
        return emptyPartResponse('No diagram available yet. Architecture model has not been generated.', part);
      }
      lines.push('## Architecture Diagram');
      lines.push('');
      lines.push('```mermaid');
      lines.push(model.mermaidDiagram);
      lines.push('```');
      break;

    case 'components':
      if (arch.components.length === 0) {
        return emptyPartResponse('No components found in session history.', part);
      }
      lines.push(`## Components (${arch.components.length} directories)`);
      lines.push('');
      for (const comp of arch.components.slice(0, 30)) {
        const typeStr = Object.entries(comp.types)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([t, n]) => `${t}:${n}`)
          .join(' ');
        const dirLabel = comp.directory === '(project root)' ? comp.directory : `${comp.directory}/`;
        const tempTag = comp.temperature === 'cold' ? ' [cold]' : comp.temperature === 'warm' ? ' [warm]' : '';
        lines.push(`- **${dirLabel}**${tempTag} — ${comp.fileCount} files, ${comp.milestoneCount} milestones | ${typeStr}`);
      }
      if (arch.components.length > 30) {
        lines.push(`- ... and ${arch.components.length - 30} more`);
      }
      break;

    case 'key_files':
      if (arch.keyFiles.length === 0) {
        return emptyPartResponse('No key files found in session history.', part);
      }
      lines.push(`## Key Files (${arch.keyFiles.length} most active)`);
      lines.push('');
      for (const f of arch.keyFiles) {
        let detail = `${f.modifyCount}W ${f.readCount}R`;
        if (f.lastMilestoneTitle) {
          detail += ` | last: "${f.lastMilestoneTitle}"`;
        }
        lines.push(`- **${f.filePath}** — ${detail}`);
      }
      break;

    case 'resources':
      if (!arch.resources || arch.resources.length === 0) {
        return emptyPartResponse('No resources found in session history.', part);
      }
      lines.push(`## Resources (${arch.resources.length})`);
      lines.push('');
      for (const r of arch.resources.slice(0, 20)) {
        let detail = `${r.accessCount}x | ${r.commands.join(', ')}`;
        if (r.dbTables && r.dbTables.length > 0) {
          detail += ` | tables: ${r.dbTables.slice(0, 8).join(', ')}`;
        }
        lines.push(`- **${r.name}** [${r.category}] — ${detail}`);
      }
      break;

    default:
      return `Unknown part: "${part}". Valid parts: services, connections, databases, data_flows, diagram, components, key_files, resources`;
  }

  // Append staleness hint for LLM model parts
  if (['services', 'connections', 'databases', 'data_flows', 'diagram'].includes(part) && modelCache) {
    const currentHash = computeInputHash(arch.project, arch.resources?.length || 0);
    if (modelCache.inputHash !== currentHash) {
      const genDate = modelCache.generatedAt ? new Date(modelCache.generatedAt).toISOString().slice(0, 10) : 'unknown';
      const checkedDate = modelCache.lastCheckedAt ? new Date(modelCache.lastCheckedAt).toISOString().slice(0, 10) : null;
      const checkedStr = checkedDate && checkedDate !== genDate ? `, last checked ${checkedDate}` : '';
      lines.push('');
      lines.push(`> Architecture model may be outdated (generated ${genDate}${checkedStr}).`);
    }
  }

  // Navigation hints
  lines.push('');
  lines.push(`→ project_architecture() for index | project_architecture({part: "${getRelatedPart(part)}"}) for related data`);

  return lines.join('\n');
}

function emptyPartResponse(msg: string, part: string): string {
  return `${msg}\n\n→ project_architecture() for index | project_architecture({part: "${getRelatedPart(part)}"}) for related data`;
}

function getRelatedPart(part: string): string {
  const related: Record<string, string> = {
    services: 'connections',
    connections: 'services',
    databases: 'data_flows',
    data_flows: 'databases',
    diagram: 'services',
    components: 'key_files',
    key_files: 'components',
    resources: 'services',
  };
  return related[part] || 'services';
}

/**
 * Overview mode (default) — lightweight index.
 * ~1 line per directory, stats summary, drill-down hints.
 * Designed to be ~50 lines, not 300+.
 */
function formatOverview(arch: CachedArchitecture): string {
  const lines: string[] = [];
  const resourceCount = arch.resources?.length || 0;

  lines.push(`# Project Architecture: ${path.basename(arch.project)} (${arch.milestoneCount} milestones)`);
  lines.push('');

  // Directory Index — top 15 by milestone count, one line each
  if (arch.components.length > 0) {
    const top = arch.components.slice(0, 15);
    lines.push(`## Directory Index (top ${top.length} by activity)`);
    for (const comp of top) {
      const dirLabel = comp.directory === '(project root)' ? '(root)' : `${comp.directory}/`;
      const topTypes = Object.entries(comp.types)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([t, n]) => `${t}:${n}`)
        .join(' ');
      const pad1 = dirLabel.length < 40 ? ' '.repeat(Math.max(1, 42 - dirLabel.length)) : ' ';
      lines.push(`  ${dirLabel}${pad1}${String(comp.fileCount).padStart(3)} files  ${String(comp.milestoneCount).padStart(4)}ms  ${comp.temperature.padEnd(4)}  ${topTypes}`);
    }
    if (arch.components.length > 15) {
      lines.push(`  ... and ${arch.components.length - 15} more directories`);
    }
    lines.push('');
  }

  // Key Stats summary
  lines.push('## Key Stats');
  lines.push(`  ${arch.keyFiles.length} key files (most modified) → part="key_files"`);
  lines.push(`  ${resourceCount} resources (APIs, DBs, SSH) → part="resources"`);
  if (arch.externalProjects && arch.externalProjects.length > 0) {
    lines.push(`  ${arch.externalProjects.length} external projects → part="components" for cross-project view`);
  }
  lines.push('');

  // System Model summary (counts only, not full model)
  try {
    const modelCache = loadModelCache(arch.project);
    if (modelCache?.model) {
      const m = modelCache.model;
      const genDate = modelCache.generatedAt ? new Date(modelCache.generatedAt).toISOString().slice(0, 10) : 'unknown';
      lines.push(`## System Model (generated ${genDate})`);
      lines.push(`  ${m.services.length} services, ${m.connections.length} connections, ${m.databases.length} databases, ${m.dataFlows.length} data flows`);
      lines.push(`  → part="services" | "connections" | "databases" | "data_flows" | "diagram"`);

      // Check staleness
      const currentHash = computeInputHash(arch.project, resourceCount);
      if (modelCache.inputHash !== currentHash) {
        const checkedDate = modelCache.lastCheckedAt ? new Date(modelCache.lastCheckedAt).toISOString().slice(0, 10) : null;
        const checkedStr = checkedDate && checkedDate !== genDate ? `, last checked ${checkedDate}` : '';
        lines.push(`  > Model may be outdated (generated ${genDate}${checkedStr}).`);
      }
      lines.push('');
    }
  } catch { /* ignore — LLM model is optional */ }

  // Drill Down hints
  lines.push('## Drill Down');
  const exampleDirs = arch.components
    .filter(c => c.directory !== '(project root)')
    .slice(0, 2);
  for (const ex of exampleDirs) {
    lines.push(`  → project_architecture({directory: "${ex.directory}"})`);
  }
  lines.push(`  → project_architecture({part: "services"})`);
  lines.push(`  → project_architecture({part: "key_files"})`);

  return lines.join('\n');
}

/**
 * Directory detail mode — full info for a specific directory and its children.
 */
function formatDirectoryDetail(
  arch: CachedArchitecture,
  directory: string,
  sections: Set<string> | null
): string {
  const lines: string[] = [];
  const showAll = !sections;

  // Normalize: strip trailing slash
  const dir = directory.replace(/\/+$/, '');
  const isRoot = dir === '.' || dir === '';

  // Find matching components (exact match + children)
  const matchingComponents = isRoot
    ? arch.components
    : arch.components.filter(c => {
        const d = c.directory === '(project root)' ? '.' : c.directory;
        return d === dir || d.startsWith(dir + '/');
      });

  // Find matching key files
  const matchingFiles = isRoot
    ? arch.keyFiles
    : arch.keyFiles.filter(f =>
        f.filePath.startsWith(dir + '/') || path.dirname(f.filePath) === dir
      );

  if (matchingComponents.length === 0 && matchingFiles.length === 0) {
    lines.push(`No data found for directory: ${dir}`);
    lines.push('');
    lines.push('Available directories:');
    for (const comp of arch.components.slice(0, 10)) {
      const label = comp.directory === '(project root)' ? '.' : comp.directory;
      lines.push(`  -> project_architecture({directory: "${label}"})`);
    }
    return lines.join('\n');
  }

  lines.push(`# Directory Detail: ${dir}/`);
  lines.push(`Project: ${arch.project}`);
  lines.push('');

  // Full component detail
  if ((showAll || sections!.has('components')) && matchingComponents.length > 0) {
    lines.push(`## Components (${matchingComponents.length} subdirectories)`);
    lines.push('');

    for (const comp of matchingComponents) {
      const typeStr = Object.entries(comp.types)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t}:${n}`)
        .join(' ');

      const dirLabel = comp.directory === '(project root)' ? comp.directory : `${comp.directory}/`;
      lines.push(`### ${dirLabel}`);
      lines.push(`${comp.purpose}`);
      lines.push(`${comp.fileCount} files | ${comp.milestoneCount} milestones | ${typeStr}`);

      if (comp.recentMilestones.length > 0) {
        for (const title of comp.recentMilestones) {
          lines.push(`  - ${title}`);
        }
      }
      lines.push('');
    }
  }

  // Full key files for this directory
  if ((showAll || sections!.has('key_files')) && matchingFiles.length > 0) {
    lines.push(`## Key Files (${matchingFiles.length})`);
    lines.push('');

    for (const f of matchingFiles) {
      let detail = `${f.modifyCount}W ${f.readCount}R`;
      if (f.lastMilestoneTitle) {
        detail += ` | last: "${f.lastMilestoneTitle}"`;
      }
      if (f.lastMilestoneId) {
        detail += ` -> milestone_detail("${f.lastMilestoneId}")`;
      }
      lines.push(`- **${f.filePath}** — ${detail}`);
    }
    lines.push('');
  }

  // Navigation hints
  lines.push('---');
  lines.push('→ project_architecture() for index');
  // Suggest a subdirectory if the current directory has children
  const childDirs = arch.components
    .filter(c => {
      const d = c.directory === '(project root)' ? '.' : c.directory;
      return d !== dir && d.startsWith(dir + '/') && d.indexOf('/', dir.length + 1) === -1;
    })
    .slice(0, 2);
  for (const child of childDirs) {
    lines.push(`→ project_architecture({directory: "${child.directory}"}) for subdirectory`);
  }

  return lines.join('\n');
}

/**
 * Full section view — used when include filters specific sections for full detail.
 * Falls back to this when include is set but no directory.
 */
function formatSectionsFull(arch: CachedArchitecture, sections: Set<string>): string {
  const lines: string[] = [];

  lines.push(`# Project Architecture: ${arch.project}`);
  lines.push(`${arch.milestoneCount} milestones analyzed`);
  lines.push('');

  if (sections.has('key_files') && arch.keyFiles.length > 0) {
    lines.push(`## Key Files (${arch.keyFiles.length} most active)`);
    lines.push('');

    for (const f of arch.keyFiles) {
      let detail = `${f.modifyCount}W ${f.readCount}R`;
      if (f.lastMilestoneTitle) {
        detail += ` | last: "${f.lastMilestoneTitle}"`;
      }
      if (f.lastMilestoneId) {
        detail += ` -> milestone_detail("${f.lastMilestoneId}")`;
      }
      lines.push(`- **${f.filePath}** — ${detail}`);
    }
    lines.push('');
  }

  if (sections.has('components') && arch.components.length > 0) {
    lines.push(`## Components (${arch.components.length} directories)`);
    lines.push('');

    for (const comp of arch.components.slice(0, 30)) {
      const typeStr = Object.entries(comp.types)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t}:${n}`)
        .join(' ');

      const dirLabel = comp.directory === '(project root)' ? comp.directory : `${comp.directory}/`;
      lines.push(`### ${dirLabel}`);
      lines.push(`${comp.purpose}`);
      lines.push(`${comp.fileCount} files | ${comp.milestoneCount} milestones | ${typeStr}`);

      if (comp.recentMilestones.length > 0) {
        for (const title of comp.recentMilestones) {
          lines.push(`  - ${title}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('→ project_architecture() for index');

  return lines.join('\n');
}

// ─── Cache I/O ──────────────────────────────────────────

function cacheKey(project: string): string {
  return project.replace(/\//g, '_').replace(/^_/, '');
}

function loadCache(project: string): CachedArchitecture | null {
  const file = path.join(CACHE_DIR, `${cacheKey(project)}.json`);
  try {
    if (fs.existsSync(file)) {
      const cached = JSON.parse(fs.readFileSync(file, 'utf-8')) as CachedArchitecture;
      // Invalidate old cache versions
      if (cached.cacheVersion !== CACHE_VERSION) return null;
      return cached;
    }
  } catch { /* ignore */ }
  return null;
}

function saveCache(project: string, arch: CachedArchitecture): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    const file = path.join(CACHE_DIR, `${cacheKey(project)}.json`);
    fs.writeFileSync(file, JSON.stringify(arch, null, 2));
  } catch { /* ignore */ }
}

// ─── Helpers ──────────────────────────────────────────

function detectMostActiveProject(
  sessions: Array<{ sessionId: string; filePath: string; cacheData: any }>
): string | null {
  // Use milestone index (cheap) instead of loading milestones for every session
  const milestoneStore = getMilestoneStore();
  const index = milestoneStore.getIndex();
  const projectCounts = new Map<string, number>();

  // Build sessionId → project mapping from cache
  const sessionProjectMap = new Map<string, string>();
  for (const { sessionId, filePath, cacheData } of sessions) {
    const project = cacheData.cwd || getProjectPathForSession(cacheData, filePath);
    if (project) sessionProjectMap.set(sessionId, project);
  }

  // Count milestones per project using the index (no disk reads)
  for (const [sessionId, entry] of Object.entries(index.sessions)) {
    const project = sessionProjectMap.get(sessionId);
    if (project && entry.milestoneCount > 0) {
      projectCounts.set(project, (projectCounts.get(project) || 0) + entry.milestoneCount);
    }
  }

  if (projectCounts.size === 0) return null;

  let best = '';
  let bestCount = 0;
  for (const [project, count] of projectCounts) {
    if (count > bestCount) {
      best = project;
      bestCount = count;
    }
  }
  return best || null;
}
