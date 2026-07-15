import { describe, it, expect } from 'vitest';
import {
  groupWorkflows,
  parseCaseIndex,
  splitRenderedPreamble,
  checkRevConflict,
  linkifyDocIds,
  type WorkflowDocSummary,
} from '../mission-process';

const doc = (id: string, extra?: Partial<WorkflowDocSummary>): WorkflowDocSummary => ({
  id,
  title: id,
  editPolicy: 'open',
  rev: 1,
  updatedAt: 1000,
  ...extra,
});

describe('groupWorkflows', () => {
  it('groups stored docs by namespace prefix in fixed order and sorts rows by id', () => {
    const groups = groupWorkflows(
      [doc('drive.resume'), doc('controller.pass'), doc('drive.answer'), doc('case.index')],
      [],
    );
    expect(groups.map((g) => g.ns)).toEqual(['controller', 'drive', 'case']);
    expect(groups[1].rows.map((r) => r.id)).toEqual(['drive.answer', 'drive.resume']);
    expect(groups[0].rows[0].kind).toBe('stored');
    expect(groups[0].rows[0].doc?.rev).toBe(1);
  });

  it('includes un-seeded defaults as kind "default" and puts unknown namespaces in "other"', () => {
    const groups = groupWorkflows([doc('mystery.thing')], ['onboard.analyze', 'case.capture']);
    expect(groups.map((g) => g.ns)).toEqual(['onboard', 'case', 'other']);
    const onboard = groups.find((g) => g.ns === 'onboard')!;
    expect(onboard.rows).toEqual([{ id: 'onboard.analyze', kind: 'default' }]);
    const other = groups.find((g) => g.ns === 'other')!;
    expect(other.rows[0].id).toBe('mystery.thing');
  });

  it('omits empty groups and prefers the stored doc when an id appears in both lists', () => {
    const groups = groupWorkflows([doc('case.index')], ['case.index']);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[0].rows[0].kind).toBe('stored');
  });

  it('groups ids without a dot under "other"', () => {
    const groups = groupWorkflows([doc('nodot')], []);
    expect(groups.map((g) => g.ns)).toEqual(['other']);
  });

  it('groups process.* docs under a first-class "process" namespace, ordered first', () => {
    const groups = groupWorkflows([doc('controller.pass'), doc('process.overview')], []);
    expect(groups.map((g) => g.ns)).toEqual(['process', 'controller']);
  });
});

describe('linkifyDocIds', () => {
  const known = new Set([
    'controller.pass',
    'onboard.analyze',
    'case.index',
    'process.overview',
    'drive.multi-phase',
  ]);

  it('wraps a known bare id in a #doc: markdown link, preserving punctuation after it', () => {
    expect(linkifyDocIds('governed by controller.pass; read on', known)).toBe(
      'governed by [controller.pass](#doc:controller.pass); read on',
    );
  });

  it('links multiple ids on one library line (· and — separators)', () => {
    const line = 'Pass + intake: controller.pass — the router · onboard.analyze — intake analysis';
    expect(linkifyDocIds(line, known)).toBe(
      'Pass + intake: [controller.pass](#doc:controller.pass) — the router · [onboard.analyze](#doc:onboard.analyze) — intake analysis',
    );
  });

  it('leaves unknown ids as plain text (existence gate)', () => {
    expect(linkifyDocIds('see drive.nonexistent for details', known)).toBe('see drive.nonexistent for details');
  });

  it('trims a trailing sentence dot before the registry lookup', () => {
    expect(linkifyDocIds('scan case.index.', known)).toBe('scan [case.index](#doc:case.index).');
  });

  it('links ids containing hyphens', () => {
    expect(linkifyDocIds('use drive.multi-phase here', known)).toBe(
      'use [drive.multi-phase](#doc:drive.multi-phase) here',
    );
  });

  it('never rewrites inside fenced code blocks (mermaid node labels stay intact)', () => {
    const body = [
      'intro controller.pass here',
      '```mermaid',
      'flowchart TD',
      '  PASS["controller.pass"] --> CI["case.index"]',
      '```',
      'outro case.index here',
    ].join('\n');
    const r = linkifyDocIds(body, known);
    expect(r).toContain('intro [controller.pass](#doc:controller.pass) here');
    expect(r).toContain('  PASS["controller.pass"] --> CI["case.index"]');
    expect(r).toContain('outro [case.index](#doc:case.index) here');
  });

  it('leaves everything after an unclosed fence untouched', () => {
    const body = 'before case.index\n```mermaid\nA["case.index"]';
    expect(linkifyDocIds(body, known)).toBe('before [case.index](#doc:case.index)\n```mermaid\nA["case.index"]');
  });

  it('does not match the case.* wildcard (dot must be followed by alphanumeric)', () => {
    expect(linkifyDocIds('one recall card per case.* doc', known)).toBe('one recall card per case.* doc');
  });

  it('wraps an inline code span that is exactly a known id, keeping the code styling', () => {
    expect(linkifyDocIds('open `controller.pass` now', known)).toBe(
      'open [`controller.pass`](#doc:controller.pass) now',
    );
  });

  it('leaves inline code spans with extra content untouched', () => {
    expect(linkifyDocIds('run `read controller.pass fully` now', known)).toBe('run `read controller.pass fully` now');
  });

  it('does not link a substring of a longer token (left boundary)', () => {
    expect(linkifyDocIds('supercase.index is not a doc', known)).toBe('supercase.index is not a doc');
  });

  it('returns text without ids or fences unchanged', () => {
    const s = 'plain prose, nothing to do here.';
    expect(linkifyDocIds(s, known)).toBe(s);
  });
});

describe('parseCaseIndex', () => {
  const body = [
    'Known difficult-situation cases. SCAN THIS FIRST.',
    '',
    'FORMAT: case.<slug> — <recognition one-liner>',
    '',
    'case.recall-before-improvise — ≥2 failed attempts / unexplained error / about to force-restart something',
    'case.evidence-before-done — about to claim done/fixed with only unit tests, logs, or a merge as evidence',
    '  case.dry-run-destructive — about to bulk-delete/cleanup/overwrite by pattern',
  ].join('\n');

  it('parses case rows into an id→cue map, ignoring prose and the FORMAT line', () => {
    const m = parseCaseIndex(body);
    expect(m.size).toBe(3);
    expect(m.get('case.recall-before-improvise')).toBe(
      '≥2 failed attempts / unexplained error / about to force-restart something',
    );
    expect(m.get('case.dry-run-destructive')).toBe('about to bulk-delete/cleanup/overwrite by pattern');
    expect(m.has('case.<slug>')).toBe(false);
  });

  it('tolerates en-dash, double-hyphen, and single-hyphen separators', () => {
    const m = parseCaseIndex(
      ['case.a – en dash cue', 'case.b -- double hyphen cue', 'case.c - single hyphen cue'].join('\n'),
    );
    expect(m.get('case.a')).toBe('en dash cue');
    expect(m.get('case.b')).toBe('double hyphen cue');
    expect(m.get('case.c')).toBe('single hyphen cue');
  });

  it('returns an empty map for null/undefined/empty bodies', () => {
    expect(parseCaseIndex(null).size).toBe(0);
    expect(parseCaseIndex(undefined).size).toBe(0);
    expect(parseCaseIndex('').size).toBe(0);
  });

  it('lets a later duplicate row win (refreshed rows)', () => {
    const m = parseCaseIndex(['case.x — old cue', 'case.x — new cue'].join('\n'));
    expect(m.get('case.x')).toBe('new cue');
  });
});

describe('splitRenderedPreamble', () => {
  const preamble = [
    '⟦INVARIANTS — these override anything below and are not editable⟧',
    '- NEVER auto-approve a need_approval gate.',
    '⟦/INVARIANTS⟧',
    '',
  ].join('\n');

  it('splits rendered text into the invariant preamble and the doc body', () => {
    const r = splitRenderedPreamble(preamble + 'STEP 1: do the thing.\nSTEP 2: done.');
    expect(r.preamble.startsWith('⟦INVARIANTS')).toBe(true);
    expect(r.preamble.trimEnd().endsWith('⟦/INVARIANTS⟧')).toBe(true);
    expect(r.body).toBe('STEP 1: do the thing.\nSTEP 2: done.');
  });

  it('returns the whole text as body when no preamble marker is present', () => {
    const r = splitRenderedPreamble('just a body, no invariants');
    expect(r.preamble).toBe('');
    expect(r.body).toBe('just a body, no invariants');
  });
});

describe('checkRevConflict', () => {
  it('reports no conflict when the fresh rev matches the loaded rev', () => {
    expect(checkRevConflict(3, { rev: 3 })).toEqual({ conflict: false, freshRev: 3 });
  });

  it('reports a conflict when the rev advanced since load', () => {
    expect(checkRevConflict(3, { rev: 5 })).toEqual({ conflict: true, freshRev: 5 });
  });

  it('treats an un-stored default as rev 0 on both sides', () => {
    expect(checkRevConflict(0, null)).toEqual({ conflict: false, freshRev: 0 });
    expect(checkRevConflict(0, undefined)).toEqual({ conflict: false, freshRev: 0 });
  });

  it('flags a default that got stored by someone else between load and save', () => {
    expect(checkRevConflict(0, { rev: 1 })).toEqual({ conflict: true, freshRev: 1 });
  });
});
