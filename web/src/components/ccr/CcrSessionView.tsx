'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2, X, Send, RefreshCw, Sparkles, Wrench, ChevronRight, ChevronDown, User } from 'lucide-react';
import { formatToolCallString } from '@/lib/smart-display';

interface ToolCall { name?: string; input?: Record<string, unknown>; isError?: boolean; result?: string; resultSummary?: string }
interface Msg { role: string; content?: string; turnIndex?: number; lineIndex?: number; toolCalls?: ToolCall[]; timestamp?: string }
interface Think { lineIndex?: number; turnIndex?: number; thinking?: string }
type Item = { k: 'msg'; line: number; m: Msg } | { k: 'think'; line: number; t: string };

type ApiFetch = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

/** Native embedded view of a Claude Code (CCR-bridged) session — rich render like claude.ai/code
 *  (markdown text, thinking blocks, tool cards) + a drive box. claude.ai blocks iframing, so we render
 *  the same transcript events ourselves. */
export function CcrSessionView({ sessionId, driveable, tmuxSession, apiFetch, onClose, fill, hideHeader }: {
  sessionId: string; driveable: boolean; tmuxSession?: string; apiFetch: ApiFetch; onClose: () => void; fill?: boolean; hideHeader?: boolean;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [thinking, setThinking] = useState<Think[]>([]);
  const [info, setInfo] = useState<{ model?: string; numTurns?: number; status?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [via, setVia] = useState<string>('');
  const [live, setLive] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const seqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++seqRef.current; // guard: a slower/older response must not overwrite a newer one
    try {
      const r = await apiFetch<{ messages?: Msg[]; thinkingBlocks?: Think[]; model?: string; numTurns?: number; sessionInfo?: { status?: string } }>(
        `/sessions/${encodeURIComponent(sessionId)}/conversation?lastN=40&toolDetail=full`,
      );
      if (seq !== seqRef.current) return; // a newer load started — drop this stale result
      setMessages(r.messages || []);
      setThinking(r.thinkingBlocks || []);
      setInfo({ model: r.model, numTurns: r.numTurns, status: r.sessionInfo?.status });
      setErr(null);
    } catch (e) { if (seq === seqRef.current) setErr(e instanceof Error ? e.message : String(e)); }
    finally { if (seq === seqRef.current) setLoading(false); }
  }, [apiFetch, sessionId]);

  // Poll on a STABLE 5s interval that always calls the latest `load` via a ref. Keying the interval
  // on `load`/`apiFetch` identity (which churns in hybrid/proxy mode) made the effect re-run every
  // few seconds, firing OVERLAPPING fetches whose out-of-order arrival showed stale data ("not
  // updating sometimes"). The ref decouples the cadence from that churn.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    loadRef.current();
    if (!live) return;
    const t = setInterval(() => loadRef.current(), 5000);
    return () => clearInterval(t);
  }, [live, sessionId]);
  useEffect(() => { const el = scrollRef.current; if (el && atBottomRef.current) el.scrollTop = el.scrollHeight; });

  // interleave messages + thinking by line position (the transcript order claude.ai renders)
  const stream = useMemo<Item[]>(() => {
    const items: Item[] = [];
    for (const m of messages) items.push({ k: 'msg', line: m.lineIndex ?? 0, m });
    for (const t of thinking) if (t.thinking) items.push({ k: 'think', line: Number(t.lineIndex) || 0, t: t.thinking });
    return items.sort((a, b) => a.line - b.line);
  }, [messages, thinking]);

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (!text) return;
    setSending(true); setErr(null);
    let label = '';
    try {
      // Primary: claude.ai cloud endpoint via /ccr/drive — reaches a two-way bridged
      // session from anywhere (the server itself falls back to tmux for a same-host bridge).
      try {
        const r = await apiFetch<{ path?: string; delivered?: boolean }>('/ccr/drive', { method: 'POST', body: { sessionId, text } });
        if (!r?.delivered) throw new Error('not delivered'); // force the same-host fallback
        label = r.path === 'cloud' ? 'sent via claude.ai (cloud)' : 'typed into the session (user turn)';
      } catch {
        // No live bridge for this session — same-host direct drive (second option).
        if (tmuxSession) {
          await apiFetch(`/terminal/tmux/${encodeURIComponent(tmuxSession)}/send-keys`, { method: 'POST', body: { keys: text, literal: true, enter: true } });
          label = 'typed into the session (user turn)';
        } else {
          await apiFetch('/session-messages', { method: 'POST', body: { toSession: sessionId, category: 'guided', body: text } });
          label = 'injected';
        }
      }
      setVia(label); setPrompt(''); setSent(text.slice(0, 60)); setTimeout(() => setSent(null), 4000); setTimeout(load, 1000);
    } catch (e) { setErr(`drive failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setSending(false); }
  }, [apiFetch, sessionId, prompt, load, tmuxSession]);

  return (
    <div className="card" style={{ marginTop: fill ? 0 : 8, padding: 0, display: 'flex', flexDirection: 'column', ...(fill ? { flex: 1, minHeight: 0, height: '100%', maxHeight: 'none' as const } : { maxHeight: 520 }), overflow: 'hidden', border: fill ? 'none' : '1px solid var(--color-accent)' }}>
      {!hideHeader && (
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>embedded session</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-tertiary)' }}>{sessionId.slice(0, 8)}</span>
        {info?.status && <span className="badge badge-outline">{info.status}</span>}
        {info?.numTurns != null && <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{info.numTurns} turns</span>}
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" onClick={() => setLive((v) => !v)} title={live ? 'Auto-refresh on (5s)' : 'paused'}>
          <RefreshCw size={12} style={live ? { animation: 'spin 3s linear infinite' } : undefined} /> {live ? 'live' : 'paused'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={13} /></button>
      </div>
      )}

      <div ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 200 }}>
        {loading && !stream.length ? (
          <div className="empty-state"><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /><span style={{ fontSize: 12 }}>Loading…</span></div>
        ) : err && !stream.length ? (
          <div style={{ fontSize: 12, color: 'var(--color-status-red)' }}>{err}</div>
        ) : !stream.length ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>No messages.</div>
        ) : stream.map((it, i) => it.k === 'think'
          ? <ThinkBlock key={`t${i}`} text={it.t} />
          : <Message key={it.m.lineIndex ?? `m${i}`} m={it.m} />)}
      </div>

      <div style={{ borderTop: '1px solid var(--color-border-default)', padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {err && stream.length > 0 && <div style={{ fontSize: 11, color: 'var(--color-status-red)' }}>{err}</div>}
        {sent && <div style={{ fontSize: 11, color: 'var(--color-status-green)' }}>{via || 'sent'}: “{sent}”.</div>}
        {!driveable && <div style={{ fontSize: 11, color: 'var(--color-status-orange)' }}>Not live/driveable — start it (or Connect) to drive. (View is read-only.)</div>}
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <textarea className="input" value={prompt} rows={2} placeholder={driveable ? 'Drive: type a prompt to send to the running session…' : 'Read-only'}
            disabled={!driveable || sending} style={{ flex: 1, resize: 'none', fontSize: 12.5 }}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
          <button className="btn btn-primary btn-sm" disabled={!driveable || sending || !prompt.trim()} onClick={send} title="Send (⌘/Ctrl+Enter)">
            {sending ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <><Send size={13} /> Drive</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function Message({ m }: { m: Msg }) {
  const isUser = m.role === 'user';
  // suppress the "[N tool call(s)]" placeholder content — the tool cards already render them
  const text = m.content?.trim();
  const showText = text && !/^\[\d+\s+tool call/i.test(text);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: isUser ? '8px 10px' : 0, borderLeft: isUser ? '2px solid var(--color-accent)' : undefined, background: isUser ? 'var(--color-bg-elevated)' : undefined, borderRadius: isUser ? 'var(--radius-sm)' : undefined }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: isUser ? 'var(--color-accent)' : 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: 4 }}>
        {isUser && <User size={11} />}{m.role.toUpperCase()}
      </span>
      {showText && (
        <div className="prose" style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-text-secondary)', maxWidth: 'none', wordBreak: 'break-word' }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text!.length > 6000 ? text!.slice(0, 6000) + ' …' : text!}</ReactMarkdown>
        </div>
      )}
      {m.toolCalls?.map((t, j) => <ToolCard key={j} t={t} />)}
    </div>
  );
}

function ToolCard({ t }: { t: ToolCall }) {
  const [open, setOpen] = useState(false);
  const header = formatToolCallString(t.name || 'tool', t.input);
  const result = (t.result || t.resultSummary || '').trim();
  return (
    <div style={{ border: `1px solid ${t.isError ? 'var(--color-status-red)' : 'var(--color-border-subtle)'}`, borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-elevated)', overflow: 'hidden' }}>
      <button onClick={() => setOpen((o) => !o)} disabled={!result}
        style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: result ? 'pointer' : 'default', padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-secondary)' }}>
        <Wrench size={11} style={{ color: t.isError ? 'var(--color-status-red)' : 'var(--color-accent)', flexShrink: 0 }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{header}</span>
        {t.isError && <span className="badge badge-red" style={{ flexShrink: 0 }}>error</span>}
        {result && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </button>
      {open && result && (
        <pre style={{ margin: 0, padding: '6px 8px', borderTop: '1px solid var(--color-border-subtle)', fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 220, overflow: 'auto' }}>
          {result.length > 3000 ? result.slice(0, 3000) + '\n… (truncated)' : result}
        </pre>
      )}
    </div>
  );
}

function ThinkBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderLeft: '2px solid var(--color-border-default)', paddingLeft: 8 }}>
      <button onClick={() => setOpen((o) => !o)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: 'var(--color-text-tertiary)' }}>
        <Sparkles size={11} /> THINKING {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div style={{ marginTop: 4, fontSize: 12, fontStyle: 'italic', color: 'var(--color-text-tertiary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>
          {text.length > 4000 ? text.slice(0, 4000) + ' …' : text}
        </div>
      )}
    </div>
  );
}
