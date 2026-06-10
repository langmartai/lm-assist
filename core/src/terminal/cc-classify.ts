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

/** Classify the visible terminal text. Pure + deterministic; order = priority. */
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

  // 2. Auth problems
  d =
    find(/OAuth token has expired[^\n]*/i) ||
    find(/Invalid API key[^\n]*/i) ||
    find(/Invalid authentication credentials[^\n]*/i) ||
    find(/Credit balance is too low[^\n]*/i) ||
    find(/API Error:\s*401[^\n]*/i) ||
    find(/Please run \/login[^\n]*/i);
  if (d) return { state: 'auth_error', detail: d };

  // 3. Server-side throttle — explicitly NOT the user's usage limit (check before user limit)
  d = find(/Server is temporarily limiting requests \(not your usage limit\)[^\n]*/i) || find(/temporarily limiting requests[^\n]*/i);
  if (d) return { state: 'rate_limit_server', detail: d };

  // 4. User account usage limit
  d =
    find(/(Claude )?usage limit reached[^\n]*/i) ||
    find(/5-hour limit[^\n]*/i) ||
    find(/approaching your usage limit[^\n]*/i) ||
    find(/You've been rate limited[^\n]*/i) ||
    find(/limit reached[^\n]*reset[^\n]*/i);
  if (d) {
    return { state: 'rate_limit_user', detail: d, retryHint: find(/resets?\s*(at|in)[^\n]*/i) };
  }

  // 5. Overloaded / capacity (529)
  d = find(/Overloaded[^\n]*/i) || find(/overloaded_error/i) || find(/API Error:\s*529[^\n]*/i) || find(/Waiting for capacity[^\n]*/i);
  if (d) return { state: 'overloaded', detail: d };

  // 6. Other server / API errors (5xx)
  d = find(/API Error:\s*5\d\d[^\n]*/i) || find(/Internal server error[^\n]*/i) || find(/API Error \(.*5\d\d.*\)[^\n]*/i);
  if (d) return { state: 'server_error', detail: d };

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
