/**
 * Voice v2 Routes (lm-assist)
 *
 * Endpoints: /voice/claude/capability
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
  ];
}
