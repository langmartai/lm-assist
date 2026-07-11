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
import { anthropicOAuthPost, getOrganizationUuid } from '../utils/claude-oauth';

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
async function ccrOpts() {
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
  const cc = await ccrOpts();

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
  const session = created.body?.session || created.body?.response_shape || created.body;
  const cse: string = session?.id;
  if (!cse) throw new CoworkTaskError('COWORK_CREATE_FAILED', 'no session id in create response', 502);
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
