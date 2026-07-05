'use client';
import type { CallFn, EditTarget } from './types';
export function RulesBrowser({ call, onEdit }: { call: CallFn; onEdit?: (t: EditTarget) => void }) {
  void call; void onEdit;
  return <div className="text-sm text-gray-400">Rules browser coming in Task 7.</div>;
}
