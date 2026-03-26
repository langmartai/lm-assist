/**
 * Learning Store
 *
 * Captures signals from every user prompt to evolve project and session summaries.
 * Each interaction teaches us something — keywords, features used, commands run,
 * routing decisions made. Over time, summaries become comprehensive enough that
 * deep scans are rarely needed.
 *
 * Signal types:
 *   - keyword: a term/feature the user mentioned for this project
 *   - command: a command the user ran or asked about
 *   - endpoint: an API endpoint that was used
 *   - area: a project area the user worked in
 *   - routing: a routing decision (which session was chosen and why)
 *   - correction: user corrected a routing decision (wrong project/session)
 *   - workflow: a workflow pattern observed (sequence of actions)
 *
 * Storage: ~/.lm-assist/learning-signals.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './utils/path-utils';

export interface LearningSignal {
  /** Signal ID */
  id: string;
  /** What type of signal */
  type: 'keyword' | 'command' | 'endpoint' | 'area' | 'routing' | 'correction' | 'workflow';
  /** The value learned (e.g., keyword: "delta analysis", command: "./core.sh build") */
  value: string;
  /** Which project this signal applies to */
  projectPath?: string;
  projectName?: string;
  /** Which session this signal came from */
  sessionId?: string;
  sessionDisplayName?: string;
  /** Frequency — how many times this signal has been observed */
  count: number;
  /** When first observed */
  firstSeen: string;
  /** When last observed */
  lastSeen: string;
}

const STORE_FILE = path.join(getDataDir(), 'learning-signals.json');

let signals: LearningSignal[] | null = null;
let storeMtime = 0;

function ensureLoaded(): LearningSignal[] {
  if (signals) {
    try {
      const stat = fs.statSync(STORE_FILE);
      if (stat.mtimeMs !== storeMtime) signals = null;
    } catch {}
  }
  if (!signals) {
    signals = [];
    try {
      if (fs.existsSync(STORE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
        if (Array.isArray(data)) signals = data;
        storeMtime = fs.statSync(STORE_FILE).mtimeMs;
      }
    } catch {}
  }
  return signals;
}

function persist(): void {
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(signals, null, 2));
  storeMtime = fs.statSync(STORE_FILE).mtimeMs;
}

/**
 * Record a learning signal. If the same type+value+project already exists, increment count.
 */
export function recordSignal(input: {
  type: LearningSignal['type'];
  value: string;
  projectPath?: string;
  projectName?: string;
  sessionId?: string;
  sessionDisplayName?: string;
}): LearningSignal {
  const s = ensureLoaded();
  const now = new Date().toISOString();

  // Find existing signal with same type+value+project
  const existing = s.find(sig =>
    sig.type === input.type &&
    sig.value === input.value &&
    (sig.projectPath || '') === (input.projectPath || '')
  );

  if (existing) {
    existing.count++;
    existing.lastSeen = now;
    if (input.sessionId) existing.sessionId = input.sessionId;
    if (input.sessionDisplayName) existing.sessionDisplayName = input.sessionDisplayName;
    persist();
    return existing;
  }

  const signal: LearningSignal = {
    id: `ls-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    type: input.type,
    value: input.value,
    projectPath: input.projectPath,
    projectName: input.projectName,
    sessionId: input.sessionId,
    sessionDisplayName: input.sessionDisplayName,
    count: 1,
    firstSeen: now,
    lastSeen: now,
  };
  s.push(signal);
  persist();
  return signal;
}

/**
 * Record multiple signals at once (batch from a single prompt).
 */
export function recordSignals(inputs: Array<{
  type: LearningSignal['type'];
  value: string;
  projectPath?: string;
  projectName?: string;
  sessionId?: string;
  sessionDisplayName?: string;
}>): number {
  let count = 0;
  for (const input of inputs) {
    recordSignal(input);
    count++;
  }
  return count;
}

/**
 * Get top signals for a project, ordered by frequency.
 */
export function getProjectSignals(projectPath: string, type?: LearningSignal['type']): LearningSignal[] {
  const s = ensureLoaded();
  return s
    .filter(sig => sig.projectPath === projectPath && (!type || sig.type === type))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get all signals grouped by project.
 */
export function getAllSignals(): { signals: LearningSignal[]; total: number; byProject: Record<string, number> } {
  const s = ensureLoaded();
  const byProject: Record<string, number> = {};
  for (const sig of s) {
    const proj = sig.projectName || sig.projectPath?.split('/').pop() || 'unknown';
    byProject[proj] = (byProject[proj] || 0) + 1;
  }
  return { signals: s, total: s.length, byProject };
}

/**
 * Get a learning context string for a project — what we've learned so far.
 * Used when regenerating project summaries to include accumulated knowledge.
 */
export function getProjectLearningContext(projectPath: string): string {
  const sigs = getProjectSignals(projectPath);
  if (sigs.length === 0) return '';

  const parts: string[] = [];

  const keywords = sigs.filter(s => s.type === 'keyword').slice(0, 15);
  if (keywords.length) parts.push(`Frequently mentioned: ${keywords.map(k => `${k.value}(${k.count}x)`).join(', ')}`);

  const commands = sigs.filter(s => s.type === 'command').slice(0, 10);
  if (commands.length) parts.push(`Commands used: ${commands.map(c => `${c.value}(${c.count}x)`).join(', ')}`);

  const endpoints = sigs.filter(s => s.type === 'endpoint').slice(0, 10);
  if (endpoints.length) parts.push(`Endpoints called: ${endpoints.map(e => `${e.value}(${e.count}x)`).join(', ')}`);

  const areas = sigs.filter(s => s.type === 'area').slice(0, 10);
  if (areas.length) parts.push(`Areas worked in: ${areas.map(a => `${a.value}(${a.count}x)`).join(', ')}`);

  const routings = sigs.filter(s => s.type === 'routing').slice(0, 5);
  if (routings.length) parts.push(`Routing patterns: ${routings.map(r => r.value).join('; ')}`);

  const corrections = sigs.filter(s => s.type === 'correction');
  if (corrections.length) parts.push(`Routing corrections: ${corrections.map(c => c.value).join('; ')}`);

  return parts.join('\n');
}

/**
 * Clean up old signals (keep top N per project, remove signals older than 30 days with count=1).
 */
export function cleanupSignals(): number {
  const s = ensureLoaded();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const before = s.length;
  signals = s.filter(sig =>
    sig.count > 1 || new Date(sig.lastSeen).getTime() > cutoff
  );
  if (signals.length < before) persist();
  return before - signals.length;
}
