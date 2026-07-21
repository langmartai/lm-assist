/** The aggregator: turns enabled plugins into `ext__<plugin>__<tool>` entries on the
 *  lm-assist MCP surfaces and routes calls into their subprocesses (contract §2, §3.3, §5).
 *
 *  Two invariants worth stating out loud:
 *   1. LISTING NEVER SPAWNS. Advertised tools come from the manifest, so browsing the
 *      tool surface can never execute third-party code.
 *   2. THE MANIFEST IS AUTHORITATIVE. A tool that appears only at runtime is never
 *      exposed and never callable, so an approved plugin cannot grow new tools. */
import * as path from 'path';
import {
  PLUGIN_LIMITS, composeToolName, parseToolName, pluginsSubsystemEnabled,
  type PluginCapabilities, type PluginPhase, type PluginToolDef,
} from './model';
import { discoverPlugins, type PluginRecord } from './discovery';
import { pluginAuditFile, pluginScratchRoot, pluginStateFile, pluginsDir } from './paths';
import { writeState } from './state-store';
import { spawnPlugin, type McpToolResultLike, type SpawnedPlugin } from './client';
import { appendPluginAudit, argDigest, type PluginCallOutcome } from './audit';

export interface AggregatorOptions {
  dir?: string;
  stateFile?: string;
  auditFile?: string;
  scratchRoot?: string;
  /** Idle window before a resident child is stopped. Overridable for tests. */
  idleMs?: number;
}

export interface NamespacedToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface PluginStatusView {
  name: string;
  phase: PluginPhase;
  version?: string;
  description?: string;
  author?: string;
  payloadChecksum: string | null;
  approvedChecksum?: string;
  pinMatches: boolean;
  capabilities: PluginCapabilities;
  grantedEnv: string[];
  tools: string[];
  processes: number;
  health: { failures: number; lastError?: string; quarantinedUntil?: number };
  reason?: string;
  manifestErrors: string[];
}

export interface PluginAggregator {
  listToolDefs(): Promise<NamespacedToolDef[]>;
  call(namespacedName: string, args: Record<string, unknown>): Promise<McpToolResultLike>;
  status(): PluginStatusView[];
  shutdown(): Promise<void>;
}

interface LiveProcess {
  client: SpawnedPlugin;
  runtimeTools: Set<string> | null;   // filled at first reconciliation
  lastUsedAt: number;
  keepWarm: boolean;
}

const errorResult = (text: string): McpToolResultLike => ({ isError: true, content: [{ type: 'text', text }] });

export function createAggregator(opts: AggregatorOptions = {}): PluginAggregator {
  const dir = opts.dir ?? pluginsDir();
  const stateFile = opts.stateFile ?? pluginStateFile();
  const auditFile = opts.auditFile ?? pluginAuditFile();
  const scratchRoot = opts.scratchRoot ?? pluginScratchRoot();
  const idleMs = opts.idleMs ?? PLUGIN_LIMITS.idleShutdownMs;

  const live = new Map<string, LiveProcess>();
  const starting = new Map<string, Promise<LiveProcess>>();

  const records = (): PluginRecord[] => discoverPlugins({ dir, stateFile });

  function audit(
    plugin: string, tool: string, args: Record<string, unknown>,
    startedAt: number, outcome: PluginCallOutcome, extra: Record<string, unknown> = {},
  ): void {
    appendPluginAudit({
      ts: new Date().toISOString(),
      plugin, tool,
      argDigest: argDigest(args),
      durationMs: Date.now() - startedAt,
      outcome,
      ...extra,
    }, { auditFile });
  }

  /** Record a failure and quarantine the plugin once it has failed enough times. */
  function noteFailure(rec: PluginRecord, message: string): void {
    const failures = (rec.state.health?.failures ?? 0) + 1;
    const health = {
      failures,
      lastError: message.slice(0, 300),
      ...(failures >= PLUGIN_LIMITS.unhealthyAfterFailures
        ? { quarantinedUntil: Date.now() + PLUGIN_LIMITS.quarantineMs }
        : {}),
    };
    try { writeState(rec.name, { health }, stateFile); } catch { /* health is best-effort */ }
  }

  function noteSuccess(rec: PluginRecord): void {
    if (!rec.state.health || rec.state.health.failures === 0) return;
    try { writeState(rec.name, { health: { failures: 0 } }, stateFile); } catch { /* best effort */ }
  }

  /**
   * Stop children that should no longer be running: a plugin that lost its `enabled`
   * phase (owner disable, or an auto-revert after payload/manifest drift) must not be
   * left with a live process, and an idle child is stopped rather than parked forever.
   */
  function reap(): void {
    if (live.size === 0) return;
    const phaseByName = new Map(records().map((r) => [r.name, r.effective.phase]));
    const now = Date.now();
    for (const [name, proc] of [...live.entries()]) {
      const stale = phaseByName.get(name) !== 'enabled';
      const idle = !proc.keepWarm && idleMs > 0 && now - proc.lastUsedAt > idleMs;
      if (!stale && !idle && proc.client.alive()) continue;
      live.delete(name);
      void proc.client.close().catch(() => undefined);
    }
  }

  async function ensureProcess(rec: PluginRecord): Promise<LiveProcess> {
    const existing = live.get(rec.name);
    if (existing && existing.client.alive()) return existing;
    if (existing) live.delete(rec.name);

    const inFlight = starting.get(rec.name);
    if (inFlight) return inFlight;   // one process per plugin, even under concurrent first calls

    const p = (async (): Promise<LiveProcess> => {
      const client = await spawnPlugin({
        name: rec.name,
        dir: rec.dir,
        manifest: rec.manifest!,
        scratchDir: path.join(scratchRoot, rec.name),
        grants: rec.state.grants ?? {},
      });
      const entry: LiveProcess = { client, runtimeTools: null, lastUsedAt: Date.now(), keepWarm: rec.manifest?.keepWarm === true };
      try {
        const runtime = await client.listTools();
        entry.runtimeTools = new Set(runtime.map((t) => t.name));
      } catch {
        entry.runtimeTools = null;   // reconciliation deferred; the call below reports it
      }
      live.set(rec.name, entry);
      return entry;
    })();

    starting.set(rec.name, p);
    try {
      return await p;
    } finally {
      starting.delete(rec.name);
    }
  }

  return {
    /** Manifest-derived, namespaced defs for every ENABLED plugin. Never spawns. */
    async listToolDefs(): Promise<NamespacedToolDef[]> {
      reap();
      if (!pluginsSubsystemEnabled()) return [];
      const out: NamespacedToolDef[] = [];
      for (const rec of records()) {
        if (rec.effective.phase !== 'enabled' || !rec.manifest) continue;
        for (const t of rec.manifest.tools as PluginToolDef[]) {
          out.push({
            name: composeToolName(rec.name, t.name),
            description: t.description,
            inputSchema: t.inputSchema,
          });
        }
      }
      return out;
    },

    async call(namespacedName: string, args: Record<string, unknown>): Promise<McpToolResultLike> {
      reap();
      const startedAt = Date.now();
      const parsed = parseToolName(namespacedName);
      if (!parsed) {
        return errorResult(`"${namespacedName}" is not a plugin tool (expected ext__<plugin>__<tool>).`);
      }
      const { plugin, tool } = parsed;

      if (!pluginsSubsystemEnabled()) {
        audit(plugin, tool, args, startedAt, 'refused', { reason: 'kill switch' });
        return errorResult(
          `⛔ the MCP plugin subsystem is disabled on this node (LM_MCP_PLUGINS=0). "${namespacedName}" was not executed.`,
        );
      }

      const rec = records().find((r) => r.name === plugin);
      if (!rec) {
        audit(plugin, tool, args, startedAt, 'refused', { reason: 'unknown plugin' });
        return errorResult(`⛔ no plugin named "${plugin}" is installed. "${namespacedName}" was not executed.`);
      }

      if (rec.effective.phase !== 'enabled') {
        audit(plugin, tool, args, startedAt, 'refused', { reason: rec.effective.phase });
        return errorResult(
          `⛔ plugin "${plugin}" is ${rec.effective.phase}${rec.effective.reason ? ` (${rec.effective.reason})` : ''}. ` +
          `"${namespacedName}" was not executed. Enable it on the /mcp-tools page at the console.`,
        );
      }

      // Manifest is authoritative: refuse an undeclared tool BEFORE the plugin sees it.
      const declared = (rec.manifest!.tools as PluginToolDef[]).some((t) => t.name === tool);
      if (!declared) {
        audit(plugin, tool, args, startedAt, 'refused', { reason: 'not declared in manifest' });
        return errorResult(
          `⛔ "${tool}" is not declared in the approved manifest of plugin "${plugin}", so it is not exposed. ` +
          `A plugin cannot gain tools after approval — re-approve it if the manifest legitimately changed.`,
        );
      }

      let proc: LiveProcess;
      try {
        proc = await ensureProcess(rec);
      } catch (e) {
        const msg = (e as Error).message;
        noteFailure(rec, msg);
        audit(plugin, tool, args, startedAt, 'spawn_failed', { reason: msg.slice(0, 200) });
        return errorResult(`⛔ plugin "${plugin}" failed to start: ${msg}`);
      }

      // Reconcile: a declared tool the running server does not provide is a real fault.
      if (proc.runtimeTools && !proc.runtimeTools.has(tool)) {
        const msg = `declared tool "${tool}" is missing at runtime (reconciliation failed)`;
        noteFailure(rec, msg);
        audit(plugin, tool, args, startedAt, 'error', { reason: msg });
        return errorResult(
          `⛔ plugin "${plugin}" declares "${tool}" in its manifest but its running server does not provide it. ` +
          `The call was not made; the plugin has been marked unhealthy if this keeps happening.`,
        );
      }

      proc.lastUsedAt = Date.now();
      try {
        const res = await proc.client.call(tool, args);   // LOCAL name — the prefix never crosses the boundary
        const bytes = res.content.reduce((n, c) => n + Buffer.byteLength(c.text ?? c.data ?? '', 'utf8'), 0);
        const truncated = res.isError === true && /result too large/.test(res.content[0]?.text ?? '');
        if (res.isError && !truncated) {
          // A tool-level error is the plugin's own business outcome, not a health fault.
          audit(plugin, tool, args, startedAt, 'error', { resultBytes: bytes });
        } else {
          noteSuccess(rec);
          audit(plugin, tool, args, startedAt, truncated ? 'truncated' : 'ok', { resultBytes: bytes, ...(truncated ? { truncated: true } : {}) });
        }
        return res;
      } catch (e) {
        const msg = (e as Error).message;
        const timedOut = /timeout/i.test(msg);
        noteFailure(rec, msg);
        audit(plugin, tool, args, startedAt, timedOut ? 'timeout' : 'error', {
          reason: msg.slice(0, 200), ...(timedOut ? { timedOut: true } : {}),
        });
        live.delete(rec.name);
        return errorResult(`⛔ plugin "${plugin}" call failed: ${msg}`);
      }
    },

    status(): PluginStatusView[] {
      reap();
      return records().map((rec) => {
        const proc = live.get(rec.name);
        return {
          name: rec.name,
          phase: rec.effective.phase,
          version: rec.manifest?.version,
          description: rec.manifest?.description,
          author: rec.manifest?.author,
          payloadChecksum: rec.payloadChecksum,
          approvedChecksum: rec.state.approvedPayloadChecksum,
          pinMatches: !!rec.state.approvedPayloadChecksum && rec.state.approvedPayloadChecksum === rec.payloadChecksum,
          capabilities: rec.manifest?.capabilities ?? { network: [], fs: [], env: [] },
          grantedEnv: Object.keys(rec.state.grants ?? {}),   // NAMES only — never values
          tools: (rec.manifest?.tools ?? []).map((t) => composeToolName(rec.name, t.name)),
          processes: proc && proc.client.alive() ? 1 : 0,
          health: {
            failures: rec.state.health?.failures ?? 0,
            ...(rec.state.health?.lastError ? { lastError: rec.state.health.lastError } : {}),
            ...(rec.state.health?.quarantinedUntil ? { quarantinedUntil: rec.state.health.quarantinedUntil } : {}),
          },
          ...(rec.effective.reason ? { reason: rec.effective.reason } : {}),
          manifestErrors: rec.manifestErrors,
        };
      });
    },

    async shutdown(): Promise<void> {
      const all = [...live.values()];
      live.clear();
      await Promise.all(all.map((p) => p.client.close().catch(() => undefined)));
    },
  };
}

// --- process-wide singleton used by the MCP surfaces + routes -----------------------
let shared: PluginAggregator | null = null;

export function getPluginAggregator(): PluginAggregator {
  if (!shared) shared = createAggregator();
  return shared;
}

/** Tests only. */
export function _resetPluginAggregatorForTests(): void {
  shared = null;
}
