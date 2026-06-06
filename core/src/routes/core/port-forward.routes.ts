/**
 * Port Forward Routes
 *
 * Local control surface for node-to-node TCP port forwarding. Opening a forward
 * makes THIS node listen on a local port and tunnel every connection — over the
 * existing hub WebSocket — to another lm-assist node's local port.
 *
 *   POST   /port-forward   { localPort, targetGatewayId, targetPort, bindHost? }
 *   GET    /port-forward
 *   DELETE /port-forward   { forwardId }
 *
 * The target node is addressed by its gatewayId/hostId (from `list_nodes`) or
 * hostname. The hub only bridges nodes owned by the same user.
 */

import type { RouteContext, RouteHandler, ParsedRequest } from '../index';
import { getHubClient, isHubConfigured } from '../../hub-client';

export function createPortForwardRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // POST /port-forward — open a local listener that forwards to a target node
    {
      method: 'POST',
      pattern: /^\/port-forward$/,
      handler: async (req: ParsedRequest) => {
        if (!isHubConfigured()) {
          return { success: false, error: 'Hub not configured — port forwarding requires a hub connection' };
        }
        const { localPort, targetGatewayId, targetPort, bindHost } = req.body || {};

        if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
          return { success: false, error: 'localPort must be an integer 0–65535 (0 = ephemeral)' };
        }
        if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
          return { success: false, error: 'targetPort must be an integer 1–65535' };
        }
        if (!targetGatewayId || typeof targetGatewayId !== 'string') {
          return { success: false, error: 'targetGatewayId (target node hostId or hostname) is required' };
        }
        // Default is loopback; only allow explicitly binding to loopback addresses
        // so a forward can't accidentally expose the tunnel on a public interface.
        if (bindHost && !['127.0.0.1', '::1', 'localhost'].includes(bindHost)) {
          return { success: false, error: 'bindHost must be a loopback address (127.0.0.1, ::1, or localhost)' };
        }

        const hub = getHubClient();
        if (!hub.getStatus().authenticated) {
          return { success: false, error: 'Hub not connected/authenticated yet — try again shortly' };
        }

        try {
          const result = await hub.openPortForward({ localPort, targetGatewayId, targetPort, bindHost });
          return {
            success: true,
            data: { ...result, targetGatewayId, targetPort, node: hub.getNodeInfo() },
          };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    },

    // GET /port-forward — list active forwards on this node
    {
      method: 'GET',
      pattern: /^\/port-forward$/,
      handler: async () => {
        const hub = getHubClient();
        return { success: true, data: { node: hub.getNodeInfo(), forwards: hub.listPortForwards() } };
      },
    },

    // GET /port-forward/check?port=NNNN — is a local port free on this node, and who holds it
    {
      method: 'GET',
      pattern: /^\/port-forward\/check$/,
      handler: async (req: ParsedRequest) => {
        const port = parseInt(String(req.query?.port ?? ''), 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return { success: false, error: 'port query param must be an integer 1–65535' };
        }
        const hub = getHubClient();
        const status = await hub.checkLocalPort(port);
        return { success: true, data: { port, node: hub.getNodeInfo(), ...status } };
      },
    },

    // DELETE /port-forward — close a forward by id
    {
      method: 'DELETE',
      pattern: /^\/port-forward$/,
      handler: async (req: ParsedRequest) => {
        const { forwardId } = req.body || {};
        if (!forwardId || typeof forwardId !== 'string') {
          return { success: false, error: 'forwardId is required' };
        }
        const hub = getHubClient();
        const closed = hub.closePortForward(forwardId);
        return closed
          ? { success: true, data: { forwardId, closed: true } }
          : { success: false, error: `No such forward: ${forwardId}` };
      },
    },
  ];
}
