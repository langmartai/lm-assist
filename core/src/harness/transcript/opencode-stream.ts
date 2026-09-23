/**
 * OpenCode `run --format json` capture → normalized events, plus the part/error
 * mappers the SQLite reader shares (the stream's `part` IS the DB's `part.data`).
 *
 * Each captured line is `{type, timestamp, sessionID, part}` or, on failure,
 * `{type:'error', error:{name, data}}` (measured, opencode 1.18.29). Types seen:
 * step_start, text, reasoning, tool_use, step_finish, error. The prompt is not in
 * the stream; the caller prepends it from prompt.txt.
 *
 * 🔴 An error's `data` also carries the provider's `responseHeaders` and
 * `responseBody` (Cloudflare headers, a whole HTML page). Only name, message,
 * statusCode and isRetryable are ever copied out — a whitelist, so a field
 * OpenCode adds later is dropped by default rather than leaked by default.
 */

import type { ApiErrorEvent, HarnessEvent, ReasoningEvent, ToolEvent, TurnEvent } from './types';
import {
  type CaptureEntry,
  type ParsedTranscript,
  asText,
  finiteNum,
  mapToolStatus,
  markFinalText,
  str,
  truncatedLineEvent,
} from './capture';

/** Fold one tool part's state into a tool event. The last state wins; a missing field keeps what an earlier state said. */
export function applyOpencodeToolPart(ev: ToolEvent, part: any): void {
  const tool = str(part?.tool);
  if (tool) ev.name = tool;
  const callId = str(part?.callID);
  if (callId) ev.callId = callId;
  const state = part?.state;
  if (!state || typeof state !== 'object') return;
  if (state.status !== undefined) {
    ev.status = mapToolStatus(state.status);
    ev.nativeStatus = String(state.status);
  }
  if (state.input !== undefined) ev.input = state.input;
  const output = asText(state.output);
  if (output !== undefined) ev.output = output;
  const error = asText(state.error);
  if (error !== undefined) ev.error = error;
  const title = str(state.title);
  if (title) ev.title = title;
  const start = finiteNum(state.time?.start);
  const end = finiteNum(state.time?.end);
  if (start !== undefined) ev.startedAt = start;
  if (end !== undefined) ev.endedAt = end;
  if (start !== undefined && end !== undefined) ev.durationMs = Math.max(0, end - start);
  const meta = state.metadata;
  if (meta && typeof meta.diff === 'string') {
    const diff: NonNullable<ToolEvent['diff']> = { patch: meta.diff };
    // edit also reports `filediff:{file, patch, additions, deletions}`; take the counts from it.
    const fd = meta.filediff;
    if (fd && typeof fd === 'object') {
      if (typeof fd.file === 'string') diff.file = fd.file;
      if (finiteNum(fd.additions) !== undefined) diff.added = fd.additions;
      if (finiteNum(fd.deletions) !== undefined) diff.removed = fd.deletions;
    }
    ev.diff = diff;
  }
}

/** A new tool event from a part. */
export function opencodeToolEvent(part: any, at: number | undefined, turn: number | undefined): ToolEvent {
  const ev: ToolEvent = { seq: 0, kind: 'tool', name: 'unknown', status: 'unknown' };
  if (at !== undefined) ev.at = at;
  if (turn) ev.turn = turn;
  applyOpencodeToolPart(ev, part);
  return ev;
}

/** `{name, data:{message, statusCode, isRetryable, responseHeaders, responseBody}}` → api_error, WITHOUT the response. */
export function opencodeApiError(error: any, at: number | undefined, turn?: number): ApiErrorEvent {
  const data = error && typeof error.data === 'object' && error.data ? error.data : {};
  const name = str(error?.name);
  const ev: ApiErrorEvent = {
    seq: 0,
    kind: 'api_error',
    message: str(data.message) ?? name ?? 'opencode reported an error',
  };
  if (name) ev.errorType = name;
  const status = finiteNum(data.statusCode);
  if (status !== undefined) ev.statusCode = status;
  if (typeof data.isRetryable === 'boolean') ev.retryable = data.isRetryable;
  if (at !== undefined) ev.at = at;
  if (turn) ev.turn = turn;
  return ev;
}

/** Step/message tokens `{input, output, reasoning, cache:{read, write}}` → turn usage, reasoning kept SEPARATE. */
export function opencodeUsage(t: any): TurnEvent['usage'] | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const u: NonNullable<TurnEvent['usage']> = { input: finiteNum(t.input) ?? 0, output: finiteNum(t.output) ?? 0 };
  const reasoning = finiteNum(t.reasoning);
  if (reasoning !== undefined) u.reasoning = reasoning;
  const read = finiteNum(t.cache?.read);
  if (read !== undefined) u.cacheRead = read;
  const write = finiteNum(t.cache?.write);
  if (write !== undefined) u.cacheWrite = write;
  return u;
}

export function reasoningEvent(part: any, at: number | undefined, turn: number | undefined): ReasoningEvent {
  const ev: ReasoningEvent = { seq: 0, kind: 'reasoning', text: typeof part?.text === 'string' ? part.text : '' };
  if (at !== undefined) ev.at = at;
  if (turn) ev.turn = turn;
  const start = finiteNum(part?.time?.start);
  const end = finiteNum(part?.time?.end);
  if (start !== undefined && end !== undefined) ev.durationMs = Math.max(0, end - start);
  return ev;
}

export function normalizeOpencodeStream(entries: readonly CaptureEntry[]): ParsedTranscript {
  const events: HarnessEvent[] = [];
  const out: ParsedTranscript = { events, filesTouched: [], warnings: [], partial: false };
  const byCallId = new Map<string, ToolEvent>();
  let turn = 0;
  let stepOpen = false;

  const ensureStep = () => {
    if (!stepOpen) {
      turn++;
      stepOpen = true;
    }
  };

  for (const entry of entries) {
    const at = entry.at;
    if (entry.truncatedBytes !== undefined) {
      events.push(truncatedLineEvent(at, entry.truncatedBytes));
      continue;
    }
    const f = entry.value;
    const sid = str(f.sessionID);
    if (sid && !out.sessionId) {
      out.sessionId = sid;
      events.push({ seq: 0, kind: 'lifecycle', phase: 'session', detail: sid, at });
    }
    const part = f.part && typeof f.part === 'object' ? f.part : {};

    switch (f.type) {
      case 'step_start':
        stepOpen = false;
        ensureStep();
        break;

      case 'text':
        ensureStep();
        if (typeof part.text === 'string') events.push({ seq: 0, kind: 'text', text: part.text, at, turn });
        break;

      case 'reasoning':
        ensureStep();
        events.push(reasoningEvent(part, at, turn));
        break;

      case 'tool_use': {
        ensureStep();
        const callId = str(part.callID);
        const existing = callId ? byCallId.get(callId) : undefined;
        if (existing) {
          applyOpencodeToolPart(existing, part);
        } else {
          const ev = opencodeToolEvent(part, at, turn);
          if (callId) byCallId.set(callId, ev);
          events.push(ev);
        }
        break;
      }

      case 'step_finish': {
        ensureStep();
        const ev: TurnEvent = { seq: 0, kind: 'turn', turn, at };
        const finish = str(part.reason);
        if (finish) ev.finish = finish;
        const usage = opencodeUsage(part.tokens);
        if (usage) ev.usage = usage;
        events.push(ev);
        stepOpen = false;
        break;
      }

      case 'error':
        events.push(opencodeApiError(f.error, at, stepOpen ? turn : undefined));
        break;
    }
  }

  markOpencodeFinal(events);
  return out;
}

/** The answer is the text of the last step, and only when that step finished with `stop`. */
export function markOpencodeFinal(events: HarnessEvent[]): void {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind !== 'turn') continue;
    if (ev.finish === 'stop') markFinalText(events, ev.turn);
    return;
  }
}
