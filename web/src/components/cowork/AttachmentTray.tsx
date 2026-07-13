'use client';

import { FileText, Image as ImageIcon, Loader2, X } from 'lucide-react';
import { fmtSize, type AttachItem } from './useAttachments';

/** Horizontal tray of attachment chips shown above a composer input. Shared by the
 *  home composer (CoworkComposer) and the in-task composer (CoworkTaskView). */
export function AttachmentTray({ items, onRemove }: { items: AttachItem[]; onRemove: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {items.map((a) => {
        const Icon = a.isImage ? ImageIcon : FileText;
        const err = a.status === 'error';
        return (
          <div
            key={a.id}
            title={err ? a.error : a.name}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 240,
              padding: '4px 6px 4px 8px', borderRadius: 'var(--radius-md)',
              background: 'var(--color-bg-elevated)',
              border: `1px solid ${err ? 'var(--color-status-red)' : 'var(--color-border-subtle)'}`,
              fontSize: 11.5,
            }}
          >
            {a.status === 'uploading'
              ? <Loader2 size={12} className="spin" style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
              : <Icon size={12} style={{ color: err ? 'var(--color-status-red)' : 'var(--color-accent)', flexShrink: 0 }} />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text-secondary)' }}>{a.name}</span>
            <span style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
              {a.status === 'uploading' ? 'uploading…' : err ? 'failed' : fmtSize(a.size)}
            </span>
            <button
              type="button"
              onClick={() => onRemove(a.id)}
              title="Remove"
              style={{ display: 'inline-flex', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', padding: 0, flexShrink: 0 }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
