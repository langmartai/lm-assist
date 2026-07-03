/**
 * Transport routes — local control surface to drive the node-to-node transport
 * driver (feature 1) + file/dir transfer (feature 2). Loopback usage + e2e
 * trigger. openChannel auto-negotiates: tries direct (UDP hole-punch), falls
 * back to hub relay.
 *
 *   POST /transport/send-file        { peerGatewayId, localPath, remotePath }
 *   POST /transport/list-remote      { peerGatewayId, remotePath }
 *   GET  /transport/jobs             ?peer=&state=  -- job manager snapshot (filterable)
 *   GET  /transport/jobs/:id         -- one job's status
 *   POST /transport/jobs/:id/cancel  -- cancel a queued or active job
 *
 * Sends are enqueued through the durable job manager (file-transfer/job-manager.ts)
 * rather than run inline — see /transport/send-file below for the wait:true
 * (synchronous) vs default (fire-and-forget jobId) contract.
 */

import * as fs from 'fs';
import type { RouteContext, RouteHandler, ParsedRequest } from '../index';
import { listRemote, TransferError, snapshotTransfers, enqueueJob, cancelJob, getJob, snapshot, waitForJob, requestFs, listDirAbs, statAbs, listDrives, readFileAbs } from '../../file-transfer';

export function createTransportRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/transport\/stats$/,
      handler: async () => ({ success: true, data: snapshotTransfers() }),
    },
    {
      method: 'GET',
      pattern: /^\/transport\/queue$/,
      handler: async () => ({ success: true, data: snapshot() }),
    },
    {
      method: 'GET',
      pattern: /^\/transport\/jobs$/,
      handler: async (req: ParsedRequest) => {
        const snap = snapshot();
        const peer = typeof req.query?.peer === 'string' ? req.query.peer : '';
        const state = typeof req.query?.state === 'string' ? req.query.state : '';
        const jobs = peer || state
          ? snap.jobs.filter((j) => (!peer || j.peer === peer) && (!state || j.state === state))
          : snap.jobs;
        return { success: true, data: { ...snap, jobs } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/transport\/jobs\/(?<id>[^/]+)$/,
      handler: async (req: ParsedRequest) => {
        const job = getJob(req.params.id);
        if (!job) return { success: false, error: `job not found: ${req.params.id}`, code: 'NOT_FOUND' };
        return { success: true, data: job };
      },
    },
    {
      method: 'POST',
      pattern: /^\/transport\/jobs\/(?<id>[^/]+)\/cancel$/,
      handler: async (req: ParsedRequest) => {
        const b = req.body || {};
        const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim() : undefined;
        const cancelled = cancelJob(req.params.id, reason);
        return { success: true, data: { cancelled } };
      },
    },
    {
      method: 'POST',
      pattern: /^\/transport\/send-file$/,
      handler: async (req: ParsedRequest) => {
        const b = req.body || {};
        const peerGatewayId = String(b.peerGatewayId || '');
        const localPath = String(b.localPath || '');
        const remotePath = String(b.remotePath || '');
        if (!peerGatewayId || !localPath || !remotePath) {
          return { success: false, error: 'peerGatewayId, localPath, remotePath required' };
        }
        try {
          const o: { forceMode?: 'direct' | 'relay'; timeoutMs?: number; maxRetries?: number; ttlMs?: number } = {};
          // forceMode (direct|relay), when given, is threaded onto the JobRecord
          // and applied by the default executor's sendPath() call (job-manager.ts).
          // Omitted => undefined => today's auto-negotiation (try direct, fall
          // back to relay) — unchanged for every caller that doesn't pass it.
          if (b.forceMode === 'relay' || b.forceMode === 'direct') o.forceMode = b.forceMode;
          if (typeof b.timeoutMs === 'number') o.timeoutMs = b.timeoutMs;
          if (typeof b.maxRetries === 'number') o.maxRetries = b.maxRetries;
          if (typeof b.ttlMs === 'number') o.ttlMs = b.ttlMs;

          const size = fs.statSync(localPath).size;
          const jobId = enqueueJob({
            peer: peerGatewayId,
            source: { kind: 'file', path: localPath },
            sink: { kind: 'file', path: remotePath },
            size,
            ttlMs: o.ttlMs,
            maxAttempts: o.maxRetries,
            forceMode: o.forceMode,
          });

          // Default: ENQUEUE and return a jobId immediately (non-blocking). The
          // send runs from the job manager; poll /transport/jobs/:id (or
          // /transport/jobs, /transport/queue). Pass wait:true to block until
          // the job reaches a terminal state (or o.timeoutMs/120s elapses).
          if (b.wait === true) {
            const v = await waitForJob(jobId, o.timeoutMs ?? 120000);
            return v.state === 'done'
              ? { success: true, data: v }
              : v.state === 'queued' || v.state === 'active' || v.state === 'retry-wait'
                ? { success: true, data: { jobId, state: v.state } }
                : { success: false, error: v.error || v.state };
          }
          return { success: true, data: { jobId, state: 'queued' } };
        } catch (e) {
          return {
            success: false,
            error: e instanceof Error ? e.message : String(e),
            code: e instanceof TransferError ? e.code : undefined,
          };
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/transport\/list-remote$/,
      handler: async (req: ParsedRequest) => {
        const b = req.body || {};
        const peerGatewayId = String(b.peerGatewayId || '');
        const remotePath = String(b.remotePath || '');
        if (!peerGatewayId || !remotePath) {
          return { success: false, error: 'peerGatewayId, remotePath required' };
        }
        try {
          const entries = await listRemote(peerGatewayId, remotePath);
          return { success: true, data: { entries } };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/storage\/drives$/,
      handler: async (req: ParsedRequest) => {
        const b = req.body || {};
        try {
          if (b.peerGatewayId) {
            const data = await requestFs(String(b.peerGatewayId), { op: 'drives', refresh: b.refresh === true });
            return { success: true, data: { drives: data, node: String(b.peerGatewayId) } };
          }
          const drives = await listDrives({ refresh: b.refresh === true });
          return { success: true, data: { drives } };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/storage\/list$/,
      handler: async (req: ParsedRequest) => {
        const b = req.body || {};
        const p = String(b.path || '');
        if (!p) return { success: false, error: 'path required' };
        const pattern = typeof b.pattern === 'string' && b.pattern ? b.pattern : undefined;
        const regex = b.regex === true;
        try {
          if (b.peerGatewayId) {
            const data = await requestFs(String(b.peerGatewayId), { op: 'list', path: p, refresh: b.refresh === true, pattern, regex });
            return { success: true, data };
          }
          const data = await listDirAbs(p, { refresh: b.refresh === true, pattern, regex });
          return { success: true, data };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/storage\/stat$/,
      handler: async (req: ParsedRequest) => {
        const b = req.body || {};
        const p = String(b.path || '');
        if (!p) return { success: false, error: 'path required' };
        try {
          if (b.peerGatewayId) {
            const data = await requestFs(String(b.peerGatewayId), { op: 'stat', path: p, refresh: b.refresh === true });
            return { success: true, data };
          }
          const data = await statAbs(p, { refresh: b.refresh === true });
          return { success: true, data };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/storage\/read$/,
      handler: async (req: ParsedRequest) => {
        const b = req.body || {};
        const p = String(b.path || '');
        if (!p) return { success: false, error: 'path required' };
        const offset = Number.isFinite(Number(b.offset)) ? Number(b.offset) : undefined;
        const maxBytes = Number.isFinite(Number(b.maxBytes)) ? Number(b.maxBytes) : undefined;
        try {
          if (b.peerGatewayId) {
            const data = await requestFs(String(b.peerGatewayId), { op: 'read', path: p, offset, maxBytes });
            return { success: true, data };
          }
          const data = await readFileAbs(p, { offset, maxBytes });
          return { success: true, data };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
  ];
}
