/**
 * Cowork Routes
 *
 * Headless "create + send" for Claude cowork sessions (cloud or local
 * bridge), plus list/get/drive/answer/rename/archive/pin/delete for the
 * Cowork UI. See `core/src/cowork/cowork-tasks.ts` for the implementation
 * and `docs/superpowers/specs/2026-07-11-cowork-task-creation-design.md`
 * for the design.
 *
 * Endpoints:
 *   POST   /cowork/attachments               Upload a file to claude.ai's cowork attachment store
 *   POST   /cowork/tasks                     Create a cowork session and send the initial prompt
 *   GET    /cowork/tasks                     List cowork tasks
 *   GET    /cowork/tasks/:cse                Get one task's detail (parsed events + status)
 *   POST   /cowork/tasks/:cse/events         Drive — send a follow-up turn
 *   POST   /cowork/tasks/:cse/answer         Answer a pending AskUserQuestion
 *   POST   /cowork/tasks/:cse/rename         Rename
 *   POST   /cowork/tasks/:cse/archive        Archive/unarchive
 *   POST   /cowork/tasks/:cse/pin            Pin/unpin
 *   DELETE /cowork/tasks/:cse                Delete
 *   GET    /cowork/tasks/:cse/outputs/:file  Download an output file (501 stub — TODO)
 */

import type { RouteContext, RouteHandler } from '../index';
import { wrapResponse, wrapError } from '../../api/helpers';
import {
  createCoworkTask,
  CoworkTaskError,
  listCoworkTasks,
  getCoworkTask,
  driveCoworkTask,
  renameCoworkTask,
  archiveCoworkTask,
  pinCoworkTask,
  deleteCoworkTask,
} from '../../cowork/cowork-tasks';
import { uploadCoworkAttachment } from '../../cowork/cowork-attachments';
import { cloudAnswer } from '../../terminal/ccr-cloud';

// Cap a single attachment at 25 MiB decoded — matches claude.ai's practical
// upload ceiling and keeps the base64 request body bounded.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// wrapError() doesn't carry an HTTP status (ApiResponse has none); attach
// `httpStatus` at the envelope's top level — the field rest-server.ts's
// dispatch loop honors ahead of the flat success?200:400 default (see
// rest-server.ts ~line 566-572).
function fail(e: unknown, start: number) {
  if (e instanceof CoworkTaskError) return { ...wrapError(e.code, e.message, start), httpStatus: e.httpStatus };
  return { ...wrapError('COWORK_ERROR', (e as Error).message, start), httpStatus: 500 };
}

const CSE = '(?<cse>cse_[^/]+)';

export function createCoworkRoutes(_ctx: RouteContext): RouteHandler[] {
  return [
    {
      method: 'POST',
      pattern: /^\/cowork\/tasks$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          const b = req.body || {};
          const result = await createCoworkTask({
            prompt: b.prompt,
            target: b.target,
            environmentId: b.environmentId,
            model: b.model,
            effort: b.effort,
            title: b.title,
            attachments: Array.isArray(b.attachments) ? b.attachments : undefined,
          });
          return wrapResponse(result, start);
        } catch (e) {
          return fail(e, start);
        }
      },
    },

    // POST /cowork/attachments — upload a file to claude.ai's cowork attachment
    // store (the NATIVE attach flow). Body: { fileName, mimeType?, contentBase64 }.
    // Returns a CoworkAttachmentRef the caller passes back in `attachments` on
    // create (POST /cowork/tasks) or drive (POST /cowork/tasks/:cse/events).
    {
      method: 'POST',
      pattern: /^\/cowork\/attachments$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          const b = req.body || {};
          const fileName = String(b.fileName || b.file_name || '').trim();
          const contentBase64 = b.contentBase64 ?? b.content_base64;
          if (!fileName) return { ...wrapError('COWORK_BAD_REQUEST', 'fileName is required', start), httpStatus: 400 };
          if (typeof contentBase64 !== 'string' || !contentBase64) {
            return { ...wrapError('COWORK_BAD_REQUEST', 'contentBase64 is required', start), httpStatus: 400 };
          }
          const bytes = Buffer.from(contentBase64, 'base64');
          if (bytes.length === 0) return { ...wrapError('COWORK_BAD_REQUEST', 'attachment decoded to 0 bytes', start), httpStatus: 400 };
          if (bytes.length > MAX_ATTACHMENT_BYTES) {
            return { ...wrapError('COWORK_ATTACH_TOO_LARGE', `attachment exceeds ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MiB`, start), httpStatus: 413 };
          }
          const ref = await uploadCoworkAttachment(bytes, fileName, typeof b.mimeType === 'string' ? b.mimeType : undefined);
          return wrapResponse(ref, start);
        } catch (e) {
          return fail(e, start);
        }
      },
    },

    // GET /cowork/tasks — list
    {
      method: 'GET',
      pattern: /^\/cowork\/tasks$/,
      handler: async (req) => {
        const start = Date.now();
        try {
          const filter = req.query?.filter as 'all' | 'cowork' | 'archived' | undefined;
          const limit = Number(req.query?.limit) || undefined;
          const result = await listCoworkTasks({ filter, limit });
          return wrapResponse(result, start);
        } catch (e) {
          return fail(e, start);
        }
      },
    },

    // GET /cowork/tasks/:cse — detail
    {
      method: 'GET',
      pattern: new RegExp(`^/cowork/tasks/${CSE}$`),
      handler: async (req) => {
        const start = Date.now();
        try {
          const result = await getCoworkTask(req.params.cse);
          return wrapResponse(result, start);
        } catch (e) {
          return fail(e, start);
        }
      },
    },

    // POST /cowork/tasks/:cse/events — drive (send a follow-up turn)
    {
      method: 'POST',
      pattern: new RegExp(`^/cowork/tasks/${CSE}/events$`),
      handler: async (req) => {
        const start = Date.now();
        try {
          const result = await driveCoworkTask({
            cse: req.params.cse,
            text: String(req.body?.text || ''),
            attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : undefined,
          });
          return wrapResponse(result, start);
        } catch (e) {
          return fail(e, start);
        }
      },
    },

    // POST /cowork/tasks/:cse/answer — answer a pending AskUserQuestion
    {
      method: 'POST',
      pattern: new RegExp(`^/cowork/tasks/${CSE}/answer$`),
      handler: async (req) => {
        const start = Date.now();
        try {
          const result = await cloudAnswer({
            sid: req.params.cse,
            answer: String(req.body?.answer || ''),
            toolUseId: req.body?.toolUseId,
            requestId: req.body?.requestId,
          });
          return wrapResponse(result, start);
        } catch (e) {
          return fail(e, start);
        }
      },
    },

    // POST /cowork/tasks/:cse/rename
    {
      method: 'POST',
      pattern: new RegExp(`^/cowork/tasks/${CSE}/rename$`),
      handler: async (req) => {
        const start = Date.now();
        try {
          const result = await renameCoworkTask(req.params.cse, String(req.body?.title || ''));
          return wrapResponse(result, start);
        } catch (e) {
          return fail(e, start);
        }
      },
    },

    // POST /cowork/tasks/:cse/archive
    {
      method: 'POST',
      pattern: new RegExp(`^/cowork/tasks/${CSE}/archive$`),
      handler: async (req) => {
        const start = Date.now();
        try {
          const result = await archiveCoworkTask(req.params.cse, req.body?.archived !== false);
          return wrapResponse(result, start);
        } catch (e) {
          return fail(e, start);
        }
      },
    },

    // POST /cowork/tasks/:cse/pin
    {
      method: 'POST',
      pattern: new RegExp(`^/cowork/tasks/${CSE}/pin$`),
      handler: async (req) => {
        const start = Date.now();
        try {
          const result = await pinCoworkTask(req.params.cse, req.body?.pinned !== false);
          return wrapResponse(result, start);
        } catch (e) {
          return fail(e, start);
        }
      },
    },

    // DELETE /cowork/tasks/:cse
    {
      method: 'DELETE',
      pattern: new RegExp(`^/cowork/tasks/${CSE}$`),
      handler: async (req) => {
        const start = Date.now();
        try {
          const result = await deleteCoworkTask(req.params.cse);
          return wrapResponse(result, start);
        } catch (e) {
          return fail(e, start);
        }
      },
    },

    // GET /cowork/tasks/:cse/outputs/:file — 501 stub. The Outputs panel
    // (Spec 1) lists filenames from the parser; wiring the actual download
    // is a small follow-up. Return a typed 501 so the UI can show "download
    // coming soon" instead of a bare 404.
    {
      method: 'GET',
      pattern: new RegExp(`^/cowork/tasks/${CSE}/outputs/(?<file>[^/]+)$`),
      handler: async (req) => {
        const start = Date.now();
        return { ...wrapError('COWORK_OUTPUTS_TODO', 'output file download is not yet implemented', start), httpStatus: 501 };
      },
    },
  ];
}
