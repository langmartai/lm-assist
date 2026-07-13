/**
 * Cowork file attachments — the NATIVE claude.ai attach flow, headless.
 *
 * Two legs (both verified live 2026-07-13, see docs/cowork-web-endpoints.md §0e):
 *  1) UPLOAD (claude.ai cookie, multipart): POST /api/organizations/{org}/cowork/attachments
 *     with a `file` form field and the FULL browser fingerprint (buildBrowserHeaders,
 *     minus content-type). Returns { file_uuid, file_name (server-sanitized), size_bytes }.
 *  2) SEND (OAuth events): the cowork user event carries `file_attachments:[{file_name,
 *     file_uuid, is_image}]` AND a `<uploaded_files>` content prefix (see buildAttachmentEnvelope).
 *     The cloud runtime then stages the file at /root/.claude/uploads/{session}/{uuid}-{name}
 *     and the agent reads it — exactly what claude.ai's own web composer does.
 */

import { CoworkTaskError } from './cowork-tasks';
import { readClaudeAISession, deriveIdentity, claudeaiUploadMultipart } from '../utils/claudeai-session';

/** A reference to a file already uploaded to claude.ai's cowork attachment store. */
export interface CoworkAttachmentRef {
  file_uuid: string;
  file_name: string;      // the SERVER-SANITIZED name (claude.ai strips dots/dashes) — used verbatim on send
  is_image?: boolean;
  size_bytes?: number;
}

/**
 * Upload one file to claude.ai's cowork attachment store and return its ref.
 * Requires a valid claude.ai cookie session (the upload endpoint is cookie-auth
 * and Cloudflare-gated; the full browser fingerprint in claudeaiUploadMultipart
 * is what lets a headless caller through).
 */
export async function uploadCoworkAttachment(
  bytes: Buffer,
  fileName: string,
  mimeType = 'application/octet-stream',
): Promise<CoworkAttachmentRef> {
  const cfg = readClaudeAISession();
  if (!cfg) {
    throw new CoworkTaskError('COWORK_NO_COOKIE', 'a claude.ai cookie session is required to upload cowork attachments', 400);
  }
  let org = '';
  try { org = deriveIdentity(cfg).orgUuid || ''; } catch { org = ''; }
  if (!org) {
    throw new CoworkTaskError('COWORK_NO_ORG', 'could not derive org uuid from the claude.ai session', 400);
  }

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType }), fileName);
  const res = await claudeaiUploadMultipart(`/api/organizations/${org}/cowork/attachments`, form, { referer: 'https://claude.ai/' });
  if (res.status < 200 || res.status >= 300) {
    const hint = res.status === 403 ? ' — Cloudflare challenge (the claude.ai cookie session may be stale; re-capture it)' : '';
    throw new CoworkTaskError('COWORK_ATTACH_FAILED', `attachment upload failed (${res.status})${hint}`, 502);
  }
  const b: any = res.body || {};
  const fileUuid: string | undefined = b.file_uuid || b.uuid;
  if (!fileUuid) {
    throw new CoworkTaskError('COWORK_ATTACH_FAILED', 'attachment upload response missing file_uuid', 502);
  }
  return {
    file_uuid: fileUuid,
    file_name: (typeof b.file_name === 'string' && b.file_name) ? b.file_name : fileName,
    is_image: /^image\//i.test(mimeType),
    size_bytes: typeof b.size_bytes === 'number' ? b.size_bytes : undefined,
  };
}

/**
 * Build the native attachment envelope for a cowork user turn: the
 * `<uploaded_files>` content prefix + the `file_attachments[]` payload field.
 * Pure — no I/O. Returns the ORIGINAL prompt unchanged when there are no
 * (valid) attachments, so callers can always route through it.
 */
export function buildAttachmentEnvelope(
  prompt: string,
  attachments: CoworkAttachmentRef[] | undefined,
): { content: string; fileAttachments: Array<{ file_name: string; file_uuid: string; is_image: boolean }> } {
  const list = (attachments || []).filter((a) => a && typeof a.file_uuid === 'string' && a.file_uuid && typeof a.file_name === 'string' && a.file_name);
  if (!list.length) return { content: prompt, fileAttachments: [] };
  const files = list
    .map((a) => `<file><file_path>${a.file_name}</file_path><file_uuid>${a.file_uuid}</file_uuid></file>`)
    .join('\n');
  const content = `<uploaded_files>\n${files}\n</uploaded_files>\n\n${prompt}`;
  const fileAttachments = list.map((a) => ({ file_name: a.file_name, file_uuid: a.file_uuid, is_image: !!a.is_image }));
  return { content, fileAttachments };
}
