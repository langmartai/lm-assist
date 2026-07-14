/**
 * Pure parser for a cowork task's event stream (GET /v1/code/sessions/{cse}/events
 * → { data:[event…], resume_cursor }). Produces the transcript + right-rail data.
 *
 * Cowork specifics: the assistant reply is a `SendUserMessage` tool_use; progress
 * is an `active_goal` payload; outputs come from `task_notification.output_file`
 * and tool_uses writing under /mnt/user-data/outputs. See docs/cowork-web-endpoints.md §5.
 *
 * Rendering rules (match claude.ai's cowork transcript):
 *  - events are sorted by `sequence_num` ascending — the `/events?limit=` endpoint
 *    returns them NEWEST-first, so without this the transcript renders upside-down;
 *  - a user event carrying only a `tool_result` (no user text) is NOT a user turn —
 *    it is the result of the assistant's tool call, so it is dropped from the transcript;
 *  - consecutive assistant events (thinking / tool_use / final text) between two real
 *    user prompts are GROUPED into a single assistant turn, with the tools collected —
 *    so tools render inline in the turn instead of as separate empty messages.
 */
export interface CoworkToolCall { name: string; input?: unknown; result?: string; isError?: boolean }
export interface CoworkMsg { role: 'user' | 'assistant'; type: string; text: string; tools?: string[]; thinking?: string; toolCalls?: CoworkToolCall[] }
export interface CoworkGoalStep { label: string; status: 'done' | 'active' | 'pending' }
export interface CoworkContext { tools: string[]; files: string[] }
export interface CoworkPending { toolUseId: string; requestId?: string; questions: Array<{ header?: string; question?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> }> }
export interface CoworkDetail {
  messages: CoworkMsg[];
  activeGoal: CoworkGoalStep[];
  outputs: string[];
  context: CoworkContext;
  pendingQuestion: CoworkPending | null;
  statusCategory: string | null;
}

const OUTPUTS_DIR = '/mnt/user-data/outputs';

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
}

function goalState(s: unknown): CoworkGoalStep['status'] {
  const v = String(s || '').toLowerCase();
  if (/complete|done|success/.test(v)) return 'done';
  if (/progress|active|running|current/.test(v)) return 'active';
  return 'pending';
}

/** True when a user event carries only tool_result content (the outcome of a tool call, not a user turn). */
function isToolResultEvent(payload: any, content: unknown): boolean {
  if (payload?.type === 'tool_result') return true;
  return Array.isArray(content) && content.length > 0 && content.every((b: any) => b?.type === 'tool_result');
}

/** Flatten a tool_result's `content` (string, or blocks) into displayable text. */
function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(b))).join('\n');
  }
  try { return JSON.stringify(content); } catch { return String(content); }
}

export function parseCoworkEvents(eventsBody: unknown, sessionBody?: unknown): CoworkDetail {
  const empty: CoworkDetail = { messages: [], activeGoal: [], outputs: [], context: { tools: [], files: [] }, pendingQuestion: null, statusCategory: null };
  const dataRaw = (eventsBody as any)?.data;
  const session: any = sessionBody || {};
  const statusCategory: string | null = session?.post_turn_summary?.status_category
    ?? session?.response_shape?.post_turn_summary?.status_category ?? null;
  if (!Array.isArray(dataRaw)) return { ...empty, statusCategory };

  // The events endpoint returns NEWEST-first; sort to chronological (ascending sequence_num),
  // stable on original position for events that share (or lack) a sequence_num.
  const seqOf = (ev: any): number => { const n = Number(ev?.sequence_num); return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY; };
  const data = dataRaw
    .map((ev: any, i: number) => ({ ev, i }))
    .sort((a, b) => (seqOf(a.ev) - seqOf(b.ev)) || (a.i - b.i))
    .map((x) => x.ev);

  const messages: CoworkMsg[] = [];
  const outputs = new Set<string>();
  const toolNames = new Set<string>();
  const files = new Set<string>();
  let activeGoal: CoworkGoalStep[] = [];
  // Pending AskUserQuestion detection: an AskUserQuestion is "pending" only while UNANSWERED.
  // Its answer arrives as a tool_result whose tool_use_id === the question's id, so we collect
  // every AskUserQuestion (in order) plus the set of answered tool_use_ids, and resolve to the
  // LATEST still-unanswered one after the pass. Setting it eagerly on the first AskUserQuestion
  // (without the answered check) left the "waiting on you" widget stuck after answering and
  // surfaced the oldest question when several existed. Mirrors ccr-cloud's answered-set logic.
  const askCandidates: CoworkPending[] = [];
  const answeredToolUseIds = new Set<string>();

  // The assistant "turn" currently being accumulated (flushed when a real user prompt arrives).
  // toolCalls maps a tool_use id → its call so the following tool_result event can attach its output.
  let curAssistant: { texts: string[]; tools: string[]; thinking: string[]; toolCalls: Map<string, CoworkToolCall>; anonCalls: CoworkToolCall[] } | null = null;
  const flushAssistant = () => {
    if (!curAssistant) return;
    const text = curAssistant.texts.join('\n').trim();
    const tools = [...new Set(curAssistant.tools)];
    const thinking = curAssistant.thinking.join('\n\n').trim();
    const toolCalls = [...curAssistant.toolCalls.values(), ...curAssistant.anonCalls];
    if (text || tools.length || thinking || toolCalls.length) {
      messages.push({ role: 'assistant', type: 'assistant', text, ...(tools.length ? { tools } : {}), ...(thinking ? { thinking } : {}), ...(toolCalls.length ? { toolCalls } : {}) });
    }
    curAssistant = null;
  };

  for (const ev of data) {
    const p: any = ev?.payload || {};
    const etype = ev?.event_type || p?.type;

    if (etype === 'active_goal' || p?.type === 'active_goal') {
      const steps: any[] = p?.steps || p?.goal?.steps || [];
      activeGoal = steps.map((s) => ({ label: String(s?.title || s?.label || s?.text || ''), status: goalState(s?.state || s?.status) }));
      continue;
    }
    if (etype === 'system' || p?.type === 'system') {
      if (p?.output_file) outputs.add(String(p.output_file).split('/').pop() as string);
      continue;
    }

    const msg = p?.message;
    const role: string = msg?.role || (etype === 'user' ? 'user' : etype === 'assistant' ? 'assistant' : '');
    if (role !== 'user' && role !== 'assistant') continue;

    const content = msg?.content;
    let text = textFromContent(content);
    const evTools: string[] = [];
    const evThinking: string[] = [];
    const evToolUses: Array<{ id: string; name: string; input: unknown }> = [];
    const evToolResults: Array<{ id: string; result: string; isError: boolean }> = [];
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) evThinking.push(b.thinking);
        if (b?.type === 'tool_result') {
          const trId = String(b?.tool_use_id || '');
          evToolResults.push({ id: trId, result: stringifyToolResult(b?.content), isError: !!b?.is_error });
          if (trId) answeredToolUseIds.add(trId); // marks the matching AskUserQuestion (if any) answered
        }
        if (b?.type === 'tool_use') {
          const name = String(b?.name || 'tool');
          if (name === 'SendUserMessage') {
            const reply = b?.input?.message ?? b?.input?.text ?? b?.input?.content;
            if (typeof reply === 'string' && reply.trim()) text = (text ? text + '\n' : '') + reply;
            continue; // the reply IS the assistant text, not a tool card
          }
          if (name === 'AskUserQuestion') {
            const qs = b?.input?.questions;
            if (Array.isArray(qs) && b?.id) askCandidates.push({ toolUseId: String(b.id), questions: qs });
          }
          toolNames.add(name);
          evTools.push(name);
          evToolUses.push({ id: String(b?.id || ''), name, input: b?.input });
          const path = b?.input?.file_path || b?.input?.path;
          if (typeof path === 'string') { files.add(path); if (path.includes(OUTPUTS_DIR)) outputs.add(path.split('/').pop() as string); }
          const cmd = String(b?.input?.command || '');
          const m = cmd.match(/\/mnt\/user-data\/outputs\/([^\s'"]+)/);
          if (m) outputs.add(m[1]);
        }
      }
    }

    if (role === 'user') {
      // A tool_result event carries the outcome of the assistant's tool call — attach it to the
      // matching tool_use in the current turn (by id), then drop it from the transcript.
      if (curAssistant) for (const tr of evToolResults) {
        const call = curAssistant.toolCalls.get(tr.id);
        if (call) { call.result = tr.result; call.isError = tr.isError; }
      }
      if (isToolResultEvent(p, content) || !text.trim()) continue;
      flushAssistant();
      messages.push({ role: 'user', type: 'user', text });
      continue;
    }

    // assistant event → accumulate into the current turn
    if (!curAssistant) curAssistant = { texts: [], tools: [], thinking: [], toolCalls: new Map(), anonCalls: [] };
    if (text.trim()) curAssistant.texts.push(text);
    for (const t of evTools) curAssistant.tools.push(t);
    for (const th of evThinking) curAssistant.thinking.push(th);
    for (const tu of evToolUses) {
      const call: CoworkToolCall = { name: tu.name, input: tu.input };
      if (tu.id) curAssistant.toolCalls.set(tu.id, call); else curAssistant.anonCalls.push(call);
    }
  }
  flushAssistant();

  // The pending question is the newest AskUserQuestion with no matching tool_result answer.
  const pendingQuestion: CoworkPending | null =
    [...askCandidates].reverse().find((c) => !answeredToolUseIds.has(c.toolUseId)) || null;

  return { messages, activeGoal, outputs: [...outputs], context: { tools: [...toolNames], files: [...files] }, pendingQuestion, statusCategory };
}
