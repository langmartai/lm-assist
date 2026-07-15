/**
 * Content catalog — EXHAUSTIVE enumeration from the code (gate guardrail 2):
 * every editable content string the bootstrap + guide tools emit maps to a stable
 * doc id/field, and the catalog is exactly the code-derived set (no silent gaps,
 * no phantom ids). Mirrors the mcp-tool-catalog completeness contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getContentCatalog, CONTENT_GROUP_ORDER } from '../mcp-server/registry/content-catalog';
import { validateContentId } from '../mcp-server/registry/content-model';
import {
  GUIDES_TEST_EXPORT,
  BOOTSTRAP_SECTION_ORDER,
  BOOTSTRAP_HEADER_DEFAULT,
  INDEX_PREAMBLE_DEFAULT,
  GUIDE_BLURBS,
} from '../mcp-server/tools/guide';

test('catalog ids are EXACTLY the code-derived set (overview + bootstrap.header + guide.index + one per topic)', () => {
  const catalog = getContentCatalog();
  const expected = new Set<string>([
    'content.overview',
    'bootstrap.header',
    'guide.index',
    ...Object.keys(GUIDES_TEST_EXPORT).map((k) => `guide.${k}`),
  ]);
  assert.deepEqual(new Set(catalog.keys()), expected);
  // topics + the two composition preambles + the generated overview map — a topic
  // added to GUIDES auto-extends this set; a removed topic shrinks it.
  assert.equal(catalog.size, Object.keys(GUIDES_TEST_EXPORT).length + 3);
});

test('content.overview SHOWS ALL: its generated body names every other unit id as a #doc: link', () => {
  const catalog = getContentCatalog();
  const body = catalog.get('content.overview')!.defaultBody;
  for (const id of catalog.keys()) {
    if (id === 'content.overview') continue;
    assert.ok(body.includes(`(#doc:${id})`), `overview must link ${id}`);
  }
  assert.ok(body.includes('```mermaid'), 'overview carries the map diagram');
  assert.deepEqual(catalog.get('content.overview')!.renderedIn, [], 'overview is a page map — never shipped in tool output');
});

test('every catalog id passes the model id grammar', () => {
  for (const id of getContentCatalog().keys()) {
    assert.equal(validateContentId(id).ok, true, `${id} must satisfy the grammar`);
  }
});

test('every bootstrap SECTION maps to a unit rendered in bootstrap (nothing silently code-only)', () => {
  const catalog = getContentCatalog();
  assert.ok(BOOTSTRAP_SECTION_ORDER.length >= 20, 'bootstrap has the full section list');
  for (const key of BOOTSTRAP_SECTION_ORDER) {
    assert.ok(GUIDES_TEST_EXPORT[key], `bootstrap section "${key}" must be a GUIDES topic`);
    const unit = catalog.get(`guide.${key}`);
    assert.ok(unit, `guide.${key} present`);
    assert.ok(unit!.renderedIn.includes('bootstrap'), `guide.${key} marked as rendered in bootstrap`);
    assert.ok(unit!.renderedIn.includes('guide'));
  }
  const header = catalog.get('bootstrap.header')!;
  assert.equal(header.group, 'bootstrap');
  assert.deepEqual([...header.renderedIn], ['bootstrap']);
  assert.equal(header.defaultBody, BOOTSTRAP_HEADER_DEFAULT);
});

test('mission-controller is a guide-only unit (deliberately NOT in bootstrap)', () => {
  const unit = getContentCatalog().get('guide.mission-controller')!;
  assert.ok(unit);
  assert.equal(unit.renderedIn.includes('bootstrap'), false);
  assert.ok(unit.renderedIn.includes('guide'));
  assert.equal(BOOTSTRAP_SECTION_ORDER.includes('mission-controller'), false);
});

test('guide.index carries the index preamble (golden rules editable; topic list stays generated)', () => {
  const unit = getContentCatalog().get('guide.index')!;
  assert.equal(unit.group, 'guide');
  assert.deepEqual([...unit.renderedIn], ['guide']);
  assert.equal(unit.defaultBody, INDEX_PREAMBLE_DEFAULT);
  assert.match(unit.defaultBody, /Golden rules/);
  assert.ok(!unit.defaultBody.includes('## Topics'), 'generated topic list is NOT part of the editable unit');
});

test('every topic BLURB is editable on its owning unit (index one-liners are content too)', () => {
  const catalog = getContentCatalog();
  // exhaustiveness both ways: every topic has a blurb, every blurb belongs to a topic
  assert.deepEqual(Object.keys(GUIDE_BLURBS).sort(), Object.keys(GUIDES_TEST_EXPORT).sort());
  for (const [key, blurb] of Object.entries(GUIDE_BLURBS)) {
    const unit = catalog.get(`guide.${key}`)!;
    assert.equal(unit.hasBlurb, true, `guide.${key} exposes its blurb`);
    assert.equal(unit.defaultBlurb, blurb);
  }
  assert.equal(catalog.get('bootstrap.header')!.hasBlurb, false);
  assert.equal(catalog.get('guide.index')!.hasBlurb, false);
});

test('units carry non-empty titles + defaults; group order is bootstrap-first', () => {
  assert.deepEqual([...CONTENT_GROUP_ORDER], ['overview', 'bootstrap', 'guide']);
  for (const unit of getContentCatalog().values()) {
    assert.ok(unit.title.length > 0, `${unit.id} has a title`);
    assert.ok(unit.defaultBody.length > 0, `${unit.id} has a code default`);
    assert.ok(unit.group === 'overview' || unit.group === 'bootstrap' || unit.group === 'guide');
    const prefix = unit.group === 'bootstrap' ? 'bootstrap' : unit.group === 'overview' ? 'content' : 'guide';
    assert.equal(unit.id, `${prefix}.${unit.key}`);
  }
});
