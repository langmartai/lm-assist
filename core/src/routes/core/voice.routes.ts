/**
 * Voice v2 Routes (lm-assist)
 *
 * Endpoints: /voice/claude/capability, /voice/claude/client-error
 */

import type { RouteHandler, RouteContext } from '../index';
import { wrapResponse } from '../../api/helpers';
import * as voiceCapability from '../../voice/voice-v2-capability';
import * as claudeaiSession from '../../utils/claudeai-session';

/**
 * Same truthy-flag check rest-server.ts's maybeStartHttps() uses to decide whether the
 * opt-in HTTPS terminator starts (LM_HTTPS=1/true/on/yes). Voice v2 needs that terminator
 * up for a secure same-origin WSS, so the capability probe mirrors this exact check rather
 * than inferring "on" a different way and risking the two definitions drifting apart.
 */
function isHttpsEnabled(): boolean {
  const flag = (process.env.LM_HTTPS || '').toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(flag);
}

export function createVoiceRoutes(ctx: RouteContext): RouteHandler[] {
  return [
    // GET /voice/claude/capability - read-only voice-v2 preconditions (https terminator,
    // claude.ai cookie, system Chrome) so the client can hide the toggle instead of
    // showing it and erroring on click. Never throws — a missing precondition is just
    // `available: false` with a reason, same contract as voiceV2Capability() itself.
    {
      method: 'GET',
      pattern: /^\/voice\/claude\/capability$/,
      handler: async () => {
        const start = Date.now();
        const result = voiceCapability.voiceV2Capability({
          httpsEnabled: isHttpsEnabled(),
          cookiePresent: !!claudeaiSession.readClaudeAISession()?.cookie,
          chromePath: voiceCapability.resolveChromePath(),
        });
        return wrapResponse(result, start);
      },
    },

    // POST /voice/claude/client-error - the browser reporting WHY voice failed.
    //
    // Deliberately HTTP and not the voice WebSocket. The first version of this reported over
    // the socket, which silently dropped the most important cases: when the engine fails fast
    // (unsupported API, instantly-denied mic) the socket is still CONNECTING, so
    // readyState !== OPEN and nothing was ever sent. That is exactly the failure shape seen on
    // the device we could not inspect — `up=0 ... 1ms` with no explanation attached. An HTTP
    // POST has no such dependency on connection state.
    //
    // Write-only and log-only: it stores nothing and returns nothing but an ack, so the worst a
    // bad actor achieves is a line in our log. Fields are truncated on the way in.
    {
      method: 'POST',
      pattern: /^\/voice\/claude\/client-error$/,
      handler: async (req) => {
        const start = Date.now();
        const body = (req.body || {}) as { message?: string; ua?: string; caps?: Record<string, unknown>; stage?: string };
        const trim = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
        const msg = trim(body.message, 200);
        const ua = trim(body.ua, 200);
        const stage = trim(body.stage, 40);
        let caps = '';
        try { caps = JSON.stringify(body.caps ?? {}).slice(0, 300); } catch { caps = '{}'; }
        console.log(`[claude-voice CLIENT] ${stage ? `stage=${stage} ` : ''}error=${JSON.stringify(msg)}`);
        if (ua) console.log(`[claude-voice CLIENT]   ua: ${ua}`);
        console.log(`[claude-voice CLIENT]   caps: ${caps}`);
        return wrapResponse({ ok: true }, start);
      },
    },
  ];
}
