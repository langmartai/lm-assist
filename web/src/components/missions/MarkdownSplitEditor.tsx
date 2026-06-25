'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Pencil, Columns2, Eye } from 'lucide-react';

type Mode = 'edit' | 'split' | 'preview';

/**
 * A full-height editor for a mission text field with a live Markdown preview.
 * `value`/`onChange` bind to the caller's draft state (no internal copy), so edits made here
 * flow straight back to the inline field, Save, and dirty-tracking. `previewTransform` adapts
 * the raw text before rendering (e.g. a newline list → bullets for Next steps).
 */
export function MarkdownSplitEditor({
  value,
  onChange,
  previewTransform,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  previewTransform?: (v: string) => string;
  mono?: boolean;
}) {
  const [mode, setMode] = useState<Mode>('split');
  const previewText = previewTransform ? previewTransform(value) : value;

  const showEditor = mode === 'edit' || mode === 'split';
  const showPreview = mode === 'preview' || mode === 'split';

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Mode toggle */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: '6px 12px',
          borderBottom: '1px solid var(--color-border-subtle)',
          flexShrink: 0,
        }}
      >
        {(
          [
            ['edit', Pencil, 'Edit'],
            ['split', Columns2, 'Split'],
            ['preview', Eye, 'Preview'],
          ] as const
        ).map(([m, Icon, label]) => (
          <button
            key={m}
            className={`btn btn-sm ${mode === m ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setMode(m)}
            style={{ fontSize: 11 }}
          >
            <Icon size={11} /> {label}
          </button>
        ))}
      </div>

      {/* Panes */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        {showEditor && (
          <textarea
            className="input"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Type here…"
            style={{
              flex: 1,
              minWidth: 0,
              resize: 'none',
              border: 'none',
              borderRadius: 0,
              fontSize: 13,
              lineHeight: 1.6,
              padding: '12px 16px',
              fontFamily: mono ? 'var(--font-mono)' : undefined,
              ...(mode === 'split' ? { borderRight: '1px solid var(--color-border-subtle)' } : {}),
            }}
          />
        )}
        {showPreview && (
          <div
            className="prose"
            style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '12px 16px', fontSize: 13, lineHeight: 1.6 }}
          >
            {previewText.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{previewText}</ReactMarkdown>
            ) : (
              <span style={{ color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>Nothing to preview</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
