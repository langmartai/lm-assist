/**
 * node_status — the GENERAL per-node status endpoint (spec N4): one call
 * reports every registered subsystem (services, hub, fabric, …future: bus,
 * data-sync, scheduler). `section` narrows to one subsystem with full detail
 * (e.g. section="network" ≡ "fabric" → the peer-link table). Cross-node via
 * the standard `node` param (hub tool routing).
 * Registration: NODE_STATUS_TOOL_DEFS + NODE_STATUS_HANDLERS → expanded.ts;
 * scope 'read' → configure.ts TOOL_SCOPES.
 */
import { ok, err, workerGet, type McpToolResult } from './_passthrough';

export const NODE_STATUS_TOOL_DEFS = [
  {
    name: 'node_status',
    description:
      'General status of an lm-assist node — every subsystem in one call: services (uptime), hub ' +
      'connection, STORAGE (disk volumes: total/used/free per mount), NETWORK (the host\'s own NICs + ' +
      'IPs), the fabric MESH peer-links, and any other registered provider. Pass section="storage" for ' +
      'disks, section="network" for the host IPs/interfaces, section="fabric" (aka "peers") for the mesh, ' +
      'or another section name for its detail. Pass node=<host> to read another node. Read-only.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: {
        section: { type: 'string', description: 'Optional subsystem: "storage"/"disk", "network"/"nics" (host IPs), "fabric"/"peers" (mesh), "hub", "services", … Omit for the all-subsystem summary.' },
      },
    },
  },
];

/** Section aliases → provider name. "network" now means the HOST's NICs (was an
 *  alias for "fabric"); the mesh is reached via "fabric"/"peers"/"mesh". */
const SECTION_ALIAS: Record<string, string> = {
  peers: 'fabric', mesh: 'fabric', disk: 'storage', disks: 'storage', nic: 'network', nics: 'network', interfaces: 'network',
};

interface SectionReport { verdict: string; summary: string; detail?: unknown }

export function formatStatusSections(sections: Record<string, SectionReport>, section?: string): string {
  const names = Object.keys(sections).sort();
  if (!names.length) return section ? `No status section named "${section}".` : 'No status providers registered.';
  const lines = names.map((n) => `[${sections[n].verdict}] ${n} — ${sections[n].summary}`);
  if (section && names.length === 1 && sections[names[0]].detail !== undefined) {
    lines.push('', JSON.stringify(sections[names[0]].detail, null, 2));
  }
  return lines.join('\n');
}

export const NODE_STATUS_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  node_status: async (args) => {
    const raw = typeof args.section === 'string' ? args.section.trim().toLowerCase() : '';
    const section = raw ? (SECTION_ALIAS[raw] ?? raw) : undefined;
    try {
      const res = await workerGet<{ sections?: Record<string, SectionReport> }>(
        `/status/full${section ? `?section=${encodeURIComponent(section)}` : ''}`,
      );
      const sections = res?.sections ?? {};
      return ok(formatStatusSections(sections, section));
    } catch (e) {
      return err(`node_status failed: ${(e as Error).message}`);
    }
  },
};
