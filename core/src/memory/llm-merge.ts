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
export type MergeRunner = (system: string, user: string) => Promise<string>;

export function buildMergePrompt(input: LlmMergeInput): { system: string; user: string } {
  const system =
    'You merge two diverged versions of a single Markdown memory file into ONE coherent version. ' +
    'Rules: lose NO information; combine complementary facts; if the versions contradict, keep the more ' +
    'specific statement (note the other only if it adds value); preserve a single valid YAML frontmatter ' +
    'block (--- … ---) merging its fields sensibly; output ONLY the merged file content — no commentary, ' +
    'no code fences.';
  const user =
    `File: ${input.filename}\n\n` +
    `=== BASE (common ancestor) ===\n${input.base}\n\n` +
    `=== VERSION A (local) ===\n${input.local}\n\n` +
    `=== VERSION B (peer) ===\n${input.peer}\n\n` +
    'Return the merged file.';
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
async function defaultRunner(system: string, user: string): Promise<string> {
  const { createConversation, sendMessage } = await import('../utils/claudeai-session');
  const { randomUUID } = await import('node:crypto');
  const convUuid = randomUUID();
  await createConversation({ uuid: convUuid, name: 'lm-assist memory-merge (auto)', model: MERGE_MODEL, autoDeleteHours: 1 });
  // claude.ai conversations have no separate `system` param — fold it into the prompt.
  const res = await sendMessage(convUuid, `${system}\n\n${user}`, { model: MERGE_MODEL });
  const text = (res?.text || '').trim();
  if (!text) throw new Error('empty completion');
  return text;
}

export async function llmMerge(input: LlmMergeInput, runner: MergeRunner = defaultRunner): Promise<string | null> {
  try {
    const { system, user } = buildMergePrompt(input);
    const merged = extractMerged(await runner(system, user));
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
