/**
 * Startup Profiler — lightweight timing instrumentation for server boot.
 *
 * Usage:
 *   profiler.start('controlApi');
 *   // ... init work ...
 *   profiler.end('controlApi');
 *
 *   profiler.summary();  // prints timing table
 *
 * Each entry stores start/end hrtime for sub-ms precision.
 */

const NS_PER_MS = 1_000_000;

interface ProfileEntry {
  label: string;
  parent?: string;
  startHr: [number, number];
  endHr?: [number, number];
  durationMs?: number;
}

class StartupProfiler {
  private entries = new Map<string, ProfileEntry>();
  private bootHr: [number, number] = process.hrtime();

  /**
   * Mark the start of a profiled section.
   */
  start(key: string, label?: string, parent?: string): void {
    this.entries.set(key, {
      label: label || key,
      parent,
      startHr: process.hrtime(),
    });
  }

  /**
   * Mark the end of a profiled section.
   */
  end(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    entry.endHr = process.hrtime();
    const diff = process.hrtime(entry.startHr);
    entry.durationMs = (diff[0] * 1e9 + diff[1]) / NS_PER_MS;
    return entry.durationMs;
  }

  /**
   * Get elapsed ms for a completed entry.
   */
  get(key: string): number | undefined {
    return this.entries.get(key)?.durationMs;
  }

  /**
   * Get ms elapsed since boot (profiler creation).
   */
  sinceBootMs(): number {
    const diff = process.hrtime(this.bootHr);
    return (diff[0] * 1e9 + diff[1]) / NS_PER_MS;
  }

  /**
   * Print a formatted summary table to stdout.
   */
  summary(): void {
    const totalMs = this.sinceBootMs();

    // Build parent→children map keyed by label
    const children = new Map<string, ProfileEntry[]>();
    const topLevel: ProfileEntry[] = [];

    for (const [, entry] of this.entries) {
      if (entry.parent) {
        const list = children.get(entry.parent) || [];
        list.push(entry);
        children.set(entry.parent, list);
      } else {
        topLevel.push(entry);
      }
    }

    const sortByStart = (a: ProfileEntry, b: ProfileEntry) => {
      const aDiff = (a.startHr[0] - this.bootHr[0]) * 1e9 + (a.startHr[1] - this.bootHr[1]);
      const bDiff = (b.startHr[0] - this.bootHr[0]) * 1e9 + (b.startHr[1] - this.bootHr[1]);
      return aDiff - bDiff;
    };

    topLevel.sort(sortByStart);

    const printEntry = (entry: ProfileEntry, depth: number) => {
      const ms = entry.durationMs ?? 0;
      const pct = totalMs > 0 ? (ms / totalMs) * 100 : 0;
      const bar = '█'.repeat(Math.min(Math.round(pct / 5), 10));
      const indent = depth === 0 ? '' : '  '.repeat(depth - 1) + '└ ';
      const label = (`${indent}${entry.label}`).substring(0, 30).padEnd(30);
      const msStr = ms.toFixed(1).padStart(8);
      const pctStr = `${pct.toFixed(1)}% ${bar}`.padEnd(15);
      console.log(`│ ${label} │ ${msStr} │ ${pctStr} │`);

      // Recurse into children
      const kids = children.get(entry.label) || [];
      kids.sort(sortByStart);
      for (const child of kids) {
        printEntry(child, depth + 1);
      }
    };

    console.log('');
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log('│                   STARTUP PROFILE                           │');
    console.log('├────────────────────────────────┬──────────┬─────────────────┤');
    console.log('│ Component                      │ Time(ms) │ % of Total      │');
    console.log('├────────────────────────────────┼──────────┼─────────────────┤');

    for (const entry of topLevel) {
      printEntry(entry, 0);
    }

    console.log('├────────────────────────────────┼──────────┼─────────────────┤');
    const totalStr = totalMs.toFixed(1).padStart(8);
    console.log(`│ ${'TOTAL'.padEnd(30)} │ ${totalStr} │ ${'100%'.padEnd(15)} │`);
    console.log('└────────────────────────────────┴──────────┴─────────────────┘');
    console.log('');
  }
}

// Singleton — shared across all modules during startup
let instance: StartupProfiler | null = null;

export function getStartupProfiler(): StartupProfiler {
  if (!instance) {
    instance = new StartupProfiler();
  }
  return instance;
}

export function resetStartupProfiler(): void {
  instance = null;
}

export { StartupProfiler };
