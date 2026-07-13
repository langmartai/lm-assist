'use client';

import { useRef, useState } from 'react';

/** A file uploaded to claude.ai's cowork attachment store (mirrors the core CoworkAttachmentRef). */
export interface CoworkAttachmentRef { file_uuid: string; file_name: string; is_image?: boolean; size_bytes?: number }

/** One row in a composer's attachment tray — tracks upload progress per file. */
export interface AttachItem { id: string; name: string; size: number; isImage: boolean; status: 'uploading' | 'done' | 'error'; ref?: CoworkAttachmentRef; error?: string }

export function fmtSize(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Shared attachment-tray state for both the home composer and the in-task
 * composer: adds files (each uploaded via `onUpload` → a CoworkAttachmentRef),
 * tracks per-file upload status, and exposes the ready refs for send. `reset()`
 * clears the tray after a successful send.
 */
export function useAttachments(onUpload: (file: File) => Promise<CoworkAttachmentRef>) {
  const [items, setItems] = useState<AttachItem[]>([]);
  const idRef = useRef(0);

  const addFiles = (files: FileList | null) => {
    if (!files || !files.length) return;
    for (const file of Array.from(files)) {
      const id = `a${++idRef.current}`;
      const isImage = /^image\//i.test(file.type);
      setItems((prev) => [...prev, { id, name: file.name, size: file.size, isImage, status: 'uploading' }]);
      void onUpload(file)
        .then((ref) => setItems((prev) => prev.map((a) => (a.id === id ? { ...a, status: 'done', ref, name: ref.file_name || a.name } : a))))
        .catch((e) => setItems((prev) => prev.map((a) => (a.id === id ? { ...a, status: 'error', error: e instanceof Error ? e.message : String(e) } : a))));
    }
  };

  const remove = (id: string) => setItems((prev) => prev.filter((a) => a.id !== id));
  const reset = () => setItems([]);
  const uploading = items.some((a) => a.status === 'uploading');
  const hasReady = items.some((a) => a.status === 'done');
  const refs = (): CoworkAttachmentRef[] => items.filter((a) => a.status === 'done' && a.ref).map((a) => a.ref as CoworkAttachmentRef);

  return { items, addFiles, remove, reset, uploading, hasReady, refs };
}
