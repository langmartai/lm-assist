/** Pure model for third-party MCP plugins (docs/mcp-plugin-contract.md).
 *
 *  DEPENDENCY-LIGHT ON PURPOSE: `configure.ts` imports this module and ships inside
 *  the stdio plugin binary, so nothing here may pull fs/child_process/the data stack.
 *  Types, constants and the namespace grammar only. */

export const PLUGIN_PREFIX = 'ext__';
export const NAME_SEPARATOR = '__';

/** Contract §8 — the limits the loader enforces. Not negotiable per-plugin beyond timeoutMs. */
export const PLUGIN_LIMITS = {
  handshakeMs: 10_000,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 120_000,
  maxResultBytes: 1024 * 1024,       // 1 MiB
  maxConcurrentCalls: 4,
  maxProcesses: 1,                   // per plugin
  killGraceMs: 5_000,                // SIGTERM -> SIGKILL
  unhealthyAfterFailures: 3,
  quarantineMs: 60_000,
  maxStderrCapture: 8 * 1024,        // tail kept per plugin for the audit trail
  idleShutdownMs: 5 * 60_000,        // a resident child with nothing to do is stopped
} as const;

/** Contract §6.1 — names a plugin may never declare: they would either override the
 *  injected base environment or inject code into the Node process. */
export const RESERVED_ENV: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
  'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
]);

/** The minimal PATH handed to a plugin. The interpreter itself is passed by absolute
 *  path (process.execPath), so PATH never needs to resolve `node`. */
export const MINIMAL_PATH = '/usr/local/bin:/usr/bin:/bin';

export const MANIFEST_FILENAME = 'mcp-plugin.json';

// --- manifest shape (mirrors docs/mcp-plugin.schema.json) --------------------------

export interface PluginToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface PluginCapabilities {
  network: string[];
  fs: string[];
  env: string[];
}

export interface PluginManifest {
  manifestVersion: 1;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  entry: { command: 'node'; args: string[] };
  tools: PluginToolDef[];
  capabilities: PluginCapabilities;
  keepWarm?: boolean;
  timeoutMs?: number;
  checksum: string;
}

// --- persisted enable-state (lives OUTSIDE the plugin dir) -------------------------

export interface PluginHealth {
  failures: number;
  lastError?: string;
  quarantinedUntil?: number;
}

export interface PluginState {
  enabled: boolean;
  approvedPayloadChecksum?: string;
  approvedManifestDigest?: string;
  /** Owner-supplied values for the manifest's declared env names. NEVER inherited
   *  from the Core process, never returned by a read route. */
  grants?: Record<string, string>;
  enabledAt?: number;
  enabledBy?: string;
  revertedReason?: string;
  health?: PluginHealth;
}

export type PluginPhase = 'disabled' | 'enabled' | 'unhealthy' | 'invalid';

// --- §5 namespace grammar ---------------------------------------------------------

/** A segment (plugin id or local tool name): lowercase alphanumerics with SINGLE
 *  `_`/`-` separators. Consecutive separators are forbidden so that splitting a
 *  composed name on `__` is unambiguous. */
export const SEGMENT_RE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

/** The lm-assist tool-registry rule a composed name must also satisfy (64 chars). */
export const REGISTRY_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const MAX_PLUGIN_NAME = 24;
export const MAX_TOOL_NAME = 32;

export function composeToolName(plugin: string, tool: string): string {
  return `${PLUGIN_PREFIX}${plugin}${NAME_SEPARATOR}${tool}`;
}

/** Split a namespaced name back into its parts, or null when it is not one of ours.
 *  Unambiguous because neither segment may contain `__` (SEGMENT_RE). */
export function parseToolName(name: string): { plugin: string; tool: string } | null {
  if (typeof name !== 'string' || !name.startsWith(PLUGIN_PREFIX)) return null;
  const parts = name.slice(PLUGIN_PREFIX.length).split(NAME_SEPARATOR);
  if (parts.length !== 2) return null;
  const [plugin, tool] = parts;
  if (!SEGMENT_RE.test(plugin) || !SEGMENT_RE.test(tool)) return null;
  return { plugin, tool };
}

export function isPluginToolName(name: string): boolean {
  return parseToolName(name) !== null;
}

/** Kill switch (contract §2 / design §Security 8). */
export function pluginsSubsystemEnabled(): boolean {
  return process.env.LM_MCP_PLUGINS !== '0';
}
