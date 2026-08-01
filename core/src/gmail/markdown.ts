/**
 * Markdown -> DOM-node renderer for composing richly formatted Gmail messages.
 *
 * WHY THIS EXISTS
 * ---------------
 * Gmail's compose surface enforces Trusted Types. MEASURED 2026-07-29 on the
 * live page, both of these THROW:
 *
 *   el.innerHTML = '...'
 *     -> TypeError: Failed to set the 'innerHTML' property on 'Element':
 *        This document requires 'TrustedHTML' assignment.
 *   new DOMParser().parseFromString(...)   -> same class of error.
 *
 * That is not theoretical: an innerHTML assignment there threw and Gmail then
 * silently sent a real email with an EMPTY body. So formatted content MUST be
 * built with document.createElement / createTextNode / appendChild only.
 *
 * MEASURED (same session): building rich content programmatically WORKS and
 * Gmail preserves it. A test message built as DOM nodes read back after Gmail
 * processed it with <b> x2, <i>, <a href>, <ul>, <ol> (6 <li>) and
 * <blockquote> all intact.
 *
 * SHAPE
 * -----
 * Two halves, so parsing is testable in Node and only a tiny GENERIC walker
 * runs in the page:
 *
 *   1. parseMarkdown(md)     -> MdNode[]   (pure, dependency-free, Node-side)
 *   2. buildDomScript(nodes) -> string     (page-side JS for Runtime.evaluate)
 *   3. markdownToPlainText(md) -> string   (format:'text' / text-plain part)
 *
 * The emitted script carries the tree as ONE JSON literal plus a fixed walker.
 * There is deliberately no per-node code generation: the page-side surface stays
 * constant no matter how large or weird the message is.
 *
 * Node built-ins only. No dependencies. Nothing here touches a browser.
 */

/* ------------------------------------------------------------------ *
 * Tree types (serialisable — this is what crosses into the page)
 * ------------------------------------------------------------------ */

export type MdNode =
  | { t: 'p'; c: MdInline[] }
  | { t: 'h'; level: 1 | 2 | 3; c: MdInline[] }
  | { t: 'ul'; items: MdInline[][] }
  | { t: 'ol'; items: MdInline[][] }
  | { t: 'quote'; c: MdInline[] }
  | { t: 'pre'; text: string }
  | { t: 'hr' };

export type MdInline =
  | { t: 'text'; v: string }
  | { t: 'b'; c: MdInline[] }
  | { t: 'i'; c: MdInline[] }
  | { t: 'code'; v: string }
  | { t: 'a'; href: string; c: MdInline[] }
  | { t: 'br' };

/* ------------------------------------------------------------------ *
 * Link scheme policy
 * ------------------------------------------------------------------ */

/**
 * Only these schemes may become a live <a href>. Message content is untrusted:
 * `javascript:`, `data:`, `vbscript:`, `file:` and every relative or
 * protocol-relative form are refused, and the caller keeps the link TEXT.
 *
 * Enforced in BOTH halves on purpose:
 *   - here, so a serialised tree never carries a live hostile href; and
 *   - again inside the emitted walker, so a hand-built tree handed straight to
 *     buildDomScript is still safe.
 *
 * @returns the normalised href, or null if it must not become a link.
 */
export function sanitizeHref(raw: string): string | null {
  if (typeof raw !== 'string') return null;

  // C0 controls and DEL are never legal in a URL, and browsers IGNORE TAB/CR/LF
  // while parsing the scheme — "java\tscript:alert(1)" is a live javascript URL.
  // Strip them before the allowlist test rather than after.
  const stripped = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!stripped) return null;

  const colon = stripped.indexOf(':');
  if (colon < 1) return null; // relative, protocol-relative, fragment -> refuse
  const scheme = stripped.slice(0, colon).toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return null;
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') return null;

  // Interior spaces are encoded rather than dropped so mailto query strings
  // ("?subject=hello world") survive intact.
  return stripped.replace(/ /g, '%20');
}

/* ------------------------------------------------------------------ *
 * Small shared helpers
 * ------------------------------------------------------------------ */

const PUNCT = /[\p{P}\p{S}]/u;

function isSpaceish(ch: string): boolean {
  return ch === '' || /\s/.test(ch);
}

function isPunct(ch: string): boolean {
  return ch !== '' && PUNCT.test(ch);
}

function unescapeMd(s: string): string {
  return s.replace(/\\([\p{P}\p{S}])/gu, '$1');
}

/* ------------------------------------------------------------------ *
 * INLINE: tokenizer
 * ------------------------------------------------------------------ */

type Tok =
  | { kind: 'node'; node: MdInline }
  | { kind: 'delim'; ch: '*' | '_'; n: number; origN: number; canOpen: boolean; canClose: boolean };

function runLength(src: string, i: number, ch: string): number {
  let n = 0;
  while (i + n < src.length && src[i + n] === ch) n++;
  return n;
}

/** CommonMark code span: opened by a run of N backticks, closed by exactly N. */
function readCodeSpan(src: string, start: number): { text: string; end: number } | null {
  const n = runLength(src, start, '`');
  let i = start + n;
  while (i < src.length) {
    if (src[i] === '`') {
      const r = runLength(src, i, '`');
      if (r === n) {
        let text = src.slice(start + n, i);
        // CommonMark strips one leading + trailing space when both are present.
        if (text.length > 2 && text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '') {
          text = text.slice(1, -1);
        }
        return { text, end: i + r };
      }
      i += r;
      continue;
    }
    i++;
  }
  return null;
}

function readLinkLabel(src: string, start: number): { text: string; end: number } | null {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      const cs = readCodeSpan(src, i);
      if (cs) { i = cs.end; continue; }
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return { text: src.slice(start + 1, i), end: i + 1 };
    }
    i++;
  }
  return null;
}

function readLinkDest(src: string, start: number): { href: string; end: number } | null {
  let i = start + 1;
  while (i < src.length && /[ \t]/.test(src[i])) i++;

  let href: string;
  if (src[i] === '<') {
    const close = src.indexOf('>', i + 1);
    if (close < 0) return null;
    href = src.slice(i + 1, close);
    i = close + 1;
  } else {
    const s = i;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (/\s/.test(c)) break;
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      i++;
    }
    href = src.slice(s, i);
  }

  // Optional title — parsed so it does not leak into the href, then discarded.
  while (i < src.length && /\s/.test(src[i])) i++;
  const q = src[i];
  if (q === '"' || q === "'" || q === '(') {
    const closeCh = q === '(' ? ')' : q;
    let j = i + 1;
    while (j < src.length && src[j] !== closeCh) { if (src[j] === '\\') j++; j++; }
    if (j < src.length) i = j + 1;
  }
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== ')') return null;
  return { href: unescapeMd(href), end: i + 1 };
}

const SCHEME_AUTOLINK = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const BARE_URL_HEAD = /(?:https?:\/\/|www\.)/iy;
const BARE_URL_BODY = /[^\s<>"'`\\\u0000-\u001F]*/y;
const BARE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/y;

/** Trim trailing sentence punctuation off an autolinked URL, keeping balanced ")". */
function trimUrlTail(url: string): string {
  let u = url;
  for (;;) {
    const last = u.slice(-1);
    if (last === ')') {
      const opens = (u.match(/\(/g) || []).length;
      const closes = (u.match(/\)/g) || []).length;
      if (closes <= opens) break;
      u = u.slice(0, -1);
      continue;
    }
    if ('.,;:!?"\'*_~]}>'.includes(last)) { u = u.slice(0, -1); continue; }
    break;
  }
  return u;
}

function linkNode(href: string, label: MdInline[], fallback: string): MdInline[] {
  const safe = sanitizeHref(href);
  // Unsafe scheme -> drop the link, keep the text. Never silently lose content.
  if (!safe) return label.length ? label : [{ t: 'text', v: fallback }];
  return [{ t: 'a', href: safe, c: label.length ? label : [{ t: 'text', v: fallback }] }];
}

function tokenizeInline(src: string, inLink: boolean): Tok[] {
  const toks: Tok[] = [];
  let buf = '';
  const flush = () => { if (buf) { toks.push({ kind: 'node', node: { t: 'text', v: buf } }); buf = ''; } };
  const pushNodes = (ns: MdInline[]) => { flush(); for (const n of ns) toks.push({ kind: 'node', node: n }); };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // Hard line break — block layer encodes it as a literal newline so that
    // emphasis can still span the wrapped lines of one paragraph.
    if (ch === '\n') { flush(); toks.push({ kind: 'node', node: { t: 'br' } }); i++; continue; }

    if (ch === '\\' && i + 1 < src.length && isPunct(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }

    if (ch === '`') {
      const cs = readCodeSpan(src, i);
      if (cs) { flush(); toks.push({ kind: 'node', node: { t: 'code', v: cs.text } }); i = cs.end; continue; }
    }

    if (ch === '<' && !inLink) {
      const close = src.indexOf('>', i + 1);
      if (close > i + 1) {
        const body = src.slice(i + 1, close);
        if (EMAIL_RE.test(body)) {
          pushNodes(linkNode('mailto:' + body, [{ t: 'text', v: body }], body));
          i = close + 1; continue;
        }
        if (SCHEME_AUTOLINK.test(body)) {
          pushNodes(linkNode(body, [{ t: 'text', v: body }], body));
          i = close + 1; continue;
        }
      }
    }

    // Images are DOWNGRADED to links (see module notes) rather than dropped.
    if (ch === '!' && src[i + 1] === '[' && !inLink) {
      const label = readLinkLabel(src, i + 1);
      if (label && src[label.end] === '(') {
        const dest = readLinkDest(src, label.end);
        if (dest) {
          const alt = label.text.trim();
          pushNodes(linkNode(dest.href, alt ? parseInlineInner(alt, true) : [], alt || dest.href));
          i = dest.end; continue;
        }
      }
    }

    if (ch === '[' && !inLink) {
      const label = readLinkLabel(src, i);
      if (label && src[label.end] === '(') {
        const dest = readLinkDest(src, label.end);
        if (dest) {
          pushNodes(linkNode(dest.href, parseInlineInner(label.text, true), label.text));
          i = dest.end; continue;
        }
      }
    }

    if (ch === '*' || ch === '_') {
      const n = runLength(src, i, ch);
      const prev = i > 0 ? src[i - 1] : '';
      const next = i + n < src.length ? src[i + n] : '';
      const leftFlanking = !isSpaceish(next) && (!isPunct(next) || isSpaceish(prev) || isPunct(prev));
      const rightFlanking = !isSpaceish(prev) && (!isPunct(prev) || isSpaceish(next) || isPunct(next));
      const canOpen = ch === '*' ? leftFlanking : leftFlanking && (!rightFlanking || isPunct(prev));
      const canClose = ch === '*' ? rightFlanking : rightFlanking && (!leftFlanking || isPunct(next));
      flush();
      toks.push({ kind: 'delim', ch, n, origN: n, canOpen, canClose });
      i += n; continue;
    }

    // Bare URL / email autolinking. Never starts mid-word.
    if (!inLink && (i === 0 || !/[A-Za-z0-9]/.test(src[i - 1]))) {
      BARE_URL_HEAD.lastIndex = i;
      if (BARE_URL_HEAD.test(src)) {
        BARE_URL_BODY.lastIndex = i;
        const m = BARE_URL_BODY.exec(src);
        const raw = trimUrlTail(m ? m[0] : src.slice(i));
        if (raw.length > 4) {
          const href = /^www\./i.test(raw) ? 'https://' + raw : raw;
          pushNodes(linkNode(href, [{ t: 'text', v: raw }], raw));
          i += raw.length; continue;
        }
      }
      BARE_EMAIL.lastIndex = i;
      const em = BARE_EMAIL.exec(src);
      if (em && em.index === i) {
        pushNodes(linkNode('mailto:' + em[0], [{ t: 'text', v: em[0] }], em[0]));
        i += em[0].length; continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return toks;
}

/* ------------------------------------------------------------------ *
 * INLINE: emphasis resolution (CommonMark delimiter stack, simplified)
 * ------------------------------------------------------------------ */

function ruleOfThree(opener: Extract<Tok, { kind: 'delim' }>, closer: Extract<Tok, { kind: 'delim' }>): boolean {
  if (!(opener.canClose || closer.canOpen)) return true;
  if ((opener.origN + closer.origN) % 3 !== 0) return true;
  return opener.origN % 3 === 0 && closer.origN % 3 === 0;
}

function toksToNodes(toks: Tok[]): MdInline[] {
  const out: MdInline[] = [];
  for (const tk of toks) {
    // Leftover delimiters were never matched -> they stay literal text.
    if (tk.kind === 'delim') { if (tk.n > 0) out.push({ t: 'text', v: tk.ch.repeat(tk.n) }); continue; }
    out.push(tk.node);
  }
  return pruneInline(out);
}

function resolveEmphasis(toks: Tok[]): MdInline[] {
  let i = 0;
  while (i < toks.length) {
    const closer = toks[i];
    if (closer.kind === 'delim' && closer.canClose && closer.n > 0) {
      let found = -1;
      for (let j = i - 1; j >= 0; j--) {
        const o = toks[j];
        if (o.kind === 'delim' && o.ch === closer.ch && o.canOpen && o.n > 0 && ruleOfThree(o, closer)) { found = j; break; }
      }
      if (found >= 0) {
        const opener = toks[found] as Extract<Tok, { kind: 'delim' }>;
        const use = opener.n >= 2 && closer.n >= 2 ? 2 : 1;
        const inner = resolveEmphasis(toks.slice(found + 1, i));
        const node: MdInline = use === 2 ? { t: 'b', c: inner } : { t: 'i', c: inner };
        opener.n -= use;
        closer.n -= use;
        const head: Tok[] = opener.n > 0 ? [opener] : [];
        const tail: Tok[] = closer.n > 0 ? [closer] : [];
        toks.splice(found, i - found + 1, ...head, { kind: 'node', node }, ...tail);
        i = found + head.length + 1;
        continue;
      }
    }
    i++;
  }
  return toksToNodes(toks);
}

function pruneInline(list: MdInline[]): MdInline[] {
  const out: MdInline[] = [];
  for (const n of list) {
    if (n.t === 'text') {
      if (!n.v) continue;
      const last = out[out.length - 1];
      if (last && last.t === 'text') { last.v += n.v; continue; }
      out.push({ t: 'text', v: n.v });
      continue;
    }
    if (n.t === 'b' || n.t === 'i') {
      const c = pruneInline(n.c);
      if (!c.length) continue;
      out.push({ t: n.t, c } as MdInline);
      continue;
    }
    if (n.t === 'a') {
      const c = pruneInline(n.c);
      if (!c.length) continue;
      out.push({ t: 'a', href: n.href, c });
      continue;
    }
    if (n.t === 'code' && !n.v) continue;
    out.push(n);
  }
  return out;
}

function parseInlineInner(src: string, inLink: boolean): MdInline[] {
  return resolveEmphasis(tokenizeInline(src, inLink));
}

/** Parse one run of inline markdown. A literal "\n" becomes a hard <br>. */
export function parseInline(src: string): MdInline[] {
  return parseInlineInner(src, false);
}

/* ------------------------------------------------------------------ *
 * BLOCK layer
 * ------------------------------------------------------------------ */

const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const RE_QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const RE_UL = /^( *)([-*+])([ \t]+)(.*)$/;
const RE_OL = /^( *)(\d{1,9})[.)]([ \t]+)(.*)$/;

function isFence(line: string): { marker: string; len: number } | null {
  const m = RE_FENCE.exec(line);
  if (!m) return null;
  // A backtick fence's info string may not contain a backtick.
  if (m[1][0] === '`' && m[2].includes('`')) return null;
  return { marker: m[1][0], len: m[1].length };
}

function isClosingFence(line: string, marker: string, len: number): boolean {
  const m = /^ {0,3}(.*?)[ \t]*$/.exec(line);
  const body = m ? m[1] : line.trim();
  if (body.length < len) return false;
  for (const c of body) if (c !== marker) return false;
  return true;
}

function listMarker(line: string): { kind: 'ul' | 'ol'; content: string } | null {
  if (RE_HR.test(line)) return null;
  let m = RE_UL.exec(line);
  if (m) return { kind: 'ul', content: m[4] };
  m = RE_OL.exec(line);
  if (m) return { kind: 'ol', content: m[4] };
  return null;
}

function isBlockStart(line: string): boolean {
  return !!(isFence(line) || RE_HEADING.test(line) || RE_QUOTE.test(line) || RE_HR.test(line) || listMarker(line));
}

/**
 * Join the lines of one paragraph / list item / quote into a single inline
 * source. A trailing double space, or an odd trailing backslash, is a HARD
 * break and becomes "\n"; every other wrap is a soft break and becomes " ".
 */
function joinLines(lines: string[]): string {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i];
    let hard = false;
    if (/ {2,}$/.test(text)) { hard = true; text = text.replace(/[ \t]+$/, ''); }
    else {
      const bs = /(\\+)$/.exec(text);
      if (bs && bs[1].length % 2 === 1) { hard = true; text = text.slice(0, -1); }
      else text = text.replace(/[ \t]+$/, '');
    }
    out += text;
    if (i < lines.length - 1) out += hard ? '\n' : ' ';
  }
  return out;
}

/**
 * Parse a practical email subset of markdown into a serialisable tree.
 * Pure and dependency-free — this is the half that gets unit-tested.
 */
export function parseMarkdown(md: string): MdNode[] {
  if (typeof md !== 'string' || !md) return [];
  const lines = md
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^\t+/, (t) => '    '.repeat(t.length)));

  const out: MdNode[] = [];
  let i = 0;

  const pushInline = (node: MdNode, content: MdInline[]) => {
    if (content.length) out.push(node);
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const fence = isFence(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !isClosingFence(lines[i], fence.marker, fence.len)) { body.push(lines[i]); i++; }
      if (i < lines.length) i++; // consume the closing fence
      out.push({ t: 'pre', text: body.join('\n') });
      continue;
    }

    if (RE_HR.test(line)) { out.push({ t: 'hr' }); i++; continue; }

    const h = RE_HEADING.exec(line);
    if (h) {
      const level = Math.min(h[1].length, 3) as 1 | 2 | 3;
      const raw = (h[2] || '').replace(/[ \t]+#+[ \t]*$/, '');
      const c = parseInlineInner(raw, false);
      pushInline({ t: 'h', level, c }, c);
      i++;
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const parts: string[] = [];
      while (i < lines.length) {
        const q = RE_QUOTE.exec(lines[i]);
        if (!q) break;
        parts.push(q[1].replace(/^[ \t]*(?:>[ \t]?)+/, '')); // flatten nesting
        i++;
      }
      const c = parseInlineInner(parts.join('\n'), false);
      pushInline({ t: 'quote', c }, c);
      continue;
    }

    const lm = listMarker(line);
    if (lm) {
      const kind = lm.kind;
      const items: string[][] = [];
      let cur: string[] = [lm.content];
      i++;
      while (i < lines.length) {
        const ln = lines[i];
        if (!ln.trim()) {
          let j = i;
          while (j < lines.length && !lines[j].trim()) j++;
          const nm = j < lines.length ? listMarker(lines[j]) : null;
          if (nm && nm.kind === kind) { i = j; continue; }
          break;
        }
        const m2 = listMarker(ln);
        if (m2) {
          if (m2.kind !== kind) break;
          items.push(cur);
          cur = [m2.content];
          i++;
          continue;
        }
        if (isBlockStart(ln)) break;
        cur.push(ln.trim()); // lazy / indented continuation of the current item
        i++;
      }
      items.push(cur);
      const parsed = items.map((it) => parseInlineInner(joinLines(it), false)).filter((c) => c.length);
      if (parsed.length) out.push(kind === 'ul' ? { t: 'ul', items: parsed } : { t: 'ol', items: parsed });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { para.push(lines[i]); i++; }
    const c = parseInlineInner(joinLines(para), false);
    pushInline({ t: 'p', c }, c);
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Page-side script emission
 * ------------------------------------------------------------------ */

export interface BuildDomScriptOptions {
  /** CSS selectors tried in order to locate the compose body. */
  selectors?: string[];
  /**
   * Raw JS expression evaluated in the page to obtain the target element,
   * e.g. "el". Takes precedence over `selectors`.
   *
   * CALLER-AUTHORED CODE ONLY — never derive this from message content. It must
   * be a single-line expression with no comments, no regex literals and no
   * template literals (see the escaping note below).
   */
  targetExpr?: string;
}

const DEFAULT_SELECTORS = [
  'div[aria-label="Message Body"]',
  'div[g_editable="true"][role="textbox"]',
  'div[contenteditable="true"][role="textbox"]',
  'div.Am.Al.editable',
];

const STYLE = {
  h1: 'font-size:20px;line-height:1.3;',
  h2: 'font-size:17px;line-height:1.3;',
  h3: 'font-size:15px;line-height:1.3;',
  quote: 'margin:0 0 0 .8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex;',
  pre: 'font-family:monospace,monospace;font-size:13px;white-space:pre-wrap;background:rgb(246,248,250);padding:8px 10px;border-radius:4px;',
  code: 'font-family:monospace,monospace;font-size:13px;background:rgb(246,248,250);padding:1px 4px;border-radius:3px;',
};

/**
 * ESCAPING GUARANTEE — read before editing the template literal below.
 *
 * The returned script is meant to be dropped into a TypeScript template literal:
 *
 *     const expr = `(function(){ ... ${buildDomScript(nodes)} ... })()`;
 *
 * That interpolation is plain RUNTIME concatenation — TS never re-parses the
 * interpolated value — so nothing in the returned string can break the caller's
 * literal. The hazard is entirely on THIS side, and it is the exact bug that
 * produced "SyntaxError: Invalid or unexpected token":
 *
 *   writing  \n  in TS source inside the template below yields a REAL newline
 *   in the emitted page source. Inside a page-side "..." literal that is an
 *   unterminated string.
 *
 * Three rules make that impossible, and the third is machine-checked:
 *
 *  1. EVERY string that reaches the page goes through jsLiteral() at RUNTIME.
 *     JSON.stringify emits a real backslash followed by "n" — correct JS source.
 *     jsLiteral additionally escapes < > U+2028 U+2029, which JSON.stringify
 *     leaves raw and which are line terminators / HTML-context hazards.
 *  2. No backslash, comment, regex literal or template literal is ever TYPED
 *     into the emitted page source. Page code uses only "double quotes" and
 *     plain statements, so a quote scanner over it is sound.
 *  3. assertPageSourceSafe() re-scans the finished script and THROWS if any raw
 *     line terminator ever lands inside a string literal. A regression fails
 *     here, in Node, instead of silently sending an empty email.
 */
function jsLiteral(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return 'null';
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Rule 3 above: no raw line terminator may sit inside a string literal. */
export function assertPageSourceSafe(src: string): void {
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) { quote = null; continue; }
      if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') {
        throw new Error(`buildDomScript: raw line terminator inside a page-side string literal at offset ${i}`);
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
  }
  if (quote) throw new Error('buildDomScript: unterminated page-side string literal');
}

/**
 * Emit page-side JS that rebuilds `nodes` as real DOM under the compose body.
 *
 * The tree crosses as ONE JSON literal; the walker below is fixed and generic.
 * The script is an expression (IIFE) — evaluate it with `returnByValue: true`
 * and read the summary to VERIFY the body actually took:
 *
 *   { ok, reason?, blocks, links, lists, bolds, chars }
 *
 * `ok:false` with `chars:0` is exactly the empty-body case that must never be
 * sent, so the caller can abort before hitting Send.
 */
export function buildDomScript(nodes: MdNode[], opts: BuildDomScriptOptions = {}): string {
  const target = opts.targetExpr && opts.targetExpr.trim()
    ? `(${opts.targetExpr})`
    : `lmFind(${jsLiteral(opts.selectors && opts.selectors.length ? opts.selectors : DEFAULT_SELECTORS)})`;

  const src = `(function(){
var NODES = ${jsLiteral(nodes)};
var NL = ${jsLiteral('\n')};
var OKS = ${jsLiteral(['http', 'https', 'mailto'])};
var ST = ${jsLiteral(STYLE)};
function lmFind(sels){
for (var i=0;i<sels.length;i++){ var n=document.querySelector(sels[i]); if (n) return n; }
return null;
}
function safeHref(h){
if (typeof h !== "string") return null;
var s = "";
var t = h.trim();
for (var i=0;i<t.length;i++){
var c = t.charCodeAt(i);
if (c === 32) { s += "%20"; continue; }
if (c < 32 || c === 127) continue;
s += t.charAt(i);
}
var ci = s.indexOf(":");
if (ci < 1) return null;
var sc = s.substring(0, ci).toLowerCase();
for (var k=0;k<sc.length;k++){
var cc = sc.charCodeAt(k);
var al = (cc >= 97 && cc <= 122);
var nu = (cc >= 48 && cc <= 57);
var sy = (cc === 43 || cc === 45 || cc === 46);
if (k === 0 ? !al : !(al || nu || sy)) return null;
}
if (OKS.indexOf(sc) < 0) return null;
return s;
}
var el = ${target};
if (!el) return { ok:false, reason:"no_target", blocks:0, links:0, lists:0, bolds:0, chars:0 };
var stats = { blocks:0, links:0, lists:0, bolds:0, chars:0 };
function txt(v){
var s = (v === null || v === undefined) ? "" : String(v);
stats.chars += s.length;
return document.createTextNode(s);
}
function br(){ return document.createElement("br"); }
function inline(list, parent){
if (!list) return;
for (var i=0;i<list.length;i++){
var n = list[i];
if (!n) continue;
if (n.t === "text") { parent.appendChild(txt(n.v)); }
else if (n.t === "br") { parent.appendChild(br()); }
else if (n.t === "b") { var b = document.createElement("b"); stats.bolds++; inline(n.c, b); parent.appendChild(b); }
else if (n.t === "i") { var em = document.createElement("i"); inline(n.c, em); parent.appendChild(em); }
else if (n.t === "code") { var sp = document.createElement("span"); sp.setAttribute("style", ST.code); sp.appendChild(txt(n.v)); parent.appendChild(sp); }
else if (n.t === "a") {
var href = safeHref(n.href);
if (href) { var a = document.createElement("a"); a.setAttribute("href", href); inline(n.c, a); stats.links++; parent.appendChild(a); }
else { inline(n.c, parent); }
}
else if (n.c) { inline(n.c, parent); }
}
}
function spacer(){ var d = document.createElement("div"); d.appendChild(br()); return d; }
var frag = document.createDocumentFragment();
for (var bi=0; bi<NODES.length; bi++){
var node = NODES[bi];
if (!node) continue;
if (bi > 0) frag.appendChild(spacer());
var e;
if (node.t === "h") {
e = document.createElement("div");
e.setAttribute("style", node.level === 1 ? ST.h1 : (node.level === 2 ? ST.h2 : ST.h3));
var hb = document.createElement("b");
stats.bolds++;
inline(node.c, hb);
e.appendChild(hb);
} else if (node.t === "ul" || node.t === "ol") {
e = document.createElement(node.t === "ul" ? "ul" : "ol");
stats.lists++;
var items = node.items || [];
for (var li=0; li<items.length; li++){
var liEl = document.createElement("li");
inline(items[li], liEl);
e.appendChild(liEl);
}
} else if (node.t === "quote") {
e = document.createElement("blockquote");
e.setAttribute("style", ST.quote);
inline(node.c, e);
} else if (node.t === "pre") {
e = document.createElement("div");
e.setAttribute("style", ST.pre);
var ls = String(node.text === null || node.text === undefined ? "" : node.text).split(NL);
for (var pi=0; pi<ls.length; pi++){
var ln = document.createElement("div");
if (ls[pi]) ln.appendChild(txt(ls[pi])); else ln.appendChild(br());
e.appendChild(ln);
}
} else if (node.t === "hr") {
e = document.createElement("hr");
} else {
e = document.createElement("div");
inline(node.c, e);
if (!e.firstChild) e.appendChild(br());
}
frag.appendChild(e);
stats.blocks++;
}
try { el.focus(); } catch (err) { void err; }
el.replaceChildren();
el.appendChild(frag);
el.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText" }));
return { ok: (stats.chars > 0 || stats.blocks > 0), blocks:stats.blocks, links:stats.links, lists:stats.lists, bolds:stats.bolds, chars:stats.chars };
})()`;

  assertPageSourceSafe(src);
  return src;
}

/* ------------------------------------------------------------------ *
 * Plain-text fallback
 * ------------------------------------------------------------------ */

function inlineToText(list: MdInline[]): string {
  let s = '';
  for (const n of list) {
    if (n.t === 'text') s += n.v;
    else if (n.t === 'br') s += '\n';
    else if (n.t === 'code') s += n.v;
    else if (n.t === 'b' || n.t === 'i') s += inlineToText(n.c);
    else if (n.t === 'a') {
      const label = inlineToText(n.c);
      const href = sanitizeHref(n.href);
      if (!href) s += label;
      else if (label === href || href === 'mailto:' + label) s += label;
      else s += `${label} (${href})`;
    }
  }
  return s;
}

/** Plain-text rendering, for the format:'text' path and the text/plain part. */
export function markdownToPlainText(md: string): string {
  const blocks: string[] = [];
  for (const node of parseMarkdown(md)) {
    if (node.t === 'p') blocks.push(inlineToText(node.c));
    else if (node.t === 'h') blocks.push(inlineToText(node.c));
    else if (node.t === 'ul') blocks.push(node.items.map((it) => `- ${inlineToText(it)}`).join('\n'));
    else if (node.t === 'ol') blocks.push(node.items.map((it, k) => `${k + 1}. ${inlineToText(it)}`).join('\n'));
    else if (node.t === 'quote') blocks.push(inlineToText(node.c).split('\n').map((l) => `> ${l}`).join('\n'));
    else if (node.t === 'pre') blocks.push(node.text);
    else blocks.push('---');
  }
  return blocks.join('\n\n').replace(/[ \t]+$/gm, '');
}
