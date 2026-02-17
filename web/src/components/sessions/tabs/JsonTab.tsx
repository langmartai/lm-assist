'use client';

import { useState, useMemo } from 'react';
import { Copy, Check, FileJson } from 'lucide-react';
import type { SessionDetail } from '@/lib/types';

interface JsonTabProps {
  detail: SessionDetail;
}

export function JsonTab({ detail }: JsonTabProps) {
  const [copied, setCopied] = useState(false);
  const [showMessages, setShowMessages] = useState(false);

  const jsonContent = useMemo(() => {
    if (showMessages) {
      return JSON.stringify(detail, null, 2);
    }
    // Exclude messages for a compact view
    const { messages, ...rest } = detail;
    return JSON.stringify(
      { ...rest, messageCount: messages?.length ?? 0 },
      null,
      2,
    );
  }, [detail, showMessages]);

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <div style={{
        padding: '6px 12px',
        borderBottom: '1px solid var(--color-border-subtle)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 11,
      }}>
        <FileJson size={12} style={{ color: 'var(--color-text-tertiary)' }} />
        <span style={{ color: 'var(--color-text-tertiary)' }}>Raw Session Data</span>

        <label style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          color: 'var(--color-text-tertiary)',
          cursor: 'pointer',
          marginLeft: 8,
        }}>
          <input
            type="checkbox"
            checked={showMessages}
            onChange={e => setShowMessages(e.target.checked)}
          />
          Include messages
        </label>

        <div style={{ flex: 1 }} />

        <button className="btn btn-sm btn-ghost" onClick={handleCopy} style={{ gap: 4 }}>
          {copied ? (
            <Check size={12} style={{ color: 'var(--color-status-green)' }} />
          ) : (
            <Copy size={12} />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* JSON content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }} className="scrollbar-thin">
        <pre style={{
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          color: 'var(--color-text-secondary)',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.5,
        }}>
          {jsonContent}
        </pre>
      </div>
    </div>
  );
}
