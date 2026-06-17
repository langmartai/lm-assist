/** Batches dirty record ids per dataset; flushed periodically by the sync boot timer (Task 7). */
export class SyncQueue {
  private dirty = new Map<string, Set<string>>();
  markDirty(dataset: string, id: string): void {
    let set = this.dirty.get(dataset);
    if (!set) { set = new Set(); this.dirty.set(dataset, set); }
    set.add(id);
  }
  /** Snapshot the pending changes as batches and CLEAR the queue. */
  flush(): Array<{ dataset: string; recordIds: string[] }> {
    const out: Array<{ dataset: string; recordIds: string[] }> = [];
    for (const [dataset, ids] of this.dirty) out.push({ dataset, recordIds: [...ids] });
    this.dirty.clear();
    return out;
  }
  size(): number { let n = 0; for (const s of this.dirty.values()) n += s.size; return n; }
}
let _instance: SyncQueue | null = null;
export function getSyncQueue(): SyncQueue { if (!_instance) _instance = new SyncQueue(); return _instance; }
