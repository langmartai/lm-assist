'use client';
import type { CallFn, EditTarget } from './types';
export function SyncTab({ call, onEdit }: { call: CallFn; onEdit?: (t: EditTarget) => void }) {
  void call; void onEdit;
  return <div className="text-sm text-gray-400">Sync status coming in Task 8.</div>;
}
