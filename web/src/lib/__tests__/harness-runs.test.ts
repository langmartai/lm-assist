/**
 * Pure helpers for the /harness page (Harness Runs spec §7.8, §9 web). No IO: status and
 * runner labels, tool-name canonicalization, transcript → TranscriptMessage shaping,
 * formatting, grouping, cwd containment, and the query / deep-link round trips.
 * Fixtures are synthetic, in the shapes measured from real qwen and OpenCode runs.
 */
import { describe, it, expect } from 'vitest';
import {
  HARNESS_RUN_STATUSES,
  barGeometry,
  buildDeepLink,
  buildRunsQuery,
  canonicalTool,
  collectRunFiles,
  compactNumber,
  diffLines,
  eventMatchesFilters,
  eventsToMessages,
  formatCost,
  formatDuration,
  formatElapsed,
  formatTokens,
  groupRunsByDay,
  isOutsideCwd,
  liveTailOffset,
  mergeTranscript,
  tabBadgeCounts,
  offsetLabel,
  parseDeepLink,
  parseRunsQuery,
  pollIntervalMs,
  recordedRunnerTabs,
  runnerLabel,
  statusBarSegments,
  statusMeta,
  successRateLabel,
  toolSummaryLabel,
  transcriptNotice,
  turnLabel,
  type HarnessEvent,
  type HarnessRunRow,
  type HarnessRunnerSummary,
  type HarnessRunUsage,
  type HarnessTranscriptPage,
  type TimelineFilter,
} from '../harness-runs';
import { formatSummary, summarizeToolCall } from '../tool-summary';

const T0 = 1_790_000_000_000;

// qwen: chat JSONL normalized by core (functionCall joined with functionResponse by id).
const QWEN_EVENTS: HarnessEvent[] = [
  { seq: 0, kind: 'user', at: T0, text: 'Create a file named hello.txt containing exactly the word PONG, then reply DONE.' },
  { seq: 1, kind: 'reasoning', at: T0 + 2000, turn: 1, text: 'The user wants a file.' },
  {
    seq: 2, kind: 'tool', at: T0 + 2100, turn: 1, callId: 'write_file_abc', name: 'write_file', status: 'completed', nativeStatus: 'success',
    input: { file_path: '/work/proj/hello.txt', content: 'PONG' },
    output: 'Successfully created and wrote to new file: /work/proj/hello.txt',
    durationMs: 9,
    diff: { file: 'hello.txt', patch: 'Index: hello.txt\n--- hello.txt\n+++ hello.txt\n@@ -0,0 +1 @@\n+PONG', added: 1, removed: 0 },
  },
  { seq: 3, kind: 'turn', at: T0 + 2489, turn: 1, model: 'vendor/synthetic-model:free', latencyMs: 2489, usage: { input: 16102, output: 120, reasoning: 57, cacheRead: 0 } },
  { seq: 4, kind: 'tool', at: T0 + 3000, turn: 2, callId: 'read_file_x', name: 'read_file', status: 'error', nativeStatus: 'error', input: { absolute_path: '/work/proj/missing.txt' }, error: 'File not found' },
  { seq: 5, kind: 'text', at: T0 + 4000, turn: 2, text: 'DONE', final: true },
  { seq: 6, kind: 'turn', at: T0 + 4000, turn: 2, model: 'vendor/synthetic-model:free', latencyMs: 900, usage: { input: 16164, output: 16, reasoning: 19 } },
];

// opencode: DB parts normalized by core (tool state merged by callID; camelCase input keys).
const OPENCODE_EVENTS: HarnessEvent[] = [
  { seq: 0, kind: 'user', at: T0, text: 'Create hello.txt with PONG and reply DONE' },
  { seq: 1, kind: 'reasoning', at: T0 + 1500, turn: 1, text: 'Write it to /tmp.', durationMs: 400 },
  {
    seq: 2, kind: 'tool', at: T0 + 2000, turn: 1, callId: 'write_1', name: 'write', status: 'completed',
    input: { content: 'PONG', filePath: '/tmp/hello.txt' }, output: 'Wrote file successfully.', title: 'tmp/hello.txt',
    startedAt: T0 + 2000, endedAt: T0 + 2040,
  },
  {
    seq: 3, kind: 'tool', at: T0 + 2500, turn: 2, callId: 'edit_1', name: 'edit', status: 'completed',
    input: { filePath: '/work/proj/x.ts', oldString: 'a', newString: 'b' }, output: 'Edit applied successfully.',
  },
  { seq: 4, kind: 'tool', at: T0 + 2600, turn: 2, callId: 'bash_1', name: 'bash', status: 'error', input: { command: 'false', description: 'fail' }, error: 'exit 1' },
  { seq: 5, kind: 'api_error', at: T0 + 2700, errorType: 'APIError', statusCode: 500, message: 'Internal Server Error', retryable: true },
  { seq: 6, kind: 'text', at: T0 + 3000, turn: 3, text: 'DONE', final: true },
  { seq: 7, kind: 'turn', at: T0 + 3000, turn: 3, model: 'synthetic-model', finish: 'stop', latencyMs: 1200, usage: { input: 10267, output: 13, reasoning: 106, cacheRead: 0, cacheWrite: 0 } },
];

function row(partial: Partial<HarnessRunRow> & { id: string; startedAt: number }): HarnessRunRow {
  return {
    executionId: partial.id, runner: 'qwen', runnerDisplayName: 'Qwen Code', origin: 'recorded', inferred: false,
    status: 'succeeded', background: false, promptPreview: 'p', cwd: '/work', cwdDefaulted: false,
    model: null, providerProfile: null, live: false, hasTranscript: true,
    ...partial,
  };
}

function usage(p: Partial<HarnessRunUsage> = {}): HarnessRunUsage {
  return { inputTokens: 16102, outputTokens: 120, reasoningTokens: 57, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 16222, reported: true, ...p };
}

describe('statusMeta', () => {
  it('covers all 10 statuses with the spec colours', () => {
    const expected: Record<string, [string, boolean]> = {
      running: ['var(--color-status-blue)', true],
      succeeded: ['var(--color-status-green)', false],
      failed: ['var(--color-status-red)', false],
      launch_failed: ['var(--color-status-red)', false],
      timed_out: ['var(--color-status-orange)', false],
      aborted: ['var(--color-status-yellow)', false],
      interrupted: ['var(--color-status-purple)', false],
      refused: ['var(--color-text-tertiary)', false],
      not_started: ['var(--color-text-tertiary)', false],
      unknown: ['var(--color-text-tertiary)', false],
    };
    expect(HARNESS_RUN_STATUSES).toHaveLength(10);
    for (const s of HARNESS_RUN_STATUSES) {
      const m = statusMeta(s);
      expect([m.colorVar, m.pulse], s).toEqual(expected[s]);
      expect(m.label.length).toBeGreaterThan(0);
    }
    expect(statusMeta('timed_out').label).toBe('timed out');
    expect(statusMeta('launch_failed').label).toBe('launch failed');
  });

  it('renders a status this build does not know as grey, keeping its name', () => {
    const m = statusMeta('paused_by_future_core');
    expect(m.colorVar).toBe('var(--color-text-tertiary)');
    expect(m.label).toBe('paused_by_future_core');
    expect(statusMeta(undefined).label).toBe('unknown');
  });
});

describe('runnerLabel', () => {
  it('prefers the served displayName', () => {
    expect(runnerLabel('qwen', 'Qwen Code (dev)')).toBe('Qwen Code (dev)');
  });
  it('falls back by id — sdk/tmux serve a null displayName', () => {
    expect(runnerLabel('sdk', null)).toBe('Claude SDK');
    expect(runnerLabel('tmux', '')).toBe('Claude tmux');
    expect(runnerLabel('qwen')).toBe('Qwen Code');
    expect(runnerLabel('opencode', '  ')).toBe('OpenCode');
    expect(runnerLabel('future-harness')).toBe('future-harness');
    expect(runnerLabel(undefined)).toBe('unknown');
  });
});

describe('canonicalTool', () => {
  it('maps qwen names', () => {
    const cases: Record<string, string> = {
      read_file: 'Read', write_file: 'Write', edit: 'Edit', replace: 'Edit', run_shell_command: 'Bash',
      grep_search: 'Grep', search_file_content: 'Grep', glob: 'Glob', list_directory: 'LS',
      web_fetch: 'WebFetch', web_search: 'WebSearch', todo_write: 'TodoWrite',
    };
    for (const [n, c] of Object.entries(cases)) expect(canonicalTool(n).name, n).toBe(c);
  });

  it('maps opencode names', () => {
    const cases: Record<string, string> = {
      read: 'Read', write: 'Write', edit: 'Edit', patch: 'Edit', bash: 'Bash', grep: 'Grep',
      glob: 'Glob', list: 'LS', webfetch: 'WebFetch', todowrite: 'TodoWrite', task: 'Task',
    };
    for (const [n, c] of Object.entries(cases)) expect(canonicalTool(n).name, n).toBe(c);
  });

  it('passes unknown names through', () => {
    expect(canonicalTool('some_mcp_tool', { a: 1 })).toEqual({ name: 'some_mcp_tool', input: { a: 1 } });
  });

  it('adds Claude key aliases alongside the originals without mutating the input', () => {
    const input = { filePath: '/x/a.ts', oldString: 'a', newString: 'b' };
    const frozen = JSON.stringify(input);
    const c = canonicalTool('edit', input);
    expect(c.input).toEqual({ filePath: '/x/a.ts', oldString: 'a', newString: 'b', file_path: '/x/a.ts', old_string: 'a', new_string: 'b' });
    expect(JSON.stringify(input)).toBe(frozen);
    expect(c.input).not.toBe(input);
  });

  it('aliases absolute_path and path, and never overwrites an existing file_path', () => {
    expect((canonicalTool('read_file', { absolute_path: '/a' }).input as Record<string, unknown>).file_path).toBe('/a');
    expect((canonicalTool('read', { path: '/b' }).input as Record<string, unknown>).file_path).toBe('/b');
    const keep = { file_path: '/real', filePath: '/other' };
    expect(canonicalTool('write', keep).input).toBe(keep);
  });

  it('leaves non-object inputs alone', () => {
    expect(canonicalTool('bash', 'ls').input).toBe('ls');
    expect(canonicalTool('bash').input).toBeUndefined();
  });
});

describe('summarizeToolCall on canonicalized harness tools', () => {
  it('qwen write_file → Created hello.txt', () => {
    const c = canonicalTool('write_file', { file_path: '/work/proj/hello.txt', content: 'PONG' });
    const s = summarizeToolCall(c.name, c.input);
    expect(s).toEqual({ verb: 'Created', target: 'hello.txt', added: 1, removed: 0 });
    expect(formatSummary(s)).toContain('Created hello.txt');
  });

  it('opencode edit (camelCase keys) → Edited x.ts +1 -1', () => {
    const c = canonicalTool('edit', { filePath: '/work/x.ts', oldString: 'a', newString: 'b' });
    expect(formatSummary(summarizeToolCall(c.name, c.input))).toBe('Edited x.ts +1 -1');
  });

  it('toolSummaryLabel reads the same, and names a server-truncated input instead of an empty target', () => {
    expect(toolSummaryLabel({ name: 'bash', input: { command: 'npm test' } })).toBe('Ran npm test');
    expect(toolSummaryLabel({ name: 'write', input: { _truncated: true, preview: '{"content":"…', originalBytes: 90000 }, title: 'big.txt' }))
      .toBe('Write (input truncated) · big.txt');
  });
});

describe('eventsToMessages', () => {
  it('qwen: one assistant message between user events, reasoning → thinking, tools paired', () => {
    const msgs = eventsToMessages(QWEN_EVENTS);
    expect(msgs.map((m) => m.type)).toEqual(['user', 'assistant']);
    expect(msgs[0].text).toMatch(/^Create a file named hello.txt/);
    const a = msgs[1];
    expect(a.thinking).toBe('The user wants a file.');
    expect(a.text).toBe('DONE');
    expect(a.toolCalls?.map((t) => t.name)).toEqual(['Write', 'Read']);
    expect(a.toolCalls?.[0]).toMatchObject({ result: 'Successfully created and wrote to new file: /work/proj/hello.txt', isError: false });
    expect(a.toolCalls?.[1]).toMatchObject({ result: 'File not found', isError: true });
    expect((a.toolCalls?.[1].input as Record<string, unknown>).file_path).toBe('/work/proj/missing.txt');
  });

  it('opencode: canonical names + keys, error flags, API errors land in the text', () => {
    const msgs = eventsToMessages(OPENCODE_EVENTS);
    expect(msgs).toHaveLength(2);
    const a = msgs[1];
    expect(a.toolCalls?.map((t) => [t.name, t.isError])).toEqual([['Write', false], ['Edit', false], ['Bash', true]]);
    expect((a.toolCalls?.[0].input as Record<string, unknown>).file_path).toBe('/tmp/hello.txt');
    expect(a.toolCalls?.[2].result).toBe('exit 1');
    expect(a.text).toContain('**API error** 500 APIError: Internal Server Error');
    expect(a.text).toContain('DONE');
    expect(a.thinking).toBe('Write it to /tmp.');
  });

  it('splits at every user event and drops assistant groups with nothing to show', () => {
    const msgs = eventsToMessages([
      { seq: 0, kind: 'user', text: 'one' },
      { seq: 1, kind: 'turn', turn: 1 },
      { seq: 2, kind: 'lifecycle', phase: 'session', detail: 'abc' },
      { seq: 3, kind: 'user', text: 'two' },
      { seq: 4, kind: 'text', text: 'reply' },
    ]);
    expect(msgs.map((m) => `${m.type}:${m.text}`)).toEqual(['user:one', 'user:two', 'assistant:reply']);
  });
});

describe('groupRunsByDay', () => {
  it('groups by local day in row order: Today, Yesterday, then a date', () => {
    const now = new Date(2026, 8, 23, 15, 0, 0).getTime();
    const rows = [
      row({ id: 'a', startedAt: new Date(2026, 8, 23, 14, 0).getTime() }),
      row({ id: 'b', startedAt: new Date(2026, 8, 23, 0, 5).getTime() }),
      row({ id: 'c', startedAt: new Date(2026, 8, 22, 23, 59).getTime() }),
      row({ id: 'd', startedAt: new Date(2026, 8, 14, 10, 0).getTime() }),
    ];
    const g = groupRunsByDay(rows, now);
    expect(g.map((x) => x.rows.map((r) => r.id))).toEqual([['a', 'b'], ['c'], ['d']]);
    expect(g[0].label).toBe('Today');
    expect(g[1].label).toBe('Yesterday');
    expect(g[2].key).toBe('2026-09-14');
    expect(g[2].label).not.toMatch(/Today|Yesterday/);
  });
  it('handles no rows', () => {
    expect(groupRunsByDay([], Date.now())).toEqual([]);
  });
});

describe('formatDuration / formatElapsed / compactNumber', () => {
  it('ms / s / m / h', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(2500)).toBe('2.5s');
    expect(formatDuration(185_000)).toBe('3m 5s');
    expect(formatDuration(7_500_000)).toBe('2h 5m');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
  it('elapsed timer', () => {
    expect(formatElapsed(7_400)).toBe('0:07');
    expect(formatElapsed(723_000)).toBe('12:03');
    expect(formatElapsed(3_729_000)).toBe('1:02:09');
  });
  it('compact counts', () => {
    expect(compactNumber(950)).toBe('950');
    expect(compactNumber(16102)).toBe('16.1k');
    expect(compactNumber(10000)).toBe('10k');
    expect(compactNumber(2_500_000)).toBe('2.5M');
    expect(compactNumber(null)).toBe('—');
  });
});

describe('formatTokens', () => {
  it('keeps reasoning a separate figure', () => {
    expect(formatTokens(usage())).toBe('16.1k in · 120 out · 57 reasoning');
  });
  it('omits reasoning when not reported', () => {
    expect(formatTokens(usage({ reasoningTokens: null }))).toBe('16.1k in · 120 out');
  });
  it('unreported usage is unknown, not zero', () => {
    expect(formatTokens(usage({ inputTokens: 0, outputTokens: 0, reported: false }))).toBe('—');
    expect(formatTokens(undefined)).toBe('—');
  });
});

describe('formatCost', () => {
  it('never renders $0', () => {
    for (const v of [undefined, null, 0, -1, Number.NaN]) {
      const s = formatCost(v as number | null | undefined);
      expect(s).toBe('unavailable');
      expect(s).not.toMatch(/\$0/);
    }
  });
});

describe('isOutsideCwd', () => {
  it('prefix is not child: /a/bc is outside /a/b', () => {
    expect(isOutsideCwd('/a/bc', '/a/b')).toBe(true);
    expect(isOutsideCwd('/a/b/c.txt', '/a/b')).toBe(false);
    expect(isOutsideCwd('/a/b', '/a/b/')).toBe(false);
    expect(isOutsideCwd('/tmp/hello.txt', '/work/proj')).toBe(true);
  });
  it('relative paths and a missing cwd are not flagged', () => {
    expect(isOutsideCwd('hello.txt', '/work')).toBe(false);
    expect(isOutsideCwd('/tmp/x', null)).toBe(false);
    expect(isOutsideCwd('/tmp/x', '/')).toBe(false);
  });
});

describe('collectRunFiles', () => {
  it('unions filesTouched with tool paths, dedupes, flags outside-cwd', () => {
    const files = collectRunFiles(['/work/proj/hello.txt', 'notes.md'], [...QWEN_EVENTS, ...OPENCODE_EVENTS], '/work/proj');
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['/work/proj/hello.txt'].ops).toEqual(['created']);
    expect(byPath['/work/proj/hello.txt'].outsideCwd).toBe(false);
    expect(byPath['/tmp/hello.txt']).toMatchObject({ ops: ['created'], outsideCwd: true });
    expect(byPath['/work/proj/x.ts'].ops).toEqual(['edited']);
    expect(byPath['/work/proj/notes.md'].ops).toEqual(['touched']);
    expect(byPath['/work/proj/missing.txt'].ops).toEqual(['read']);
    // writes sort before reads
    expect(files[files.length - 1].path).toBe('/work/proj/missing.txt');
    expect(files.filter((f) => f.path === '/work/proj/hello.txt')).toHaveLength(1);
  });

  it('a write or edit that FAILED is not listed as created/edited', () => {
    const failed: HarnessEvent[] = [
      { seq: 0, kind: 'tool', name: 'edit', status: 'error', input: { filePath: '/work/proj/app.ts', oldString: 'a', newString: 'b' }, error: 'oldString not found in content' },
      { seq: 1, kind: 'tool', name: 'write_file', status: 'error', input: { file_path: '/work/proj/denied.txt', content: 'x' }, error: 'EACCES' },
      { seq: 2, kind: 'tool', name: 'edit', status: 'completed', input: { filePath: '/work/proj/ok.ts', oldString: 'a', newString: 'b' } },
    ];
    const files = collectRunFiles([], failed, '/work/proj');
    expect(files.map((f) => f.path)).toEqual(['/work/proj/ok.ts']);
  });
});

describe('offsetLabel', () => {
  it('formats the offset from run start', () => {
    expect(offsetLabel(T0 + 3200, T0)).toBe('+00:03.2');
    expect(offsetLabel(T0 + 65_000, T0)).toBe('+01:05.0');
    expect(offsetLabel(T0 + 3_723_000, T0)).toBe('+1:02:03');
    expect(offsetLabel(undefined, T0)).toBe('');
  });
});

describe('successRateLabel / pollIntervalMs', () => {
  it('— when there is no denominator', () => {
    expect(successRateLabel(null)).toBe('—');
    expect(successRateLabel({ successRate: null })).toBe('—');
    expect(successRateLabel({ successRate: 0.666 })).toBe('67%');
  });
  it('5 s while something runs, else 15 s', () => {
    expect(pollIntervalMs({ running: 2 })).toBe(5000);
    expect(pollIntervalMs({ running: 0 })).toBe(15000);
    expect(pollIntervalMs(null)).toBe(15000);
  });
});

describe('runs query', () => {
  it('omits defaults', () => {
    expect(buildRunsQuery({})).toBe('');
    expect(buildRunsQuery({ runner: 'all', since: 'all', includeBackfill: true, limit: 50, offset: 0 })).toBe('');
    expect(buildRunsQuery({ runner: 'claude' })).toBe('');
  });
  it('round-trips through parseRunsQuery, statuses in canonical order', () => {
    const qs = buildRunsQuery({ runner: 'qwen', statuses: ['aborted', 'failed'], q: '  hello world ', since: '7d', includeBackfill: false, limit: 100, offset: 100 });
    expect(qs).toBe('?runner=qwen&status=failed%2Caborted&q=hello+world&since=7d&includeBackfill=0&limit=100&offset=100');
    expect(parseRunsQuery(qs)).toEqual({ runner: 'qwen', statuses: ['failed', 'aborted'], q: 'hello world', since: '7d', includeBackfill: false, limit: 100, offset: 100 });
  });
  it('clamps q to 100 chars and limit to 200', () => {
    const f = parseRunsQuery(buildRunsQuery({ q: 'x'.repeat(150), limit: 999 }));
    expect(f.q).toHaveLength(100);
    expect(f.limit).toBe(200);
  });
});

describe('deep link', () => {
  it('round-trips and keeps params it does not own', () => {
    const s = buildDeepLink({ runner: 'opencode', run: 'oc-ses_f3470e223ffe2LO5P53o28dflX', tab: 'chat' }, '?foo=1&run=old');
    expect(s).toBe('?foo=1&runner=opencode&run=oc-ses_f3470e223ffe2LO5P53o28dflX&tab=chat');
    expect(parseDeepLink(s)).toEqual({ runner: 'opencode', run: 'oc-ses_f3470e223ffe2LO5P53o28dflX', tab: 'chat' });
  });
  it('omits defaults', () => {
    expect(buildDeepLink({ runner: 'all', run: null, tab: 'timeline' })).toBe('');
    expect(buildDeepLink({ runner: 'all', run: 'agent-1-x', tab: 'timeline' })).toBe('?run=agent-1-x');
  });
  it('rejects ids the route would refuse and unknown tabs', () => {
    expect(parseDeepLink('?run=..%2Fetc&tab=nope&runner=a%2Fb')).toEqual({ runner: 'all', run: null, tab: 'timeline' });
    expect(parseDeepLink('?run=a.b').run).toBeNull();
    expect(parseDeepLink('').runner).toBe('all');
  });
});

describe('transcript paging', () => {
  const page = (p: Partial<HarnessTranscriptPage>): HarnessTranscriptPage => ({
    id: 'r', runner: 'qwen', source: 'captured', version: 'c:1:1', events: [], total: 0, offset: 0, nextOffset: null,
    truncated: false, live: true, runStatus: 'running', filesTouched: [], warnings: [],
    sources: { captured: { available: true }, native: { kind: 'qwen-chat', available: false, reason: 'NO_CHAT_FILE' } },
    ...p,
  });
  it('merges by position: later pages append, unchanged keeps events, a head re-read refreshes in place without shrinking', () => {
    const first = page({ events: QWEN_EVENTS.slice(0, 3), total: 7, nextOffset: 3 });
    const more = mergeTranscript(first, page({ events: QWEN_EVENTS.slice(2, 7), offset: 3, total: 7 }));
    expect(more.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(more.offset).toBe(0);
    expect(more.nextOffset).toBe(null);
    const same = mergeTranscript(more, page({ unchanged: true, events: [], live: false, runStatus: 'succeeded' }));
    expect(same.events).toHaveLength(7);
    expect(same.runStatus).toBe('succeeded');
    // A head re-read (or a page the server's size budget cut short) replaces seqs 0-1 only.
    const done = { ...QWEN_EVENTS[1], text: 'refreshed' } as HarnessEvent;
    const head = mergeTranscript(more, page({ events: [QWEN_EVENTS[0], done], offset: 0, total: 7 }));
    expect(head.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(head.events[1]).toBe(done);
    expect(head.events[2]).toBe(more.events[2]);
    // A page from ANOTHER source (captured → native at the end) replaces everything.
    const native = mergeTranscript(more, page({ source: 'qwen-chat', events: QWEN_EVENTS.slice(0, 2), total: 2 }));
    expect(native.events).toHaveLength(2);
  });

  it('a live run past the loaded window follows its TAIL, and a poll never cuts back what Load more loaded', () => {
    const mk = (n: number, from = 0): HarnessEvent[] =>
      Array.from({ length: n }, (_, i) => ({ seq: from + i, kind: 'text' as const, text: `EVENT-${from + i}` }));
    let t = page({ events: mk(300), total: 375, nextOffset: 300 });
    // The poll re-reads from just before the end, so the newest events land.
    const from = liveTailOffset(t.events);
    expect(from).toBe(280);
    t = mergeTranscript(t, page({ events: mk(475 - from, from), offset: from, total: 475 }));
    expect(t.events).toHaveLength(475);
    expect(t.events[t.events.length - 1].seq).toBe(474);
    expect(t.nextOffset).toBe(null);
    // Past 1000 events a head-window refresh keeps everything loaded beyond it.
    t = mergeTranscript(t, page({ events: mk(1450 - 475, 475), offset: 475, total: 1450 }));
    const refreshed = mergeTranscript(t, page({ events: mk(1000), offset: 0, total: 1475, nextOffset: 1000 }));
    expect(refreshed.events).toHaveLength(1450);
    expect(refreshed.nextOffset).toBe(1450);
  });

  it('the live re-read starts before the first pending tool', () => {
    const evs: HarnessEvent[] = [
      ...QWEN_EVENTS.slice(0, 2),
      { seq: 2, kind: 'tool', name: 'write_file', status: 'pending' },
      ...QWEN_EVENTS.slice(3),
    ];
    expect(liveTailOffset(evs)).toBe(0);
    const many = Array.from({ length: 100 }, (_, i) => ({ seq: i, kind: 'text' as const, text: 'x' })) as HarnessEvent[];
    many[70] = { seq: 70, kind: 'tool', name: 'bash', status: 'running' };
    expect(liveTailOffset(many)).toBe(70);
    many[70] = { seq: 70, kind: 'tool', name: 'bash', status: 'completed' };
    expect(liveTailOffset(many)).toBe(80);
  });
});

describe('tabBadgeCounts', () => {
  it('reads the byRunner facet; a missing runner is 0, not the unfiltered total; All is the sum', () => {
    const c = tabBadgeCounts({ qwen: 2 });
    expect(c.of('qwen')).toBe(2);
    expect(c.of('opencode')).toBe(0);
    expect(c.all).toBe(2);
    expect(tabBadgeCounts(undefined).all).toBe(0);
  });
});

describe('timeline helpers', () => {
  it('filters: any enabled chip claims an event; tool errors ride with Errors too', () => {
    const only = (...f: TimelineFilter[]) => new Set(f);
    const errTool = QWEN_EVENTS[4];
    expect(eventMatchesFilters(errTool, only('errors'))).toBe(true);
    expect(eventMatchesFilters(QWEN_EVENTS[2], only('errors'))).toBe(false);
    expect(eventMatchesFilters(OPENCODE_EVENTS[5], only('errors'))).toBe(true);
    expect(eventMatchesFilters(QWEN_EVENTS[3], only('tools'))).toBe(false);
    expect(eventMatchesFilters(QWEN_EVENTS[0], only('text'))).toBe(true);
  });
  it('turn labels omit what is missing', () => {
    expect(turnLabel(QWEN_EVENTS[3] as Extract<HarnessEvent, { kind: 'turn' }>)).toBe('Turn 1 · vendor/synthetic-model:free · 16.1k/120/57 · 2.5s');
    expect(turnLabel(OPENCODE_EVENTS[7] as Extract<HarnessEvent, { kind: 'turn' }>)).toBe('Turn 3 · synthetic-model · 10.3k/13/106 · 1.2s · finish stop');
    expect(turnLabel({ seq: 0, kind: 'turn' })).toBe('Turn');
  });
  it('duration bars are proportional; a turn latency ends at its timestamp', () => {
    expect(barGeometry(OPENCODE_EVENTS[2], T0, 4000)).toEqual({ left: 50, width: 1 });
    const turn = barGeometry(QWEN_EVENTS[3], T0, 4000);
    expect(turn?.left).toBe(0);
    expect(turn?.width).toBeCloseTo(62.225, 2);
    expect(barGeometry(QWEN_EVENTS[0], T0, 4000)).toBeNull();
  });
  it('diff lines are classified', () => {
    expect(diffLines('--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n same').map((l) => l.kind)).toEqual(['meta', 'meta', 'hunk', 'del', 'add', 'ctx']);
    // Inside a hunk, content that LOOKS like a header is content: a removed `-- comment`
    // and an added `++i;`.
    expect(diffLines('--- a\n+++ b\n@@ -1,2 +1,2 @@\n--- legacy column\n+++i;\n keep').map((l) => l.kind))
      .toEqual(['meta', 'meta', 'hunk', 'del', 'add', 'ctx']);
    // The header of the NEXT file in a multi-file patch is still meta.
    expect(diffLines('--- a\n+++ a\n@@ -1 +1 @@\n-x\n+y\n--- b\n+++ b\n@@ -0,0 +1 @@\n+z').map((l) => l.kind))
      .toEqual(['meta', 'meta', 'hunk', 'del', 'add', 'meta', 'meta', 'hunk', 'add']);
  });
});

describe('transcriptNotice', () => {
  const sources = (reason?: string, available = false) => ({
    captured: { available: true }, native: { kind: 'opencode-db' as const, available, reason: reason as never },
  });
  it('explains a chatless qwen run', () => {
    expect(transcriptNotice({ source: 'none', sources: sources('NO_CHAT_FILE'), runStatus: 'not_started' }, 'qwen')?.text)
      .toMatch(/never received the prompt/);
  });
  it('explains why the native source was skipped', () => {
    expect(transcriptNotice({ source: 'captured', sources: sources('SQLITE_UNAVAILABLE'), runStatus: 'succeeded' }, 'opencode')?.text).toMatch(/npm rebuild better-sqlite3/);
    expect(transcriptNotice({ source: 'captured', sources: sources('UNSUPPORTED_SCHEMA'), runStatus: 'succeeded', cliVersion: '9.9.9' }, 'opencode')?.text)
      .toBe('OpenCode 9.9.9 stores transcripts in a format this build does not read');
    expect(transcriptNotice({ source: 'captured', sources: sources('SESSION_NOT_FOUND'), runStatus: 'succeeded' }, 'opencode')?.text).toMatch(/deleted from OpenCode/);
    expect(transcriptNotice({ source: 'none', sources: sources('NO_SESSION_ID'), runStatus: 'running' }, 'opencode')?.text).toBe('waiting for first output…');
  });
  it('says nothing when the native source was used or does not apply', () => {
    expect(transcriptNotice({ source: 'opencode-db', sources: sources(undefined, true), runStatus: 'succeeded' }, 'opencode')).toBeNull();
    expect(transcriptNotice({ source: 'captured', sources: sources('NOT_APPLICABLE'), runStatus: 'succeeded' }, 'x')).toBeNull();
  });
});

describe('runner tabs + status bar', () => {
  const summary = (id: string, pluggable: boolean, recorded: boolean): HarnessRunnerSummary => ({
    id, displayName: id, pluggable, recorded, maxTurnsEnforced: null, isolation: null, profile: null, stats: null,
    capabilities: { cost: 'unavailable', sessionResume: false, mcp: false, permissionBroker: false, durableBackground: false, usesProviderProfile: true, abortable: true },
  });
  it('only pluggable + recorded runners get a tab', () => {
    const tabs = recordedRunnerTabs([summary('sdk', false, false), summary('qwen', true, true), summary('opencode', true, true), summary('x', true, false)]);
    expect(tabs.map((t) => t.id)).toEqual(['qwen', 'opencode']);
    expect(recordedRunnerTabs(null)).toEqual([]);
  });
  it('status segments in canonical order with percentages', () => {
    const segs = statusBarSegments({ failed: 1, succeeded: 3, aborted: 0 });
    expect(segs.map((s) => [s.status, s.count, s.pct])).toEqual([['succeeded', 3, 75], ['failed', 1, 25]]);
    expect(statusBarSegments(undefined)).toEqual([]);
  });
});
