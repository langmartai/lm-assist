/**
 * Annotator — produce compact annotations for un-annotated turns of a session.
 *
 * Design notes:
 *   - UUID-level delta: skip already-annotated turns on re-runs.
 *   - Compact schema: short keys + role codes + omit-default fields. ~50%
 *     smaller output than full schema.
 *   - Chunks of turns in parallel (default pool of 3) to amortize boot latency.
 *   - Uses the Claude Agent SDK; per `sdk-runner.ts` it imports dynamically.
 *
 * Strategy: always uses isolated Haiku by default (~$0.04/chunk). The `forked`
 * strategy exists as opt-in but is ~18x more expensive (~$0.80/chunk Opus)
 * because each fork creates its own cache_creation entries for the full session
 * history. Cache reads (~18K system+tools) don't offset the creation cost.
 */
import * as fs from 'fs';
import type { CompactAnnotation, AnnotateOptions, AnnotateStrategy } from './types';
import { readSessionLines, extractTurns, type SessionTurn } from './jsonl-utils';
import { detectSessionCacheState } from './session-state';

export interface AnnotateResult {
  annotated: number;
  skipped: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  runtimeMs: number;
  chunksTotal: number;
  /** Per-chunk strategy used (auto resolved each chunk). */
  strategiesUsed: { isolated: number; forked: number };
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_CHUNK_SIZE = 25;
const DEFAULT_CONCURRENCY = 3;

function buildInstructions(turns: SessionTurn[]): string {
  return `Emit ONE compact annotation JSON per line (JSONL) per turn. USE SHORT KEYS. OMIT DEFAULT FIELDS.

Compact schema (short keys, 3-char role codes):
  "u" = uuid (REQUIRED, full uuid string)
  "t" = topics array (REQUIRED, 1-4 kebab-case tags)
  "r" = role code: "use" (user-brief) | "dec" (decision) | "sta" (state-change) | "ref" (reference) |
                   "rea" (reasoning) | "tol" (tool-output) | "imp" (imperative)
  "s" = one-line summary — for tool-output, ENCODE THE RESULT'S ESSENCE (filenames found,
        exit codes, key output values), not just the action name. Aim <=140 chars.
  "e" = entities array — OMIT if empty
  "k" = stickyness: "h" | "m" — OMIT if "l" (low, default)
  "i" = state_impact short text — OMIT if "none" (default)
  "ref" = referenced prior uuids array — OMIT if empty
  "kr" = keep raw — set "1" only on tool-output turns whose RAW content carries
         information not preserved in the summary. OMIT (default) for everything else.

When to set "kr":"1" (tool-output turns ONLY):
  - File contents the assistant would need to re-read verbatim (e.g. config files,
    code snippets the user might quote, schema definitions)
  - Exact error messages / stack traces that future debug needs to reference
  - Specific output values, query results, version strings
  - Search results where exact matches matter
When to OMIT "kr":
  - "ls" listings already enumerated in the summary
  - "mkdir" / "cp" / boilerplate commands with no informational output
  - Successful builds with no warnings ("build OK")
  - Anything where the summary is a complete substitute for the raw text

Example outputs:
  {"u":"abc-123...","t":["auth"],"r":"imp","s":"Always use TypeScript strict","k":"h"}
  {"u":"def-456...","t":["auth","redis"],"r":"dec","s":"Go with Redis sessions","e":["Redis","Express"],"k":"h"}
  {"u":"ghi-789...","t":["bash"],"r":"tol","s":"Listed schema/: 001_initial.sql, 002_soft_delete.sql"}
  {"u":"jkl-012...","t":["bash"],"r":"tol","s":"Read auth.ts (110 lines, defines SessionData)","kr":"1","e":["auth.ts","SessionData"]}
  {"u":"mno-345...","t":["test"],"r":"tol","s":"Test suite failed: TypeError at session.test.ts:42","kr":"1"}
  {"u":"pqr-678...","t":["filesystem"],"r":"tol","s":"Created /tmp/foo (mkdir succeeded)"}

Rules:
- One JSON per line, no fences, no preamble
- Keep summaries tight but content-rich for tool turns (encode the result, not just the call)
- Consistent topic tags across related turns
- Only tool-output role gets "kr"; OMIT for all other roles

Turns:
${JSON.stringify(turns, null, 1)}`;
}

interface CallResult {
  parsed: CompactAnnotation[];
  cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  strategy: 'isolated' | 'forked';
}

function parseAnnotationsFromText(text: string): CompactAnnotation[] {
  const cleaned = text.replace(/^```(?:jsonl?)?\n?/gm, '').replace(/\n?```$/gm, '').trim();
  const parsed: CompactAnnotation[] = [];
  for (const line of cleaned.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as CompactAnnotation;
      if (obj.u && obj.t) parsed.push(obj);
    } catch { /* swallow */ }
  }
  return parsed;
}

/** Isolated stateless Haiku call — no main session context. Cheap input. */
async function callIsolated(instructions: string, model: string): Promise<CallResult> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const pending: any[] = [{
    type: 'user',
    message: { role: 'user', content: instructions },
    session_id: 'annotator',
    parent_tool_use_id: null,
  }];
  async function* input() {
    if (pending.length) yield pending.shift();
    await new Promise<void>(() => { /* idle */ });
  }

  const q = query({
    prompt: input(),
    options: {
      model,
      tools: [],
      settingSources: [],
      permissionMode: 'bypassPermissions',
      systemPrompt:
        'JSONL emitter. ONLY JSONL lines with short keys u/t/r/s/e/k/i/ref/kr. No fences.',
      stderr: () => { /* swallow */ },
    } as any,
  });

  let text = '';
  let usage: any;
  let cost = 0;
  for await (const msg of q as any) {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const b of msg.message.content) if (b.type === 'text') text += b.text;
    }
    if (msg.type === 'result') {
      usage = msg.usage;
      cost = msg.total_cost_usd || 0;
      break;
    }
  }
  return {
    parsed: parseAnnotationsFromText(text),
    cost,
    input_tokens: usage?.input_tokens || 0,
    output_tokens: usage?.output_tokens || 0,
    cache_read_tokens: usage?.cache_read_input_tokens || 0,
    cache_creation_tokens: usage?.cache_creation_input_tokens || 0,
    strategy: 'isolated',
  };
}

/**
 * Forked-session Haiku call — resumes the main session as a fork, then sends
 * the annotation request as a new user turn. If the main session's prefix
 * (system + tools + history) is still in Anthropic's prompt cache, this hits
 * cache_read at 10% of base; otherwise it pays full input rate.
 *
 * Requires:
 *   - main sessionId must exist on disk
 *   - cwd matches the main session's cwd (so SDK loads the same project context)
 *   - same model as the main session for cache key match
 */
async function callForked(
  instructions: string,
  model: string,
  mainSessionId: string,
  cwd: string,
): Promise<CallResult> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const pending: any[] = [{
    type: 'user',
    message: { role: 'user', content: instructions },
    session_id: 'annotator-fork',
    parent_tool_use_id: null,
  }];
  async function* input() {
    if (pending.length) yield pending.shift();
    await new Promise<void>(() => { /* idle */ });
  }

  const q = query({
    prompt: input(),
    options: {
      model,
      cwd,                                       // must match main for cache match
      resume: mainSessionId,
      forkSession: true,                         // creates a fork — own JSONL, parent's history
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project'],       // loads same CLAUDE.md as main
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      stderr: () => { /* swallow */ },
    } as any,
  });

  let text = '';
  let usage: any;
  let cost = 0;
  for await (const msg of q as any) {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const b of msg.message.content) if (b.type === 'text') text += b.text;
    }
    if (msg.type === 'result') {
      usage = msg.usage;
      cost = msg.total_cost_usd || 0;
      break;
    }
  }
  return {
    parsed: parseAnnotationsFromText(text),
    cost,
    input_tokens: usage?.input_tokens || 0,
    output_tokens: usage?.output_tokens || 0,
    cache_read_tokens: usage?.cache_read_input_tokens || 0,
    cache_creation_tokens: usage?.cache_creation_input_tokens || 0,
    strategy: 'forked',
  };
}

/**
 * Resolve which strategy to use for a chunk, given options + session state.
 *
 * Economics (empirical, 10 turns/chunk): forked-Opus ~$0.80/chunk (18K cache
 * reads + 32K cache creation per fork) vs isolated-Haiku ~$0.04/chunk (2.5K
 * input). Forked is ~18x more expensive with no quality benefit for structured
 * metadata extraction. `auto` always picks isolated Haiku. `forked` is opt-in.
 */
function resolveStrategy(
  requested: AnnotateStrategy,
  sessionFile: string,
  mainSessionId: string,
): { strategy: 'isolated' | 'forked'; reason: string; model: string | null } {
  if (requested === 'isolated') {
    return { strategy: 'isolated', reason: 'explicit override', model: null };
  }
  const state = detectSessionCacheState(sessionFile);
  if (requested === 'forked') {
    // Explicit forked: use parent model for cache match, but require hot session
    if (!state.hot || !state.lastModel) {
      return {
        strategy: 'isolated',
        reason: `forked requested but session cold or no model (${state.reason})`,
        model: state.lastModel,
      };
    }
    return {
      strategy: 'forked',
      reason: `explicit forked, session hot (${state.reason})`,
      model: state.lastModel,
    };
  }
  // auto → always isolated Haiku (cheapest, quality is sufficient for annotation)
  return {
    strategy: 'isolated',
    reason: `auto → isolated (${state.reason})`,
    model: state.lastModel,
  };
}

async function pool<T, R>(
  items: T[],
  poolSize: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const running: Array<Promise<void>> = [];
  for (let i = 0; i < items.length; i++) {
    const p = fn(items[i], i).then((r) => { results[i] = r; });
    running.push(p);
    if (running.length >= poolSize) {
      await Promise.race(running);
      for (let j = running.length - 1; j >= 0; j--) {
        if ((await Promise.race([running[j], Promise.resolve('p')])) !== 'p') {
          running.splice(j, 1);
        }
      }
    }
  }
  await Promise.all(running);
  return results;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function annotate(
  sessionFile: string,
  annFile: string,
  opts: AnnotateOptions = {},
  onProgress?: (progress: {
    chunksTotal: number;
    chunksCompleted: number;
    annotationsWritten: number;
  }) => void,
): Promise<AnnotateResult> {
  const started = Date.now();
  const chunkSize = opts.chunkSize || DEFAULT_CHUNK_SIZE;
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
  const scope = opts.scope || 'delta';
  const strategyOpt: AnnotateStrategy = opts.strategy || 'auto';

  const lines = readSessionLines(sessionFile);
  const turns = extractTurns(lines);

  // Determine main session id + cwd from the session file itself.
  // First line may be a `permission-mode` entry without `cwd`; scan until we find both.
  let mainSessionId: string | null = null;
  let cwd: string | null = null;
  for (const l of lines) {
    if (!mainSessionId && (l as any).sessionId) mainSessionId = (l as any).sessionId;
    if (!cwd && (l as any).cwd) cwd = (l as any).cwd;
    if (mainSessionId && cwd) break;
  }

  // Resolve strategy ONCE up-front (per-chunk re-resolution would cost wall
  // clock time — and within a single annotate() call the cache state isn't
  // going to change unless TTL boundary crosses, which is rare).
  const resolved = resolveStrategy(strategyOpt, sessionFile, mainSessionId || '');
  // For isolated, always use Haiku (cheapest) unless user explicitly overrides.
  // For forked, use the parent's model (required for cache key match).
  const effectiveModel = opts.model
    || (resolved.strategy === 'forked' ? resolved.model : null)
    || DEFAULT_MODEL;

  // For 'forked' and 'auto', bail to isolated if we couldn't detect a model
  // or main sessionId
  let useStrategy = resolved.strategy;
  const isValidModel = resolved.model && resolved.model.startsWith('claude-');
  if (useStrategy === 'forked' && (!mainSessionId || !cwd || !isValidModel)) {
    console.warn(`[annotator] forked strategy bailed to isolated: mainSessionId=${!!mainSessionId}, cwd=${!!cwd}, model=${resolved.model}, isValidModel=${isValidModel}`);
    useStrategy = 'isolated';
  }
  console.log(`[annotator] strategy=${useStrategy} (requested=${strategyOpt}), model=${effectiveModel}, reason=${resolved.reason}`);

  // DELTA: read existing annotation UUIDs
  const existing = new Set<string>();
  if (scope === 'delta' && fs.existsSync(annFile)) {
    for (const l of fs.readFileSync(annFile, 'utf-8').split('\n')) {
      const t = l.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t) as CompactAnnotation;
        if (obj.u) existing.add(obj.u);
      } catch { /* ignore */ }
    }
  }
  if (scope === 'full' && fs.existsSync(annFile)) {
    fs.unlinkSync(annFile);
  }

  const pending = turns.filter((t) => !existing.has(t.uuid));
  const chunks = chunk(pending, chunkSize);

  let written = 0;
  let totalCost = 0;
  let tIn = 0;
  let tOut = 0;
  let cRead = 0;
  let cCreate = 0;
  const stratUsed = { isolated: 0, forked: 0 };

  const appendResults = (parsed: CompactAnnotation[]) => {
    if (!parsed.length) return;
    const toAppend = parsed.map((p) => JSON.stringify(p)).join('\n') + '\n';
    fs.appendFileSync(annFile, toAppend);
    written += parsed.length;
  };

  let chunksCompleted = 0;
  await pool(chunks, concurrency, async (c, i) => {
    try {
      const instr = buildInstructions(c);
      const willFork = useStrategy === 'forked' && mainSessionId && cwd && isValidModel;
      const res = willFork
        ? await callForked(instr, resolved.model!, mainSessionId!, cwd!)
        : await callIsolated(instr, effectiveModel);
      appendResults(res.parsed);
      totalCost += res.cost;
      tIn += res.input_tokens;
      tOut += res.output_tokens;
      cRead += res.cache_read_tokens;
      cCreate += res.cache_creation_tokens;
      stratUsed[res.strategy]++;
    } catch (e: any) {
      // Continue on chunk failure; partial progress is valuable
      console.error(`[annotator] chunk ${i} failed (${useStrategy}):`, e?.message || e);
    }
    chunksCompleted++;
    if (onProgress) {
      onProgress({
        chunksTotal: chunks.length,
        chunksCompleted,
        annotationsWritten: written,
      });
    }
    return i;
  });

  return {
    annotated: written,
    skipped: existing.size,
    cost_usd: totalCost,
    input_tokens: tIn,
    output_tokens: tOut,
    cache_read_tokens: cRead,
    cache_creation_tokens: cCreate,
    runtimeMs: Date.now() - started,
    chunksTotal: chunks.length,
    strategiesUsed: stratUsed,
  };
}
