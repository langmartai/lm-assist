'use client';

/**
 * Renders an import plan (dry run) or apply result: one row per section with its action,
 * the non-zero outcome buckets (and what was actually written, after an apply), refusals with
 * a next step, warnings and per-item errors. Sample ids (≤ 10 per bucket) expand per row.
 */

import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  BUCKET_LABEL, WRITE_BUCKETS, nextStep, nonZeroBuckets,
  type ImportResult, type PlanBucket, type PlanCounts, type SectionPlan,
} from '@/lib/data-bundles';
import { mono, muted, td, th } from './shared';

const ACTION_BADGE: Record<string, string> = {
  import: 'badge-blue', create: 'badge-green', takeover: 'badge-orange', skip: 'badge-default', refuse: 'badge-red',
};

function bucketBadge(b: PlanBucket): string {
  if ((WRITE_BUCKETS as readonly string[]).includes(b)) return 'badge-green';
  if (b === 'neutralized' || b === 'importedDisabled' || b === 'skipDiffers') return 'badge-orange';
  if (b === 'tooLarge') return 'badge-red';
  return 'badge-default';
}

function Chips({ counts }: { counts: PlanCounts | undefined }) {
  const nz = nonZeroBuckets(counts);
  if (!nz.length) return <span style={muted}>nothing</span>;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
      {nz.map(([b, n]) => <span key={b} className={`badge ${bucketBadge(b)}`}>{n} {BUCKET_LABEL[b]}</span>)}
    </span>
  );
}

function SectionRow({ s, applied }: { s: SectionPlan; applied: boolean }) {
  const [open, setOpen] = useState(false);
  const sampleBuckets = Object.entries(s.samples ?? {}).filter(([, ids]) => Array.isArray(ids) && ids.length > 0) as Array<[PlanBucket, string[]]>;
  const hint = s.refused ? nextStep(s.refused.code) : null;
  return (
    <Fragment>
      <tr style={{ borderTop: '1px solid var(--color-border-default)' }}>
        <td style={td}>
          <button className="btn btn-ghost btn-sm" style={{ padding: 2, visibility: sampleBuckets.length ? 'visible' : 'hidden' }} onClick={() => setOpen((v) => !v)} title="Sample ids">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        </td>
        <td style={td}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className="badge badge-default">{s.kind}</span>
            <span style={{ ...mono, color: 'var(--color-text-primary)' }}>{s.id}</span>
          </div>
          {s.title && s.title !== s.id && <div style={muted}>{s.title}</div>}
        </td>
        <td style={td}>{s.action ? <span className={`badge ${ACTION_BADGE[s.action] ?? 'badge-default'}`}>{s.action}</span> : <span style={muted}>—</span>}</td>
        <td style={td}>
          {s.refused ? <span style={muted}>refused</span> : <Chips counts={s.counts} />}
          {applied && !s.refused && (
            <div style={{ marginTop: 4 }}><span style={{ ...muted, marginRight: 4 }}>written:</span><Chips counts={s.applied} /></div>
          )}
        </td>
        <td style={{ ...td, maxWidth: 420 }}>
          {s.refused && (
            <div style={{ marginBottom: 4 }}>
              <span className="badge badge-red" style={mono}>{s.refused.code}</span>{' '}
              <span style={{ fontSize: 12, color: 'var(--color-status-red)' }}>{s.refused.reason}</span>
              {hint && <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>Next: {hint}</div>}
            </div>
          )}
          {(s.warnings ?? []).map((w, i) => <div key={i} style={{ fontSize: 11, color: 'var(--color-status-orange)', wordBreak: 'break-word' }}>{w}</div>)}
          {(s.errors ?? []).map((e, i) => <div key={`e${i}`} style={{ fontSize: 11, color: 'var(--color-status-red)', ...mono, wordBreak: 'break-word' }}>{e}</div>)}
        </td>
      </tr>
      {open && (
        <tr>
          <td />
          <td colSpan={4} style={{ ...td, paddingTop: 0 }}>
            {sampleBuckets.map(([b, ids]) => (
              <div key={b} style={{ fontSize: 11, color: 'var(--color-text-secondary)', wordBreak: 'break-word' }}>
                <span style={{ color: 'var(--color-text-tertiary)' }}>{BUCKET_LABEL[b] ?? b}:</span> <span style={mono}>{ids.join(', ')}</span>
              </div>
            ))}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export function PlanTable({ result }: { result: ImportResult }) {
  const applied = !result.dryRun;
  return (
    <div>
      {(result.warnings ?? []).map((w, i) => <div key={i} style={{ fontSize: 11, color: 'var(--color-status-orange)', marginBottom: 4 }}>{w}</div>)}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--color-text-tertiary)' }}>
              <th style={{ ...th, width: 24 }} /><th style={th}>section</th><th style={th}>action</th>
              <th style={th}>{applied ? 'plan / written' : 'outcome'}</th><th style={th}>notes</th>
            </tr>
          </thead>
          <tbody>
            {result.sections.length === 0 && (
              <tr><td colSpan={5} style={{ ...td, ...muted }}>No section of the bundle matched the selection.</td></tr>
            )}
            {result.sections.map((s) => <SectionRow key={`${s.kind}:${s.id}`} s={s} applied={applied} />)}
            <tr style={{ borderTop: '2px solid var(--color-border-strong)' }}>
              <td />
              <td style={{ ...td, fontWeight: 600, color: 'var(--color-text-primary)' }}>total</td>
              <td style={td}>{result.refused > 0 && <span className="badge badge-red">{result.refused} refused</span>}</td>
              <td style={td}>
                <Chips counts={result.totals} />
                {applied && <div style={{ marginTop: 4 }}><span style={{ ...muted, marginRight: 4 }}>written:</span><Chips counts={result.applied} /></div>}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
