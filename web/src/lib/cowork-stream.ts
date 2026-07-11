/**
 * Pure web-side SSE-frame parsing, event merging, and SSE-vs-poll transport
 * decision for a live cowork task transcript. No React, no I/O.
 *
 * - parseSseChunk: splits a raw SSE byte-buffer into complete `\n\n`-terminated
 *   frames plus the trailing partial-frame remainder (fed back on the next chunk).
 * - shouldUseSse: the `_coreapi` hub relay buffers responses, so a hub-relayed
 *   remote node can't stream SSE — callers must fall back to polling.
 * - mergeEvents: merges newly-received raw events (already-JSON-parsed SSE
 *   `data` payloads) into an existing message list by `sequence_num`, extracting
 *   the `SendUserMessage` tool_use reply as assistant text. Extraction rule is
 *   kept consistent with the backend parser (core/src/cowork/cowork-read.ts).
 */

export interface SseFrame { id?: string; event?: string; data: string }
export interface CoworkMsgLite { seq: number; role: 'user' | 'assistant'; text: string; tools?: string[] }

export function parseSseChunk(buffer: string): { frames: SseFrame[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const frames: SseFrame[] = [];
  for (const block of parts) {
    if (!block.trim() || block.startsWith(':')) continue; // skip keepalives
    const f: SseFrame = { data: '' };
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) f.id = line.slice(3).trim();
      else if (line.startsWith('event:')) f.event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    f.data = dataLines.join('\n');
    if (f.data) frames.push(f);
  }
  return { frames, rest };
}

export function shouldUseSse(opts: { isRemoteNode: boolean }): boolean {
  return !opts.isRemoteNode; // the _coreapi hub relay buffers responses → SSE can't stream to a remote node
}

function msgFromEvent(ev: any): CoworkMsgLite | null {
  const seq = Number(ev?.sequence_num ?? ev?.seq ?? 0);
  const p = ev?.payload || {};
  const msg = p?.message;
  const role = msg?.role || (p?.type === 'user' ? 'user' : p?.type === 'assistant' ? 'assistant' : '');
  if (role !== 'user' && role !== 'assistant') return null;
  const content = msg?.content;
  let text = typeof content === 'string' ? content : '';
  const tools: string[] = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text;
      if (b?.type === 'tool_use') {
        if (b.name === 'SendUserMessage') {
          const r = b?.input?.message ?? b?.input?.text;
          if (typeof r === 'string') text += (text ? '\n' : '') + r;
        } else {
          tools.push(String(b?.name || 'tool'));
        }
      }
    }
  }
  return { seq, role, text, ...(tools.length ? { tools } : {}) };
}

export function mergeEvents(prev: CoworkMsgLite[], incoming: unknown[]): CoworkMsgLite[] {
  const bySeq = new Map(prev.map((m) => [m.seq, m]));
  for (const ev of incoming) {
    const m = msgFromEvent(ev);
    if (m && !bySeq.has(m.seq)) bySeq.set(m.seq, m);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
