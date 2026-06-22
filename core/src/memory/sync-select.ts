import type { MemoryRecord } from './record-extract';

/** The records eligible to leave this node: persistent + shareable, optionally newer than sinceMs.
 *  Host-local and `temporary` records never sync; sinceMs is a watermark on recordedAtMs. */
export function selectSyncable(records: MemoryRecord[], sinceMs = 0): MemoryRecord[] {
  return records.filter(r =>
    r.persistence === 'persistent' &&
    r.shareability !== 'host-local' &&
    r.recordedAtMs > sinceMs
  );
}
