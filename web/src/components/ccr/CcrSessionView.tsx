'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, X, Send, RefreshCw, ChevronDown } from 'lucide-react';

interface Msg {
  role: string;
  content?: string;
  turnIndex?: number;
  lineIndex?: number;
  toolCalls?: Array<{ name?: string; tool?: string } | string>;
  timestamp?: string;
}

type ApiFetch = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

/** Native embedded view of a Claude Code (CCR-bridged) session: live conversation + a drive box.
 *  Renders the SAME content the claude.ai/code page mirrors — no iframe (claude.ai blocks framing). */
export function CcrSessionView({ sessionId, driveable, tmuxSession, apiFetch, onClose }: {
  sessionId: string; driveable: boolean; tmuxSession?: string; apiFetch: ApiFetch; onClose: () => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [info, setInfo] = useState<{ model?: string; numTurns?: number; status?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [live, setLive] = useState(true); // auto-refresh on
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<{ messages?: Msg[]; model?: string; numTurns?: number; sessionInfo?: { status?: string } }>(
        `/sessions/${encodeURIComponent(sessionId)}/conversation?lastN=40&toolDetail=summary`,
      );
      setMessages(r.messages || []);
      setInfo({ model: r.model, numTurns: r.numTurns, status: r.sessionInfo?.status });
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [apiFetch, sessionId]);

  useEffect(() => {
    load();
    if (!live) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load, live]);

  // keep scrolled to bottom when new messages arrive and user is already at bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (!text) return;
    setSending(true); setErr(null);
    try {
      if (tmuxSession) {
        // Drive PARITY with the real CCR bridge / claude.ai/code: type the prompt into the session's
        // tmux pane as a clean USER turn (claude.ai → worker/events/stream client_event → bridge does the
        // same tmux send-keys). Closer than a 'guided' inject — it becomes a real user message.
        await apiFetch(`/terminal/tmux/${encodeURIComponent(tmuxSession)}/send-keys`, { method: 'POST', body: { keys: text, literal: true, enter: true } });
      } else {
        // No tmux backing → fall back to injecting it as a guided message.
        await apiFetch('/session-messages', { method: 'POST', body: { toSession: sessionId, category: 'guided', body: text } });
      }
      setPrompt(''); setSent(text.slice(0, 60)); setTimeout(() => setSent(null), 4000);
      setTimeout(load, 1000);
    } catch (e) {
      setErr(`drive failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setSending(false); }
  }, [apiFetch, sessionId, prompt, load, tmuxSession]);

  const roleColor = (r: string) => r === 'user' ? 'var(--color-accent)' : r === 'assistant' ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)';

  return (
    <div className="card" style={{ marginTop: 8, padding: 0, display: 'flex', flexDirection: 'column', maxHeight: 460, overflow: 'hidden', border: '1px solid var(--color-accent)' }}>
      {/* header */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>embedded session</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>{sessionId.slice(0, 8)}</span>
        {info?.status && <span className="badge badge-outline">{info.status}</span>}
        {info?.numTurns != null && <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{info.numTurns} turns</span>}
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" onClick={() => setLive((v) => !v)} title={live ? 'Auto-refresh on (5s)' : 'Auto-refresh off'}>
          <RefreshCw size={12} style={live ? { animation: 'spin 3s linear infinite' } : undefined} /> {live ? 'live' : 'paused'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={13} /></button>
      </div>

      {/* messages */}
      <div ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 160 }}>
        {loading && !messages.length ? (
          <div className="empty-state"><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /><span style={{ fontSize: 12 }}>Loading…</span></div>
        ) : err && !messages.length ? (
          <div style={{ fontSize: 12, color: 'var(--color-status-red)' }}>{err}</div>
        ) : !messages.length ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>No messages.</div>
        ) : messages.map((m, i) => (
          <div key={m.lineIndex ?? i} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: roleColor(m.role) }}>{m.role}</span>
            {m.content && <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>{m.content.length > 4000 ? m.content.slice(0, 4000) + ' …' : m.content}</div>}
            {!!m.toolCalls?.length && (
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                {m.toolCalls.map((t, j) => <span key={j}>🔧 {typeof t === 'string' ? t : (t.name || t.tool || 'tool')}{j < m.toolCalls!.length - 1 ? ' · ' : ''}</span>)}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* drive box */}
      <div style={{ borderTop: '1px solid var(--color-border-default)', padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {err && messages.length > 0 && <div style={{ fontSize: 11, color: 'var(--color-status-red)' }}>{err}</div>}
        {sent && <div style={{ fontSize: 11, color: 'var(--color-status-green)' }}>{tmuxSession ? 'typed into the session' : 'injected'}: “{sent}”{tmuxSession ? ' (user turn)' : ' — the session will pick it up'}.</div>}
        {!driveable && <div style={{ fontSize: 11, color: 'var(--color-status-orange)' }}>This session isn’t live/driveable — start it (or Connect) to drive it. (View is read-only.)</div>}
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <textarea className="input" value={prompt} rows={2} placeholder={driveable ? 'Drive: type a prompt to inject into the running session…' : 'Read-only — session not driveable'}
            disabled={!driveable || sending} style={{ flex: 1, resize: 'none', fontSize: 12.5 }}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
          <button className="btn btn-primary btn-sm" disabled={!driveable || sending || !prompt.trim()} onClick={send} title="Inject prompt (⌘/Ctrl+Enter)">
            {sending ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <><Send size={13} /> Drive</>}
          </button>
        </div>
      </div>
    </div>
  );
}
