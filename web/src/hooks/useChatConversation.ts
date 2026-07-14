'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type ApiFetch = <T>(path: string, o?: { method?: string; body?: unknown }) => Promise<T>;

export interface ChatAttachment { file_name: string; file_type: string; file_size: number; extracted_content: string; origin: 'user_upload'; kind: 'file' }

export interface ChatDetailView {
  uuid: string;
  name?: string;
  messages: Array<{ role: string; type: string; text: string; thinking?: string; toolCalls?: Array<{ name: string; input?: unknown; result?: string; isError?: boolean }> }>;
}

/** Chat conversation detail: loads core-parsed messages, sends via the blocking
 *  completion endpoint (no SSE — the reply returns whole), then reloads. */
export function useChatConversation(opts: { uuid: string; apiFetch: ApiFetch; model: string }): {
  detail: ChatDetailView | null; err: string | null; gone: boolean; sending: boolean;
  send: (prompt: string, attachments?: ChatAttachment[]) => Promise<void>; refresh: () => void;
} {
  const { uuid, apiFetch, model } = opts;
  const [detail, setDetail] = useState<ChatDetailView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [sending, setSending] = useState(false);

  const seqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    // Retry a transient 404: a just-created conversation's read can 404 for a second or
    // two (claude.ai read-replica lag right after create) — retrying avoids a spurious
    // "conversation was deleted". Only a persistent 404 means truly gone.
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await apiFetch<ChatDetailView>(`/claude-ai/conversations/${uuid}/messages`);
        if (seq !== seqRef.current) return;
        // Success ⇒ exists; clear any prior `gone` (it must not latch).
        setDetail(r); setErr(null); setGone(false);
        return;
      } catch (e) {
        if (seq !== seqRef.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        const notFound = /not.?found|HTTP 404|CONVERSATION_NOT_FOUND/i.test(msg);
        if (notFound && attempt < 4) { await new Promise((r) => setTimeout(r, 700)); if (seq !== seqRef.current) return; continue; }
        if (notFound) setGone(true); else setErr(msg);
        return;
      }
    }
  }, [apiFetch, uuid]);

  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => { loadRef.current(); }, [uuid]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(async (prompt: string, attachments?: ChatAttachment[]) => {
    setSending(true);
    try {
      await apiFetch(`/claude-ai/conversations/${uuid}/completion`, {
        method: 'POST',
        body: { prompt, model, ...(attachments && attachments.length ? { attachments } : {}) },
      });
      await loadRef.current();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [apiFetch, uuid, model]);

  const refresh = useCallback(() => { loadRef.current(); }, []);
  return { detail, err, gone, sending, send, refresh };
}
