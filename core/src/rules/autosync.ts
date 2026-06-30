/**
 * Rule Auto-Sync Daemon — pull-based cross-node USER-rule convergence (sibling of memory/autosync.ts).
 *
 *   watch ~/.claude/rules/*.md (own; chokidar v3, excl synced.*) + 5-min timer + on-demand
 *     -> for each ONLINE FLEET node (unfiltered / fleet-wide): pull /rules/export -> applyIngest
 *        (OS router: active synced.<host>.* vs inert rules-mirror/<host>/, set-diff removal)
 *
 * MODE: `on` by DEFAULT (ruleSyncEnabled, default true; env RULE_AUTOSYNC overrides off/observe/on).
 * observe/off = detect + log a PLAN only, no writes. PULL-only (memory's dataset_updated push is dead).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import { getClaudeConfigDir } from '../utils/path-utils';
import { getHubConfig } from '../hub-client/hub-config';
import * as transport from '../memory/mcp-transport';
import { applyIngest } from './rule-sync';

export type RuleSyncMode = 'off' | 'observe' | 'on';

/** env RULE_AUTOSYNC wins; else ruleSyncEnabled (default true → on); fallback observe. */
export function resolveMode(): RuleSyncMode {
  const v = (process.env.RULE_AUTOSYNC || '').trim().toLowerCase();
  if (v === 'on') return 'on';
  if (v === 'off') return 'off';
  if (v === 'observe') return 'observe';
  try {
    return require('../project-settings').getProjectSettings().ruleSyncEnabled ? 'on' : 'off';
  } catch {
    return 'observe';
  }
}

const DEBOUNCE_MS = 1500;
const LOG_DIR = path.join(os.homedir(), '.cache', 'lm-assist');
const LOG_FILE = path.join(LOG_DIR, 'rule-autosync.log');
const RECENT_EVENT_CAP = 50;

export interface RuleSyncEvent {
  ts: number;
  mode: RuleSyncMode;
  decision: string;
  detail?: Record<string, unknown>;
}

export interface RuleSyncStatus {
  mode: RuleSyncMode;
  running: boolean;
  hostId: string | null;
  counts: {
    reconciles: number;
    pulled: number;
    applied: number;
    removed: number;
    fetched: number;
    errors: number;
  };
  recentEvents: RuleSyncEvent[];
  logFile: string;
}

export class RuleAutoSyncDaemon {
  private mode: RuleSyncMode;
  private started = false;
  private reconciling = false;  // F3: single-flight guard
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private recentEvents: RuleSyncEvent[] = [];
  private counts: RuleSyncStatus['counts'] = {
    reconciles: 0, pulled: 0, applied: 0, removed: 0, fetched: 0, errors: 0,
  };

  constructor(opts: { mode?: RuleSyncMode } = {}) {
    this.mode = opts.mode || resolveMode();
  }

  getMode(): RuleSyncMode { return this.mode; }

  /** F2: Lazily create the fs watcher + periodic reconcile timer. Idempotent — no-op if already running. */
  private initWatcherAndTimer(): void {
    if (this.timer) return; // already running
    const rulesDir = path.join(getClaudeConfigDir(), 'rules');
    try {
      // chokidar v3 API (CommonJS). Ignore synced.* (own export excludes them → no self-trigger loop).
      this.watcher = chokidar.watch(rulesDir, {
        ignoreInitial: true,
        depth: 4,
        ignored: (p: string) => path.basename(p).startsWith('synced.'),
      });
      const onEvt = (p: string) => { if (p.endsWith('.md')) this.scheduleReconcile(); };
      this.watcher.on('add', onEvt).on('change', onEvt).on('unlink', onEvt);
    } catch (err) {
      this.counts.errors++;
      this.log('watch-init-failed', { error: String(err) });
    }
    const periodMs = Math.max(60_000, (Number(process.env.RULE_RECONCILE_SEC) || 300) * 1000);
    this.timer = setInterval(() => {
      void this.reconcile().catch(() => { /* best-effort */ });
    }, periodMs);
    this.timer.unref?.();
    this.log('watcher-timer-init', { mode: this.mode, rulesDir, periodMs });
    if (this.mode === 'on') {
      setTimeout(() => {
        void this.reconcile().catch(() => { /* best-effort */ });
      }, 15_000).unref?.();
    }
  }

  /** F2: Tear down watcher + timer. Idempotent. */
  private teardownWatcherAndTimer(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.watcher) { try { void this.watcher.close(); } catch { /* */ } this.watcher = null; }
    this.log('watcher-timer-stopped', {});
  }

  /** F2: Update mode from env/settings; handle off→on (lazy init) and on/observe→off (teardown). */
  refreshMode(): RuleSyncMode {
    const prev = this.mode;
    this.mode = resolveMode();
    if (this.started && prev !== this.mode) {
      if (this.mode === 'off') {
        this.teardownWatcherAndTimer();
      } else if (prev === 'off') {
        // off → on/observe: lazily create watcher + timer now
        this.initWatcherAndTimer();
        this.log('mode-changed-off-to-active', { mode: this.mode });
      }
      // observe ↔ on: watcher+timer stay; mode already updated so reconcile() acts accordingly
    }
    return this.mode;
  }

  /** Idempotent. Watches own rules + a periodic reconcile timer. Harmless in observe/off (no writes). */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.mode === 'off') {
      this.log('daemon-off', { reason: 'RULE_AUTOSYNC=off / ruleSyncEnabled=false' });
      return;
    }
    this.initWatcherAndTimer();
    this.log('started', { mode: this.mode });
  }

  private scheduleReconcile(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.reconcile().catch(() => { /* */ });
    }, DEBOUNCE_MS);
    this.debounce.unref?.();  // F4: don't prevent process exit
  }

  /** Pull every online fleet node's own rules and apply locally through the OS router. */
  async reconcile(): Promise<void> {
    if (this.reconciling) return;  // F3: single-flight guard — coalesce overlapping calls
    this.reconciling = true;
    try {
      if (this.mode !== 'on') {
        this.log('would-reconcile', { note: 'observe/off — no transport, no writes' });
        return;
      }
      const key = getHubConfig().apiKey || '';
      if (!key) {
        this.log('skip-no-key', { note: 'node not enrolled (no hub apiKey)' });
        return;
      }
      let fleet: string[] = [];
      try {
        fleet = await transport.listFleetNodes();
      } catch (e) {
        this.counts.errors++;
        this.log('fleet-error', { error: String(e) });
        return;
      }
      if (!fleet.length) {
        this.log('reconcile-no-peers', {});
        return;
      }

      this.counts.reconciles++;
      const localPlatform = os.platform();
      for (const node of fleet) {
        try {
          const exp = await transport.pullRulesExport(node, key);
          if (!exp) {
            this.log('pull-empty', { node });
            continue;
          }
          this.counts.pulled++;
          const res = applyIngest(exp.host || node, exp.platform, exp.rules, localPlatform);
          this.counts.applied += res.applied;
          this.counts.removed += res.removed;
          this.counts.fetched++;
          this.log('reconciled', { node: exp.host || node, ...res });
        } catch (e) {
          this.counts.errors++;
          this.log('reconcile-error', { node, error: String(e) });
        }
      }
    } finally {
      this.reconciling = false;  // F3: always release guard
    }
  }

  private resolveHostId(): string | null {
    return process.env.LM_HOST_ID || null;
  }

  private log(decision: string, detail?: Record<string, unknown>): void {
    const ev: RuleSyncEvent = { ts: Date.now(), mode: this.mode, decision, detail };
    this.recentEvents.push(ev);
    if (this.recentEvents.length > RECENT_EVENT_CAP) this.recentEvents.shift();
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(LOG_FILE, JSON.stringify(ev) + '\n');
    } catch { /* never throw */ }
  }

  getStatus(): RuleSyncStatus {
    return {
      mode: this.mode,
      running: this.started,
      hostId: this.resolveHostId(),
      counts: { ...this.counts },
      recentEvents: this.recentEvents.slice(-20),
      logFile: LOG_FILE,
    };
  }
}

let instance: RuleAutoSyncDaemon | null = null;

export function getRuleAutoSyncDaemon(): RuleAutoSyncDaemon {
  if (!instance) instance = new RuleAutoSyncDaemon();
  return instance;
}
