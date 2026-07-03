/** Correlates fabric `req` → `res` by envelope id, with a per-call timeout. */
import type { Envelope } from './envelope';

interface Waiter { resolve: (e: Envelope) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout>; }

export class PendingCalls {
  private waiters = new Map<string, Waiter>();

  register(id: string, timeoutMs: number): Promise<Envelope> {
    return new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiters.delete(id)) reject(new Error(`fabric call timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(id, { resolve, reject, timer });
    });
  }

  resolve(id: string, env: Envelope): boolean {
    const w = this.waiters.get(id);
    if (!w) return false;
    clearTimeout(w.timer);
    this.waiters.delete(id);
    w.resolve(env);
    return true;
  }

  reject(id: string, err: Error): boolean {
    const w = this.waiters.get(id);
    if (!w) return false;
    clearTimeout(w.timer);
    this.waiters.delete(id);
    w.reject(err);
    return true;
  }

  rejectAll(err: Error): void {
    for (const [, w] of this.waiters) { clearTimeout(w.timer); w.reject(err); }
    this.waiters.clear();
  }

  size(): number { return this.waiters.size; }
}
