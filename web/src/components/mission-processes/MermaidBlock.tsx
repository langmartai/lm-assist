'use client';

import { useEffect, useState } from 'react';

// Module singletons: initialize mermaid once per page, unique render ids per block.
let mermaidReady = false;
let renderSeq = 0;

/**
 * Renders a ```mermaid fence as an SVG diagram. The mermaid package is loaded via
 * dynamic import so it stays out of the initial bundle; on any parse/render error
 * the raw fence text is shown with the error instead (the page must never crash
 * on a bad diagram in a playbook doc).
 *
 * XSS posture: doc bodies are semi-trusted (human + controller authored, but any
 * registry writer could smuggle markup into labels). Mermaid runs at its default
 * securityLevel 'strict', htmlLabels are disabled so labels stay plain SVG text,
 * and the produced SVG is passed through DOMPurify before injection.
 */
export function MermaidBlock({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSvg(null);
    setError(null);
    (async () => {
      try {
        const [{ default: mermaid }, { default: DOMPurify }] = await Promise.all([import('mermaid'), import('dompurify')]);
        if (!mermaidReady) {
          mermaid.initialize({
            startOnLoad: false,
            theme: 'dark',
            suppressErrorRendering: true,
            flowchart: { htmlLabels: false },
          });
          mermaidReady = true;
        }
        const { svg: rendered } = await mermaid.render(`lm-mermaid-${++renderSeq}`, chart);
        const clean = DOMPurify.sanitize(rendered, { USE_PROFILES: { svg: true, svgFilters: true } });
        if (alive) setSvg(clean);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [chart]);

  if (error) {
    return (
      <div
        style={{
          margin: '8px 0',
          padding: '10px 12px',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid rgba(248,113,113,0.4)',
          background: 'var(--color-bg-elevated)',
        }}
      >
        <div style={{ fontSize: 11, color: 'var(--color-status-red)', marginBottom: 6 }}>
          mermaid diagram failed to render: {error}
        </div>
        <pre
          style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: 1.5,
            color: 'var(--color-text-secondary)',
          }}
        >
          {chart}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div style={{ margin: '8px 0', fontSize: 11, color: 'var(--color-text-tertiary)' }}>Rendering diagram…</div>
    );
  }

  return (
    <div
      data-mermaid-diagram
      style={{ margin: '8px 0', overflowX: 'auto' }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
