/**
 * Cowork task creation — headless "create + send" for Claude cowork sessions.
 *
 * Creates a Claude **cowork** session (`cse_…`) on api.anthropic.com via the
 * Claude Code OAuth token (auto-refreshing, see `../utils/claude-oauth.ts`),
 * then sends the initial prompt. Cloud target uses the well-known
 * `anthropic_cloud` singleton environment; local target requires a caller-
 * supplied bridge `environmentId` (headless device discovery is out of scope
 * — see `docs/superpowers/specs/2026-07-11-cowork-task-creation-design.md`).
 *
 * Distinct from CCR *code* sessions (`ccr-cloud.ts` → `/v1/sessions`,
 * `claude.ai/code/{sid}`): cowork uses `/v1/code/sessions`
 * (`cse_…`, `claude.ai/cowork/{cse}`). Verified request/response shapes:
 * `docs/cowork-web-endpoints.md` §0d.
 */

import { randomUUID } from 'crypto';
import { anthropicOAuthPost, anthropicOAuthGet, anthropicOAuthPut, anthropicOAuthDelete, getOrganizationUuid } from '../utils/claude-oauth';
import { parseCoworkEvents, type CoworkDetail } from './cowork-read';

const CLOUD_ENV_ID = 'env_011111111111111111111117'; // anthropic_cloud singleton

export interface CreateCoworkTaskOpts {
  prompt: string;
  target?: 'cloud' | 'local';
  environmentId?: string;      // required when target === 'local'
  model?: string;              // default claude-sonnet-5
  effort?: string;             // default medium -> config.effort_level
  title?: string;
}

export interface CoworkTaskResult {
  sessionId: string;           // cse_…
  url: string;                 // https://claude.ai/cowork/{cse}
  target: 'cloud' | 'local';
  environmentKind?: string;    // anthropic_cloud | bridge
  environmentId: string;
  status?: string;
  model: string;
  title: string;
  warning?: string;            // set if the prompt failed to send
}

export class CoworkTaskError extends Error {
  constructor(public code: string, message: string, public httpStatus = 502) {
    super(message);
  }
}

// Match ccr-cloud.ts's private ccrOpts(): CCR beta + version + org header.
export async function ccOpts() {
  const org = await getOrganizationUuid();
  return {
    betaHeader: 'ccr-byoc-2025-07-29',
    extraHeaders: { 'anthropic-version': '2023-06-01', 'x-organization-uuid': org },
  };
}

export async function createCoworkTask(opts: CreateCoworkTaskOpts): Promise<CoworkTaskResult> {
  const prompt = (opts.prompt || '').trim();
  if (!prompt) throw new CoworkTaskError('COWORK_BAD_REQUEST', 'prompt is required', 400);

  const target = opts.target === 'local' ? 'local' : 'cloud';
  if (target === 'local' && !opts.environmentId) {
    throw new CoworkTaskError('COWORK_BAD_REQUEST', 'environmentId is required for local target', 400);
  }
  const environmentId = target === 'local' ? String(opts.environmentId) : CLOUD_ENV_ID;
  const model = opts.model || 'claude-sonnet-5';
  const effort = opts.effort || 'medium';
  const title = opts.title || (prompt.length > 60 ? prompt.slice(0, 57) + '…' : prompt);
  const cc = await ccOpts();

  // 1) create the cowork session
  const created = await anthropicOAuthPost('/v1/code/sessions', {
    environment_id: environmentId,
    config: { model, effort_level: effort },
    tags: ['cowork'],
    title,
  }, cc);
  if (created.status < 200 || created.status >= 300) {
    throw new CoworkTaskError('COWORK_CREATE_FAILED',
      `create failed (${created.status}): ${JSON.stringify(created.body).slice(0, 300)}`, 502);
  }
  const session = created.body?.session || created.body;
  const cse: string = session?.id;
  if (!cse || !cse.startsWith('cse_')) {
    throw new CoworkTaskError('COWORK_CREATE_FAILED',
      `unexpected session id in create response: ${JSON.stringify(cse)}`, 502);
  }
  const sid = 'session_' + cse.slice(4);

  // 2) send the initial prompt
  let warning: string | undefined;
  const sent = await anthropicOAuthPost(`/v1/code/sessions/${cse}/events`, {
    events: [{ payload: {
      type: 'user', uuid: randomUUID(), session_id: sid, parent_tool_use_id: null,
      message: { role: 'user', content: prompt },
    } }],
  }, cc);
  if (sent.status < 200 || sent.status >= 300) {
    warning = `session created but prompt send failed (${sent.status})`;
  }

  return {
    sessionId: cse,
    url: `https://claude.ai/cowork/${cse}`,
    target,
    environmentKind: session?.environment_kind,
    environmentId,
    status: session?.status,
    model,
    title,
    ...(warning ? { warning } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Cowork task-ops — list/get/drive/rename/archive/pin/delete against the
// same /v1/code/sessions/{cse} surface used by createCoworkTask above.
// ─────────────────────────────────────────────────────────────────────────

const COWORK_TAGS = ['cowork', 'product:cowork-remote', 'config:cowork-remote'];

export interface CoworkListItem { sid: string; title?: string; status?: string; model?: string; lastEventAt?: string; statusCategory?: string | null; archived?: boolean }

function isCowork(s: any): boolean {
  const tags: string[] = s?.tags || s?.config_tags || [];
  return Array.isArray(tags) && tags.some((t) => COWORK_TAGS.includes(t));
}

export async function listCoworkTasks(opts: { filter?: 'all' | 'cowork' | 'archived'; limit?: number } = {}): Promise<{ tasks: CoworkListItem[]; nextCursor?: string }> {
  const cc = await ccOpts();
  const res = await anthropicOAuthGet('/v1/code/sessions', { ...cc, query: `limit=${encodeURIComponent(opts.limit || 50)}` });
  if (res.status < 200 || res.status >= 300) throw new CoworkTaskError('COWORK_LIST_FAILED', `list failed (${res.status})`, 502);
  const arr: any[] = res.body?.sessions ?? res.body?.data ?? (Array.isArray(res.body) ? res.body : []);
  const tasks: CoworkListItem[] = arr.filter(isCowork).map((s) => ({
    sid: (s.id || s.session_id) as string,
    title: s.title,
    status: s.status || s.session_status,
    model: s.config?.model,
    lastEventAt: s.last_event_at || s.updated_at,
    statusCategory: s.post_turn_summary?.status_category ?? null,
    archived: !!s.archived,
  })).filter((t) => t.sid);
  const filtered = opts.filter === 'archived' ? tasks.filter((t) => t.archived)
    : opts.filter === 'all' ? tasks
    : tasks.filter((t) => !t.archived);
  return { tasks: filtered, nextCursor: res.body?.next_cursor };
}

export async function getCoworkTask(cse: string): Promise<CoworkDetail & { sid: string; title?: string; status?: string; model?: string }> {
  if (!cse.startsWith('cse_')) throw new CoworkTaskError('COWORK_BAD_REQUEST', 'cse id required', 400);
  const cc = await ccOpts();
  const [ev, se] = await Promise.all([
    anthropicOAuthGet(`/v1/code/sessions/${cse}/events`, { ...cc, query: 'limit=500' }).catch(() => null),
    anthropicOAuthGet(`/v1/code/sessions/${cse}`, cc).catch(() => null),
  ]);
  if (ev && ev.status === 404) throw new CoworkTaskError('COWORK_NOT_FOUND', 'task not found', 404);
  const sessionBody = se?.body?.response_shape || se?.body;
  const detail = parseCoworkEvents(ev?.body, sessionBody);
  return { ...detail, sid: cse, title: sessionBody?.title, status: sessionBody?.status || sessionBody?.session_status, model: sessionBody?.config?.model };
}

export async function driveCoworkTask(opts: { cse: string; text: string }): Promise<{ delivered: boolean; eventId?: string }> {
  if (!opts.cse.startsWith('cse_')) throw new CoworkTaskError('COWORK_BAD_REQUEST', 'cse id required', 400);
  const text = (opts.text || '').trim();
  if (!text) throw new CoworkTaskError('COWORK_BAD_REQUEST', 'text is required', 400);
  const sid = 'session_' + opts.cse.slice(4);
  const sent = await anthropicOAuthPost(`/v1/code/sessions/${opts.cse}/events`, { events: [{ payload: {
    type: 'user', uuid: randomUUID(), session_id: sid, parent_tool_use_id: null,
    message: { role: 'user', content: text },
  } }] }, await ccOpts());
  if (sent.status < 200 || sent.status >= 300) throw new CoworkTaskError('COWORK_DRIVE_FAILED', `drive failed (${sent.status})`, 502);
  const r = Array.isArray(sent.body?.results) ? sent.body.results[0] : undefined;
  return { delivered: true, eventId: r?.event_id };
}

export async function renameCoworkTask(cse: string, title: string): Promise<{ ok: true; title: string }> {
  const res = await anthropicOAuthPut(`/v1/code/sessions/${cse}`, { title }, await ccOpts());
  if (res.status < 200 || res.status >= 300) throw new CoworkTaskError('COWORK_RENAME_FAILED', `rename failed (${res.status})`, 502);
  return { ok: true, title };
}

export async function archiveCoworkTask(cse: string, archived: boolean): Promise<{ ok: true; archived: boolean }> {
  const res = await anthropicOAuthPost(`/v1/code/sessions/${cse}/${archived ? 'archive' : 'unarchive'}`, {}, await ccOpts());
  if (res.status < 200 || res.status >= 300) throw new CoworkTaskError('COWORK_ARCHIVE_FAILED', `archive failed (${res.status})`, 502);
  return { ok: true, archived };
}

export async function pinCoworkTask(cse: string, pinned: boolean): Promise<{ ok: true; pinned: boolean }> {
  const res = await anthropicOAuthPut(`/v1/code/sessions/${cse}`, { pinned }, await ccOpts());
  if (res.status < 200 || res.status >= 300) throw new CoworkTaskError('COWORK_PIN_FAILED', `pin failed (${res.status})`, 502);
  return { ok: true, pinned };
}

export async function deleteCoworkTask(cse: string): Promise<{ ok: true }> {
  const res = await anthropicOAuthDelete(`/v1/code/sessions/${cse}`, await ccOpts());
  if (res.status !== 404 && (res.status < 200 || res.status >= 300)) throw new CoworkTaskError('COWORK_DELETE_FAILED', `delete failed (${res.status})`, 502);
  return { ok: true };
}
