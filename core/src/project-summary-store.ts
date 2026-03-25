/**
 * Project Summary Store
 *
 * Persistent per-project summaries for understanding what each project is about.
 * Used for routing prompts to the right project's sessions.
 *
 * Storage: ~/.lm-assist/project-summaries.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './utils/path-utils';

export interface ProjectSummary {
  /** Project path (e.g. /home/ubuntu/lm-assist) */
  projectPath: string;
  /** Short project name (last path segment) */
  projectName: string;
  /** What this project is — 1-2 sentence description */
  summary: string;
  /** Key technologies / stack */
  stack?: string[];
  /** Main areas of the project (e.g. "core API", "web UI", "hooks") */
  areas?: string[];
  /** Recent focus — what work has been happening lately */
  recentFocus?: string;
  /** Total session count at time of summary */
  sessionCount?: number;
  /** Service management — how to start/stop/restart/status */
  services?: string;
  /** Key commands — most frequently used commands and operations */
  keyCommands?: string;
  /** Project structure — key directories and their purpose */
  structure?: string;
  /** Key endpoints or APIs — most used entry points */
  keyEndpoints?: string;
  /** Common workflows — what users do most often */
  commonWorkflows?: string;
  /** Deployment — how to deploy, where it runs, prod/staging setup */
  deployment?: string;
  /** Important notes — gotchas, constraints, rules */
  importantNotes?: string;
  /** Full comprehensive reference (markdown) — everything the agent needs to know */
  fullReference?: string;
  /** When the summary was last updated */
  updatedAt: string;
}

const STORE_FILE = path.join(getDataDir(), 'project-summaries.json');

let store: Map<string, ProjectSummary> | null = null;
let storeMtime = 0;

function ensureLoaded(): Map<string, ProjectSummary> {
  if (store) {
    try {
      const stat = fs.statSync(STORE_FILE);
      if (stat.mtimeMs !== storeMtime) store = null;
    } catch {}
  }
  if (!store) {
    store = new Map();
    try {
      if (fs.existsSync(STORE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
        if (Array.isArray(data)) {
          for (const entry of data) {
            if (entry.projectPath) store.set(entry.projectPath, entry);
          }
        }
        storeMtime = fs.statSync(STORE_FILE).mtimeMs;
      }
    } catch {}
  }
  return store;
}

function persist(): void {
  const s = ensureLoaded();
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify([...s.values()], null, 2));
  storeMtime = fs.statSync(STORE_FILE).mtimeMs;
}

export function getProjectSummary(projectPath: string): ProjectSummary | null {
  return ensureLoaded().get(projectPath) || null;
}

export function getAllProjectSummaries(): ProjectSummary[] {
  return [...ensureLoaded().values()];
}

export function saveProjectSummary(summary: ProjectSummary): void {
  const s = ensureLoaded();
  summary.updatedAt = new Date().toISOString();
  s.set(summary.projectPath, summary);
  persist();
}

export function deleteProjectSummary(projectPath: string): boolean {
  const s = ensureLoaded();
  const existed = s.delete(projectPath);
  if (existed) persist();
  return existed;
}
