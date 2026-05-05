/**
 * Read session JSONL + extract text representations for the annotator.
 */
import * as fs from 'fs';

export interface SessionTurn {
  uuid: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export interface SessionLine {
  uuid?: string;
  parentUuid?: string | null;
  type: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  message?: any;
  requestId?: string;
  promptId?: string;
  toolUseResult?: any;
  [k: string]: any;
}

export function readSessionLines(sessionFile: string): SessionLine[] {
  if (!fs.existsSync(sessionFile)) return [];
  return fs.readFileSync(sessionFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l) as SessionLine; } catch { return null; }
    })
    .filter((l): l is SessionLine => !!l);
}

/**
 * Flatten the various content shapes (string / [text|tool_use|tool_result]) to
 * a single string capped for inclusion in the annotator prompt.
 */
export function extractText(line: SessionLine, cap = 800): string {
  const msg = line.message;
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c.slice(0, cap);
  if (!Array.isArray(c)) return '';
  const parts: string[] = [];
  for (const b of c) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') parts.push(String(b.text || ''));
    else if (b.type === 'tool_use') {
      const input = JSON.stringify(b.input || {}).slice(0, 250);
      parts.push(`[TU ${b.name || '?'}:${input}]`);
    } else if (b.type === 'tool_result') {
      const tc = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
      parts.push(`[TR:${tc.slice(0, 400)}]`);
    }
  }
  return parts.join(' ').slice(0, cap);
}

export function extractTurns(lines: SessionLine[]): SessionTurn[] {
  return lines
    .filter((l) => (l.type === 'user' || l.type === 'assistant') && l.uuid)
    .map((l) => ({
      uuid: l.uuid!,
      role: l.type as 'user' | 'assistant',
      text: extractText(l),
      timestamp: l.timestamp || '',
    }));
}
