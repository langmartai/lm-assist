/**
 * list_claudeai_conversations tool — claude.ai web conversations.
 *
 * Surfaces what the user actually cares about: the name (which is
 * the auto-generated title — that IS content) + the summary if any.
 * Metadata like model and project_uuid is intentionally dropped.
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

function clip(s: string | undefined, n: number): string {
  if (!s) return '';
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine;
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
              'claude.ai session not configured. Write `~/.claude/claudeai-session.json` ' +
              'with `{ "cookie": "<full Cookie header from a logged-in claude.ai web request>" }`. ' +
              'Capture via DevTools → Network → any /api/... → Copy as cURL → grab the Cookie header.',
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }

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
    `Conversations (${list.length}${starred ? ', starred' : ''}):`,
    '',
  ];
  for (const c of list as Array<Record<string, unknown>>) {
    const uuid = String(c.uuid || '');
    const name = String(c.name || '(untitled)');
    const summary = clip(c.summary as string | undefined, 240);
    const updated = fmtRelative(c.updated_at as string | undefined);
    const star = c.is_starred ? ' ★' : '';

    lines.push(`${uuid}${star}  ·  ${updated}`);
    lines.push(`  ${name}`);
    if (summary) {
      lines.push(`  ${summary}`);
    }
    lines.push(`  → read_conversation(conversation_uuid="${uuid}")`);
    lines.push('');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
