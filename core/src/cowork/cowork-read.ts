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
export interface CoworkMsg { role: 'user' | 'assistant'; type: string; text: string; tools?: string[] }
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
  let pendingQuestion: CoworkPending | null = null;

  // The assistant "turn" currently being accumulated (flushed when a real user prompt arrives).
  let curAssistant: { texts: string[]; tools: string[] } | null = null;
  const flushAssistant = () => {
    if (!curAssistant) return;
    const text = curAssistant.texts.join('\n').trim();
    const tools = [...new Set(curAssistant.tools)];
    if (text || tools.length) messages.push({ role: 'assistant', type: 'assistant', text, ...(tools.length ? { tools } : {}) });
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
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_use') {
          const name = String(b?.name || 'tool');
          if (name === 'SendUserMessage') {
            const reply = b?.input?.message ?? b?.input?.text ?? b?.input?.content;
            if (typeof reply === 'string' && reply.trim()) text = (text ? text + '\n' : '') + reply;
            continue; // the reply IS the assistant text, not a tool card
          }
          if (name === 'AskUserQuestion' && !pendingQuestion) {
            const qs = b?.input?.questions;
            if (Array.isArray(qs)) pendingQuestion = { toolUseId: String(b?.id || ''), questions: qs };
          }
          toolNames.add(name);
          evTools.push(name);
          const path = b?.input?.file_path || b?.input?.path;
          if (typeof path === 'string') { files.add(path); if (path.includes(OUTPUTS_DIR)) outputs.add(path.split('/').pop() as string); }
          const cmd = String(b?.input?.command || '');
          const m = cmd.match(/\/mnt\/user-data\/outputs\/([^\s'"]+)/);
          if (m) outputs.add(m[1]);
        }
      }
    }

    if (role === 'user') {
      // A tool_result (or otherwise text-less) user event is the assistant's tool outcome,
      // not a user turn — its tools/outputs are already collected above; don't render it.
      if (isToolResultEvent(p, content) || !text.trim()) continue;
      flushAssistant();
      messages.push({ role: 'user', type: 'user', text });
      continue;
    }

    // assistant event → accumulate into the current turn
    if (!curAssistant) curAssistant = { texts: [], tools: [] };
    if (text.trim()) curAssistant.texts.push(text);
    for (const t of evTools) curAssistant.tools.push(t);
  }
  flushAssistant();

  return { messages, activeGoal, outputs: [...outputs], context: { tools: [...toolNames], files: [...files] }, pendingQuestion, statusCategory };
}
