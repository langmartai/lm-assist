/**
 * Shared protocol constants and the inbound-routing convention.
 *
 * Channels are subsystem-agnostic — the transport driver just gives both ends
 * a reliable ordered byte pipe. To let one integrator multiplex many
 * subsystems (file-transfer, future RPC, etc.) over the same channel-open
 * mechanism, the FIRST control frame an opener sends names the subsystem:
 *
 *     { "type": "lm-file-transfer/1" }
 *
 * The integrator, when it accepts a new inbound transport Channel, reads the
 * first frame, switches on its `type`, and for SUBSYSTEM_TAG hands the channel
 * to handleIncomingTransfer (it should re-feed that already-consumed first
 * frame OR, simpler, just call handleIncomingTransfer which tolerates the tag
 * frame appearing first). See handleIncomingTransfer for the exact contract.
 */

/** The subsystem tag the sender emits as its first control frame. */
export const SUBSYSTEM_TAG = 'lm-file-transfer/1';
