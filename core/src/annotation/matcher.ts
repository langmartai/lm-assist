/**
 * Matcher — Haiku-powered router from a user prompt to relevant topic clusters.
 */
import * as fs from 'fs';
import type { MatchResult, SessionIndex } from './types';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const TOP_TOPICS = 40;
const TOP_ENTITIES = 50;

export async function match(
  indexFile: string,
  prompt: string,
  model: string = DEFAULT_MODEL,
): Promise<MatchResult> {
  if (!fs.existsSync(indexFile)) throw new Error(`index file missing: ${indexFile}`);
  const idx: SessionIndex = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));

  const topTopics = Object.entries(idx.topic_clusters)
    .sort((a, b) => b[1].turn_count - a[1].turn_count)
    .slice(0, TOP_TOPICS);
  const clusterDesc = topTopics
    .map(([t, i]) => `- ${t} (${i.turn_count}t): ${(i.turns_summary[0] || '').slice(0, 100)}`)
    .join('\n');

  const topEntities = Object.entries(idx.entity_map)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, TOP_ENTITIES)
    .map(([e, uuids]) => `${e}(${uuids.length})`)
    .join(', ');

  const matcherPrompt = `Route the user's new prompt to relevant conversation clusters.

Top ${topTopics.length} topic clusters (topic-tag (turn-count): summary):
${clusterDesc}

Known entities (name(count)): ${topEntities}

Imperatives/briefs (always-included sticky):
${idx.imperatives.slice(0, 10).map((i) => `  - ${i.summary}`).join('\n')}

Respond with ONLY a JSON object on a single line:
{"relevant_topics": ["topic1","topic2"], "include_recent": true|false, "rationale": "<=200 chars"}

Rules:
- relevant_topics: most relevant (up to 5). Empty if truly unrelated.
- include_recent=true if prompt implicitly references recent turns.

New prompt: """${prompt}"""`;

  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const pending: any[] = [{
    type: 'user',
    message: { role: 'user', content: matcherPrompt },
    session_id: 'matcher',
    parent_tool_use_id: null,
  }];
  async function* input() {
    if (pending.length) yield pending.shift();
    await new Promise<void>(() => { /* idle */ });
  }

  const start = Date.now();
  const q = query({
    prompt: input(),
    options: {
      model,
      tools: [],
      settingSources: [],
      permissionMode: 'bypassPermissions',
      systemPrompt: 'Return ONLY a JSON object on one line.',
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
  const elapsed = Date.now() - start;

  const cleaned = text.replace(/^```(?:json)?\n?/gm, '').replace(/\n?```$/gm, '').trim();
  let parsed: any;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    throw new Error(`matcher returned unparseable response: ${cleaned.slice(0, 200)}`);
  }

  return {
    relevant_topics: Array.isArray(parsed.relevant_topics) ? parsed.relevant_topics : [],
    include_recent: !!parsed.include_recent,
    rationale: String(parsed.rationale || ''),
    timing_ms: elapsed,
    cost_usd: cost,
    usage: usage ? {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    } : undefined,
  };
}
