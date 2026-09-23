/**
 * qwen's own chat transcript (`<QWEN_HOME>/projects/<cwd-slug>/chats/<sid>.jsonl`)
 * → normalized events; plus the legacy-run inference and the debug-log tail,
 * which read the same per-run QWEN_HOME.
 *
 * Every line carries `{uuid, parentUuid, sessionId, timestamp, type, cwd, version}`.
 * Record kinds (measured, qwen 0.15.10):
 *   user                 message.parts[].text — the prompt, with a trailing "\n\n" (stdin)
 *   assistant            one per model call: parts {text, thought?} | {functionCall},
 *                        plus usageMetadata
 *   tool_result          functionResponse {id, name, response.output} + toolCallResult
 *                        {callId, status, resultDisplay: '' | {fileDiff, fileName, diffStat…}}
 *   system/ui_telemetry  qwen-code.api_response | .tool_call | .api_error
 *   system/attribution_snapshot  fileStates = files the run created or changed
 *
 * 🔴 Tokens are counted from usageMetadata ONLY. Every api_response telemetry
 * record restates the same numbers (measured identical, one per assistant record),
 * so summing both double-counts a run.
 *
 * The cwd-slug in the path is lossy ('/' → '-'); the directory is only globbed,
 * never decoded — the record's own `cwd` field is the truth.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  ApiErrorEvent,
  HarnessEvent,
  LegacyQwenRun,
  LegacyUsage,
  TextEvent,
  ToolEvent,
  TurnEvent,
} from './types';
import {
  type ParsedTranscript,
  asText,
  filesFromTools,
  finiteNum,
  isRealDir,
  isoMs,
  lstatSafe,
  markFinalText,
  readHead,
  readTail,
  regularFileStat,
  str,
  unionCapped,
} from './capture';

export const QWEN_CHAT_MAX_BYTES = 16 * 1024 * 1024;
export const QWEN_CHAT_MAX_LINES = 20_000;
/** Bounds on the directory walk, so a run dir stuffed with entries cannot stall a request. */
const MAX_PROJECT_DIRS = 200;
const MAX_CHAT_FILES = 2000;
const FILES_TOUCHED_MAX = 50;
const API_ERROR_MESSAGE_CHARS = 300;

const DEBUG_NAME_RE = /^[0-9a-f-]{36}\.txt$/;
const CHAT_NAME_RE = /^[A-Za-z0-9._-]{1,200}\.jsonl$/;
const DEBUG_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/;

/** Upstream 500s arrive as a whole HTML page; the event keeps readable text only. */
export function stripHtml(s: string): string {
  return s
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ChatFileRef {
  file: string;
  size: number;
  mtimeMs: number;
}

/**
 * Locate the chat JSONL of a run: `<runDir>/qwen-home/projects/<any>/chats/<*.jsonl>`.
 * Directories are walked with readdir and each hop is a real directory (not a
 * symlink); only regular files qualify. `<sessionId>.jsonl` is preferred, else
 * the newest.
 */
export function findQwenChatFile(runDir: string | null, sessionId: string | null): ChatFileRef | null {
  if (!runDir) return null;
  const home = path.join(runDir, 'qwen-home');
  const projects = path.join(home, 'projects');
  if (!isRealDir(runDir) || !isRealDir(home) || !isRealDir(projects)) return null;
  let best: ChatFileRef | null = null;
  let scanned = 0;
  try {
    const dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory()).slice(0, MAX_PROJECT_DIRS);
    for (const d of dirs) {
      const chats = path.join(projects, d.name, 'chats');
      if (!isRealDir(chats)) continue;
      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(chats, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files) {
        if (++scanned > MAX_CHAT_FILES) return best;
        if (!f.isFile() || !CHAT_NAME_RE.test(f.name)) continue;
        const file = path.join(chats, f.name);
        const st = regularFileStat(file);
        if (!st) continue;
        const ref = { file, size: st.size, mtimeMs: st.mtimeMs };
        if (sessionId && f.name === `${sessionId}.jsonl`) return ref;
        if (!best || st.mtimeMs > best.mtimeMs) best = ref;
      }
    }
  } catch {
    return best;
  }
  return best;
}

/** The facts inferLegacyQwenRun needs beyond the event list. */
export interface QwenChatStats {
  assistantRecords: number;
  functionCalls: number;
  usage: LegacyUsage;
  /** The model named by telemetry — present even when no assistant record was ever written. */
  telemetryModel?: string;
  lastAssistantModel?: string;
  firstUserText?: string;
  finalText?: string;
  lastSignificant?: 'user' | 'assistant' | 'tool_result' | 'api_error';
  lastApiError?: { errorType?: string; message: string };
  userAbort: boolean;
  firstRecordAt?: number;
  lastRecordAt?: number;
  lines: number;
}

export interface QwenChatParse {
  parsed: ParsedTranscript;
  stats: QwenChatStats;
}

function emptyUsage(): LegacyUsage {
  return { input: 0, output: 0, reasoning: null, cacheRead: 0, total: 0, reported: false };
}

/** Parse a chat JSONL (bounded: 16 MB, 20k lines — beyond that the parse is partial). */
export function parseQwenChat(file: string): QwenChatParse {
  const events: HarnessEvent[] = [];
  const parsed: ParsedTranscript = { events, filesTouched: [], warnings: [], partial: false };
  const stats: QwenChatStats = {
    assistantRecords: 0,
    functionCalls: 0,
    usage: emptyUsage(),
    userAbort: false,
    lines: 0,
  };

  const head = readHead(file, QWEN_CHAT_MAX_BYTES);
  if (!head) {
    parsed.warnings.push('QWEN_CHAT_UNREADABLE');
    return { parsed, stats };
  }
  if (head.partial) parsed.partial = true;

  const byCallId = new Map<string, ToolEvent>();
  const turnEvents: TurnEvent[] = [];
  const latencies: number[] = [];
  /** tool_call telemetry by record uuid: the matching tool_result's parentUuid points here. */
  const toolCallByUuid = new Map<string, { name?: string; durationMs: number; used: boolean }>();
  const toolCallOrder: Array<{ name?: string; durationMs: number; used: boolean }> = [];
  let lastSnapshotFiles: string[] = [];
  let turn = 0;
  let lastAssistantTurn = 0;

  const lines = head.text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (stats.lines >= QWEN_CHAT_MAX_LINES) {
      parsed.partial = true;
      break;
    }
    const raw = lines[i];
    if (!raw.trim()) continue;
    stats.lines++;
    let r: any;
    try {
      r = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!r || typeof r !== 'object') continue;

    const at = isoMs(r.timestamp);
    if (at !== undefined) {
      if (stats.firstRecordAt === undefined) stats.firstRecordAt = at;
      stats.lastRecordAt = at;
    }
    parsed.sessionId = parsed.sessionId ?? str(r.sessionId);
    parsed.cwd = parsed.cwd ?? str(r.cwd);
    parsed.cliVersion = str(r.version) ?? parsed.cliVersion;
    const parts: any[] = Array.isArray(r.message?.parts) ? r.message.parts : [];

    if (r.type === 'user') {
      const text = parts
        .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
        .join('')
        .replace(/\n+$/, '');
      const ev: HarnessEvent = { seq: 0, kind: 'user', text };
      if (at !== undefined) ev.at = at;
      events.push(ev);
      if (stats.firstUserText === undefined) stats.firstUserText = text;
      stats.lastSignificant = 'user';
    } else if (r.type === 'assistant') {
      turn++;
      lastAssistantTurn = turn;
      stats.assistantRecords++;
      const model = str(r.model);
      if (model) {
        stats.lastAssistantModel = model;
        parsed.model = model;
      }
      let lastText: TextEvent | undefined;
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        if (typeof p.text === 'string' && p.thought === true) {
          events.push({ seq: 0, kind: 'reasoning', text: p.text, at, turn });
        } else if (typeof p.text === 'string') {
          lastText = { seq: 0, kind: 'text', text: p.text, at, turn };
          events.push(lastText);
        } else if (p.functionCall && typeof p.functionCall === 'object') {
          stats.functionCalls++;
          const fc = p.functionCall;
          const ev: ToolEvent = { seq: 0, kind: 'tool', name: str(fc.name) ?? 'unknown', status: 'pending', at, turn };
          const id = str(fc.id);
          if (id) {
            ev.callId = id;
            byCallId.set(id, ev);
          }
          if (fc.args !== undefined) ev.input = fc.args;
          events.push(ev);
        }
      }
      stats.finalText = lastText?.text;
      const tev: TurnEvent = { seq: 0, kind: 'turn', turn, at };
      if (model) tev.model = model;
      const um = r.usageMetadata;
      if (um && typeof um === 'object') {
        const input = finiteNum(um.promptTokenCount) ?? 0;
        const output = finiteNum(um.candidatesTokenCount) ?? 0;
        const reasoning = finiteNum(um.thoughtsTokenCount);
        const cacheRead = finiteNum(um.cachedContentTokenCount) ?? 0;
        tev.usage = { input, output, cacheRead };
        // Thoughts are NOT a subset of candidates (measured 19 thoughts vs 16
        // candidates), so they stay a separate figure.
        if (reasoning !== undefined) tev.usage.reasoning = reasoning;
        const u = stats.usage;
        u.input += input;
        u.output += output;
        u.cacheRead += cacheRead;
        if (reasoning !== undefined) u.reasoning = (u.reasoning ?? 0) + reasoning;
        u.total = u.input + u.output;
        u.reported = true;
      }
      events.push(tev);
      turnEvents.push(tev);
      stats.lastSignificant = 'assistant';
    } else if (r.type === 'tool_result') {
      const tcr = r.toolCallResult && typeof r.toolCallResult === 'object' ? r.toolCallResult : {};
      for (const p of parts) {
        const fr = p?.functionResponse;
        if (!fr || typeof fr !== 'object') continue;
        const id = str(fr.id) ?? str(tcr.callId);
        let tool = id ? byCallId.get(id) : undefined;
        if (!tool) {
          // A result whose call was never seen (a partial file): keep it visible.
          tool = { seq: 0, kind: 'tool', name: str(fr.name) ?? 'unknown', status: 'unknown' };
          if (at !== undefined) tool.at = at;
          if (id) tool.callId = id;
          events.push(tool);
        }
        const output = asText(fr.response?.output);
        if (output !== undefined) tool.output = output;
        const status = str(tcr.status);
        if (status) {
          tool.nativeStatus = status;
          // Only 'success' has been observed; anything else is shown, not guessed at.
          tool.status = status === 'success' ? 'completed' : status === 'error' ? 'error' : 'unknown';
        }
        if (tool.status === 'error') {
          const err = asText(fr.response?.error);
          if (err !== undefined) tool.error = err;
        }
        const rd = tcr.resultDisplay;
        if (rd && typeof rd === 'object' && typeof rd.fileDiff === 'string') {
          const diff: NonNullable<ToolEvent['diff']> = { patch: rd.fileDiff };
          if (typeof rd.fileName === 'string') diff.file = rd.fileName;
          const added = finiteNum(rd.diffStat?.model_added_lines);
          const removed = finiteNum(rd.diffStat?.model_removed_lines);
          if (added !== undefined) diff.added = added;
          if (removed !== undefined) diff.removed = removed;
          tool.diff = diff;
        }
        if (at !== undefined) tool.endedAt = at;
        const parent = str(r.parentUuid);
        const tc = parent ? toolCallByUuid.get(parent) : undefined;
        if (tc && !tc.used) {
          tc.used = true;
          tool.durationMs = tc.durationMs;
        }
      }
      stats.lastSignificant = 'tool_result';
    } else if (r.type === 'system' && r.subtype === 'ui_telemetry') {
      const ue = r.systemPayload?.uiEvent;
      if (!ue || typeof ue !== 'object') continue;
      const name = ue['event.name'];
      const tm = str(ue.model);
      if (tm) stats.telemetryModel = tm;
      if (name === 'qwen-code.api_response') {
        latencies.push(finiteNum(ue.duration_ms) ?? NaN);
      } else if (name === 'qwen-code.tool_call') {
        const d = finiteNum(ue.duration_ms);
        if (d !== undefined) {
          const tc = { name: str(ue.function_name), durationMs: d, used: false };
          toolCallOrder.push(tc);
          const uuid = str(r.uuid);
          if (uuid) toolCallByUuid.set(uuid, tc);
        }
      } else if (name === 'qwen-code.api_error') {
        const errorType = str(ue.error_type);
        const message = stripHtml(asText(ue.error_message) ?? '').slice(0, API_ERROR_MESSAGE_CHARS);
        const ev: ApiErrorEvent = { seq: 0, kind: 'api_error', message };
        if (errorType) ev.errorType = errorType;
        const sc = finiteNum(ue.status_code);
        if (sc !== undefined) ev.statusCode = sc;
        const d = finiteNum(ue.duration_ms);
        if (d !== undefined) ev.durationMs = d;
        if (at !== undefined) ev.at = at;
        events.push(ev);
        if (errorType === 'APIUserAbortError') stats.userAbort = true;
        stats.lastApiError = { errorType, message };
        stats.lastSignificant = 'api_error';
      }
    } else if (r.type === 'system' && r.subtype === 'attribution_snapshot') {
      const fs0 = r.systemPayload?.snapshot?.fileStates;
      if (fs0 && typeof fs0 === 'object') lastSnapshotFiles = Object.keys(fs0);
    }
  }

  // The k-th api_response is the k-th model call, i.e. the k-th assistant record.
  for (let k = 0; k < turnEvents.length && k < latencies.length; k++) {
    if (Number.isFinite(latencies[k])) turnEvents[k].latencyMs = latencies[k];
  }
  // A tool_call record whose tool_result never pointed back at it: the next tool
  // of that name still without a duration.
  for (const tc of toolCallOrder) {
    if (tc.used) continue;
    const tool = events.find((e): e is ToolEvent => e.kind === 'tool' && e.durationMs === undefined && e.name === tc.name);
    if (tool) {
      tool.durationMs = tc.durationMs;
      tc.used = true;
    }
  }
  // Only the LAST assistant record's text is the answer; earlier text is commentary.
  if (stats.lastSignificant === 'assistant' && stats.finalText !== undefined) markFinalText(events, lastAssistantTurn);
  else if (stats.lastSignificant !== 'assistant') stats.finalText = undefined;

  parsed.filesTouched = unionCapped([lastSnapshotFiles, filesFromTools(events)], FILES_TOUCHED_MAX);
  if (parsed.partial) parsed.warnings.push('TOO_LARGE: the qwen chat file exceeds the read cap; the transcript is partial');
  return { parsed, stats };
}

// ─── debug log ───────────────────────────────────────────────────────────────

/** Locate `<runDir>/qwen-home/debug/<uuid>.txt`. Never `debug/latest` (a symlink), never a symlink at all. */
function findDebugFile(runDir: string, sessionId: string | null): string | null {
  const home = path.join(runDir, 'qwen-home');
  const dir = path.join(home, 'debug');
  if (!isRealDir(runDir) || !isRealDir(home) || !isRealDir(dir)) return null;
  if (sessionId && DEBUG_NAME_RE.test(`${sessionId}.txt`)) {
    const f = path.join(dir, `${sessionId}.txt`);
    if (regularFileStat(f)) return f;
  }
  let best: { file: string; mtimeMs: number } | null = null;
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true }).slice(0, MAX_CHAT_FILES)) {
      if (!d.isFile() || !DEBUG_NAME_RE.test(d.name)) continue;
      const file = path.join(dir, d.name);
      const st = regularFileStat(file);
      if (st && (!best || st.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: st.mtimeMs };
    }
  } catch {
    return null;
  }
  return best?.file ?? null;
}

const DEBUG_SCAN_WHOLE_BYTES = 4 * 1024 * 1024;
const DEBUG_SCAN_EDGE_BYTES = 1024 * 1024;

interface DebugFacts {
  sessionId: string;
  firstAt?: number;
  lastAt?: number;
  cwd?: string;
  shutdown: boolean;
}

/**
 * The lifecycle facts in a debug log: its first and last timestamped lines are
 * process start and exit, 'memory for CWD:' names the cwd, and 'Shutdown signal
 * received' means the process was killed. A large log is read at both ends only.
 */
function scanDebug(file: string): DebugFacts {
  const facts: DebugFacts = { sessionId: path.basename(file, '.txt'), shutdown: false };
  const st = regularFileStat(file);
  if (!st) return facts;
  let headText = '';
  let tailText = '';
  if (st.size <= DEBUG_SCAN_WHOLE_BYTES) {
    headText = tailText = readHead(file, DEBUG_SCAN_WHOLE_BYTES)?.text ?? '';
  } else {
    headText = readHead(file, DEBUG_SCAN_EDGE_BYTES)?.text ?? '';
    tailText = readTail(file, DEBUG_SCAN_EDGE_BYTES)?.text ?? '';
  }
  for (const line of headText.split('\n')) {
    const m = DEBUG_TS_RE.exec(line);
    if (m && facts.firstAt === undefined) facts.firstAt = isoMs(m[1]);
    if (facts.cwd === undefined) {
      const c = /memory for CWD: (.+?)(?: \(importFormat:[^)]*\))?\s*$/.exec(line);
      if (c) facts.cwd = c[1];
    }
    if (facts.firstAt !== undefined && facts.cwd !== undefined) break;
  }
  const tailLines = tailText.split('\n');
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const m = DEBUG_TS_RE.exec(tailLines[i]);
    if (m) {
      facts.lastAt = isoMs(m[1]);
      break;
    }
  }
  facts.shutdown = headText.includes('Shutdown signal received') || tailText.includes('Shutdown signal received');
  return facts;
}

/**
 * The last `maxLines` lines of a run's qwen debug log (read from at most the
 * last 32 KB). Unredacted — the route redacts before serving.
 */
export function readQwenDebugTail(
  runDir: string,
  sessionId: string | null,
  maxLines: number,
): { available: boolean; reason?: string; lines: string[]; totalLines: number; truncated: boolean } {
  const none = (reason: string) => ({ available: false, reason, lines: [] as string[], totalLines: 0, truncated: false });
  try {
    const n = Math.min(200, Math.max(1, Math.floor(Number.isFinite(maxLines) ? maxLines : 120)));
    if (!runDir || !isRealDir(runDir)) return none('NO_RUN_DIR');
    const file = findDebugFile(runDir, sessionId);
    if (!file) return none('NO_DEBUG_LOG');
    const tail = readTail(file, 32 * 1024);
    if (!tail) return none('READ_FAILED');
    let text = tail.text;
    // Started mid-file: the first line is a fragment.
    if (tail.start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    const all = text.split('\n');
    if (all.length && all[all.length - 1] === '') all.pop();
    let totalLines = all.length;
    if (tail.start > 0) {
      const whole = tail.size <= QWEN_CHAT_MAX_BYTES ? readHead(file, QWEN_CHAT_MAX_BYTES) : null;
      if (whole) {
        let count = 0;
        for (let i = 0; i < whole.text.length; i++) if (whole.text.charCodeAt(i) === 10) count++;
        if (whole.text.length && !whole.text.endsWith('\n')) count++;
        totalLines = count;
      }
    }
    const lines = all.slice(-n);
    return { available: true, lines, totalLines, truncated: tail.start > 0 || totalLines > lines.length };
  } catch {
    return none('READ_FAILED');
  }
}

// ─── legacy (pre-recorder) runs ──────────────────────────────────────────────

/**
 * Reconstruct what can honestly be known about a qwen run that predates the
 * recorder, from its QWEN_HOME alone. Status rules, in order:
 *   no chat file                                   → not_started (the prompt never arrived)
 *   debug 'Shutdown signal received' or an
 *   api_error of type APIUserAbortError            → aborted
 *   the last significant record is an api_error    → failed
 *   the last assistant record has answer text      → succeeded
 *   anything else                                  → unknown
 * A harness timeout (SIGTERM) and an abort look identical from these files.
 */
export function inferLegacyQwenRun(runDirAbs: string): LegacyQwenRun {
  const base: LegacyQwenRun = {
    sessionId: null, cwd: null, model: null, cliVersion: null, startedAt: null, endedAt: null,
    status: 'unknown', numTurns: 0, toolCalls: 0, usage: emptyUsage(), filesTouched: [],
  };
  try {
    if (!runDirAbs || !lstatSafe(runDirAbs)?.isDirectory()) return base;
    const chat = findQwenChatFile(runDirAbs, null);
    const chatStem = chat ? path.basename(chat.file, '.jsonl') : null;
    const debugFile = findDebugFile(runDirAbs, chatStem);
    const dbg = debugFile ? scanDebug(debugFile) : null;

    base.sessionId = chatStem ?? dbg?.sessionId ?? null;
    base.cwd = dbg?.cwd ?? null;
    base.startedAt = dbg?.firstAt ?? null;
    base.endedAt = dbg?.lastAt ?? null;
    if (!chat) {
      base.status = 'not_started';
      return base;
    }

    const { parsed, stats } = parseQwenChat(chat.file);
    base.cwd = parsed.cwd ?? base.cwd;
    base.model = stats.lastAssistantModel ?? stats.telemetryModel ?? null;
    base.cliVersion = parsed.cliVersion ?? null;
    base.startedAt = base.startedAt ?? stats.firstRecordAt ?? null;
    base.endedAt = base.endedAt ?? stats.lastRecordAt ?? null;
    base.numTurns = stats.assistantRecords;
    base.toolCalls = stats.functionCalls;
    base.usage = stats.usage;
    base.filesTouched = parsed.filesTouched;
    if (stats.firstUserText !== undefined) {
      base.promptPreview = stats.firstUserText.trim().slice(0, 300);
      // The full length, as the recorder stores prompt.length — not the preview's.
      base.promptChars = stats.firstUserText.length;
    }
    if (stats.finalText !== undefined) base.resultPreview = stats.finalText.slice(0, 2000);

    const errText = stats.lastApiError
      ? `${stats.lastApiError.errorType ?? 'Error'}: ${stats.lastApiError.message}`.slice(0, 2000)
      : undefined;
    if (dbg?.shutdown || stats.userAbort) {
      base.status = 'aborted';
      if (errText) base.error = errText;
    } else if (stats.lastSignificant === 'api_error') {
      base.status = 'failed';
      base.error = errText;
    } else if (stats.finalText !== undefined) {
      base.status = 'succeeded';
    } else {
      base.status = 'unknown';
    }
    return base;
  } catch {
    return base;
  }
}
