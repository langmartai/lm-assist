/**
 * list_claudeai_conversations tool — claude.ai web conversations.
 *
 * Includes the LAST ~20 user/assistant messages per conversation so the
 * model has context to know which conv is which. This requires a
 * per-conversation read against claude.ai, so default limit is small
 * (5 convs). Heavy mode (`include_messages: false`) returns the cheap
 * list-only view.
 */

import { listConversations, readConversation } from '../../utils/claudeai-session';

export { listClaudeaiConversationsToolDef } from './definitions';

/**
 * `claudeaiGet` resolves to the ClaudeAIResponse ENVELOPE
 * ({status, statusText, headers, body}) — the payload is `.body`. Both helpers used
 * here return that envelope untouched, and both are typed loosely enough
 * (`Promise<unknown>` / `any`) that the compiler never objected.
 *
 * Missing this made `list_claudeai_conversations` fail 100% of the time on a
 * PERFECTLY HEALTHY cookie: claude.ai answered `200 OK` with the real list at
 * `body.data`, this file looked for `resp.data`, found nothing, and reported
 * "Unexpected response shape from claude.ai." — a message that reads like claude.ai
 * changed its API when nothing was wrong at all. Verified on prod 117 (2026-07-28).
 * `read-conversation.ts` had already been fixed for exactly this; this file was missed.
 */
function payloadOf(resp: unknown): unknown {
  return resp && typeof resp === 'object' && 'body' in (resp as Record<string, unknown>)
    ? (resp as Record<string, unknown>).body
    : resp;
}

/** HTTP status of the envelope, or 0 when the caller handed us a bare payload. */
function statusOf(resp: unknown): number {
  const s = resp && typeof resp === 'object' ? (resp as Record<string, unknown>).status : undefined;
  return typeof s === 'number' ? s : 0;
}

/**
 * Map an upstream status onto the SAME coarse reason vocabulary `probeClaudeAISession`
 * uses (ok / session_expired / cloudflare_blocked / network_error / upstream_error), so a
 * failure names a cause and an action instead of a bare sentence. A caller that only sees
 * "MCP tool call failed" cannot tell "log in again" from "claude.ai is down" from "this is
 * the wrong node" — and will usually go read the wrong store instead.
 */
function describeFailure(status: number, statusText: string): string {
  if (status === 401) {
    return 'session_expired — the claude.ai cookie is no longer valid. Fix: claudeai_login(which="cookie") on the node holding it.';
  }
  if (status === 403 || status === 503) {
    return 'cloudflare_blocked — Cloudflare rejected the request (cf_clearance/__cf_bm expired, or the source IP changed since capture). The cookie is IP-PINNED: run this on the node that captured it, or refresh from a browser on that machine.';
  }
  return `upstream_error — claude.ai responded ${status}${statusText ? ` ${statusText}` : ''}.`;
}

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

function messageText(block: Record<string, unknown>): string {
  const type = block.type as string;
  if (type === 'text') return String(block.text || '');
  if (type === 'tool_use') return `[tool_use ${block.name || ''}]`;
  if (type === 'tool_result') {
    const c = block.content;
    const txt = Array.isArray(c) ? c.map((x) => (x as Record<string, unknown>).text || '').join('') : '';
    return `[tool_result] ${String(txt).slice(0, 120)}`;
  }
  return '';
}

async function tailMessages(uuid: string, n: number, charLimit: number): Promise<string[]> {
  try {
    const resp = (await readConversation(uuid, {
      tree: true,
      renderingMode: 'messages',
      renderAllTools: true,
    })) as unknown;
    const conv = (payloadOf(resp) || {}) as Record<string, unknown>;
    const msgs = (conv.chat_messages || []) as Array<Record<string, unknown>>;
    const tail = msgs.slice(-n);
    return tail.map((m) => {
      const sender = String(m.sender || '?');
      const blocks = (m.content || []) as Array<Record<string, unknown>>;
      const text = blocks.map(messageText).join(' ').trim();
      return `    ${sender}: ${clip(text, charLimit)}`;
    });
  } catch (e) {
    return [`    (failed to read messages: ${e instanceof Error ? e.message : String(e)})`];
  }
}

/**
 * Pull the conversation rows out of whatever `listConversations` resolved to.
 *
 * Two hops, both required. `claudeaiGet` resolves to a ClaudeAIResponse
 * envelope `{status, statusText, headers, body}`, so the payload is at `.body`
 * — missing that hop is what made this tool fail on every call. The payload
 * itself is then either `chat_conversations_v2`'s `{data, has_more}` object or
 * a legacy bare array. Mirrors claude-ai.routes.ts (~L381) so the REST and MCP
 * surfaces cannot drift apart again.
 *
 * Returns `undefined` — not `[]` — when the shape is genuinely unrecognizable,
 * so the caller can tell "cannot parse" from "no conversations".
 */
export function extractConversationRows(resp: unknown): Array<Record<string, unknown>> | undefined {
  const payload = (resp as { body?: unknown } | null)?.body ?? resp;
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  const data = (payload as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : undefined;
}

export async function handleListClaudeaiConversations(args: Record<string, unknown>): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
  const starred = Boolean(args.starred);
  const projectUuid = args.project_uuid as string | undefined;
  const includeMessages = args.include_messages !== false; // default true
  const messagesPerConv = Math.min(Math.max(Number(args.messages_per_conv) || 20, 1), 50);
  const charLimit = Math.min(Math.max(Number(args.message_char_limit) || 120, 40), 500);

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

  const status = statusOf(resp);
  if (status !== 0 && status !== 200) {
    return {
      content: [{ type: 'text', text: describeFailure(status, String((resp as { statusText?: string })?.statusText ?? '')) }],
      isError: true,
    };
  }

  const list = extractConversationRows(resp);
  if (!Array.isArray(list)) {
    const keys =
      resp && typeof resp === 'object' ? Object.keys(resp as Record<string, unknown>).join(', ') : typeof resp;
    return {
      content: [
        {
          type: 'text',
          text:
            `Unexpected response shape from claude.ai — could not find a conversation array. ` +
            `Top-level keys: [${keys}]. Expected chat_conversations_v2's {data, has_more} ` +
            `(optionally inside a {status, headers, body} envelope).`,
        },
      ],
      isError: true,
    };
  }
  if (list.length === 0) {
    return { content: [{ type: 'text', text: 'No claude.ai conversations match.' }] };
  }

  const lines: string[] = [
    `Conversations (${list.length}${starred ? ', starred' : ''}, last ${
      includeMessages ? messagesPerConv : 0
    } msgs each):`,
    '',
  ];

  // Fetch tail messages in parallel for the convs that need them
  const tails = includeMessages
    ? await Promise.all(list.map((c) => tailMessages(String(c.uuid || ''), messagesPerConv, charLimit)))
    : list.map(() => [] as string[]);

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const uuid = String(c.uuid || '');
    const name = String(c.name || '(untitled)');
    const summary = clip(c.summary as string | undefined, 200);
    const updated = fmtRelative(c.updated_at as string | undefined);
    const star = c.is_starred ? ' ★' : '';

    lines.push(`━━━ ${uuid}${star}  ·  ${updated} ━━━`);
    lines.push(`  ${name}`);
    if (summary) lines.push(`  ${summary}`);
    if (includeMessages && tails[i].length > 0) {
      lines.push('  recent messages:');
      lines.push(...tails[i]);
    }
    lines.push(`  → read_conversation(conversation_uuid="${uuid}")`);
    lines.push('');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
