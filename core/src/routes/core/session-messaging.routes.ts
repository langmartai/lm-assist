/**
 * Session Messaging Routes
 *
 * Local control surface for cross-node session-to-session messaging. The MCP
 * tools (send_session_message / list_session_messages / get_message_status)
 * reach these routes on loopback — same pattern as the terminal + memory MCP
 * tools — so the route layer stays the single source of truth.
 *
 * Because the send MCP tool is NODE-ROUTED (the existing `node` selector — the
 * hub relays the call to the target node), these handlers always run ON the
 * node where the target session lives. They store, inject, and ack locally.
 *
 *   POST   /session-messages              { toSession, category, body, toNode?, fromNode?, fromSession? }
 *   GET    /session-messages              ?session=&status=
 *   GET    /session-messages/:id          status + ack history
 *   POST   /session-messages/:id/read     { detail? }
 *   POST   /session-messages/:id/executed { detail? }
 *   POST   /session-messages/:id/failed   { detail? }
 *   POST   /session-messages/sweep        retry pending injections
 */

import type { RouteContext, RouteHandler, ParsedRequest } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import {
  sendMessage,
  listMessages,
  getStatus,
  markRead,
  markExecuted,
  markFailed,
  sweepPending,
} from '../../session-messaging';
import type { MessageCategory, MessageStatus } from '../../session-messaging';

function localNode(): string {
  try {
    // Best-effort: derive this node's identity for provenance stamping.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getHubClient, isHubConfigured } = require('../../hub-client') as typeof import('../../hub-client');
    if (isHubConfigured()) {
      const info = getHubClient().getNodeInfo();
      return info.gatewayId || info.hostname || '';
    }
  } catch {
    /* fall through */
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('os') as typeof import('os')).hostname();
  } catch {
    return '';
  }
}

export function createSessionMessagingRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    // POST /session-messages — store + inject + ack a message for a local session
    {
      method: 'POST',
      pattern: /^\/session-messages$/,
      handler: async (req: ParsedRequest) => {
        const start = Date.now();
        const b = req.body || {};
        // `node` is the connector's ROUTING key and rides on relayed calls; it
        // is consumed as provenance below, never treated as a message field.
        try {
          const result = await sendMessage(
            {
              toSession: String(b.toSession || ''),
              category: b.category as MessageCategory,
              body: String(b.body ?? ''),
              toNode: b.toNode ? String(b.toNode) : undefined,
              fromNode: b.fromNode ? String(b.fromNode) : undefined,
              fromSession: b.fromSession ? String(b.fromSession) : undefined,
              messageId: b.messageId !== undefined ? String(b.messageId) : undefined,
            },
            { localNode: localNode() },
          );
          return wrapResponse(result, start);
        } catch (e) {
          // Typed refusal → typed code, so the caller can tell a validation
          // rejection from a transport failure instead of parsing prose.
          const code = (e as { code?: unknown })?.code;
          return wrapError(
            typeof code === 'string' && code ? code : 'SEND_FAILED',
            e instanceof Error ? e.message : String(e),
            start,
          );
        }
      },
    },

    // GET /session-messages — list (optionally ?session= &status=)
    {
      method: 'GET',
      pattern: /^\/session-messages$/,
      handler: async (req: ParsedRequest) => {
        const session = req.query?.session ? String(req.query.session) : undefined;
        const status = req.query?.status ? (String(req.query.status) as MessageStatus) : undefined;
        return { success: true, data: { messages: listMessages({ session, status }) } };
      },
    },

    // POST /session-messages/sweep — retry pending injections
    {
      method: 'POST',
      pattern: /^\/session-messages\/sweep$/,
      handler: async () => {
        const results = await sweepPending();
        return { success: true, data: { swept: results.length, results } };
      },
    },

    // GET /session-messages/:id — one message (status + acks)
    {
      method: 'GET',
      pattern: /^\/session-messages\/(?<id>[^/]+)$/,
      handler: async (req: ParsedRequest) => {
        const msg = getStatus(String(req.params.id));
        if (!msg) return { success: false, error: `message ${req.params.id} not found on this node` };
        return { success: true, data: msg };
      },
    },

    // POST /session-messages/:id/read
    {
      method: 'POST',
      pattern: /^\/session-messages\/(?<id>[^/]+)\/read$/,
      handler: async (req: ParsedRequest) => {
        const msg = markRead(String(req.params.id), req.body?.detail ? String(req.body.detail) : undefined);
        if (!msg) return { success: false, error: `message ${req.params.id} not found on this node` };
        return { success: true, data: msg };
      },
    },

    // POST /session-messages/:id/executed
    {
      method: 'POST',
      pattern: /^\/session-messages\/(?<id>[^/]+)\/executed$/,
      handler: async (req: ParsedRequest) => {
        const msg = markExecuted(String(req.params.id), req.body?.detail ? String(req.body.detail) : undefined);
        if (!msg) return { success: false, error: `message ${req.params.id} not found on this node` };
        return { success: true, data: msg };
      },
    },

    // POST /session-messages/:id/failed
    {
      method: 'POST',
      pattern: /^\/session-messages\/(?<id>[^/]+)\/failed$/,
      handler: async (req: ParsedRequest) => {
        const msg = markFailed(String(req.params.id), req.body?.detail ? String(req.body.detail) : undefined);
        if (!msg) return { success: false, error: `message ${req.params.id} not found on this node` };
        return { success: true, data: msg };
      },
    },
  ];
}
