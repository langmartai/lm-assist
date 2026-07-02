# Transport performance baseline — 2026-07-02 (pre-A0, fleet 0.1.134)

Live 123 (Linux) → 107 (Windows), same LAN 10.0.1.x, measured via `transfer_stats`.

| Transfer | Path | Throughput | Note |
|---|---|---|---|
| 10 MB (auto) | **oneway / host** (data direct) | **2.30 MB/s** | direct data leg confirmed |
| 50 MB (forceMode:relay) | relay / — | **2.46 MB/s** | via Singapore hub |
| 2 MB (auto, earlier) | relay / — | (fast, ~instant) | too short — direct never confirmed |

## Finding (root cause, confirmed empirically)
The `via:host` direct-data transfer is **NOT faster than relay** (2.30 vs 2.46 MB/s). Even with data flowing direct over the ~1ms LAN, throughput is capped at relay speed because **ACKs always ride the relay** (hybrid.ts routed all control datagrams to the relay unconditionally), so the 64×1200B send window can only advance at relay-RTT (~40–200ms). The direct data leg is wasted.

Also: `rtt=-ms` — per-transfer RTT is not surfaced (Phase C / C4 reporting gap).

## Predictions after fixes
- **A0 (ACKs over direct when confirmed):** the `oneway/host` case should rise sharply — window advances at LAN-RTT (~1ms) instead of relay-RTT. Expected multiple× improvement for confirmed-direct transfers.
- **Phase B (channel reuse / warm fabric link):** SHORT transfers (like the 2MB) start `via:host` immediately instead of racing a cold ladder and losing to relay.
- **A2–A4 (adaptive RTO, fast-retransmit, coalesced ACK):** improve the relay/lossy worst-case (fewer spurious retransmits, faster loss recovery).

This file is the "before"; re-run C3 after each deploy for the "after".

## Firehose (bulk direct) measured — the current design's ceiling
| Transfer | Path | Throughput | RTT |
|---|---|---|---|
| 30 MB (auto) | firehose, **bidi/host** | 5.24 MB/s | 1ms |
| 100 MB (auto) | firehose, **bidi/host** | **9.28 MB/s** | 1ms |

Firehose (raw UDP blast + FASP/LEDBAT paced) ramps with file size but tops out **~9 MB/s = ~8% of gigabit line rate**. RTT is genuinely 1ms — the LAN is fast; the software is the bottleneck. Root cause: userspace UDP in Node's single-threaded event loop — every 1100B chunk is a JS call + sendto syscall on both ends (~9k datagrams/s). A kernel TCP socket between the two host IPs would hit ~100 MB/s (GSO/GRO/sendfile offloads, C-speed ARQ). CONCLUSION: the UDP ARQ/firehose is structurally an order of magnitude short of native LAN speed → direct-TCP-for-LAN is the real fix.
