'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppMode } from '@/contexts/AppModeContext';
import { errText } from '@/components/memory/format';
import {
  buildRunsQuery,
  liveTailOffset,
  mergeTranscript,
  pollIntervalMs,
  RUN_LIMITS,
  sinceToDays,
  type AgentExecutionItem,
  type HarnessDebugTail,
  type HarnessEvent,
  type HarnessRunDetail,
  type HarnessRunRow,
  type HarnessRunnersResponse,
  type HarnessRunsListResponse,
  type HarnessStatusResponse,
  type HarnessTranscriptPage,
  type RunsFilters,
} from '@/lib/harness-runs';

export type HarnessApiFetch = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

/** A Core that predates a route answers `Route not found` as a real 404; handler errors are 400. */
export function isNotFoundError(e: unknown): boolean {
  return /\bAPI 404\b/.test(String(e));
}

/**
 * apiClient.fetchPath bound to the node this page is viewing (the mcp-tools pattern). The
 * pure hub UI has no node to ask — fetchPath would throw 'Hub mode requires machineId' — so
 * `needsNode` lets the page say so instead of showing that error.
 */
export function useHarnessApi(): { apiFetch: HarnessApiFetch; needsNode: boolean } {
  const { apiClient, proxy, isHub } = useAppMode();
  const apiFetch = useCallback(
    <T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> =>
      apiClient.fetchPath<T>(path, { method: opts?.method, body: opts?.body, machineId: proxy.machineId || undefined }),
    [apiClient, proxy.machineId],
  );
  return { apiFetch, needsNode: isHub && !proxy.machineId };
}

/** Date.now() re-read every `ms` while `enabled` — drives the live elapsed timers. */
export function useNow(enabled: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [enabled, ms]);
  return now;
}

/** True below `px` wide (the page goes single-pane). */
export function useNarrow(px = 900): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${px - 1}px)`);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [px]);
  return narrow;
}

const PAGE = RUN_LIMITS.listDefault;

export interface HarnessRunsState {
  list: HarnessRunsListResponse | null;
  rows: HarnessRunRow[];
  runners: HarnessRunnersResponse | null;
  runnersError: string | null;
  loading: boolean;
  error: string | null;
  /** The last refresh failed; what is on screen is from `updatedAt`. */
  stale: boolean;
  /** /harness/runs is a 404: this node's Core predates the Harness Runs API. */
  notSupported: boolean;
  updatedAt: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  refresh: () => void;
  loadMore: () => void;
}

/**
 * GET /harness/runs + /harness/runners, polled every 5 s while something runs, else 15 s,
 * and not at all while the tab is hidden.
 *
 * "Load more" first widens the polled page (up to the route's 200 cap) so every loaded row
 * stays live; only past 200 does it fall back to offset pages, which are appended and not
 * re-polled.
 */
export function useHarnessRuns(
  filters: Omit<RunsFilters, 'limit' | 'offset'>,
  { enabled }: { enabled: boolean },
): HarnessRunsState {
  const { apiFetch } = useHarnessApi();
  const [list, setList] = useState<HarnessRunsListResponse | null>(null);
  const [extra, setExtra] = useState<HarnessRunRow[]>([]);
  const [extraNext, setExtraNext] = useState<number | null>(null);
  const [runners, setRunners] = useState<HarnessRunnersResponse | null>(null);
  const [runnersError, setRunnersError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notSupported, setNotSupported] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const key = buildRunsQuery(filters);
  const days = sinceToDays(filters.since);
  const filtersRef = useRef(filters);
  const wantRef = useRef<number>(PAGE);
  const seqRef = useRef(0);
  /**
   * Bumped ONLY by a filter/runner reset — not by polls, so a poll landing mid-"Load more"
   * does not throw away a good page. An offset page that returns after a reset belongs to
   * the previous query and is dropped.
   */
  const queryGenRef = useRef(0);
  useEffect(() => { filtersRef.current = filters; });

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    const f = filtersRef.current;
    const [runsR, runnersR] = await Promise.allSettled([
      apiFetch<HarnessRunsListResponse>(`/harness/runs${buildRunsQuery({ ...f, limit: wantRef.current })}`),
      apiFetch<HarnessRunnersResponse>(`/harness/runners?days=${sinceToDays(f.since)}`),
    ]);
    if (seq !== seqRef.current) return; // a newer load already landed — drop this one
    if (runsR.status === 'fulfilled') {
      setList(runsR.value);
      setError(null);
      setNotSupported(false);
      setUpdatedAt(Date.now());
    } else if (isNotFoundError(runsR.reason)) {
      setNotSupported(true);
    } else {
      // Keep the last good list on screen; the banner marks it stale.
      setError(errText(runsR.reason));
    }
    if (runnersR.status === 'fulfilled') {
      setRunners(runnersR.value);
      setRunnersError(null);
    } else if (!isNotFoundError(runnersR.reason)) {
      setRunnersError(errText(runnersR.reason));
    }
    setLoading(false);
  }, [apiFetch]);

  // Stable poll via a ref: apiClient identity churn (hybrid/proxy mode) must not reset the
  // interval or fire overlapping fetches.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);

  // A different runner is a different list, not a refinement of this one: drop the rows so
  // the new tab never shows the old tab's runs (or feeds its counts) while the fetch is out.
  // Other filter changes keep the old rows on screen until the answer lands.
  const runnerKey = filters.runner ?? '';
  const lastRunnerRef = useRef(runnerKey);
  useEffect(() => {
    if (!enabled) return;
    if (lastRunnerRef.current !== runnerKey) {
      lastRunnerRef.current = runnerKey;
      setList(null);
      setError(null);
    }
    queryGenRef.current++;
    wantRef.current = PAGE;
    setExtra([]);
    setExtraNext(null);
    setLoadingMore(false);
    void loadRef.current();
  }, [key, days, enabled, runnerKey]);

  const busy = (list?.counts.running ?? 0) > 0;
  useEffect(() => {
    if (!enabled || notSupported) return;
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void loadRef.current();
    }, pollIntervalMs({ running: busy ? 1 : 0 }));
    const onVisible = () => { if (!document.hidden) void loadRef.current(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [busy, enabled, notSupported]);

  const loadMore = useCallback(async () => {
    if (!list) return;
    const gen = queryGenRef.current;
    setLoadingMore(true);
    try {
      if (wantRef.current < RUN_LIMITS.listMax) {
        wantRef.current = Math.min(RUN_LIMITS.listMax, wantRef.current + PAGE);
        await loadRef.current();
        return;
      }
      const offset = extra.length ? extraNext : list.nextOffset;
      if (offset == null) return;
      const page = await apiFetch<HarnessRunsListResponse>(`/harness/runs${buildRunsQuery({ ...filtersRef.current, limit: PAGE, offset })}`);
      if (gen !== queryGenRef.current) return; // the filters changed while this page was out
      setExtra((prev) => [...prev, ...page.runs]);
      setExtraNext(page.nextOffset);
    } catch (e) {
      if (gen === queryGenRef.current) setError(errText(e));
    } finally {
      if (gen === queryGenRef.current) setLoadingMore(false);
    }
  }, [apiFetch, list, extra.length, extraNext]);

  const rows = useMemo(() => {
    const base = list?.runs ?? [];
    if (!extra.length) return base;
    const seen = new Set(base.map((r) => r.id));
    return [...base, ...extra.filter((r) => !seen.has(r.id))];
  }, [list, extra]);
  const hasMore = extra.length ? extraNext != null : list?.nextOffset != null;

  const refresh = useCallback(() => { void loadRef.current(); }, []);
  const loadMoreCb = useCallback(() => { void loadMore(); }, [loadMore]);
  return {
    list, rows, runners, runnersError, loading, error,
    stale: !!error && !!list,
    notSupported, updatedAt, hasMore, loadingMore,
    refresh,
    loadMore: loadMoreCb,
  };
}

/**
 * GET /harness/status — once, then only on an explicit refresh. It shells out to every
 * harness probe (~1.6 s measured), so it must never ride a poll or re-fire on apiClient churn.
 */
export function useHarnessStatus(enabled: boolean) {
  const { apiFetch } = useHarnessApi();
  const [status, setStatus] = useState<HarnessStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchRef = useRef(apiFetch);
  useEffect(() => { fetchRef.current = apiFetch; }, [apiFetch]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await fetchRef.current<HarnessStatusResponse>('/harness/status'));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadedRef = useRef(false);
  useEffect(() => {
    if (!enabled || loadedRef.current) return;
    loadedRef.current = true;
    void refresh();
  }, [enabled, refresh]);

  return { status, loading, error, refresh };
}

export type TranscriptChoice = 'auto' | 'captured' | 'native';

const LIVE_POLL_MS = 3000;
const TRANSCRIPT_PAGE = 300;
const TRANSCRIPT_MAX = 1000;

export interface HarnessRunState {
  detail: HarnessRunDetail | null;
  transcript: HarnessTranscriptPage | null;
  loading: boolean;
  error: string | null;
  transcriptLoading: boolean;
  transcriptError: string | null;
  notFound: boolean;
  source: TranscriptChoice;
  setSource: (s: TranscriptChoice) => void;
  loadingMore: boolean;
  loadMore: () => void;
  refresh: () => void;
  /** POST /agent/execution/:id/abort. Resolves to null on success, else the server's reason verbatim. */
  abort: () => Promise<string | null>;
}

/**
 * One run: GET /harness/runs/:id then its transcript. While the run is live both are
 * re-read every 3 s, the transcript with `ifVersion` so an idle run costs an empty
 * `unchanged` answer, and from just before its TAIL (liveTailOffset) so a run past the
 * first page still shows its newest events. On the transition to terminal — seen by a
 * poll or by an abort — one unconditional head re-read picks up the native source (auto
 * switches to it once the run ends), then polling stops.
 */
export function useHarnessRun(id: string | null): HarnessRunState {
  const { apiFetch } = useHarnessApi();
  const [detail, setDetail] = useState<HarnessRunDetail | null>(null);
  const [transcript, setTranscript] = useState<HarnessTranscriptPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [source, setSourceState] = useState<TranscriptChoice>('auto');
  const [loadingMore, setLoadingMore] = useState(false);

  // Generation: bumped on every id/source change so a slow answer for the previous run
  // (or source) can never land on the current one.
  const genRef = useRef(0);
  const transcriptRef = useRef<HarnessTranscriptPage | null>(null);
  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  const fetchRef = useRef(apiFetch);
  useEffect(() => { fetchRef.current = apiFetch; }, [apiFetch]);

  const enc = encodeURIComponent;

  const fetchDetail = useCallback(async (gen: number, runId: string): Promise<HarnessRunDetail | null> => {
    try {
      const d = await fetchRef.current<HarnessRunDetail>(`/harness/runs/${enc(runId)}`);
      if (gen !== genRef.current) return null;
      setDetail(d);
      setError(null);
      return d;
    } catch (e) {
      if (gen !== genRef.current) return null;
      if (isNotFoundError(e)) setNotFound(true);
      else setError(errText(e));
      return null;
    }
  }, [enc]);

  const fetchTranscript = useCallback(async (
    gen: number, runId: string, src: TranscriptChoice, opts: { ifVersion?: string; offset?: number; limit?: number } = {},
  ) => {
    const get = (offset: number, ifVersion?: string) => {
      const q = new URLSearchParams({
        source: src,
        offset: String(offset),
        limit: String(opts.limit ?? TRANSCRIPT_PAGE),
        maxField: '4000',
      });
      if (ifVersion) q.set('ifVersion', ifVersion);
      return fetchRef.current<HarnessTranscriptPage>(`/harness/runs/${enc(runId)}/transcript?${q.toString()}`);
    };
    try {
      let page = await get(opts.offset ?? 0, opts.ifVersion);
      if (gen !== genRef.current) return;
      const cur = transcriptRef.current;
      if (!page.unchanged && page.offset > 0 && (!cur || page.source !== cur.source)) {
        // The served source changed under a tail read (a capture appeared, say): its seqs
        // do not line up with what is on screen, so read it from the start instead.
        page = await get(0);
        if (gen !== genRef.current) return;
      }
      const next = page;
      setTranscript((prev) => mergeTranscript(prev, next));
      setTranscriptError(null);
    } catch (e) {
      if (gen !== genRef.current) return;
      if (isNotFoundError(e)) setNotFound(true);
      else setTranscriptError(errText(e));
    }
  }, [enc]);

  // The window a head re-read asks for. mergeTranscript keeps anything loaded past it.
  const windowLimit = () => Math.min(TRANSCRIPT_MAX, Math.max(TRANSCRIPT_PAGE, transcriptRef.current?.events.length ?? 0));

  const loadAll = useCallback(async (runId: string, src: TranscriptChoice, resetDetail: boolean) => {
    const gen = ++genRef.current;
    if (resetDetail) {
      setDetail(null);
      setError(null);
      setNotFound(false);
      setLoading(true);
    }
    setTranscript(null);
    setTranscriptError(null);
    setTranscriptLoading(true);
    const d = await fetchDetail(gen, runId);
    if (gen !== genRef.current) return;
    setLoading(false);
    if (d) await fetchTranscript(gen, runId, src);
    if (gen === genRef.current) setTranscriptLoading(false);
  }, [fetchDetail, fetchTranscript]);

  useEffect(() => {
    if (!id) {
      genRef.current++;
      setDetail(null); setTranscript(null); setNotFound(false); setError(null); setLoading(false);
      return;
    }
    setSourceState('auto');
    void loadAll(id, 'auto', true);
  }, [id, loadAll]);

  const setSource = useCallback((s: TranscriptChoice) => {
    setSourceState(s);
    if (id) void loadAll(id, s, false);
  }, [id, loadAll]);

  const live = !!detail?.live;
  const sourceRef = useRef(source);
  useEffect(() => { sourceRef.current = source; }, [source]);

  useEffect(() => {
    if (!id || !live) return;
    let inFlight = false;
    const t = setInterval(async () => {
      if (inFlight || (typeof document !== 'undefined' && document.hidden)) return;
      inFlight = true;
      // Read per tick: a source switch bumps the generation without re-running this effect.
      const gen = genRef.current;
      try {
        const d = await fetchDetail(gen, id);
        const cur = transcriptRef.current;
        await fetchTranscript(gen, id, sourceRef.current, {
          ifVersion: cur?.version,
          offset: cur ? liveTailOffset(cur.events) : 0,
          limit: TRANSCRIPT_MAX,
        });
        if (d && !d.live) await fetchTranscript(gen, id, sourceRef.current, { limit: windowLimit() });
      } finally {
        inFlight = false;
      }
    }, LIVE_POLL_MS);
    return () => clearInterval(t);
  }, [id, live, fetchDetail, fetchTranscript]);

  const loadMoreAsync = useCallback(async () => {
    const t = transcriptRef.current;
    if (!id || !t || t.nextOffset == null) return;
    setLoadingMore(true);
    try {
      await fetchTranscript(genRef.current, id, sourceRef.current, { offset: t.nextOffset, limit: TRANSCRIPT_PAGE });
    } finally {
      setLoadingMore(false);
    }
  }, [id, fetchTranscript]);
  const loadMore = useCallback(() => { void loadMoreAsync(); }, [loadMoreAsync]);

  const refresh = useCallback(() => {
    if (id) void loadAll(id, sourceRef.current, false);
  }, [id, loadAll]);

  const abort = useCallback(async (): Promise<string | null> => {
    if (!id) return 'no run selected';
    const execId = detail?.run.executionId ?? id;
    try {
      await fetchRef.current(`/agent/execution/${enc(execId)}/abort`, { method: 'POST' });
    } catch (e) {
      return errText(e);
    }
    const gen = genRef.current;
    const d = await fetchDetail(gen, id);
    // Already terminal (the child exited before this read landed — certain through the hub
    // relay): the live effect is torn down now and its tick will never do the final re-read,
    // so do it here, keeping the loaded window.
    if (d && !d.live) await fetchTranscript(gen, id, sourceRef.current, { limit: windowLimit() });
    return null;
  }, [id, detail?.run.executionId, enc, fetchDetail, fetchTranscript]);

  return {
    detail, transcript, loading, error, transcriptLoading, transcriptError, notFound,
    source, setSource, loadingMore, loadMore, refresh, abort,
  };
}

/**
 * The FULL text of one event the page shows cut at 4,000 chars (`truncated`): the Prompt &
 * Result tab re-reads that single event at the route's 65,536-char cap, from the same
 * source. Returns null until it lands (the caller shows the cut one meanwhile).
 */
export function useFullEvent(runId: string | null, page: HarnessTranscriptPage | null, ev: HarnessEvent | null | undefined): HarnessEvent | null {
  const { apiFetch } = useHarnessApi();
  const [full, setFull] = useState<HarnessEvent | null>(null);
  const fetchRef = useRef(apiFetch);
  useEffect(() => { fetchRef.current = apiFetch; }, [apiFetch]);
  const cut = !!ev && 'truncated' in ev && ev.truncated === true;
  const served = page?.source;
  const src = served === 'captured' ? 'captured' : served === 'qwen-chat' || served === 'opencode-db' ? 'native' : null;
  const seq = ev?.seq;
  const kind = ev?.kind;
  const version = page?.version;
  useEffect(() => {
    setFull(null);
    if (!runId || !cut || seq == null || !src) return;
    let cancelled = false;
    void (async () => {
      try {
        const q = new URLSearchParams({ source: src, offset: String(seq), limit: '1', maxField: '65536' });
        const p = await fetchRef.current<HarnessTranscriptPage>(`/harness/runs/${encodeURIComponent(runId)}/transcript?${q.toString()}`);
        const got = p.events[0];
        if (!cancelled && got && got.seq === seq && got.kind === kind && p.source === served) setFull(got);
      } catch { /* keep showing the cut one */ }
    })();
    return () => { cancelled = true; };
  }, [runId, cut, seq, kind, src, served, version]);
  return full;
}

/** GET /harness/runs/:id/debug — fetched when the Debug tab opens, not polled. */
export function useHarnessDebug(id: string | null, enabled: boolean) {
  const { apiFetch } = useHarnessApi();
  const [tail, setTail] = useState<HarnessDebugTail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchRef = useRef(apiFetch);
  useEffect(() => { fetchRef.current = apiFetch; }, [apiFetch]);

  const load = useCallback(async (runId: string, cancelled: () => boolean) => {
    setLoading(true);
    try {
      const d = await fetchRef.current<HarnessDebugTail>(`/harness/runs/${encodeURIComponent(runId)}/debug?lines=120`);
      if (!cancelled()) { setTail(d); setError(null); }
    } catch (e) {
      if (!cancelled()) { setTail(null); setError(errText(e)); }
    } finally {
      if (!cancelled()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setTail(null);
    setError(null);
    if (!id || !enabled) return;
    let cancelled = false;
    void load(id, () => cancelled);
    return () => { cancelled = true; };
  }, [id, enabled, load]);

  return { tail, loading, error, refresh: () => { if (id) void load(id, () => false); } };
}

/** GET /agent/executions — the in-memory background map, loaded once for the Claude runners tab. */
export function useAgentExecutions(enabled: boolean) {
  const { apiFetch } = useHarnessApi();
  const [items, setItems] = useState<AgentExecutionItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchRef = useRef(apiFetch);
  useEffect(() => { fetchRef.current = apiFetch; }, [apiFetch]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchRef.current<AgentExecutionItem[] | { executions?: AgentExecutionItem[] }>('/agent/executions');
      setItems(Array.isArray(d) ? d : d?.executions ?? []);
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadedRef = useRef(false);
  useEffect(() => {
    if (!enabled || loadedRef.current) return;
    loadedRef.current = true;
    void refresh();
  }, [enabled, refresh]);

  return { items, loading, error, refresh };
}
