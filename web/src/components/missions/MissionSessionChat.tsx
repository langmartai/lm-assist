'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2, Send, Wrench, HelpCircle, Eye, EyeOff } from 'lucide-react';
import { filterInjectedExchanges } from '@/lib/injected-message';

// ── Types ──────────────────────────────────────────────────────────────────

interface QOption { label: string; description?: string }
interface PendingQuestion {
  toolUseId: string;
  /** Present for a `--remote-control` (bridge) session: the worker/events control_request id the answer echoes. */
  requestId?: string;
  questions: Array<{ header?: string; question?: string; multiSelect?: boolean; options?: QOption[] }>;
}

export interface SessionMessage {
  role?: string;
  /** Mission session reads (`/mission/session/:sid/read`) return `{ role, text, tools? }`. */
  text?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  type?: string;
  /** Tool names used in this turn (from CloudTranscriptMsg.tools or native toolCalls[].name). */
  tools?: string[];
  [key: string]: unknown;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Resolve a session message to plain text (read API returns {role,text}; other sources use content). */
export function resolveMsgText(msg: SessionMessage): string {
  if (typeof msg.text === 'string') return msg.text;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => (typeof c === 'object' && c?.type === 'text' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Heartbeat = the controller's autonomous-pass noise we hide from the chat so it
 * stays a usable interface: the standing pass directive and ⟦HEARTBEAT⟧ idle replies.
 * Tool-call turns are now shown (as badges) so the user can see what the controller
 * did. A truly empty turn (no text AND no tools) is still dropped.
 */
export function isHeartbeatMsg(msg: SessionMessage): boolean {
  const text = resolveMsgText(msg).trim();
  const hasTools = Array.isArray(msg.tools) && msg.tools.length > 0;
  // Drop truly empty turns (no text and no tools).
  if (!text && !hasTools) return true;
  // Drop the standing pass directive sent every tick.
  if (text.startsWith('Run a controller pass now:')) return true;
  // Drop idle ⟦HEARTBEAT⟧ replies.
  if (text.startsWith('⟦HEARTBEAT⟧')) return true;
  return false;
}

/** Strip the `mcp__<server>__` prefix so a tool reads as just its name (mission_list). */
export function shortToolName(t: string): string {
  return t.replace(/^mcp__.*?__/, '');
}

/** A message's MEANINGFUL text — treats the bare "[N tool call(s)]" placeholder as empty. */
export function meaningfulText(msg: SessionMessage): string {
  const t = resolveMsgText(msg).trim();
  return /^\[\d+ tool call\(s\)\]$/.test(t) ? '' : resolveMsgText(msg);
}

/**
 * A run of tool calls renders as ONE minimal line (the tool names) and expands
 * on click to the full badge list — so consecutive tool calls between messages
 * don't sprawl the chat.
 */
export function ToolGroupLine({ tools }: { tools: string[] }) {
  const [open, setOpen] = useState(false);
  if (!tools.length) return null;
  const names = tools.map(shortToolName);
  const preview = names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : '');
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '82%', margin: '1px 0' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={open ? 'collapse tool calls' : 'expand tool calls'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', padding: '1px 2px', fontSize: 10.5, color: 'var(--color-text-tertiary)' }}
      >
        <span style={{ fontSize: 8, width: 8 }}>{open ? '▾' : '▸'}</span>
        <Wrench size={10} />
        <span>{open ? `${tools.length} tool call${tools.length > 1 ? 's' : ''}` : preview}</span>
      </button>
      {open && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3, paddingLeft: 6 }}>
          {names.map((t, ti) => (
            <span key={ti} className="badge badge-outline" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5 }}>
              <Wrench size={10} /> {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

interface MissionSessionChatProps {
  /** Session id to read/drive (local or cse_ / session_). */
  sid: string;
  /**
   * The node that owns this session.  Passed in the read/drive request bodies
   * so the local Core server-side proxies to the right host — same pattern as
   * the controller chat (`{ lastN, node }` / `{ text, node }`).
   */
  node?: string;
  /**
   * The same apiFetch already built by MissionsPage (`apiClient.fetchPath`-
   * based).  Accepted as a prop so this component is self-contained and the
   * caller never needs to re-build auth state.
   */
  apiFetch: <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
  /**
   * When true the chat area fills all available vertical space (flex: 1).
   * Defaults to false which gives a fixed 360 px max-height scrollable area.
   */
  heightFill?: boolean;
  /**
   * Optional prefix prepended to every message the user SENDS (the drive/send
   * composer only — NOT the answer path).  Used by the mission detail tab so the
   * controller knows a chat message is about a specific mission
   * (e.g. `[mission ms-abc "Title"] `).
   */
  missionTag?: string;
}

type ChatGroup =
  | { kind: 'msg'; msg: SessionMessage; text: string }
  | { kind: 'tools'; tools: string[] };

function buildChatGroups(messages: SessionMessage[]): ChatGroup[] {
  const groups: ChatGroup[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length) {
      groups.push({ kind: 'tools', tools: pending });
      pending = [];
    }
  };
  for (const msg of messages) {
    const t = meaningfulText(msg);
    const tools = Array.isArray(msg.tools) ? msg.tools : [];
    if (!t && tools.length) {
      pending.push(...tools);
      continue;
    }
    flush();
    groups.push({ kind: 'msg', msg, text: t });
    if (tools.length) pending.push(...tools);
  }
  flush();
  return groups;
}

export function MissionSessionChat({ sid, node, apiFetch, heightFill = false, missionTag }: MissionSessionChatProps) {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingQ, setPendingQ] = useState<PendingQuestion | null>(null);
  const [answering, setAnswering] = useState(false);
  const [customAnswer, setCustomAnswer] = useState('');
  const [hideInjected, setHideInjected] = useState(true); // "Only user ↔ assistant" — default ON
  const pollerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // ── Read ──

  const readMessages = useCallback(async () => {
    try {
      const res = await apiFetch<{
        data?: { messages: SessionMessage[]; pendingQuestion?: PendingQuestion | null };
        messages?: SessionMessage[];
        pendingQuestion?: PendingQuestion | null;
      }>(
        `/mission/session/${encodeURIComponent(sid)}/read`,
        { method: 'POST', body: { lastN: 30, node: node ?? undefined } },
      );
      const msgs = (res as any).data?.messages ?? (res as any).messages ?? [];
      const pq: PendingQuestion | null = (res as any).data?.pendingQuestion ?? (res as any).pendingQuestion ?? null;
      setMessages(msgs);
      setPendingQ(pq);
      // Auto-scroll to bottom
      setTimeout(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      }, 50);
    } catch {
      // silently ignore — keep last messages
    }
  }, [apiFetch, sid, node]);

  // Start poller when sid/node change
  useEffect(() => {
    // Initial read
    readMessages();
    // Poll every 4 s
    if (pollerRef.current) clearInterval(pollerRef.current);
    pollerRef.current = setInterval(readMessages, 4000);
    return () => {
      if (pollerRef.current) {
        clearInterval(pollerRef.current);
        pollerRef.current = null;
      }
    };
  }, [readMessages]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollerRef.current) clearInterval(pollerRef.current);
    };
  }, []);

  // ── Drive ──

  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setSendBusy(true);
    setSendError(null);
    try {
      await apiFetch(
        `/mission/session/${encodeURIComponent(sid)}/drive`,
        { method: 'POST', body: { text: (missionTag ?? '') + text, node: node ?? undefined } },
      );
      setDraft('');
      // Poll immediately after send
      setTimeout(() => readMessages(), 600);
    } catch (e) {
      const raw = (e as Error)?.message || '';
      let msg = raw;
      const m = raw.match(/\{.*\}/s);
      if (m) {
        try { msg = JSON.parse(m[0])?.error?.message || raw; } catch { /* keep raw */ }
      }
      setSendError(msg || 'Send failed — session may be busy. Retry.');
    } finally {
      setSendBusy(false);
    }
  }, [apiFetch, sid, node, draft, readMessages, missionTag]);

  // ── Answer a pending AskUserQuestion ──

  const answerQuestion = useCallback(async (text: string) => {
    const a = text.trim();
    if (!a || !pendingQ) return;
    setAnswering(true);
    setSendError(null);
    try {
      await apiFetch(`/mission/session/${encodeURIComponent(sid)}/answer`, {
        method: 'POST',
        body: { answer: a, toolUseId: pendingQ.toolUseId, requestId: pendingQ.requestId, node: node ?? undefined },
      });
      setPendingQ(null);
      setCustomAnswer('');
      setTimeout(() => readMessages(), 600);
    } catch (e) {
      const raw = (e as Error)?.message || '';
      let msg = raw;
      const m = raw.match(/\{.*\}/s);
      if (m) {
        try { msg = JSON.parse(m[0])?.error?.message || raw; } catch { /* keep raw */ }
      }
      setSendError(msg || 'Answer failed — please retry.');
    } finally {
      setAnswering(false);
    }
  }, [apiFetch, sid, node, pendingQ, readMessages]);

  // ── Derived render data ──

  // Always drop truly-empty turns (no text AND no tools); tool-only turns stay
  // (shown as badges). The "Only user ↔ assistant" toggle additionally hides
  // lm-assist-injected scaffolding (worker-status / heartbeat / bootstrap / the
  // standing controller-pass directive) — subsuming the old heartbeat filter.
  const nonEmptyMessages = messages.filter((m) => {
    const hasText = resolveMsgText(m).trim().length > 0;
    const hasTools = Array.isArray(m.tools) && m.tools.length > 0;
    return hasText || hasTools;
  });
  // Span-aware: hides each injected directive AND the assistant turns that respond
  // to it (a reply to a hidden controller-pass prompt is noise), not just the
  // directive itself. A genuine `[mission …]` user turn keeps its responses.
  const visibleMessages = hideInjected
    ? filterInjectedExchanges(nonEmptyMessages, resolveMsgText)
    : nonEmptyMessages;
  const injectedHiddenCount = nonEmptyMessages.length - visibleMessages.length;
  const chatGroups = buildChatGroups(visibleMessages);

  // ── Render ──

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: heightFill ? '1 1 0' : undefined, overflow: 'hidden', minHeight: 0 }}>
      {/* Toolbar: "Only user ↔ assistant" filter (default ON — hides injected scaffolding) */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '6px 16px 0', flexShrink: 0 }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setHideInjected((v) => !v)}
          title={hideInjected ? 'Showing only user ↔ assistant — click to show injected turns' : 'Showing all turns — click to hide injected'}
          style={{ gap: 4, fontSize: 10.5 }}
        >
          {hideInjected ? <EyeOff size={11} /> : <Eye size={11} />} Only user ↔ assistant
        </button>
      </div>

      {/* Transcript */}
      <div
        ref={scrollRef}
        style={{
          flex: heightFill ? 1 : undefined,
          maxHeight: heightFill ? undefined : 360,
          overflow: 'auto',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          minHeight: 0,
        }}
      >
        {visibleMessages.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', textAlign: 'center', padding: '16px 0' }}>
            {injectedHiddenCount > 0
              ? 'Session is running idle background passes — send a message to give it work.'
              : 'No messages yet'}
          </div>
        )}

        {chatGroups.map((g, i) => {
          if (g.kind === 'tools') return <ToolGroupLine key={`t${i}`} tools={g.tools} />;
          const msg = g.msg;
          const text = g.text;
          const msgRole = (msg.role as string) ?? (msg.type as string) ?? 'msg';
          const isUser = msgRole === 'user';
          const isAssistant = msgRole === 'assistant';
          return (
            <div
              key={`m${i}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: isUser ? 'flex-end' : 'flex-start',
                gap: 2,
              }}
            >
              <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                {isUser ? 'you' : isAssistant ? 'controller' : msgRole}
              </span>
              <div
                style={{
                  maxWidth: '82%',
                  padding: '6px 10px',
                  borderRadius: 'var(--radius-md)',
                  background: isUser
                    ? 'var(--color-accent)'
                    : 'var(--color-bg-elevated)',
                  color: isUser
                    ? '#fff'
                    : 'var(--color-text-primary)',
                  fontSize: 12,
                  lineHeight: 1.5,
                  wordBreak: 'break-word',
                  border: isUser ? 'none' : '1px solid var(--color-border-subtle)',
                }}
              >
                {text ? (
                  <div className="prose" style={{ fontSize: 12, lineHeight: 1.5 }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                  </div>
                ) : (
                  <span style={{ color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>(no text)</span>
                )}
              </div>
            </div>
          );
        })}

        {injectedHiddenCount > 0 && (
          <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', textAlign: 'center', padding: '4px 0', fontStyle: 'italic' }}>
            · {injectedHiddenCount} injected message{injectedHiddenCount === 1 ? '' : 's'} hidden ·
          </div>
        )}
      </div>

      {/* Composer */}
      <div
        style={{
          padding: '10px 16px',
          borderTop: '1px solid var(--color-border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          flexShrink: 0,
          background: 'var(--color-bg-root)',
        }}
      >
        {/* Pending AskUserQuestion — answer by clicking an option OR typing a custom reply */}
        {pendingQ && pendingQ.questions[0] && (
          <div style={{ border: '1px solid var(--color-accent)', borderRadius: 'var(--radius-md)', padding: 8, marginBottom: 4, background: 'var(--color-bg-elevated)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>
              <HelpCircle size={13} style={{ color: 'var(--color-accent)' }} />
              {pendingQ.questions[0].header || 'Question'} — session is waiting on you
            </div>
            {pendingQ.questions[0].question && (
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                {pendingQ.questions[0].question}
              </div>
            )}
            {(pendingQ.questions[0].options || []).length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
                {(pendingQ.questions[0].options || []).map((o) => (
                  <button
                    key={o.label}
                    className="btn btn-ghost btn-sm"
                    disabled={answering}
                    onClick={() => answerQuestion(o.label)}
                    style={{ justifyContent: 'flex-start', textAlign: 'left', height: 'auto', padding: '6px 10px', whiteSpace: 'normal' }}
                    title={o.description}
                  >
                    <span style={{ fontWeight: 600 }}>{o.label}</span>
                    {o.description ? <span style={{ color: 'var(--color-text-tertiary)', fontSize: 11 }}> — {o.description}</span> : null}
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                className="input"
                value={customAnswer}
                placeholder="…or type your own answer"
                disabled={answering}
                style={{ flex: 1, fontSize: 12 }}
                onChange={(e) => setCustomAnswer(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); answerQuestion(customAnswer); } }}
              />
              <button
                className="btn btn-primary btn-sm"
                disabled={answering || !customAnswer.trim()}
                onClick={() => answerQuestion(customAnswer)}
                title="Send custom answer"
              >
                {answering ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : 'Send'}
              </button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            className="input"
            value={draft}
            rows={3}
            placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
            style={{ flex: 1, resize: 'vertical', fontSize: 12 }}
            onChange={(e) => {
              setDraft(e.target.value);
              if (sendError) setSendError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={sendMessage}
            disabled={sendBusy || !draft.trim()}
            title="Send (Enter)"
            style={{ height: 'auto', alignSelf: 'stretch', display: 'flex', alignItems: 'center', gap: 4 }}
          >
            {sendBusy ? (
              <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
            ) : (
              <Send size={13} />
            )}
            Send
          </button>
        </div>
        {sendError && (
          <div style={{ fontSize: 11, color: 'var(--color-status-red, #e5484d)', paddingTop: 2 }}>
            {sendError}
          </div>
        )}
      </div>
    </div>
  );
}
