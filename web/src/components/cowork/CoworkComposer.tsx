'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Mic, Plus, Send } from 'lucide-react';
import { ModelEffortSelector } from './ModelEffortSelector';
import { AttachmentTray } from './AttachmentTray';
import { useAttachments, type CoworkAttachmentRef } from './useAttachments';

export type { CoworkAttachmentRef } from './useAttachments';

type ApprovalMode = 'manual' | 'skip';

const APPROVAL_OPTIONS: Array<{ id: ApprovalMode; label: string; desc: string }> = [
  { id: 'manual', label: 'Manually approve', desc: 'Claude pauses so you can approve each action' },
  { id: 'skip', label: 'Skip all approvals', desc: 'Claude never pauses, even for unsafe actions' },
];

/** claude.ai-look-alike home composer. Owns local draft state (prompt/model/effort/
 *  approvalMode) plus the attachment tray (via useAttachments). Files upload through
 *  `onUpload` (→ core /cowork/attachments) and their refs are passed to `onCreate`.
 *  Approval mode is NOT sent (Spec 1).
 *
 *  The `Chat | Cowork` segmented toggle is functional: the active segment is `mode`,
 *  and clicking a segment calls `onModeChange`. `onCreate` is called the SAME way in
 *  both modes — the PAGE decides chat-vs-cowork from `mode` (chat ignores `effort`/
 *  `attachments`; home-composer attachments are Cowork-only in v1, so the `+` tray is
 *  hidden in Chat mode — chat attachments live in ChatView). */
export function CoworkComposer({ onCreate, onUpload, busy, mode, onModeChange }: {
  onCreate: (opts: { prompt: string; model: string; effort: string; attachments?: CoworkAttachmentRef[] }) => Promise<void> | void;
  onUpload: (file: File) => Promise<CoworkAttachmentRef>;
  busy: boolean;
  mode: 'chat' | 'cowork';
  onModeChange: (m: 'chat' | 'cowork') => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('claude-sonnet-5');
  const [effort, setEffort] = useState('medium');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('manual');
  const [manualMenuOpen, setManualMenuOpen] = useState(false);
  const att = useAttachments(onUpload);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const manualMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-height textarea — grow with content, no resize handle (matches captured composer).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [prompt]);

  // Close the Manual ▾ menu on outside click / Escape (idiom copied from MachineDropdown.tsx).
  useEffect(() => {
    if (!manualMenuOpen) return;
    function handleMouseDown(e: MouseEvent) {
      if (manualMenuRef.current && !manualMenuRef.current.contains(e.target as Node)) setManualMenuOpen(false);
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [manualMenuOpen]);
  useEffect(() => {
    if (!manualMenuOpen) return;
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setManualMenuOpen(false); }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [manualMenuOpen]);

  const canSend = (prompt.trim().length > 0 || att.hasReady) && !busy && !att.uploading;

  const send = () => {
    if (!canSend) return;
    const refs = att.refs();
    void Promise.resolve(onCreate({ prompt: prompt.trim(), model, effort, attachments: refs.length ? refs : undefined }));
    setPrompt('');
    att.reset();
  };

  const approvalLabel = APPROVAL_OPTIONS.find((o) => o.id === approvalMode)?.label ?? 'Manually approve';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, width: '100%', maxWidth: 720, margin: '0 auto' }}>
      <h1 style={{ fontSize: 26, fontWeight: 600, color: 'var(--color-text-primary)', textAlign: 'center' }}>
        How can I help you today?
      </h1>

      <div className="card" style={{ width: '100%', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {mode === 'cowork' && <AttachmentTray items={att.items} onRemove={att.remove} />}

        <textarea
          ref={textareaRef}
          className="input"
          value={prompt}
          placeholder="How can I help you today?"
          disabled={busy}
          rows={1}
          style={{
            border: 'none', background: 'none', resize: 'none', overflow: 'hidden',
            fontSize: 14, padding: '6px 4px', minHeight: 28,
          }}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
        />

        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => { att.addFiles(e.target.files); e.target.value = ''; }}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Attachments are Cowork-only from the home composer in v1 — hide the tray + `+` in Chat mode. */}
          {mode === 'cowork' && (
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              disabled={busy}
              title="Add files or photos"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus size={14} />
            </button>
          )}

          {/* Chat | Cowork segmented toggle — the active segment is `mode`; clicking switches the whole page. */}
          <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-md)', padding: 2, gap: 2 }}>
            {(['chat', 'cowork'] as const).map((m) => {
              const active = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onModeChange(m)}
                  style={{
                    padding: '3px 10px', borderRadius: 'var(--radius-sm)', border: 'none',
                    background: active ? 'var(--color-accent-glow)' : 'none',
                    color: active ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
                    fontSize: 11.5, fontWeight: active ? 600 : 500, fontFamily: 'var(--font-sans)',
                    cursor: active ? 'default' : 'pointer',
                  }}
                >
                  {m === 'chat' ? 'Chat' : 'Cowork'}
                </button>
              );
            })}
          </div>

          <div style={{ flex: 1 }} />

          <ModelEffortSelector model={model} effort={effort} onChange={(m, e) => { setModel(m); setEffort(e); }} />

          <Mic size={14} style={{ color: 'var(--color-text-tertiary)', opacity: 0.6, cursor: 'not-allowed' }} aria-hidden />

          <button
            type="button"
            className="btn btn-primary btn-sm btn-icon"
            disabled={!canSend}
            onClick={send}
            title={att.uploading ? 'Waiting for uploads…' : 'Send (⌘/Ctrl+Enter)'}
            style={!canSend ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
          >
            <Send size={14} />
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled
          title="Projects — coming soon"
          style={{ opacity: 0.4, cursor: 'not-allowed' }}
        >
          Project <ChevronDown size={12} />
        </button>

        <div ref={manualMenuRef} style={{ position: 'relative' }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setManualMenuOpen((v) => !v)}
            aria-expanded={manualMenuOpen}
          >
            {approvalLabel} <ChevronDown size={12} style={{ transition: 'transform 200ms ease', transform: manualMenuOpen ? 'rotate(180deg)' : undefined }} />
          </button>

          {manualMenuOpen && (
            <div
              style={{
                position: 'absolute', top: 'calc(100% + 6px)', left: 0, minWidth: 260,
                background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-md)', boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
                zIndex: 60, padding: 4,
              }}
            >
              {APPROVAL_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => { setApprovalMode(o.id); setManualMenuOpen(false); }}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', textAlign: 'left',
                    padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: 'none',
                    background: o.id === approvalMode ? 'var(--color-accent-glow)' : 'none',
                    cursor: 'pointer', fontFamily: 'var(--font-sans)',
                  }}
                  onMouseEnter={(e) => { if (o.id !== approvalMode) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)'; }}
                  onMouseLeave={(e) => { if (o.id !== approvalMode) e.currentTarget.style.background = 'none'; }}
                >
                  <span style={{ fontSize: 12.5, fontWeight: 500, color: o.id === approvalMode ? 'var(--color-accent)' : 'var(--color-text-primary)' }}>{o.label}</span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{o.desc}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ flex: 1 }} />

        <span className="badge badge-outline">Beta</span>
      </div>
    </div>
  );
}
