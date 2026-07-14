/**
 * Pure parser for a claude.ai chat conversation's message tree
 * (GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&render_all_tools=true
 *  -> { chat_messages: [...] }). Produces the display shape the web's shared
 * TranscriptMessage renders — the chat analogue of cowork-read.ts's parseCoworkEvents.
 *
 * Chat is simpler than cowork events: each chat_message IS one turn (user or
 * assistant), so there is no cross-event grouping. We flatten each message's
 * content[] blocks and pair tool_use with its result (inline when the read used
 * render_all_tools=true, else a separate tool_result block matched by tool_use_id).
 */
export interface ChatToolCall { name: string; input?: unknown; result?: string; isError?: boolean }
export interface ChatMsg { role: 'user' | 'assistant'; type: 'user' | 'assistant'; text: string; thinking?: string; toolCalls?: ChatToolCall[] }

function stringifyResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(b))).join('\n');
  }
  try { return JSON.stringify(content); } catch { return String(content); }
}

export function parseChatMessages(conversationBody: unknown): ChatMsg[] {
  const msgsRaw = (conversationBody as any)?.chat_messages;
  if (!Array.isArray(msgsRaw)) return [];

  const out: ChatMsg[] = [];
  // tool_use id -> the toolCall object, so a later tool_result block can attach its output.
  const toolIndex = new Map<string, ChatToolCall>();

  for (const m of msgsRaw) {
    // claude.ai uses sender="human" for user turns (not "user"); accept both.
    const sender = m?.sender === 'assistant' ? 'assistant' : (m?.sender === 'human' || m?.sender === 'user') ? 'user' : null;
    if (!sender) continue;
    const content = m?.content;

    const texts: string[] = [];
    const thinking: string[] = [];
    const toolCalls: ChatToolCall[] = [];
    let attachedAResult = false;

    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text) texts.push(b.text);
        else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) thinking.push(b.thinking);
        else if (b?.type === 'tool_use') {
          const call: ChatToolCall = { name: String(b?.name || 'tool'), input: b?.input };
          if (typeof b?.result === 'string') call.result = b.result;
          if (typeof b?.is_error === 'boolean') call.isError = b.is_error;
          toolCalls.push(call);
          if (b?.id) toolIndex.set(String(b.id), call);
        } else if (b?.type === 'tool_result') {
          const call = toolIndex.get(String(b?.tool_use_id || ''));
          if (call) { call.result = stringifyResult(b?.content); call.isError = !!b?.is_error; attachedAResult = true; }
        }
      }
    } else if (typeof content === 'string') {
      texts.push(content);
    }

    const text = texts.join('\n').trim();
    const think = thinking.join('\n\n').trim();
    // Drop a message that was ONLY a tool_result carrier (no text/tools of its own).
    if (!text && !think && !toolCalls.length) {
      if (attachedAResult) continue;
      continue;
    }
    out.push({ role: sender, type: sender, text, ...(think ? { thinking: think } : {}), ...(toolCalls.length ? { toolCalls } : {}) });
  }
  return out;
}
