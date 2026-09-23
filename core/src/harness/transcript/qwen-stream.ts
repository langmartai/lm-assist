/**
 * qwen `--output-format stream-json` capture → normalized events.
 *
 * This is the LIVE view of a qwen run: the chat JSONL under QWEN_HOME is the
 * richer source once a run has finished, but the captured stdout is what exists
 * while it is still going. The prompt is not in the stream (it goes in on
 * stdin), so the caller prepends it from prompt.txt.
 *
 * Frame shapes were read off real captures (qwen 0.15.10):
 *   system    {subtype:'init', session_id, cwd, model, qwen_code_version, tools…}
 *   assistant {uuid, message:{id, model, content:[thinking|text|tool_use], usage}}
 *   user      {message:{content:[{type:'tool_result', tool_use_id, is_error, content}]}}
 *   result    {subtype:'success'|…, is_error, result, usage}
 * The tool_result frame shape is modelled on a fixture, not a real capture — so
 * every field is optional here and a result with no matching call still lands.
 */

import type { ApiErrorEvent, HarnessEvent, ToolEvent, TurnEvent } from './types';
import {
  type CaptureEntry,
  type ParsedTranscript,
  finiteNum,
  str,
  asText,
  markFinalText,
  truncatedLineEvent,
} from './capture';

type TurnUsage = NonNullable<TurnEvent['usage']>;

const API_ERROR_TEXT = /^\s*\[API Error:/;

function frameUsage(raw: any): TurnUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u: TurnUsage = {
    input: finiteNum(raw.input_tokens) ?? 0,
    output: finiteNum(raw.output_tokens) ?? 0,
    cacheRead: finiteNum(raw.cache_read_input_tokens) ?? 0,
    cacheWrite: finiteNum(raw.cache_creation_input_tokens) ?? 0,
  };
  // A thinking-only frame reports `{input_tokens: 0, output_tokens: 0}` (measured):
  // that is "nothing reported yet", not a turn that cost nothing.
  return u.input || u.output || u.cacheRead || u.cacheWrite ? u : null;
}

/** tool_result content is a string or `[{type:'text', text}]`. */
function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((c) => (c && typeof c === 'object' && typeof (c as any).text === 'string' ? (c as any).text : null))
      .filter((t): t is string => t !== null);
    if (texts.length) return texts.join('\n');
  }
  return asText(content);
}

export function normalizeQwenStream(entries: readonly CaptureEntry[]): ParsedTranscript {
  const events: HarnessEvent[] = [];
  const out: ParsedTranscript = { events, filesTouched: [], warnings: [], partial: false };

  const byCallId = new Map<string, ToolEvent>();
  const pending: ToolEvent[] = [];
  const seenFrames = new Set<string>();
  const seenSessions = new Set<string>();

  let turn = 0;
  /**
   * The open model turn. Turns are deduped on the frame's uuid (else message.id),
   * the rule parseQwenStream uses. That alone is not enough, though: MEASURED on
   * real captures, qwen emits a turn's thinking and its tool_use/text as SEPARATE
   * frames with DIFFERENT uuids, and only the last one carries usage. So a new
   * frame joins the open turn until that turn has reported usage; a tool_result
   * or the result frame closes it. Without this every turn would show up twice.
   */
  let open: { usage: Map<string, TurnUsage>; model?: string; at: number } | null = null;
  let frameNo = 0;

  const closeTurn = () => {
    if (!open) return;
    const ev: TurnEvent = { seq: 0, kind: 'turn', turn, at: open.at };
    if (open.model) ev.model = open.model;
    if (open.usage.size) {
      const sum: TurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const u of open.usage.values()) {
        sum.input += u.input;
        sum.output += u.output;
        sum.cacheRead = (sum.cacheRead ?? 0) + (u.cacheRead ?? 0);
        sum.cacheWrite = (sum.cacheWrite ?? 0) + (u.cacheWrite ?? 0);
      }
      ev.usage = sum;
    }
    events.push(ev);
    open = null;
  };

  let resultSeen = false;
  let resultOk = false;

  for (const entry of entries) {
    const at = entry.at;
    if (entry.truncatedBytes !== undefined) {
      events.push(truncatedLineEvent(at, entry.truncatedBytes));
      continue;
    }
    const f = entry.value;
    const sid = str(f.session_id);
    if (sid && !out.sessionId) out.sessionId = sid;

    switch (f.type) {
      case 'system': {
        if (sid && !seenSessions.has(sid)) {
          seenSessions.add(sid);
          events.push({ seq: 0, kind: 'lifecycle', phase: 'session', detail: sid, at });
        }
        out.cliVersion = str(f.qwen_code_version) ?? out.cliVersion;
        out.model = str(f.model) ?? out.model;
        out.cwd = str(f.cwd) ?? out.cwd;
        break;
      }

      case 'assistant': {
        frameNo++;
        const id = str(f.uuid) ?? str(f.message?.id);
        const repeat = !!id && seenFrames.has(id);
        if (id) seenFrames.add(id);
        if (open && !repeat && open.usage.size > 0) closeTurn();
        if (!open) {
          turn++;
          open = { usage: new Map(), at };
        }
        open.at = at;
        const model = str(f.message?.model);
        if (model) {
          open.model = model;
          out.model = model;
        }
        const content = Array.isArray(f.message?.content) ? f.message.content : [];
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'thinking' && typeof block.thinking === 'string') {
            events.push({ seq: 0, kind: 'reasoning', text: block.thinking, at, turn });
          } else if (block.type === 'text' && typeof block.text === 'string') {
            if (API_ERROR_TEXT.test(block.text)) {
              events.push({ seq: 0, kind: 'api_error', message: block.text, at, turn });
            } else {
              events.push({ seq: 0, kind: 'text', text: block.text, at, turn });
            }
          } else if (block.type === 'tool_use') {
            const ev: ToolEvent = {
              seq: 0, kind: 'tool', name: str(block.name) ?? 'unknown', status: 'pending', at, turn,
            };
            const callId = str(block.id);
            if (callId) {
              ev.callId = callId;
              byCallId.set(callId, ev);
            }
            if (block.input !== undefined) ev.input = block.input;
            events.push(ev);
            pending.push(ev);
          }
        }
        const u = frameUsage(f.message?.usage);
        // A repeated frame restates its usage rather than adding to it, so it is
        // stored per frame and summed across distinct frames at close.
        if (u) open.usage.set(id ?? `#${frameNo}`, u);
        break;
      }

      case 'user': {
        closeTurn();
        const content = Array.isArray(f.message?.content) ? f.message.content : [];
        for (const block of content) {
          if (!block || typeof block !== 'object' || block.type !== 'tool_result') continue;
          const callId = str(block.tool_use_id);
          let tool = callId ? byCallId.get(callId) : undefined;
          // No id to join on: FIFO — qwen runs a turn's tools in the order it asked for them.
          if (!tool) tool = pending.find((t) => t.status === 'pending' && (!callId || !t.callId));
          if (!tool) {
            tool = { seq: 0, kind: 'tool', name: 'unknown', status: 'unknown', at, turn: turn || undefined };
            if (callId) tool.callId = callId;
            events.push(tool);
          }
          const idx = pending.indexOf(tool);
          if (idx >= 0) pending.splice(idx, 1);
          const text = toolResultText(block.content);
          if (block.is_error === true) {
            tool.status = 'error';
            if (text !== undefined) tool.error = text;
          } else {
            tool.status = 'completed';
            if (text !== undefined) tool.output = text;
          }
          if (tool.at !== undefined) {
            tool.startedAt = tool.at;
            tool.endedAt = at;
            tool.durationMs = Math.max(0, at - tool.at);
          }
        }
        break;
      }

      case 'result': {
        closeTurn();
        resultSeen = true;
        const result = typeof f.result === 'string' ? f.result : undefined;
        const subtype = str(f.subtype);
        if ((subtype && subtype !== 'success') || f.is_error === true) {
          const ev: ApiErrorEvent = { seq: 0, kind: 'api_error', message: result || subtype || 'qwen reported an error', at };
          if (subtype) ev.errorType = subtype;
          events.push(ev);
        } else if (result && API_ERROR_TEXT.test(result)) {
          // qwen exits 0 with subtype "success" when the endpoint failed; the
          // text is the only signal. Skip it if the assistant frame already said so.
          if (!events.some((e) => e.kind === 'api_error' && e.message === result)) {
            events.push({ seq: 0, kind: 'api_error', message: result, at });
          }
        } else {
          resultOk = true;
        }
        break;
      }
    }
  }
  closeTurn();

  if (resultSeen && resultOk) markFinalText(events);
  return out;
}
