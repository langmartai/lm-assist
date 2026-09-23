/**
 * Harness transcripts — the one entry point the run store and routes use to
 * read what a harness run did.
 *
 * A run can be read from up to two places:
 *   captured  `<runDir>/stdout.log`, written by the recorder while the run goes.
 *             The only source for a LIVE run; every runner has one.
 *   native    the CLI's own store: qwen's chat JSONL under the run's QWEN_HOME,
 *             or OpenCode's SQLite DB. Richer (diffs, latency, reasoning tokens)
 *             but complete only once the run has finished.
 * `auto` picks captured while live and native after, falling back to whichever
 * exists; an explicit choice that is unavailable falls back with a warning.
 *
 * Contract for every export: synchronous, NEVER throws (failures come back as
 * reason codes / warnings), NEVER writes, and does NO redaction of its own — the
 * caller redacts before anything leaves Core. The one hook is loadTranscript's
 * `redact` option: a field cut to `maxField` must be redacted BEFORE the cut, or a
 * key straddling it survives as a fragment exact matching no longer finds.
 * OpenCode error response headers and bodies are dropped here, at the source,
 * because nothing downstream needs them.
 */

import type {
  HarnessEvent,
  NativeUnavailableReason,
  RunEnrichment,
  TranscriptResult,
  TranscriptSource,
  TranscriptSourceRef,
  TranscriptSources,
  UserEvent,
} from './types';
import {
  type ParsedTranscript,
  assignSeq,
  filesFromTools,
  readCapture,
  readPromptFile,
  regularFileStat,
  unionCapped,
} from './capture';
import { normalizeQwenStream } from './qwen-stream';
import { normalizeOpencodeStream } from './opencode-stream';
import { QWEN_CHAT_MAX_BYTES, findQwenChatFile, parseQwenChat, readQwenDebugTail, inferLegacyQwenRun } from './qwen-chat';
import { listLmharnessSessions, opencodeDbPath, opencodeSessionVersion, readOpencodeSession } from './opencode-db';

export type {
  HarnessEvent,
  HarnessEventKind,
  UserEvent,
  ReasoningEvent,
  TextEvent,
  ToolEvent,
  TurnEvent,
  ApiErrorEvent,
  LifecycleEvent,
  TranscriptSource,
  NativeUnavailableReason,
  TranscriptSources,
  TranscriptSourceRef,
  TranscriptResult,
  RunEnrichment,
  LegacyUsage,
  LegacyQwenRun,
  LegacyOpencodeSession,
} from './types';

export { opencodeDbPath, readQwenDebugTail, inferLegacyQwenRun, listLmharnessSessions };

type Requested = 'auto' | 'captured' | 'native';

const FILES_TOUCHED_MAX = 50;
const TOOLS_BY_NAME_MAX = 30;
/** A page stops growing past this many serialized chars; the rest comes on the next page. */
const PAGE_SOFT_BUDGET = 1024 * 1024;

// ─── parse cache ─────────────────────────────────────────────────────────────

/**
 * The last 8 parsed sources, keyed by path + size + mtime (the DB by its
 * version). A live run's page polls every few seconds; an unchanged file must
 * not be re-parsed each time. Cached values are shared, so nothing downstream
 * may mutate them — paging always builds copies.
 */
const CACHE_MAX = 8;
const cache = new Map<string, ParsedTranscript>();

function cacheGet(key: string): ParsedTranscript | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cachePut(key: string, value: ParsedTranscript): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// ─── source discovery ────────────────────────────────────────────────────────

interface Probe {
  sources: TranscriptSources;
  capture?: { size: number; mtimeMs: number };
  chat?: { file: string; size: number; mtimeMs: number };
  ocVersion?: string;
  ocDetail?: string;
}

function nativeKindFor(runner: string): 'qwen-chat' | 'opencode-db' | null {
  if (runner === 'qwen') return 'qwen-chat';
  if (runner === 'opencode') return 'opencode-db';
  return null;
}

function probe(ref: TranscriptSourceRef): Probe {
  const cst = regularFileStat(ref.capturePath);
  const p: Probe = {
    sources: {
      captured: { available: !!cst && cst.size > 0 },
      native: { kind: nativeKindFor(ref.runner), available: false },
    },
  };
  if (cst) {
    p.sources.captured.bytes = cst.size;
    p.capture = { size: cst.size, mtimeMs: cst.mtimeMs };
  }
  const native = p.sources.native;
  if (native.kind === 'qwen-chat') {
    const chat = findQwenChatFile(ref.runDir, ref.sessionId);
    if (!chat) {
      native.reason = 'NO_CHAT_FILE';
    } else {
      native.available = true;
      p.chat = chat;
      // Still readable, but only in part.
      if (chat.size > QWEN_CHAT_MAX_BYTES) native.reason = 'TOO_LARGE';
    }
  } else if (native.kind === 'opencode-db') {
    const v = opencodeSessionVersion(ref.opencodeDbPath, ref.sessionId);
    if (v.ok) {
      native.available = true;
      p.ocVersion = v.value;
    } else {
      native.reason = v.reason;
      p.ocDetail = v.detail;
    }
  } else {
    native.reason = 'NOT_APPLICABLE';
  }
  return p;
}

function pick(ref: TranscriptSourceRef, requested: Requested, p: Probe, warnings: string[]): TranscriptSource {
  const cap = p.sources.captured.available;
  const nat = p.sources.native.available;
  const nativeSource: TranscriptSource = p.sources.native.kind ?? 'none';
  const natReason = p.sources.native.reason ?? 'unavailable';
  if (requested === 'captured') {
    if (cap) return 'captured';
    if (nat) {
      warnings.push('CAPTURED_UNAVAILABLE: no captured stream for this run — showing the native transcript');
      return nativeSource;
    }
    return 'none';
  }
  if (requested === 'native') {
    if (nat) return nativeSource;
    if (cap) {
      warnings.push(`NATIVE_UNAVAILABLE: ${natReason} — showing the captured stream`);
      return 'captured';
    }
    return 'none';
  }
  // auto: the capture is the only thing that grows while a run is live; after,
  // the CLI's own store is the complete record.
  if (ref.live) return cap ? 'captured' : nat ? nativeSource : 'none';
  return nat ? nativeSource : cap ? 'captured' : 'none';
}

export function resolveTranscriptSource(
  ref: TranscriptSourceRef,
  requested: Requested,
): { source: TranscriptSource; sources: TranscriptSources } {
  try {
    const p = probe(ref);
    return { source: pick(ref, requested, p, []), sources: p.sources };
  } catch {
    return {
      source: 'none',
      sources: { captured: { available: false }, native: { kind: nativeKindFor(ref?.runner ?? ''), available: false } },
    };
  }
}

function versionOf(source: TranscriptSource, p: Probe): string {
  switch (source) {
    case 'captured':
      return `c:${p.capture?.size ?? 0}:${p.capture?.mtimeMs ?? 0}`;
    case 'qwen-chat':
      return `q:${p.chat?.size ?? 0}:${p.chat?.mtimeMs ?? 0}`;
    case 'opencode-db':
      return p.ocVersion ?? 'o:0:0';
    default:
      return 'n:0';
  }
}

export function transcriptVersion(ref: TranscriptSourceRef, source: TranscriptSource): string {
  try {
    if (source === 'captured') {
      const st = regularFileStat(ref.capturePath);
      return `c:${st?.size ?? 0}:${st?.mtimeMs ?? 0}`;
    }
    if (source === 'qwen-chat') {
      const chat = findQwenChatFile(ref.runDir, ref.sessionId);
      return `q:${chat?.size ?? 0}:${chat?.mtimeMs ?? 0}`;
    }
    if (source === 'opencode-db') {
      const v = opencodeSessionVersion(ref.opencodeDbPath, ref.sessionId);
      return v.ok ? v.value : 'o:0:0';
    }
    return 'n:0';
  } catch {
    return 'n:0';
  }
}

// ─── loading ─────────────────────────────────────────────────────────────────

function promptEvent(ref: TranscriptSourceRef): UserEvent | null {
  const prompt = readPromptFile(ref.promptPath);
  if (!prompt) return null;
  const ev: UserEvent = { seq: 0, kind: 'user', text: prompt.text, at: ref.startedAt };
  if (prompt.truncated) ev.truncated = true;
  return ev;
}

function loadCaptured(ref: TranscriptSourceRef, p: Probe): ParsedTranscript | null {
  if (!p.capture) return null;
  const pst = regularFileStat(ref.promptPath);
  const key = [
    'c', ref.runner, ref.capturePath, p.capture.size, p.capture.mtimeMs,
    ref.promptPath ?? '', pst?.size ?? -1, pst?.mtimeMs ?? -1, ref.startedAt,
  ].join('|');
  const hit = cacheGet(key);
  if (hit) return hit;

  const cap = readCapture(ref.capturePath);
  if (!cap) return null;
  let body: ParsedTranscript;
  if (ref.runner === 'qwen') body = normalizeQwenStream(cap.entries);
  else if (ref.runner === 'opencode') body = normalizeOpencodeStream(cap.entries);
  else body = { events: [], filesTouched: [], warnings: [`NO_STREAM_NORMALIZER: runner '${ref.runner}' has no captured-stream reader`], partial: false };

  const lead = promptEvent(ref);
  const events: HarnessEvent[] = lead ? [lead, ...body.events] : body.events;
  const parsed: ParsedTranscript = {
    ...body,
    events: assignSeq(events),
    filesTouched: unionCapped([body.filesTouched, filesFromTools(events)], FILES_TOUCHED_MAX),
    partial: body.partial || cap.partial,
    warnings: [...body.warnings],
  };
  // A torn last line is normal while the writer is mid-append.
  if (cap.skipped > 0 && !ref.live) parsed.warnings.push(`CAPTURE_LINES_SKIPPED: ${cap.skipped} line(s) were not JSON frames`);
  if (cap.partial) parsed.warnings.push('TOO_LARGE: the capture exceeds the read cap; the transcript is partial');
  cachePut(key, parsed);
  return parsed;
}

function loadQwenChat(p: Probe): ParsedTranscript | null {
  if (!p.chat) return null;
  const key = ['q', p.chat.file, p.chat.size, p.chat.mtimeMs].join('|');
  const hit = cacheGet(key);
  if (hit) return hit;
  const { parsed } = parseQwenChat(p.chat.file);
  assignSeq(parsed.events);
  cachePut(key, parsed);
  return parsed;
}

function loadOpencodeDb(ref: TranscriptSourceRef, p: Probe): { parsed: ParsedTranscript | null; reason?: NativeUnavailableReason; detail?: string } {
  // `live` is part of the key: a live parse omits the in-progress step's killed_step
  // marker, and a run killed mid-step never writes the DB again — so the version is
  // the same before and after it ends, and the terminal read must not get the live parse.
  const keyFor = (version: string) => ['o', ref.opencodeDbPath, ref.sessionId, version, ref.live ? 'L' : 'T'].join('|');
  const r = readOpencodeSession(ref.opencodeDbPath, ref.sessionId, (version) => cacheGet(keyFor(version)), { live: ref.live });
  if (!r.ok) return { parsed: null, reason: r.reason, detail: r.detail };
  p.ocVersion = r.value.version;
  const key = keyFor(r.value.version);
  if (!cache.has(key)) {
    assignSeq(r.value.parsed.events);
    cachePut(key, r.value.parsed);
  }
  return { parsed: r.value.parsed };
}

/** Load the chosen source; if a native read fails between probe and read, fall back to the capture. */
function loadChosen(
  ref: TranscriptSourceRef,
  source: TranscriptSource,
  p: Probe,
  warnings: string[],
): { source: TranscriptSource; parsed: ParsedTranscript | null } {
  if (source === 'captured') return { source, parsed: loadCaptured(ref, p) };
  if (source === 'qwen-chat') return { source, parsed: loadQwenChat(p) };
  if (source === 'opencode-db') {
    const r = loadOpencodeDb(ref, p);
    if (r.parsed) return { source, parsed: r.parsed };
    p.sources.native.available = false;
    p.sources.native.reason = r.reason;
    warnings.push(`NATIVE_UNAVAILABLE: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`);
    if (p.sources.captured.available) {
      warnings.push('showing the captured stream instead');
      return { source: 'captured', parsed: loadCaptured(ref, p) };
    }
    return { source: 'none', parsed: null };
  }
  return { source: 'none', parsed: null };
}

// ─── field caps ──────────────────────────────────────────────────────────────

/** Cut at `max` chars without splitting a surrogate pair. */
function cut(s: string, max: number): string {
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

type Redact = (s: string) => string;

function capValue(v: unknown, max: number, flag: { cut: boolean }, redact?: Redact, depth = 0): unknown {
  if (typeof v === 'string') {
    // Redact FIRST: cutting first would leave a straddling key as an unmatched fragment.
    const r = redact ? redact(v) : v;
    if (r.length <= max) return r;
    flag.cut = true;
    return cut(r, max);
  }
  if (!v || typeof v !== 'object') return v;
  if (depth > 32) {
    flag.cut = true;
    return '[nested too deep]';
  }
  if (Array.isArray(v)) return v.map((x) => capValue(x, max, flag, redact, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = capValue(x, max, flag, redact, depth + 1);
  return out;
}

/**
 * A copy of `ev` with every string leaf cut to `max` chars, and a tool input
 * whose JSON exceeds `max` replaced by a preview. Sets the event's own
 * `truncated` where the type has one.
 */
function capInput(input: unknown, max: number, flag: { cut: boolean }, redact?: Redact): unknown {
  // Leaf-wise, before serializing: a regex over the JSON text could cut an escape.
  const clean = redact ? capValue(input, Number.MAX_SAFE_INTEGER, { cut: false }, redact) : input;
  let json: string | undefined;
  try {
    json = JSON.stringify(clean);
  } catch {
    json = undefined;
  }
  if (json === undefined || json.length <= max) return capValue(clean, max, flag);
  flag.cut = true;
  return { _truncated: true, preview: cut(json, max), originalBytes: Buffer.byteLength(json) };
}

function capEvent(ev: HarnessEvent, max: number, pageFlag: { cut: boolean }, redact?: Redact): HarnessEvent {
  const flag = { cut: false };
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev)) {
    copy[k] = ev.kind === 'tool' && k === 'input' ? capInput(v, max, flag, redact) : capValue(v, max, flag, redact);
  }
  const out = copy as unknown as HarnessEvent;
  if (flag.cut) {
    pageFlag.cut = true;
    // Every kind that carries text says so itself: the page-level flag alone let a
    // cut final answer render as if it were complete.
    if (out.kind === 'tool' || out.kind === 'user' || out.kind === 'text' || out.kind === 'reasoning') out.truncated = true;
  }
  return out;
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function loadTranscript(
  ref: TranscriptSourceRef,
  opts: { source: Requested; offset: number; limit: number; maxField: number; redact?: Redact },
): TranscriptResult {
  const offset = clampInt(opts?.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clampInt(opts?.limit, 300, 1, 1000);
  const maxField = clampInt(opts?.maxField, 4000, 256, 65536);
  const requested: Requested = opts?.source === 'captured' || opts?.source === 'native' ? opts.source : 'auto';
  const warnings: string[] = [];
  const empty = (sources: TranscriptSources, source: TranscriptSource, version: string): TranscriptResult => ({
    source, sources, version, events: [], total: 0, offset, nextOffset: null, truncated: false, filesTouched: [], warnings,
  });

  let p: Probe;
  try {
    p = probe(ref);
  } catch (e) {
    warnings.push(`READ_FAILED: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}`);
    return empty({ captured: { available: false }, native: { kind: null, available: false } }, 'none', 'n:0');
  }
  try {
    const chosen = loadChosen(ref, pick(ref, requested, p, warnings), p, warnings);
    const version = versionOf(chosen.source, p);
    const parsed = chosen.parsed;
    if (!parsed) return empty(p.sources, 'none', 'n:0');

    const all = parsed.events;
    const flag = { cut: false };
    const events: HarnessEvent[] = [];
    let spent = 0;
    for (let i = offset; i < all.length && events.length < limit; i++) {
      const ev = capEvent(all[i], maxField, flag, opts?.redact);
      const size = JSON.stringify(ev).length;
      if (events.length > 0 && spent + size > PAGE_SOFT_BUDGET) break;
      events.push(ev);
      spent += size;
    }
    const end = offset + events.length;
    const result: TranscriptResult = {
      source: chosen.source,
      sources: p.sources,
      version,
      events,
      total: all.length,
      offset,
      nextOffset: end < all.length ? end : null,
      truncated: flag.cut || parsed.partial,
      filesTouched: parsed.filesTouched.slice(0, FILES_TOUCHED_MAX),
      warnings: [...warnings, ...parsed.warnings],
    };
    if (parsed.cliVersion) result.cliVersion = parsed.cliVersion;
    if (parsed.title) result.title = parsed.title;
    if (parsed.model) result.model = parsed.model;
    return result;
  } catch (e) {
    warnings.push(`READ_FAILED: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}`);
    return empty(p.sources, 'none', 'n:0');
  }
}

/**
 * What the recorder stamps onto a finished run: tool counts by native name,
 * files written, reasoning tokens. Read from the `auto` source, so a terminal
 * run is summarized from the CLI's own store where one exists.
 *
 * When no source could be read, the tool fields are ABSENT, not zero: "0 tool
 * calls" is a claim about the run, and nothing here saw the run.
 */
export function summarizeRun(ref: TranscriptSourceRef): RunEnrichment {
  const out: RunEnrichment = { filesTouched: [], reasoningTokens: null };
  try {
    const p = probe(ref);
    const chosen = loadChosen(ref, pick(ref, 'auto', p, []), p, []);
    const parsed = chosen.parsed;
    if (!parsed) return out;
    const counts = new Map<string, number>();
    let reasoning: number | null = null;
    let toolCalls = 0;
    let toolErrors = 0;
    for (const ev of parsed.events) {
      if (ev.kind === 'tool') {
        toolCalls++;
        if (ev.status === 'error') toolErrors++;
        counts.set(ev.name, (counts.get(ev.name) ?? 0) + 1);
      } else if (ev.kind === 'turn' && typeof ev.usage?.reasoning === 'number') {
        reasoning = (reasoning ?? 0) + ev.usage.reasoning;
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOOLS_BY_NAME_MAX);
    out.toolCalls = toolCalls;
    out.toolErrors = toolErrors;
    out.toolsByName = Object.fromEntries(top);
    out.filesTouched = unionCapped([parsed.filesTouched, filesFromTools(parsed.events)], FILES_TOUCHED_MAX);
    out.reasoningTokens = reasoning;
    if (parsed.cliVersion) out.cliVersion = parsed.cliVersion;
    if (parsed.model) out.model = parsed.model;
    if (parsed.sessionId) out.sessionId = parsed.sessionId;
    return out;
  } catch {
    return out;
  }
}
