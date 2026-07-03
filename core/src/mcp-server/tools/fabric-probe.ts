/**
 * fabric_probe — measured throughput + RTT to a peer on the current fabric path
 * (spec T5). Cross-node via the standard `node` param (hub tool routing hits
 * that node's GET /fabric/probe). Read-only. MUST have a TOOL_SCOPES entry.
 */
import { ok, err, workerGet, type McpToolResult } from './_passthrough';

export const FABRIC_PROBE_TOOL_DEFS = [
  {
    name: 'fabric_probe',
    description:
      'Measure live fabric throughput (MB/s) + round-trip latency to a peer node on the current path ' +
      '(direct LAN vs relay floor). Pass node=<peer gatewayId>. Pass an outer node=<host> to run the probe ' +
      'from that host. Read-only.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object' as const,
      properties: { node: { type: 'string', description: 'Peer gatewayId to probe (required).' } },
      required: ['node'],
    },
  },
];

interface ProbeResult { node: string; rttMs: number | null; mbps: number | null; path: string; }

export function formatProbe(p: ProbeResult): string {
  if (p.path === 'none' || p.rttMs === null) return `fabric_probe ${p.node}: no fabric link (not connected or legacy peer).`;
  const mbps = p.mbps === null ? 'n/a' : `${p.mbps.toFixed(1)} MB/s`;
  return `fabric_probe ${p.node}: ${mbps} · ${p.rttMs} ms RTT · path=${p.path}`;
}

export const FABRIC_PROBE_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  fabric_probe: async (args) => {
    const node = typeof args.node === 'string' ? args.node.trim() : '';
    if (!node) return err('fabric_probe: node is required');
    try {
      const p = await workerGet<ProbeResult>(`/fabric/probe?node=${encodeURIComponent(node)}`);
      return ok(formatProbe(p));
    } catch (e) {
      return err(`fabric_probe failed: ${(e as Error).message}`);
    }
  },
};
