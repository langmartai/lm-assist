/**
 * LLM conflict resolver for the hybrid auto-merge: only invoked when merge3 reports an OVERLAPPING
 * conflict (rare — same region edited on two nodes). Given base/local/peer it asks an LLM to produce
 * ONE coherent merged file, losing no information. Best-effort: any failure (no auth, error, invalid
 * output) returns null so the caller degrades to keeping the conflict (markers + a reconcile-plan item)
 * — never writes garbage to live memory, never silently drops a curated edit.
 *
 * The runner is injectable so the prompt/extract/validate logic is unit-tested without a real LLM.
 */

export interface LlmMergeInput { filename: string; base: string; local: string; peer: string }
export type MergeRunner = (system: string, user: string, input: LlmMergeInput) => Promise<string>;

export function buildMergePrompt(input: LlmMergeInput): { system: string; user: string } {
  const system =
    'You merge two diverged versions of a single Markdown memory file into ONE coherent version. ' +
    'Rules: lose NO information; combine complementary facts; if the versions contradict, keep the more ' +
    'specific statement (note the other only if it adds value); preserve a single valid YAML frontmatter ' +
    'block (--- … ---) merging its fields sensibly; output ONLY the merged file content — no commentary, ' +
    'no code fences.';
  const user =
    `Three versions of "${input.filename}" are attached: base.md (the common ancestor), ` +
    'local.md, and peer.md. Merge local.md and peer.md into ONE coherent file, using base.md ' +
    'as the ancestor. Return the merged file.';
  return { system, user };
}

/** Strip a leading/trailing ``` fence the model may wrap the file in, and trim. */
export function extractMerged(raw: string): string {
  let s = (raw || '').trim();
  const fence = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  if (fence) s = fence[1].trim();
  return s;
}

/** Memory-merge model on the claude.ai conversation API. A focused merge task —
 *  sonnet is plenty (the frontmatter-validation guard rejects bad output → defer,
 *  so an imperfect merge never corrupts live memory). Override via MEMORY_MERGE_MODEL. */
const MERGE_MODEL = process.env.MEMORY_MERGE_MODEL || 'claude-sonnet-4-6';

/**
 * Default runner: the SANCTIONED claude.ai web conversation API (session cookie),
 * NOT the Claude Code OAuth token (which is for Claude Code's own flow, not raw
 * inference). Each merge spins up a THROWAWAY conversation tagged for auto-deletion
 * (`autoDeleteHours: 1` → `[lm-autodel]` marker → swept by the cleanup-test-conversations
 * job), sends the merge prompt, and returns the reply text. With no claude.ai session
 * configured it throws → llmMerge returns null → the conflict is DEFERRED (0 cost).
 */
/** A claude.ai TEXT attachment ({@link sendMessage} `attachments` channel) — the
 *  reliable channel for markdown/source (the `files` upload channel is for binaries
 *  and often fails to auto-extract text). Shape verified live against claude.ai. */
function textAttachment(name: string, content: string) {
  return {
    file_name: name,
    file_type: 'text/markdown',
    file_size: Buffer.byteLength(content, 'utf8'),
    extracted_content: content,
    origin: 'user_upload',
    kind: 'file',
  };
}

async function defaultRunner(system: string, user: string, input: LlmMergeInput): Promise<string> {
  const { createConversation, sendMessage, deleteConversation } = await import('../utils/claudeai-session');
  const { randomUUID } = await import('node:crypto');
  const convUuid = randomUUID();
  await createConversation({ uuid: convUuid, name: 'lm-assist memory-merge (auto)', model: MERGE_MODEL, autoDeleteHours: 1 });
  try {
    // The three versions ride as ATTACHMENTS (not inlined in the prompt) — keeps the
    // prompt small and lets the model see each file directly. claude.ai conversations
    // have no separate `system` param, so fold the instructions into the prompt.
    const attachments = [
      textAttachment('base.md', input.base),
      textAttachment('local.md', input.local),
      textAttachment('peer.md', input.peer),
    ];
    const res = await sendMessage(convUuid, `${system}\n\n${user}`, { model: MERGE_MODEL, attachments });
    const text = (res?.text || '').trim();
    if (!text) throw new Error('empty completion');
    return text;
  } finally {
    // Delete the throwaway conversation NOW — don't leave it in Recents. The
    // `autoDeleteHours` name marker is only a fallback: the cleanup sweep removes
    // VERIFIED ids, not arbitrary expired tags, so tagged convs otherwise linger.
    try { await deleteConversation(convUuid); } catch { /* fallback: the [lm-autodel] marker */ }
  }
}

export async function llmMerge(input: LlmMergeInput, runner: MergeRunner = defaultRunner): Promise<string | null> {
  try {
    const { system, user } = buildMergePrompt(input);
    const merged = extractMerged(await runner(system, user, input));
    if (!merged) return null;
    // If the inputs were valid memory files (frontmatter), the merge must be too — don't corrupt live memory.
    const { parseFrontmatter, isValidMemoryFrontmatter } = await import('../utils/frontmatter');
    const inputsHadFm = [input.local, input.peer].some((v) => {
      const p = parseFrontmatter(v);
      return p.hasFrontmatter && isValidMemoryFrontmatter(p.frontmatter);
    });
    if (inputsHadFm) {
      const p = parseFrontmatter(merged);
      if (!p.hasFrontmatter || !isValidMemoryFrontmatter(p.frontmatter)) return null;
    }
    return merged;
  } catch {
    return null;
  }
}
