/* Stub for tabs/ConsoleTab (aliased in build.mjs).
 *
 * The Console tab is a LIVE terminal — ttyd/WebSocket attach to a running PID,
 * started via session-driving POSTs. Both are outside this pane's deliberately
 * read-only grant, and streaming across the pane data plane is a separate,
 * still-blocked backlog item. The stub says so instead of failing quietly.
 */
export function ConsoleTab(_props: any) {
  return (
    <div className="empty-state" style={{ padding: 32, textAlign: 'center' }}>
      <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
        Console is not available in this pane
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }}>
        The live terminal needs a session-driving connection this read-only pane
        deliberately does not hold. Open the full web UI on the node to attach.
      </div>
    </div>
  );
}
