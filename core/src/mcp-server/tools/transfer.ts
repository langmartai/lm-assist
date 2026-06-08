/**
 * File/dir transfer + data-plane stats MCP tools — wrap the worker's
 * /transport/* REST routes (single source of truth). The `node` selector
 * (configure.ts) picks which node runs the command; `peerGatewayId` names the
 * other node. Both nodes must belong to you.
 *
 * Wiring: registered in EXPANDED_TOOL_DEFS + EXPANDED_HANDLERS (expanded.ts) and
 * scoped in configure.ts TOOL_SCOPES.
 */
import { ok, err, workerGet, workerPost, type McpToolResult } from './_passthrough';

export const sendFileToolDef = {
  name: 'transfer_send_file',
  description:
    'Send a local file or directory from one lm-assist node to another over the node-to-node ' +
    'transport (direct UDP firehose when a direct path exists, else hub relay; automatic + ' +
    'integrity-verified). `node` selector = the SENDER; `peerGatewayId` = the receiver ' +
    '(from list_nodes). Trigger words: "send file to my other node", "copy this dir to host B". ' +
    'Returns bytes, mode (bidi/oneway/relay), and via (host/static/srflx).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      peerGatewayId: { type: 'string', description: 'Receiver node hostId/gatewayId (from list_nodes).' },
      localPath: { type: 'string', description: 'Absolute path of the file or directory to send (on the sender node).' },
      remotePath: { type: 'string', description: 'Destination path/name on the receiver (relative to its receive root).' },
      forceMode: { type: 'string', enum: ['direct', 'relay'], description: 'Optional: force transport path. Default auto.' },
      wait: { type: 'boolean', description: 'Block until the transfer completes (sync). Default false — enqueue and return a jobId; poll transfer_queue.' },
    },
    required: ['peerGatewayId', 'localPath', 'remotePath'],
  },
};

export const listRemoteToolDef = {
  name: 'transfer_list_remote',
  description:
    'List a directory on another lm-assist node over the transport. `node` selector = the node ' +
    'that asks; `peerGatewayId` = the node whose directory to list. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      peerGatewayId: { type: 'string', description: 'Node hostId/gatewayId whose directory to list.' },
      remotePath: { type: 'string', description: 'Absolute directory path on the peer node.' },
    },
    required: ['peerGatewayId', 'remotePath'],
  },
};

export const transferStatsToolDef = {
  name: 'transfer_stats',
  description:
    'Data-plane transfer stats on a node (use the `node` selector). Each active + recent ' +
    'file/dir transfer: bytes/total/percent, elapsed, instant + average MB/s, p2p round-trip ' +
    'latency (rttMs), mode (bidi/oneway/relay), via, direction, peer, state. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const portForwardStatsToolDef = {
  name: 'port_forward_stats',
  description:
    'Per-forward traffic stats on a node (use the `node` selector): bytesUp/Down + total, ' +
    'stream count, elapsed, instant + average MB/s, forward-path ping/pong latency (rttMs), ' +
    'and target health. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const transferQueueToolDef = {
  name: 'transfer_queue',
  description:
    'Send-queue status on a node (use the `node` selector): each queued / active / done / ' +
    'failed send job with state, bytes + percent, MB/s, mode/via, and any error. Sends are ' +
    'enqueued (non-blocking) and run from this queue. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const TRANSFER_TOOL_DEFS = [
  sendFileToolDef,
  listRemoteToolDef,
  transferStatsToolDef,
  portForwardStatsToolDef,
  transferQueueToolDef,
] as const;

async function handleSendFile(args: Record<string, unknown>): Promise<McpToolResult> {
  const peerGatewayId = String(args.peerGatewayId || '').trim();
  const localPath = String(args.localPath || '').trim();
  const remotePath = String(args.remotePath || '').trim();
  if (!peerGatewayId || !localPath || !remotePath) {
    return err('peerGatewayId, localPath, remotePath are all required.');
  }
  const body: Record<string, unknown> = { peerGatewayId, localPath, remotePath };
  if (args.forceMode === 'direct' || args.forceMode === 'relay') body.forceMode = args.forceMode;
  if (args.wait === true) body.wait = true;
  try {
    const d = await workerPost<{ jobId?: string; state?: string; bytes?: number; entries?: number; mode?: string; via?: string | null }>(
      '/transport/send-file',
      body,
    );
    if (d.jobId) {
      return ok(
        `Queued send to ${peerGatewayId} as "${remotePath}" — jobId ${d.jobId} (${d.state}).\n` +
          `Poll transfer_queue (or transfer_stats) for progress.`,
      );
    }
    return ok(
      `Sent ${d.bytes} bytes (${d.entries} entr${d.entries === 1 ? 'y' : 'ies'}) to ${peerGatewayId} as "${remotePath}".\n` +
        `  mode: ${d.mode ?? '-'} via ${d.via ?? '-'}`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface QJob {
  jobId: string; state: string; peerGatewayId: string; remotePath: string; localPath: string;
  bytes?: number; totalBytes?: number; pct?: number; instantMBps?: number; avgMBps?: number;
  rttMs?: number | null; mode?: string; via?: string | null; error?: string;
}
async function handleTransferQueue(): Promise<McpToolResult> {
  try {
    const d = await workerGet<{ maxConcurrent: number; active: number; pending: number; jobs: QJob[] }>('/transport/queue');
    const jobs = d.jobs || [];
    const fmt = (j: QJob) =>
      `  [${j.state}] ${j.localPath} -> ${j.peerGatewayId}:${j.remotePath}` +
      (j.state === 'active' ? ` ${j.pct ?? 0}% inst=${j.instantMBps ?? 0} avg=${j.avgMBps ?? 0}MB/s rtt=${j.rttMs ?? '-'}ms ${j.mode ?? '-'}/${j.via ?? '-'}` : '') +
      (j.state === 'done' ? ` ${j.bytes ?? 0}B ${j.mode ?? '-'}/${j.via ?? '-'}` : '') +
      (j.error ? ` ERROR: ${j.error}` : '') +
      ` (${j.jobId.slice(0, 8)})`;
    return ok(
      `Send queue — ${d.active} active / ${d.pending} pending (max ${d.maxConcurrent}):\n` +
        (jobs.length ? jobs.map(fmt).join('\n') : '  no jobs'),
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleListRemote(args: Record<string, unknown>): Promise<McpToolResult> {
  const peerGatewayId = String(args.peerGatewayId || '').trim();
  const remotePath = String(args.remotePath || '').trim();
  if (!peerGatewayId || !remotePath) return err('peerGatewayId and remotePath are required.');
  try {
    const d = await workerPost<{ entries: Array<{ relPath: string; size: number; isDir: boolean }> }>(
      '/transport/list-remote',
      { peerGatewayId, remotePath },
    );
    const entries = d.entries || [];
    if (!entries.length) return ok(`(empty) ${remotePath} on ${peerGatewayId}`);
    return ok(
      `${remotePath} on ${peerGatewayId} (${entries.length}):\n` +
        entries.map((e) => `  ${e.isDir ? 'd' : '-'} ${e.size}\t${e.relPath}`).join('\n'),
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface TStat {
  direction: string; kind: string; remotePath: string; bytes: number; totalBytes: number;
  pct: number; instantMBps: number; avgMBps: number; rttMs?: number | null;
  mode?: string; via?: string | null; state: string; peerGatewayId: string;
}
function fmtT(t: TStat): string {
  return `  ${t.direction}/${t.kind} ${t.remotePath} ${t.pct}% (${t.bytes}/${t.totalBytes}B) ` +
    `inst=${t.instantMBps} avg=${t.avgMBps}MB/s rtt=${t.rttMs ?? '-'}ms ${t.mode ?? '-'}/${t.via ?? '-'} ` +
    `peer=${t.peerGatewayId} [${t.state}]`;
}
async function handleTransferStats(): Promise<McpToolResult> {
  try {
    const d = await workerGet<{ active: TStat[]; recent: TStat[] }>('/transport/stats');
    const a = d.active || [];
    const r = (d.recent || []).slice(0, 10);
    return ok(
      `ACTIVE transfers (${a.length}):\n${a.map(fmtT).join('\n') || '  none'}\n\n` +
        `RECENT (${r.length}):\n${r.map(fmtT).join('\n') || '  none'}`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface FStat {
  forwardId: string; localPort: number; bindHost?: string; targetGatewayId: string; targetPort: number;
  activeStreams: number; streamsTotal: number; bytesUp: number; bytesDown: number; totalBytes: number;
  avgMBps: number; instantMBps: number; rttMs?: number | null; health?: { status: string };
}
async function handlePortForwardStats(): Promise<McpToolResult> {
  try {
    const d = await workerGet<{ forwards: FStat[] }>('/port-forward/stats');
    const f = d.forwards || [];
    if (!f.length) return ok('No active port forwards on this node.');
    return ok(
      `Port forwards (${f.length}):\n` +
        f
          .map(
            (x) =>
              `  ${x.bindHost ?? '127.0.0.1'}:${x.localPort} -> ${x.targetGatewayId}:${x.targetPort}  ` +
              `up=${x.bytesUp} down=${x.bytesDown} (${x.totalBytes}B) streams=${x.activeStreams}/${x.streamsTotal} ` +
              `inst=${x.instantMBps} avg=${x.avgMBps}MB/s rtt=${x.rttMs ?? '-'}ms [${x.health?.status ?? '?'}]`,
          )
          .join('\n'),
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const TRANSFER_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  transfer_send_file: handleSendFile,
  transfer_queue: () => handleTransferQueue(),
  transfer_list_remote: handleListRemote,
  transfer_stats: () => handleTransferStats(),
  port_forward_stats: () => handlePortForwardStats(),
};
