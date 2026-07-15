import { describe, expect, it } from 'vitest';
import {
  contentBadges,
  formatBytes,
  groupContentUnits,
  summarizeContentCounts,
  utf8Bytes,
  type ContentUnitRow,
} from '../assist-content';

function row(partial: Partial<ContentUnitRow> & { id: string; group: ContentUnitRow['group'] }): ContentUnitRow {
  return {
    key: partial.id.split('.').slice(1).join('.'),
    title: partial.id,
    renderedIn: ['guide'],
    hasBlurb: false,
    defaultBytes: 100,
    hasOverride: false,
    hasBlurbOverride: false,
    ...partial,
  } as ContentUnitRow;
}

describe('groupContentUnits', () => {
  it('groups by server group order and PRESERVES row order within a group', () => {
    const rows = [
      row({ id: 'bootstrap.header', group: 'bootstrap' }),
      row({ id: 'guide.index', group: 'guide' }),
      row({ id: 'guide.orientation', group: 'guide' }),
      row({ id: 'guide.cross-node', group: 'guide' }),
    ];
    const groups = groupContentUnits(rows, ['bootstrap', 'guide']);
    expect(groups.map((g) => g.group)).toEqual(['bootstrap', 'guide']);
    expect(groups[1].rows.map((r) => r.id)).toEqual(['guide.index', 'guide.orientation', 'guide.cross-node']);
  });

  it('drops empty groups and appends unknown groups last', () => {
    const rows = [
      row({ id: 'zz.custom', group: 'zz' as ContentUnitRow['group'] }),
      row({ id: 'guide.data', group: 'guide' }),
    ];
    const groups = groupContentUnits(rows, ['bootstrap', 'guide']);
    expect(groups.map((g) => g.group)).toEqual(['guide', 'zz']);
  });
});

describe('contentBadges', () => {
  it('derives stored/override/blurb/bootstrap badges', () => {
    const r = row({
      id: 'guide.data', group: 'guide', rev: 3, hasOverride: true,
      hasBlurbOverride: false, renderedIn: ['guide', 'bootstrap'],
    });
    expect(contentBadges(r)).toEqual({ stored: true, override: true, blurbOverride: false, inBootstrap: true });
    expect(contentBadges(row({ id: 'guide.index', group: 'guide' }))).toEqual({
      stored: false, override: false, blurbOverride: false, inBootstrap: false,
    });
  });
});

describe('summarizeContentCounts', () => {
  it('counts a unit as overridden when EITHER field is overridden', () => {
    const rows = [
      row({ id: 'guide.a', group: 'guide', hasOverride: true }),
      row({ id: 'guide.b', group: 'guide', hasBlurbOverride: true }),
      row({ id: 'guide.c', group: 'guide' }),
    ];
    expect(summarizeContentCounts(rows)).toEqual({ units: 3, overridden: 2 });
  });
});

describe('byte helpers', () => {
  it('formatBytes renders B and KB with sane rounding', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(150 * 1024)).toBe('150 KB');
    expect(formatBytes(-5)).toBe('0 B');
  });

  it('utf8Bytes counts bytes (not code units) like the server cap', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('🙂')).toBe(4);
  });
});
