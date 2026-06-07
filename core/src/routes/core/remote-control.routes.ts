/**
 * Remote Control routes — drive a Claude Code session connected to claude.ai
 * Remote Control (the cloud control channel). This is the cross-platform
 * "remote session interface" injection backend, the peer of the Linux tmux and
 * Windows-terminal control surfaces — but the transport is claude.ai's
 * /v1/sessions/{id}/events over OAuth (token from ~/.claude/.credentials.json),
 * so it reaches a session that local tmux/WT cannot (e.g. another machine).
 *
 *   GET  /terminal/remote-control/:sessionId       -> { connected, driveable, rcId, status }
 *   POST /terminal/remote-control/:sessionId/send  { text } -> relay a user turn
 *
 * The :sessionId may be a real Remote-Control id (session_… / cse_…), used
 * directly, OR a name/title matched against the live session list.
 *
 * REQUIRES a valid claude.ai OAuth login on this host. If the token is missing
 * or expired, both endpoints report driveable:false / fail cleanly so the
 * session-messaging driver chain falls back to the local drivers.
 *
 * STATUS: protocol-complete but NOT yet e2e-verified — the host's login was
 * expired during development, so the live drive (and the exact id-mapping for a
 * `claude --remote-control` LOCAL session) must be confirmed against a live
 * Remote-Control session after re-login.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { RouteContext, RouteHandler, ParsedRequest } from '../index';

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

function uuidv4(): string {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
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
        const rc = await resolveRcId(req.params.sessionId, a);
        if (!rc) return { success: false, error: `remote-control session not found: ${req.params.sessionId}` };
        // FLAT user event on the OAuth ingress (api.anthropic.com /v1/sessions/{id}/events).
        const event = {
          uuid: uuidv4(),
          session_id: rc.id,
          type: 'user',
          parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text }] },
        };
        try {
          const r = await fetch(`${API}/v1/sessions/${encodeURIComponent(rc.id)}/events`, {
            method: 'POST',
            headers: authHeaders(a),
            body: JSON.stringify({ events: [event] }),
            signal: AbortSignal.timeout(15000),
          });
          if (!r.ok) return { success: false, error: `events POST ${r.status}: ${(await r.text()).slice(0, 200)}` };
          return { success: true, data: { rcId: rc.id, delivered: true } };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
  ];
}
