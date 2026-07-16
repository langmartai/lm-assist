'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2, X, Send, RefreshCw, Sparkles, Wrench, ChevronRight, ChevronDown, User } from 'lucide-react';
import { formatToolCallString } from '@/lib/smart-display';
import { parseEnvelopeError } from '@/lib/ccr-interact';
import { ApprovalWidget } from '@/components/shared/ApprovalWidget';

interface ToolCall { name?: string; input?: Record<string, unknown>; isError?: boolean; result?: string; resultSummary?: string }
interface Msg { role: string; content?: string; turnIndex?: number; lineIndex?: number; toolCalls?: ToolCall[]; timestamp?: string }
interface Think { lineIndex?: number; turnIndex?: number; thinking?: string }
type Item = { k: 'msg'; line: number; m: Msg } | { k: 'think'; line: number; t: string };
interface QOption { label: string; description?: string }
interface PendingQuestion { toolUseId: string; requestId?: string; questions: Array<{ header?: string; question?: string; multiSelect?: boolean; options?: QOption[] }> }

type ApiFetch = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

/** Native embedded view of a Claude Code (CCR-bridged) session — rich render like claude.ai/code
 *  (markdown text, thinking blocks, tool cards) + a drive box. claude.ai blocks iframing, so we render
 *  the same transcript events ourselves. */
export function CcrSessionView({ sessionId, driveable, apiFetch, onClose, fill, hideHeader }: {
  /** tmuxSession is still accepted from callers but no longer used — the mission drive resolves tmux server-side. */
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
  const [pendingQ, setPendingQ] = useState<PendingQuestion | null>(null);
  const [answering, setAnswering] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // This Core's node id — the leader-anchored /answer needs `node` to route back to
  // the session's own host when the leader is a different node. null when hub unconfigured.
  const selfNodeRef = useRef<string | null>(null);
  useEffect(() => {
    apiFetch<{ gatewayId?: string | null; data?: { gatewayId?: string | null } }>('/hub/status')
      .then((r) => { selfNodeRef.current = r?.gatewayId ?? r?.data?.gatewayId ?? null; })
      .catch(() => { /* hub unconfigured — leader anchoring is inert, node not needed */ });
  }, [apiFetch]);

  const seqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++seqRef.current; // guard: a slower/older response must not overwrite a newer one
    // Transcript (rich: thinking + tool cards) and the mission-session read run in parallel —
    // the latter is the only surface with native pendingQuestion extraction (jsonl AskUserQuestion
    // + the bridge worker/events fallback for --remote-control sessions). Either may fail alone.
    const [conv, missionRead] = await Promise.allSettled([
      apiFetch<{ messages?: Msg[]; thinkingBlocks?: Think[]; model?: string; numTurns?: number; sessionInfo?: { status?: string } }>(
        `/sessions/${encodeURIComponent(sessionId)}/conversation?lastN=40&toolDetail=full`,
      ),
      apiFetch<{ pendingQuestion?: PendingQuestion | null; data?: { pendingQuestion?: PendingQuestion | null } }>(
        `/mission/session/${encodeURIComponent(sessionId)}/read`,
        { method: 'POST', body: { lastN: 5 } },
      ),
    ]);
    if (seq !== seqRef.current) return; // a newer load started — drop this stale result
    if (conv.status === 'fulfilled') {
      const r = conv.value;
      setMessages(r.messages || []);
      setThinking(r.thinkingBlocks || []);
      setInfo({ model: r.model, numTurns: r.numTurns, status: r.sessionInfo?.status });
      setErr(null);
    } else {
      setErr(conv.reason instanceof Error ? conv.reason.message : String(conv.reason));
    }
    if (missionRead.status === 'fulfilled') {
      const mr = missionRead.value;
      setPendingQ(mr?.pendingQuestion ?? mr?.data?.pendingQuestion ?? null);
    }
    setLoading(false);
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
    try {
      let label = '';
      try {
        // Primary: the mission-session drive — transport-resolving (tmux user turn for a
        // native, cloudDrive for session_/cse_) AND the onboarded rails apply (STANDBY_MODE
        // rejection, ⟦lm-assist⟧ marker auto-prefix).
        await apiFetch(`/mission/session/${encodeURIComponent(sessionId)}/drive`, { method: 'POST', body: { text } });
        label = 'typed into the session (user turn)';
      } catch (e) {
        const { code, message } = parseEnvelopeError(e);
        // Rails are never bypassed: a standby rejection surfaces verbatim, no fallback.
        if (code === 'STANDBY_MODE') throw new Error(message);
        // Only a transport that literally can't deliver (session not in tmux) degrades to the
        // soft context-inject, which lands on the session's NEXT user turn.
        if (!/not in a tmux pane/i.test(message)) throw new Error(message);
        await apiFetch('/session-messages', { method: 'POST', body: { toSession: sessionId, category: 'guided', body: text } });
        label = 'injected (soft) — delivered on the next user turn';
      }
      setVia(label); setPrompt(''); setSent(text.slice(0, 60)); setTimeout(() => setSent(null), 4000); setTimeout(load, 1000);
    } catch (e) { setErr(`drive failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setSending(false); }
  }, [apiFetch, sessionId, prompt, load]);

  // Answer a pending AskUserQuestion — option click sends the label, free text sends the text.
  // Uses the mission-session answer paths (bridge worker/events control_response, else tmux
  // digit/text keys) — NEVER a plain drive, which would queue behind the question.
  const answer = useCallback(async (text: string) => {
    const a = text.trim(); if (!a) return;
    setAnswering(true); setErr(null);
    try {
      await apiFetch(`/mission/session/${encodeURIComponent(sessionId)}/answer`, {
        method: 'POST',
        body: { answer: a, toolUseId: pendingQ?.toolUseId, requestId: pendingQ?.requestId, node: selfNodeRef.current ?? undefined },
      });
      setPendingQ(null); setSent(`answered: ${a.slice(0, 50)}`); setTimeout(() => setSent(null), 4000); setTimeout(load, 1200);
    } catch (e) {
      const { message } = parseEnvelopeError(e);
      setErr(`answer failed: ${message}`);
    } finally { setAnswering(false); }
  }, [apiFetch, sessionId, pendingQ, load]);

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

        {/* Pending AskUserQuestion — answer by clicking an option OR typing a custom reply (both → /answer) */}
        {pendingQ && pendingQ.questions[0] && (
          <ApprovalWidget pending={pendingQ} answering={answering} onAnswer={answer} who="the session" />
        )}

        {/* Input is NEVER hard-gated — same contract as the missions page's MissionSessionChat:
            the /mission/session drive resolves transport server-side (live tmux → user turn;
            not-in-tmux → soft context-inject for the next turn; STANDBY_MODE surfaces). The
            liveness flag only tunes the hint so expectations stay honest. */}
        {!driveable && <div style={{ fontSize: 11, color: 'var(--color-status-orange)' }}>Session looks idle — sends deliver as a soft inject on its next turn; Resume above brings it live for immediate replies.</div>}
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <textarea className="input" value={prompt} rows={2} placeholder="Drive: type a prompt… (Enter to send, Shift+Enter for newline)"
            disabled={sending} style={{ flex: 1, resize: 'none', fontSize: 12.5 }}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <button className="btn btn-primary btn-sm" disabled={sending || !prompt.trim()} onClick={send} title="Send (Enter)">
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
