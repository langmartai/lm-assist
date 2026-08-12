/**
 * rename_session — first-class SESSION rename, symmetric with
 * rename_conversation (which renames a claude.ai WEB chat).
 *
 * The id names the mechanism — three disjoint shapes, no guessing:
 *   session_…  cloud CCR session   → POST /ccr/cloud/:sid/rename (claude.ai/code API)
 *   cse_…      cowork task         → POST /cowork/tasks/:cse/rename (same upstream PUT)
 *   uuid       local Claude Code   → POST /sessions/:id/rename — appends the CLI's own
 *              custom-title record to the transcript (session-rename.ts), the record
 *              /rename itself writes. NO TUI driving, works on sessions with no pane.
 *
 * Honesty: the local route re-reads the title from the transcript and reports
 * `verified` + `previousTitle`; the cloud/cowork paths report what the upstream
 * API accepted. An unknown id shape is refused NAMING the accepted shapes —
 * never silently treated as one of them.
 */
import { ok, err, workerPost } from './_passthrough';
import type { McpToolResult } from './_passthrough';
import type { LocalRenameResult } from '../../session-rename';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionIdKind = 'cloud' | 'cowork' | 'local';

/** Which rename path an id selects — the shapes are disjoint by construction. */
export function classifySessionId(id: string): SessionIdKind | null {
  if (/^session_[A-Za-z0-9_-]+$/.test(id)) return 'cloud';
  if (/^cse_[A-Za-z0-9_-]+$/.test(id)) return 'cowork';
  if (UUID_RE.test(id)) return 'local';
  return null;
}

export const renameSessionToolDef = {
  name: 'rename_session',
  description:
    'Rename a SESSION by id — never drives the TUI. The id picks the path: a local Claude Code ' +
    'uuid appends the CLI\'s own custom-title record to the transcript (title re-read back to ' +
    'verify; a LIVE session\'s terminal shows the old title until resume), session_… renames the ' +
    'cloud CCR session, cse_… the cowork task. Reports previousTitle for local renames. ' +
    'For claude.ai WEB chats use rename_conversation. WRITE, reversible.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: { type: 'string', description: 'Local Claude Code uuid, cloud session_…, or cowork cse_… id.' },
      title: { type: 'string', description: 'New title — one line, <= 200 chars.' },
    },
    required: ['session_id', 'title'],
  },
};

export async function handleRenameSession(args: Record<string, unknown>): Promise<McpToolResult> {
  const id = String(args.session_id || '').trim();
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!id) return err('session_id is required — a local Claude Code session uuid, a cloud session_… id, or a cowork cse_… id.');
  if (!title) return err('title is required — the new session title.');

  const kind = classifySessionId(id);
  if (!kind) {
    return err(
      `Unrecognized session id "${id}". Accepted shapes: a local Claude Code session uuid ` +
      '(list_recent_sessions / cc_sessions), a cloud session_… id (ccr_cloud_list / ccr_live_list), ' +
      'or a cowork cse_… id. For a claude.ai WEB conversation use rename_conversation.',
    );
  }

  try {
    if (kind === 'cloud') {
      const d = await workerPost<{ renamed?: boolean; sid?: string; title?: string }>(
        `/ccr/cloud/${encodeURIComponent(id)}/rename`, { title },
      );
      return ok(`Renamed cloud CCR session ${d.sid || id} to "${d.title || title}" — claude.ai/code accepted the rename.`);
    }
    if (kind === 'cowork') {
      const d = await workerPost<{ ok?: boolean; title?: string }>(
        `/cowork/tasks/${encodeURIComponent(id)}/rename`, { title },
      );
      return ok(`Renamed cowork task ${id} to "${d.title || title}" — claude.ai accepted the rename.`);
    }
    const d = await workerPost<LocalRenameResult>(
      `/sessions/${encodeURIComponent(id.toLowerCase())}/rename`, { title },
    );
    const lines = [
      d.verified
        ? `Renamed local session ${d.sessionId} to "${d.title}" — verified by re-reading the transcript.`
        : `Rename NOT verified: the transcript read back "${d.readBack ?? '(nothing)'}" instead of "${d.title}". Treat the rename as NOT applied.`,
      `Previous title : ${d.previousTitle ?? '(none)'}`,
      `Mechanism      : appended the CLI's own custom-title record to ${d.jsonl} (no TUI driving)`,
      ...(d.note ? [d.note] : []),
    ];
    return d.verified ? ok(lines.join('\n')) : err(lines.join('\n'));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export const RENAME_SESSION_TOOL_DEFS = [renameSessionToolDef];
export const RENAME_SESSION_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  rename_session: handleRenameSession,
};
