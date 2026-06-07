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
import { sendPath, listRemote } from '../../file-transfer';

export function createTransportRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
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
          const res = await sendPath(peerGatewayId, localPath, remotePath);
          return { success: true, data: res };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
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
  ];
}
