'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, PhoneOff, RefreshCw, ShieldAlert, Square } from 'lucide-react';
import { ModelEffortSelector } from '@/components/cowork/ModelEffortSelector';
import { ConnectorCard } from './ConnectorCard';
import { ApprovalPrompt } from './ApprovalPrompt';
import { useClaudeVoice, type VoiceState } from '@/hooks/useClaudeVoice';

const STATUS: Record<VoiceState, { label: string; color: string; pulse: boolean }> = {
  idle: { label: 'Idle', color: 'var(--color-text-tertiary)', pulse: false },
  connecting: { label: 'Connecting…', color: 'var(--color-status-blue)', pulse: true },
  listening: { label: 'Listening…', color: 'var(--color-status-green)', pulse: true },
  thinking: { label: 'Thinking…', color: 'var(--color-status-purple)', pulse: true },
  speaking: { label: 'Speaking…', color: 'var(--color-accent)', pulse: true },
  reconnect: { label: 'Reconnecting…', color: 'var(--color-status-yellow)', pulse: true },
  error: { label: 'Voice error', color: 'var(--color-status-red)', pulse: false },
};

/**
 * Full-screen bidirectional voice conversation over an existing claude.ai chat
 * (`conversationUuid`) — the /cowork "voice mode", alongside (not replacing) the
 * dictation `MicButton`/mic in `ChatView`. Mounted/unmounted by ChatView's
 * voice-mode toggle; portal-rendered to `document.body` like `FullScreenOverlay`
 * so it covers the whole page while open.
 *
 * Owns its own effort/thinking as local state (ChatView only tracks `model`,
 * shared back via `onModelChange` so the text composer stays in sync). A live
 * voice turn's params are fixed at connect — `useClaudeVoice.start()` is a no-op
 * once a session is active — so picking a new model/effort/thinking mid-call only
 * takes effect on the NEXT `start()`; the "Applies on next start" label by the
 * selector says so rather than implying a live switch that doesn't happen. The
 * selector lives in the FOOTER, not the header — its popover opens upward
 * (`bottom: 100%`) and would clip against the viewport top up there.
 *
 * `tool_use`/`connector_text` (Plan B): `useClaudeVoice`'s `tools`/`connectorTexts`/
 * `pendingApprovals`/`mcpAuth` (sourced from the demux's typed classification of the
 * connector/MCP loop, `claude-voice-demux.ts`) render below as, respectively,
 * `ConnectorCard`s, styled transcript blocks, `ApprovalPrompt`s wired to `approve`/
 * `denyApproval`, and an informational "needs authorization" notice (v1 — the actual
 * auth flow happens on claude.ai, not here). `passthrough` (still-unclassified frames)
 * has no consumer yet and stays unread.
 */
export function ClaudeVoiceOverlay({
  conversationUuid,
  model,
  onModelChange,
  isRemoteNode,
  onClose,
}: {
  conversationUuid: string;
  model: string;
  onModelChange: (model: string) => void;
  isRemoteNode: boolean;
  onClose: () => void;
}) {
  const [effort, setEffort] = useState('medium');
  const [thinking, setThinking] = useState('off');

  const {
    state,
    transcript,
    assistantText,
    liveModel,
    tools,
    connectorTexts,
    pendingApprovals,
    mcpAuth,
    start,
    stop,
    interrupt,
    approve,
    denyApproval,
  } = useClaudeVoice({
    conversationUuid,
    model,
    effort,
    thinkingMode: thinking,
    isRemoteNode,
  });

  // Auto-start on open (the brief allows either; auto-start reads as "answering the
  // call" the moment the overlay appears). Unmount always releases the mic/socket —
  // Exit below also calls stop() explicitly so the mic drops the instant the user
  // clicks it rather than waiting on React's unmount timing. Mount-once by design:
  // `start`/`stop` close over the CURRENT model/effort/thinking, and re-running this
  // on every identity change (effort/thinking edits) would fight the "next start()"
  // contract described above.
  useEffect(() => {
    start();
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { stop(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stop, onClose]);

  // Lock page scroll while the overlay covers the viewport (matches FullScreenOverlay).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // SSR guard — portals need a document.
  if (typeof document === 'undefined') return null;

  const status = STATUS[state];
  const canRetry = state === 'error' || state === 'reconnect';
  const canInterrupt = state === 'listening' || state === 'thinking' || state === 'speaking';
  const handleExit = () => { stop(); onClose(); };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Voice conversation"
      style={{ position: 'fixed', inset: 0, zIndex: 9995, background: 'var(--color-bg-root)', display: 'flex', flexDirection: 'column' }}
    >
      {/* Header */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-border-subtle)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <AudioLines size={16} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', flex: 1, minWidth: 0 }}>Voice conversation</div>
        <button className="btn btn-ghost btn-sm" onClick={handleExit} title="Exit voice conversation (Esc)">
          <PhoneOff size={13} /> Exit
        </button>
      </div>

      {/* Status */}
      <div style={{ padding: '10px 16px 0', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span className="status-dot" style={{ background: status.color, animation: status.pulse ? 'pulse-dot 2s ease-in-out infinite' : undefined }} />
        <span style={{ fontSize: 12.5, color: status.color }}>{status.label}</span>
        {liveModel && <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>· live model: {liveModel}</span>}
        {canRetry && (
          // stop() first, not just start(): start()'s guard only proceeds from
          // 'idle'/'error' (useClaudeVoice.ts), so a bare start() silently no-ops from
          // 'reconnect' — exactly the state this button exists to recover from. stop()
          // synchronously resets stateRef to 'idle' (the whole reason that ref mirror
          // exists), so the immediately-following start() sees 'idle' and proceeds,
          // reusing the same conversationUuid to resume the same conversation.
          <button className="btn btn-ghost btn-sm" onClick={() => { stop(); start(); }} style={{ marginLeft: 4 }}>
            <RefreshCw size={12} /> {state === 'error' ? 'Retry' : 'Reconnect'}
          </button>
        )}
      </div>

      {/* Live transcript + assistant text */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 16px 16px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Approvals surface first — they block the conversation until answered, so they
            shouldn't require scrolling to find. */}
        {pendingApprovals.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pendingApprovals.map((req, i) => (
              <ApprovalPrompt
                key={req.toolUseId || i}
                req={req}
                onApprove={(option) => approve(req.toolUseId, option)}
                onDeny={() => denyApproval(req.toolUseId)}
              />
            ))}
          </div>
        )}

        {/* mcp_auth_required / mcp_elicitation — v1 is informational only (design §7); the
            actual auth flow happens on claude.ai, not here. */}
        {mcpAuth.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {mcpAuth.map((auth, i) => (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                  border: '1px solid var(--color-status-yellow)', borderRadius: 'var(--radius-md)',
                  background: 'var(--color-bg-elevated)', padding: '8px 10px',
                  fontSize: 12, lineHeight: 1.4, color: 'var(--color-text-secondary)',
                }}
              >
                <ShieldAlert size={13} style={{ color: 'var(--color-status-yellow)', flexShrink: 0, marginTop: 1 }} />
                <span>
                  {auth.integrationName ? `${auth.integrationName} needs authorization` : 'A connector needs authorization'}
                  {auth.message ? ` — ${auth.message}` : ''}
                  {auth.serverUrl && (
                    <>
                      <br />
                      <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{auth.serverUrl}</span>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {tools.length > 0 && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Tools</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {tools.map((tool, i) => <ConnectorCard key={tool.id || i} tool={tool} />)}
            </div>
          </div>
        )}

        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>You</div>
          <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--color-text-primary)', minHeight: 20, whiteSpace: 'pre-wrap' }}>
            {transcript || <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>}
          </div>
        </div>

        {connectorTexts.length > 0 && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Connector</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {connectorTexts.map((text, i) => (
                <div key={i} style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--color-text-primary)', whiteSpace: 'pre-wrap' }}>{text}</div>
              ))}
            </div>
          </div>
        )}

        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Claude</div>
          <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--color-text-primary)', minHeight: 20, whiteSpace: 'pre-wrap' }}>
            {assistantText || <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>}
          </div>
        </div>
      </div>

      {/* Controls — ModelEffortSelector's popover opens UPWARD (bottom: 100%), so it
          lives down here (room to open into the transcript area above), not in the
          header where it would clip against the viewport top. */}
      <div style={{ borderTop: '1px solid var(--color-border-subtle)', flexShrink: 0 }}>
        {/* ONE row: the actions sit on the SAME line as the next-start selectors rather
            than stacking into a second row (the stacked layout wasted a whole line of
            vertical space in a panel whose transcript is the thing worth showing). */}
        <div style={{ padding: '8px 16px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary btn-sm" disabled={!canInterrupt} onClick={interrupt} title="Interrupt Claude">
            <Square size={13} /> Interrupt
          </button>
          <button className="btn btn-ghost btn-sm" onClick={handleExit} title="Exit voice conversation">
            <PhoneOff size={13} /> Exit
          </button>
          <div style={{ flex: 1, minWidth: 8 }} />
          <span style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>Applies on next start:</span>
          <ModelEffortSelector
            model={model}
            effort={effort}
            thinking={thinking}
            onChange={(m, e, t) => { onModelChange(m); setEffort(e); if (t !== undefined) setThinking(t); }}
            hideThinking={false}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
