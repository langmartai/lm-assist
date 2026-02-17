/**
 * MCP Tool Call Disk Logger
 *
 * Appends JSONL entries to ~/.tier-agent/logs/mcp-calls.jsonl for debugging.
 * Each line: { ts, tool, args, durationMs, responseChars, error?, isError? }
 *
 * - Async, non-blocking (fire-and-forget writes)
 * - Auto-rotates when file exceeds MAX_LOG_SIZE (keeps one backup)
 * - Truncates large args/response text to keep entries readable
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const LOG_DIR = path.join(os.homedir(), '.tier-agent', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'mcp-calls.jsonl');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_ARG_LENGTH = 500;
const MAX_RESPONSE_PREVIEW = 300;

let dirEnsured = false;

function ensureDir(): void {
  if (dirEnsured) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    dirEnsured = true;
  } catch {
    // Silently fail — logging should never break MCP
  }
}

function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE) {
      const backup = LOG_FILE + '.1';
      try { fs.unlinkSync(backup); } catch { /* no backup yet */ }
      fs.renameSync(LOG_FILE, backup);
    }
  } catch {
    // File doesn't exist yet — nothing to rotate
  }
}

function truncate(val: unknown, maxLen: number): string {
  const s = typeof val === 'string' ? val : JSON.stringify(val);
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `… [${s.length} chars]`;
}

export interface McpLogEntry {
  ts: string;
  tool: string;
  args: Record<string, unknown>;
  durationMs: number;
  responseChars: number;
  responsePreview?: string;
  error?: string;
  isError?: boolean;
}

export function logToolCall(
  tool: string,
  args: Record<string, unknown>,
  durationMs: number,
  response: { content: Array<{ type: string; text: string }>; isError?: boolean },
): void {
  try {
    ensureDir();
    rotateIfNeeded();

    const text = response.content?.[0]?.text || '';
    const entry: McpLogEntry = {
      ts: new Date().toISOString(),
      tool,
      args: truncateArgs(args),
      durationMs: Math.round(durationMs),
      responseChars: text.length,
    };

    if (text.length > 0) {
      entry.responsePreview = truncate(text, MAX_RESPONSE_PREVIEW);
    }
    if (response.isError) {
      entry.isError = true;
      entry.error = truncate(text, MAX_RESPONSE_PREVIEW);
    }

    const line = JSON.stringify(entry) + '\n';
    fs.appendFile(LOG_FILE, line, () => {
      // Fire-and-forget — callback required by Node but we ignore errors
    });
  } catch {
    // Never let logging break MCP
  }
}

function truncateArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > MAX_ARG_LENGTH) {
      out[k] = v.slice(0, MAX_ARG_LENGTH) + `… [${v.length} chars]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}
