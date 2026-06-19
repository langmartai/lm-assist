/**
 * Port-forward MCP tools — node-to-node TCP tunnel control surface.
 *
 * These wrap the worker's own `/port-forward` REST route on loopback (single
 * source of truth). The optional `node` selector injected by configure.ts picks
 * which node OPENS the local listener; `targetGatewayId` names the node that
 * owns the real service. The hub only bridges nodes owned by the same user.
 *
 * Wiring: registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts) and
 * scoped in configure.ts TOOL_SCOPES.
 */

import { ok, err, workerGet, workerPost, workerDelete, type McpToolResult } from './_passthrough';

export const openPortForwardToolDef = {
  name: 'open_port_forward',
  description:
    'Open a local TCP port on one lm-assist node that tunnels to another node\'s local ' +
    'port, over the existing hub connection (like `ssh -L`, but node-to-node). Use the ' +
    '`node` selector to choose which node LISTENS (creates the local port); ' +
    '`targetGatewayId` names the node that owns the service. Trigger words: "port forward", ' +
    '"tunnel a port", "expose node B\'s port on node A", "reach the database on my other ' +
    'machine". Both nodes must belong to you. Returns the forwardId + bound localPort.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      targetGatewayId: {
        type: 'string',
        description: 'Target node hostId/gatewayId (from list_nodes) or hostname — the node whose local port you want to reach.',
      },
      targetPort: {
        type: 'number',
        description: 'Port on the target node to forward to (1–65535).',
      },
      localPort: {
        type: 'number',
        description: 'Local port to listen on at the listener node. Pass 0 for an ephemeral (OS-assigned) port. Omit to default to targetPort.',
      },
      bindHost: {
        type: 'string',
        description: 'Interface to bind the local listener to. Defaults to 127.0.0.1 (loopback only).',
      },
      exposeLan: {
        type: 'boolean',
        description: 'Bind the node\'s LAN IP instead of loopback so OTHER hosts on the network can reach this forward. Default false (loopback only, for safety).',
      },
    },
    required: ['targetGatewayId', 'targetPort'],
  },
};

export const listPortForwardsToolDef = {
  name: 'list_port_forwards',
  description:
    'List active node-to-node port forwards on a node (use the `node` selector to choose ' +
    'which node). Each entry shows forwardId, local bind host/port, target node + port, and ' +
    'active stream count. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

export const closePortForwardToolDef = {
  name: 'close_port_forward',
  description:
    'Close a node-to-node port forward by forwardId (use the `node` selector to target the ' +
    'listener node it lives on). Stops the local listener and tears down its streams.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      forwardId: { type: 'string', description: 'forwardId returned by open_port_forward / list_port_forwards.' },
    },
    required: ['forwardId'],
  },
};

export const PORT_FORWARD_TOOL_DEFS = [
  openPortForwardToolDef,
  listPortForwardsToolDef,
  closePortForwardToolDef,
] as const;

interface ForwardEntry {
  forwardId: string;
  localPort: number;
  bindHost: string;
  targetGatewayId: string;
  targetPort: number;
  activeStreams?: number;
  health?: { status: 'unknown' | 'up' | 'down'; since: string; lastError?: string };
}

interface NodeInfo {
  gatewayId: string | null;
  hostname: string;
  os: { platform: string; release: string; arch: string };
  ip: string;
}

/** "host (gw4-… · linux 6.x x64 · 10.0.1.117)" — the node a forward lives on. */
function fmtNode(n?: NodeInfo): string {
  if (!n) return '';
  return `${n.hostname} (${n.gatewayId || 'unregistered'} · ${n.os.platform} ${n.os.release} ${n.os.arch} · ${n.ip})`;
}

async function handleOpenPortForward(args: Record<string, unknown>): Promise<McpToolResult> {
  const targetGatewayId = String(args.targetGatewayId || '').trim();
  const targetPort = Number(args.targetPort);
  if (!targetGatewayId) return err('targetGatewayId is required.');
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    return err('targetPort must be an integer 1–65535.');
  }
  const localPort = args.localPort !== undefined && args.localPort !== null ? Number(args.localPort) : targetPort;
  const body: Record<string, unknown> = { targetGatewayId, targetPort, localPort };
  if (args.bindHost) body.bindHost = String(args.bindHost);
  if (args.exposeLan) body.exposeLan = true;

  try {
    const data = await workerPost<ForwardEntry & { node?: NodeInfo }>('/port-forward', body);
    return ok(
      `Port forward opened on ${fmtNode(data.node)}.\n` +
        `  forwardId: ${data.forwardId}\n` +
        `  listening: ${data.bindHost}:${data.localPort} (on the node above)\n` +
        `  -> target: ${data.targetGatewayId}:${data.targetPort}`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleListPortForwards(): Promise<McpToolResult> {
  try {
    const data = await workerGet<{ node?: NodeInfo; forwards: ForwardEntry[] }>('/port-forward');
    const forwards = data.forwards || [];
    const header = `Node: ${fmtNode(data.node)}`;
    if (forwards.length === 0) return ok(`${header}\n\nNo active port forwards on this node.`);
    const lines = forwards.map(
      (f) => {
        const h = f.health
          ? ` [target ${f.health.status}${f.health.lastError ? `: ${f.health.lastError}` : ''} since ${f.health.since}]`
          : '';
        return `- ${f.forwardId}\n  ${f.bindHost}:${f.localPort} -> ${f.targetGatewayId}:${f.targetPort}` +
          (typeof f.activeStreams === 'number' ? ` (${f.activeStreams} active streams)` : '') + h;
      },
    );
    return ok(`${header}\n\nActive port forwards (${forwards.length}):\n${lines.join('\n')}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleClosePortForward(args: Record<string, unknown>): Promise<McpToolResult> {
  const forwardId = String(args.forwardId || '').trim();
  if (!forwardId) return err('forwardId is required.');
  try {
    await workerDelete('/port-forward', { forwardId });
    return ok(`Closed port forward ${forwardId}.`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const PORT_FORWARD_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  open_port_forward: handleOpenPortForward,
  list_port_forwards: () => handleListPortForwards(),
  close_port_forward: handleClosePortForward,
};
