'use client';
import type { CallFn, EditTarget } from './types';
export function SyncTab({ call, onEdit, refreshTick }: { call: CallFn; onEdit?: (t: EditTarget) => void; refreshTick?: number }) {
  void call; void onEdit; void refreshTick;
  return <div className="text-sm text-gray-400">Sync status coming in Task 8.</div>;
}
