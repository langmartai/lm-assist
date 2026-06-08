/**
 * Transport routes — local control surface to drive the node-to-node transport
 * driver (feature 1) + file/dir transfer (feature 2). Loopback usage + e2e
 * trigger. openChannel auto-negotiates: tries direct (UDP hole-punch), falls
 * back to hub relay.
 *
 *   POST /transport/send-file   { peerGatewayId, localPath, remotePath }
 *   POST /transport/list-remote { peerGatewayId, remotePath }
 */

import type { RouteContext, RouteHandler, ParsedRequest } from '../index';
import { sendPath, listRemote, TransferError, snapshotTransfers, enqueueSend, snapshotQueue, requestFs, listDirAbs, statAbs, listDrives } from '../../file-transfer';

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
      handler: async () => ({ success: true, data: snapshotQueue() }),
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
          const o: { forceMode?: 'direct' | 'relay'; timeoutMs?: number; maxRetries?: number } = {};
          if (b.forceMode === 'relay' || b.forceMode === 'direct') o.forceMode = b.forceMode;
          if (typeof b.timeoutMs === 'number') o.timeoutMs = b.timeoutMs;
          if (typeof b.maxRetries === 'number') o.maxRetries = b.maxRetries;
          // Default: ENQUEUE and return a jobId immediately (non-blocking). The
          // send runs from the queue; poll /transport/queue or /transport/stats.
          // Pass wait:true to block until the transfer completes (sync).
          if (b.wait === true) {
            const res = await sendPath(peerGatewayId, localPath, remotePath, o);
            return { success: true, data: res };
          }
          const jobId = enqueueSend({ peerGatewayId, localPath, remotePath, opts: o });
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
        try {
          if (b.peerGatewayId) {
            const data = await requestFs(String(b.peerGatewayId), { op: 'list', path: p, refresh: b.refresh === true });
            return { success: true, data };
          }
          const data = await listDirAbs(p, { refresh: b.refresh === true });
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
  ];
}
