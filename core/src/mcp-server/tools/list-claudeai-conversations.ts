/**
 * list_claudeai_conversations tool — read-only listing of the user's
 * claude.ai web conversations. Uses the in-process listConversations()
 * helper which reads `~/.claude/claudeai-session.json` for the cookie.
 *
 * If the session is not configured, returns a clear error pointing the
 * user at the setup. The model should NOT keep retrying after that.
 */

import { listConversations } from '../../utils/claudeai-session';

export { listClaudeaiConversationsToolDef } from './definitions';

function fmtRelative(iso: string | undefined): string {
  if (!iso) return '?';
  const ms = new Date(iso).getTime();
  if (isNaN(ms)) return iso;
  const age = Date.now() - ms;
  if (age < 60_000) return 'just now';
  if (age < 3600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86400_000) return `${Math.floor(age / 3600_000)}h ago`;
  if (age < 30 * 86400_000) return `${Math.floor(age / 86400_000)}d ago`;
  return iso.slice(0, 10);
}

export async function handleListClaudeaiConversations(args: Record<string, unknown>): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  const starred = Boolean(args.starred);
  const projectUuid = args.project_uuid as string | undefined;

  const extraQuery: Record<string, string | number | boolean> = {};
  if (projectUuid) extraQuery.project_uuid = projectUuid;

  let resp: unknown;
  try {
    resp = await listConversations({ limit, starred, extraQuery });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/No claude.ai session configured/i.test(msg)) {
      return {
        content: [
          {
            type: 'text',
            text:
              'claude.ai session not configured. The user needs to write ' +
              '`~/.claude/claudeai-session.json` containing `{ "cookie": "<full Cookie ' +
              'header from a logged-in claude.ai web request>" }`. Capture via DevTools ' +
              '→ Network → any /api/... → Copy as cURL → grab the Cookie header.',
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }

  // claude.ai returns an array of conversation summaries
  const list = Array.isArray(resp) ? resp : (resp as { data?: unknown[] })?.data;
  if (!Array.isArray(list)) {
    return {
      content: [{ type: 'text', text: 'Unexpected response shape from claude.ai.' }],
      isError: true,
    };
  }

  if (list.length === 0) {
    return { content: [{ type: 'text', text: 'No claude.ai conversations match.' }] };
  }

  const lines: string[] = [
    `claude.ai conversations (${list.length}, limit=${limit}${starred ? ', starred' : ''}):`,
    '',
  ];
  for (const c of list as Array<Record<string, unknown>>) {
    const uuid = String(c.uuid || '');
    const name = String(c.name || '(untitled)');
    const updated = fmtRelative(c.updated_at as string | undefined);
    const created = fmtRelative(c.created_at as string | undefined);
    const proj = (c.project_uuid as string | undefined) || '';
    const star = c.is_starred ? ' ★' : '';
    lines.push(`${uuid}${star}`);
    lines.push(`  ${name}`);
    lines.push(`  updated ${updated}  ·  created ${created}${proj ? `  ·  project ${proj}` : ''}`);
    lines.push('');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
