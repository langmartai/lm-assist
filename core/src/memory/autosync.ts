/**
 * Memory Auto-Sync Daemon — Stream A (write side), cross-node sync.
 *
 * Transport is DIRECT-MCP over the hub relay (NOT git):
 *
 *   watch (MemoryCache chokidar) → detect record-level delta (memory-map.js
 *   --changes) → filter/guard (host-local, temporary, credentials) →
 *   push-back to the home node (POST /memory/ingest, relayed) → hub-notify →
 *   (on remote notify) register/refresh the peer's mirror in the cache
 *
 * Persistence model (see core/src/memory/node-mode.ts):
 *   - EPHEMERAL node (cloud worker): its memory dir is a working copy. New
 *     persistent + project-domain memory is pushed back to the persistent
 *     `homeNode` so it survives the VM. `persistence: temporary` files stay local.
 *   - PERSISTENT node (home): memory is canonical here; it does NOT push back
 *     (cloud workers pull its memory at bootstrap — see ccr-cloud.ts).
 *
 * MODE: `on` by DEFAULT (the `memorySyncEnabled` project setting, default true; the
 * `MEMORY_AUTOSYNC` env overrides to off/observe/on). In `off`/`observe` mode the daemon detects,
 * filters, and LOGS the sync PLAN ("would push / would notify / would refresh") but performs NO
 * transport and writes to NO file outside its log. NOTE: `on` is still a no-op for transport on a
 * node with no configured peers/home (planPushBack → "none"); it only moves memory once peers exist.
 *
 * Per-host-folder ownership: a node's records land under `memory/<that-node>/`
 * on the receiver. A node never overwrites another node's folder.
 *
 * Reuses existing infra (does not reimplement):
 *   - MemoryCache.onMemoryChange  — the chokidar watcher (no second watcher).
 *   - core/scripts/memory-map.js  — deterministic record-level delta source.
 *   - classifyShareability        — host-local vs project-domain gate.
 *   - mcp-transport pushToHome    — relayed key-in-body transport (peer-client pattern).
 *   - HubClient.sendMemoryUpdated / onMemoryUpdated — cross-node notification.
 *
 * Supersedes the git-mirror transport in docs/plans/2026-06-06-record-level-memory-map-and-sync.md;
 * see docs/superpowers/specs/2026-06-22-direct-mcp-memory-sync-design.md.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { getProjectsDir, decodePath } from '../utils/path-utils';
import { parseFrontmatter, isValidMemoryFrontmatter } from '../utils/frontmatter';
import { classifyShareability } from '../utils/memory-shareability';
import { getHubClient, MemoryUpdatedMessage } from '../hub-client';
import { getHubConfig } from '../hub-client/hub-config';
import { selectSyncable } from './sync-select';
import { readMemorySyncConfig, MemorySyncConfig } from './node-mode';
import { extractRecords, MemoryRecord } from './record-extract';
import { pushToHome } from './mcp-transport';

// ─── Mode ───────────────────────────────────────────────────

export type AutoSyncMode = 'off' | 'observe' | 'on';

/**
 * Resolve the autosync mode. An explicit `MEMORY_AUTOSYNC` env always wins (`off`/`observe`/`on`).
 * With no env, the mode follows the `memorySyncEnabled` project setting (default true → `on`).
 * (Lazy require of project-settings avoids a load cycle; it is mtime-cached.)
 */
export function resolveMode(): AutoSyncMode {
  const v = (process.env.MEMORY_AUTOSYNC || '').trim().toLowerCase();
  if (v === 'on') return 'on';
  if (v === 'off') return 'off';
  if (v === 'observe') return 'observe';
  try {
    return require('../project-settings').getProjectSettings().memorySyncEnabled ? 'on' : 'off';
  } catch {
    return 'observe';
  }
}

// ─── Push-back planning (pure) ──────────────────────────────

export interface PushPlan {
  action: 'push' | 'none';
  homeNode: string | null;
  records: MemoryRecord[];
}

/**
 * Pure: given this node's sync config + the changed records, decide what to push back to home.
 * Only an EPHEMERAL node with a configured homeNode pushes; persistent (home) nodes never do.
 * The records are narrowed to persistent + shareable (selectSyncable); temporary/host-local drop.
 */
export function planPushBack(cfg: MemorySyncConfig, changed: MemoryRecord[]): PushPlan {
  if (cfg.nodeMode !== 'ephemeral' || !cfg.homeNode) return { action: 'none', homeNode: null, records: [] };
  const records = selectSyncable(changed);
  return records.length
    ? { action: 'push', homeNode: cfg.homeNode, records }
    : { action: 'none', homeNode: cfg.homeNode, records: [] };
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

  /** Re-resolve the mode from env/settings (called when the memorySyncEnabled toggle changes). */
  refreshMode(): AutoSyncMode { this.mode = resolveMode(); return this.mode; }

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
    const cfg = readMemorySyncConfig();
    const sourceHost = hostId || getHubClient().getStatus().gatewayId;

    if (this.mode !== 'on') {
      // OBSERVE: emit the sync PLAN without any transport.
      this.counts.planned++;
      if (cfg.nodeMode === 'ephemeral' && cfg.homeNode) {
        this.log(slug, 'would-push', {
          homeNode: cfg.homeNode, sourceHost: sourceHost || '(unresolved — would skip)',
          files, recordIds,
          note: `would POST /memory/ingest ${files.length} file(s) to home node ${cfg.homeNode} (direct-MCP relay, no git) then hub-notify`,
        });
      } else {
        this.log(slug, 'would-skip-persistent', {
          nodeMode: cfg.nodeMode, homeNode: cfg.homeNode, files,
          note: 'persistent/home node — memory is canonical here; nothing to push back',
        });
      }
      return;
    }

    // ── on-mode: build records for the syncable files, plan, push to home ──
    const records: MemoryRecord[] = [];
    for (const s of syncable) {
      try {
        const fp = path.join(liveDir, s.file);
        const content = fs.readFileSync(fp, 'utf-8');
        const st = fs.statSync(fp);
        const recs = extractRecords({
          node: sourceHost || '', project: slug, source: 'live',
          filename: s.file, content, mtimeMs: st.mtimeMs, size: st.size,
        });
        if (recs[0]) records.push(recs[0]);
      } catch { /* unreadable — skip */ }
    }
    // An ephemeral node syncs only its configured project (cfg.project = the cloud's local slug).
    if (cfg.project && slug !== cfg.project) {
      this.log(slug, 'skip-other-project', {
        configuredProject: cfg.project,
        note: 'ephemeral node syncs only its configured project',
      });
      return;
    }
    const plan = planPushBack(cfg, records);
    if (plan.action !== 'push') {
      this.log(slug, 'no-push-target', {
        nodeMode: cfg.nodeMode, homeNode: cfg.homeNode,
        note: 'persistent/home node or no syncable records — memory stays local (canonical)',
      });
      return;
    }
    // Land in the home node's project slug (may differ from the local slug on a cloud clone).
    const targetProject = cfg.homeProject || slug;
    await this.pushToHomeNode(slug, targetProject, liveDir, plan.homeNode!, sourceHost, plan.records);
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
    if (frontmatter.persistence === 'temporary') return 'temporary'; // working-copy scratch — never syncs
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

  // ─── on-mode push-back to home (direct-MCP; NEVER runs in observe) ──

  /**
   * Push the changed records to the home node's per-host mirror via the hub relay
   * (POST /memory/ingest, access-key in body), then hub-notify so the receiver
   * registers/refreshes the new mirror folder. The receiver files them under
   * memory/<sourceHost>/ — this node never writes another node's folder.
   */
  private async pushToHomeNode(
    slug: string, targetProject: string, liveDir: string, homeNode: string,
    sourceHost: string | null, records: MemoryRecord[],
  ): Promise<void> {
    if (!sourceHost) { this.log(slug, 'skip-no-host', { note: 'no host id / gatewayId to attribute the push' }); return; }
    const key = getHubConfig().apiKey || '';
    if (!key) { this.log(slug, 'skip-no-key', { note: 'node not enrolled (no hub apiKey)' }); return; }

    // Read each file's whole bytes (frontmatter + body) so the home re-extracts identically.
    const payload: Array<{ file: string; content: string; contentHash: string }> = [];
    for (const r of records) {
      try {
        const content = fs.readFileSync(path.join(liveDir, r.file), 'utf-8');
        payload.push({ file: r.file, content, contentHash: createHash('sha256').update(content).digest('hex') });
      } catch { /* unreadable — skip */ }
    }
    if (!payload.length) { this.log(slug, 'push-noop', { note: 'no readable files to push' }); return; }

    try {
      // Push into the home node's project (targetProject), filed under this node's mirror.
      const ingested = await pushToHome(homeNode, targetProject, sourceHost, payload, key);
      this.counts.pushed++;
      this.log(slug, 'pushed', { homeNode, targetProject, sourceHost, ingested, files: payload.map((p) => p.file) });

      // Notify so the home registers/refreshes memory/<sourceHost>/ in its cache (under targetProject).
      const hub = getHubClient();
      const ok = hub.sendMemoryUpdated({ project: targetProject, host: sourceHost, recordIds: records.map((r) => r.recordId), ts: Date.now() });
      if (ok) { this.counts.notified++; this.log(slug, 'notified', { host: sourceHost }); }
      else this.log(slug, 'notify-skip', { reason: 'hub not connected' });
    } catch (err) {
      this.counts.errors++;
      this.log(slug, 'push-error', { error: String(err) });
    }
  }

  // ─── Receive: a peer pushed to our mirror + notified; register/refresh cache ──

  private onRemoteUpdate(m: MemoryUpdatedMessage): void {
    const slug = m.project;
    let projectPath: string;
    try { projectPath = decodePath(slug); } catch { return; }
    const thisHost = this.resolveHostId(projectPath) || getHubClient().getStatus().gatewayId;
    if (m.host && thisHost && m.host === thisHost) {
      this.log(slug, 'remote-self-echo', { host: m.host }); return; // our own push echoed back
    }
    if (!m.host) { this.log(slug, 'remote-no-host', {}); return; }
    if (this.mode !== 'on') {
      this.log(slug, 'would-refresh', {
        fromHost: m.host, recordIds: m.recordIds,
        note: `would register/refresh memory/${m.host}/ in the cache (data delivered via direct-MCP push)`,
      });
      return;
    }
    // on-mode: the peer's records were already written into memory/<m.host>/ by its push
    // (POST /memory/ingest). Register that folder with the cache so the map re-indexes it.
    try {
      const rel = path.posix.join('memory', m.host);
      this.counts.fetched++;
      this.log(slug, 'refreshed', { fromHost: m.host, rel });
      try {
        const { getMemoryCache } = require('../memory-cache');
        getMemoryCache().addWatchPath(path.join(projectPath, rel));
      } catch { /* cache refresh best-effort */ }
    } catch (err) {
      this.counts.errors++;
      this.log(slug, 'refresh-error', { error: String(err) });
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
