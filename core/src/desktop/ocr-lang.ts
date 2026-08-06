/**
 * OCR language auto-detection + auto-install for desktop_find_text/click_text.
 *
 * Tesseract needs to be TOLD which language(s) to read (`-l`), and it can only
 * read a language whose `<lang>.traineddata` is present. This module makes that
 * automatic and privilege-free:
 *
 *  - DETECT: run tesseract OSD (`--psm 0`, needs osd.traineddata) on the captured
 *    image to identify the SCRIPT (Han/Cyrillic/…), mapped to a tesseract lang;
 *    fall back to the system LOCALE when OSD is inconclusive; default eng.
 *  - INSTALL: ensure `<lang>.traineddata` exists in a USER-OWNED tessdata dir
 *    (~/.lm-assist/desktop[-dev]/tessdata) — copied from the system tessdata when
 *    present, else DOWNLOADED from the official tessdata_fast repo. No apt / choco
 *    / admin, identical on Linux + Windows. Cached (in-memory + on-disk).
 *
 * Every OCR run then uses `--tessdata-dir <LM_TESSDATA> -l <lang>+eng`, so the
 * user dir is the single source and always carries eng+osd plus any added langs.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const IS_DEV_REPO = process.env.LM_ASSIST_PROD === 'true' ? false : !__dirname.includes('node_modules');
const DEV_SUFFIX = IS_DEV_REPO ? '-dev' : '';
/** User-owned tessdata dir — writable without admin; the single dir OCR reads from. */
export const LM_TESSDATA = path.join(os.homedir(), '.lm-assist', `desktop${DEV_SUFFIX}`, 'tessdata');

/** tessdata_fast is the small/fast trained models — good enough for UI text. */
const TESSDATA_BASE = 'https://github.com/tesseract-ocr/tessdata_fast/raw/main';

/** OSD script name → tesseract language code (tessdata_fast names). */
export const SCRIPT_TO_LANG: Record<string, string> = {
  Han: 'chi_sim',
  HanS: 'chi_sim',
  HanT: 'chi_tra',
  Hiragana: 'jpn', Katakana: 'jpn', Japanese: 'jpn',
  Hangul: 'kor', Korean: 'kor',
  Cyrillic: 'rus',
  Arabic: 'ara',
  Greek: 'ell',
  Hebrew: 'heb',
  Thai: 'tha',
  Devanagari: 'hin',
  Latin: 'eng',
};

/** A locale prefix (from $LANG / Windows culture) → tesseract language code. */
export const LOCALE_TO_LANG: Record<string, string> = {
  zh: 'chi_sim', 'zh-tw': 'chi_tra', 'zh-hant': 'chi_tra', 'zh-hk': 'chi_tra',
  ja: 'jpn', ko: 'kor', ru: 'rus', ar: 'ara', el: 'ell', he: 'heb', th: 'tha', hi: 'hin',
  en: 'eng', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', pt: 'por', nl: 'nld', pl: 'pol',
  tr: 'tur', vi: 'vie', id: 'ind',
};

/** Langs we will auto-install (download) — the allowlist keeps it to known models. */
export const KNOWN_LANGS = new Set<string>([
  ...Object.values(SCRIPT_TO_LANG), ...Object.values(LOCALE_TO_LANG), 'osd', 'eng',
]);

function autoInstallEnabled(): boolean {
  return process.env.DESKTOP_OCR_AUTO_INSTALL !== 'off';
}

/** Locate the system tessdata dir (to copy eng/osd/langs instead of downloading). */
function systemTessdataDir(): string | null {
  if (process.env.TESSDATA_PREFIX && fs.existsSync(path.join(process.env.TESSDATA_PREFIX, 'eng.traineddata'))) return process.env.TESSDATA_PREFIX;
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Tesseract-OCR\\tessdata', 'C:\\Program Files (x86)\\Tesseract-OCR\\tessdata']
    : ['/usr/share/tesseract-ocr/5/tessdata', '/usr/share/tesseract-ocr/4.00/tessdata', '/usr/share/tessdata', '/usr/share/tesseract-ocr/tessdata', '/usr/local/share/tessdata'];
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, 'eng.traineddata'))) return c; } catch { /* skip */ }
  }
  return null;
}

const ensured = new Set<string>(); // in-memory cache of langs verified this process

/** A safe tesseract language code — the ONLY shape allowed near path.join.
 *  tesseract codes are lowercase ascii + digits + underscore (chi_sim, eng, osd).
 *  This rejects any traversal / separators BEFORE `${lang}.traineddata` is built. */
export const LANG_CODE_RE = /^[a-z0-9_]{1,32}$/;
export function isValidLangCode(l: string): boolean {
  return typeof l === 'string' && LANG_CODE_RE.test(l);
}

export interface EnsureResult { lang: string; available: boolean; source: 'present' | 'copied' | 'downloaded' | 'missing' }

/** Ensure `<lang>.traineddata` is in LM_TESSDATA. Copy from system if present,
 *  else download from tessdata_fast when auto-install is on. Cached. */
export async function ensureLang(lang: string): Promise<EnsureResult> {
  // 🔴 Validate BEFORE any path.join — `lang` is caller-supplied and both the
  // copy-from-system and the dest path derive from it; a value like "../../x"
  // would otherwise read/write outside the tessdata dir.
  if (!isValidLangCode(lang)) return { lang, available: false, source: 'missing' };
  fs.mkdirSync(LM_TESSDATA, { recursive: true });
  const dest = path.join(LM_TESSDATA, `${lang}.traineddata`);
  if (ensured.has(lang) || fs.existsSync(dest)) { ensured.add(lang); return { lang, available: true, source: 'present' }; }
  // Prefer copying from the system install (no network).
  const sys = systemTessdataDir();
  if (sys) {
    const src = path.join(sys, `${lang}.traineddata`);
    try { if (fs.existsSync(src)) { fs.copyFileSync(src, dest); ensured.add(lang); return { lang, available: true, source: 'copied' }; } } catch { /* fall through */ }
  }
  // Download (auto-install) — only known langs, only when enabled.
  if (!autoInstallEnabled() || !KNOWN_LANGS.has(lang)) return { lang, available: false, source: 'missing' };
  try {
    const res = await fetch(`${TESSDATA_BASE}/${lang}.traineddata`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return { lang, available: false, source: 'missing' };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) return { lang, available: false, source: 'missing' }; // guard against an error page
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    ensured.add(lang);
    return { lang, available: true, source: 'downloaded' };
  } catch {
    return { lang, available: false, source: 'missing' };
  }
}

/** Ensure the base models (eng + osd) are in LM_TESSDATA. */
export async function ensureBase(): Promise<void> {
  await ensureLang('eng');
  await ensureLang('osd');
}

/** Parse the SCRIPT from `tesseract --psm 0` (OSD) output. */
export function parseOsdScript(osd: string): string | null {
  const m = osd.match(/^Script:\s*(\S+)/m);
  return m ? m[1] : null;
}

/** The tesseract lang implied by the system locale ($LANG / LC_ALL / culture). */
export function localeLang(): string | null {
  const raw = (process.env.LC_ALL || process.env.LANG || process.env.LANGUAGE || '').toLowerCase();
  if (!raw) return null;
  const tag = raw.split(/[.:@]/)[0].replace('_', '-'); // en_sg.utf-8 -> en-sg
  return LOCALE_TO_LANG[tag] || LOCALE_TO_LANG[tag.split('-')[0]] || null;
}

/** Run OSD script detection on an image; returns a tesseract lang or null. */
function osdDetect(bin: string, pngPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, [pngPath, 'stdout', '--psm', '0', '--tessdata-dir', LM_TESSDATA], { timeout: 15_000, encoding: 'utf-8' }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      const script = parseOsdScript(stdout || '');
      resolve(script ? SCRIPT_TO_LANG[script] ?? null : null);
    });
  });
}

export interface DetectResult { lang: string; via: 'osd' | 'locale' | 'default'; install?: EnsureResult }

/**
 * Auto-detect the OCR language for an image: OSD script first, locale fallback,
 * default eng. Ensures the detected pack is installed (download if needed).
 * Always returns something usable (falls back to eng if the pack can't be had).
 */
export async function autoDetectLang(bin: string, pngPath: string): Promise<DetectResult> {
  await ensureBase();
  const fromOsd = await osdDetect(bin, pngPath);
  const fromLocale = fromOsd ? null : localeLang();
  const cand = fromOsd || fromLocale || 'eng';
  const via: DetectResult['via'] = fromOsd ? 'osd' : fromLocale ? 'locale' : 'default';
  if (cand === 'eng') return { lang: 'eng', via };
  const install = await ensureLang(cand);
  return { lang: install.available ? cand : 'eng', via, install };
}
