/**
 * Build a curated session JSONL from:
 *   - original session file
 *   - consolidated index
 *   - matcher output (relevant_topics + include_recent)
 *
 * Tool-pair handling driven by `BuildOptions.tool_strategy`:
 *   'per-annotation' (default) — per-turn keep_raw flag from annotation
 *   'keep-all'                 — preserve every tool_use/tool_result pair verbatim
 *   'summarize-all'            — replace every pair with a text turn from summary
 *   'drop-all'                 — drop tool turns entirely
 *
 * Rules:
 *   1. Always include sticky_high (first user turn + imperatives).
 *   2. Include recent_3 if matcher requested include_recent.
 *   3. Include all turns from each relevant topic cluster.
 *   4. Process tool turns per strategy (may keep verbatim, summarize, or drop).
 *   5. Rechain with fresh UUIDs, monotonic timestamps, new sessionId.
 *   6. Remap tool IDs so any kept pairs remain matched post-rechain.
 *   7. Optionally prepend a synthetic "prior-context" stub with imperatives.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  Annotation, BuildOptions, BuildResult, MatchResult, SessionIndex, CompactAnnotation,
} from './types';
import { readSessionLines, type SessionLine } from './jsonl-utils';
import { expand } from './expander';

function hex(): string {
  return randomUUID().replace(/-/g, '').slice(0, 24);
}

/** Find compact annotations file next to a session file. */
function loadAnnotations(sessionFile: string): Map<string, Annotation> {
  const annFile = sessionFile.replace(/\.jsonl$/, '.annotations.compact.jsonl');
  const out = new Map<string, Annotation>();
  if (!fs.existsSync(annFile)) return out;
  for (const line of fs.readFileSync(annFile, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const c = JSON.parse(t) as CompactAnnotation;
      if (c.u) out.set(c.u, expand(c));
    } catch { /* skip malformed */ }
  }
  return out;
}

/** True if a session line carries any tool_use or tool_result block. */
function isToolTurn(line: SessionLine): boolean {
  const c = line.message?.content;
  if (!Array.isArray(c)) return false;
  return c.some((b: any) => b?.type === 'tool_use' || b?.type === 'tool_result');
}

/**
 * Resolve the effective keep_raw decision for a tool turn.
 */
function shouldKeepRaw(
  line: SessionLine,
  annotation: Annotation | undefined,
  strategy: NonNullable<BuildOptions['tool_strategy']>,
): 'keep' | 'summarize' | 'drop' {
  if (!isToolTurn(line)) return 'keep'; // text turns always pass through
  switch (strategy) {
    case 'keep-all':       return 'keep';
    case 'drop-all':       return 'drop';
    case 'summarize-all':  return 'summarize';
    case 'per-annotation':
    default:
      return annotation?.keep_raw ? 'keep' : 'summarize';
  }
}

/** Pre-build maps so tool-pair lookup is O(n) instead of O(n²). */
function buildToolIndex(lines: SessionLine[]): {
  toolUseLineByToolId: Map<string, SessionLine>;
  toolResultLineByToolId: Map<string, SessionLine>;
} {
  const toolUseLineByToolId = new Map<string, SessionLine>();
  const toolResultLineByToolId = new Map<string, SessionLine>();
  for (const l of lines) {
    const c = l.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === 'tool_use' && b.id) toolUseLineByToolId.set(b.id, l);
      if (b?.type === 'tool_result' && b.tool_use_id) toolResultLineByToolId.set(b.tool_use_id, l);
    }
  }
  return { toolUseLineByToolId, toolResultLineByToolId };
}

export function build(
  sessionFile: string,
  indexFile: string,
  match: MatchResult,
  options: BuildOptions = {},
): BuildResult {
  const sessionLines = readSessionLines(sessionFile);
  if (!sessionLines.length) throw new Error(`session file empty: ${sessionFile}`);
  if (!fs.existsSync(indexFile)) throw new Error(`index file missing: ${indexFile}`);
  const index: SessionIndex = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
  const annotations = loadAnnotations(sessionFile);
  const strategy = options.tool_strategy || 'per-annotation';

  const byUuid = new Map<string, SessionLine>();
  for (const l of sessionLines) if (l.uuid) byUuid.set(l.uuid, l);

  // 1. Collect initial kept uuids (sticky + recent + topic clusters)
  const kept = new Set<string>();
  for (const u of index.sticky_high) kept.add(u);
  if (match.include_recent) for (const u of index.recent_3) kept.add(u);
  for (const topic of match.relevant_topics) {
    const cluster = index.topic_clusters[topic];
    if (cluster) for (const u of cluster.uuids) kept.add(u);
  }

  // 2. Tool-pair expansion is now CONDITIONAL on strategy.
  //    Only pair-expand if a kept tool turn will end up KEPT verbatim.
  //    For 'summarize' / 'drop', we don't need the partner since we'll
  //    transform / discard the turn anyway.
  const { toolUseLineByToolId, toolResultLineByToolId } = buildToolIndex(sessionLines);
  if (strategy === 'keep-all' || strategy === 'per-annotation') {
    // Walk a snapshot of currently-kept lines; pull in partners for those that
    // will be kept verbatim.
    for (const uuid of Array.from(kept)) {
      const line = byUuid.get(uuid);
      if (!line || !isToolTurn(line)) continue;
      const ann = annotations.get(uuid);
      const decision = shouldKeepRaw(line, ann, strategy);
      if (decision !== 'keep') continue;
      const c = line.message?.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b?.type === 'tool_use' && b.id) {
          const partner = toolResultLineByToolId.get(b.id);
          if (partner?.uuid) kept.add(partner.uuid);
        }
        if (b?.type === 'tool_result' && b.tool_use_id) {
          const partner = toolUseLineByToolId.get(b.tool_use_id);
          if (partner?.uuid) kept.add(partner.uuid);
        }
      }
    }
  }

  // 3. Gather kept lines in original timestamp order
  const originals = Array.from(kept)
    .map((u) => byUuid.get(u))
    .filter((l): l is SessionLine => !!l)
    .sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());

  // 3a. Compute "force-keep" set: when we plan to keep a tool_use verbatim,
  //     its tool_result partner MUST also be kept verbatim (and vice versa),
  //     even if that partner's own annotation says keep_raw=false. The API
  //     rejects orphan tool_use blocks.
  const forceKeep = new Set<string>();
  for (const line of originals) {
    if (!isToolTurn(line)) continue;
    const ann = annotations.get(line.uuid!);
    if (shouldKeepRaw(line, ann, strategy) !== 'keep') continue;
    const c = line.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === 'tool_use' && b.id) {
        const partner = toolResultLineByToolId.get(b.id);
        if (partner?.uuid) forceKeep.add(partner.uuid);
      }
      if (b?.type === 'tool_result' && b.tool_use_id) {
        const partner = toolUseLineByToolId.get(b.tool_use_id);
        if (partner?.uuid) forceKeep.add(partner.uuid);
      }
    }
  }

  // 4. Apply tool strategy: drop / summarize / keep per turn.
  //    Track which uuids end up dropped so we can drop unmatched partners.
  const stats = { kept_raw: 0, summarized: 0, dropped: 0 };
  const transformed: any[] = [];
  for (const line of originals) {
    if (!isToolTurn(line)) { transformed.push(line); continue; }
    const ann = annotations.get(line.uuid!);
    let decision = shouldKeepRaw(line, ann, strategy);
    if (forceKeep.has(line.uuid!)) decision = 'keep';  // Pair partner forces keep

    if (decision === 'keep') {
      transformed.push(line);
      stats.kept_raw++;
    } else if (decision === 'drop') {
      stats.dropped++;
      // skip — also skips partner if partner happened to be in `originals`
    } else {
      // summarize → emit a text-only assistant message with the annotation summary
      const summary = ann?.summary || '[Tool turn summary unavailable]';
      const newAssistant: any = {
        ...line,
        type: 'assistant',
        message: {
          ...(line.type === 'assistant' ? line.message : {}),
          role: 'assistant',
          model: line.message?.model || 'claude-haiku-4-5-20251001',
          type: 'message',
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [{ type: 'text', text: `[Prior tool] ${summary}` }],
          // synthetic: usage zero
          usage: {
            input_tokens: 0, output_tokens: 0,
            cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
          },
        },
      };
      // requestId/message.id will be regenerated in the rechain step below
      delete newAssistant.toolUseResult;
      transformed.push(newAssistant);
      stats.summarized++;
    }
  }

  // 4a. After transform, drop any orphaned tool_result/tool_use lines that
  //     lost their partner via summarize/drop. (E.g. summarize converted a
  //     tool_use turn into text; the matching tool_result turn now has no
  //     partner and would crash the API.)
  const transformedKeptIds = new Set<string>();
  for (const t of transformed) {
    if (!Array.isArray(t.message?.content)) continue;
    for (const b of t.message.content) {
      if (b?.type === 'tool_use' && b.id) transformedKeptIds.add(b.id);
      // Also collect tool_use_ids that have a partner kept
    }
  }
  // Keep only tool_result turns whose tool_use partner survived in `transformed`
  const finalLines: any[] = [];
  for (const t of transformed) {
    const c = t.message?.content;
    if (!Array.isArray(c)) { finalLines.push(t); continue; }
    const orphan = c.some((b: any) =>
      b?.type === 'tool_result' && !transformedKeptIds.has(b.tool_use_id),
    );
    if (orphan) {
      stats.dropped++;
      continue;
    }
    finalLines.push(t);
  }

  // 5. Rechain: fresh UUIDs, monotonic timestamps, new sessionId
  const newSessionId = randomUUID();
  const cwd = finalLines[0]?.cwd || sessionLines[0]?.cwd || process.cwd();
  const base = Date.now() - finalLines.length * 60_000;
  const tsAt = (i: number) => new Date(base + i * 60_000).toISOString();

  // Map old tool ids → new tool ids so kept pairs stay matched
  const toolIdMap = new Map<string, string>();
  for (const o of finalLines) {
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      const oldId = b?.id ?? b?.tool_use_id;
      if (oldId && !toolIdMap.has(oldId)) toolIdMap.set(oldId, 'toolu_' + hex());
    }
  }

  let prev: string | null = null;
  const out: any[] = [];
  for (let i = 0; i < finalLines.length; i++) {
    const o = finalLines[i];
    const newUuid = randomUUID();
    const newLine: any = {
      ...o,
      uuid: newUuid,
      parentUuid: prev,
      sessionId: newSessionId,
      timestamp: tsAt(i),
    };
    if (o.type === 'assistant') {
      newLine.requestId = 'req_' + hex();
      newLine.message = { ...o.message, id: 'msg_' + hex() };
    }
    if (Array.isArray(newLine.message?.content)) {
      newLine.message = {
        ...newLine.message,
        content: newLine.message.content.map((b: any) => {
          if (b?.type === 'tool_use' && b.id && toolIdMap.has(b.id)) {
            return { ...b, id: toolIdMap.get(b.id) };
          }
          if (b?.type === 'tool_result' && b.tool_use_id && toolIdMap.has(b.tool_use_id)) {
            return { ...b, tool_use_id: toolIdMap.get(b.tool_use_id) };
          }
          return b;
        }),
      };
    }
    out.push(newLine);
    prev = newUuid;
  }

  // 6. Prepend synthetic context stub
  let stubUuid: string | null = null;
  if (!options.skipContextStub) {
    const impSummary = (index.imperatives || [])
      .slice(0, 10)
      .map((i) => `- ${i.summary}`)
      .join('\n');
    if (impSummary) {
      stubUuid = randomUUID();
      const stub: any = {
        sessionId: newSessionId,
        cwd,
        version: '2.1.104',
        gitBranch: 'main',
        userType: 'external',
        isSidechain: false,
        isMeta: false,
        parentUuid: null,
        type: 'user',
        uuid: stubUuid,
        promptId: randomUUID(),
        timestamp: new Date(base - 60_000).toISOString(),
        message: {
          role: 'user',
          content: `[Prior session context — key briefs and rules]\n${impSummary}`,
        },
      };
      if (out.length) out[0].parentUuid = stubUuid;
      out.unshift(stub);
    }
  }

  // 7. Optional max-lines cap that PROTECTS sticky head.
  //    Algorithm: keep stub (if present) + first user turn + last (cap-2) entries.
  if (options.maxLines && out.length > options.maxLines) {
    const cap = options.maxLines;
    const head: any[] = [];
    if (stubUuid && out[0]?.uuid === stubUuid) head.push(out[0]);
    // first user turn after head
    const headLen = head.length;
    const firstUser = out.slice(headLen).find((l) => l.type === 'user');
    if (firstUser) head.push(firstUser);
    const headIds = new Set(head.map((l) => l.uuid));
    const remainingSlots = Math.max(cap - head.length, 0);
    const tail = out
      .slice(headLen)
      .filter((l) => !headIds.has(l.uuid))
      .slice(-remainingSlots);
    const capped = [...head, ...tail];
    // Re-chain
    capped[0].parentUuid = null;
    for (let i = 1; i < capped.length; i++) capped[i].parentUuid = capped[i - 1].uuid;
    out.length = 0;
    out.push(...capped);
  }

  const newFile = path.join(path.dirname(sessionFile), `${newSessionId}.jsonl`);
  fs.writeFileSync(newFile, out.map((l) => JSON.stringify(l)).join('\n') + '\n');

  return {
    newSessionId,
    file: newFile,
    lineCount: out.length,
    originalLines: sessionLines.length,
    reduction: `${Math.round((1 - out.length / sessionLines.length) * 100)}%`,
    matchTopics: match.relevant_topics,
    keptUuidsCount: kept.size,
    // Tool stats live on the result so callers can audit per-call
    ...(strategy !== 'keep-all' ? { tool_stats: stats } : {}),
  } as BuildResult;
}
