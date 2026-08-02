/**
 * Gmail connector — LIVE CANARY SUITE. Deploy to `core/src/gmail/selfcheck.ts`.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 * `validate.ts` fails closed on the way OUT of an extraction: it stops a wrong
 * answer reaching a caller who asked a question. This file asks the questions
 * itself, on a schedule or on demand, so drift is found by a canary instead of
 * by someone acting on bad mail data.
 *
 * ── The one rule: assert STRUCTURE, never CONTENT ────────────────────────────
 * Mail changes every minute; the shape of the mail app does not. So no check
 * here knows a subject line, a sender or a count. What they know is: an inbox
 * has rows, rows carry 16-hex ids, two different views cannot return the same
 * rows, an opened thread carries the id that was asked for, an account has at
 * least one send-as identity with exactly one default, a compose exposes four
 * controls together. Every one of those was FALSE at some point on 2026-07-29,
 * silently.
 *
 * ── Isolation, timing, and why a partial matrix is the point ─────────────────
 * Each check runs in its own try/catch and is timed on its own. A failure NEVER
 * aborts the rest: "login works, listing works, but Sent is serving the Inbox"
 * is a far more useful answer than the first exception. `ok` is true only when
 * no CRITICAL check failed; `warn` failures are reported and counted but do not
 * condemn the connector.
 *
 * ── This canary MUST NOT MUTATE MAIL ─────────────────────────────────────────
 * No send, no reply, no draft, no label write, no archive, no delete. Two
 * consequences that are easy to get wrong and are enforced below:
 *
 *  🔴 OPENING AN UNREAD THREAD MARKS IT READ. That is a mutation. So the thread
 *     and attachment checks only ever open a row that is ALREADY read, and SKIP
 *     (reporting why) rather than touch an unread one.
 *  🔴 IF A COMPOSE IS ALREADY OPEN, the compose check ABORTS. The operator may
 *     be mid-message in that window, and this canary is not going to be the
 *     thing that discards it.
 *
 * The compose check itself types NOTHING — Gmail only auto-saves a draft once
 * content changes — and clicks Discard on the way out regardless of whether the
 * assertion passed, so a failed check cannot strand a dialog on screen.
 *
 * ── Session discipline ───────────────────────────────────────────────────────
 * Every browser touch goes through cdp-client's exported operations, or through
 * `pageProbe()`, which is `op('read', …)`. That means every check inherits the
 * same entry sequence as a real read — rate budget → session → assertLoggedIn →
 * assertDesktopUi → work — and none of them opens a raw CDP socket of its own. A
 * canary that connects differently from the code it is watching is testing
 * itself.
 */

import {
  cdpStatus,
  listThreads,
  createLabel,
  renameLabel,
  deleteLabel,
  draftMail,
  listDrafts,
  deleteDraft,
  starThread,
  gmailSummary,
  searchThreads,
  readThread,
  listSendAs,
  listLabels,
  listAttachments,
  pageProbe,
  type Cdp,
  type GmailThread,
} from './cdp-client';
import { JS_LIB, COMPOSE_SELECTORS } from './compose';
import {
  GmDriftError,
  assertThreadRows,
  assertDistinctViews,
  assertThreadMatches,
  assertAttachmentName,
  assertSendAs,
  assertComposeReady,
  assertNavLabels,
  looksLikeThreadId,
} from './validate';

// ─── result shapes ───────────────────────────────────────────────────────────

export interface CheckResult {
  /** Stable dotted id. Stable so a matrix can be diffed across runs. */
  name: string;
  ok: boolean;
  /**
   * TRUE when the check could not RUN — no browser, or the driver was held by a
   * sync. That is not a feature failure, and reporting it as one is worse than
   * useless: a suite that goes red because it fought itself for the browser
   * teaches the reader to ignore red. Skips are counted separately and never
   * fail the run.
   */
  skipped?: boolean;
  /** One line a human can act on: what was seen, or which invariant broke. */
  detail: string;
  ms: number;
  /**
   * 'critical' — a failure means the connector is returning wrong data.
   * 'warn'     — a failure is AMBIGUOUS (nothing to sample, or a legitimately
   *              empty account). Reported, counted, but does not fail the run.
   */
  severity: 'critical' | 'warn';
}

export interface SelfCheckReport {
  /** True when no CRITICAL check failed. Warn failures do not clear this flag. */
  ok: boolean;
  passed: number;
  /** Checks that could not RUN (no browser / driver busy). Never a failure. */
  skipped: number;
  failed: number;
  checks: CheckResult[];
  startedAt: number;
  ms: number;
}

// ─── check plumbing ──────────────────────────────────────────────────────────

/**
 * A failure that is not proof of drift: nothing to sample, an account with no
 * labels, a skipped check. Reported as a WARN so the matrix stays honest without
 * crying wolf — the single fastest way to make a canary worthless is to have it
 * go red for reasons nobody can fix.
 */
class SoftFail extends Error {}

/** A check body: return the pass detail, throw to fail. */
type CheckBody = () => Promise<string>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Render whatever a check threw into one actionable line. */
function reason(e: unknown): string {
  if (e instanceof GmDriftError) return `[${e.code}] invariant "${e.invariant}" — ${e.message}`;
  const code = (e as { code?: unknown } | null)?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return typeof code === 'string' && code ? `[${code}] ${msg}` : msg;
}

/**
 * Put the page back to a known-good state between checks.
 *
 * 🔴 Checks were sharing whatever state the previous one left behind — an open
 * compose, a thread view, a settings page, a menu. MEASURED 2026-08-02: a full run
 * degraded from 14/15 to 5 passed / 9 skipped / 1 failed as the page accumulated
 * state and eventually stopped answering CDP entirely (BROWSER_BUSY ->
 * BROWSER_UNRESPONSIVE -> BROWSER_NOT_RUNNING), with 10 GB of RAM free and no OOM.
 * Each check is only meaningful from a clean start, and the wedge was the tail end
 * of that accumulation.
 *
 * Returns false when the page could not be brought back — the caller then knows to
 * skip rather than to report a feature failure.
 */
async function resetBetweenChecks(): Promise<boolean> {
  try {
    await pageProbe(async (cdp) => {
      // A real load, not a hash write: a hash-only change does not re-route the SPA
      // and would leave whatever view the last check opened.
      await cdp.navigate('https://mail.google.com/mail/u/0/#inbox');
      await sleep(1200);
      // Prove it actually answers, rather than assuming navigate() implies alive.
      const ok = await cdp.evaluate<boolean>('return !!document.querySelector("body");').catch(() => false);
      if (ok !== true) throw new Error('page did not answer after reset');
      return true;
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reset, and if the browser is gone try ONE relaunch before giving up.
 *
 * Without this a single mid-run death skipped every remaining check — 9 of 15 on
 * the measured run. The browser dying is a recoverable condition, not a reason to
 * abandon the suite.
 */
async function resetOrRecover(state: { relaunched: boolean }): Promise<boolean> {
  if (await resetBetweenChecks()) return true;
  if (state.relaunched) return false; // only ever once per run
  state.relaunched = true;
  try {
    const { gmailLogin } = await import('./login');
    await gmailLogin({});
    await sleep(2500);
    return await resetBetweenChecks();
  } catch {
    return false;
  }
}

/**
 * Run one check in isolation.
 *
 * The try/catch is the feature, not defensive noise: check 4 (two views must
 * differ) is worthless if check 3 threw and stopped the run, and check 3 is
 * exactly the kind of thing that throws.
 */
/**
 * Errors that mean "could not run", never "the feature is broken".
 *
 * MEASURED 2026-08-02: the first run of the feature checks reported 11/15 with
 * three failures — LABEL_DIALOG_NOT_OPEN, BROWSER_BUSY and BROWSER_NOT_RUNNING —
 * on a mailbox that was completely healthy. The browser had died partway through
 * because the feature checks roughly double the browser work a run does, and each
 * sub-call takes the driver lock independently. Those are conditions of the
 * harness, not findings about Gmail.
 */
const INFRA_CODES = new Set(['BROWSER_BUSY', 'BROWSER_NOT_RUNNING', 'CDP_UNREACHABLE', 'PAGE_NOT_FOUND']);

function infraReason(e: unknown): string | null {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === 'string' && INFRA_CODES.has(code)) return code;
  const msg = e instanceof Error ? e.message : String(e);
  for (const c of INFRA_CODES) if (msg.includes(c)) return c;
  return null;
}

async function run(name: string, severity: CheckResult['severity'], body: CheckBody): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const detail = await body();
    return { name, ok: true, detail, ms: Date.now() - t0, severity };
  } catch (e) {
    const infra = infraReason(e);
    if (infra) {
      return {
        name,
        ok: true,
        skipped: true,
        detail: `SKIPPED — could not run (${infra}); this says nothing about the feature`,
        ms: Date.now() - t0,
        severity,
      };
    }
    const soft = e instanceof SoftFail;
    return {
      name,
      ok: false,
      detail: soft ? `AMBIGUOUS — ${e.message}` : reason(e),
      ms: Date.now() - t0,
      severity: soft ? 'warn' : severity,
    };
  }
}

// ─── page probes ─────────────────────────────────────────────────────────────

const S = COMPOSE_SELECTORS;
const q = (v: unknown) => JSON.stringify(v);

/**
 * The desktop landmarks. Identical to cdp-client's UI_LANDMARKS — cdp-client's
 * own guard passes when ANY ONE is present (it exists to reject a wholly
 * different surface); this canary wants ALL THREE, because losing just the
 * Compose button or just `tr.zA` is drift that the one-of-three guard cannot
 * see and that turns reads into confident empties.
 */
const UI_LANDMARKS = ['[gh="mtb"]', 'tr.zA', 'div[role="button"].T-I.T-I-KE.L3'] as const;

interface LandmarkProbe {
  hit: string[];
  missing: string[];
  url: string;
  hash: string;
}

/**
 * `tr.zA` only exists on a LIST view, so the probe routes to `#inbox` first when
 * the browser happens to be parked on an open thread. That is the same nudge
 * every read op performs (gotoHash), not an extra liberty taken with the
 * operator's window.
 */
/** @internal Exported ONLY so the unit tests can compile this exact string. */
export const JS_LANDMARKS = `
  const want = ${q(UI_LANDMARKS)};
  if (!document.querySelector('tr.zA')) {
    if (!/#(inbox|all|sent|label|search)/.test(location.hash)) location.hash = '#inbox';
    for (let i = 0; i < 20 && !document.querySelector('tr.zA'); i++) await new Promise(r => setTimeout(r, 400));
  }
  const hit = want.filter(s => { try { return !!document.querySelector(s); } catch (e) { void e; return false; } });
  return { hit, missing: want.filter(s => hit.indexOf(s) < 0), url: location.href, hash: location.hash };`;

interface ComposeProbe {
  /** True when a compose was ALREADY open before we touched anything — abort, do not discard it. */
  preexisting: boolean;
  clicked: boolean;
  to: number;
  subject: number;
  body: number;
  send: number;
  discarded: boolean;
  /** Any compose body still visible after the discard. True = we left something on screen. */
  stillOpen: boolean;
  note: string;
}

/**
 * Open a compose, read which of the four controls the REAL `__scope()` resolver
 * finds, then discard it.
 *
 * 🔴 Uses compose.ts's own `JS_LIB` and `COMPOSE_SELECTORS` rather than a copy.
 * A canary that reimplements `__scope()` would have passed happily through the
 * whole bug it exists to catch: the resolver walked ≤12 ancestors from the last
 * visible body for a Send button, else `body.parentElement`, and landed on a
 * container too narrow to hold the To field. Testing a copy tests the copy.
 *
 * The discard runs in a `finally`-shaped tail: it happens whether or not the
 * four controls resolved, because a half-open compose left on screen is a worse
 * outcome than a failed check.
 */
/**
 * @internal Exported ONLY so the unit tests can compile this exact string as an
 * async function body — the same way cdp.evaluate will. A template typo here is
 * otherwise invisible until it reaches a live browser as PAGE_EVAL_ERROR.
 */
export const JS_COMPOSE = `
  ${JS_LIB}
  const out = { preexisting: false, clicked: false, to: 0, subject: 0, body: 0, send: 0,
                discarded: false, stillOpen: false, note: '' };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // A compose already on screen may be the operator's unfinished mail. Refuse.
  if (__visAll(${q(S.body)}).length > 0) { out.preexisting = true; return out; }

  let btn = __last(__visAll(${q(S.composeBtn)}));
  if (!btn) btn = __last(__visAll('div[role="button"], button').filter(x => __label(x).toLowerCase() === 'compose'));
  if (!btn) { out.note = 'the Compose button was not found (' + ${q(S.composeBtn)} + ' and no button labelled "Compose")'; return out; }
  out.clicked = __click(btn);

  for (let i = 0; i < 25; i++) {
    const sc = __scope();
    out.to      = sc ? (__fieldInput(sc, 'to') ? 1 : 0) : 0;
    out.subject = sc ? __visAll(${q(S.subject)}, sc).length : 0;
    out.body    = sc ? __visAll(${q(S.body)}, sc).length : 0;
    out.send    = sc ? __visAll(${q(S.send)}, sc).length : 0;
    if (out.to && out.subject && out.body && out.send) break;
    await sleep(400);
  }

  // Discard unconditionally. Nothing was typed, so Gmail has had no content to
  // auto-save; this only closes the dialog we opened.
  try {
    const sc = __scope();
    let d = __last(__visAll(${q(S.discard)}, sc)) || __last(__visAll(${q(S.discard)}));
    if (!d && sc) d = __last(__visAll('[role="button"]', sc).filter(x => /discard/i.test(__label(x))));
    if (d) { out.discarded = __click(d); }
    else { out.note = (out.note ? out.note + '; ' : '') + 'no Discard control found (' + ${q(S.discard)} + ')'; }
  } catch (e) {
    out.note = (out.note ? out.note + '; ' : '') + 'discard threw: ' + String((e && e.message) || e);
  }
  await sleep(1000);
  out.stillOpen = __visAll(${q(S.body)}).length > 0;
  return out;`;


/**
 * @internal Exported so the unit tests can compile this exact string.
 *
 * Writes through the connector's REAL body resolver and verifies through a
 * DIFFERENT one. That asymmetry is the whole point: the bug this exists to catch
 * had the write and the readback share \`__bodyEl()\`, so they agreed perfectly
 * while the text went into Gmail's "Describe your message" AI prompt and every
 * message went out EMPTY reporting verified: true. A readback that reuses the
 * writer's resolver cannot detect a targeting error — it can only confirm that
 * the resolver is self-consistent.
 *
 * So the assertion is two-sided: the marker must be in the canonical Message
 * Body, AND in no other editable textbox on the page.
 */
export const JS_BODY_TARGET = `
  ${JS_LIB}
  const out = { preexisting: false, clicked: false, wroteVia: '', inCanonical: false,
                strays: [], discarded: false, note: '' };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const MARK = 'lmcanary-' + Math.random().toString(36).slice(2, 10);

  if (__visAll(${q(S.body)}).length > 0) { out.preexisting = true; return out; }

  let btn = __last(__visAll(${q(S.composeBtn)}));
  if (!btn) btn = __last(__visAll('div[role="button"], button').filter(x => __label(x).toLowerCase() === 'compose'));
  if (!btn) { out.note = 'the Compose button was not found'; return out; }
  out.clicked = __click(btn);

  for (let i = 0; i < 25 && !__bodyEl(); i++) await sleep(400);
  const el = __bodyEl();
  if (!el) { out.note = 'the body resolver returned nothing after opening a compose'; return out; }
  out.wroteVia = String(el.getAttribute('aria-label') || el.className || el.tagName);

  el.replaceChildren();
  el.appendChild(document.createTextNode(MARK));
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  await sleep(500);

  const canon = __visAll('div[aria-label="Message Body"][role="textbox"]');
  out.inCanonical = canon.some(b => String(b.innerText || '').indexOf(MARK) >= 0);
  out.strays = __visAll('div[contenteditable="true"][role="textbox"]')
    .filter(b => b.getAttribute('aria-label') !== 'Message Body')
    .filter(b => String(b.innerText || '').indexOf(MARK) >= 0)
    .map(b => String(b.getAttribute('aria-label') || b.className || 'unlabelled'));

  try {
    const sc = __scope();
    let d = __last(__visAll(${q(S.discard)}, sc)) || __last(__visAll(${q(S.discard)}));
    if (!d && sc) d = __last(__visAll('[role="button"]', sc).filter(x => /discard/i.test(__label(x))));
    if (d) out.discarded = __click(d);
    else out.note = (out.note ? out.note + '; ' : '') + 'no Discard control found';
  } catch (e) {
    out.note = (out.note ? out.note + '; ' : '') + 'discard threw: ' + String((e && e.message) || e);
  }
  await sleep(900);
  return out;`;

/**
 * Does text written through the connector's body resolver actually reach the
 * message body? See JS_BODY_TARGET for why this is verified independently.
 */
async function checkBodyTarget(): Promise<string> {
  const r = await pageProbe(async (cdp) =>
    cdp.evaluate<{
      preexisting: boolean; clicked: boolean; wroteVia: string;
      inCanonical: boolean; strays: string[]; discarded: boolean; note: string;
    }>(JS_BODY_TARGET),
  );
  if (r.preexisting) throw new SoftFail('a compose was already open — leaving the operator\'s unfinished mail alone');
  if (!r.clicked || !r.wroteVia) throw new SoftFail(r.note || 'could not open a compose to test');
  if (!r.inCanonical || r.strays.length > 0) {
    throw new GmDriftError(
      'COMPOSE_BODY_MISTARGETED',
      'text written through the connector\'s own body resolver lands in the canonical Message Body and nowhere else',
      `resolved "${r.wroteVia}"; reached the Message Body: ${r.inCanonical}; also landed in: ${r.strays.join(', ') || '(nothing)'} — a mistargeted body sends EMPTY mail, and any readback sharing the resolver will still report success`,
      r,
    );
  }
  return `body text reaches the canonical Message Body and nothing else (resolved "${r.wroteVia}")`;
}

// ─── shared run state ────────────────────────────────────────────────────────

/**
 * One inbox listing shared by the checks that need rows.
 *
 * Isolation is about FAILURE (one check must not abort another), not about
 * refusing to reuse a result. A browser round trip is seconds of the operator's
 * window being driven, so checks 4 and 5 reuse check 3's rows when it produced
 * some, and fetch their own when it did not.
 */
interface RunState {
  inbox: GmailThread[] | null;
}

/** A row that can be opened without changing anything: already read, real id. */
function safeToOpen(rows: GmailThread[] | null): GmailThread | null {
  if (!Array.isArray(rows)) return null;
  return rows.find((r) => r.unread === false && looksLikeThreadId(String(r.threadId ?? ''))) ?? null;
}

// ─── the checks ──────────────────────────────────────────────────────────────

async function checkDriver(): Promise<string> {
  const st = await cdpStatus();
  if (!st.loggedIn) {
    throw new Error(
      `the driver browser answered but is NOT logged in (self=${st.self || 'unknown'}, ui=${st.ui}) — run gmail_login and finish the Google sign-in`,
    );
  }
  return `logged in as ${st.self || '(unknown)'}; sends as ${st.defaultSendAs || '(unknown)'}; ui=${st.ui}`;
}

async function checkLandmarks(): Promise<string> {
  const r = await pageProbe((cdp: Cdp) => cdp.evaluate<LandmarkProbe>(JS_LANDMARKS));
  const hit = Array.isArray(r?.hit) ? r.hit : [];
  const missing = Array.isArray(r?.missing) ? r.missing : UI_LANDMARKS.slice();
  if (missing.length) {
    throw new GmDriftError(
      'DRIFT_UI_LANDMARKS',
      'the desktop mail app exposes its toolbar, its list rows and its Compose button',
      `${hit.length}/3 desktop landmarks present at ${r?.url || 'unknown url'} (hash ${r?.hash || '?'}); MISSING: ${missing.join(', ')}. cdp-client's own guard passes on any one of the three, so a partial loss like this reads as a healthy surface while turning reads into confident empties.`,
      { hit, missing, url: r?.url },
    );
  }
  return `all 3 landmarks present (${hit.join(', ')})`;
}

async function checkInboxRows(state: RunState): Promise<string> {
  const rows = await listThreads({ label: 'inbox', limit: 25 });
  state.inbox = rows;
  assertThreadRows(rows, { view: 'inbox', expectNonEmpty: true });

  const wellFormed = rows.filter((r) => looksLikeThreadId(String(r.threadId ?? ''))).length;
  const pct = Math.round((wellFormed * 100) / rows.length);
  if (pct < 80) {
    throw new GmDriftError(
      'DRIFT_ROWS_MALFORMED',
      'at least 80% of inbox rows carry a 16-hex data-legacy-thread-id',
      `only ${wellFormed}/${rows.length} inbox rows (${pct}%) carry a well-formed 16-hex thread id. Rows rendered, so this is drift on [data-legacy-thread-id] — every id below the bar is a thread nothing can open.`,
      { count: rows.length, wellFormed },
    );
  }
  return `${rows.length} row(s); ${pct}% carry a 16-hex thread id`;
}

/**
 * 🔴 THE stale-container canary. Gmail retains previous view containers (3 list
 * tables x 50 rows measured, only one visible), and an unscoped read returns the
 * stale rows FIRST — which is how `#sent` served the Inbox with a full,
 * well-formed, entirely wrong payload.
 */
async function checkViewsDistinct(state: RunState): Promise<string> {
  const inbox = state.inbox?.length ? state.inbox : await listThreads({ label: 'inbox', limit: 10 });
  if (!inbox.length) throw new SoftFail('the inbox returned no rows, so there is nothing to compare a second view against');

  // `#label/sent` is how listThreads routes a named view; `in:sent` is the
  // deterministic hash-route fallback. Either way the invariant is the same, and
  // WHICH ONE ANSWERED is reported — a fallback that silently replaced the view
  // under test would make a pass meaningless.
  let sent: GmailThread[] = [];
  let via = '#label/sent';
  try {
    sent = await listThreads({ label: 'sent', limit: 10 });
  } catch {
    sent = [];
  }
  if (!sent.length) {
    via = '#search/in:sent';
    sent = await searchThreads('in:sent', 10);
  }
  if (!sent.length) throw new SoftFail('no Sent rows from either #label/sent or in:sent — nothing to compare');

  assertDistinctViews(inbox, sent, { viewA: 'inbox', viewB: via, depth: 3 });
  return `inbox top-3 differs from ${via} top-3 (${inbox.length} vs ${sent.length} rows read)`;
}

/**
 * 🔴 THE wrong-thread canary. `#all/<legacy-hex>` silently no-ops (different id
 * space) while still setting location.hash to the requested id, so the hash
 * certifies the wrong conversation. Verified here the only way that works:
 * against `data-legacy-message-id` on what actually rendered.
 */

/**
 * The page-supplied tokens the connector depends on outside the DOM.
 *
 * These are the values that make the NON-DOM paths work, and each one fails
 * silently: a wrong `ik` yields an error page that parses as an empty message,
 * and a missing XSRF token makes the internal endpoints reject before reading
 * the payload. If Google moves them, this is where we find out.
 */
async function checkPageTokens(): Promise<string> {
  const r = await pageProbe(async (cdp) =>
    cdp.evaluate<{ ik: string | null; email: string | null; xsrf: string | null }>(
      `const g = window.GLOBALS || [];
       const ik = typeof g[9] === 'string' ? g[9] : null;
       const email = typeof g[10] === 'string' && g[10].indexOf('@') > 0 ? g[10] : null;
       let xsrf = null;
       try {
         const src = [...document.querySelectorAll('script')].map((x) => x.textContent || '').join('');
         const m = src.match(/"sdpc","([^"]+)"/);
         xsrf = m ? m[1] : null;
       } catch (e) {}
       return { ik, email, xsrf };`,
    ),
  );
  const missing: string[] = [];
  if (!r.ik || !/^[0-9a-f]{6,}$/i.test(r.ik)) missing.push(`ik (GLOBALS[9] = ${JSON.stringify(r.ik)})`);
  if (!r.email) missing.push(`account address (GLOBALS[10] = ${JSON.stringify(r.email)})`);
  if (!r.xsrf) missing.push('XSRF token (inline script ["sdpc","<token>"])');
  if (missing.length) {
    throw new GmDriftError(
      'PAGE_TOKENS_MOVED',
      'the page still publishes ik, the account address and the XSRF token where the connector reads them',
      `missing or malformed: ${missing.join('; ')} — Google has moved or renamed them, and the paths that use them fail SILENTLY (a bad ik returns an error page that parses as an empty message)`,
      r,
    );
  }
  return `ik, account address and XSRF token all present and well-formed`;
}

/**
 * The raw-source read path (view=om), which is what makes a FULL message
 * readable — the rendered DOM clips long messages and hides trimmed quotes.
 * A wrong ik or a changed endpoint returns an HTML error page, and the parser
 * would report that as an empty message rather than a failure.
 */
async function checkRawSource(state: RunState): Promise<string> {
  const rows = state.inbox?.length ? state.inbox : await listThreads({ label: 'inbox', limit: 25 });
  // MEASURED 2026-07-30: sampling ONE thread conflates "this message has no raw
  // source" with "the raw-source path is broken". Threads the connector itself
  // created answer notExist=true, so a canary that happened to pick one reported
  // a dead read path while it was working. Try several; fail only if none works.
  const cands = rows.filter((r) => !r.unread && r.threadId && looksLikeThreadId(r.threadId)).slice(0, 5);
  if (cands.length === 0) throw new SoftFail('no already-read inbox row to sample (opening an unread one would mark it read)');
  const tried: Array<{ id: string; status: number; len: number; notExist: boolean }> = [];
  for (const cand of cands) {
    const id = String(cand.threadId);
  const r = await pageProbe(async (cdp) =>
    cdp.evaluate<{ status: number; len: number; rfc822: boolean; notExist: boolean }>(
      `const g = window.GLOBALS || [];
       const ik = typeof g[9] === 'string' ? g[9] : '';
       const res = await fetch('/mail/u/0/?ui=2&ik=' + ik + '&view=om&th=' + ${JSON.stringify(id)}, { credentials: 'include' });
       const html = await res.text();
       const m = html.match(/<pre[^>]*>([\\s\\S]*?)<\\/pre>/i);
       const dec = (x) => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
       const src = m ? dec(m[1]) : '';
       return { status: res.status, len: src.length,
                rfc822: /^(Delivered-To|Received|Return-Path|MIME-Version|From):/mi.test(src.slice(0, 3000)),
                notExist: /does not exist/i.test(html) };`,
    ),
  );
    if (r.rfc822) return `raw source reachable (${r.len} chars of RFC822 for ${id}; ${tried.length} thread(s) skipped as notExist)`;
    tried.push({ id, status: r.status, len: r.len, notExist: r.notExist });
  }
  throw new GmDriftError(
    'RAW_SOURCE_UNAVAILABLE',
    'view=om returns RFC822 source for at least one known thread',
    `${tried.length} thread(s) tried, none returned RFC822: ${tried
      .map((t) => `${t.id} (status ${t.status}, ${t.len} chars, notExist=${t.notExist})`)
      .join('; ')} — full-message reads would silently return nothing`,
    { tried },
  );
}

async function checkThreadIdentity(state: RunState): Promise<string> {
  const rows = state.inbox?.length ? state.inbox : await listThreads({ label: 'inbox', limit: 25 });

  // TWO different threads, deliberately. A single read CANNOT detect the failure
  // this check exists for: navigating #all/<legacy-hex> silently no-ops, so the
  // first read looks correct and the SECOND read of a DIFFERENT thread returns the
  // FIRST one's mail. Reading once tests a well-formed shape; reading twice tests
  // that state does not carry over — which is the actual bug.
  const targets = safeToOpenMany(rows, 2);
  if (targets.length === 0) {
    throw new SoftFail(
      'no already-read inbox row with a 16-hex id to open — opening an UNREAD thread would MARK IT READ, and this canary does not mutate mail',
    );
  }
  if (targets.length === 1) {
    const only = String(targets[0].threadId);
    const d = await readThread(only);
    assertThreadMatches(only, d);
    throw new SoftFail(
      `only ONE already-read thread available (${only}); its id verified, but a single read cannot detect thread-to-thread bleed — the failure mode this check exists for`,
    );
  }

  const [a, b] = targets.map((t) => String(t.threadId));
  const da = await readThread(a);
  assertThreadMatches(a, da);
  const db = await readThread(b);
  assertThreadMatches(b, db);

  // The load-bearing assertion: two DIFFERENT threads must not return the same
  // conversation. assertThreadMatches alone is not enough — readThreadDom builds
  // `threadId` by echoing its argument, and the subject/messages can still be the
  // previous thread's.
  const sameSubject = (da.subject || '') === (db.subject || '') && (da.subject || '') !== '';
  const idsA = da.messages.map((m) => m.messageId).filter(Boolean).join(',');
  const idsB = db.messages.map((m) => m.messageId).filter(Boolean).join(',');
  if (sameSubject && idsA === idsB) {
    throw new GmDriftError(
      'THREAD_BLEED',
      'two different threads returned the same conversation',
      `read ${a} then ${b}; both returned subject "${String(da.subject).slice(0, 60)}" with identical message ids — the second read served the FIRST thread's mail`,
      { requested: [a, b], subject: da.subject, messageIds: idsA },
    );
  }
  return `read 2 threads (${a}, ${b}); each carries its own id and they returned different conversations`;
}

/** Up to `n` already-read rows with a well-formed id — never an UNREAD one, since opening it would mark it read. */
function safeToOpenMany(rows: GmailThread[], n: number): GmailThread[] {
  const out: GmailThread[] = [];
  for (const r of rows) {
    if (r.unread) continue;
    if (!r.threadId || !looksLikeThreadId(r.threadId)) continue;
    if (out.some((o) => o.threadId === r.threadId)) continue;
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

/** 🔴 0 identities is BROKEN, not empty — every account carries its own primary address. */
async function checkSendAs(): Promise<string> {
  const ids = await listSendAs();
  assertSendAs(ids);
  const def = ids.find((i) => i.isDefault);
  return `${ids.length} identity(ies), exactly one default (${def ? def.email : '?'})`;
}

async function checkLabels(): Promise<string> {
  const labels = await listLabels();
  assertNavLabels(labels); // throws on toolbar junk — that part is never ambiguous
  if (!labels.length) {
    throw new SoftFail(
      'no labels parsed from the left nav. Legitimate on an account with no user labels — and also exactly what drift on a[href*="#label/"] looks like, which is why this is a warn and not a verdict',
    );
  }
  return `${labels.length} nav label(s), none matching a toolbar control`;
}

async function checkCompose(): Promise<string> {
  const r = await pageProbe((cdp: Cdp) => cdp.evaluate<ComposeProbe>(JS_COMPOSE));
  if (r?.preexisting) {
    throw new SoftFail(
      'a compose window was already open — refusing to open or discard another, because that one may be the operator\'s unfinished mail',
    );
  }
  if (!r?.clicked) throw new Error(`could not open a compose${r?.note ? `: ${r.note}` : ''}`);

  // Assert AFTER the probe has already discarded: the page code discards
  // unconditionally, so a failure here cannot leave a dialog on screen.
  assertComposeReady({ to: r.to, subject: r.subject, body: r.body, send: r.send });

  if (!r.discarded || r.stillOpen) {
    throw new GmDriftError(
      'DRIFT_COMPOSE_NOT_DISCARDED',
      'the compose canary leaves nothing behind',
      `compose opened with all four controls, but discard ${r.discarded ? 'was clicked and the dialog is STILL open' : 'could not be performed'}${r.note ? ` (${r.note})` : ''}. Nothing was typed, so no draft can have been saved — but a dialog is on the operator's screen and the next read may resolve its scope instead of the mail list.`,
      { discarded: r.discarded, stillOpen: r.stillOpen, note: r.note },
    );
  }
  return 'compose exposed To + Subject + Body + Send together, then discarded cleanly (nothing typed, no draft)';
}

/**
 * Every artifact this file creates is named with this prefix.
 *
 * 🔴 CLEANUP ONLY EVER TOUCHES ITS OWN ARTIFACTS. Each teardown re-reads the live
 * list and removes only entries whose name carries this tag — never "the newest
 * draft", never "the label at index 0". A health check that deletes real mail
 * because a lookup drifted is far worse than one that leaves a stray label behind.
 */
const SELFCHECK_TAG = 'lm-selfcheck';
const stamp = (): string => `${SELFCHECK_TAG}-${Date.now().toString(36)}`;

/**
 * Labels round-trip: create -> rename -> delete.
 *
 * Covers gmail_create_label / gmail_rename_label / gmail_delete_label, none of
 * which any structural check exercises. Self-cleaning: the label exists for a few
 * seconds and is verified GONE at the end.
 */
async function checkLabelRoundTrip(): Promise<string> {
  const name = stamp();
  const renamed = `${name}-r`;
  let created = false;
  try {
    await createLabel(name);
    created = true;
    const afterCreate = await listLabels();
    if (!afterCreate.some((l: { name: string }) => l.name === name)) throw new Error(`created "${name}" but it is not in the label list`);

    await renameLabel(name, renamed);
    const afterRename = await listLabels();
    if (!afterRename.some((l: { name: string }) => l.name === renamed)) throw new Error(`renamed to "${renamed}" but it is not in the list`);
    if (afterRename.some((l: { name: string }) => l.name === name)) throw new Error(`renamed but the old name "${name}" is still present`);
    created = false; // it now lives under `renamed`

    await deleteLabel(renamed);
    const afterDelete = await listLabels();
    if (afterDelete.some((l: { name: string }) => l.name === renamed)) throw new Error(`deleted "${renamed}" but it is STILL listed`);
    return 'create -> rename -> delete all verified by re-reading the label list';
  } finally {
    // Best-effort teardown, scoped to OUR tag only.
    for (const n of [renamed, name]) {
      if (!n.startsWith(SELFCHECK_TAG)) continue;
      try {
        const live = await listLabels();
        if (live.some((l: { name: string }) => l.name === n)) await deleteLabel(n);
      } catch {
        /* leave it rather than risk deleting something else */
      }
    }
    void created;
  }
}

/**
 * Draft round-trip: create -> appears in Drafts -> delete -> gone.
 *
 * Covers gmail_draft / gmail_drafts / gmail_draft_delete. Nothing is ever SENT —
 * gmail_draft_send is deliberately out of scope, because a health check must not
 * deliver mail.
 */
async function checkDraftRoundTrip(): Promise<string> {
  const subject = stamp();
  let draftId: string | null = null;
  try {
    // Positional signature: (to, subject, body, format). An EMPTY recipient keeps
    // this un-sendable by construction — the draft cannot leave the account even
    // if some future change starts sending drafts.
    const made = await draftMail('', subject, 'lm-assist selfcheck probe — safe to delete', 'text');
    draftId = (made as { draftId?: string | null }).draftId ?? null;

    const drafts = await listDrafts(25);
    const hit = drafts.find((d: { subject?: string|null; draftId?: string|null }) => (d.subject || '').trim() === subject);
    if (!hit) throw new Error(`saved draft "${subject}" but it is not in the Drafts list`);
    draftId = draftId || hit.draftId;
    if (!draftId) throw new Error('draft saved and listed but carries no draftId');

    await deleteDraft(draftId);
    const after = await listDrafts(25);
    if (after.some((d: { subject?: string|null }) => (d.subject || '').trim() === subject)) throw new Error('deleted the draft but it is STILL listed');
    return 'create -> list -> delete verified by re-reading Drafts; nothing was sent';
  } finally {
    try {
      const live = await listDrafts(25);
      // Match on OUR subject, never on position.
      const mine = live.filter((d: { subject?: string|null; draftId?: string|null }) => (d.subject || '').trim().startsWith(SELFCHECK_TAG));
      for (const d of mine) if (d.draftId) await deleteDraft(d.draftId);
    } catch {
      /* leave it rather than risk deleting a real draft */
    }
  }
}

/*
 * 🔴 NO star-toggle check, deliberately — three attempts, three different failures,
 * all on a HEALTHY mailbox:
 *
 *   1. listThreads({label:'starred'}) -> routes to #label/starred, a view Gmail
 *      does not have (its starred view is #starred). PAGE_NOT_READY.
 *   2. searchThreads('is:starred')    -> the search INDEX lags the DOM, so an
 *      immediate re-read of a toggle that visibly took reads as unchanged.
 *   3. same search                    -> #search/is%3Astarred did not render
 *      within the wait, even from a freshly reset page.
 *
 * The common thread: the ACTION is a click on a row, and every verification route
 * available is slower and less reliable than the action itself. A check that
 * verifies on a weaker basis than the thing it tests will go red on a healthy
 * mailbox — which is precisely the crying-wolf failure this whole harness exists
 * to prevent, and worse than having no check at all.
 *
 * gmail_star stays covered by gmail_bulk's own star/unstar path and by manual
 * verification. If someone wants it here, it needs a verification basis as fast as
 * the click — reading the row's own star state in the same DOM pass, not a
 * navigation.
 */

/** Read-only surface probes: these tools must at least answer coherently. */
async function checkReadSurface(): Promise<string> {
  const bad: string[] = [];
  const summary = await gmailSummary().catch((e) => { bad.push(`summary: ${reason(e)}`); return null; });
  if (summary && typeof summary.labels !== 'number' && typeof (summary as { labels?: unknown }).labels !== 'object') {
    bad.push('summary returned no label count');
  }
  const aliases = await listSendAs().catch((e) => { bad.push(`aliases: ${reason(e)}`); return null; });
  if (aliases && aliases.length === 0) bad.push('aliases returned an EMPTY list (an account always has its primary address)');
  if (bad.length) throw new Error(bad.join('; '));
  return 'summary and aliases both answered coherently';
}

/** `deep` only. Everything about Gmail's attachment DOM is CANDIDATE, so this is a warn. */
async function checkAttachments(): Promise<string> {
  const hits = await searchThreads('has:attachment', 10);
  if (!hits.length) throw new SoftFail('the has:attachment search returned no threads — nothing to probe');
  const target = safeToOpen(hits);
  if (!target) {
    throw new SoftFail(
      'every has:attachment result is UNREAD — opening one would mark it read, and this canary does not mutate mail',
    );
  }
  const id = String(target.threadId);
  const rows = await listAttachments(id);
  if (!rows.length) {
    throw new SoftFail(
      `thread ${id} matched has:attachment but yielded 0 attachment rows. Every attachment selector in extractors.ts is CANDIDATE (never observed matching a real attachment), so an empty scan is indistinguishable from a thread whose attachment is inline — hence a warn, not a verdict`,
    );
  }

  // Repair-or-fail on every name: this is the one validator that returns data.
  const cleaned = rows.map((a) => assertAttachmentName(a.name));
  const named = cleaned.filter((n): n is string => typeof n === 'string' && n !== '');
  if (!named.length) throw new SoftFail(`${rows.length} attachment row(s) on ${id} but not one carried a name`);

  const withUrl = rows.filter((a) => typeof a.downloadUrl === 'string' && a.downloadUrl !== '');
  if (!withUrl.length) throw new SoftFail(`${rows.length} attachment row(s) on ${id}, none with a download URL`);
  const observed = withUrl.filter((a) => a.downloadUrlSource === 'observed').length;

  return `${rows.length} attachment(s) on ${id}; names well-formed (e.g. ${named[0]}); ${withUrl.length} with a URL (${observed} observed off a real anchor, ${withUrl.length - observed} constructed)`;
}

// ─── the suite ───────────────────────────────────────────────────────────────

/**
 * Run the canary suite against the live mail app.
 *
 * Never throws for a failed CHECK — a thrown suite is a suite that tells you
 * nothing about checks 5 through 9. It only rejects if the runner itself breaks.
 *
 * `deep` adds the attachment probe, which costs an extra search plus a thread
 * open with a full expand-all.
 */
export async function runSelfCheck(opts?: { deep?: boolean }): Promise<SelfCheckReport> {
  const startedAt = Date.now();
  const state: RunState = { inbox: null };
  const checks: CheckResult[] = [];

  // One reset before each check, so none of them inherits the previous one's page.
  const recov = { relaunched: false };
  const gated = async (name: string, sev: CheckResult['severity'], body: CheckBody): Promise<CheckResult> => {
    const clean = await resetOrRecover(recov);
    if (!clean) {
      return {
        name,
        ok: true,
        skipped: true,
        detail: 'SKIPPED — the page could not be reset to a clean state (browser gone); run gmail_login',
        ms: 0,
        severity: sev,
      };
    }
    return run(name, sev, body);
  };

  checks.push(await run('driver.reachable', 'critical', checkDriver));
  checks.push(await gated('ui.landmarks', 'critical', checkLandmarks));
  checks.push(await gated('list.inbox_rows', 'critical', () => checkInboxRows(state)));
  checks.push(await gated('list.views_distinct', 'critical', () => checkViewsDistinct(state)));
  checks.push(await gated('thread.identity', 'critical', () => checkThreadIdentity(state)));
  checks.push(await gated('sendas.identities', 'critical', checkSendAs));
  checks.push(await gated('labels.nav', 'critical', checkLabels));
  checks.push(await gated('api.page_tokens', 'critical', checkPageTokens));
  checks.push(await gated('api.raw_source', 'critical', () => checkRawSource(state)));

  // Small settle before driving the compose UI: the preceding checks navigate,
  // and clicking Compose mid-navigation is how a probe invents its own flake.
  await sleep(500);
  checks.push(await gated('compose.fields', 'critical', checkCompose));
  checks.push(await gated('compose.body_target', 'critical', checkBodyTarget));

  // Feature round-trips. These EXERCISE the verbs rather than inspecting the DOM
  // around them, which is the only way a broken verb gets caught before a user
  // hits it. Every one is self-cleaning and scoped to its own SELFCHECK_TAG.
  // Gate the whole feature block on ONE liveness probe. Without this a dead
  // browser produces four separate confusing failures instead of one honest line.
  let browserLive = true;
  try {
    await cdpStatus();
  } catch {
    browserLive = false;
  }
  if (!browserLive) {
    for (const n of ['feature.read_surface', 'feature.label_roundtrip', 'feature.draft_roundtrip', 'feature.star_toggle']) {
      checks.push({
        name: n,
        ok: true,
        skipped: true,
        detail: 'SKIPPED — no browser to drive; run gmail_login and re-check',
        ms: 0,
        severity: 'critical',
      });
    }
  } else {
    checks.push(await gated('feature.read_surface', 'critical', checkReadSurface));
    checks.push(await gated('feature.label_roundtrip', 'critical', checkLabelRoundTrip));
    checks.push(await gated('feature.draft_roundtrip', 'critical', checkDraftRoundTrip));
    }

  if (opts?.deep === true) {
    checks.push(await run('attachments.deep', 'warn', checkAttachments));
  }

  const skipped = checks.filter((c) => c.skipped === true);
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.every((c) => c.severity !== 'critical'),
    passed: checks.length - failed.length - skipped.length,
    skipped: skipped.length,
    failed: failed.length,
    checks,
    startedAt,
    ms: Date.now() - startedAt,
  };
}
