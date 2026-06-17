// core/src/data/backend-registry.ts
import type { StorageBackend, BackendKind } from './types';

export class BackendRegistry {
  private map = new Map<BackendKind, StorageBackend>();
  register(b: StorageBackend): void { this.map.set(b.kind, b); }
  get(kind: BackendKind): StorageBackend | undefined { return this.map.get(kind); }
}
