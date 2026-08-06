import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOsdScript, localeLang, isValidLangCode, ensureLang, SCRIPT_TO_LANG, LOCALE_TO_LANG, KNOWN_LANGS } from '../desktop/ocr-lang';

/**
 * OCR language auto-detection maps + parsers (pure). The download/copy paths
 * (ensureLang) touch the network/filesystem and are covered by live e2e, not here.
 */

test('parseOsdScript extracts the Script line from tesseract OSD output', () => {
  const osd = 'Page number: 0\nOrientation in degrees: 0\nScript: Han\nScript confidence: 3.14\n';
  assert.strictEqual(parseOsdScript(osd), 'Han');
  assert.strictEqual(parseOsdScript('no script here'), null);
});

test('SCRIPT_TO_LANG maps the scripts we care about to tessdata_fast codes', () => {
  assert.strictEqual(SCRIPT_TO_LANG.Han, 'chi_sim');
  assert.strictEqual(SCRIPT_TO_LANG.Cyrillic, 'rus');
  assert.strictEqual(SCRIPT_TO_LANG.Hangul, 'kor');
  assert.strictEqual(SCRIPT_TO_LANG.Latin, 'eng');
});

test('localeLang maps $LANG to a tesseract code, prefix-fallback', (t) => {
  const save = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE };
  t.after(() => { process.env.LANG = save.LANG; process.env.LC_ALL = save.LC_ALL; process.env.LANGUAGE = save.LANGUAGE; });
  delete process.env.LC_ALL; delete process.env.LANGUAGE;
  process.env.LANG = 'zh_CN.UTF-8';
  assert.strictEqual(localeLang(), 'chi_sim');
  process.env.LANG = 'ja_JP.UTF-8';
  assert.strictEqual(localeLang(), 'jpn');
  process.env.LANG = 'en_SG.UTF-8';
  assert.strictEqual(localeLang(), 'eng');
  process.env.LANG = 'zz_ZZ.UTF-8'; // unknown
  assert.strictEqual(localeLang(), null);
});

test('KNOWN_LANGS (auto-install allowlist) includes the detected langs + base', () => {
  for (const l of ['chi_sim', 'jpn', 'kor', 'rus', 'eng', 'osd']) assert.ok(KNOWN_LANGS.has(l), `${l} should be installable`);
});

test('isValidLangCode accepts real codes and rejects path traversal', () => {
  for (const ok of ['eng', 'chi_sim', 'chi_tra', 'jpn', 'osd']) assert.ok(isValidLangCode(ok), ok);
  for (const bad of ['../eng', '../../etc/passwd', 'a/b', 'a\\b', 'a b', 'a.b', '', 'ABC', 'x'.repeat(33)]) assert.ok(!isValidLangCode(bad), bad);
});

test('ensureLang refuses a traversal code without touching the filesystem', async () => {
  const r = await ensureLang('../../../etc/shadow');
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.source, 'missing');
});
