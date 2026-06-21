'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2, X, Send, RefreshCw, Wrench, User, Cloud, ExternalLink, HelpCircle } from 'lucide-react';

type ApiFetch = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
interface CloudMsg { role: string; type: string; text: string; tools?: string[] }
interface QOption { label: string; description?: string }
interface PendingQuestion { toolUseId: string; questions: Array<{ header?: string; question?: string; multiSelect?: boolean; options?: QOption[] }> }

/** Native viewer for a CLOUD CCR session (claude runs in an Anthropic-cloud container).
 *  Renders the teleport-events transcript and drives via /ccr/cloud/:sid/drive. */
export function CcrCloudView({ sid, webUrl, apiFetch, onClose }: {
  sid: string; webUrl?: string; apiFetch: ApiFetch; onClose: () => void;
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
  const [customAnswer, setCustomAnswer] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const seqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++seqRef.current; // guard: a slower/older response must not overwrite a newer one
    try {
      const r = await apiFetch<{ messages?: CloudMsg[]; pendingQuestion?: PendingQuestion | null }>(`/ccr/cloud/${encodeURIComponent(sid)}`);
      if (seq !== seqRef.current) return; // a newer load started — drop this stale result
      setMessages(r.messages || []); setPendingQ(r.pendingQuestion || null); setErr(null);
    } catch (e) { if (seq === seqRef.current) setErr(e instanceof Error ? e.message : String(e)); }
    finally { if (seq === seqRef.current) setLoading(false); }
  }, [apiFetch, sid]);

  // Answer a pending AskUserQuestion — by clicking an option (label) or typing free text. Both hit /answer.
  const answer = useCallback(async (text: string) => {
    const a = text.trim(); if (!a) return;
    setAnswering(true); setErr(null);
    try {
      await apiFetch(`/ccr/cloud/${encodeURIComponent(sid)}/answer`, { method: 'POST', body: { answer: a } });
      setPendingQ(null); setCustomAnswer(''); setSent(`answered: ${a.slice(0, 50)}`); setTimeout(() => setSent(null), 4000); setTimeout(load, 1500);
    } catch (e) { setErr(`answer failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setAnswering(false); }
  }, [apiFetch, sid, load]);

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

  return (
    <div className="card" style={{ marginTop: 8, padding: 0, display: 'flex', flexDirection: 'column', maxHeight: 520, overflow: 'hidden', border: '1px solid var(--color-accent)' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Cloud size={14} style={{ color: 'var(--color-accent)' }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>cloud session</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>{sid.replace('session_', '').slice(0, 10)}</span>
        <div style={{ flex: 1 }} />
        {webUrl && <a className="btn btn-ghost btn-sm" href={webUrl} target="_blank" rel="noreferrer" title="Open on claude.ai/code"><ExternalLink size={12} /></a>}
        <button className="btn btn-ghost btn-sm" onClick={() => setLive((v) => !v)} title={live ? 'Auto-refresh on (5s)' : 'paused'}>
          <RefreshCw size={12} style={live ? { animation: 'spin 3s linear infinite' } : undefined} /> {live ? 'live' : 'paused'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={13} /></button>
      </div>

      <div ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 200 }}>
        {loading && !messages.length ? (
          <div className="empty-state"><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /><span style={{ fontSize: 12 }}>Loading…</span></div>
        ) : err && !messages.length ? (
          <div style={{ fontSize: 12, color: 'var(--color-status-red)' }}>{err}</div>
        ) : !messages.length ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>No turns yet — the cloud container is booting; replies appear here.</div>
        ) : messages.map((m, i) => <CloudMessage key={i} m={m} />)}
      </div>

      <div style={{ borderTop: '1px solid var(--color-border-default)', padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {err && messages.length > 0 && <div style={{ fontSize: 11, color: 'var(--color-status-red)' }}>{err}</div>}
        {sent && <div style={{ fontSize: 11, color: 'var(--color-status-green)' }}>{sent}.</div>}

        {/* Pending AskUserQuestion — answer by clicking an option OR typing a custom reply (both → /answer) */}
        {pendingQ && pendingQ.questions[0] && (
          <div style={{ border: '1px solid var(--color-accent)', borderRadius: 'var(--radius-md)', padding: 8, marginBottom: 4, background: 'var(--color-bg-elevated)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>
              <HelpCircle size={13} style={{ color: 'var(--color-accent)' }} /> {pendingQ.questions[0].header || 'Question'} — the cloud claude is waiting on you
            </div>
            {pendingQ.questions[0].question && <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>{pendingQ.questions[0].question}</div>}
            {(pendingQ.questions[0].options || []).length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
                {(pendingQ.questions[0].options || []).map((o) => (
                  <button key={o.label} className="btn btn-ghost btn-sm" disabled={answering} onClick={() => answer(o.label)}
                    style={{ justifyContent: 'flex-start', textAlign: 'left', height: 'auto', padding: '6px 10px', whiteSpace: 'normal' }} title={o.description}>
                    <span style={{ fontWeight: 600 }}>{o.label}</span>{o.description ? <span style={{ color: 'var(--color-text-tertiary)', fontSize: 11 }}> — {o.description}</span> : null}
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input className="input" value={customAnswer} placeholder="…or type your own answer" disabled={answering}
                style={{ flex: 1, fontSize: 12 }} onChange={(e) => setCustomAnswer(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); answer(customAnswer); } }} />
              <button className="btn btn-primary btn-sm" disabled={answering || !customAnswer.trim()} onClick={() => answer(customAnswer)} title="Send custom answer">
                {answering ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : 'Send'}
              </button>
            </div>
          </div>
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
    </div>
  );
}

function CloudMessage({ m }: { m: CloudMsg }) {
  const isUser = m.type === 'user';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: isUser ? 'flex-end' : 'stretch' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {isUser ? <User size={11} /> : <Cloud size={11} />}{isUser ? 'you' : 'cloud claude'}
      </div>
      {m.text && (
        <div className="prose" style={{
          fontSize: 12.5, lineHeight: 1.55, maxWidth: isUser ? '85%' : '100%',
          background: isUser ? 'var(--color-bg-elevated)' : 'transparent',
          border: isUser ? '1px solid var(--color-border-default)' : 'none',
          borderRadius: isUser ? 'var(--radius-md)' : 0, padding: isUser ? '6px 10px' : 0,
        }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
        </div>
      )}
      {m.tools && m.tools.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {m.tools.map((t, i) => (
            <span key={i} className="badge badge-outline" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5 }}>
              <Wrench size={10} /> {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
