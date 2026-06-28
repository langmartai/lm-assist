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

/**
 * Default runner: a METERED Anthropic API key (ANTHROPIC_API_KEY) → /v1/messages.
 * It deliberately does NOT use the Claude Code OAuth token: that credential is for
 * Claude Code's own flow, not raw inference — calling /v1/messages with it misuses
 * the subscription (and is rate-limited). With no API key set, this throws → llmMerge
 * returns null → the conflict is DEFERRED (0 cost), never auto-merged.
 */
async function defaultRunner(system: string, user: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('no ANTHROPIC_API_KEY — LLM merge skipped (conflict deferred)');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8000, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`/v1/messages ${res.status}`);
  const body = (await res.json()) as { content?: Array<{ type: string; text: string }> };
  const blocks = body?.content;
  const text = Array.isArray(blocks) ? blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('') : '';
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
