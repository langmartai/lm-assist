'use client';

import { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useAppMode } from '@/contexts/AppModeContext';
import { detectAppMode, resolveConsoleUrl } from '@/lib/api-client';
import { CoworkComposer, type CoworkAttachmentRef } from '@/components/cowork/CoworkComposer';
import { CoworkList, type CoworkListItem } from '@/components/cowork/CoworkList';
import { CoworkTaskView } from '@/components/cowork/CoworkTaskView';

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

/** Cowork shell — assembles the composer (home), the chats-and-tasks list, and the
 *  task-detail view behind one `openSid` state. `apiFetch` is built exactly like
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

  const [tasks, setTasks] = useState<CoworkListItem[]>([]);
  const [filter, setFilter] = useState('cowork');
  const [openSid, setOpenSid] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const reloadList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch<{ tasks: CoworkListItem[] }>(`/cowork/tasks?filter=${encodeURIComponent(filter)}`);
      setTasks(r.tasks || []);
    } catch {
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, filter]);
  useEffect(() => { reloadList(); }, [reloadList]);

  const createTask = useCallback(async (o: { prompt: string; model: string; effort: string; attachments?: CoworkAttachmentRef[] }) => {
    setCreating(true);
    try {
      const r = await apiFetch<{ sessionId: string }>('/cowork/tasks', { method: 'POST', body: { ...o, target: 'cloud' } });
      if (r?.sessionId) {
        setOpenSid(r.sessionId);
        reloadList();
      }
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
        {openSid ? (
          <CoworkTaskView
            key={openSid}
            sid={openSid}
            apiFetch={apiFetch}
            onUpload={uploadAttachment}
            streamUrl={buildStreamUrl(openSid)}
            isRemoteNode={isRemoteNode}
            onClose={() => setOpenSid(null)}
            onDeleted={() => { setOpenSid(null); reloadList(); }}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 32, maxWidth: 720, margin: '0 auto' }}>
            <CoworkComposer onCreate={createTask} onUpload={uploadAttachment} busy={creating} />
            <CoworkList
              tasks={tasks}
              filter={filter}
              onFilter={setFilter}
              onOpen={setOpenSid}
              onNew={() => setOpenSid(null)}
              loading={loading}
            />
          </div>
        )}
      </div>
    </div>
  );
}
