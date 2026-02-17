'use client';

import { useState, useEffect } from 'react';
import { Loader2, RefreshCw, Sparkles, Server, ArrowRight, Database, Workflow, AlertTriangle, ExternalLink } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ArchitectureModelResponse, ServiceNode, ServiceConnection, DatabaseNode, DataFlow } from '@/lib/types';
import DOMPurify from 'dompurify';

let mermaidIdCounter = 0;

interface Props {
  model: ArchitectureModelResponse | null;
  loading: boolean;
  generating: boolean;
  onGenerate: () => void;
  machineId?: string;
}

// Service type → color mapping
const SERVICE_COLORS: Record<string, string> = {
  'api-server': '#60a5fa',
  'web-app': '#4ade80',
  'worker': '#fbbf24',
  'proxy': '#a78bfa',
  'database': '#22d3ee',
  'cache': '#f87171',
  'queue': '#fb923c',
  'external': '#94a3b8',
};

// Connection type → color mapping
const CONNECTION_COLORS: Record<string, string> = {
  http: '#60a5fa',
  websocket: '#4ade80',
  tcp: '#94a3b8',
  proxy: '#a78bfa',
  docker: '#c084fc',
  ssh: '#f87171',
  database: '#22d3ee',
};

export function SystemTab({ model: modelResp, loading, generating, onGenerate, machineId }: Props) {
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', gap: 8 }}>
        <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-text-tertiary)' }} />
        <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>Loading architecture model...</span>
      </div>
    );
  }

  if (!modelResp && !generating) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', gap: 16 }}>
        <Sparkles size={32} style={{ color: 'var(--color-text-tertiary)' }} />
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
            No architecture model generated yet
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', maxWidth: 400 }}>
            Generate a system architecture model using AI analysis of your project&apos;s CLAUDE.md, package.json, resources, and activity data.
          </div>
        </div>
        <button
          onClick={onGenerate}
          style={{
            padding: '8px 20px',
            fontSize: 13,
            fontWeight: 600,
            color: '#fff',
            background: 'var(--color-accent)',
            border: 'none',
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Sparkles size={14} />
          Generate Architecture
        </button>
      </div>
    );
  }

  if (generating && !modelResp) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', gap: 12 }}>
        <Loader2 size={24} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-accent)' }} />
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
          Generating architecture model...
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          Analyzing project context with AI. This may take 30-60 seconds.
        </div>
      </div>
    );
  }

  const { model, stale, generatedAt, sessionId } = modelResp!;

  const sessionUrl = sessionId
    ? `/sessions?session=${encodeURIComponent(sessionId)}${machineId ? `&machine=${encodeURIComponent(machineId)}` : ''}`
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header with stale badge + session link + regenerate button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          Generated {new Date(generatedAt).toLocaleDateString()} {new Date(generatedAt).toLocaleTimeString()}
        </span>
        {stale && (
          <span style={{
            fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px',
            padding: '1px 6px', borderRadius: 'var(--radius-sm)',
            background: '#fbbf2418', color: '#fbbf24',
          }}>
            Stale
          </span>
        )}
        {sessionUrl && (
          <a
            href={sessionUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-accent)',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              padding: '1px 6px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-accent-muted, #3b82f610)',
            }}
            title={`Discovery session: ${sessionId}`}
          >
            <ExternalLink size={10} />
            session
          </a>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={onGenerate}
          disabled={generating}
          style={{
            padding: '4px 12px',
            fontSize: 11,
            fontWeight: 500,
            color: 'var(--color-text-secondary)',
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border-default)',
            borderRadius: 'var(--radius-sm)',
            cursor: generating ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            opacity: generating ? 0.5 : 1,
          }}
        >
          {generating ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={12} />}
          Regenerate
        </button>
      </div>

      {/* Regeneration banner */}
      {generating && (
        <div style={{
          padding: '8px 14px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-accent-muted, #3b82f615)',
          border: '1px solid var(--color-accent, #3b82f6)33',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: 'var(--color-text-secondary)',
        }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-accent)' }} />
          Regenerating architecture model... Showing previous version below.
        </div>
      )}

      {/* Mermaid Diagram */}
      {model.mermaidDiagram && (
        <MermaidDiagram diagram={model.mermaidDiagram} />
      )}

      {/* Summary */}
      {model.summary && (
        <div style={{
          padding: '14px 16px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-bg-secondary)',
          fontSize: 13,
          lineHeight: 1.6,
          color: 'var(--color-text-secondary)',
        }} className="markdown-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {model.summary}
          </ReactMarkdown>
        </div>
      )}

      {/* Services */}
      {model.services.length > 0 && (
        <ServicesList services={model.services} />
      )}

      {/* Connections */}
      {model.connections.length > 0 && (
        <ConnectionsList connections={model.connections} />
      )}

      {/* Databases */}
      {model.databases.length > 0 && (
        <DatabasesList databases={model.databases} />
      )}

      {/* Data Flows */}
      {model.dataFlows.length > 0 && (
        <DataFlowsList dataFlows={model.dataFlows} />
      )}
    </div>
  );
}

// ─── Mermaid Diagram ──────────────────────────────────

function MermaidDiagram({ diagram }: { diagram: string }) {
  // Use React state for SVG output — avoids direct DOM manipulation that conflicts with React reconciliation
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          themeVariables: {
            primaryColor: '#334155',
            primaryTextColor: '#f1f5f9',
            primaryBorderColor: '#475569',
            lineColor: '#60a5fa',
            secondaryColor: '#1e293b',
            tertiaryColor: '#475569',
            nodeTextColor: '#f1f5f9',
            mainBkg: '#334155',
            nodeBorder: '#60a5fa',
            clusterBkg: '#1e293b',
            titleColor: '#f1f5f9',
            edgeLabelBackground: '#1e293b',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: '13px',
          },
          flowchart: {
            htmlLabels: true,
            curve: 'basis',
          },
        });

        if (cancelled) return;

        const id = `mermaid-${++mermaidIdCounter}`;
        const { svg } = await mermaid.render(id, diagram);
        if (cancelled) return;

        // Sanitize SVG with DOMPurify then set as React-managed state.
        // Mermaid uses foreignObject + HTML for labels; we must allow these tags.
        // DOMPurify still strips scripts, event handlers, and dangerous attributes.
        const sanitized = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true, html: true },
          ADD_TAGS: ['foreignObject'],
        });
        setSvgHtml(sanitized);
      } catch (err) {
        if (!cancelled) {
          console.error('Mermaid render error:', err);
          setError(true);
        }
      }
    }

    renderDiagram();
    return () => { cancelled = true; };
  }, [diagram]);

  if (error) {
    return (
      <div style={{
        padding: '14px 16px',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border-default)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <AlertTriangle size={14} style={{ color: '#fbbf24' }} />
          <span style={{ fontSize: 12, color: '#fbbf24', fontWeight: 600 }}>Diagram rendering failed</span>
        </div>
        <pre style={{
          fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0,
          padding: '10px 12px', borderRadius: 'var(--radius-sm)',
          background: 'var(--color-bg-tertiary)',
          maxHeight: 300, overflowY: 'auto',
        }}>
          {diagram}
        </pre>
      </div>
    );
  }

  return (
    <div style={{
      padding: '14px 16px',
      borderRadius: 'var(--radius-md)',
      background: 'var(--color-bg-secondary)',
      border: '1px solid var(--color-border-default)',
      overflow: 'auto',
      maxHeight: 500,
    }}>
      {!svgHtml ? (
        <div style={{ display: 'flex', justifyContent: 'center', minHeight: 100, alignItems: 'center' }}>
          <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', color: 'var(--color-text-tertiary)' }} />
        </div>
      ) : (
        /* SVG is sanitized by DOMPurify above — safe for dangerouslySetInnerHTML */
        <div
          style={{ display: 'flex', justifyContent: 'center' }}
          dangerouslySetInnerHTML={{ __html: svgHtml }}
        />
      )}
    </div>
  );
}

// ─── Services ──────────────────────────────────

function ServicesList({ services }: { services: ServiceNode[] }) {
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
        paddingBottom: 6, borderBottom: '1px solid var(--color-border-default)',
      }}>
        <Server size={14} style={{ color: '#60a5fa' }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Services
        </span>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {services.length}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 8 }}>
        {services.map(svc => {
          const color = SERVICE_COLORS[svc.type] || '#94a3b8';
          return (
            <div key={svc.id} style={{
              padding: '10px 14px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-bg-secondary)',
              borderLeft: `3px solid ${color}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', flex: 1 }}>
                  {svc.name}
                </span>
                {svc.port && (
                  <span style={{
                    fontSize: 11, fontFamily: 'var(--font-mono)',
                    padding: '1px 6px', borderRadius: 'var(--radius-sm)',
                    background: `${color}15`, color,
                  }}>
                    :{svc.port}
                  </span>
                )}
              </div>
              <div style={{
                fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px',
                color, marginBottom: 6,
              }}>
                {svc.type}
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6, lineHeight: 1.4 }}>
                {svc.description}
              </div>
              {svc.technologies.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                  {svc.technologies.map(tech => (
                    <span key={tech} style={{
                      fontSize: 10, fontFamily: 'var(--font-mono)',
                      padding: '1px 6px', borderRadius: 'var(--radius-sm)',
                      background: 'var(--color-bg-tertiary)', color: 'var(--color-text-tertiary)',
                    }}>
                      {tech}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Connections ──────────────────────────────────

function ConnectionsList({ connections }: { connections: ServiceConnection[] }) {
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
        paddingBottom: 6, borderBottom: '1px solid var(--color-border-default)',
      }}>
        <ArrowRight size={14} style={{ color: '#a78bfa' }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Connections
        </span>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {connections.length}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {connections.map((conn, i) => {
          const color = CONNECTION_COLORS[conn.type] || '#94a3b8';
          return (
            <div key={i} style={{
              padding: '8px 14px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-bg-secondary)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
            }}>
              <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{conn.from}</span>
              <ArrowRight size={12} style={{ color: 'var(--color-text-tertiary)' }} />
              <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{conn.to}</span>
              <span style={{
                fontSize: 10, fontFamily: 'var(--font-mono)',
                padding: '1px 6px', borderRadius: 'var(--radius-sm)',
                background: `${color}15`, color,
              }}>
                {conn.type}
              </span>
              {conn.port && (
                <span style={{
                  fontSize: 10, fontFamily: 'var(--font-mono)',
                  color: 'var(--color-text-tertiary)',
                }}>
                  :{conn.port}
                </span>
              )}
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flex: 1 }}>
                {conn.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Databases ──────────────────────────────────

function DatabasesList({ databases }: { databases: DatabaseNode[] }) {
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
        paddingBottom: 6, borderBottom: '1px solid #22d3ee33',
      }}>
        <Database size={14} style={{ color: '#22d3ee' }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#22d3ee', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Databases
        </span>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {databases.length}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {databases.map(db => (
          <div key={db.id} style={{
            padding: '10px 14px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-secondary)',
            borderLeft: '3px solid #22d3ee',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                {db.name}
              </span>
              <span style={{
                fontSize: 10, fontFamily: 'var(--font-mono)',
                padding: '1px 6px', borderRadius: 'var(--radius-sm)',
                background: '#22d3ee15', color: '#22d3ee',
              }}>
                {db.system}
              </span>
            </div>
            {db.tables.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 4 }}>
                {db.tables.map(t => (
                  <span key={t} style={{
                    fontSize: 9, fontFamily: 'var(--font-mono)',
                    padding: '1px 5px', borderRadius: 'var(--radius-sm)',
                    background: '#22d3ee12', color: '#22d3ee',
                  }}>
                    {t}
                  </span>
                ))}
              </div>
            )}
            {db.usedBy.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                Used by: {db.usedBy.join(', ')}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Data Flows ──────────────────────────────────

function DataFlowsList({ dataFlows }: { dataFlows: DataFlow[] }) {
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
        paddingBottom: 6, borderBottom: '1px solid #fbbf2433',
      }}>
        <Workflow size={14} style={{ color: '#fbbf24' }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Data Flows
        </span>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {dataFlows.length}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {dataFlows.map((flow, i) => (
          <div key={i} style={{
            padding: '10px 14px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-secondary)',
            borderLeft: '3px solid #fbbf24',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>
              {flow.name}
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8, lineHeight: 1.4 }}>
              {flow.description}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {flow.steps.map((step, j) => (
                <div key={j} style={{
                  fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)',
                  paddingLeft: 8,
                  borderLeft: '2px solid #fbbf2433',
                }}>
                  {step}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

