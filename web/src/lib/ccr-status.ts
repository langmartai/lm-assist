/**
 * Pure status helpers for the CCR page — map the `/v1/code/sessions` status fields
 * (status_bucket / worker_status / post_turn_summary.status_category) to the claude.ai/code
 * status PILL (label + tone), and format a relative "13m / 2d / 1w" timestamp.
 * Unit-tested in __tests__/ccr-status.test.ts.
 */

export type StatusTone = 'green' | 'orange' | 'blue' | 'purple' | 'gray' | 'red';

export interface CcrStatusInput {
  statusBucket?: string | null;
  workerStatus?: string | null;
  statusCategory?: string | null;
  connectionStatus?: string | null;
  /** true for a live local session (from the local verdict) that has no cloud status fields. */
  live?: boolean;
}

/**
 * The claude.ai/code status pill. Priority mirrors what the web app foregrounds:
 * "Needs input" (a blocked / awaiting-answer session) wins, then Working, then Review ready,
 * then Completed / Disconnected / Idle.
 */
export function ccrStatusPill(s: CcrStatusInput): { label: string; tone: StatusTone } {
  const cat = (s.statusCategory || '').toLowerCase();
  const ws = (s.workerStatus || '').toLowerCase();
  const bucket = (s.statusBucket || '').toLowerCase();
  const conn = (s.connectionStatus || '').toLowerCase();

  if (ws === 'requires_action' || cat === 'need_input' || bucket === 'blocked') return { label: 'Needs input', tone: 'orange' };
  if (ws === 'running' || bucket === 'working') return { label: 'Working', tone: 'green' };
  if (cat === 'review_ready' || bucket === 'review_ready') return { label: 'Review ready', tone: 'blue' };
  if (bucket === 'completed') return { label: 'Completed', tone: 'gray' };
  if (conn === 'disconnected') return { label: 'Disconnected', tone: 'red' };
  if (s.live) return { label: 'Live', tone: 'green' };
  if (ws === 'idle') return { label: 'Idle', tone: 'gray' };
  return { label: 'Idle', tone: 'gray' };
}

/** CSS var for a tone's dot/text color (aligns with the app's status palette). */
export function toneColor(tone: StatusTone): string {
  switch (tone) {
    case 'green': return 'var(--color-status-green)';
    case 'orange': return 'var(--color-status-orange)';
    case 'blue': return 'var(--color-status-blue, var(--color-accent))';
    case 'purple': return 'var(--color-status-purple, var(--color-accent))';
    case 'red': return 'var(--color-status-red)';
    case 'gray': default: return 'var(--color-text-tertiary)';
  }
}

/** Compact relative time like claude.ai: 13m, 2d, 1w. Empty for missing/invalid. */
export function relativeTime(iso?: string | null, nowMs?: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, ((nowMs ?? Date.now()) - t) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h`;
  const d = h / 24; if (d < 7) return `${Math.floor(d)}d`;
  const w = d / 7; if (w < 5) return `${Math.floor(w)}w`;
  const mo = d / 30; if (mo < 12) return `${Math.floor(mo)}mo`;
  return `${Math.floor(d / 365)}y`;
}
