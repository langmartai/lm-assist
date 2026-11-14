/**
 * Process-level backstop for the long-running Core server.
 *
 * Node ≥ 15 turns an unhandled promise rejection into a process exit. Core runs under
 * `nohup` (core.sh) or `lm-assist start` with nothing that restarts it, so one stray
 * rejection anywhere — a request path, a timer, a fire-and-forget sync — took down the
 * MCP, the hub relay, terminals and mission control until someone noticed. Request
 * paths are now caught where they start (rest-server dispatchRequest); this is the
 * last line for everything else: log, keep serving.
 *
 * Only unhandledRejection. An uncaughtException leaves the process in an unknown
 * state and still exits, as Node intends.
 */

let installed = false;

/** Min gap between two logged rejections — a hot loop must not flood the log. */
const LOG_INTERVAL_MS = 1000;

export function installUnhandledRejectionLogger(log: (msg: string) => void = (m) => console.error(m)): void {
  if (installed) return;
  installed = true;
  let lastLogAt = 0;
  let suppressed = 0;
  process.on('unhandledRejection', (reason) => {
    const now = Date.now();
    if (now - lastLogAt < LOG_INTERVAL_MS) {
      suppressed++;
      return;
    }
    lastLogAt = now;
    const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    const more = suppressed ? ` (+${suppressed} suppressed since the last one)` : '';
    suppressed = 0;
    try {
      log(`[Core] unhandled promise rejection — kept running${more}: ${detail}`);
    } catch {
      /* logging must never throw from here */
    }
  });
}
