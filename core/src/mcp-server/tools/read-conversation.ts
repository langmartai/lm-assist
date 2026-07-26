/**
 * read_conversation tool — read a single claude.ai web conversation
 * (the user's chats at claude.ai/chat/<uuid>) in full.
 *
 * Distinct from `detail` which reads CODE SESSIONS (Claude Code) and
 * knowledge entries. Both use UUIDs but they index different stores —
 * the user disambiguates via the verb ("show me conversation X" vs
 * "show me code session X").
 */

import { readConversation } from '../../utils/claudeai-session';

export { readConversationToolDef } from './definitions';

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

function blockText(block: Record<string, unknown>): string {
  const type = block.type as string;
  if (type === 'text') {
    return String(block.text || '');
  }
  if (type === 'tool_use') {
    const name = block.name || '';
    const input = JSON.stringify(block.input || {});
    return `[tool_use ${name}] ${input.slice(0, 200)}`;
  }
  if (type === 'tool_result') {
    const content = block.content;
    const txt = Array.isArray(content)
      ? content.map((c) => (c as Record<string, unknown>).text || '').join('\n')
      : String(content || '');
    return `[tool_result] ${txt.slice(0, 200)}`;
  }
  return `[${type}]`;
}

export async function handleReadConversation(args: Record<string, unknown>): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  const uuid = String(args.conversation_uuid || args.uuid || '').trim();
  if (!uuid) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: conversation_uuid is required (the claude.ai conversation UUID from list_claudeai_conversations).',
        },
      ],
      isError: true,
    };
  }

  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200);
  const offset = Math.max(Number(args.offset) || 0, 0);
  const maxCharsPerMessage = Math.min(Math.max(Number(args.max_chars_per_message) || 600, 100), 4000);

  let resp: unknown;
  try {
    resp = await readConversation(uuid, { tree: true, renderingMode: 'messages', renderAllTools: true });
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
    if (/Invalid conversation UUID/i.test(msg)) {
      return { content: [{ type: 'text', text: `Invalid conversation UUID: ${uuid}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Error reading conversation: ${msg}` }], isError: true };
  }

  // readConversation returns the ClaudeAIResponse ENVELOPE
  // ({status, statusText, headers, body}) — the conversation is `.body`.
  // Treating the envelope as the conversation made every field undefined, so
  // this tool reported `(untitled)` / `Messages: 0 total` for EVERY
  // conversation (verified live on prod against a 62-message chat). `resp` is
  // typed `unknown`, so the compiler never caught it.
  const env = resp as Record<string, unknown>;
  const conv = (env && typeof env === 'object' && 'body' in env
    ? (env.body as Record<string, unknown>)
    : env) || {};
  const name = String(conv.name || '(untitled)');
  const created = fmtRelative(conv.created_at as string | undefined);
  const updated = fmtRelative(conv.updated_at as string | undefined);
  const model = String(conv.model || '?');
  const projectUuid = (conv.project_uuid as string | undefined) || '';
  const messages = (conv.chat_messages || []) as Array<Record<string, unknown>>;

  const lines: string[] = [];
  lines.push(`Conversation: ${name}`);
  lines.push(`UUID: ${uuid}`);
  lines.push(`Model: ${model}  ·  created ${created}  ·  updated ${updated}${projectUuid ? `  ·  project ${projectUuid}` : ''}`);
  lines.push(`Messages: ${messages.length} total`);
  lines.push('');

  const slice = messages.slice(offset, offset + limit);
  if (slice.length === 0) {
    lines.push(
      `(no messages in offset=${offset}, limit=${limit} — conversation has ${messages.length} messages total)`,
    );
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    const sender = String(m.sender || '?');
    const at = fmtRelative(m.created_at as string | undefined);
    const blocks = (m.content || []) as Array<Record<string, unknown>>;
    const text = blocks.map(blockText).join('\n').trim();
    const truncated = text.length > maxCharsPerMessage
      ? text.slice(0, maxCharsPerMessage) + ` … [+${text.length - maxCharsPerMessage} chars]`
      : text;
    lines.push(`[${offset + i}] ${sender}  ·  ${at}`);
    lines.push(truncated || '(no text content)');
    lines.push('');
  }

  if (offset + limit < messages.length) {
    lines.push(`→ read_conversation(conversation_uuid="${uuid}", offset=${offset + limit}, limit=${limit}) for more`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
