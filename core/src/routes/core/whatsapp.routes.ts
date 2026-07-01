/**
 * WhatsApp Routes (lm-assist)
 *
 * Drive a logged-in WhatsApp Web session (WhatsApp Desktop WebView2 on Windows,
 * or a debug-port Chrome anywhere) over CDP. One POST entrypoint + introspection:
 *
 *   GET  /whatsapp              -> { ok, data: { actions: [...] } }
 *   POST /whatsapp/<action>     body = action params -> { ok, data } | { ok:false, error }
 *
 * Actions: status, chats, read (read-only); open, type, send (mutating).
 * The CDP endpoint is configurable per call (`cdpUrl`/`port`) or via env
 * (WHATSAPP_CDP_URL / WHATSAPP_CDP_PORT), default http://localhost:9222.
 *
 * Errors are structured: CDP_UNREACHABLE / PAGE_NOT_FOUND / NOT_LOGGED_IN /
 *   CHAT_NOT_FOUND / NO_CHAT_OPEN / BAD_REQUEST / PAGE_EVAL_ERROR / CDP_ERROR /
 *   UNKNOWN_ACTION / SERVER.
 */
import type { RouteHandler, RouteContext } from '../index';
import { runAction, WHATSAPP_ACTIONS } from '../../whatsapp/whatsapp-service';

export function createWhatsappRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/whatsapp$/,
      handler: async () => ({ success: true, data: { actions: WHATSAPP_ACTIONS } }),
    },
    {
      method: 'POST',
      pattern: /^\/whatsapp\/(?<action>.+)$/,
      handler: async (req) => {
        const action = decodeURIComponent(req.params.action || '');
        const r: any = await runAction(action, req.body || {});
        // success drives HTTP status; keep the structured {ok, data|error} body.
        return { success: !!r.ok, ...r };
      },
    },
  ];
}
