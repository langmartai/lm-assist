/** Milestone type → color map (matches MilestonesTab) */
export const typeColors: Record<string, string> = {
  discovery: '#60a5fa',
  implementation: '#4ade80',
  bugfix: '#f87171',
  refactor: '#c084fc',
  decision: '#fbbf24',
  configuration: '#22d3ee',
};

/** Returns the type with the highest count */
export function getDominantType(types: Record<string, number>): string {
  let best = '';
  let bestCount = 0;
  for (const [type, count] of Object.entries(types)) {
    if (count > bestCount) { best = type; bestCount = count; }
  }
  return best;
}
