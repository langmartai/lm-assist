// core/src/search/prompt-classifier.ts
// Decide whether a user-message turn is a REAL prompt worth ranking, or injected
// boilerplate that merely arrives through the user channel.
//
// WHY THIS IS SEPARATE FROM session-cache's classifyUserPrompt():
// that function's output is persisted in the session cache, so changing it means
// bumping CACHE_VERSION, which forces a full re-parse of every cached session on
// every node. This classifier is applied at INDEX time only and can therefore be
// revised whenever a new template shows up — a reindex of the prompt store is
// cheap, a fleet-wide transcript re-parse is not.
//
// The class list is measured, not guessed. Over 552 transcripts / 2857 user-channel
// messages, ~86% were injected: the single biggest source was the mission-controller
// INVARIANTS preamble at 1044 occurrences (37% of all prompts on its own), followed
// by controller drive prompts (466), the templated security review (346) and the
// core-restart reattach notice (179). Ranking user prompts without filtering these
// means ranking the fleet's own automation, not the operator's intent.

/** Why a prompt was judged synthetic. Kept queryable so the noise stays inspectable. */
export type PromptClass =
  | 'user'              // a real, topical prompt — the only class indexed by default
  | 'invariants'        // ⟦INVARIANTS ...⟧ controller preamble
  | 'envelope'          // any other ⟦...⟧ lm-assist injection envelope
  | 'task_notification' // <task-notification> subagent-completion injection
  | 'banner'            // a turn opening with a ═══/--- separator rule
  | 'controller_pass'   // "Run a controller pass now..."
  | 'security_review'   // templated "Review this change for security vulnerabilities"
  | 'core_restart'      // ⟦CORE RESTARTED — REATTACH⟧
  | 'interrupt'         // [Request interrupted by user]
  | 'teammate_message'  // cross-session <teammate-message>/<agent-message> envelopes
  | 'skill_preamble'    // "Base directory for this skill: ..."
  | 'worker_preamble'   // "# Worker preamble — ..."
  | 'compaction'        // "This session is being continued from a previous conversation"
  | 'command_wrapper'   // <command-name>/<local-command-stdout>/<local-command-caveat>
  | 'hook_feedback'     // Stop hook feedback / <user-prompt-submit-hook>
  | 'system_reminder'   // a turn that is nothing but <system-reminder>
  | 'bootstrap'         // [lm-assist bootstrap] ...
  | 'filler';           // "continue", "Go", "Warmup" — real, but carries no topical signal

export interface ClassifiedPrompt {
  promptClass: PromptClass;
  /** True for everything except `user`. Indexed, but filtered out of results by default. */
  synthetic: boolean;
  /** Text to hand the full-text index: injected blocks stripped from a real prompt. */
  indexText: string;
}

/**
 * Prefix/substring rules, checked in order. Ordering matters where templates nest
 * (a teammate envelope can itself contain a <system-reminder>).
 */
const RULES: Array<{ cls: PromptClass; test: (t: string) => boolean }> = [
  { cls: 'invariants',       test: (t) => t.startsWith('⟦INVARIANTS') },
  { cls: 'core_restart',     test: (t) => t.startsWith('⟦CORE RESTARTED') },
  // Every lm-assist injection wraps itself in ⟦...⟧. Matching the ENVELOPE rather than
  // each banner's wording means a template added later is filtered on the day it ships
  // instead of the day someone notices it polluting results.
  { cls: 'envelope',         test: (t) => t.startsWith('⟦') },
  // Subagent-completion notifications. These were invisible to a frequency scan of
  // prompt prefixes because each embeds a unique task-id, so no two are byte-equal —
  // they only surfaced once indexed output was inspected. Structure, not repetition,
  // is what identifies injected text.
  { cls: 'task_notification', test: (t) => t.startsWith('<task-notification') },
  { cls: 'controller_pass',  test: (t) => /^Run a controller pass\b/.test(t) },
  { cls: 'security_review',  test: (t) => t.startsWith('Review this change for security vulnerabilities') },
  { cls: 'interrupt',        test: (t) => t.startsWith('[Request interrupted by user') },
  { cls: 'teammate_message', test: (t) => t.startsWith('Another Claude session sent a message:') || t.startsWith('<teammate-message') || t.startsWith('<agent-message') },
  { cls: 'skill_preamble',   test: (t) => t.startsWith('Base directory for this skill:') },
  { cls: 'worker_preamble',  test: (t) => /^#\s*Worker preamble\b/.test(t) || /^You are the executor \(worker\) for mission\b/.test(t) },
  { cls: 'banner',           test: (t) => /^[=═─—_*#-]{10,}/.test(t) },
  // A SHORTER separator run still marks a template when it wraps an ALL-CAPS heading —
  // e.g. "=== DEEP MEMORY VALIDATOR -- READ CAREFULLY ===", an automation preamble that
  // recurs across sessions and was ranking as a real prompt. Deliberately narrow: it
  // needs the separators AND a caps run, so an ordinary prompt opening with "==" or a
  // markdown "## Heading" is untouched.
  { cls: 'banner',           test: (t) => /^[=─—═]{3,}\s*[A-Z][A-Z0-9 _\-]{11,}/.test(t) },
  { cls: 'compaction',       test: (t) => t.startsWith('This session is being continued from a previous conversation') },
  { cls: 'bootstrap',        test: (t) => t.startsWith('[lm-assist bootstrap]') },
  { cls: 'hook_feedback',    test: (t) => t.startsWith('Stop hook feedback:') || t.startsWith('<user-prompt-submit-hook>') },
  { cls: 'command_wrapper',  test: (t) => t.startsWith('<command-name>') || t.startsWith('<command-message>') || t.startsWith('<command-args>') || t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-caveat>') },
  { cls: 'system_reminder',  test: (t) => t.startsWith('<system-reminder>') },
];

/**
 * Prompts that are genuinely the operator's but carry no topical signal. They are
 * SHORT, which matters: bm25 rewards brevity, so an unfiltered "Go" would outrank a
 * real paragraph for the query "go". Listed exactly — a substring rule here would
 * swallow real prompts that merely begin with the same word.
 */
const FILLER = new Set([
  'continue', 'continue.', 'continue from where you left off.', 'continue from where you left off',
  'go', 'go.', 'go ahead', 'go ahead.', 'proceed', 'proceed.', 'warmup', 'yes', 'yes.', 'ok', 'okay',
  'y', 'n', 'no', 'no.', 'next', 'done', 'thanks', 'thank you', 'resume', 'resume.', 'carry on',
]);

/** Injected blocks that ride along INSIDE an otherwise real prompt. */
const EMBEDDED_BLOCKS: RegExp[] = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
  /<teammate-message[\s\S]*?<\/teammate-message>/g,
  /<agent-message[\s\S]*?<\/agent-message>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
];

/**
 * Strip injected blocks from a real prompt so they cannot contribute search terms.
 * A session-reminder naming the session, for instance, would otherwise make every
 * prompt in that session match the session's own name.
 */
export function stripEmbedded(text: string): string {
  let out = text;
  for (const re of EMBEDDED_BLOCKS) out = out.replace(re, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/** Does the text carry enough substance to be worth ranking? */
function hasSignal(text: string): boolean {
  // At least two word-ish tokens; a bare "ok" or a lone path fragment is not a topic.
  const words = text.split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length >= 2);
  if (words.length >= 2) return true;
  // CJK is written without spaces, so a whole Chinese/Japanese sentence tokenizes as ONE
  // "word" and would be discarded as filler. Several ideographs are a real topic — this
  // matters here: the fleet has genuine Chinese-language work (the WeChat client sessions).
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu);
  return (cjk?.length ?? 0) >= 2;
}

/**
 * Classify one user-channel message for indexing.
 *
 * `isMeta` comes from the transcript and already marks system-generated turns;
 * it is honoured before any text rule so a meta turn never lands as a real prompt.
 */
export function classifyPromptForIndex(text: string, isMeta?: boolean): ClassifiedPrompt {
  const raw = String(text || '');
  const trimmed = raw.trim();

  if (!trimmed) return { promptClass: 'system_reminder', synthetic: true, indexText: '' };

  if (isMeta) {
    return { promptClass: 'system_reminder', synthetic: true, indexText: stripEmbedded(trimmed) };
  }

  for (const r of RULES) {
    if (r.test(trimmed)) {
      // Synthetic text is still stored (queryable on request), just never ranked by default.
      return { promptClass: r.cls, synthetic: true, indexText: stripEmbedded(trimmed) };
    }
  }

  if (FILLER.has(trimmed.toLowerCase())) {
    return { promptClass: 'filler', synthetic: true, indexText: trimmed };
  }

  const cleaned = stripEmbedded(trimmed);

  // A turn that was ONLY an injected block reduces to nothing once stripped — and a
  // prompt left with no real words after stripping is noise, not a short question.
  if (!cleaned || !hasSignal(cleaned)) {
    return { promptClass: 'filler', synthetic: true, indexText: cleaned };
  }

  return { promptClass: 'user', synthetic: false, indexText: cleaned };
}
