'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Cloud, RefreshCw, Send, Plus, X, ChevronDown, ChevronRight, MoreHorizontal, Loader2,
} from 'lucide-react';
import { useLiveTranscript } from '@/hooks/useLiveTranscript';
import { TranscriptMessage } from '@/components/shared/TranscriptMessage';
import { ApprovalWidget } from '@/components/shared/ApprovalWidget';
import { ModelEffortSelector } from '@/components/cowork/ModelEffortSelector';
import { CoworkRightRail } from '@/components/cowork/CoworkRightRail';
import { AttachmentTray } from '@/components/cowork/AttachmentTray';
import { useAttachments, type CoworkAttachmentRef } from '@/components/cowork/useAttachments';

type ApiFetch = <T>(path: string, o?: { method?: string; body?: unknown }) => Promise<T>;

type ApprovalMode = 'manual' | 'skip';
const APPROVAL_OPTIONS: Array<{ id: ApprovalMode; label: string; desc: string }> = [
  { id: 'manual', label: 'Manually approve', desc: 'Claude pauses so you can approve each action' },
  { id: 'skip', label: 'Skip all approvals', desc: 'Claude never pauses, even for unsafe actions' },
];

interface TitleMenuItem { id: string; label: string; disabled?: boolean; danger?: boolean }
const TITLE_MENU_ITEMS: TitleMenuItem[] = [
  { id: 'rename', label: 'Rename' },
  { id: 'archive', label: 'Archive' },
  { id: 'pin', label: 'Pin' },
  { id: 'delete', label: 'Delete', danger: true },
  { id: 'schedule', label: 'Schedule', disabled: true },
  { id: 'skill', label: 'Turn into skill', disabled: true },
  { id: 'project', label: 'Add to project', disabled: true },
];

/** claude.ai-look-alike Cowork task-detail view: live transcript + approvals (center),
 *  progress/outputs/context (right rail), in-task composer (bottom), and a title▾
 *  manage menu (rename/archive/pin/delete — active; schedule/skill/project — disabled)
 *  in the header. Composes useLiveTranscript (Task 9) + TranscriptMessage/ApprovalWidget
 *  (Task 6) + ModelEffortSelector (Task 8) + CoworkRightRail (this task). Every handler
 *  is thin: one apiFetch call then refresh(). */
export function CoworkTaskView({ sid, apiFetch, onUpload, streamUrl, isRemoteNode, onClose, onDeleted }: {
  sid: string;
  apiFetch: ApiFetch;
  onUpload: (file: File) => Promise<CoworkAttachmentRef>;
  streamUrl: string | null;
  isRemoteNode: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [live, setLive] = useState(true);
  const [railOpen, setRailOpen] = useState(true);

  const { detail, err, gone, refresh } = useLiveTranscript({
    sid, apiFetch, detailPath: `/cowork/tasks/${sid}`, streamUrl, isRemoteNode, live,
  });

  // Bottom in-task composer draft state.
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const att = useAttachments(onUpload);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [answering, setAnswering] = useState(false);
  const [model, setModel] = useState(detail?.model || 'claude-sonnet-5');
  const [effort, setEffort] = useState('medium');
  // Seed the model once the first detail load resolves it (display/parity only — Spec 1
  // drive does not change the task's actual model).
  const seededModelRef = useRef(false);
  useEffect(() => {
    if (!seededModelRef.current && detail?.model) { setModel(detail.model); seededModelRef.current = true; }
  }, [detail?.model]);

  // Local "Manual ▾" approval-mode menu — display only, not sent (matches CoworkComposer).
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('manual');
  const [manualMenuOpen, setManualMenuOpen] = useState(false);
  const manualMenuRef = useRef<HTMLDivElement>(null);
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

  // Header title▾ menu — outside-click + Escape (idiom copied from CoworkComposer.tsx).
  const [titleMenuOpen, setTitleMenuOpen] = useState(false);
  const titleMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!titleMenuOpen) return;
    function handleMouseDown(e: MouseEvent) {
      if (titleMenuRef.current && !titleMenuRef.current.contains(e.target as Node)) setTitleMenuOpen(false);
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [titleMenuOpen]);
  useEffect(() => {
    if (!titleMenuOpen) return;
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setTitleMenuOpen(false); }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [titleMenuOpen]);

  // Inline rename — clicking Rename swaps the header title for a text input.
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  // Inline delete confirm (NOT window.confirm) — "Delete this task? [Delete] [Cancel]".
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [manageErr, setManageErr] = useState<string | null>(null);
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);

  // Bottom-stick scroll (idiom copied from CcrCloudView.tsx).
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  useEffect(() => { const el = scrollRef.current; if (el && atBottomRef.current) el.scrollTop = el.scrollHeight; });

  const handleDrive = async () => {
    const t = prompt.trim();
    const refs = att.refs();
    if (!t && !refs.length) return;
    setSending(true);
    try {
      await apiFetch(`/cowork/tasks/${sid}/events`, { method: 'POST', body: { text: t, attachments: refs.length ? refs : undefined } });
      setPrompt('');
      att.reset();
      refresh();
    } catch (e) {
      setManageErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const handleAnswer = async (answer: string) => {
    setAnswering(true);
    try {
      await apiFetch(`/cowork/tasks/${sid}/answer`, { method: 'POST', body: { answer, toolUseId: detail?.pendingQuestion?.toolUseId } });
      refresh();
    } catch (e) {
      setManageErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAnswering(false);
    }
  };

  const handleArchive = async () => {
    setTitleMenuOpen(false);
    try {
      await apiFetch(`/cowork/tasks/${sid}/archive`, { method: 'POST', body: { archived: true } });
      onClose();
    } catch (e) {
      setManageErr(e instanceof Error ? e.message : String(e));
    }
  };

  const handlePin = async () => {
    setTitleMenuOpen(false);
    try {
      await apiFetch(`/cowork/tasks/${sid}/pin`, { method: 'POST', body: { pinned: true } });
      refresh();
    } catch (e) {
      setManageErr(e instanceof Error ? e.message : String(e));
    }
  };

  const startRename = () => {
    setTitleMenuOpen(false);
    setRenameValue(detail?.title || sid);
    setRenaming(true);
  };

  const commitRename = async () => {
    const title = renameValue.trim();
    if (!title) { setRenaming(false); return; }
    setRenameBusy(true);
    try {
      await apiFetch(`/cowork/tasks/${sid}/rename`, { method: 'POST', body: { title } });
      setRenaming(false);
      refresh();
    } catch (e) {
      setManageErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRenameBusy(false);
    }
  };

  const armDelete = () => {
    setTitleMenuOpen(false);
    setDeleteArmed(true);
  };

  const confirmDelete = async () => {
    setDeleteBusy(true);
    try {
      await apiFetch(`/cowork/tasks/${sid}`, { method: 'DELETE' });
      onDeleted();
    } catch (e) {
      setManageErr(e instanceof Error ? e.message : String(e));
      setDeleteBusy(false);
      setDeleteArmed(false);
    }
  };

  const handleDownload = (file: string) => {
    // The outputs endpoint is a 501 stub in Spec 1 — don't actually fetch it, just
    // surface a transient "coming soon" notice.
    setDownloadNotice(`"${file}" — download coming soon`);
    setTimeout(() => setDownloadNotice(null), 4000);
  };

  const canSend = (prompt.trim().length > 0 || att.hasReady) && !sending && !att.uploading;
  const approvalLabel = APPROVAL_OPTIONS.find((o) => o.id === approvalMode)?.label ?? 'Manually approve';

  return (
    <div className="card" style={{ padding: 0, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Cloud size={14} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />

        {renaming ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
            <input
              className="input"
              autoFocus
              value={renameValue}
              disabled={renameBusy}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); }
              }}
              style={{ flex: 1, fontSize: 13, padding: '4px 8px' }}
            />
            <button className="btn btn-primary btn-sm" disabled={renameBusy || !renameValue.trim()} onClick={commitRename}>Save</button>
            <button className="btn btn-ghost btn-sm" disabled={renameBusy} onClick={() => setRenaming(false)}>Cancel</button>
          </div>
        ) : (
          <span className="truncate" style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', flex: 1, minWidth: 0 }}>
            {detail?.title || sid}
          </span>
        )}

        {!renaming && (
          <div ref={titleMenuRef} style={{ position: 'relative', flexShrink: 0 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setTitleMenuOpen((v) => !v)}
              aria-expanded={titleMenuOpen}
              title="Task options"
            >
              <MoreHorizontal size={13} /> <ChevronDown size={11} style={{ transition: 'transform 200ms ease', transform: titleMenuOpen ? 'rotate(180deg)' : undefined }} />
            </button>

            {titleMenuOpen && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 6px)', right: 0, minWidth: 200,
                background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-md)', boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
                zIndex: 60, padding: 4,
              }}>
                {TITLE_MENU_ITEMS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    disabled={item.disabled}
                    title={item.disabled ? 'Coming soon' : undefined}
                    onClick={() => {
                      if (item.disabled) return;
                      if (item.id === 'rename') startRename();
                      else if (item.id === 'archive') handleArchive();
                      else if (item.id === 'pin') handlePin();
                      else if (item.id === 'delete') armDelete();
                    }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '6px 10px', borderRadius: 'var(--radius-sm)', border: 'none', background: 'none',
                      color: item.disabled ? 'var(--color-text-tertiary)' : (item.danger ? 'var(--color-status-red)' : 'var(--color-text-primary)'),
                      opacity: item.disabled ? 0.5 : 1,
                      cursor: item.disabled ? 'not-allowed' : 'pointer',
                      fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 500,
                    }}
                    onMouseEnter={(e) => { if (!item.disabled) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)'; }}
                    onMouseLeave={(e) => { if (!item.disabled) e.currentTarget.style.background = 'none'; }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setRailOpen((v) => !v)} title={railOpen ? 'Hide side panel' : 'Show side panel'}>
          {railOpen ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setLive((v) => !v)} title={live ? 'Auto-refresh on' : 'paused'}>
          <RefreshCw size={12} style={live ? { animation: 'spin 3s linear infinite' } : undefined} /> {live ? 'live' : 'paused'}
        </button>
        <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} title="Close">
          <X size={13} />
        </button>
      </div>

      {deleteArmed && (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(248, 113, 113, 0.08)' }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-primary)', flex: 1 }}>Delete this task?</span>
          <button className="btn btn-destructive btn-sm" disabled={deleteBusy} onClick={confirmDelete}>Delete</button>
          <button className="btn btn-ghost btn-sm" disabled={deleteBusy} onClick={() => setDeleteArmed(false)}>Cancel</button>
        </div>
      )}

      {manageErr && (
        <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--color-status-red)', borderBottom: '1px solid var(--color-border-default)' }}>
          {manageErr}
        </div>
      )}

      {/* Body: center transcript + right rail */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <div
          ref={scrollRef}
          onScroll={(e) => { const el = e.currentTarget; atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
          style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          {gone ? (
            <div className="empty-state">
              <Cloud size={28} className="empty-state-icon" />
              <div style={{ fontSize: 12.5 }}>This task has ended.</div>
              <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ marginTop: 8 }}><X size={13} /> Close</button>
            </div>
          ) : err && !detail ? (
            <div style={{ fontSize: 12, color: 'var(--color-status-red)' }}>{err}</div>
          ) : !detail?.messages.length ? (
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>No turns yet — the cloud container is booting; replies appear here.</div>
          ) : (
            detail.messages.map((m, i) => <TranscriptMessage key={i} m={m} />)
          )}

          {detail?.pendingQuestion && (
            <ApprovalWidget pending={detail.pendingQuestion} answering={answering} onAnswer={handleAnswer} />
          )}

          {detail?.running && !detail.pendingQuestion && !gone && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-text-tertiary)', fontSize: 12, fontStyle: 'italic' }}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Working…
            </div>
          )}
        </div>

        {railOpen && (
          <div style={{ width: 260, flexShrink: 0, borderLeft: '1px solid var(--color-border-default)', padding: 10, overflow: 'auto' }}>
            <CoworkRightRail
              activeGoal={detail?.activeGoal || []}
              outputs={detail?.outputs || []}
              context={detail?.context || { tools: [], files: [] }}
              onDownload={handleDownload}
            />
          </div>
        )}
      </div>

      {/* Bottom in-task composer */}
      {!gone && (
        <div style={{ borderTop: '1px solid var(--color-border-default)', padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {downloadNotice && <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{downloadNotice}</div>}

          <AttachmentTray items={att.items} onRemove={att.remove} />
          <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => { att.addFiles(e.target.files); e.target.value = ''; }} />

          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
            <button type="button" className="btn btn-ghost btn-sm btn-icon" disabled={sending} title="Add files or photos" onClick={() => fileInputRef.current?.click()}>
              <Plus size={14} />
            </button>
            <textarea
              className="input"
              value={prompt}
              rows={2}
              placeholder="Write a message…"
              disabled={sending}
              style={{ flex: 1, resize: 'none', fontSize: 12.5 }}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleDrive(); } }}
            />
            <button className="btn btn-primary btn-sm btn-icon" disabled={!canSend} onClick={handleDrive} title="Send (⌘/Ctrl+Enter)">
              <Send size={13} />
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div ref={manualMenuRef} style={{ position: 'relative' }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setManualMenuOpen((v) => !v)} aria-expanded={manualMenuOpen}>
                {approvalLabel} <ChevronDown size={12} style={{ transition: 'transform 200ms ease', transform: manualMenuOpen ? 'rotate(180deg)' : undefined }} />
              </button>

              {manualMenuOpen && (
                <div style={{
                  position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, minWidth: 260,
                  background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)',
                  borderRadius: 'var(--radius-md)', boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
                  zIndex: 60, padding: 4,
                }}>
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

            <ModelEffortSelector model={model} effort={effort} onChange={(m, e) => { setModel(m); setEffort(e); }} />
          </div>
        </div>
      )}
    </div>
  );
}
