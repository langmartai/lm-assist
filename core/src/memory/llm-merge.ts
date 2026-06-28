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

// Claude Code OAuth /v1/messages requires the system prompt to begin with this identity line.
const CLAUDE_CODE_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude.";

export function buildMergePrompt(input: LlmMergeInput): { system: string; user: string } {
  const system =
    CLAUDE_CODE_PREAMBLE +
    '\n\nYou merge two diverged versions of a single Markdown memory file into ONE coherent version. ' +
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

/** Default runner: Claude Code OAuth → /v1/messages (no separate API key). Best-effort. */
async function defaultRunner(system: string, user: string): Promise<string> {
  const { anthropicOAuthPost } = await import('../utils/claude-oauth');
  const res = await anthropicOAuthPost(
    '/v1/messages',
    { model: 'claude-sonnet-4-6', max_tokens: 8000, system, messages: [{ role: 'user', content: user }] },
    // /v1/messages REQUIRES anthropic-version; without it the API rejects the
    // request with 400 ("anthropic-version: header is required") BEFORE inference,
    // which silently broke every memory merge (→ conflicts deferred, 0 resolved, 0 tokens).
    { timeoutMs: 60_000, extraHeaders: { 'anthropic-version': '2023-06-01' } },
  );
  if (res.status !== 200) throw new Error(`/v1/messages ${res.status}`);
  const blocks = (res.body as any)?.content;
  const text = Array.isArray(blocks) ? blocks.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('') : '';
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
