/**
 * bus_publish / bus_read / bus_topics (spec §5 S1). Thin wrappers over the /bus
 * routes on loopback. bus_read is a stateless long-poll: pass the `from` cursor
 * you last received; it returns events + the next cursor. Connector args arrive
 * as STRINGS (data-service lesson) — coerce wait/from. Each MUST have a
 * TOOL_SCOPES entry (bus_publish=write, bus_read/bus_topics=read).
 */
import { ok, err, workerGet, workerGetLong, workerPost, type McpToolResult } from './_passthrough';

export const busPublishToolDef = {
  name: 'bus_publish',
  description:
    'Publish an event to a bus topic (durable, fanned out to same-cluster peers). ' +
    'topic (e.g. "mission:<id>", "data:<dataset>", "app:<name>"), type (event type), payload (JSON ≤64KB). ' +
    'Optional scope="fleet" for fleet-wide topics. Returns the event id (origin:seq).',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      topic: { type: 'string', description: 'Topic name (required).' },
      type: { type: 'string', description: 'Application event type (required).' },
      payload: { type: 'object', description: 'JSON payload (≤64KB). Omit for a pure signal.' },
      scope: { type: 'string', enum: ['cluster', 'fleet'], description: 'Fan-out scope (default cluster).' },
    },
    required: ['topic', 'type'],
  },
};

export const busReadToolDef = {
  name: 'bus_read',
  description:
    'Read events from a bus topic since a cursor (stateless long-poll). Pass topic and the `from` cursor ' +
    'you last received (omit for the start of retained history). `wait` (ms, ≤25000) long-polls for new events. ' +
    'Returns { events, nextCursor } — pass nextCursor as `from` next time.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: {
      topic: { type: 'string', description: 'Topic name (required).' },
      from: { type: 'string', description: 'Opaque cursor from a previous read (optional).' },
      wait: { type: 'number', description: 'Long-poll up to this many ms (≤25000, default 0).' },
    },
    required: ['topic'],
  },
};

export const busTopicsToolDef = {
  name: 'bus_topics',
  description: 'List bus topics with event counts, origins, subscribers, and cursor lag. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object' as const, properties: {} },
};

export const BUS_TOOL_DEFS = [busPublishToolDef, busReadToolDef, busTopicsToolDef];

interface TopicRow { topic: string; events: number; origins: number; subscribers: number; lag: number; oldestAt: number | null; newestAt: number | null; head: Record<string, number>; }

export function formatTopics(rows: TopicRow[]): string {
  if (rows.length === 0) return 'bus: no topics yet.';
  return rows.map((t) => `• ${t.topic} — ${t.events} events · ${t.origins} origins · ${t.subscribers} subs · lag ${t.lag}`).join('\n');
}

export const BUS_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  bus_publish: async (args) => {
    const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
    const type = typeof args.type === 'string' ? args.type.trim() : '';
    if (!topic || !type) return err('bus_publish: topic and type are required');
    const scope = args.scope === 'fleet' ? 'fleet' : 'cluster';
    try {
      const r = await workerPost<{ id: string; seq: number }>('/bus/publish', { topic, type, payload: args.payload ?? null, scope });
      return ok(`published ${r.id} to ${topic}`);
    } catch (e) { return err(`bus_publish failed: ${(e as Error).message}`); }
  },
  bus_read: async (args) => {
    const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
    if (!topic) return err('bus_read: topic is required');
    const from = typeof args.from === 'string' ? args.from : '';
    const wait = Math.max(0, Math.min(25_000, Number(args.wait) || 0)); // connector sends numbers as strings → coerce
    const qs = `topic=${encodeURIComponent(topic)}${from ? `&from=${encodeURIComponent(from)}` : ''}${wait ? `&wait=${wait}` : ''}`;
    try {
      const r = await workerGetLong<{ events: unknown[]; nextCursor: string }>(`/bus/read?${qs}`, wait + 5_000);
      return ok(JSON.stringify(r, null, 2));
    } catch (e) { return err(`bus_read failed: ${(e as Error).message}`); }
  },
  bus_topics: async () => {
    try {
      const r = await workerGet<{ topics: TopicRow[] }>('/bus/topics');
      return ok(formatTopics(r.topics ?? []));
    } catch (e) { return err(`bus_topics failed: ${(e as Error).message}`); }
  },
};
