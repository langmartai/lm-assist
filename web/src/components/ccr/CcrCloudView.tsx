'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, X, Send, RefreshCw, ExternalLink, Eye, EyeOff, Cloud } from 'lucide-react';
import { filterInjectedExchanges } from '@/lib/injected-message';
import { TranscriptMessage } from '@/components/shared/TranscriptMessage';
import { ApprovalWidget } from '@/components/shared/ApprovalWidget';

type ApiFetch = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
interface CloudMsg { role: string; type: string; text: string; tools?: string[] }
interface QOption { label: string; description?: string }
interface PendingQuestion { toolUseId: string; requestId?: string; questions: Array<{ header?: string; question?: string; multiSelect?: boolean; options?: QOption[] }> }

/** Native viewer for a CLOUD CCR session (claude runs in an Anthropic-cloud container).
 *  Renders the teleport-events transcript and drives via /ccr/cloud/:sid/drive. */
export function CcrCloudView({ sid, webUrl, apiFetch, onClose, fill, hideHeader }: {
  sid: string; webUrl?: string; apiFetch: ApiFetch; onClose: () => void; fill?: boolean; hideHeader?: boolean;
}) {
  const [messages, setMessages] = useState<CloudMsg[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [pendingQ, setPendingQ] = useState<PendingQuestion | null>(null);
  const [answering, setAnswering] = useState(false);
  const [gone, setGone] = useState(false); // session deleted/ended — stop polling, show a clean state
  const [hideInjected, setHideInjected] = useState(true); // "Only user ↔ assistant" — default ON
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const seqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++seqRef.current; // guard: a slower/older response must not overwrite a newer one
    try {
      const r = await apiFetch<{ messages?: CloudMsg[]; pendingQuestion?: PendingQuestion | null }>(`/ccr/cloud/${encodeURIComponent(sid)}`);
      if (seq !== seqRef.current) return; // a newer load started — drop this stale result
      setMessages(r.messages || []); setPendingQ(r.pendingQuestion || null); setErr(null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      // A deleted/stopped session 404s on read — surface a clean "ended" state and stop polling
      // (don't sit on a raw "API 400: …not found" and keep retrying).
      if (/not.?found|HTTP 404|session_deleted|no live/i.test(msg)) { setGone(true); setLive(false); }
      else setErr(msg);
    }
    finally { if (seq === seqRef.current) setLoading(false); }
  }, [apiFetch, sid]);

  // Answer a pending AskUserQuestion — by clicking an option (label) or typing free text. Both hit /answer.
  const answer = useCallback(async (text: string) => {
    const a = text.trim(); if (!a) return;
    setAnswering(true); setErr(null);
    try {
      // requestId/toolUseId thread through for a --remote-control bridge session (controller/executor);
      // for a cloud session they're ignored (the backend auto-resolves the tool_use_id from teleport).
      await apiFetch(`/ccr/cloud/${encodeURIComponent(sid)}/answer`, { method: 'POST', body: { answer: a, toolUseId: pendingQ?.toolUseId, requestId: pendingQ?.requestId } });
      setPendingQ(null); setSent(`answered: ${a.slice(0, 50)}`); setTimeout(() => setSent(null), 4000); setTimeout(load, 1500);
    } catch (e) { setErr(`answer failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setAnswering(false); }
  }, [apiFetch, sid, load, pendingQ]);

  // Stable 5s poll via a ref — apiFetch/apiClient identity churn (hybrid/proxy mode) must not reset
  // the interval and fire overlapping fetches that race and show stale data.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    loadRef.current();
    if (!live) return;
    const t = setInterval(() => loadRef.current(), 5000);
    return () => clearInterval(t);
  }, [live, sid]);
  useEffect(() => { const el = scrollRef.current; if (el && atBottomRef.current) el.scrollTop = el.scrollHeight; });

  const send = useCallback(async () => {
    const text = prompt.trim(); if (!text) return;
    setSending(true); setErr(null);
    try {
      await apiFetch(`/ccr/cloud/${encodeURIComponent(sid)}/drive`, { method: 'POST', body: { text } });
      setPrompt(''); setSent(text.slice(0, 60)); setTimeout(() => setSent(null), 4000); setTimeout(load, 1500);
    } catch (e) { setErr(`drive failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setSending(false); }
  }, [apiFetch, sid, prompt, load]);

  // "Only user ↔ assistant": always drop truly-empty turns (no text AND no tools);
  // when the toggle is ON, also drop lm-assist-injected scaffolding.
  const nonEmpty = messages.filter((m) => (m.text && m.text.trim().length > 0) || (m.tools && m.tools.length > 0));
  // Span-aware: also hides the assistant responses to a hidden injected directive.
  const visibleMessages = hideInjected ? filterInjectedExchanges(nonEmpty, (m) => m.text || '') : nonEmpty;
  const injectedHiddenCount = nonEmpty.length - visibleMessages.length;

  return (
    <div className="card" style={{ marginTop: fill ? 0 : 8, padding: 0, display: 'flex', flexDirection: 'column', ...(fill ? { flex: 1, minHeight: 0, height: '100%', maxHeight: 'none' as const } : { maxHeight: 520 }), overflow: 'hidden', border: fill ? 'none' : '1px solid var(--color-accent)' }}>
      {!hideHeader && (
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Cloud size={14} style={{ color: 'var(--color-accent)' }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>cloud session</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>{sid.replace('session_', '').slice(0, 10)}</span>
        <div style={{ flex: 1 }} />
        {webUrl && <a className="btn btn-ghost btn-sm" href={webUrl} target="_blank" rel="noreferrer" title="Open in Claude app"><ExternalLink size={12} /></a>}
        <button className="btn btn-ghost btn-sm" onClick={() => setHideInjected((v) => !v)}
          title={hideInjected ? 'Showing only user ↔ assistant — click to show injected turns' : 'Showing all turns — click to hide injected'}>
          {hideInjected ? <EyeOff size={12} /> : <Eye size={12} />} <span style={{ fontSize: 10.5 }}>only user ↔ assistant</span>
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setLive((v) => !v)} title={live ? 'Auto-refresh on (5s)' : 'paused'}>
          <RefreshCw size={12} style={live ? { animation: 'spin 3s linear infinite' } : undefined} /> {live ? 'live' : 'paused'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={13} /></button>
      </div>
      )}

      <div ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 200 }}>
        {gone ? (
          <div className="empty-state"><Cloud size={28} className="empty-state-icon" /><div style={{ fontSize: 12.5 }}>This cloud session has ended (stopped/deleted).</div><button className="btn btn-ghost btn-sm" onClick={onClose} style={{ marginTop: 8 }}><X size={13} /> Close</button></div>
        ) : loading && !messages.length ? (
          <div className="empty-state"><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /><span style={{ fontSize: 12 }}>Loading…</span></div>
        ) : err && !messages.length ? (
          <div style={{ fontSize: 12, color: 'var(--color-status-red)' }}>{err}</div>
        ) : !messages.length ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>No turns yet — the cloud container is booting; replies appear here.</div>
        ) : (
          <>
            {visibleMessages.map((m, i) => <TranscriptMessage key={i} m={m} compact />)}
            {injectedHiddenCount > 0 && (
              <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', textAlign: 'center', padding: '4px 0', fontStyle: 'italic' }}>
                · {injectedHiddenCount} injected message{injectedHiddenCount === 1 ? '' : 's'} hidden ·
              </div>
            )}
          </>
        )}
      </div>

      {!gone && (
      <div style={{ borderTop: '1px solid var(--color-border-default)', padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {err && messages.length > 0 && <div style={{ fontSize: 11, color: 'var(--color-status-red)' }}>{err}</div>}
        {sent && <div style={{ fontSize: 11, color: 'var(--color-status-green)' }}>{sent}.</div>}

        {/* Pending AskUserQuestion — answer by clicking an option OR typing a custom reply (both → /answer) */}
        {pendingQ && pendingQ.questions[0] && (
          <ApprovalWidget pending={pendingQ} answering={answering} onAnswer={answer} />
        )}

        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <textarea className="input" value={prompt} rows={2} placeholder="Drive the cloud session: type a prompt…"
            disabled={sending} style={{ flex: 1, resize: 'none', fontSize: 12.5 }}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
          <button className="btn btn-primary btn-sm" disabled={sending || !prompt.trim()} onClick={send} title="Send (⌘/Ctrl+Enter)">
            {sending ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={13} />}
          </button>
        </div>
      </div>
      )}
    </div>
  );
}
