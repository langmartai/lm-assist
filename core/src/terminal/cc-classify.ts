/**
 * Claude Code screen-state classifier — pure, platform-independent text
 * matching shared by both backends (tmux + wt) so `cc screen` returns the same
 * `state` everywhere. Patterns derive from the Claude Code CLI's on-screen
 * strings. No I/O — just classify already-captured terminal text.
 */

export type ScreenState =
  | 'folder_trust' // "Is this a project you created or one you trust?"
  | 'await_question' // a numbered choice / permission prompt waiting on the user
  | 'rate_limit_user' // the account's usage limit (5-hour / weekly) is reached
  | 'rate_limit_server' // "Server is temporarily limiting requests (not your usage limit)"
  | 'overloaded' // 529 / Overloaded / "Waiting for capacity"
  | 'server_error' // API Error 5xx / internal server error
  | 'auth_error' // invalid key / expired OAuth / credit too low / needs /login
  | 'busy' // actively working (spinner / "esc to interrupt")
  | 'idle' // at the prompt, ready for input
  | 'unknown';

export interface ScreenClassification {
  state: ScreenState;
  /** the line (or extracted fragment) that triggered the match */
  detail?: string;
  /** for await_question: the numbered options found */
  options?: string[];
  /** for rate_limit_*: extracted reset/retry hint if present */
  retryHint?: string;
}

/** Find the LAST (most recent) match of `re` in `t`, plus its start index. */
function findLast(t: string, re: RegExp): { detail: string; index: number } | undefined {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = g.exec(t))) {
    last = m;
    if (m.index === g.lastIndex) g.lastIndex++; // don't loop forever on a zero-width match
  }
  if (!last) return undefined;
  const detail = last[0].length > 200 ? last[0].slice(0, 200) : last[0];
  return { detail: detail.trim(), index: last.index };
}

/** Error-banner patterns Claude Code prints inline in the transcript. Several
 *  can be visible in one captured screen at once — an earlier one the session
 *  already moved past, and a later, currently-relevant one. Ranked by RECENCY
 *  (closest to the end of the text), not this list's order, so a stale banner
 *  can't shadow the real current state. */
const BANNER_PATTERNS: { state: ScreenState; re: RegExp }[] = [
  { state: 'auth_error', re: /OAuth token has expired[^\n]*/i },
  { state: 'auth_error', re: /Invalid API key[^\n]*/i },
  { state: 'auth_error', re: /Invalid authentication credentials[^\n]*/i },
  { state: 'auth_error', re: /Credit balance is too low[^\n]*/i },
  { state: 'auth_error', re: /API Error:\s*401[^\n]*/i },
  { state: 'auth_error', re: /Please run \/login[^\n]*/i },
  { state: 'rate_limit_server', re: /Server is temporarily limiting requests \(not your usage limit\)[^\n]*/i },
  { state: 'rate_limit_server', re: /temporarily limiting requests[^\n]*/i },
  { state: 'rate_limit_user', re: /(Claude )?usage limit reached[^\n]*/i },
  { state: 'rate_limit_user', re: /5-hour limit[^\n]*/i },
  { state: 'rate_limit_user', re: /approaching your usage limit[^\n]*/i },
  { state: 'rate_limit_user', re: /You've been rate limited[^\n]*/i },
  { state: 'rate_limit_user', re: /limit reached[^\n]*reset[^\n]*/i },
  { state: 'overloaded', re: /Overloaded[^\n]*/i },
  { state: 'overloaded', re: /overloaded_error/i },
  { state: 'overloaded', re: /API Error:\s*529[^\n]*/i },
  { state: 'overloaded', re: /Waiting for capacity[^\n]*/i },
  { state: 'server_error', re: /API Error:\s*5\d\d[^\n]*/i },
  { state: 'server_error', re: /Internal server error[^\n]*/i },
  { state: 'server_error', re: /API Error \(.*5\d\d.*\)[^\n]*/i },
];

/** Classify the visible terminal text. Pure + deterministic. */
export function classifyScreen(text: string): ScreenClassification {
  const t = text || '';
  const find = (re: RegExp): string | undefined => {
    const m = t.match(re);
    return m ? (m[0].length > 200 ? m[0].slice(0, 200) : m[0]).trim() : undefined;
  };

  // 1. Folder-trust prompt (highest priority — blocks everything, auto-handleable)
  let d =
    find(/Is this a project you created or one you trust\??/i) ||
    find(/Do you trust the files in this folder\??/i) ||
    find(/Yes, I trust this folder/i);
  if (d) return { state: 'folder_trust', detail: d };

  // 2-6. Error banners (auth / server throttle / user throttle / overloaded /
  // other 5xx) — whichever matches CLOSEST TO THE END of the text wins.
  let best: { state: ScreenState; detail: string; index: number } | undefined;
  for (const { state, re } of BANNER_PATTERNS) {
    const hit = findLast(t, re);
    if (hit && (!best || hit.index > best.index)) best = { state, ...hit };
  }
  if (best) {
    if (best.state === 'rate_limit_user') {
      return { state: 'rate_limit_user', detail: best.detail, retryHint: find(/resets?\s*(at|in)[^\n]*/i) };
    }
    return { state: best.state, detail: best.detail };
  }

  // 7. A question / numbered choice waiting on the user (permission prompts, etc.)
  if (/Enter to confirm|Do you want to (proceed|continue|create|run|make|allow)/i.test(t) || /❯\s*\d+\.\s+\S/.test(t)) {
    const options = (t.match(/^[\s│]*[❯>]?\s*(\d+\.\s+.+?)\s*$/gim) || [])
      .map((l) => l.replace(/^[\s│❯>]+/, '').trim())
      .filter(Boolean)
      .slice(0, 9);
    if (options.length > 0) {
      return { state: 'await_question', detail: find(/(Do you want to[^\n]*|[^\n]*\?)\s*$/m) || options[0], options };
    }
  }

  // 8. Busy (actively working)
  if (/esc to interrupt|\besc\b.*interrupt|Running…|tokens? ·|⏵⏵|✻|✶|·\s*\d+\s*tokens/i.test(t)) {
    return { state: 'busy', detail: find(/[^\n]*esc to interrupt[^\n]*/i) };
  }

  // 9. Idle at the prompt
  if (/[❯>]\s*$|bypass permissions on|for shortcuts|\bctx:\d+%/i.test(t)) {
    return { state: 'idle' };
  }

  return { state: 'unknown' };
}
