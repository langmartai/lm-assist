'use client';

import { useState } from 'react';
import { Brain, ChevronDown, ChevronRight, Hash } from 'lucide-react';
import type { ThinkingBlock } from '@/lib/types';

interface ThinkingTabProps {
  blocks: ThinkingBlock[];
}

export function ThinkingTab({ blocks }: ThinkingTabProps) {
  if (blocks.length === 0) {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <Brain size={28} className="empty-state-icon" />
        <span style={{ fontSize: 13 }}>No thinking blocks in this session</span>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          Extended thinking appears when the model uses deep reasoning
        </span>
      </div>
    );
  }

  const totalChars = blocks.reduce((acc, b) => acc + b.charCount, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Stats bar */}
      <div style={{
        padding: '6px 16px',
        borderBottom: '1px solid var(--color-border-default)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 11,
        color: 'var(--color-text-tertiary)',
        fontFamily: 'var(--font-mono)',
      }}>
        <span>{blocks.length} thinking block{blocks.length !== 1 ? 's' : ''}</span>
        <span>·</span>
        <span>{(totalChars / 1000).toFixed(1)}k chars total</span>
      </div>

      {/* Blocks */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }} className="scrollbar-thin">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {blocks.map((block, i) => (
            <ThinkingBlockItem key={`${block.turnIndex}-${i}`} block={block} index={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ThinkingBlockItem({ block, index }: { block: ThinkingBlock; index: number }) {
  const [expanded, setExpanded] = useState(false);

  const preview = block.content.slice(0, 200).replace(/\n/g, ' ');
  const isLong = block.content.length > 200;

  return (
    <div
      style={{
        background: 'rgba(148,163,184,0.06)',
        border: '1px solid rgba(148,163,184,0.12)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          borderBottom: expanded ? '1px solid rgba(148,163,184,0.08)' : 'none',
        }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Brain size={14} style={{ color: 'var(--color-status-purple)', flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
          Thinking Block {index + 1}
        </span>
        <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
          Turn {block.turnIndex}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
          {(block.charCount / 1000).toFixed(1)}k chars
        </span>
      </div>

      {/* Content */}
      {!expanded && (
        <div style={{ padding: '8px 12px 8px 40px' }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
            {preview}{isLong ? '...' : ''}
          </span>
        </div>
      )}

      {expanded && (
        <div style={{ padding: '12px 16px', maxHeight: 500, overflow: 'auto' }} className="scrollbar-thin">
          <pre style={{
            fontSize: 12,
            lineHeight: 1.6,
            color: 'var(--color-text-secondary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'var(--font-mono)',
            margin: 0,
          }}>
            {block.content}
          </pre>
        </div>
      )}
    </div>
  );
}
