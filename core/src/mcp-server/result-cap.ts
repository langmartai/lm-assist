// Hard per-result byte ceiling for EVERY MCP tool result, on BOTH surfaces.
//
// WHY THIS EXISTS (measured, 2026-07-26 — backlog bl_5cc4bad9):
// A conversation of 110 messages died — it could no longer accept input — while its
// visible TEXT was only 44,123 chars. The payload was 3.00 MB, 84% of it tool_result,
// and ONE `mission_list` result was 1,757 KB = 58% of the whole thread. Re-measured
// live on this fleet before the fix: `mission_list` 923,758 bytes and `mission_query`
// 960,675 bytes PER CALL. At ~4 chars/token that is ~231K and ~240K tokens — each of
// those single results is larger than the ENTIRE 200K-token context window. The call
// cannot fit, so the conversation is unrecoverable: the user loses the whole thread.
//
// A tool returning too much is therefore not a quality problem, it is a LIVENESS
// problem, and it must be stopped centrally rather than tool-by-tool. This module is
// applied in `configureMcpServer` — the one seam both transports share (stdio
// `mcp-server/index.ts` and HTTP `routes/core/mcp.routes.ts`) — so it covers every
// existing tool, every future tool, and third-party `ext__<plugin>__<tool>` tools,
// with no per-tool opt-in to forget.
//
// TRUNCATION IS ALWAYS EXPLICIT. A silent cut is worse than the overflow: the model
// reads a truncated list as a COMPLETE list and reasons from it ("only 3 missions are
// active"). The marker therefore states the original size, the bytes dropped, and how
// to obtain the rest — see `truncationMarker`.

import type { McpToolResult } from './configure';

/**
 * Default ceiling: 64 KiB of TEXT per tool result.
 *
 * Justified from measurement on this fleet rather than picked round:
 *   - The largest BY-DESIGN result is `bootstrap` at 55,572 bytes (it deliberately
 *     loads every use case in one call). 65,536 clears it with ~15% headroom, so the
 *     default truncates nothing that is meant to be big. `cc_sessions` (52,379) also
 *     fits as-is.
 *   - 64 KiB is ~16K tokens at the ~4 chars/token ratio measured on the dead thread,
 *     i.e. ~8% of a 200K-token window. A dozen worst-case results still leave the
 *     conversation usable, where ONE uncapped `mission_list` did not.
 *   - It is a 14x cut on the result that caused the incident, and after the summary
 *     projections land no routine call comes near it — the ceiling is a BACKSTOP that
 *     should rarely fire, not a working limit.
 *
 * Override per node with `MCP_RESULT_MAX_BYTES` (bytes). Values below the marker size
 * are ignored — a ceiling too small to explain itself would be a silent cut.
 */
export const DEFAULT_MAX_RESULT_BYTES = 65_536;

/** Floor for a configured ceiling: below this the marker cannot fit and the cap would
 *  degenerate into the silent truncation this module exists to prevent. */
export const MIN_MAX_RESULT_BYTES = 2_048;

/** Resolve the active ceiling. NEVER throws; a malformed env value falls back to the
 *  default rather than disabling the guardrail. */
export function maxResultBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MCP_RESULT_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_RESULT_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_MAX_RESULT_BYTES) return DEFAULT_MAX_RESULT_BYTES;
  return Math.floor(n);
}

/** What the cap did — surfaced in the result footer and the mcp-calls log so an
 *  oversized tool is VISIBLE the next time, instead of being found by a human
 *  reading a dead conversation. */
export interface ResultSize {
  /** Text bytes the tool produced, before any cap. */
  originalBytes: number;
  /** Text bytes actually returned. */
  keptBytes: number;
  /** Non-text (image/base64) bytes — measured and reported, never truncated (below). */
  binaryBytes: number;
  /** True when any text was dropped. */
  truncated: boolean;
  /** The ceiling that applied. */
  limitBytes: number;
}

/** utf8 byte length, tolerant of undefined. */
function bytesOf(s: string | undefined): number {
  return s ? Buffer.byteLength(s, 'utf8') : 0;
}

/**
 * Slice `text` to at most `maxBytes` utf8 bytes WITHOUT splitting a codepoint.
 *
 * Cutting mid-sequence would emit U+FFFD and, worse, can corrupt the tail of a JSON
 * fragment in ways that read as data rather than damage. We walk back off any
 * continuation bytes (0b10xxxxxx) so the cut always lands on a codepoint boundary.
 */
export function sliceUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/** Human-readable byte size for the marker and the footer. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

/**
 * The explicit truncation marker. States what was dropped and how to get it — never a
 * bare "…". The wording is deliberately imperative because its reader is a model that
 * would otherwise treat the surviving prefix as the complete answer.
 */
export function truncationMarker(toolName: string, originalBytes: number, keptBytes: number, limitBytes: number): string {
  const dropped = originalBytes - keptBytes;
  const pct = originalBytes > 0 ? Math.round((dropped / originalBytes) * 100) : 0;
  return (
    `\n\n⟦lm-assist: RESULT TRUNCATED — THE OUTPUT ABOVE IS INCOMPLETE⟧\n` +
    `"${toolName}" produced ${formatBytes(originalBytes)} (${originalBytes.toLocaleString('en-US')} bytes); the per-result ceiling is ` +
    `${formatBytes(limitBytes)}, so ${formatBytes(dropped)} (${pct}%) was DROPPED and is NOT shown above. ` +
    `Do NOT treat what you see as the full set — it is a prefix, and the cut may land mid-record.\n` +
    `TO GET THE REST, narrow the call instead of repeating it: pass this tool's paging/filter arguments ` +
    `(limit / offset / cursor / status / since), ask for a summary projection rather than full objects, or ` +
    `fetch items one at a time with the matching *_get / detail tool. Repeating the same call returns the ` +
    `same truncated prefix.\n` +
    `WHY: one oversized result can exceed the whole context window and permanently break the conversation. ` +
    `The node owner can raise the ceiling with MCP_RESULT_MAX_BYTES (bytes), but shrinking the request is ` +
    `almost always the right move.`
  );
}

/**
 * Apply the ceiling to a tool result.
 *
 * Scope — the ceiling governs TEXT content only. Image/binary blocks are measured and
 * reported (so their cost is visible) but never modified: a truncated base64 payload is
 * not a smaller image, it is a corrupt one, and the real remedy for an oversized image
 * is downscaling at the source. Their bytes are reported separately in `binaryBytes`.
 *
 * Error results ARE capped. An error that echoes a huge payload can kill a conversation
 * exactly like a successful one, and the whole promise here is that NO single call can.
 *
 * PURE: returns a new result; never mutates the input.
 */
export function capToolResult(
  result: McpToolResult,
  toolName: string,
  limitBytes: number = maxResultBytes(),
): { result: McpToolResult; size: ResultSize } {
  const content = result.content || [];

  let textBytes = 0;
  let binaryBytes = 0;
  for (const block of content) {
    if (typeof block.text === 'string') textBytes += bytesOf(block.text);
    if (typeof block.data === 'string') binaryBytes += block.data.length;
  }

  const size: ResultSize = {
    originalBytes: textBytes,
    keptBytes: textBytes,
    binaryBytes,
    truncated: false,
    limitBytes,
  };

  if (textBytes <= limitBytes) return { result, size };

  // Over the ceiling. Spend the budget on the blocks in order, so the beginning of the
  // result — where tools put their headline/summary — always survives. The marker is
  // reserved OUT of the budget so the capped text plus its explanation still fits.
  const marker = truncationMarker(toolName, textBytes, limitBytes, limitBytes);
  const markerBytes = bytesOf(marker);
  const budget = Math.max(0, limitBytes - markerBytes);

  const out: McpToolResult['content'] = [];
  let spent = 0;
  let lastTextIndex = -1;

  for (const block of content) {
    if (typeof block.text !== 'string') {
      out.push(block); // image/binary — passes through untouched
      continue;
    }
    const remaining = budget - spent;
    if (remaining <= 0) {
      // Budget exhausted: drop the block's text rather than emit a stray empty block.
      continue;
    }
    const kept = sliceUtf8(block.text, remaining);
    spent += bytesOf(kept);
    lastTextIndex = out.length;
    out.push({ ...block, text: kept });
  }

  // Attach the marker to the last surviving text block, or add one if every text block
  // was dropped — the explanation must never itself be the thing that got cut.
  const finalMarker = truncationMarker(toolName, textBytes, spent, limitBytes);
  if (lastTextIndex >= 0) {
    out[lastTextIndex] = { ...out[lastTextIndex], text: (out[lastTextIndex].text || '') + finalMarker };
  } else {
    out.unshift({ type: 'text', text: finalMarker.trimStart() });
  }

  size.keptBytes = spent;
  size.truncated = true;
  return { result: { ...result, content: out }, size };
}
