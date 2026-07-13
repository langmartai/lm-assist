export interface HomeRow { id: string; kind: 'chat' | 'cowork'; title: string; updatedAt: string; subtitle?: string }

/** Merge claude.ai chat conversations and cowork tasks into one recency-sorted list. */
export function normalizeRows(chats: any[], tasks: any[]): HomeRow[] {
  const rows: HomeRow[] = [];
  for (const c of Array.isArray(chats) ? chats : []) {
    if (!c?.uuid) continue;
    rows.push({ id: String(c.uuid), kind: 'chat', title: String(c.name || 'New chat'), updatedAt: String(c.updated_at || c.created_at || '') });
  }
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const id = t?.sid || t?.sessionId;
    if (!id) continue;
    rows.push({ id: String(id), kind: 'cowork', title: String(t.title || 'Untitled task'), updatedAt: String(t.lastEventAt || t.updatedAt || ''), subtitle: t.statusCategory || undefined });
  }
  return rows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
