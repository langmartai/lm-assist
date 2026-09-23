/**
 * Captured-stdout reader, plus the low-level file helpers every transcript
 * reader shares.
 *
 * The recorder writes each complete stdout line of a harness run as
 * `<epochMs>\t<redacted line>\n` into `<runDir>/stdout.log` (0600). This module
 * turns that file back into `{at, value}` entries for the per-runner stream
 * normalizers. It never writes and never throws: an unreadable file is simply
 * "no entries".
 *
 * 🔴 Everything here reads REGULAR files only, checked with lstat, so a symlink
 * planted inside a run dir (qwen's own `debug/latest` is one) can never redirect
 * a read to somewhere outside it.
 */

import * as fs from 'fs';
import type { HarnessEvent, LifecycleEvent, ToolEvent } from './types';

/** The capture writer stops at 8 MB; the slack covers the line in flight when it stopped. */
export const CAPTURE_READ_MAX_BYTES = 10 * 1024 * 1024;
/** prompt.txt holds at most this many chars (the recorder's RUN_LIMITS.promptFileChars). */
export const PROMPT_FILE_CHARS = 65536;

// ─── shared low-level helpers ────────────────────────────────────────────────

/** lstat that answers null instead of throwing. */
export function lstatSafe(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** A regular file, and not a symlink (lstat never follows one). */
export function regularFileStat(p: string | null | undefined): fs.Stats | null {
  if (!p) return null;
  const st = lstatSafe(p);
  return st && st.isFile() ? st : null;
}

/** A real directory, and not a symlink to one. */
export function isRealDir(p: string): boolean {
  const st = lstatSafe(p);
  return !!st && st.isDirectory();
}

/**
 * Read at most `maxBytes` from the head of a regular file as utf8.
 * `partial` is true when the file was longer than what was read.
 */
export function readHead(file: string, maxBytes: number): { text: string; size: number; partial: boolean } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const n = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const r = fs.readSync(fd, buf, off, n - off, off);
      if (r <= 0) break;
      off += r;
    }
    return { text: buf.subarray(0, off).toString('utf8'), size: st.size, partial: st.size > off };
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Read at most `maxBytes` from the TAIL of a regular file; `start` is the byte offset read from. */
export function readTail(file: string, maxBytes: number): { text: string; size: number; start: number } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const start = Math.max(0, st.size - maxBytes);
    const n = st.size - start;
    const buf = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const r = fs.readSync(fd, buf, off, n - off, start + off);
      if (r <= 0) break;
      off += r;
    }
    return { text: buf.subarray(0, off).toString('utf8'), size: st.size, start };
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** A finite number, or undefined. */
export function finiteNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** A non-empty string, or undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** ISO timestamp → epoch ms, or undefined. */
export function isoMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/** Tool output is text on the wire, but nothing guarantees it; never hand a non-string on. */
export function asText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Native names of the tools that write a file, across both runners
 * (qwen: write_file / edit / replace; opencode: write / edit / patch).
 */
const WRITE_TOOLS = new Set(['write_file', 'edit', 'replace', 'write', 'patch', 'multiedit']);
const PATH_KEYS = ['file_path', 'filePath', 'absolute_path'];

/**
 * The file paths a run's write/edit tool calls named, in first-seen order.
 *
 * A call that FAILED is skipped: a rejected edit ('oldString not found') changed
 * nothing. Pending/running calls are kept — on a live transcript they usually
 * complete, and on a killed run the write may already have landed.
 */
export function filesFromTools(events: readonly HarnessEvent[]): string[] {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.kind !== 'tool' || ev.status === 'error' || !WRITE_TOOLS.has(ev.name.toLowerCase())) continue;
    const input = ev.input;
    if (!input || typeof input !== 'object') continue;
    for (const k of PATH_KEYS) {
      const v = (input as Record<string, unknown>)[k];
      if (typeof v === 'string' && v) {
        out.push(v);
        break;
      }
    }
  }
  return out;
}

/** Ordered union, capped. */
export function unionCapped(lists: readonly string[][], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const s of list) {
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** Map a runner's native tool status onto the normalized set; unknown values stay visible as nativeStatus. */
export function mapToolStatus(native: unknown): ToolEvent['status'] {
  switch (native) {
    case 'pending': return 'pending';
    case 'running': return 'running';
    case 'completed': return 'completed';
    case 'error': return 'error';
    default: return 'unknown';
  }
}

/** What every source reader produces, before paging and field caps. Treated as immutable once built: it may sit in the LRU. */
export interface ParsedTranscript {
  events: HarnessEvent[];
  filesTouched: string[];
  sessionId?: string;
  cliVersion?: string;
  model?: string;
  title?: string;
  cwd?: string;
  warnings: string[];
  /** A size cap was hit and this is a partial parse. */
  partial: boolean;
}

/** `seq` is the index in the normalized list, so it is assigned once the list is complete. */
export function assignSeq(events: HarnessEvent[]): HarnessEvent[] {
  for (let i = 0; i < events.length; i++) events[i].seq = i;
  return events;
}

/**
 * Mark the last text event as the final answer — optionally only if it belongs
 * to `turn`, so a run that died mid-turn does not promote an earlier turn's
 * commentary to "the answer".
 */
export function markFinalText(events: HarnessEvent[], turn?: number): void {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind !== 'text') continue;
    if (turn === undefined || ev.turn === turn) ev.final = true;
    return;
  }
}

// ─── capture file ────────────────────────────────────────────────────────────

export type CaptureEntry =
  | { at: number; value: any; truncatedBytes?: undefined }
  /** The writer replaced an over-long line with `{"_lmTruncatedLine":true,"bytes":N}`. */
  | { at: number; value?: undefined; truncatedBytes: number };

export interface CaptureRead {
  entries: CaptureEntry[];
  bytes: number;
  /** Lines that were not `<ms>\t<json>` — a torn tail, or a non-JSON line the CLI printed. */
  skipped: number;
  /** The file was larger than CAPTURE_READ_MAX_BYTES and only its head was read. */
  partial: boolean;
}

const MS_RE = /^\d{1,16}$/;

/**
 * Parse stdout.log.
 *
 * Framing is '\n' ONLY, as in the harness parsers: U+2028/U+2029 are legal
 * inside a JSON string. A line that does not parse is skipped, which is also
 * how a torn last line (the writer mid-append on a live run) is handled — it is
 * simply picked up whole on the next read.
 */
export function readCapture(capturePath: string | null): CaptureRead | null {
  if (!regularFileStat(capturePath)) return null;
  const head = readHead(capturePath as string, CAPTURE_READ_MAX_BYTES);
  if (!head) return null;
  const entries: CaptureEntry[] = [];
  let skipped = 0;
  for (const raw of head.text.split('\n')) {
    if (!raw) continue;
    const tab = raw.indexOf('\t');
    if (tab <= 0 || !MS_RE.test(raw.slice(0, tab))) {
      skipped++;
      continue;
    }
    const at = Number(raw.slice(0, tab));
    const body = raw.slice(tab + 1).trim();
    if (!body) continue;
    let value: any;
    try {
      value = JSON.parse(body);
    } catch {
      skipped++;
      continue;
    }
    if (!value || typeof value !== 'object') {
      skipped++;
      continue;
    }
    if (value._lmTruncatedLine === true) {
      entries.push({ at, truncatedBytes: finiteNum(value.bytes) ?? 0 });
      continue;
    }
    entries.push({ at, value });
  }
  return { entries, bytes: head.size, skipped, partial: head.partial };
}

/** The lifecycle event a truncated-line marker becomes. `seq` is assigned by the caller. */
export function truncatedLineEvent(at: number, bytes: number): LifecycleEvent {
  return {
    seq: 0,
    kind: 'lifecycle',
    phase: 'capture_truncated',
    at,
    detail: `an output line of ${bytes} bytes exceeded the capture's per-line cap and was not kept`,
  };
}

/**
 * prompt.txt → the text the run was given. The stream never carries the prompt,
 * so every captured transcript starts from this file. `truncated` is inferred:
 * the recorder keeps only the first PROMPT_FILE_CHARS chars.
 */
export function readPromptFile(promptPath: string | null): { text: string; truncated: boolean } | null {
  if (!regularFileStat(promptPath)) return null;
  // utf8 is at most 4 bytes per char, so this reads every char the recorder kept.
  const head = readHead(promptPath as string, PROMPT_FILE_CHARS * 4);
  if (!head) return null;
  return { text: head.text, truncated: head.text.length >= PROMPT_FILE_CHARS };
}
