/**
 * Backup collector configuration.
 *
 * THE STORE IS ADOPTED, NOT INVENTED. `E:\claude-backup` on 107
 * (DESKTOP-GDKLATG) was built by a PowerShell script (`backup-claude.ps1`) that
 * this module replaces as the engine. Its directory layout, `status.json` shape
 * and private GitHub remote (`langmartai/claude-backup`) all keep working —
 * 4.7 GB of already-captured history stays valid, and the existing snapshots
 * become searchable the moment they are indexed.
 *
 * ONLY THE NODE THAT HAS A ROOT IS THE COLLECTOR. This is a measured constraint,
 * not a preference: on 2026-07-29 node 117 had 3.3 GB free on a 97%-full disk
 * while its own `~/.claude` was 6.8 GB. It cannot hold the store, and it cannot
 * repack a 2 GB snapshot. Every entry point therefore resolves the collector
 * first and returns a POINTER when called on the wrong node — `node:"..."` is a
 * routing parameter every lm-assist tool already has, so the caller's fix is one
 * argument rather than a diagnosis.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Where a node records its backup root, if it is a collector. */
const CONFIG_PATH = path.join(os.homedir(), '.lm-assist', 'backup.json');

/** Roots probed when nothing is configured — the adopted store first. */
const DEFAULT_ROOTS = ['E:\\claude-backup', path.join(os.homedir(), 'claude-backup')];

export type TargetName = 'windows-desk' | 'linux-117' | 'linux-123' | 'claudeai' | 'memory-rules';

export interface RemoteTarget {
  name: TargetName;
  /** SSH destination. Bare host on purpose — 107's ~/.ssh/config carries the
   *  per-host user (117=ubuntu, 123=yi). Prefixing user@ breaks it. */
  sshHost: string;
  /** Remote $HOME, so the tar is rooted correctly. */
  home: string;
}

export const REMOTE_TARGETS: RemoteTarget[] = [
  { name: 'linux-117', sshHost: '10.0.1.117', home: '/home/ubuntu' },
  { name: 'linux-123', sshHost: '10.0.1.123', home: '/home/yi' },
];

/** The collector's own `.claude`. `windows-desk` IS node 107 — 10.0.1.107 is
 *  this machine, not a separate host. The prior session had to discover that;
 *  it is recorded here so nobody looks for a missing fourth node. */
export const LOCAL_TARGET: TargetName = 'windows-desk';

export const ALL_TARGETS: TargetName[] = [
  'windows-desk', 'linux-117', 'linux-123', 'claudeai', 'memory-rules',
];

export interface BackupConfig {
  root: string;
  /** Source of the local mirror — the collector's live `.claude`. */
  localSource: string;
  /** Snapshots retained per remote target. */
  keepSnapshots: number;
  /** lm-assist base URL used by the claude.ai target. */
  claudeAiBaseUrl: string;
}

interface StoredConfig {
  root?: string;
  localSource?: string;
  keepSnapshots?: number;
  claudeAiBaseUrl?: string;
}

function readStored(): StoredConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as StoredConfig;
  } catch {
    return {};
  }
}

/** Resolve the backup root for THIS node, or null if it is not a collector. */
export function resolveRoot(): string | null {
  const stored = readStored();
  const candidates = [stored.root, process.env.LM_BACKUP_ROOT, ...DEFAULT_ROOTS];
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch { /* not present on this node */ }
  }
  return null;
}

/**
 * Full config, or null when this node holds no backup root.
 *
 * `localSource` defaults to the collector's own `~/.claude`. On 107 that is
 * `C:\Users\admin\.claude`, which is what `os.homedir()` returns for the account
 * Core runs as — so it needs no special-casing, only an override for the case
 * where Core runs as a different user than the one being backed up.
 */
export function loadConfig(): BackupConfig | null {
  const root = resolveRoot();
  if (!root) return null;
  const stored = readStored();
  return {
    root,
    localSource: stored.localSource || path.join(os.homedir(), '.claude'),
    keepSnapshots: stored.keepSnapshots ?? 5,
    claudeAiBaseUrl: stored.claudeAiBaseUrl || 'http://localhost:3100',
  };
}

/** Directory of a target inside the root. */
export function targetDir(cfg: BackupConfig, target: TargetName): string {
  return path.join(cfg.root, target);
}

/** Paths of the store's bookkeeping files. */
export function storePaths(cfg: BackupConfig) {
  return {
    statusJson: path.join(cfg.root, 'status.json'),
    statusMd: path.join(cfg.root, 'STATUS.md'),
    historyLog: path.join(cfg.root, 'logs', 'history.log'),
    excludes: path.join(cfg.root, 'excludes.json'),
    removals: path.join(cfg.root, 'removals.jsonl'),
    currentRun: path.join(cfg.root, '.current-run.json'),
    indexDb: path.join(cfg.root, 'index.db'),
  };
}

/**
 * The error a non-collector returns. It names the collector so the caller's
 * next call is a copy-paste, not an investigation.
 */
export const NOT_COLLECTOR_HINT =
  'This node holds no backup root, so it is not the backup collector. The collector is ' +
  'DESKTOP-GDKLATG (node 107), where the store lives at E:\\claude-backup — re-call with ' +
  'node:"DESKTOP-GDKLATG". Node 117 deliberately cannot be a collector: it has ~3 GB free ' +
  'against its own 6.8 GB ~/.claude and could not hold or repack a snapshot.';
