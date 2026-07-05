'use client';
import type { CallFn, EditTarget } from './types';
export function MemoryBrowser({ call, onEdit }: { call: CallFn; onEdit?: (t: EditTarget) => void }) {
  void call; void onEdit;
  return <div className="text-sm text-gray-400">Memory browser coming in Task 5.</div>;
}
