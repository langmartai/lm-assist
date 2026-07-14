import { describe, it, expect } from 'vitest';
import { ccrStatusPill, relativeTime } from '../ccr-status';

describe('ccrStatusPill', () => {
  it('needs-input wins (worker requires_action / need_input / blocked bucket)', () => {
    expect(ccrStatusPill({ workerStatus: 'requires_action' })).toEqual({ label: 'Needs input', tone: 'orange' });
    expect(ccrStatusPill({ statusCategory: 'need_input' })).toEqual({ label: 'Needs input', tone: 'orange' });
    expect(ccrStatusPill({ statusBucket: 'blocked' })).toEqual({ label: 'Needs input', tone: 'orange' });
  });

  it('working when the worker is running or bucket working', () => {
    expect(ccrStatusPill({ workerStatus: 'running' })).toEqual({ label: 'Working', tone: 'green' });
    expect(ccrStatusPill({ statusBucket: 'working' })).toEqual({ label: 'Working', tone: 'green' });
  });

  it('review ready, completed, disconnected, idle', () => {
    expect(ccrStatusPill({ statusBucket: 'review_ready' }).label).toBe('Review ready');
    expect(ccrStatusPill({ statusCategory: 'review_ready' }).label).toBe('Review ready');
    expect(ccrStatusPill({ statusBucket: 'completed' }).label).toBe('Completed');
    expect(ccrStatusPill({ connectionStatus: 'disconnected' }).label).toBe('Disconnected');
    expect(ccrStatusPill({ workerStatus: 'idle' }).label).toBe('Idle');
    expect(ccrStatusPill({})).toEqual({ label: 'Idle', tone: 'gray' });
  });

  it('needs-input beats a running worker (priority order)', () => {
    expect(ccrStatusPill({ workerStatus: 'running', statusCategory: 'need_input' }).label).toBe('Needs input');
  });

  it('live local session with no cloud fields → Live', () => {
    expect(ccrStatusPill({ live: true })).toEqual({ label: 'Live', tone: 'green' });
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-07-14T12:00:00Z');
  it('formats s/m/h/d/w', () => {
    expect(relativeTime('2026-07-14T11:59:30Z', now)).toBe('30s');
    expect(relativeTime('2026-07-14T11:47:00Z', now)).toBe('13m');
    expect(relativeTime('2026-07-14T09:00:00Z', now)).toBe('3h');
    expect(relativeTime('2026-07-12T12:00:00Z', now)).toBe('2d');
    expect(relativeTime('2026-07-07T12:00:00Z', now)).toBe('1w');
  });
  it('empty for missing/invalid', () => {
    expect(relativeTime(null, now)).toBe('');
    expect(relativeTime('not-a-date', now)).toBe('');
  });
});
