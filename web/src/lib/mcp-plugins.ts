/** Pure helpers for the /mcp-tools plugins panel (third-party MCP plugin loader).
 *  IO-free so the review-surface logic — which is security-relevant copy — is
 *  vitest-covered in __tests__/mcp-plugins.test.ts. */

export type PluginPhase = 'disabled' | 'enabled' | 'unhealthy' | 'invalid';

export interface PluginCapabilities {
  network: string[];
  fs: string[];
  env: string[];
}

export interface PluginToolView {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export interface PluginView {
  name: string;
  phase: PluginPhase;
  reason?: string;
  version?: string;
  description?: string;
  author?: string;
  homepage?: string;
  tools: PluginToolView[];
  capabilities: PluginCapabilities;
  entry?: { command: string; args: string[] };
  payloadChecksum: string | null;
  approvedChecksum?: string;
  pinMatches: boolean;
  grantedEnv: string[];
  enabledAt?: number;
  health: { failures: number; lastError?: string; quarantinedUntil?: number };
  manifestErrors: string[];
}

export interface PluginListResponse {
  subsystemEnabled: boolean;
  plugins: PluginView[];
  counts: { total: number; enabled: number; disabled: number; invalid: number; unhealthy: number };
}

export interface PluginAuditEntry {
  ts: string;
  plugin: string;
  tool: string;
  argDigest: string;
  durationMs: number;
  outcome: string;
  truncated?: boolean;
  timedOut?: boolean;
  resultBytes?: number;
  reason?: string;
}

/** The namespaced name a plugin tool is advertised under. Mirrors the core rule. */
export function namespacedToolName(plugin: string, tool: string): string {
  return `ext__${plugin}__${tool}`;
}

/** Short, readable form of a sha256:... digest for the review screen. */
export function shortChecksum(sum: string | null | undefined): string {
  if (!sum) return '—';
  const hex = sum.startsWith('sha256:') ? sum.slice(7) : sum;
  return hex.length <= 12 ? hex : `${hex.slice(0, 12)}…`;
}

/** One-line summary of what a plugin asked for. "no declared access" is a MEANINGFUL
 *  statement on this screen, so an empty capability set must not render as blank. */
export function capabilitySummary(caps: PluginCapabilities | undefined): string {
  const c = caps ?? { network: [], fs: [], env: [] };
  const parts: string[] = [];
  if (c.network.length) parts.push(`${c.network.length} network host${c.network.length > 1 ? 's' : ''}`);
  if (c.fs.length) parts.push(`${c.fs.length} fs path${c.fs.length > 1 ? 's' : ''}`);
  if (c.env.length) parts.push(`${c.env.length} env var${c.env.length > 1 ? 's' : ''}`);
  return parts.length ? parts.join(' · ') : 'no declared access';
}

export interface PhaseBadge {
  label: string;
  tone: 'green' | 'grey' | 'red' | 'amber';
  hint: string;
}

export function phaseBadge(p: PluginView): PhaseBadge {
  switch (p.phase) {
    case 'enabled':
      return { label: 'enabled', tone: 'green', hint: 'Approved and eligible to run; the subprocess starts on first call.' };
    case 'unhealthy':
      return { label: 'unhealthy', tone: 'amber', hint: p.health.lastError ?? 'Quarantined after repeated failures.' };
    case 'invalid':
      return { label: 'invalid', tone: 'red', hint: p.manifestErrors[0] ?? 'The manifest failed validation.' };
    default:
      return { label: 'disabled', tone: 'grey', hint: p.reason ?? 'Not approved — nothing runs until an owner enables it here.' };
  }
}

/** True when an approved pin no longer matches what is on disk: the plugin was
 *  auto-reverted and needs a fresh human approval. */
export function needsReapproval(p: PluginView): boolean {
  return !!p.approvedChecksum && p.approvedChecksum !== p.payloadChecksum;
}

/** What the enable button should say/do. Enabling is only offered for a plugin that
 *  can actually be approved. */
export function enableAction(p: PluginView): { canEnable: boolean; label: string; note?: string } {
  if (p.phase === 'invalid') {
    return { canEnable: false, label: 'Cannot enable', note: p.manifestErrors[0] ?? 'invalid manifest' };
  }
  if (p.phase === 'enabled') return { canEnable: false, label: 'Enabled' };
  if (needsReapproval(p)) {
    return { canEnable: true, label: 'Re-approve and enable', note: 'the payload changed since it was approved' };
  }
  return { canEnable: true, label: 'Enable plugin' };
}

export function summarizePluginCounts(plugins: PluginView[]): {
  total: number; enabled: number; needsReview: number;
} {
  return {
    total: plugins.length,
    enabled: plugins.filter((p) => p.phase === 'enabled').length,
    needsReview: plugins.filter((p) => p.phase === 'disabled' || p.phase === 'invalid' || needsReapproval(p)).length,
  };
}
