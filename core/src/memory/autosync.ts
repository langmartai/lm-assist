/**
 * Memory Auto-Sync Daemon — Stream A (write side), cross-node sync.
 *
 * Realizes the design-doc §4 / §10 pipeline:
 *
 *   watch (MemoryCache chokidar) → detect record-level delta (memory-map.js
 *   --changes) → filter/guard → register → mirror+commit+push (memory/<host>/)
 *   → hub-notify → (on remote notify) git fetch + cache refresh
 *
 * SAFETY: observe-only by DEFAULT. Set MEMORY_AUTOSYNC=on to enable real git
 * writes + hub notifications. In `off`/`observe` mode the daemon detects,
 * filters, and LOGS the sync PLAN ("would mirror / would notify / would
 * fetch") but performs NO git mutation and writes to NO file outside its log.
 *
 * Per-host-folder ownership: a node ever only writes `memory/<this-host>/`.
 * Never another host's folder, never repo-root files. Never force-push.
 *
 * Reuses existing infra (does not reimplement):
 *   - MemoryCache.onMemoryChange  — the chokidar watcher (no second watcher).
 *   - core/scripts/memory-map.js  — deterministic record-level delta source.
 *   - classifyShareability        — host-local vs project-domain gate.
 *   - HubClient.sendMemoryUpdated / onMemoryUpdated — cross-node notification.
 *
 * See docs/plans/2026-06-06-record-level-memory-map-and-sync.md (§4, §10).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile, execFileSync } from 'child_process';
import { getProjectsDir, decodePath } from '../utils/path-utils';
import { parseFrontmatter, isValidMemoryFrontmatter } from '../utils/frontmatter';
import { classifyShareability } from '../utils/memory-shareability';
import { getHubClient, MemoryUpdatedMessage } from '../hub-client';

// ─── Mode ───────────────────────────────────────────────────

export type AutoSyncMode = 'off' | 'observe' | 'on';

/** Read MEMORY_AUTOSYNC from env. Default `observe` (detect+plan, no writes). */
export function resolveMode(): AutoSyncMode {
  const v = (process.env.MEMORY_AUTOSYNC || '').trim().toLowerCase();
  if (v === 'on') return 'on';
  if (v === 'off') return 'off';
  return 'observe';
}

// ─── Constants ──────────────────────────────────────────────

const DEBOUNCE_MS = 1500;
const LOG_DIR = path.join(os.homedir(), '.cache', 'lm-assist');
const LOG_FILE = path.join(LOG_DIR, 'memory-autosync.log');
const MAP_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'memory-map.js');
const RECENT_EVENT_CAP = 50;

/** Credential-shaped filename patterns — never synced regardless of shareability. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /token/i,
  /\bkey\b/i,
  /cookie/i,
  /password/i,
  /secret/i,
  /credential/i,
];

// ─── Types ──────────────────────────────────────────────────

interface DeltaRecord {
  id: string;        // change-log records key the recordId under `id`
  title?: string;
  node?: string;     // present on addedRecords only
  category?: string; // present on addedRecords only
}

interface ChangesResult {
  added: number;
  modified: number;
  removed: number;
  addedRecords: DeltaRecord[];
  modifiedRecords: DeltaRecord[];
  removedRecords: string[];
}

export interface AutoSyncEvent {
  ts: number;
  mode: AutoSyncMode;
  project: string;
  decision: string;
  detail?: Record<string, unknown>;
}

export interface AutoSyncStatus {
  mode: AutoSyncMode;
  running: boolean;
  hostId: string | null;
  counts: {
    detected: number;
    planned: number;
    filtered: number;
    mirrored: number;
    pushed: number;
    notified: number;
    fetched: number;
    errors: number;
  };
  recentEvents: AutoSyncEvent[];
  logFile: string;
}

// ─── Daemon ─────────────────────────────────────────────────

export class MemoryAutoSyncDaemon {
  private mode: AutoSyncMode;
  private port: string;
  private started = false;
  private pending = new Map<string, NodeJS.Timeout>(); // by live dir path
  private hostIdCache = new Map<string, string | null>(); // projectPath → host-id
  private recentEvents: AutoSyncEvent[] = [];
  private counts: AutoSyncStatus['counts'] = {
    detected: 0, planned: 0, filtered: 0, mirrored: 0,
    pushed: 0, notified: 0, fetched: 0, errors: 0,
  };

  constructor(opts: { mode?: AutoSyncMode; port?: string } = {}) {
    this.mode = opts.mode || resolveMode();
    this.port = opts.port || process.env.API_PORT ||
      (__dirname.includes('node_modules') ? '3100' : '3200');
  }

  getMode(): AutoSyncMode { return this.mode; }

  /**
   * Hook into the existing MemoryCache watcher and the hub receive channel.
   * Harmless in observe/off mode (no writes). Idempotent.
   */
  start(): void {
    if (this.started) return;
    if (this.mode === 'off') {
      this.log('(disabled)', 'daemon-off', { reason: 'MEMORY_AUTOSYNC=off' });
      this.started = true;
      return;
    }

    // Detect: reuse MemoryCache's chokidar watcher — do NOT start a second one.
    try {
      const { getMemoryCache } = require('../memory-cache');
      const memCache = getMemoryCache();
      memCache.onMemoryChange((dirPath: string) => this.onDirChange(dirPath));
    } catch (err) {
      this.counts.errors++;
      this.log('(init)', 'watch-hook-failed', { error: String(err) });
    }

    // Receive: react to other nodes' memory-updated notifications via hub.
    try {
      const hub = getHubClient();
      hub.onMemoryUpdated((m) => this.onRemoteUpdate(m));
    } catch (err) {
      this.log('(init)', 'hub-hook-failed', { error: String(err) });
    }

    this.started = true;
    this.log('(daemon)', 'started', { mode: this.mode, port: this.port });
  }

  // ─── Detect (debounced) ───────────────────────────────────

  private onDirChange(dirPath: string): void {
    // Only act on LIVE auto-memory dirs (`<projectsDir>/<slug>/memory`).
    const projectsDir = getProjectsDir();
    if (!dirPath.startsWith(projectsDir)) return; // repo mirrors handled via git
    if (path.basename(dirPath) !== 'memory') return;

    const existing = this.pending.get(dirPath);
    if (existing) clearTimeout(existing);
    this.pending.set(dirPath, setTimeout(() => {
      this.pending.delete(dirPath);
      void this.handleLiveChange(dirPath).catch((err) => {
        this.counts.errors++;
        this.log(this.slugFromLiveDir(dirPath) || dirPath, 'handle-error', { error: String(err) });
      });
    }, DEBOUNCE_MS));
  }

  private slugFromLiveDir(dirPath: string): string | null {
    const projectsDir = getProjectsDir();
    const rel = path.relative(projectsDir, dirPath); // <slug>/memory
    const parts = rel.split(path.sep);
    return parts[0] || null;
  }

  /**
   * A live memory dir changed. Compute the record delta deterministically via
   * memory-map.js, filter/guard, then either log the PLAN (observe) or execute
   * the mirror+commit+push+notify (on).
   */
  private async handleLiveChange(liveDir: string): Promise<void> {
    const slug = this.slugFromLiveDir(liveDir);
    if (!slug) return;
    let projectPath: string;
    try { projectPath = decodePath(slug); } catch { return; }

    this.counts.detected++;

    // Compute record delta. In `on` mode we register (--commit appends the
    // change log + advances the snapshot watermark); in observe we read-only.
    const delta = await this.computeDelta(this.mode === 'on');
    const changed = [...delta.addedRecords, ...delta.modifiedRecords];
    if (changed.length === 0 && delta.removedRecords.length === 0) {
      this.log(slug, 'detected-noop', { note: 'no record-level delta' });
      return;
    }

    // Resolve which files changed in THIS project (delta is cross-project).
    const projChanged = changed.filter((r) => this.recordProject(r.id) === slug);
    const projRemoved = delta.removedRecords.filter((id) => this.recordProject(id) === slug);
    if (projChanged.length === 0 && projRemoved.length === 0) {
      this.log(slug, 'detected-other-project', {
        note: 'delta belongs to other projects', added: delta.added, modified: delta.modified,
      });
      return;
    }

    // Filter/guard each changed record's file.
    const syncable: Array<{ recordId: string; file: string }> = [];
    const dropped: Array<{ recordId: string; file: string; reason: string }> = [];
    for (const r of projChanged) {
      const file = this.recordFile(r.id);
      const reason = this.guard(liveDir, file);
      if (reason) { dropped.push({ recordId: r.id, file, reason }); }
      else syncable.push({ recordId: r.id, file });
    }
    if (dropped.length) {
      this.counts.filtered += dropped.length;
      this.log(slug, 'filtered', { dropped });
    }

    this.log(slug, 'detected', {
      added: delta.added, modified: delta.modified, removed: delta.removed,
      syncableFiles: [...new Set(syncable.map((s) => s.file))],
      registered: this.mode === 'on' ? 'appended to memory-changes.jsonl' : 'observe — not registered',
    });

    if (syncable.length === 0) return;

    const hostId = this.resolveHostId(projectPath);
    const recordIds = syncable.map((s) => s.recordId);
    const files = [...new Set(syncable.map((s) => s.file))];

    if (this.mode !== 'on') {
      // OBSERVE: emit the full sync PLAN without any mutation.
      this.counts.planned++;
      const mirrorDir = hostId ? path.join(projectPath, 'memory', hostId) : null;
      this.log(slug, 'would-mirror', {
        hostId: hostId || '(unresolved — would skip)',
        targetDir: mirrorDir ? path.relative(projectPath, mirrorDir) : null,
        files,
        note: mirrorDir
          ? `would copy ${files.length} file(s) into memory/${hostId}/, update MEMORY.md, git add/commit/push (scoped to that folder only)`
          : 'no host-id / no repo mirror — would skip (nothing to sync)',
      });
      this.log(slug, 'would-notify', {
        hub: 'memory_updated', host: hostId, recordIds,
        note: 'would send hub notification after successful push',
      });
      return;
    }

    // ── on-mode: real mirror + commit + push + notify ──
    await this.mirrorAndPush(projectPath, slug, hostId, files, recordIds);
  }

  // ─── Guards ───────────────────────────────────────────────

  /** Returns a drop-reason string if the file must NOT be synced, else ''. */
  private guard(liveDir: string, file: string): string {
    if (!file) return 'no-file';
    if (file === 'MEMORY.md' || file === '_hosts.md') return 'index-or-registry';
    if (file === '_cross-project.md') return 'managed-signpost'; // per-node managed; regenerated, never synced
    // CLAUDE.md flows through normal git (repo-root, not host-owned).
    if (file === 'CLAUDE.md' || file === 'CLAUDE.local.md') return 'claude-md-repo-owned';
    for (const re of CREDENTIAL_PATTERNS) {
      if (re.test(file)) return 'credential-pattern';
    }
    const filePath = path.join(liveDir, file);
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf-8'); }
    catch { return 'unreadable'; }
    const { frontmatter } = parseFrontmatter(content);
    if (!isValidMemoryFrontmatter(frontmatter)) return 'invalid-frontmatter';
    const share = classifyShareability(file, frontmatter);
    if (share === 'host-local') return 'host-local';
    // project-domain + ambiguous are syncable.
    return '';
  }

  // ─── Delta computation (shell out to memory-map.js) ───────

  private computeDelta(commit: boolean): Promise<ChangesResult> {
    const flags = ['--changes', '--port', this.port, '--format', 'json'];
    if (commit) flags.push('--commit');
    return new Promise((resolve, reject) => {
      execFile('node', [MAP_SCRIPT, ...flags], { maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return reject(err);
          try {
            const j = JSON.parse(stdout || '{}');
            resolve({
              added: j.added || 0, modified: j.modified || 0, removed: j.removed || 0,
              addedRecords: j.addedRecords || [], modifiedRecords: j.modifiedRecords || [],
              removedRecords: j.removedRecords || [],
            });
          } catch (e) { reject(e); }
        });
    });
  }

  // recordId = "<node>:<project>:<file>#<anchor>"
  private recordProject(recordId: string): string {
    const parts = recordId.split(':');
    return parts.length >= 2 ? parts[1] : '';
  }
  private recordFile(recordId: string): string {
    const parts = recordId.split(':');
    if (parts.length < 3) return '';
    const rest = parts.slice(2).join(':'); // file#anchor (file may contain no colon)
    return rest.split('#')[0];
  }

  // ─── Host-id resolution (env LM_HOST_ID > _hosts.md by local IP) ──

  private resolveHostId(projectPath: string): string | null {
    if (process.env.LM_HOST_ID) return process.env.LM_HOST_ID;
    if (this.hostIdCache.has(projectPath)) return this.hostIdCache.get(projectPath)!;
    let id: string | null = null;
    const hf = path.join(projectPath, 'memory', '_hosts.md');
    try {
      const txt = fs.readFileSync(hf, 'utf-8');
      const ips = Object.values(os.networkInterfaces()).flat()
        .filter(Boolean).map((n) => (n as os.NetworkInterfaceInfo).address);
      for (const line of txt.split('\n')) {
        const m = line.match(/`([a-z0-9-]+)`/) || line.match(/^\|\s*([a-z0-9-]+)\s*\|/);
        const cand = m && m[1];
        if (cand && ips.some((ip) => line.includes(ip))) { id = cand; break; }
      }
    } catch { /* no registry */ }
    this.hostIdCache.set(projectPath, id);
    return id;
  }

  // ─── on-mode mirror + push + notify (NEVER runs in observe) ──

  private async mirrorAndPush(
    projectPath: string, slug: string, hostId: string | null,
    files: string[], recordIds: string[],
  ): Promise<void> {
    if (!hostId) { this.log(slug, 'skip-no-host', {}); return; }
    const repoBase = path.join(projectPath, 'memory');
    const mirrorDir = path.join(repoBase, hostId);
    if (!fs.existsSync(repoBase) || !fs.existsSync(path.join(projectPath, '.git'))) {
      this.log(slug, 'skip-no-repo', { repoBase }); return;
    }
    try {
      fs.mkdirSync(mirrorDir, { recursive: true });
      const liveDir = path.join(getProjectsDir(), slug, 'memory');
      for (const f of files) {
        const src = path.join(liveDir, f);
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, path.join(mirrorDir, f));
      }
      this.counts.mirrored++;
      // Update the host's MEMORY.md index (mirror live index 1:1 if present).
      const liveIndex = path.join(liveDir, 'MEMORY.md');
      if (fs.existsSync(liveIndex)) {
        fs.copyFileSync(liveIndex, path.join(mirrorDir, 'MEMORY.md'));
      }
      // git add/commit/push scoped to memory/<host>/ ONLY. Never force-push.
      const rel = path.relative(projectPath, mirrorDir);
      const git = (a: string[]) => execFileSync('git', a, { cwd: projectPath, encoding: 'utf-8' });
      git(['add', '--', rel]);
      const status = git(['status', '--porcelain', '--', rel]).trim();
      if (!status) { this.log(slug, 'nothing-to-commit', { rel }); return; }
      git(['commit', '-m',
        `memory(${hostId}): autosync ${files.length} record(s) [${recordIds.length} ids]`,
        '--', rel]);
      this.counts.pushed++;
      git(['push']); // plain push — no --force, ever
      this.log(slug, 'pushed', { hostId, rel, files });

      // Notify other nodes (data already on remote via git).
      const hub = getHubClient();
      const ok = hub.sendMemoryUpdated({ project: slug, host: hostId, recordIds, ts: Date.now() });
      if (ok) { this.counts.notified++; this.log(slug, 'notified', { host: hostId, recordIds }); }
      else this.log(slug, 'notify-skip', { reason: 'hub not connected' });
    } catch (err) {
      this.counts.errors++;
      this.log(slug, 'mirror-push-error', { error: String(err) });
    }
  }

  // ─── Receive: another node pushed; fetch its folder + refresh cache ──

  private onRemoteUpdate(m: MemoryUpdatedMessage): void {
    const slug = m.project;
    let projectPath: string;
    try { projectPath = decodePath(slug); } catch { return; }
    const thisHost = this.resolveHostId(projectPath);
    if (m.host && thisHost && m.host === thisHost) {
      this.log(slug, 'remote-self-echo', { host: m.host }); return; // our own push echoed back
    }
    if (this.mode !== 'on') {
      this.log(slug, 'would-fetch', {
        fromHost: m.host, recordIds: m.recordIds,
        note: `would git fetch + checkout memory/${m.host}/ and refresh cache`,
      });
      return;
    }
    // on-mode: fetch only the sender's mirror folder, then refresh cache.
    try {
      if (!fs.existsSync(path.join(projectPath, '.git'))) { this.log(slug, 'remote-no-repo', {}); return; }
      const rel = path.posix.join('memory', m.host);
      const git = (a: string[]) => execFileSync('git', a, { cwd: projectPath, encoding: 'utf-8' });
      git(['fetch', 'origin']);
      git(['checkout', 'origin/HEAD', '--', rel]); // only the sender's folder
      this.counts.fetched++;
      this.log(slug, 'fetched', { fromHost: m.host, rel });
      try {
        const { getMemoryCache } = require('../memory-cache');
        getMemoryCache().addWatchPath(path.join(projectPath, rel));
      } catch { /* cache refresh best-effort */ }
    } catch (err) {
      this.counts.errors++;
      this.log(slug, 'fetch-error', { error: String(err) });
    }
  }

  // ─── Logging + status ─────────────────────────────────────

  private log(project: string, decision: string, detail?: Record<string, unknown>): void {
    const ev: AutoSyncEvent = { ts: Date.now(), mode: this.mode, project, decision, detail };
    this.recentEvents.push(ev);
    if (this.recentEvents.length > RECENT_EVENT_CAP) this.recentEvents.shift();
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(LOG_FILE, JSON.stringify(ev) + '\n');
    } catch { /* logging must never throw */ }
  }

  getStatus(): AutoSyncStatus {
    return {
      mode: this.mode,
      running: this.started,
      hostId: process.env.LM_HOST_ID || null,
      counts: { ...this.counts },
      recentEvents: this.recentEvents.slice(-20),
      logFile: LOG_FILE,
    };
  }
}

// ─── Singleton ──────────────────────────────────────────────

let instance: MemoryAutoSyncDaemon | null = null;

export function getAutoSyncDaemon(): MemoryAutoSyncDaemon {
  if (!instance) instance = new MemoryAutoSyncDaemon();
  return instance;
}
