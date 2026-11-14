/**
 * Remote Control routes — drive a Claude Code session connected to claude.ai
 * Remote Control (the cloud control channel). This is the cross-platform
 * "remote session interface" injection backend, the peer of the Linux tmux and
 * Windows-terminal control surfaces — but the transport is claude.ai's
 * /v1/sessions/{id}/events over OAuth (token from ~/.claude/.credentials.json),
 * so it reaches a session that local tmux/WT cannot (e.g. another machine).
 *
 *   GET  /terminal/remote-control/:sessionId       -> { connected, driveable, rcId, status }
 *   POST /terminal/remote-control/:sessionId/send  { text, origin? } -> relay a user turn
 *
 * The :sessionId may be a real Remote-Control id (session_… / cse_…), used
 * directly, OR a name/title matched against the live session list.
 *
 * REQUIRES a valid claude.ai OAuth login on this host. If the token is missing
 * or expired, both endpoints report driveable:false / fail cleanly so the
 * session-messaging driver chain falls back to the local drivers.
 *
 * DELIVERY IS RECEIPT-GATED. Measured 2026-09-09 against a live bridge session:
 * `POST /v1/sessions/{sid}/events` answers 200 with a bare ECHO of the event and
 * enqueues NOTHING for a `--remote-control` session, while
 * `POST /v1/code/sessions/{cse}/events` answers with a real
 * `results[{event_id, sequence_num, duplicate}]` receipt. This route used to
 * post the first one itself and report `delivered:true` off the 200 — five
 * drives reported success and none arrived. It now delegates to
 * `ccrCloud.cloudDrive`, which gates on the receipt, falls back to the client
 * channel, and reuses one event uuid so the retry dedupes instead of
 * double-delivering.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RouteContext, RouteHandler, ParsedRequest } from '../index';
import { parseOrigin } from '../../session-messaging/origin';
import * as ccrCloud from '../../terminal/ccr-cloud';

const API = 'https://api.anthropic.com';

interface Auth { token: string; org: string }

/** Read claude.ai OAuth token + org; null if missing or expired. */
function readAuth(): Auth | null {
  try {
    const cred = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf-8'));
    const o = cred.claudeAiOauth || {};
    if (!o.accessToken) return null;
    if (typeof o.expiresAt === 'number' && Date.now() > o.expiresAt) return null; // expired
    const root = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8'));
    const org = root?.oauthAccount?.organizationUuid;
    if (!org) return null;
    return { token: String(o.accessToken), org: String(org) };
  } catch {
    return null;
  }
}

function authHeaders(a: Auth): Record<string, string> {
  return {
    Authorization: `Bearer ${a.token}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': a.org,
    'Content-Type': 'application/json',
  };
}

/** Resolve a target to a Remote-Control session id. Direct id passes through;
 *  otherwise best-effort match against the live session list by title. */
async function resolveRcId(target: string, a: Auth): Promise<{ id: string; status?: string } | null> {
  if (/^(session_|cse_)/.test(target)) return { id: target };
  try {
    const r = await fetch(`${API}/v1/sessions?limit=100`, { headers: authHeaders(a), signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: Array<{ id: string; title?: string; session_status?: string }> };
    const hit = (j.data || []).find((s) => s.title === target || (s.title || '').includes(target));
    return hit ? { id: hit.id, status: hit.session_status } : null;
  } catch {
    return null;
  }
}


export function createRemoteControlRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'GET',
      pattern: /^\/terminal\/remote-control\/(?<sessionId>[^/]+)$/,
      handler: async (req: ParsedRequest) => {
        const a = readAuth();
        if (!a) return { success: true, data: { connected: false, driveable: false, reason: 'no valid claude.ai login (token missing/expired)' } };
        const rc = await resolveRcId(req.params.sessionId, a);
        if (!rc) return { success: true, data: { connected: false, driveable: false } };
        return { success: true, data: { connected: true, driveable: true, rcId: rc.id, status: rc.status } };
      },
    },
    {
      method: 'POST',
      pattern: /^\/terminal\/remote-control\/(?<sessionId>[^/]+)\/send$/,
      handler: async (req: ParsedRequest) => {
        const a = readAuth();
        if (!a) return { success: false, error: 'no valid claude.ai login (token missing/expired)' };
        const text = String((req.body as { text?: string })?.text ?? '');
        if (!text) return { success: false, error: 'text required' };
        const origin = parseOrigin((req.body as { origin?: unknown })?.origin);
        const rc = await resolveRcId(req.params.sessionId, a);
        if (!rc) return { success: false, error: `remote-control session not found: ${req.params.sessionId}` };
        // Delegate to cloudDrive rather than posting the event here. It owns the
        // two-ingress dance this route used to get wrong: /v1/sessions/{sid}/events
        // answers 200 with a bare ECHO for a --remote-control bridge session and
        // enqueues nothing, so a 2xx here reported delivered:true while the turn
        // vanished. cloudDrive gates on a delivery RECEIPT, falls back to the
        // client channel, and reuses one event uuid so the retry dedupes.
        try {
          const out = await ccrCloud.cloudDrive({ sid: rc.id, text, ...(origin ? { origin } : {}) });
          return { success: true, data: { rcId: rc.id, delivered: out.delivered, eventId: out.eventId, duplicate: out.duplicate } };
        } catch (e) {
          const code = (e as { code?: string })?.code;
          return { success: false, error: e instanceof Error ? e.message : String(e), ...(code ? { code } : {}) };
        }
      },
    },
  ];
}
