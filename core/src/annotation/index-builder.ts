/**
 * Consolidate compact annotations JSONL → compact session index JSON that the
 * matcher ingests. Runs locally, no LLM calls.
 */
import * as fs from 'fs';
import type { CompactAnnotation, SessionIndex, Annotation } from './types';
import { expand } from './expander';
import { readSessionLines } from './jsonl-utils';

export function buildIndex(
  sessionFile: string,
  annotationsFile: string,
  indexFile: string,
): SessionIndex {
  const sessionLines = readSessionLines(sessionFile);
  if (!sessionLines.length) throw new Error(`session file empty or missing: ${sessionFile}`);
  if (!fs.existsSync(annotationsFile)) throw new Error(`annotations file missing: ${annotationsFile}`);

  const compactAnns: CompactAnnotation[] = fs
    .readFileSync(annotationsFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as CompactAnnotation; } catch { return null; } })
    .filter((a): a is CompactAnnotation => !!a && !!a.u);

  // Dedupe by uuid (keep last)
  const byUuid = new Map<string, CompactAnnotation>();
  for (const a of compactAnns) byUuid.set(a.u, a);
  const annotations: Annotation[] = Array.from(byUuid.values()).map(expand);

  const tsByUuid = new Map<string, string>();
  const sessionIdFromFile = sessionLines[0].sessionId || 'unknown';
  for (const l of sessionLines) {
    if (l.uuid && l.timestamp) tsByUuid.set(l.uuid, l.timestamp);
  }

  const topic_clusters: SessionIndex['topic_clusters'] = {};
  for (const a of annotations) {
    for (const topic of a.topics) {
      if (!topic_clusters[topic]) {
        topic_clusters[topic] = { uuids: [], turns_summary: [], turn_count: 0 };
      }
      topic_clusters[topic].uuids.push(a.uuid);
      topic_clusters[topic].turns_summary.push(a.summary);
    }
  }
  for (const t of Object.keys(topic_clusters)) {
    topic_clusters[t].turns_summary = Array.from(new Set(topic_clusters[t].turns_summary)).slice(0, 3);
    topic_clusters[t].turn_count = topic_clusters[t].uuids.length;
  }

  const ordered = annotations.slice().sort((a, b) => {
    const ta = tsByUuid.get(a.uuid) || '';
    const tb = tsByUuid.get(b.uuid) || '';
    return new Date(ta).getTime() - new Date(tb).getTime();
  });

  // Sticky policy: first user turn + imperative-role turns only
  const firstUserUuid = ordered.find((a) => {
    const line = sessionLines.find((l) => l.uuid === a.uuid);
    return !!line && line.type === 'user';
  })?.uuid;

  const sticky_high: string[] = [];
  if (firstUserUuid) sticky_high.push(firstUserUuid);
  for (const a of annotations) {
    if (a.role === 'imperative') sticky_high.push(a.uuid);
  }

  const imperatives = annotations
    .filter((a) => a.role === 'imperative' || a.role === 'user-brief')
    .map((a) => ({ uuid: a.uuid, summary: a.summary }));

  const recent_3 = ordered.slice(-3).map((a) => a.uuid);

  const entity_map: Record<string, string[]> = {};
  for (const a of annotations) {
    for (const e of a.entities) {
      if (!entity_map[e]) entity_map[e] = [];
      entity_map[e].push(a.uuid);
    }
  }

  const referenced_by: Record<string, string[]> = {};
  for (const a of annotations) {
    for (const r of a.referenced_uuids) {
      if (!referenced_by[r]) referenced_by[r] = [];
      referenced_by[r].push(a.uuid);
    }
  }

  const index: SessionIndex = {
    sessionId: sessionIdFromFile,
    lastIndexed: new Date().toISOString(),
    turn_count: annotations.length,
    topic_clusters,
    sticky_high,
    imperatives,
    recent_3,
    entity_map,
    referenced_by,
  };

  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  return index;
}
