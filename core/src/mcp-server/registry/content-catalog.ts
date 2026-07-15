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

export type ContentGroup = 'overview' | 'bootstrap' | 'guide';

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

/** Display order for the page's list groups — overview pinned first (process.overview precedent). */
export const CONTENT_GROUP_ORDER: readonly ContentGroup[] = ['overview', 'bootstrap', 'guide'];

/** The content map — GENERATED from the catalog inputs so it provably SHOWS ALL units and
 *  auto-extends when a topic is added (the completeness test pins body ⊇ every unit id).
 *  A unit like any other (overridable via the registry); rendered nowhere by the tools —
 *  it is the page's start-here map, mirroring process.overview. */
function buildOverviewBody(): string {
  const topics = Object.keys(GUIDES_TEST_EXPORT);
  const inBootstrap = BOOTSTRAP_SECTION_ORDER.filter((t) => topics.includes(t));
  const guideOnly = topics.filter((t) => !inBootstrap.includes(t));
  const chip = (id: string) => `[\`${id}\`](#doc:${id})`;
  const nid = (t: string) => 'n_' + t.replace(/[^a-zA-Z0-9]/g, '_');

  const mer: string[] = ['flowchart TD'];
  mer.push('  CALLER["any Claude session (connector / hook / controller)"] --> BT["bootstrap tool (call once)"]');
  mer.push('  CALLER --> GT["guide(topic=...) tool"]');
  mer.push('  BT --> BH["bootstrap.header"]');
  mer.push('  GT --> GI["guide.index (preamble + golden rules + topic list)"]');
  mer.push('  subgraph SHIP["§bootstrap sections — ship order, every session"]');
  mer.push('    direction TB');
  let prev = '';
  for (const t of inBootstrap) {
    mer.push(`    ${nid(t)}["guide.${t}"]`);
    if (prev) mer.push(`    ${prev} --> ${nid(t)}`);
    prev = nid(t);
  }
  mer.push('  end');
  mer.push('  BH --> SHIP');
  mer.push('  subgraph ONDEMAND["guide-only topics — served on request"]');
  mer.push('    direction TB');
  for (const t of guideOnly) mer.push(`    ${nid(t)}["guide.${t}"]`);
  mer.push('  end');
  mer.push('  GI --> ONDEMAND');
  mer.push('  GT -.->|"same topics"| SHIP');
  mer.push('  PAGE["/assist-content page"] -->|"override any unit"| REG["fleet content registry (rev history + rollback)"]');
  mer.push('  REG -->|"override ?? code default, LIVE (no restart)"| BT & GT');

  const lines: string[] = [
    '# Content map — every bootstrap/guide unit',
    '',
    'The complete library the MCP onboarding surface serves: `bootstrap` ships the header plus the §bootstrap sections below in order into EVERY session that calls it; `guide(topic=...)` serves any single topic on demand. Every box is an editable unit — open it from the list (the chips below link directly), override it, and BOTH tools serve the change live, fleet-wide, no deploy. This map is generated from the code catalog, so it always shows all units.',
    '',
    '```mermaid',
    ...mer,
    '```',
    '',
    '## Every unit (click to open)',
    `- ${chip('bootstrap.header')} — Bootstrap preamble`,
    `- ${chip('guide.index')} — Guide index preamble + golden rules`,
    ...inBootstrap.map((t) => `- ${chip(`guide.${t}`)} — ${GUIDE_BLURBS[t] ?? `Guide: ${t}`} *(§bootstrap)*`),
    ...guideOnly.map((t) => `- ${chip(`guide.${t}`)} — ${GUIDE_BLURBS[t] ?? `Guide: ${t}`}`),
    '',
  ];
  return lines.join('\n');
}

let _catalog: Map<string, ContentUnit> | null = null;

export function getContentCatalog(): ReadonlyMap<string, ContentUnit> {
  if (_catalog) return _catalog;
  const m = new Map<string, ContentUnit>();
  const bootstrapSections = new Set(BOOTSTRAP_SECTION_ORDER);
  m.set('content.overview', {
    id: 'content.overview',
    group: 'overview',
    key: 'overview',
    title: 'Content map — the whole bootstrap/guide library',
    hasBlurb: false,
    defaultBody: buildOverviewBody(),
    defaultBlurb: null,
    renderedIn: [],
  });
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
