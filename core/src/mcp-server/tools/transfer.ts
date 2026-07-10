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
    'Sends run through a durable job manager (survives peer drops + Core restarts, auto-retries, ' +
    'large single files resume from the last checkpoint). Returns bytes, mode (bidi/oneway/relay), ' +
    'and via (host/static/srflx).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      peerGatewayId: { type: 'string', description: 'Receiver node hostId/gatewayId (from list_nodes).' },
      localPath: { type: 'string', description: 'Absolute path of the file or directory to send (on the sender node).' },
      remotePath: { type: 'string', description: 'Destination path on the receiver: an ABSOLUTE path writes there directly (a target file path for a single file, or a target directory for a dir); a RELATIVE path lands under the receiver receive-root. Use fs_list / fs_stat to discover the target location first.' },
      forceMode: { type: 'string', enum: ['direct', 'relay'], description: 'Optional: force the transport path instead of automatic negotiation (direct = best-effort UDP hole-punch, relay = hub only). Threaded through the durable job manager to the underlying send.' },
      wait: { type: 'boolean', description: 'Block until the job reaches a terminal state (sync), or return {jobId,state} if it times out first (see timeoutMs). Default false — enqueue and return a jobId immediately; poll transfer_status or transfer_queue.' },
      timeoutMs: { type: 'number', description: 'With wait:true, how long to block before returning the in-flight {jobId,state} instead of the final result. Default 120000ms.' },
      maxRetries: { type: 'number', description: 'Max job-level attempts before the job is marked failed (scheduler retries with backoff). Default 5.' },
      ttlMs: { type: 'number', description: 'Job deadline in ms from enqueue; past this the job is force-expired. Default 24h.' },
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
    'and target health. The numbers reveal the transport: a same-cluster DIRECT forward shows ' +
    'native-LAN MB/s, while a hub-relay forward is capped at the hub frame rate. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const transferQueueToolDef = {
  name: 'transfer_queue',
  description:
    'Job-manager queue status on a node (use the `node` selector): each queued / active / ' +
    'retry-wait / done / failed / cancelled / expired transfer job with state, bytes + percent, ' +
    'MB/s, mode/via, and any error. Sends are enqueued (non-blocking) and run from this durable ' +
    'queue — it survives peer drops and Core restarts. Read-only. For a single job by id, use ' +
    'transfer_status instead.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const transferCancelToolDef = {
  name: 'transfer_cancel',
  description:
    'Cancel a queued or in-flight transfer job on a node (use the `node` selector). A queued ' +
    'job is removed immediately; an active job\'s transport is aborted and it settles to ' +
    '"cancelled" shortly after. Returns whether the cancel took effect — false means the job ' +
    'was already terminal (done/failed/cancelled/expired) or the jobId is unknown.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      jobId: { type: 'string', description: 'Job id returned by transfer_send_file, or listed by transfer_queue.' },
    },
    required: ['jobId'],
  },
};

export const transferStatusToolDef = {
  name: 'transfer_status',
  description:
    'Status of a single transfer job by id on a node (use the `node` selector): state, ' +
    'bytes/percent, MB/s, round-trip latency, mode/via, attempts, and any error. Read-only. ' +
    'Use this to poll a specific jobId instead of scanning the whole transfer_queue.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      jobId: { type: 'string', description: 'Job id returned by transfer_send_file, or listed by transfer_queue.' },
    },
    required: ['jobId'],
  },
};

export const TRANSFER_TOOL_DEFS = [
  sendFileToolDef,
  listRemoteToolDef,
  transferStatsToolDef,
  portForwardStatsToolDef,
  transferQueueToolDef,
  transferCancelToolDef,
  transferStatusToolDef,
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
  if (typeof args.timeoutMs === 'number') body.timeoutMs = args.timeoutMs;
  if (typeof args.maxRetries === 'number') body.maxRetries = args.maxRetries;
  if (typeof args.ttlMs === 'number') body.ttlMs = args.ttlMs;
  try {
    // Every response now carries a jobId — sends always run through the durable
    // job manager (even wait:true, which enqueues then blocks on waitForJob).
    const d = await workerPost<{ jobId: string; state: string; bytesDone?: number; size?: number; mode?: string; via?: string | null }>(
      '/transport/send-file',
      body,
    );
    if (d.state === 'done') {
      return ok(
        `Sent ${d.bytesDone ?? d.size ?? '?'} bytes to ${peerGatewayId} as "${remotePath}".\n` +
          `  mode: ${d.mode ?? '-'} via ${d.via ?? '-'} (jobId ${d.jobId})`,
      );
    }
    if (d.state === 'queued') {
      return ok(
        `Queued send to ${peerGatewayId} as "${remotePath}" — jobId ${d.jobId} (${d.state}).\n` +
          `Poll transfer_status (or transfer_queue) for progress.`,
      );
    }
    // wait:true timed out while the job was already picked up (e.g. 'active') —
    // "Queued" would misleadingly suggest it hasn't started yet.
    return ok(
      `Send ${d.state} (jobId ${d.jobId}) to ${peerGatewayId} as "${remotePath}" — still running.\n` +
        `Poll transfer_status (or transfer_queue) for progress.`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface QJob {
  jobId: string; state: string; peer: string;
  source: { kind: string; path?: string; dataKey?: string };
  sink: { kind: string; path?: string; dataKey?: string };
  size?: number; bytesDone?: number; pct?: number; instantMBps?: number; avgMBps?: number;
  rttMs?: number | null; mode?: string; via?: string | null; error?: string;
  attempts?: number; maxAttempts?: number;
}
/** SourceRef/SinkRef are a `{kind:'file',path}` | `{kind:'blob',dataKey}` union
 * (job-manager.ts) — the file adapter is the only one wired up today, but
 * display should not assume it. */
function refPath(ref: { kind: string; path?: string; dataKey?: string } | undefined): string {
  if (!ref) return '?';
  return ref.kind === 'file' ? (ref.path ?? '?') : (ref.dataKey ?? '?');
}
function fmtJob(j: QJob): string {
  return `  [${j.state}] ${refPath(j.source)} -> ${j.peer}:${refPath(j.sink)}` +
    (j.state === 'active' ? ` ${j.pct ?? 0}% inst=${j.instantMBps ?? 0} avg=${j.avgMBps ?? 0}MB/s rtt=${j.rttMs ?? '-'}ms ${j.mode ?? '-'}/${j.via ?? '-'}` : '') +
    (j.state === 'done' ? ` ${j.bytesDone ?? j.size ?? 0}B ${j.mode ?? '-'}/${j.via ?? '-'}` : '') +
    (j.state !== 'active' && j.state !== 'done' ? ` attempt ${j.attempts}/${j.maxAttempts}` : '') +
    (j.error ? ` ERROR: ${j.error}` : '') +
    ` (${j.jobId.slice(0, 8)})`;
}
async function handleTransferQueue(): Promise<McpToolResult> {
  try {
    const d = await workerGet<{ maxConcurrent: number; globalMax: number; globalActive: number; pending: number; jobs: QJob[] }>('/transport/queue');
    const jobs = d.jobs || [];
    return ok(
      `Job queue — ${d.globalActive} active / ${d.pending} pending (max ${d.maxConcurrent}/peer, ${d.globalMax} global):\n` +
        (jobs.length ? jobs.map(fmtJob).join('\n') : '  no jobs'),
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleTransferCancel(args: Record<string, unknown>): Promise<McpToolResult> {
  const jobId = String(args.jobId || '').trim();
  if (!jobId) return err('jobId is required.');
  try {
    const d = await workerPost<{ cancelled: boolean }>(`/transport/jobs/${encodeURIComponent(jobId)}/cancel`, {});
    return ok(
      d.cancelled
        ? `Cancelled job ${jobId}.`
        : `Job ${jobId} was not cancelled (already terminal, or unknown jobId).`,
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function handleTransferStatus(args: Record<string, unknown>): Promise<McpToolResult> {
  const jobId = String(args.jobId || '').trim();
  if (!jobId) return err('jobId is required.');
  try {
    const j = await workerGet<QJob>(`/transport/jobs/${encodeURIComponent(jobId)}`);
    return ok(fmtJob(j).trim());
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
  transfer_cancel: handleTransferCancel,
  transfer_status: handleTransferStatus,
  transfer_list_remote: handleListRemote,
  transfer_stats: () => handleTransferStats(),
  port_forward_stats: () => handlePortForwardStats(),
};
