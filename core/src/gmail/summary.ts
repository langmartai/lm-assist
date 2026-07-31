/**
 * Gmail account summary — the "what does this mailbox look like right now" read.
 *
 * Answers, in one call: which account and its send-as aliases, how much mail is
 * in the Inbox and how much of it is unread, how many drafts and labels, what
 * arrived most recently, and WHEN any of that was last actually observed.
 *
 * That last field is the point. Every number here is scraped from a live page, so
 * a summary with no timestamp is indistinguishable from a stale one — and a
 * caller deciding "is there new mail?" against an hour-old cache would be wrong
 * in the one direction that matters. `checkedAt`/`ageMs` are therefore part of
 * the contract, not decoration, and the cached read says plainly that it is
 * cached.
 *
 * MEASURED 2026-07-31 on a live account — every source below was read off the
 * page before being coded, not assumed:
 *
 *   nav aria-label   "Inbox 2666 unread"      -> inbox.unread
 *   nav aria-label   "Drafts 47 unread"       -> drafts   🔴 the aria says
 *                                               "unread"; it is the draft COUNT.
 *                                               Gmail reuses one template.
 *   range counter    "1–50 of 5,248"          -> inbox.total
 *   first tr.zA      subject / from / when    -> newest
 *
 * 🔴 `inbox.total` comes from the range counter, which reports the CURRENT VIEW.
 * It is only the inbox total while the inbox is the view being shown, which is
 * why the read below navigates to #inbox first and refuses the number otherwise.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GM_DATA_DIR } from './config';

export interface GmailSummary {
  account: string | null;
  aliases: number;
  defaultSendAs: string | null;
  inbox: { total: number | null; unread: number | null; rendered: number };
  drafts: number | null;
  labels: number | null;
  newest: { subject: string | null; from: string | null; when: string | null; unread: boolean } | null;
  /** Epoch ms when these numbers were observed on a live page. */
  checkedAt: number;
  /** How old this read is, filled in on the way out. */
  ageMs?: number;
  /** True when served from disk rather than freshly observed. */
  cached?: boolean;
  note?: string | null;
}

function summaryFile(): string {
  return path.join(GM_DATA_DIR, 'summary.json');
}

/** The page script. Pure reads — it navigates nothing and clicks nothing. */
export const JS_SUMMARY = `
  const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && e.offsetParent !== null; };
  const num = (s) => { const m = String(s || '').replace(/,/g, '').match(/(\\d+)/); return m ? parseInt(m[1], 10) : null; };
  const out = { inboxUnread: null, inboxTotal: null, drafts: null, rendered: 0, newest: null, onInbox: false };

  out.onInbox = /#inbox/.test(location.hash) || location.hash === '';

  // Nav counts. Gmail writes them into aria-label; the visible text is just the name.
  for (const a of [...document.querySelectorAll('a[href*="#inbox"], a[href*="#drafts"]')].filter(vis)) {
    const al = a.getAttribute('aria-label') || '';
    if (/^Inbox\\b/.test(al)) out.inboxUnread = num(al);
    else if (/^Drafts\\b/.test(al)) out.drafts = num(al);
  }

  // "1-50 of 5,248" -> the CURRENT view's total. Only meaningful on the inbox.
  if (out.onInbox) {
    for (const e of [...document.querySelectorAll('span, div')].filter(vis)) {
      const t = (e.textContent || '').trim();
      const m = t.match(/^\\d[\\d,]*\\s*[-\\u2013]\\s*\\d[\\d,]*\\s+of\\s+([\\d,]+)/i);
      if (m) { out.inboxTotal = parseInt(m[1].replace(/,/g, ''), 10); break; }
    }
  }

  const rows = [...document.querySelectorAll('tr.zA')].filter(vis);
  out.rendered = rows.length;
  if (rows.length) {
    const r = rows[0];
    const subj = r.querySelector('.bog');
    const fromEl = r.querySelector('.yW span[email], .yX span[email]');
    const when = r.querySelector('.xW span, td.xW span');
    out.newest = {
      subject: subj ? (subj.innerText || '').trim().slice(0, 200) : null,
      from: fromEl ? (fromEl.getAttribute('email') || (fromEl.innerText || '').trim()).slice(0, 120) : null,
      when: when ? ((when.getAttribute('title') || when.innerText || '').trim().slice(0, 60)) : null,
      unread: r.classList.contains('zE'),
    };
  }
  return out;`;

/** Persist a freshly observed summary. Best-effort: a cache write must never fail a read. */
export function writeSummary(s: GmailSummary): void {
  try {
    fs.mkdirSync(GM_DATA_DIR, { recursive: true });
    fs.writeFileSync(summaryFile(), JSON.stringify(s, null, 2));
  } catch {
    /* a cache that cannot be written is still a summary that can be returned */
  }
}

/** The last observed summary, or null if this node has never built one. */
export function readSummary(): GmailSummary | null {
  try {
    const s = JSON.parse(fs.readFileSync(summaryFile(), 'utf-8')) as GmailSummary;
    if (!s || typeof s.checkedAt !== 'number') return null;
    return { ...s, ageMs: Date.now() - s.checkedAt, cached: true };
  } catch {
    return null;
  }
}
