/** Code-derived assist-content catalog (design §3) — the EXHAUSTIVE enumeration of
 *  every editable content unit the bootstrap/guide tools emit, keyed by stable doc id:
 *
 *    bootstrap.header   — the bootstrap preamble
 *    guide.index        — the guide-tool index preamble + golden rules
 *    guide.<topic>      — one per GUIDES topic (body; blurb when the index lists it)
 *
 *  Derived FROM the guide module's exports, so adding/removing a topic auto-extends/
 *  shrinks the catalog — the completeness test (content-catalog.test.ts) fails the
 *  suite on any drift, exactly like the tool catalog's contract.
 *
 *  Imported by routes only (core process) — configure.ts/stdio must NOT import this
 *  (catalog.ts precedent; it pulls the full guide content module which is fine, but
 *  the rule keeps the graph auditable). */
import {
  GUIDES_TEST_EXPORT,
  GUIDE_BLURBS,
  BOOTSTRAP_SECTION_ORDER,
  BOOTSTRAP_HEADER_DEFAULT,
  INDEX_PREAMBLE_DEFAULT,
} from '../tools/guide';

export type ContentGroup = 'bootstrap' | 'guide';

export interface ContentUnit {
  id: string;
  group: ContentGroup;
  /** The key within the group (topic name, or the section name for bootstrap.*). */
  key: string;
  title: string;
  /** True when the generated guide index lists this unit with a one-liner —
   *  i.e. its doc's blurbOverride actually renders somewhere. */
  hasBlurb: boolean;
  defaultBody: string;
  defaultBlurb: string | null;
  /** Which tool outputs this unit's body appears in. */
  renderedIn: ReadonlyArray<'bootstrap' | 'guide'>;
}

/** Display order for the page's list groups. */
export const CONTENT_GROUP_ORDER: readonly ContentGroup[] = ['bootstrap', 'guide'];

let _catalog: Map<string, ContentUnit> | null = null;

export function getContentCatalog(): ReadonlyMap<string, ContentUnit> {
  if (_catalog) return _catalog;
  const m = new Map<string, ContentUnit>();
  const bootstrapSections = new Set(BOOTSTRAP_SECTION_ORDER);
  m.set('bootstrap.header', {
    id: 'bootstrap.header',
    group: 'bootstrap',
    key: 'header',
    title: 'Bootstrap preamble',
    hasBlurb: false,
    defaultBody: BOOTSTRAP_HEADER_DEFAULT,
    defaultBlurb: null,
    renderedIn: ['bootstrap'],
  });
  m.set('guide.index', {
    id: 'guide.index',
    group: 'guide',
    key: 'index',
    title: 'Guide index preamble + golden rules',
    hasBlurb: false,
    defaultBody: INDEX_PREAMBLE_DEFAULT,
    defaultBlurb: null,
    renderedIn: ['guide'],
  });
  for (const [topic, body] of Object.entries(GUIDES_TEST_EXPORT)) {
    m.set(`guide.${topic}`, {
      id: `guide.${topic}`,
      group: 'guide',
      key: topic,
      title: `Guide: ${topic}`,
      hasBlurb: topic in GUIDE_BLURBS,
      defaultBody: body,
      defaultBlurb: GUIDE_BLURBS[topic] ?? null,
      renderedIn: bootstrapSections.has(topic) ? ['guide', 'bootstrap'] : ['guide'],
    });
  }
  _catalog = m;
  return m;
}
