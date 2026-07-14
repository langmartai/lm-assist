'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { detectAppMode, resolveConsoleUrl } from '@/lib/api-client';
import { CoworkComposer, type CoworkAttachmentRef } from '@/components/cowork/CoworkComposer';
import { CoworkList } from '@/components/cowork/CoworkList';
import { CoworkTaskView } from '@/components/cowork/CoworkTaskView';
import { ChatView } from '@/components/cowork/ChatView';
import type { ChatDetailView } from '@/hooks/useChatConversation';
import { normalizeRows, type HomeRow } from '@/lib/chat-rows';

/** Read a File as raw base64 (no data: prefix) for the /cowork/attachments upload. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}

/** Mode-aware unified home — one page drives both claude.ai chat conversations AND
 *  cowork tasks. The composer's `Chat | Cowork` toggle sets `mode`, which routes the
 *  composer's send (chat → createChat, cowork → createTask), the list filter, and the
 *  detail view (`openItem.kind` → ChatView vs CoworkTaskView). The list merges BOTH
 *  sources (recency-sorted via `normalizeRows`). `apiFetch` is built exactly like
 *  CcrPage.tsx (apiClient.fetchPath + proxy.machineId) so it transparently reaches
 *  a proxied/remote node the same way every other dashboard page does. */
export function CoworkPage() {
  const { apiClient, proxy } = useAppMode();
  const apiFetch = useCallback(
    <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> =>
      apiClient.fetchPath<T>(path, { method: opts?.method, body: opts?.body, machineId: proxy.machineId || undefined }),
    [apiClient, proxy.machineId],
  );
  const isRemoteNode = proxy.isProxied || !!proxy.machineId;
  // SSE only works when the browser reaches Core DIRECTLY (local). Proxied/remote → null → the hook polls.
  const buildStreamUrl = useCallback((sid: string): string | null => {
    if (isRemoteNode) return null;
    try { return resolveConsoleUrl(`${detectAppMode().baseUrl}/cowork/tasks/${sid}/stream`); } catch { return null; }
  }, [isRemoteNode]);
  // Voice STT needs a DIRECT ws to Core (like SSE) → local mode only. The api-token rides the
  // query string (browsers can't set WS headers). Null when proxied/remote → voice UI disabled.
  const voiceWsUrl = useMemo((): string | null => {
    if (isRemoteNode) return null;
    try {
      const httpUrl = resolveConsoleUrl(`${detectAppMode().baseUrl}/voice/stt/ws`);
      const token = (window as unknown as { __LM_API_TOKEN__?: string }).__LM_API_TOKEN__ || '';
      return httpUrl.replace(/^http/, 'ws') + (token ? `?token=${encodeURIComponent(token)}` : '');
    } catch { return null; }
  }, [isRemoteNode]);

  const [mode, setMode] = useState<'chat' | 'cowork'>('cowork');
  const [rows, setRows] = useState<HomeRow[]>([]);
  const [filter, setFilter] = useState<'all' | 'chat' | 'cowork'>('all');
  const [openItem, setOpenItem] = useState<{ id: string; kind: 'chat' | 'cowork'; seed?: ChatDetailView } | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  // Ids deleted this session — kept out of the merged list even while the claude.ai
  // list cache still returns them (the list index lags create/delete). See B1.
  const removedRef = useRef<Set<string>>(new Set());

  // Merge BOTH sources (claude.ai chats + cowork tasks) into one recency-sorted list.
  // Each fetch is guarded so a missing claude.ai cookie (empty chat list) or a cowork
  // hiccup degrades to just the other source instead of blanking the whole list.
  const reloadList = useCallback(async () => {
    setLoading(true);
    try {
      const [chatsR, tasksR] = await Promise.all([
        apiFetch<{ data?: any[] }>(`/claude-ai/conversations?limit=40`).catch(() => ({ data: [] as any[] })),
        apiFetch<{ tasks: any[] }>(`/cowork/tasks?filter=all&limit=40`).catch(() => ({ tasks: [] as any[] })),
      ]);
      const merged = normalizeRows((chatsR as any).data || (chatsR as any) || [], (tasksR as any).tasks || []);
      setRows(merged.filter((r) => !removedRef.current.has(r.id)));
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);
  useEffect(() => { reloadList(); }, [reloadList]);

  const createTask = useCallback(async (o: { prompt: string; model: string; effort: string; attachments?: CoworkAttachmentRef[] }) => {
    setCreating(true);
    try {
      const r = await apiFetch<{ sessionId: string }>('/cowork/tasks', { method: 'POST', body: { ...o, target: 'cloud' } });
      if (r?.sessionId) {
        setOpenItem({ id: r.sessionId, kind: 'cowork' });
        reloadList();
      }
    } finally {
      setCreating(false);
    }
  }, [apiFetch, reloadList]);

  // Chat-create path (used when mode==='chat'): create an empty conversation, open its
  // ChatView, then send the first prompt (blocking — the completion drains SSE server-side).
  // The route returns { ...upstream, uuid } as the unwrapped `data`, so `uuid` is top-level.
  const createChat = useCallback(async (o: { prompt: string; model: string }) => {
    setCreating(true);
    setCreateErr(null);
    try {
      const c = await apiFetch<{ uuid?: string; data?: { uuid?: string } }>(`/claude-ai/conversations`, { method: 'POST', body: { model: o.model } });
      const uuid = (c as any).uuid || (c as any).data?.uuid;
      if (!uuid) throw new Error('conversation create returned no id');
      // Send the first turn, then open the view SEEDED from the completion's reply. An
      // API-created conversation's tree read (/messages) 404s for a long while after create
      // even once completed, so we can't rely on it for the just-sent turn — instead we show
      // the prompt + the completion's returned text immediately (the tree read backfills later).
      const comp = await apiFetch<{ text?: string }>(`/claude-ai/conversations/${uuid}/completion`, { method: 'POST', body: { prompt: o.prompt, model: o.model } });
      const seed: ChatDetailView = {
        uuid,
        messages: [
          { role: 'user', type: 'user', text: o.prompt },
          ...(comp?.text ? [{ role: 'assistant', type: 'assistant', text: comp.text }] : []),
        ],
      };
      setOpenItem({ id: uuid, kind: 'chat', seed });
      // Optimistically show the new chat in the list immediately — the claude.ai list
      // index lags a fresh create, so a plain reloadList wouldn't include it yet (B1).
      const title = o.prompt.trim().slice(0, 60) || 'New chat';
      setRows((prev) => [{ id: uuid, kind: 'chat', title, updatedAt: new Date().toISOString() }, ...prev.filter((r) => r.id !== uuid)]);
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [apiFetch, reloadList]);

  // Upload one file to claude.ai's cowork attachment store (via core /cowork/attachments)
  // and return its ref for the composer to include on send.
  const uploadAttachment = useCallback(async (file: File): Promise<CoworkAttachmentRef> => {
    const contentBase64 = await fileToBase64(file);
    return apiFetch<CoworkAttachmentRef>('/cowork/attachments', {
      method: 'POST',
      body: { fileName: file.name, mimeType: file.type || undefined, contentBase64 },
    });
  }, [apiFetch]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--color-bg-root)' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border-default)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Sparkles size={20} style={{ color: 'var(--color-accent)' }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>Cowork</div>
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>chat + delegate tasks to a cloud-run claude</span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        {openItem ? (
          openItem.kind === 'chat' ? (
            <ChatView
              key={openItem.id}
              uuid={openItem.id}
              apiFetch={apiFetch}
              seed={openItem.seed}
              voiceWsUrl={voiceWsUrl}
              onClose={() => setOpenItem(null)}
              onDeleted={() => { removedRef.current.add(openItem.id); setRows((prev) => prev.filter((r) => r.id !== openItem.id)); setOpenItem(null); }}
            />
          ) : (
            <CoworkTaskView
              key={openItem.id}
              sid={openItem.id}
              apiFetch={apiFetch}
              onUpload={uploadAttachment}
              streamUrl={buildStreamUrl(openItem.id)}
              isRemoteNode={isRemoteNode}
              onClose={() => setOpenItem(null)}
              onDeleted={() => { removedRef.current.add(openItem.id); setRows((prev) => prev.filter((r) => r.id !== openItem.id)); setOpenItem(null); }}
            />
          )
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 32, maxWidth: 720, margin: '0 auto' }}>
            {createErr && (
              <div style={{ fontSize: 12, color: 'var(--color-status-red)', textAlign: 'center', marginBottom: -20 }}>
                Couldn’t start chat: {createErr}{/^API 4\d\d|cookie|unauth|not.?configured/i.test(createErr) ? ' — check your claude.ai connection.' : ''}
              </div>
            )}
            <CoworkComposer
              onCreate={(o) => (mode === 'chat' ? createChat(o) : createTask(o))}
              onUpload={uploadAttachment}
              busy={creating}
              mode={mode}
              onModeChange={setMode}
            />
            <CoworkList
              rows={rows}
              filter={filter}
              onFilter={setFilter}
              onOpen={setOpenItem}
              onNew={() => setOpenItem(null)}
              loading={loading}
            />
          </div>
        )}
      </div>
    </div>
  );
}
