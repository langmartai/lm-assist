'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { workerFetch } from '@/lib/api-client';
import { parseSseChunk, shouldUseSse } from '@/lib/cowork-stream';

export interface CoworkDetailView {
  sid: string; title?: string; status?: string; model?: string;
  messages: Array<{ role: string; type: string; text: string; tools?: string[] }>;
  activeGoal: Array<{ label: string; status: 'done' | 'active' | 'pending' }>;
  outputs: string[];
  context: { tools: string[]; files: string[] };
  pendingQuestion: { toolUseId: string; requestId?: string; questions: any[] } | null;
  statusCategory: string | null;
}

type ApiFetch = <T>(path: string, o?: { method?: string; body?: unknown }) => Promise<T>;

/** Live task-detail transcript: initial load from Core, then kept live via true
 *  SSE (local/LAN — the browser reaches Core directly) or 5s polling (hub-relayed
 *  remote node — the `_coreapi` relay buffers responses, so SSE can't stream).
 *  SSE is used only as a "something changed" signal: each complete frame triggers
 *  a debounced refresh() (= full reload), so the backend's parse stays the single
 *  source of truth for `detail` — no client-side message merge to keep in sync. */
export function useLiveTranscript(opts: {
  sid: string;
  apiFetch: ApiFetch;
  detailPath: string;
  streamUrl: string | null;
  isRemoteNode: boolean;
  live: boolean;
}): { detail: CoworkDetailView | null; err: string | null; gone: boolean; refresh: () => void } {
  const { sid, apiFetch, detailPath, streamUrl, isRemoteNode, live } = opts;

  const [detail, setDetail] = useState<CoworkDetailView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  const seqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++seqRef.current; // guard: a slower/older response must not overwrite a newer one
    try {
      const r = await apiFetch<CoworkDetailView>(detailPath);
      if (seq !== seqRef.current) return; // a newer load started — drop this stale result
      setDetail(r); setErr(null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      // A deleted/ended task 404s on read — surface a clean "gone" state and stop live updates
      // (don't sit on a raw "API 400: …not found" and keep retrying).
      if (/not.?found|HTTP 404|session_deleted|no live/i.test(msg)) setGone(true);
      else setErr(msg);
    }
  }, [apiFetch, detailPath]);

  // Stable ref to the latest load — both the poll interval and the SSE debounce
  // key off this, so apiFetch/detailPath identity churn never resets a running
  // interval/timer or fires overlapping fetches that race and show stale data.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);

  // Initial load on mount / sid change.
  useEffect(() => { loadRef.current(); }, [sid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live updates: SSE-first (debounced refresh-on-frame) with a poll fallback.
  useEffect(() => {
    if (!live || gone) return;

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedRefresh = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => loadRef.current(), 300);
    };
    const startPolling = () => {
      if (pollTimer || cancelled) return;
      pollTimer = setInterval(() => loadRef.current(), 5000);
    };

    if (shouldUseSse({ isRemoteNode }) && streamUrl) {
      const controller = new AbortController();
      let sawFrame = false;
      const noFrameTimer = setTimeout(() => { if (!sawFrame) controller.abort(); }, 4000);

      (async () => {
        try {
          const res = await workerFetch(streamUrl, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
          const reader = res.body?.getReader();
          if (!reader) throw new Error('no response body');
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done || cancelled) break;
            buf += dec.decode(value, { stream: true });
            const { frames, rest } = parseSseChunk(buf);
            buf = rest;
            if (frames.length) { sawFrame = true; clearTimeout(noFrameTimer); debouncedRefresh(); }
          }
        } catch {
          // SSE rejected/aborted (incl. the 4s no-frame guard) — fall through to polling.
        } finally {
          clearTimeout(noFrameTimer);
          if (!cancelled) startPolling();
        }
      })();

      return () => {
        cancelled = true;
        controller.abort();
        clearTimeout(noFrameTimer);
        if (debounceTimer) clearTimeout(debounceTimer);
        if (pollTimer) clearInterval(pollTimer);
      };
    }

    startPolling();
    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [sid, live, gone, isRemoteNode, streamUrl]);

  const refresh = useCallback(() => { loadRef.current(); }, []);

  return { detail, err, gone, refresh };
}
