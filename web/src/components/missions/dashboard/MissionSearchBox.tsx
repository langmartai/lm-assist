'use client';
export function MissionSearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="border-b border-neutral-800 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Search</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="title, id, status, tags… (space = AND)"
        className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 placeholder:text-neutral-600"
      />
    </div>
  );
}
