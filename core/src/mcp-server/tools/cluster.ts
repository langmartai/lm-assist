/**
 * Cluster MCP tools — fleet cluster management.
 *
 *   cluster_list    (read)  — GET  /cluster/list
 *   cluster_assign  (write) — POST /cluster/assign
 *   cluster_unassign(write) — POST /cluster/unassign
 *   cluster_describe(write) — POST /cluster/describe
 *
 * Each tool calls the local lm-assist route via the in-process passthrough
 * helpers (workerGet / workerPost), following the same pattern as node-builds.ts.
 *
 * Registration: CLUSTER_TOOL_DEFS + CLUSTER_HANDLERS → expanded.ts.
 * Scopes: cluster_list:'read', cluster_assign/unassign/describe:'write' → configure.ts.
 */
import { ok, err, workerGet, workerPost, type McpToolResult } from './_passthrough';

// ── Tool definitions ──────────────────────────────────────────────────────────

export const clusterListToolDef = {
  name: 'cluster_list',
  description:
    'List all clusters in the fleet with their members (online/offline), leader, description, ' +
    'and status. Also reports which cluster THIS node belongs to (`myCluster`). ' +
    'Use before cluster_assign to see the current fleet grouping. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

export const clusterAssignToolDef = {
  name: 'cluster_assign',
  description:
    'Assign a node to a named cluster. Pass `node` as a gatewayId OR hostname; pass `cluster` ' +
    'as the target cluster name (e.g. "release", "dev"). If the node is this host the ' +
    'assignment is local; otherwise it is proxied to the target node. WRITE — changes fleet state.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      node: { type: 'string', description: 'Target node: gatewayId or hostname.' },
      cluster: { type: 'string', description: 'Cluster name to assign the node to.' },
    },
    required: ['node', 'cluster'],
  },
};

export const clusterUnassignToolDef = {
  name: 'cluster_unassign',
  description:
    'Remove a node from its current cluster by resetting it to the "default" cluster. ' +
    'Pass `node` as a gatewayId OR hostname. WRITE — changes fleet state.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      node: { type: 'string', description: 'Target node: gatewayId or hostname.' },
    },
    required: ['node'],
  },
};

export const clusterDescribeToolDef = {
  name: 'cluster_describe',
  description:
    'Annotate a cluster with a human-readable description and optional status string ' +
    '(e.g. "stable", "in-progress"). Omit `cluster` to annotate this node\'s own cluster. ' +
    'WRITE — updates the fleet-wide cluster metadata.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      cluster: { type: 'string', description: 'Cluster name to annotate (default: this node\'s cluster).' },
      description: { type: 'string', description: 'Human-readable description for the cluster.' },
      status: { type: 'string', description: 'Optional status tag (e.g. "stable", "in-progress").' },
    },
    required: ['description'],
  },
};

export const CLUSTER_TOOL_DEFS = [
  clusterListToolDef,
  clusterAssignToolDef,
  clusterUnassignToolDef,
  clusterDescribeToolDef,
] as const;

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleClusterList(): Promise<McpToolResult> {
  try {
    const data = await workerGet('/cluster/list');
    return ok(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleClusterAssign(args: Record<string, unknown>): Promise<McpToolResult> {
  const node = typeof args.node === 'string' ? args.node.trim() : '';
  const cluster = typeof args.cluster === 'string' ? args.cluster.trim() : '';
  if (!node || !cluster) return err('node and cluster are required.');
  try {
    const data = await workerPost('/cluster/assign', { node, cluster });
    return ok(JSON.stringify(data, null, 2));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleClusterUnassign(args: Record<string, unknown>): Promise<McpToolResult> {
  const node = typeof args.node === 'string' ? args.node.trim() : '';
  if (!node) return err('node is required.');
  try {
    const data = await workerPost('/cluster/unassign', { node });
    return ok(JSON.stringify(data, null, 2));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleClusterDescribe(args: Record<string, unknown>): Promise<McpToolResult> {
  const description = typeof args.description === 'string' ? args.description : '';
  if (!description) return err('description is required.');
  const body: Record<string, unknown> = { description };
  if (typeof args.cluster === 'string' && args.cluster.trim()) body.cluster = args.cluster.trim();
  if (typeof args.status === 'string' && args.status.trim()) body.status = args.status.trim();
  try {
    const data = await workerPost('/cluster/describe', body);
    return ok(JSON.stringify(data, null, 2));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const CLUSTER_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  cluster_list: () => handleClusterList(),
  cluster_assign: handleClusterAssign,
  cluster_unassign: handleClusterUnassign,
  cluster_describe: handleClusterDescribe,
};
