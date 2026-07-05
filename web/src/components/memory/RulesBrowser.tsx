'use client';
import type { CallFn, EditTarget } from './types';
export function RulesBrowser({ call, onEdit, refreshTick }: { call: CallFn; onEdit?: (t: EditTarget) => void; refreshTick?: number }) {
  void call; void onEdit; void refreshTick;
  return <div className="text-sm text-gray-400">Rules browser coming in Task 7.</div>;
}
