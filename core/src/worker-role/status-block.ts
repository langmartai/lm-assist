// core/src/worker-role/status-block.ts
import type { StatusLine, TaskStatus } from './types';

const OPEN = '⟦WORKER-STATUS⟧';   // ⟦WORKER-STATUS⟧
const CLOSE = '⟦/WORKER-STATUS⟧'; // ⟦/WORKER-STATUS⟧
const STATUSES: TaskStatus[] = ['todo', 'working', 'blocked', 'need_approval', 'done', 'skipped'];

/** Render the one-per-turn status block a worker prints into its LLM output. */
export function formatStatusBlock(s: StatusLine): string {
  const head = [
    OPEN,
    `task=${s.taskId}`,
    s.phase ? `phase="${s.phase}"` : '',
    `status=${s.status}`,
    s.progress ? `progress=${s.progress}` : '',
  ].filter(Boolean).join(' ');
  const lines = [head];
  if (s.last) lines.push(` last: ${s.last}`);
  if (s.next) lines.push(` next: ${s.next}`);
  if (s.gate) lines.push(` gate: ${s.gate}`);
  lines.push(CLOSE);
  return lines.join('\n');
}

/** Extract the LAST status block from arbitrary text; null if none. */
export function parseStatusBlock(text: string): StatusLine | null {
  if (!text) return null;
  const start = text.lastIndexOf(OPEN);
  if (start < 0) return null;
  const end = text.indexOf(CLOSE, start);
  if (end < 0) return null;
  const block = text.slice(start, end);
  const headLine = block.slice(0, block.indexOf('\n') < 0 ? undefined : block.indexOf('\n'));
  const taskId = /\btask=(\S+)/.exec(headLine)?.[1];
  const statusRaw = /\bstatus=(\S+)/.exec(headLine)?.[1] as TaskStatus | undefined;
  if (!taskId || !statusRaw || !STATUSES.includes(statusRaw)) return null;
  const out: StatusLine = { taskId, status: statusRaw };
  const phase = /\bphase="([^"]*)"/.exec(headLine)?.[1];
  if (phase) out.phase = phase;
  const progress = /\bprogress=(\S+)/.exec(headLine)?.[1];
  if (progress) out.progress = progress;
  const grab = (label: string) => new RegExp(`^\\s${label}:\\s(.*)$`, 'm').exec(block)?.[1];
  const last = grab('last'); if (last) out.last = last;
  const next = grab('next'); if (next) out.next = next;
  const gate = grab('gate'); if (gate) out.gate = gate;
  return out;
}
