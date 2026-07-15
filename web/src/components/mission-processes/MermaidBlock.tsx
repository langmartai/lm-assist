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
 * XSS posture: doc bodies are semi-trusted (human + controller authored, attributed
 * and rollback-able, but any registry writer could try to smuggle markup into
 * labels). Mermaid runs at its default securityLevel 'strict', which HTML-encodes
 * label text and forbids click/javascript directives — that is the sanitizer here.
 * DOMPurify was tried and is structurally incompatible: mermaid-11 flowcharts
 * render every node label as foreignObject HTML (the htmlLabels option is not
 * honored), and DOMPurify empties foreignObject children by design (mXSS defense),
 * which blanks every label. As defense-in-depth, INJECT_GUARD refuses to inject
 * any SVG that still carries scripty constructs (falls back to the raw block) —
 * verified headless with a hostile-label probe against the live pipeline.
 */
const INJECT_GUARD = /<script|(?:^|[\s"'<])on[a-z]+\s*=|javascript:/i;
export function MermaidBlock({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSvg(null);
    setError(null);
    (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        if (!mermaidReady) {
          mermaid.initialize({ startOnLoad: false, theme: 'dark', suppressErrorRendering: true });
          mermaidReady = true;
        }
        const { svg: rendered } = await mermaid.render(`lm-mermaid-${++renderSeq}`, chart);
        if (INJECT_GUARD.test(rendered)) throw new Error('diagram output failed the script-content guard');
        if (alive) setSvg(rendered);
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
