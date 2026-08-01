/**
 * Read-only audit of the account's Gmail SETTINGS.
 *
 * Why read-only: every write here changes how the operator's real mailbox behaves
 * for everyone who mails them — a vacation responder answers strangers, a
 * forwarding rule copies mail off the account. Reading is safe, immediately
 * useful, and covers the question that actually matters operationally: "is
 * anything configured on this mailbox that I did not expect?"
 *
 * 🔴 An unexpected FORWARDING address is a classic account-compromise signal, so
 * that field distinguishes "none configured" from "could not read" rather than
 * reporting an empty list for both. A silent empty list here would be the most
 * dangerous possible output.
 *
 * MEASURED 2026-08-01 — the anchors are aria-labels, not hashable class names:
 *   signature  -> div[contenteditable][role=textbox][aria-label="Signature"]
 *   vacation   -> div[contenteditable][role=textbox][aria-label="Vacation responder"]
 *                 plus a sibling input[aria-label="Subject"]
 *   filters    -> table rows reading `Matches: <criteria> Do this: <actions>`
 */

export interface SignatureInfo {
  present: boolean;
  text: string | null;
  chars: number;
}

export interface VacationInfo {
  /** null when the on/off control could not be resolved — NOT the same as false. */
  enabled: boolean | null;
  subject: string | null;
  message: string | null;
  note?: string;
}

export interface ForwardingInfo {
  /** Addresses Gmail is forwarding to. Empty AND `read:true` means none. */
  addresses: string[];
  /** false when the page could not be read — distinguishes "none" from "unknown". */
  read: boolean;
  note?: string;
}

export interface FilterRow {
  matches: string;
  actions: string;
}

export interface FiltersInfo {
  /** Total on the account, BEFORE the cap below. */
  total: number;
  returned: number;
  capped: boolean;
  filters: FilterRow[];
}

export interface GmailSettings {
  signature: SignatureInfo;
  vacation: VacationInfo;
  forwarding: ForwardingInfo;
  filters: FiltersInfo;
  checkedAt: number;
}

/**
 * Cap on filters returned. This account has ~287 — returning them all is ~35 KB
 * of tool result, and an uncapped list is exactly the shape that killed a
 * conversation before (see the mcp result-size work). `total` is always the real
 * number so a truncated list can never read as complete.
 */
export const FILTERS_MAX = 40;

/** Signature — the editor's own text is the signature. */
export const JS_SIGNATURE = `
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.offsetParent !== null; };
  const el = [...document.querySelectorAll('div[contenteditable="true"][role="textbox"]')]
    .filter(vis).find((e) => /^signature$/i.test(e.getAttribute('aria-label') || ''));
  if (!el) return { found: false };
  const text = String(el.innerText || '').replace(/\\u00a0/g, ' ').trim();
  return { found: true, text: text.slice(0, 4000), chars: text.length };`;

/**
 * Vacation responder.
 *
 * The on/off radios carry NO usable label text of their own (measured: the
 * enclosing cell renders empty), so enabled-ness is read from the section's own
 * prose instead, and reported as null when that fails rather than guessed.
 */
export const JS_VACATION = `
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.offsetParent !== null; };
  const box = [...document.querySelectorAll('div[contenteditable="true"][role="textbox"]')]
    .filter(vis).find((e) => /vacation responder/i.test(e.getAttribute('aria-label') || ''));
  const subjEl = [...document.querySelectorAll('input[type="text"]')]
    .filter(vis).find((i) => /^subject$/i.test(i.getAttribute('aria-label') || ''));
  const message = box ? String(box.innerText || '').trim() : null;
  const subject = subjEl ? String(subjEl.value || '').trim() : null;

  // Find the radio whose OWN row mentions the responder, then read its state.
  let enabled = null;
  const radios = [...document.querySelectorAll('input[type="radio"]')].filter(vis);
  for (const r of radios) {
    const row = r.closest('tr') || r.parentElement;
    const t = String((row && row.innerText) || '').replace(/\\s+/g, ' ').trim();
    if (!/vacation responder\\s+(on|off)/i.test(t)) continue;
    const m = t.match(/vacation responder\\s+(on|off)/i);
    if (m && r.checked) { enabled = /on/i.test(m[1]); break; }
  }
  return { message: message ? message.slice(0, 2000) : null, subject, enabled };`;

/**
 * Forwarding addresses.
 *
 * Reads the forwarding block specifically — scraping every email on the page
 * would pick up the account's OWN address and report it as a forwarding target,
 * which is precisely the false alarm this check must not raise.
 */
export const JS_FORWARDING = `
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.offsetParent !== null; };
  const body = String(document.body.innerText || '');
  if (!/forward/i.test(body)) return { read: false, addresses: [] };

  const out = new Set();
  // (a) the "Forward a copy of incoming mail to" select lists configured targets.
  for (const sel of [...document.querySelectorAll('select')].filter(vis)) {
    for (const o of [...sel.options]) {
      const t = String(o.text || '');
      const m = t.match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/);
      if (m && !/^(keep|mark|archive|delete)\\b/i.test(t.trim())) out.add(m[0]);
    }
  }
  // (b) any address inside a line that actually talks about forwarding.
  for (const line of body.split(/\\n+/)) {
    if (!/forward/i.test(line)) continue;
    for (const m of line.match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/g) || []) out.add(m);
  }
  return { read: true, addresses: [...out].slice(0, 20) };`;

/** Filters — one row per rule, as Gmail renders them. */
export const JS_FILTERS = `
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.offsetParent !== null; };
  const seen = new Set();
  const out = [];
  for (const tr of [...document.querySelectorAll('tr')].filter(vis)) {
    const t = String(tr.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!/^Matches:/i.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    // "Matches: X Do this: Y editdelete" — strip the trailing action links, which
    // are part of the row text and would otherwise land inside the actions field.
    // (No backticks in here: this comment lives INSIDE a template literal.)
    const cleaned = t.replace(/\\s*edit\\s*delete\\s*$/i, '').trim();
    const m = cleaned.match(/^Matches:\\s*(.*?)\\s*Do this:\\s*(.*)$/i);
    out.push(m ? { matches: m[1], actions: m[2] } : { matches: cleaned, actions: '' });
  }
  return { total: out.length, rows: out };`;
