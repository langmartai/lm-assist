/**
 * Self-contained RFC822 / MIME parser for the lm-assist Gmail connector.
 *
 * WHY THIS EXISTS
 * ---------------
 * Gmail's rendered DOM is a lossy view of a message: long messages are clipped
 * ("[Message clipped]") and quoted text is hidden behind a trimmed-content toggle, so
 * scraping `.a3s` innerText yields incomplete content. The COMPLETE message is available
 * from inside the logged-in page at:
 *
 *     /mail/u/0/?ui=2&ik=<ik>&view=om&th=<legacyThreadId>
 *
 * which returns an HTML page titled "Original Message" whose single `<pre>` holds the full
 * raw RFC822 source. That page enforces Trusted Types, so `DOMParser.parseFromString` and
 * `innerHTML` both THROW inside it — the `<pre>` must be recovered by regex from the HTML
 * text and its entities decoded manually. `extractPreFromOriginalPage()` does exactly that.
 *
 * DESIGN RULES
 * ------------
 * - Node built-ins only. No dependencies. No `console.*`.
 * - Never throws on malformed input. Whatever was parseable comes back, and anything the
 *   parser had to guess is recorded in `headers['x-parse-warning']` (semicolon-separated
 *   codes). Callers that care about fidelity should read that field.
 * - Both CRLF and bare-LF input are accepted; line endings are normalised to LF before any
 *   structural parsing. Consequence: a non-base64 8bit/binary attachment would have its CR
 *   bytes rewritten. In practice attachments on the wire are base64 (and this page delivers
 *   HTML text anyway), so this is a theoretical loss; it is flagged as
 *   `binary-part-newline-normalised` when it can happen.
 *
 * FIELD CONVENTIONS (read these — they are choices, not standards)
 * ---------------------------------------------------------------
 * - `messageId`, `inReplyTo` and every entry of `references` have their angle brackets
 *   STRIPPED, so they compare directly against each other. Re-add `<`/`>` when emitting.
 * - `date` is the RAW (unfolded) Date header, not an ISO string; `dateMs` is the epoch.
 * - `headers` holds UNFOLDED but otherwise RAW values — RFC2047 encoded-words are NOT
 *   decoded there. The typed fields (`subject`, `from`, `to`, `cc`) are decoded. Use the
 *   exported `decodeEncodedWord()` on any other header you need decoded. A header that
 *   appears more than once (`Received:`, …) has its values joined with `\n`, first-seen
 *   first; the typed fields always come from the FIRST occurrence.
 * - `textBody` is `''` — never null — when the message carries no text/plain part. That is
 *   common (html-only mail) and is reported as `no-text-plain-part`; the caller should fall
 *   back to `htmlBody`. This module deliberately does NOT strip HTML to fake a text body.
 */

import { Buffer } from 'node:buffer';

/* ────────────────────────────── public types ────────────────────────────── */

export interface MimeAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number; // decoded size, best effort
  contentId: string | null; // for inline images (cid:), angle brackets stripped
  inline: boolean; // Content-Disposition: inline (or bare Content-ID)
  encoding: string; // base64 | quoted-printable | 7bit | ...
  /** Decoded bytes. Populated only when includeContent is requested. */
  content?: Buffer;
}

export interface MimeAddress {
  name: string | null;
  email: string | null;
}

export interface MimeMessage {
  messageId: string | null;
  from: MimeAddress | null;
  to: MimeAddress[];
  cc: MimeAddress[];
  subject: string | null;
  date: string | null;
  dateMs: number | null;
  inReplyTo: string | null;
  references: string[];
  textBody: string; // decoded text/plain (COMPLETE, not clipped)
  htmlBody: string | null; // decoded text/html
  attachments: MimeAttachment[];
  headers: Record<string, string>; // all top-level headers, lowercased keys
}

export interface ParseOptions {
  /** Decode attachment bytes into `MimeAttachment.content`. Off by default (memory). */
  includeContent?: boolean;
}

/* ────────────────────────────── limits ────────────────────────────── */

const MAX_BODY_CHARS = 200_000;
const MAX_ATTACHMENTS = 25;
const MAX_MIME_DEPTH = 20;
const MAX_PARTS = 500;
const MAX_MESSAGES = 200;
const MAX_HEADER_LINES = 2000;
const MAX_ADDRESSES = 500;
const MAX_WARNINGS = 40;

/* ────────────────────────────── warnings ────────────────────────────── */

type Warn = (code: string) => void;

interface WarnBag {
  warn: Warn;
  list(): string[];
}

function makeWarnBag(): WarnBag {
  const seen = new Set<string>();
  return {
    warn(code: string): void {
      if (seen.size < MAX_WARNINGS) seen.add(code);
    },
    list(): string[] {
      return Array.from(seen);
    },
  };
}

const NOOP_WARN: Warn = () => {
  /* the standalone exported helpers have nowhere to report to */
};

/* ────────────────────────────── charsets ────────────────────────────── */

/** windows-1252 differs from latin1 only across 0x80–0x9F; this is that range. */
const CP1252_C1 = [
  '\u20AC', '\u0081', '\u201A', '\u0192', '\u201E', '\u2026', '\u2020', '\u2021',
  '\u02C6', '\u2030', '\u0160', '\u2039', '\u0152', '\u008D', '\u017D', '\u008F',
  '\u0090', '\u2018', '\u2019', '\u201C', '\u201D', '\u2022', '\u2013', '\u2014',
  '\u02DC', '\u2122', '\u0161', '\u203A', '\u0153', '\u009D', '\u017E', '\u0178',
];

function normalizeCharset(cs: string | undefined | null): string {
  if (!cs) return 'utf-8';
  let c = String(cs).trim().toLowerCase();
  if (c.startsWith('"') && c.endsWith('"') && c.length > 1) c = c.slice(1, -1);
  if (c.startsWith("'") && c.endsWith("'") && c.length > 1) c = c.slice(1, -1);
  const star = c.indexOf('*'); // RFC2231 charset*lang
  if (star > 0) c = c.slice(0, star);
  return c.trim() || 'utf-8';
}

function isUtf8Charset(cs: string): boolean {
  const c = normalizeCharset(cs);
  return c === 'utf-8' || c === 'utf8' || c === 'unicode-1-1-utf-8' || c === 'utf_8' || c === 'utf 8';
}

/** Decode bytes with a declared charset. Never throws; unknown charsets fall back to UTF-8. */
function decodeBytes(buf: Buffer, charset: string | undefined, warn: Warn): string {
  const cs = normalizeCharset(charset);
  try {
    if (isUtf8Charset(cs)) return stripBom(buf.toString('utf8'));

    switch (cs) {
      case 'us-ascii':
      case 'ascii':
      case 'iso-ir-6':
      case 'ansi_x3.4-1968':
      case 'ibm367':
        // latin1, not 'ascii': Node's 'ascii' masks the high bit and silently mangles
        // the 8-bit bytes that mislabelled us-ascii mail routinely carries.
        return stripBom(buf.toString('latin1'));

      case 'iso-8859-1':
      case 'iso_8859-1':
      case 'iso8859-1':
      case '8859-1':
      case 'latin1':
      case 'l1':
      case 'cp819':
      case 'binary':
        return stripBom(buf.toString('latin1'));

      case 'windows-1252':
      case 'cp1252':
      case 'win-1252':
      case 'x-cp1252':
      case 'ansi':
        return stripBom(cp1252ToString(buf));

      case 'iso-8859-15':
      case 'latin9':
      case 'iso_8859-15':
        warn('charset-approximated:iso-8859-15->latin1');
        return stripBom(buf.toString('latin1'));

      case 'utf-16le':
      case 'utf16le':
      case 'ucs-2':
      case 'ucs2':
        return stripBom(buf.toString('utf16le'));

      case 'utf-16':
        // BOM sniff; default to BE per RFC2781 when unmarked.
        if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return stripBom(buf.toString('utf16le'));
        if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return stripBom(swap16(buf).toString('utf16le'));
        return stripBom(buf.toString('utf16le'));

      case 'utf-16be':
      case 'utf16be':
        return stripBom(swap16(buf).toString('utf16le'));

      default: {
        if (Buffer.isEncoding(cs)) return stripBom(buf.toString(cs as BufferEncoding));
        warn(`unknown-charset:${cs}->utf-8`);
        return stripBom(buf.toString('utf8'));
      }
    }
  } catch {
    warn(`charset-decode-failed:${cs}`);
    try {
      return buf.toString('utf8');
    } catch {
      return '';
    }
  }
}

function cp1252ToString(buf: Buffer): string {
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    out += b >= 0x80 && b <= 0x9f ? CP1252_C1[b - 0x80] : String.fromCharCode(b);
  }
  return out;
}

function swap16(buf: Buffer): Buffer {
  const even = buf.length - (buf.length % 2);
  const out = Buffer.allocUnsafe(even);
  for (let i = 0; i + 1 < even; i += 2) {
    out[i] = buf[i + 1];
    out[i + 1] = buf[i];
  }
  return out;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/* ────────────────────────── HTML entities + <pre> ────────────────────────── */

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  // A raw RFC822 source has no reason to contain U+00A0; in a <pre> dump an &nbsp; is
  // overwhelmingly a rendered plain space, and mapping it to U+00A0 would break header
  // continuation detection (which keys on SP/HTAB). Map it to a plain space.
  nbsp: ' ',
  tab: '\t',
  newline: '\n',
};

const ENTITY_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g;

/**
 * Decode HTML entities in ONE pass, so `&amp;lt;` correctly yields `&lt;` rather than `<`.
 */
function decodeHtmlEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(ENTITY_RE, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    try {
      if (dec !== undefined) {
        const cp = Number.parseInt(dec, 10);
        return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
      }
      if (hex !== undefined) {
        const cp = Number.parseInt(hex, 16);
        return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
      }
      if (name !== undefined) {
        const hit = NAMED_ENTITIES[name.toLowerCase()];
        return hit === undefined ? whole : hit;
      }
    } catch {
      return whole;
    }
    return whole;
  });
}

/**
 * Pull the raw RFC822 source out of Gmail's "Original Message" (`view=om`) HTML page.
 *
 * Regex-only by necessity: that page enforces Trusted Types, so `DOMParser.parseFromString`
 * and `innerHTML` both throw inside it.
 *
 * If several `<pre>` blocks are present the LONGEST wins — the raw source dwarfs anything
 * else Gmail might emit. Returns null when the page has no `<pre>` at all (a login wall, an
 * error page, or a changed layout), which the caller should treat as "fetch failed", not as
 * "empty message".
 */
export function extractPreFromOriginalPage(html: string): string | null {
  if (typeof html !== 'string' || html.length === 0) return null;

  const re = /<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi;
  let best: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const inner = m[1];
    if (best === null || inner.length > best.length) best = inner;
  }
  if (best === null) return null;

  // HTML parsers drop a single newline immediately after <pre>; mirror that.
  best = best.replace(/^\r?\n/, '');
  // Defensive: any tag surviving in here is markup, since real source characters would be
  // entity-escaped. Only <br>/<wbr> are plausible and only these two are touched.
  best = best.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?wbr\s*\/?>/gi, '');

  return decodeHtmlEntities(best);
}

/* ────────────────────── transfer encodings (bytes level) ────────────────────── */

function isBase64Char(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2b || // +
    code === 0x2f || // /
    code === 0x2d || // - (url-safe)
    code === 0x5f // _ (url-safe)
  );
}

function base64ToBuffer(input: string): Buffer {
  // Node's base64 decoder already skips unknown characters, but doing it explicitly keeps
  // the size estimate below in agreement with the real decode.
  let clean = '';
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (isBase64Char(c) || c === 0x3d) clean += input[i];
  }
  clean = clean.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Buffer.from(clean, 'base64');
  } catch {
    return Buffer.alloc(0);
  }
}

/** Exact decoded length of a base64 blob without allocating the decoded buffer. */
function base64DecodedSize(input: string): number {
  let n = 0;
  let pad = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c === 0x3d) {
      pad++;
      n++;
    } else if (isBase64Char(c)) {
      n++;
    }
  }
  return Math.max(0, Math.floor((n * 3) / 4) - Math.min(pad, 2));
}

/**
 * Quoted-printable → bytes.
 *
 * `underscoreAsSpace` is the RFC2047 "Q" variant used in HEADERS only; QP BODIES leave `_`
 * alone. Soft line breaks (`=` at end of line, optionally with trailing whitespace, CRLF or
 * LF) are removed. A malformed `=` that is not followed by two hex digits is kept literally
 * rather than dropped — mail from broken senders stays readable.
 *
 * Characters in 0x80–0xFF are emitted as single latin1 bytes (not UTF-8 expanded). That is
 * what makes both provenances work: a byte-provenance string carries its original bytes
 * one-per-char, and an already-decoded latin1/1252 string round-trips exactly.
 */
function qpToBuffer(input: string, underscoreAsSpace: boolean): Buffer {
  const src = input.replace(/=[ \t]*\r?\n/g, '');
  const out = Buffer.allocUnsafe(Buffer.byteLength(src, 'utf8') + 4);
  let n = 0;

  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i);

    if (code === 0x3d) {
      const hex = src.slice(i + 1, i + 3);
      if (hex.length === 2 && /^[0-9A-Fa-f]{2}$/.test(hex)) {
        out[n++] = Number.parseInt(hex, 16);
        i += 2;
        continue;
      }
      out[n++] = 0x3d; // malformed escape: keep the '='
      continue;
    }

    if (underscoreAsSpace && code === 0x5f) {
      out[n++] = 0x20;
      continue;
    }

    if (code <= 0xff) {
      out[n++] = code;
      continue;
    }

    // > U+00FF can only appear when the caller handed us already-decoded text; keep its
    // UTF-8 bytes (surrogate pairs taken together so astral chars survive).
    let ch = src[i];
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < src.length) {
      const next = src.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        ch = src.slice(i, i + 2);
        i++;
      }
    }
    const bytes = Buffer.from(ch, 'utf8');
    for (let b = 0; b < bytes.length && n < out.length; b++) out[n++] = bytes[b];
  }

  return out.subarray(0, n);
}

/**
 * Decode a quoted-printable BODY (soft line breaks honoured, `_` left alone) using `charset`.
 * Defaults to UTF-8. Never throws.
 */
export function decodeQuotedPrintable(s: string, charset?: string): string {
  if (typeof s !== 'string' || s.length === 0) return '';
  try {
    return decodeBytes(qpToBuffer(s, false), charset ?? 'utf-8', NOOP_WARN);
  } catch {
    return s;
  }
}

/* ────────────────────────────── RFC 2047 ────────────────────────────── */

// The encoded-text of an encoded-word may not contain '?' — base64's alphabet excludes it
// and Q-encoding must escape it as =3F — so [^?]* is both safe and greedy-proof.
const ENCODED_WORD_RE = /=\?([^?\s]{1,120})\?([BbQq])\?([^?]*)\?=/g;

interface EwToken {
  kind: 'ew';
  charset: string;
  bytes: Buffer;
}
interface TxToken {
  kind: 'text';
  text: string;
}
type Rfc2047Token = EwToken | TxToken;

/**
 * Decode RFC2047 encoded-words in a header value. Handles both `B` (base64) and `Q`
 * (quoted-printable with `_` as space) forms and any charset `decodeBytes` knows.
 *
 * Two subtleties that most naive implementations get wrong, and that the MEASURED Gmail
 * subject exercises:
 *
 *  1. Whitespace SEPARATING two adjacent encoded-words is not data — RFC2047 §6.2 says it
 *     must be dropped. (`=?UTF-8?Q?a?= =?UTF-8?Q?b?=` is "ab", not "a b".) Whitespace
 *     around a *plain* run is kept.
 *  2. A multi-byte character may be SPLIT across two encoded-words. Decoding each word to a
 *     string independently yields U+FFFD; this decoder concatenates the BYTES of adjacent
 *     same-charset words and decodes the run once, so the split character reassembles.
 */
export function decodeEncodedWord(s: string): string {
  return decodeEncodedWordWith(s, NOOP_WARN);
}

function decodeEncodedWordWith(s: string, warn: Warn): string {
  if (typeof s !== 'string' || s.length === 0) return '';
  if (s.indexOf('=?') === -1) return s;

  const tokens: Rfc2047Token[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  ENCODED_WORD_RE.lastIndex = 0;

  while ((m = ENCODED_WORD_RE.exec(s)) !== null) {
    if (m.index > last) tokens.push({ kind: 'text', text: s.slice(last, m.index) });
    const charset = normalizeCharset(m[1]);
    const enc = m[2].toUpperCase();
    let bytes: Buffer;
    try {
      bytes = enc === 'B' ? base64ToBuffer(m[3]) : qpToBuffer(m[3], true);
    } catch {
      warn('encoded-word-undecodable');
      bytes = Buffer.from(m[3], 'latin1');
    }
    tokens.push({ kind: 'ew', charset, bytes });
    last = m.index + m[0].length;
  }

  if (tokens.length === 0) return s;
  if (last < s.length) tokens.push({ kind: 'text', text: s.slice(last) });

  const out: string[] = [];
  let pendingBytes: Buffer[] = [];
  let pendingCharset: string | null = null;
  let prevWasEncodedWord = false;

  const flush = (): void => {
    if (pendingCharset !== null) {
      out.push(decodeBytes(Buffer.concat(pendingBytes), pendingCharset, warn));
      pendingBytes = [];
      pendingCharset = null;
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'ew') {
      if (pendingCharset !== null && pendingCharset !== t.charset) flush();
      pendingCharset = t.charset;
      pendingBytes.push(t.bytes);
      prevWasEncodedWord = true;
      continue;
    }

    const whitespaceOnly = t.text.trim() === '';
    const nextIsEncodedWord = i + 1 < tokens.length && tokens[i + 1].kind === 'ew';
    if (whitespaceOnly && prevWasEncodedWord && nextIsEncodedWord) {
      // RFC2047 §6.2 — drop it, and leave the pending run OPEN so the byte streams join.
      continue;
    }

    flush();
    out.push(t.text);
    prevWasEncodedWord = false;
  }
  flush();

  return out.join('');
}

/* ────────────────────────────── header parsing ────────────────────────────── */

interface RawHeader {
  name: string;
  lower: string;
  value: string;
}

/** RFC5322 ftext: printable ASCII except ':' — used to tell a header line from body text. */
const HEADER_LINE_RE = /^[!-9;-~]+[ \t]*:/;
const MBOX_FROM_RE = /^From \S+ +\w{3} \w{3} +\d/;

function normalizeNewlines(s: string): string {
  return s.indexOf('\r') === -1 ? s : s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Unfold and split a header block.
 *
 * Unfolding per RFC5322 removes the line break but KEEPS the leading whitespace of the
 * continuation. That matters: it is exactly the whitespace RFC2047 §6.2 then discards
 * between two encoded-words that were folded apart.
 */
function parseHeaderBlock(block: string, warn: Warn): RawHeader[] {
  const headers: RawHeader[] = [];
  if (!block) return headers;

  const lines = block.split('\n');
  let current: RawHeader | null = null;
  let count = 0;

  for (let i = 0; i < lines.length; i++) {
    if (count >= MAX_HEADER_LINES) {
      warn('header-block-truncated');
      break;
    }
    const line = lines[i];
    if (line === '') continue;

    if (i === 0 && MBOX_FROM_RE.test(line)) {
      warn('mbox-from-line-skipped');
      continue;
    }

    if (/^[ \t]/.test(line)) {
      if (current) {
        current.value += line;
        count++;
      } else {
        warn('orphan-continuation-line');
      }
      continue;
    }

    const colon = line.indexOf(':');
    if (colon <= 0 || !HEADER_LINE_RE.test(line)) {
      warn('malformed-header-line');
      continue;
    }

    if (current) headers.push(current);
    const name = line.slice(0, colon).trim();
    current = { name, lower: name.toLowerCase(), value: line.slice(colon + 1).replace(/^[ \t]+/, '') };
    count++;
  }

  if (current) headers.push(current);
  for (const h of headers) h.value = h.value.replace(/[ \t]+$/, '');
  return headers;
}

/** First occurrence wins — that is what every typed field reads. */
function firstHeader(headers: RawHeader[], lower: string): string | null {
  for (const h of headers) if (h.lower === lower) return h.value;
  return null;
}

/** Duplicates are joined with '\n' so nothing is lost (Received:, DKIM-Signature:, …). */
function headersToMap(headers: RawHeader[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of headers) {
    const existing = map[h.lower];
    map[h.lower] = existing === undefined ? h.value : `${existing}\n${h.value}`;
  }
  return map;
}

/* ───────────────── parameterised headers (Content-Type / -Disposition) ───────────────── */

interface ParamHeader {
  value: string; // lowercased primary value, e.g. 'multipart/alternative'
  params: Record<string, string>; // lowercased keys, decoded values
}

/** Split on ';' that are not inside a quoted-string. */
function splitOnSemicolons(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuote = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inQuote) {
      buf += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      buf += ch;
      continue;
    }
    if (ch === ';' && !inQuote) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return t;
}

function percentDecodeToBuffer(s: string): Buffer {
  const out = Buffer.allocUnsafe(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out[n++] = Number.parseInt(s.slice(i + 1, i + 3), 16);
      i += 2;
      continue;
    }
    const code = s.charCodeAt(i);
    out[n++] = code <= 0xff ? code : 0x3f;
  }
  return out.subarray(0, n);
}

interface Rfc2231Segment {
  index: number;
  extended: boolean;
  raw: string;
}

/**
 * Parse `Content-Type: multipart/mixed; boundary="x"` style headers, including RFC2231
 * parameter continuations and charset-tagged values:
 *   filename*=UTF-8''%E2%82%AC.pdf
 *   filename*0*=UTF-8''%E2%82%AC; filename*1=.pdf
 * A filename carrying an (illegal but very common) RFC2047 encoded-word is decoded too.
 */
function parseParamHeader(input: string | null, warn: Warn): ParamHeader {
  const result: ParamHeader = { value: '', params: {} };
  if (!input) return result;

  const chunks = splitOnSemicolons(input);
  result.value = (chunks[0] ?? '').trim().toLowerCase();

  const segments = new Map<string, Rfc2231Segment[]>();
  const charsets = new Map<string, string>();

  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.trim() === '') continue;
    const eq = chunk.indexOf('=');
    if (eq < 0) {
      warn('malformed-header-parameter');
      continue;
    }
    const rawKey = chunk.slice(0, eq).trim().toLowerCase();
    const rawVal = chunk.slice(eq + 1);
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(rawKey);
    if (!m) {
      warn('malformed-header-parameter');
      continue;
    }
    const base = m[1];
    const index = m[2] === undefined ? 0 : Number.parseInt(m[2], 10);
    const extended = m[3] === '*';
    let text = extended ? rawVal.trim() : unquote(rawVal);

    if (extended && (m[2] === undefined || index === 0)) {
      // charset'lang'value — only the first segment carries the charset
      const firstQuote = text.indexOf("'");
      const secondQuote = firstQuote >= 0 ? text.indexOf("'", firstQuote + 1) : -1;
      if (secondQuote > firstQuote) {
        charsets.set(base, text.slice(0, firstQuote));
        text = text.slice(secondQuote + 1);
      }
    }

    const list = segments.get(base) ?? [];
    list.push({ index, extended, raw: text });
    segments.set(base, list);
  }

  for (const [key, list] of segments) {
    list.sort((a, b) => a.index - b.index);
    const buffers = list.map((seg) =>
      seg.extended ? percentDecodeToBuffer(seg.raw) : Buffer.from(seg.raw, 'latin1'),
    );
    const charset = charsets.get(key);
    let value = decodeBytes(Buffer.concat(buffers), charset ?? 'utf-8', warn);
    if (value.indexOf('=?') !== -1) value = decodeEncodedWordWith(value, warn);
    result.params[key] = value;
  }

  return result;
}

/* ────────────────────────────── address parsing ────────────────────────────── */

/**
 * Split an address list on the commas that actually separate addresses — i.e. commas
 * outside quoted strings, angle-addrs and comments. Group syntax
 * (`Managers: a@x, b@y;`) is flattened: the label is dropped, the members are kept.
 */
function splitAddressChunks(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuote = false;
  let escaped = false;
  let angle = 0;
  let paren = 0;

  const push = (): void => {
    if (buf.trim() !== '' && out.length < MAX_ADDRESSES) out.push(buf);
    buf = '';
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      buf += ch;
      escaped = true;
      continue;
    }
    if (inQuote) {
      buf += ch;
      if (ch === '"') inQuote = false;
      continue;
    }
    switch (ch) {
      case '"':
        inQuote = true;
        buf += ch;
        continue;
      case '(':
        paren++;
        buf += ch;
        continue;
      case ')':
        if (paren > 0) paren--;
        buf += ch;
        continue;
      case '<':
        angle++;
        buf += ch;
        continue;
      case '>':
        if (angle > 0) angle--;
        buf += ch;
        continue;
      case ',':
        if (angle === 0 && paren === 0) {
          push();
          continue;
        }
        buf += ch;
        continue;
      case ':':
        // group label — only when nothing address-like has accumulated yet
        if (angle === 0 && paren === 0 && buf.indexOf('@') === -1) {
          buf = '';
          continue;
        }
        buf += ch;
        continue;
      case ';':
        if (angle === 0 && paren === 0) {
          push();
          continue;
        }
        buf += ch;
        continue;
      default:
        buf += ch;
    }
  }
  push();
  return out;
}

function stripComments(s: string): { text: string; comment: string | null } {
  if (s.indexOf('(') === -1) return { text: s, comment: null };
  let text = '';
  let comment: string | null = null;
  let current = '';
  let depth = 0;
  let inQuote = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      if (depth > 0) current += ch;
      else text += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      if (depth > 0) current += ch;
      else text += ch;
      continue;
    }
    if (ch === '"' && depth === 0) {
      inQuote = !inQuote;
      text += ch;
      continue;
    }
    if (!inQuote && ch === '(') {
      depth++;
      if (depth === 1) current = '';
      else current += ch;
      continue;
    }
    if (!inQuote && ch === ')' && depth > 0) {
      depth--;
      if (depth === 0) comment = current;
      else current += ch;
      continue;
    }
    if (depth > 0) current += ch;
    else text += ch;
  }
  return { text, comment };
}

function cleanEmail(raw: string): string | null {
  let e = raw.trim().replace(/^<+/, '').replace(/>+$/, '').trim();
  // A source route (`<@relay1,@relay2:user@host>`) keeps only the real mailbox.
  if (e.startsWith('@')) {
    const colon = e.lastIndexOf(':');
    if (colon >= 0) e = e.slice(colon + 1).trim();
  }
  e = e.replace(/^mailto:/i, '').trim();
  if (e === '' || /\s/.test(e) || e.indexOf('@') <= 0 || e.endsWith('@')) return null;
  return e;
}

function parseSingleAddress(chunk: string): MimeAddress | null {
  const { text, comment } = stripComments(chunk);
  const trimmed = text.trim();
  if (trimmed === '') return null;

  let name: string | null = null;
  let email: string | null = null;

  const open = trimmed.lastIndexOf('<');
  const close = open >= 0 ? trimmed.indexOf('>', open) : -1;
  if (open >= 0) {
    const inner = close > open ? trimmed.slice(open + 1, close) : trimmed.slice(open + 1);
    email = cleanEmail(inner);
    name = trimmed.slice(0, open).trim();
  } else if (trimmed.indexOf('@') >= 0) {
    email = cleanEmail(trimmed);
    name = email === null ? trimmed : '';
  } else {
    name = trimmed;
  }

  if ((name === null || name === '') && comment !== null) name = comment.trim();

  if (name !== null) {
    name = unquote(name).trim();
    if (name.indexOf('=?') !== -1) name = decodeEncodedWord(name).trim();
    name = name.replace(/^[,;\s]+|[,;\s]+$/g, '');
    if (name === '' || name === email) name = null;
  }

  if (name === null && email === null) return null;
  return { name: name ?? null, email };
}

/**
 * Parse a `To:`/`Cc:`/`From:` header value into addresses.
 *
 * Handles: `Name <a@b>`, bare `a@b`, `"Last, First" <a@b>` (the quoted comma does NOT
 * split), `a@b (Display Name)` comment-style names, RFC2047-encoded display names, RFC5322
 * group syntax (flattened, label dropped) and source routes. `undisclosed-recipients:;`
 * yields an empty array rather than a junk entry.
 */
export function parseAddressList(s: string): MimeAddress[] {
  if (typeof s !== 'string' || s.trim() === '') return [];
  const out: MimeAddress[] = [];
  try {
    for (const chunk of splitAddressChunks(s)) {
      const addr = parseSingleAddress(chunk);
      if (addr) out.push(addr);
      if (out.length >= MAX_ADDRESSES) break;
    }
  } catch {
    return out;
  }
  return out;
}

/* ────────────────────────────── MIME tree ────────────────────────────── */

interface MimePart {
  headers: RawHeader[];
  contentType: string; // lowercased 'type/subtype'
  ctParams: Record<string, string>;
  disposition: string; // '' | 'inline' | 'attachment' | other
  dispParams: Record<string, string>;
  encoding: string; // lowercased Content-Transfer-Encoding
  contentId: string | null;
  bodyRaw: string; // still transfer-encoded
  children: MimePart[];
}

interface WalkCtx {
  warn: Warn;
  parts: number;
}

function splitHeadersAndBody(raw: string, warn: Warn): { head: string; body: string } {
  const idx = raw.indexOf('\n\n');
  if (idx === -1) {
    // No blank line: either a headers-only message or a body-only fragment.
    if (HEADER_LINE_RE.test(raw.split('\n', 1)[0] ?? '')) {
      warn('no-header-body-separator');
      return { head: raw, body: '' };
    }
    warn('no-headers-found');
    return { head: '', body: raw };
  }
  return { head: raw.slice(0, idx), body: raw.slice(idx + 2) };
}

/**
 * Split a multipart body on its boundary.
 *
 * Delimiter lines are matched EXACTLY (after trailing whitespace is stripped, which
 * transports are allowed to add). Prefix matching would be a bug: sibling boundaries
 * routinely share a prefix (`----=_Part_1_2` vs `----=_Part_1_23`), and a `startsWith`
 * terminator check would end the wrong part. Preamble and epilogue are discarded.
 */
function splitMultipart(body: string, boundary: string, warn: Warn): string[] {
  const delim = `--${boundary}`;
  const terminator = `${delim}--`;
  const lines = body.split('\n');
  const parts: string[] = [];
  let current: string[] | null = null;
  let sawTerminator = false;

  for (const line of lines) {
    const trimmed = line.replace(/[ \t\r]+$/, '');
    if (trimmed === delim) {
      if (current !== null) parts.push(current.join('\n'));
      current = [];
      continue;
    }
    if (trimmed === terminator) {
      if (current !== null) parts.push(current.join('\n'));
      current = null;
      sawTerminator = true;
      break;
    }
    if (current !== null) current.push(line);
  }

  if (current !== null) {
    parts.push(current.join('\n'));
    warn('multipart-missing-final-boundary');
  } else if (!sawTerminator) {
    warn('multipart-no-boundary-seen');
  }

  return parts;
}

function buildPart(raw: string, depth: number, ctx: WalkCtx): MimePart {
  const { head, body } = splitHeadersAndBody(raw, ctx.warn);
  const headers = parseHeaderBlock(head, ctx.warn);

  const ct = parseParamHeader(firstHeader(headers, 'content-type'), ctx.warn);
  // RFC2045 default when the header is absent.
  const contentType = ct.value || 'text/plain';
  const cd = parseParamHeader(firstHeader(headers, 'content-disposition'), ctx.warn);
  const cteRaw = (firstHeader(headers, 'content-transfer-encoding') ?? '').trim().toLowerCase();
  const cte = cteRaw.split(/[;\s]/)[0] ?? '';
  const cidRaw = firstHeader(headers, 'content-id');

  const part: MimePart = {
    headers,
    contentType,
    ctParams: ct.params,
    disposition: cd.value,
    dispParams: cd.params,
    encoding: cte || '7bit',
    contentId: cidRaw ? cidRaw.trim().replace(/^<+/, '').replace(/>+$/, '').trim() || null : null,
    bodyRaw: body,
    children: [],
  };

  if (contentType.startsWith('multipart/')) {
    if (depth >= MAX_MIME_DEPTH) {
      ctx.warn('mime-depth-limit-reached');
      return part;
    }
    const boundary = part.ctParams['boundary'];
    if (!boundary) {
      // Nothing sane to split on; keep the body as a single implicit text part.
      ctx.warn('multipart-missing-boundary-param');
      part.contentType = 'text/plain';
      return part;
    }
    for (const sub of splitMultipart(body, boundary, ctx.warn)) {
      if (ctx.parts >= MAX_PARTS) {
        ctx.warn('part-count-limit-reached');
        break;
      }
      ctx.parts++;
      part.children.push(buildPart(sub, depth + 1, ctx));
    }
    if (part.children.length === 0) ctx.warn('multipart-with-no-parts');
  }

  return part;
}

/* ───────────────────────── leaf decoding + classification ───────────────────────── */

/** True when the string contains a code unit above U+00FF. */
const NON_LATIN1_RE = /[^\u0000-\u00FF]/;
const REPLACEMENT_CHAR = '\uFFFD';

/**
 * Decode an unencoded (7bit/8bit/binary) part body.
 *
 * The input to this module is a STRING, and its provenance is ambiguous: it may have come
 * from the `<pre>` of a page the browser already charset-decoded (so 'e-acute' is one char),
 * or from bytes read as latin1 (so it is two chars, 0xC3 0xA9). Guessing wrong corrupts the
 * text in one direction or the other, so decide with evidence:
 *   - any char > U+00FF  -> already-decoded text, use as-is;
 *   - charset is UTF-8   -> try the latin1 bytes as UTF-8; accept only if that yields no
 *                           U+FFFD, which byte-provenance always does and already-decoded
 *                           text essentially never does;
 *   - anything else      -> byte-for-byte decode with the declared charset (identity for
 *                           latin1-family text, so both provenances agree).
 * Side effect worth knowing: genuine mojibake typed literally gets repaired.
 */
function decodeUnencodedText(raw: string, charset: string, warn: Warn): string {
  if (raw === '') return '';
  if (NON_LATIN1_RE.test(raw)) return raw;

  const buf = Buffer.from(raw, 'latin1');
  if (isUtf8Charset(charset)) {
    const decoded = buf.toString('utf8');
    if (decoded.indexOf(REPLACEMENT_CHAR) === -1) return decoded;
    warn('utf8-declared-but-text-already-decoded');
    return raw;
  }
  return decodeBytes(buf, charset, warn);
}

function decodeLeafText(part: MimePart, warn: Warn): string {
  const charset = part.ctParams['charset'] ?? 'utf-8';
  try {
    switch (part.encoding) {
      case 'base64':
        return decodeBytes(base64ToBuffer(part.bodyRaw), charset, warn);
      case 'quoted-printable':
        return decodeBytes(qpToBuffer(part.bodyRaw, false), charset, warn);
      default:
        return decodeUnencodedText(part.bodyRaw, charset, warn);
    }
  } catch {
    warn('part-decode-failed');
    return part.bodyRaw;
  }
}

function decodeLeafBytes(part: MimePart, warn: Warn): Buffer {
  try {
    switch (part.encoding) {
      case 'base64':
        return base64ToBuffer(part.bodyRaw);
      case 'quoted-printable':
        return qpToBuffer(part.bodyRaw, false);
      default: {
        const alreadyText = NON_LATIN1_RE.test(part.bodyRaw);
        if (!alreadyText && part.bodyRaw.indexOf('\n') !== -1) warn('binary-part-newline-normalised');
        return Buffer.from(part.bodyRaw, alreadyText ? 'utf8' : 'latin1');
      }
    }
  } catch {
    warn('part-decode-failed');
    return Buffer.alloc(0);
  }
}

function decodedSize(part: MimePart, warn: Warn): number {
  // base64 size is exact from the encoded length, so a big attachment is measured without
  // ever allocating its decoded buffer.
  if (part.encoding === 'base64') return base64DecodedSize(part.bodyRaw);
  return decodeLeafBytes(part, warn).length;
}

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/json': 'json',
  'application/msword': 'doc',
  'application/rtf': 'rtf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/csv': 'csv',
  'text/calendar': 'ics',
  'message/rfc822': 'eml',
};

function synthesizeFilename(part: MimePart, index: number): string {
  const known = EXT_BY_MIME[part.contentType];
  const sub = part.contentType.split('/')[1] ?? 'bin';
  const ext = known ?? (/^[a-z0-9]{1,8}$/.test(sub) ? sub : 'bin');
  return `part-${index}.${ext}`;
}

/**
 * A leaf is an attachment when ANY of: an explicit `attachment` disposition; a filename in
 * either header; a Content-ID (inline image); or a type that is not text/plain or text/html.
 * Everything else is body material.
 */
function isAttachmentPart(part: MimePart): boolean {
  if (part.disposition === 'attachment') return true;
  if (part.dispParams['filename'] || part.ctParams['name']) return true;
  if (part.contentId !== null) return true;
  return part.contentType !== 'text/plain' && part.contentType !== 'text/html';
}

interface Collected {
  textParts: string[];
  htmlParts: string[];
  attachments: MimePart[];
}

/** Depth-first walk; body candidates and attachments come out in document order. */
function collectParts(part: MimePart, out: Collected, warn: Warn): void {
  if (part.contentType.startsWith('multipart/')) {
    // multipart/alternative needs no special case: the depth-first order already puts the
    // plain alternative ahead of the rich one, and "first non-empty of each type wins"
    // picks text/plain for textBody and text/html for htmlBody at any nesting level.
    for (const child of part.children) collectParts(child, out, warn);
    return;
  }

  if (part.contentType === 'message/rfc822') {
    // An embedded message is kept whole as an .eml attachment rather than merged into the
    // parent's body; call parseRfc822() on its `content` to walk into it.
    warn('nested-message-kept-as-attachment');
    out.attachments.push(part);
    return;
  }

  if (isAttachmentPart(part)) {
    out.attachments.push(part);
    return;
  }

  const text = decodeLeafText(part, warn);
  if (part.contentType === 'text/html') out.htmlParts.push(text);
  else out.textParts.push(text);
}

function buildAttachment(
  part: MimePart,
  index: number,
  includeContent: boolean,
  warn: Warn,
): MimeAttachment {
  let filename = part.dispParams['filename'] ?? part.ctParams['name'] ?? '';
  if (filename === '') {
    filename = synthesizeFilename(part, index);
    warn('attachment-filename-synthesized');
  }
  // Defuse path traversal before anything downstream writes this to disk.
  filename = filename.replace(/[\\/]+/g, '_').replace(/^\.+/, '_').trim() || `part-${index}.bin`;

  const attachment: MimeAttachment = {
    filename,
    mimeType: part.contentType,
    sizeBytes: 0,
    contentId: part.contentId,
    inline: part.disposition === 'inline' || (part.disposition === '' && part.contentId !== null),
    encoding: part.encoding,
  };

  if (includeContent) {
    const bytes = decodeLeafBytes(part, warn);
    attachment.content = bytes;
    attachment.sizeBytes = bytes.length;
  } else {
    attachment.sizeBytes = decodedSize(part, warn);
  }

  return attachment;
}

/* ────────────────────────────── message assembly ────────────────────────────── */

function emptyMessage(): MimeMessage {
  return {
    messageId: null,
    from: null,
    to: [],
    cc: [],
    subject: null,
    date: null,
    dateMs: null,
    inReplyTo: null,
    references: [],
    textBody: '',
    htmlBody: null,
    attachments: [],
    headers: {},
  };
}

function stripAngles(s: string): string {
  return s.trim().replace(/^<+/, '').replace(/>+$/, '').trim();
}

function parseDateMs(value: string | null): number | null {
  if (!value) return null;
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return direct;
  // Retry without a trailing timezone comment: "… +0000 (UTC)"
  const stripped = value.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (stripped !== value) {
    const retry = Date.parse(stripped);
    if (Number.isFinite(retry)) return retry;
  }
  return null;
}

function capBody(text: string, label: string, warn: Warn): string {
  if (text.length <= MAX_BODY_CHARS) return text;
  warn(`${label}-truncated:${text.length}->${MAX_BODY_CHARS}`);
  return text.slice(0, MAX_BODY_CHARS);
}

function firstNonEmpty(list: string[]): string | null {
  for (const s of list) if (s.trim() !== '') return s;
  return list.length > 0 ? list[0] : null;
}

function applyWarnings(msg: MimeMessage, bag: WarnBag): void {
  const codes = bag.list();
  if (codes.length === 0) return;
  const existing = msg.headers['x-parse-warning'];
  const note = codes.join('; ');
  msg.headers['x-parse-warning'] = existing === undefined ? note : `${existing}; ${note}`;
}

/**
 * Parse one raw RFC822 message.
 *
 * Never throws: any internal failure degrades to whatever was already parsed, with the
 * reason recorded in `headers['x-parse-warning']`.
 */
export function parseRfc822(raw: string, opts?: ParseOptions): MimeMessage {
  const bag = makeWarnBag();
  const msg = emptyMessage();
  const includeContent = opts?.includeContent === true;

  if (typeof raw !== 'string' || raw.trim() === '') {
    msg.headers['x-parse-warning'] = 'empty-input';
    return msg;
  }

  let root: MimePart | null = null;

  try {
    const normalized = normalizeNewlines(raw);
    const ctx: WalkCtx = { warn: bag.warn, parts: 0 };
    root = buildPart(normalized, 0, ctx);

    msg.headers = headersToMap(root.headers);

    const headers = root.headers;
    msg.messageId = (() => {
      const v = firstHeader(headers, 'message-id');
      const id = v === null ? '' : stripAngles(v);
      return id === '' ? null : id;
    })();

    const subjectRaw = firstHeader(headers, 'subject');
    msg.subject = subjectRaw === null ? null : decodeEncodedWordWith(subjectRaw, bag.warn);

    const fromRaw = firstHeader(headers, 'from');
    msg.from = fromRaw === null ? null : parseAddressList(fromRaw)[0] ?? null;

    msg.to = parseAddressList(firstHeader(headers, 'to') ?? '');
    msg.cc = parseAddressList(firstHeader(headers, 'cc') ?? '');

    msg.date = firstHeader(headers, 'date');
    msg.dateMs = parseDateMs(msg.date);
    if (msg.date !== null && msg.dateMs === null) bag.warn('unparseable-date');

    const inReplyToRaw = firstHeader(headers, 'in-reply-to');
    if (inReplyToRaw !== null) {
      const first = /<([^>]*)>/.exec(inReplyToRaw);
      const id = first ? first[1].trim() : stripAngles(inReplyToRaw);
      msg.inReplyTo = id === '' ? null : id;
    }

    const referencesRaw = firstHeader(headers, 'references');
    if (referencesRaw !== null) {
      const angled = referencesRaw.match(/<[^>]*>/g);
      const tokens = angled ?? referencesRaw.split(/[\s,]+/);
      msg.references = tokens.map(stripAngles).filter((t) => t !== '');
    }
  } catch (err) {
    bag.warn(`parser-exception:${err instanceof Error ? err.name : 'unknown'}`);
    applyWarnings(msg, bag);
    return msg;
  }

  try {
    const collected: Collected = { textParts: [], htmlParts: [], attachments: [] };
    collectParts(root, collected, bag.warn);

    msg.textBody = capBody(firstNonEmpty(collected.textParts) ?? '', 'textBody', bag.warn);
    const html = firstNonEmpty(collected.htmlParts);
    msg.htmlBody = html === null ? null : capBody(html, 'htmlBody', bag.warn);

    if (collected.textParts.length === 0 && collected.htmlParts.length > 0) {
      // Very common (html-only mail). Deliberately NOT html-stripped into textBody — the
      // caller decides how to render. Flagged so an empty textBody is never a silent hole.
      bag.warn('no-text-plain-part');
    }
    if (collected.textParts.length === 0 && collected.htmlParts.length === 0) {
      bag.warn('no-body-parts-found');
    }

    const total = collected.attachments.length;
    const keep = Math.min(total, MAX_ATTACHMENTS);
    for (let i = 0; i < keep; i++) {
      msg.attachments.push(buildAttachment(collected.attachments[i], i + 1, includeContent, bag.warn));
    }
    if (total > keep) bag.warn(`attachments-truncated:${keep}/${total}`);
  } catch (err) {
    bag.warn(`body-walk-exception:${err instanceof Error ? err.name : 'unknown'}`);
  }

  applyWarnings(msg, bag);
  return msg;
}

/* ─────────────────────── multiple messages in one source ─────────────────────── */

/**
 * Header names whose appearance at column 0, right after a blank line, is the signal that a
 * NEW top-level message begins. These are trace headers a receiving MTA prepends — they can
 * only legitimately appear at the very top of a message, which is what makes them usable as
 * a separator. `From ` (no colon) is the mbox separator and is accepted too.
 */
const MESSAGE_START_RE = /^(?:Delivered-To|Return-Path|Received|X-Received|X-Google-Smtp-Source)[ \t]*:|^From \S+ +\w{3} \w{3} +\d/i;

const STRONG_HEADER_NAMES = new Set(['message-id', 'from', 'subject', 'date']);

function lineStartOffsets(s: string): number[] {
  const offsets = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) offsets.push(i + 1);
  return offsets;
}

/**
 * Structural check that lines[start..] really open a header block: every line up to the
 * first blank one must be a header or a continuation, the block must actually terminate,
 * and it must carry at least one of Message-ID / From / Subject / Date. This is what stops
 * a body that merely *quotes* a `Received:` line from being read as a new message.
 */
function looksLikeHeaderBlock(lines: string[], start: number): boolean {
  let i = start;
  if (i < lines.length && MBOX_FROM_RE.test(lines[i])) i++;

  let fields = 0;
  let strong = false;
  let terminated = false;

  for (; i < lines.length && i - start < MAX_HEADER_LINES; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      terminated = true;
      break;
    }
    if (/^[ \t]/.test(line)) {
      if (fields === 0) return false; // continuation with nothing to continue
      continue;
    }
    if (!HEADER_LINE_RE.test(line)) return false;
    fields++;
    const name = line.slice(0, line.indexOf(':')).trim().toLowerCase();
    if (STRONG_HEADER_NAMES.has(name)) strong = true;
  }

  return terminated && fields >= 2 && strong;
}

/**
 * If the message starting at `startLine` is multipart, return the line index of its closing
 * `--boundary--`. Nothing before that line can be a new message — it is inside the MIME
 * tree — which is what makes an embedded `message/rfc822` attachment (a forwarded mail,
 * complete with its own Received: headers) safe. Returns -1 when there is no usable guard.
 */
function multipartGuardLine(lines: string[], startLine: number): number {
  let end = startLine;
  while (end < lines.length && lines[end].trim() !== '') end++;
  const block = lines.slice(startLine, end).join('\n');

  const headers = parseHeaderBlock(block, NOOP_WARN);
  const ct = parseParamHeader(firstHeader(headers, 'content-type'), NOOP_WARN);
  if (!ct.value.startsWith('multipart/')) return -1;
  const boundary = ct.params['boundary'];
  if (!boundary) return -1;

  const terminator = `--${boundary}--`;
  let last = -1;
  for (let i = end; i < lines.length; i++) {
    if (lines[i].replace(/[ \t\r]+$/, '') === terminator) last = i;
  }
  return last;
}

function findMessageStarts(lines: string[], offsets: number[]): number[] {
  const starts = [0];
  let i = Math.max(1, multipartGuardLine(lines, 0) + 1);

  while (i < lines.length && starts.length < MAX_MESSAGES) {
    if (
      lines[i - 1].trim() === '' &&
      MESSAGE_START_RE.test(lines[i]) &&
      looksLikeHeaderBlock(lines, i)
    ) {
      starts.push(offsets[i]);
      i = Math.max(i + 1, multipartGuardLine(lines, i) + 1);
      continue;
    }
    i++;
  }
  return starts;
}

/**
 * Parse a source that MAY hold several concatenated top-level messages — Gmail's
 * `view=om&th=<threadId>` page can be addressed by thread id, so a whole thread arriving in
 * one `<pre>` is plausible. Returns messages in source order; a single message yields a
 * one-element array.
 *
 * HOW THE SPLIT IS DECIDED (three stacked conditions, all required):
 *   1. the line is preceded by a BLANK line and starts at column 0 with a trace header
 *      (`Delivered-To:` / `Return-Path:` / `Received:` / `X-Received:` /
 *      `X-Google-Smtp-Source:`) or an mbox `From ` line;
 *   2. `looksLikeHeaderBlock()` confirms a real header block follows — every line up to a
 *      blank one parses as a header or continuation, and at least one of Message-ID / From /
 *      Subject / Date is present;
 *   3. the offset lies AFTER the closing `--boundary--` of the previous message, when that
 *      message is multipart. This is the load-bearing guard: without it, a forwarded email
 *      carried as a `message/rfc822` attachment would be torn out of its parent.
 *
 * WHY THIS IS THE WEAK POINT — and it IS inference, not a measured behaviour. What was
 * actually measured is ONE message (46,696 chars, opening `Delivered-To:`); that Gmail ever
 * concatenates a whole thread into this page is UNVERIFIED. If it never does, this function
 * is a no-op that always returns one element. Known failure modes:
 *   - FALSE SPLIT: a text/plain body that quotes a raw message with unindented `Received:`
 *     lines, inside a message whose multipart terminator is missing or which is single-part
 *     (so guard 3 cannot fire). Condition 2 filters most of these, not all.
 *   - MISSED SPLIT: a second message that begins directly at `Message-ID:` or `From:` with
 *     no trace header. Those two are excluded on purpose — they are far too common inside
 *     quoted bodies to trigger on.
 *   - A missing final boundary in message N also disarms the guard for message N+1.
 * The bias is deliberate: a missed split leaves extra text in one body (recoverable), a
 * false split corrupts two messages (not). When in doubt this does NOT split.
 */
export function parseRfc822Multi(raw: string, opts?: ParseOptions): MimeMessage[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];

  let normalized: string;
  let starts: number[];
  try {
    normalized = normalizeNewlines(raw);
    const lines = normalized.split('\n');
    starts = findMessageStarts(lines, lineStartOffsets(normalized));
  } catch {
    return [parseRfc822(raw, opts)];
  }

  if (starts.length <= 1) return [parseRfc822(normalized, opts)];

  const out: MimeMessage[] = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : normalized.length;
    const msg = parseRfc822(normalized.slice(starts[i], end), opts);
    const note = `multi-message-source:${i + 1}/${starts.length}`;
    const existing = msg.headers['x-parse-warning'];
    msg.headers['x-parse-warning'] = existing === undefined ? note : `${existing}; ${note}`;
    out.push(msg);
  }
  return out;
}
