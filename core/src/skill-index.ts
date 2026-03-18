/**
 * Skill Index — Cross-session skill analytics with lazy materialization.
 *
 * Tracks skill invocations across all sessions. Builds itself lazily as
 * sessions are loaded into cache via SessionCache.onSessionChange().
 * Persists to ~/.lm-assist/skills/index.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDataDir } from './utils/path-utils';
import type { SessionCacheData, CachedSkillInvocation } from './session-cache';

// ─── Types ──────────────────────────────────────────────────

export interface InstalledSkill {
  skillName: string;
  pluginName: string;
  shortName: string;
  description: string;
  pluginVersion: string;
  installPath: string;
  hasUsage: boolean;
}

export interface SkillIndexEntry {
  skillName: string;
  pluginName: string;
  shortName: string;
  totalInvocations: number;
  successCount: number;
  failCount: number;
  lastUsed: string;
  firstUsed: string;
  sessions: Array<{
    sessionId: string;
    project: string;
    timestamp: string;
    success?: boolean;
    toolUseCount: number;
    subagentCount: number;
    isSubagentSession: boolean;
  }>;
}

export interface SkillIndexData {
  version: number;
  lastUpdated: string;
  skills: Record<string, SkillIndexEntry>;
  indexedSessions: Record<string, number>;
}

export interface SkillTrace {
  invocation: CachedSkillInvocation;
  sessionId: string;
  project: string;
  totalToolUses: number;
  totalFilesRead: string[];
  totalFilesWritten: string[];
  totalSubagents: number;
  durationMs?: number;
  children: SkillTrace[];
}

// ─── Constants ──────────────────────────────────────────────

const INDEX_VERSION = 1;
const MAX_SESSIONS_PER_SKILL = 200;
const FLUSH_DEBOUNCE_MS = 1000;

// ─── SkillIndex Class ──────────────────────────────────────

export class SkillIndex {
  private indexPath: string;
  private data: SkillIndexData;
  private installedSkills: InstalledSkill[] = [];
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private initialized = false;

  constructor() {
    const dir = path.join(getDataDir(), 'skills');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.indexPath = path.join(dir, 'index.json');
    this.data = this.loadFromDisk();
    this.scanInstalledSkills();
    this.registerShutdownHooks();
    this.initialized = true;
  }

  // ─── Installed Skills ──────────────────────────────────────

  getInstalledSkills(): InstalledSkill[] {
    return this.installedSkills;
  }

  refreshInventory(): void {
    this.scanInstalledSkills();
  }

  /**
   * Resolve a non-namespaced skill name to its namespaced form.
   * Returns null if no unique match found.
   */
  resolveSkillName(shortName: string): { pluginName: string; skillName: string } | null {
    const matches = this.installedSkills.filter(s => s.shortName === shortName);
    if (matches.length === 1) {
      return { pluginName: matches[0].pluginName, skillName: matches[0].skillName };
    }
    return null;
  }

  // ─── Index Operations ──────────────────────────────────────

  getIndexData(): SkillIndexData {
    return this.data;
  }

  getSkillEntry(skillName: string): SkillIndexEntry | undefined {
    return this.data.skills[skillName];
  }

  getAllEntries(): SkillIndexEntry[] {
    return Object.values(this.data.skills);
  }

  /**
   * Called by SessionCache.onSessionChange() — indexes skill invocations from a session.
   */
  onSessionUpdate(sessionId: string, cacheData: SessionCacheData): void {
    // Skip if already indexed at this file size
    if (this.data.indexedSessions[sessionId] === cacheData.fileSize) return;
    if (!cacheData.skillInvocations || cacheData.skillInvocations.length === 0) {
      this.data.indexedSessions[sessionId] = cacheData.fileSize;
      this.scheduleDiskFlush();
      return;
    }

    const isSubagent = cacheData.filePath.includes('/subagents/');
    const project = cacheData.cwd || '';

    // Remove old entries for this session from all skills
    for (const entry of Object.values(this.data.skills)) {
      entry.sessions = entry.sessions.filter(s => s.sessionId !== sessionId);
    }

    // Add new entries
    for (const skill of cacheData.skillInvocations) {
      const key = skill.skillName;
      if (!this.data.skills[key]) {
        this.data.skills[key] = {
          skillName: skill.skillName,
          pluginName: skill.pluginName,
          shortName: skill.shortName,
          totalInvocations: 0,
          successCount: 0,
          failCount: 0,
          lastUsed: '',
          firstUsed: '',
          sessions: [],
        };
      }

      const entry = this.data.skills[key];
      entry.totalInvocations++;
      if (skill.success === true) entry.successCount++;
      if (skill.success === false) entry.failCount++;

      const ts = skill.timestamp || '';
      if (!entry.firstUsed || ts < entry.firstUsed) entry.firstUsed = ts;
      if (!entry.lastUsed || ts > entry.lastUsed) entry.lastUsed = ts;

      entry.sessions.push({
        sessionId,
        project,
        timestamp: ts,
        success: skill.success,
        toolUseCount: skill.toolUseCount,
        subagentCount: skill.subagentIds.length,
        isSubagentSession: isSubagent,
      });

      // Cap sessions
      if (entry.sessions.length > MAX_SESSIONS_PER_SKILL) {
        entry.sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        entry.sessions = entry.sessions.slice(0, MAX_SESSIONS_PER_SKILL);
      }
    }

    this.data.indexedSessions[sessionId] = cacheData.fileSize;
    this.data.lastUpdated = new Date().toISOString();
    this.scheduleDiskFlush();
  }

  /**
   * Force full reindex — clears and rebuilds from all cached sessions.
   */
  async reindex(
    getSessionData: (sessionPath: string) => SessionCacheData | null,
    sessionPaths: string[]
  ): Promise<{ indexed: number; skills: number }> {
    // Reset
    this.data.skills = {};
    this.data.indexedSessions = {};

    let indexed = 0;
    for (const sp of sessionPaths) {
      const cacheData = getSessionData(sp);
      if (cacheData && cacheData.skillInvocations?.length > 0) {
        this.onSessionUpdate(cacheData.sessionId, cacheData);
        indexed++;
      }
    }

    this.flushToDisk();
    return { indexed, skills: Object.keys(this.data.skills).length };
  }

  // ─── Chain Detection ──────────────────────────────────────

  detectChains(): Array<{ sequence: string[]; occurrences: number; projects: string[] }> {
    const chainCounts = new Map<string, { count: number; projects: Set<string> }>();

    // Group skill invocations by session
    const sessionSkills = new Map<string, Array<{ shortName: string; project: string }>>();
    for (const entry of Object.values(this.data.skills)) {
      for (const sess of entry.sessions) {
        if (!sessionSkills.has(sess.sessionId)) {
          sessionSkills.set(sess.sessionId, []);
        }
        sessionSkills.get(sess.sessionId)!.push({
          shortName: entry.shortName,
          project: sess.project,
        });
      }
    }

    // For each session with 2+ skills, generate sliding windows
    for (const [_sessionId, skills] of sessionSkills) {
      if (skills.length < 2) continue;
      const names = skills.map(s => s.shortName);
      const project = skills[0]?.project || '';

      for (let windowLen = 2; windowLen <= Math.min(4, names.length); windowLen++) {
        for (let i = 0; i <= names.length - windowLen; i++) {
          const window = names.slice(i, i + windowLen);
          const key = window.join(' \u2192 ');
          if (!chainCounts.has(key)) {
            chainCounts.set(key, { count: 0, projects: new Set() });
          }
          const chainEntry = chainCounts.get(key)!;
          chainEntry.count++;
          chainEntry.projects.add(project);
        }
      }
    }

    // Filter and sort
    return Array.from(chainCounts.entries())
      .filter(([_, v]) => v.count >= 2)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 20)
      .map(([key, v]) => ({
        sequence: key.split(' \u2192 '),
        occurrences: v.count,
        projects: Array.from(v.projects),
      }));
  }

  // ─── Deep Trace Resolution ──────────────────────────────────

  async resolveTrace(
    sessionId: string,
    skill: CachedSkillInvocation,
    project: string,
    getSessionData: (sessionPath: string) => Promise<SessionCacheData | null>,
    findSubagentPath: (agentId: string) => string | null,
    depth = 0,
    maxDepth = 5
  ): Promise<SkillTrace> {
    const trace: SkillTrace = {
      invocation: skill,
      sessionId,
      project,
      totalToolUses: skill.toolUseCount,
      totalFilesRead: [...skill.filesRead],
      totalFilesWritten: [...skill.filesWritten],
      totalSubagents: skill.subagentIds.length,
      children: [],
    };

    if (depth >= maxDepth) return trace;

    // Resolve each subagent
    for (const agentId of skill.subagentIds) {
      const subPath = findSubagentPath(agentId);
      if (!subPath) continue;

      const subData = await getSessionData(subPath);
      if (!subData) continue;

      if (subData.skillInvocations?.length > 0) {
        for (const childSkill of subData.skillInvocations) {
          const childTrace = await this.resolveTrace(
            subData.sessionId,
            childSkill,
            project,
            getSessionData,
            findSubagentPath,
            depth + 1,
            maxDepth
          );
          trace.children.push(childTrace);
          trace.totalToolUses += childTrace.totalToolUses;
          trace.totalFilesRead.push(...childTrace.totalFilesRead);
          trace.totalFilesWritten.push(...childTrace.totalFilesWritten);
          trace.totalSubagents += childTrace.totalSubagents;
        }
      } else {
        // No skills in subagent — attribute all tool uses to parent
        trace.totalToolUses += subData.toolUses?.length || 0;
      }
    }

    // Deduplicate file lists
    trace.totalFilesRead = [...new Set(trace.totalFilesRead)];
    trace.totalFilesWritten = [...new Set(trace.totalFilesWritten)];

    return trace;
  }

  // ─── Private ──────────────────────────────────────────────

  private loadFromDisk(): SkillIndexData {
    try {
      if (fs.existsSync(this.indexPath)) {
        const raw = fs.readFileSync(this.indexPath, 'utf-8');
        const parsed = JSON.parse(raw) as SkillIndexData;
        if (parsed.version === INDEX_VERSION) return parsed;
      }
    } catch {
      // Corrupt file — start fresh
    }
    return {
      version: INDEX_VERSION,
      lastUpdated: new Date().toISOString(),
      skills: {},
      indexedSessions: {},
    };
  }

  private flushToDisk(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      fs.writeFileSync(this.indexPath, JSON.stringify(this.data, null, 2));
      this.dirty = false;
    } catch (err) {
      console.error('[SkillIndex] Failed to flush to disk:', err);
    }
  }

  private scheduleDiskFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) this.flushToDisk();
    }, FLUSH_DEBOUNCE_MS);
  }

  private registerShutdownHooks(): void {
    const flush = () => {
      if (this.dirty) this.flushToDisk();
    };
    process.on('SIGTERM', flush);
    process.on('SIGINT', flush);
  }

  private scanInstalledSkills(): void {
    this.installedSkills = [];
    const pluginsFile = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

    try {
      if (!fs.existsSync(pluginsFile)) return;
      const raw = JSON.parse(fs.readFileSync(pluginsFile, 'utf-8'));
      const plugins = raw.plugins || {};

      for (const [key, entries] of Object.entries(plugins) as [string, any[]][]) {
        const pluginName = key.split('@')[0];
        if (!Array.isArray(entries) || entries.length === 0) continue;

        const entry = entries[0]; // Use first (typically only) entry
        const installPath = entry.installPath;
        const version = entry.version || '';

        if (!installPath || !fs.existsSync(installPath)) continue;

        const skillsDir = path.join(installPath, 'skills');
        if (!fs.existsSync(skillsDir)) continue;

        let skillDirs: string[];
        try {
          skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
        } catch {
          continue;
        }

        for (const skillDir of skillDirs) {
          const skillPath = path.join(skillsDir, skillDir, 'SKILL.md');
          if (!fs.existsSync(skillPath)) continue;

          const { name, description } = this.parseFrontmatter(skillPath, skillDir);
          const shortName = name || skillDir;
          const fullName = `${pluginName}:${shortName}`;

          this.installedSkills.push({
            skillName: fullName,
            pluginName,
            shortName,
            description: description.slice(0, 200),
            pluginVersion: version,
            installPath: path.join(skillsDir, skillDir),
            hasUsage: !!this.data.skills[fullName],
          });
        }
      }
    } catch (err) {
      console.error('[SkillIndex] Failed to scan installed skills:', err);
    }
  }

  private parseFrontmatter(filePath: string, fallbackName: string): { name: string; description: string } {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!match) return { name: fallbackName, description: '' };

      const fm = match[1];
      const nameMatch = fm.match(/^name:\s*(.+)/m);
      const descMatch = fm.match(/^description:\s*["']?([\s\S]*?)["']?\s*$/m);

      return {
        name: nameMatch ? nameMatch[1].trim() : fallbackName,
        description: descMatch ? descMatch[1].trim() : '',
      };
    } catch {
      return { name: fallbackName, description: '' };
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────

let _instance: SkillIndex | null = null;

export function getSkillIndex(): SkillIndex {
  if (!_instance) {
    _instance = new SkillIndex();

    // Wire up SessionCache callback (lazy import to avoid circular deps)
    try {
      const { getSessionCache } = require('./session-cache');
      const cache = getSessionCache();
      cache.onSessionChange((sessionId: string, cacheData: SessionCacheData) => {
        _instance!.onSessionUpdate(sessionId, cacheData);
      });
    } catch {
      // SessionCache not ready yet — index will populate on first access
    }
  }
  return _instance;
}
