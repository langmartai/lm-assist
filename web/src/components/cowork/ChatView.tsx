'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, MessageSquare, Mic, Plus, Send, X } from 'lucide-react';
import { TranscriptMessage } from '@/components/shared/TranscriptMessage';
import { ModelEffortSelector } from '@/components/cowork/ModelEffortSelector';
import { AttachmentTray } from '@/components/cowork/AttachmentTray';
import { useAttachments } from '@/components/cowork/useAttachments';
import { fileToChatAttachment } from '@/lib/chat-attachments';
import { useChatConversation, type ChatAttachment, type ChatDetailView } from '@/hooks/useChatConversation';
import { useVoiceConversation, type VoiceState } from '@/hooks/useVoiceConversation';
import { buildClaudeVoiceWsUrl } from '@/lib/voice-url';
import { ClaudeVoiceOverlay } from '@/components/voice/ClaudeVoiceOverlay';
import { voiceV2BrowserSupport } from '@/lib/voice-v2-browser';

/** Short label for the voice status line. */
function voiceStatusLabel(s: VoiceState): string {
  switch (s) {
    case 'listening': return 'Listening…';
    case 'transcribing': return 'Transcribing…';
    case 'thinking': return 'Thinking…';
    case 'speaking': return 'Speaking…';
    default: return '';
  }
}

type ApiFetch = <T>(path: string, o?: { method?: string; body?: unknown }) => Promise<T>;

/** claude.ai-look-alike Chat conversation view: transcript (center) + a bottom
 *  composer (model + send). Rename/delete via the header. No right rail / approvals
 *  / effort (chat has none). Mirrors CoworkTaskView's shell. */
export function ChatView({ uuid, apiFetch, onClose, onDeleted, seed, voiceWsUrl, isRemoteNode }: {
  uuid: string; apiFetch: ApiFetch; onClose: () => void; onDeleted: () => void; seed?: ChatDetailView; voiceWsUrl?: string | null; isRemoteNode: boolean;
}) {
  const [model, setModel] = useState('claude-sonnet-5');
  const { detail, err, gone, sending, send, refresh } = useChatConversation({ uuid, apiFetch, model, seed });
  const [prompt, setPrompt] = useState('');
  const [manageErr, setManageErr] = useState<string | null>(null);
  // Voice DICTATION: the transcript is mirrored LIVE into the composer (see the effect below),
  // not auto-sent — you review/edit and send it yourself. sendMessage is a no-op because the
  // composer already holds the text; returning undefined stops the hook from speaking a reply.
  const dictationBaseRef = useRef<string | null>(null);
  const voice = useVoiceConversation({ wsUrl: voiceWsUrl || '', sendMessage: async () => undefined });

  // Bidirectional voice v2 ("voice conversation" mode) — a separate toggle from the
  // dictation mic above; same null-hides-the-button gate as every other voice UI.
  // buildClaudeVoiceWsUrl only checks https + local + token — it can't see whether THIS
  // node actually has a claude.ai cookie or a system Chrome to drive the relay, so it's
  // paired with a server-side capability probe (fetched once on mount) before the toggle
  // is allowed to render; a fetch failure degrades to unavailable (hidden), same as the
  // transport gate itself.
  const claudeVoiceWsUrl = useMemo((): string | null => {
    try { return buildClaudeVoiceWsUrl({ isRemoteNode }); } catch { return null; }
  }, [isRemoteNode]);
  const [voiceV2Available, setVoiceV2Available] = useState(false);
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ available: boolean; reason: string }>('/voice/claude/capability')
      .then((r) => { if (!cancelled) setVoiceV2Available(!!r?.available); })
      .catch(() => { if (!cancelled) setVoiceV2Available(false); });
    return () => { cancelled = true; };
  }, [apiFetch]);
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  // Client-only: evaluated in an effect, never during render, so SSR and the first client
  // render agree (a mismatch would be a hydration error).
  const [browserVoice, setBrowserVoice] = useState<{ ok: boolean; reason: string }>({ ok: false, reason: '' });
  // Shown on screen when the voice control is tapped but unavailable — a tooltip cannot be
  // reached on a touch device, which is exactly where this was reported.
  const [voiceWhy, setVoiceWhy] = useState<string | null>(null);
  useEffect(() => { setBrowserVoice(voiceV2BrowserSupport()); }, []);

  // Mirror the growing transcript into the input box while the mic is active, appended after
  // whatever was already typed. Release the base once dictation ends so the text persists.
  useEffect(() => {
    if (voice.state === 'listening' || voice.state === 'transcribing') {
      if (dictationBaseRef.current === null) dictationBaseRef.current = prompt;
      const base = dictationBaseRef.current;
      setPrompt((base.trim() ? base.trimEnd() + ' ' : '') + voice.interim);
    } else if (voice.state === 'idle' || voice.state === 'error') {
      dictationBaseRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.interim, voice.state]);

  // Inline rename — clicking the title swaps it for a text input (idiom copied from
  // CoworkTaskView's header rename, minus the surrounding title▾ menu — chat only
  // needs rename + delete, not archive/pin/schedule/skill/project).
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  useEffect(() => { const el = scrollRef.current; if (el && atBottomRef.current) el.scrollTop = el.scrollHeight; });

  // Text-file attachments — useAttachments/AttachmentTray are the same shared tray used by
  // Cowork, but chat has no attachment-store upload endpoint: onUpload reads the file locally
  // (fileToChatAttachment) and stashes the real ChatAttachment in chatRefs, keyed by a synthetic
  // `file_uuid` (name:size) so the tray still gets back a well-formed CoworkAttachmentRef chip.
  const chatRefs = useRef(new Map<string, ChatAttachment>());
  const attKeyRef = useRef(0);
  const att = useAttachments(async (file) => {
    const a = await fileToChatAttachment(file);
    // Unique per attach — a plain name:size key collided for two files sharing both,
    // making the tray send the second file's content twice (B2).
    const key = `${file.name}:${file.size}:${++attKeyRef.current}`;
    chatRefs.current.set(key, a);
    return { file_uuid: key, file_name: a.file_name };
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canSend = (prompt.trim().length > 0 || att.hasReady) && !sending && !att.uploading;
  const handleSend = async () => {
    const t = prompt.trim();
    const ready = att.refs().map((r) => chatRefs.current.get(r.file_uuid)).filter(Boolean) as ChatAttachment[];
    if (!t && !ready.length) return;
    setPrompt('');
    att.reset();
    chatRefs.current.clear();
    await send(t, ready.length ? ready : undefined);
  };

  const startRename = () => {
    setRenameValue(detail?.name || '');
    setRenaming(true);
  };
  const commitRename = async () => {
    const name = renameValue.trim();
    if (!name) { setRenaming(false); return; }
    setRenameBusy(true);
    try {
      await apiFetch(`/claude-ai/conversations/${uuid}/title`, { method: 'POST', body: { title: name } });
      setRenaming(false);
      refresh();
    } catch (e) {
      setManageErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRenameBusy(false);
    }
  };

  const handleDelete = async () => {
    try { await apiFetch(`/claude-ai/conversations/${uuid}`, { method: 'DELETE' }); onDeleted(); }
    catch (e) { setManageErr(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <MessageSquare size={15} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
        {renaming ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
            <input
              className="input"
              autoFocus
              value={renameValue}
              disabled={renameBusy}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void commitRename(); }
                if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); }
              }}
              style={{ flex: 1, fontSize: 13, padding: '4px 8px' }}
            />
            <button className="btn btn-primary btn-sm" disabled={renameBusy || !renameValue.trim()} onClick={() => void commitRename()}>Save</button>
            <button className="btn btn-ghost btn-sm" disabled={renameBusy} onClick={() => setRenaming(false)}>Cancel</button>
          </div>
        ) : (
          <button
            className="truncate"
            onClick={startRename}
            title="Rename conversation"
            style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, color: 'var(--color-text-primary)', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {detail?.name || 'New chat'}
          </button>
        )}
        {!renaming && <button className="btn btn-ghost btn-sm" onClick={() => void handleDelete()} title="Delete conversation">Delete</button>}
        <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} title="Close"><X size={13} /></button>
      </div>

      {manageErr && (
        <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--color-status-red)', borderBottom: '1px solid var(--color-border-default)' }}>
          {manageErr}
        </div>
      )}

      <div ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {gone ? <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12.5 }}>This conversation was deleted.</div>
          : err ? <div style={{ color: 'var(--color-status-red)', fontSize: 12.5 }}>{err}</div>
          : (detail?.messages || []).map((m, i) => <TranscriptMessage key={i} m={m} />)}
        {sending && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Thinking…</div>}
      </div>

      {!gone && (
        <div style={{ borderTop: '1px solid var(--color-border-default)', padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <AttachmentTray items={att.items} onRemove={att.remove} />
          {/* Voice status line — visible only mid-turn. */}
          {voice.state !== 'idle' && (
            <div style={{ fontSize: 11.5, padding: '2px 6px', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
              color: voice.state === 'error' ? 'var(--color-status-red)' : voice.state === 'listening' || voice.state === 'speaking' ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}>
              {voice.state === 'error' ? (voice.error || 'Voice error') : (
                <>
                  <span style={{ flexShrink: 0 }}>{voiceStatusLabel(voice.state)}</span>
                </>
              )}
            </div>
          )}
          <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => { att.addFiles(e.target.files); e.target.value = ''; }} />
          {voiceWhy && (
            <div role="status" style={{ fontSize: 11.5, color: 'var(--color-status-yellow)', padding: '4px 6px', marginBottom: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ flex: 1 }}>Voice conversation unavailable — {voiceWhy}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setVoiceWhy(null)} style={{ fontSize: 11 }}>Dismiss</button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
            <button type="button" className="btn btn-ghost btn-sm btn-icon" disabled={sending} title="Add text files" onClick={() => fileInputRef.current?.click()}><Plus size={14} /></button>
            <textarea className="input" value={prompt} rows={2} placeholder="Reply to Claude…" disabled={sending}
              style={{ flex: 1, resize: 'none', fontSize: 12.5 }}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void handleSend(); } }} />
            {voiceWsUrl && voice.supported && (
              <button type="button" className="btn btn-ghost btn-sm btn-icon"
                title={voice.state === 'listening' ? 'Click to stop + send' : 'Click to talk'}
                onClick={() => { if (voice.state === 'listening') void voice.stop(); else if (voice.state === 'idle' || voice.state === 'error') void voice.start(); }}
                style={{ color: voice.state === 'listening' ? 'var(--color-accent)' : undefined }}>
                <Mic size={14} />
              </button>
            )}
            {/* THREE gates: a reachable ws URL, a Chrome on the NODE (voiceV2Available,
                server-side), and the browser's own audio capability. The last was missing — so on
                Safari/Firefox the control rendered, connected, then died the instant the engine
                loaded, showing only "Voice error".
                Deliberately DISABLED-with-a-reason rather than hidden: a control that silently
                vanishes just moves the confusion ("where did voice go?"), and the two causes need
                opposite fixes — accept the certificate vs. switch to Chrome. */}
            {claudeVoiceWsUrl && voiceV2Available && !browserVoice.ok && browserVoice.reason && (
              // Tappable, NOT disabled. The reason used to live only in a `title` tooltip — which
              // a touch device can never show, so on a tablet this was an unexplained dead
              // control. Tapping now prints the reason on screen.
              <button type="button" className="btn btn-ghost btn-sm btn-icon"
                title={`Voice conversation unavailable — ${browserVoice.reason}`}
                onClick={() => setVoiceWhy(browserVoice.reason)}
                style={{ opacity: 0.5 }}>
                <AudioLines size={14} />
              </button>
            )}
            {claudeVoiceWsUrl && voiceV2Available && browserVoice.ok && (
              <button type="button" className="btn btn-ghost btn-sm btn-icon"
                title="Voice conversation"
                onClick={() => setVoiceModeOpen(true)}>
                <AudioLines size={14} />
              </button>
            )}
            <button className="btn btn-primary btn-sm btn-icon" disabled={!canSend} onClick={() => void handleSend()} title="Send (⌘/Ctrl+Enter)"><Send size={13} /></button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1 }} />
            <ModelEffortSelector model={model} effort="" onChange={(m) => setModel(m)} hideEffort />
          </div>
        </div>
      )}

      {voiceModeOpen && (
        <ClaudeVoiceOverlay
          conversationUuid={uuid}
          model={model}
          onModelChange={setModel}
          isRemoteNode={isRemoteNode}
          onClose={() => setVoiceModeOpen(false)}
        />
      )}
    </div>
  );
}
