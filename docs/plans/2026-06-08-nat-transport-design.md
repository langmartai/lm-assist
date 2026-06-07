# lm-assist NAT-traversal transport + file/dir transfer — design & contract

Status: design (2026-06-08). Two features:
1. **Data-transfer driver** (`transport`) — a node↔node channel with UDP hole-punch (direct) and hub-relay (fallback) modes, coordinated by the hub (langmart.ai prod / xeenhub dev).
2. **File/dir transfer API** built on (1).

Both nodes belong to the SAME user (the hub enforces user-scoping via `resolveNodeForUser`).

## Substrate (from code recon — verify file:line before editing)

Worker `core/src/hub-client/`:
- `websocket-client.ts`: single outbound WS. `send(obj)` → `ws.send(JSON.stringify)`. `sendBinary(hash8, payload, marker)` → `ws.send([marker][hash8][payload])`. `bufferedAmount()`. Inbound demux on `buf[0]`: `0xFF` console, `0xFE` port-forward, else JSON → emits typed events.
- `port-forward-handler.ts`: full relay channel to mirror. Marker `0xFE`, `streamHash = md5(streamId)[0:8]`. Control msgs `forward_open/ready/error/eof/close`. Backpressure via `bufferedAmount()`.
- `index.ts`: wiring, `getNodeInfo()` → `{gatewayId, hostname, os, ip}`.

Hub `LangMartDesign/assist-api/src/services/tier-agent-gateway-manager.ts`:
- `sendToGateway(gatewayId, msg)` relays JSON to a peer worker. **Reuse for endpoint exchange.**
- `resolveNodeForUser(userId, selector)` — user-scoped peer resolution (returns null if not the user's online node).
- Worker public IP from `ws._socket.remoteAddress`. `PF_PEER_BUFFER_CAP = 16MB`. Binary relay routed by `portForwardByHash`.
- assist-api: TCP `:8086`. Deploy: `./core.sh restart assist-api [--prod]`.

## Wire protocol additions

New binary marker **`0xFD`** = transport relay-data frame: `[0xFD][8-byte md5(channelId)][payload]` — hub routes peer↔peer exactly like `0xFE`.

New JSON control messages (worker→hub→peer via `sendToGateway`):
- `transport_open  {channelId, peerGatewayId}` — initiator asks hub to coordinate a channel to peer.
- `transport_offer {channelId, fromGatewayId, udp:{ip,port}}` — relayed to peer (initiator's punched public endpoint).
- `transport_answer{channelId, udp:{ip,port}}` — peer's public endpoint back to initiator.
- `transport_relay_ready {channelId}` / `transport_relay_open {channelId, peerGatewayId}` — establish the 0xFD relay stream hub-side (mirror forward_open/ready).
- `transport_close {channelId, reason?}`.

STUN (UDP): hub runs `dgram` responder on **UDP :8087**. A worker sends any small UDP packet from its transport socket → hub echoes `{type:'stun', ip, port}` = the worker's PUBLIC ip:port (its NAT mapping). Worker uses the SAME UDP socket for STUN and for the punched data so the mapping matches.

## Worker transport driver — public API (`core/src/transport/`)

```ts
export interface Channel {
  id: string;
  peerGatewayId: string;
  mode: 'direct' | 'relay';
  send(data: Buffer): void;          // RELIABLE, ORDERED in both modes
  onData(cb: (data: Buffer) => void): void;
  onClose(cb: (reason?: string) => void): void;
  close(): void;
}
// Try direct (UDP hole punch) within `directTimeoutMs`, else fall back to relay.
export function openChannel(peerGatewayId: string, opts?: {
  directTimeoutMs?: number;        // default 4000
  forceMode?: 'direct' | 'relay';  // testing
}): Promise<Channel>;
```

Reliability: relay mode is already reliable (WS/TCP). **Direct mode needs a small reliable-ordered layer**: 32-bit seq, cumulative ACK, retransmit on RTO (~300ms, backoff), in-order delivery, a modest window (e.g. 64 unacked), and keepalive pings so the NAT hole stays open. Datagram header (direct): `[1B type][4B seq][4B ack][2B len][payload]`, types = DATA / ACK / PING / FIN. Keep MTU-safe (<=1200B payload per datagram; the driver fragments `send()` across datagrams).

Hole punch: open one `dgram` udp4 socket; STUN to hub:8087 to learn own public ip:port; send `transport_open`; on `transport_answer`, both sides blast a few packets at the peer's public ip:port (~every 50ms for ~2s) until a PING/ACK round-trips; then the reliable layer runs over it. If no round-trip by `directTimeoutMs` → close the socket, open a relay channel (0xFD) and resolve as `mode:'relay'`.

`openChannel` resolves only once a channel is usable (direct confirmed, or relay ready).

## File/dir transfer API (`core/src/file-transfer/`) — built on Channel

Framed messages over a Channel (length-prefixed JSON control + binary data):
- `FT_META {transferId, root, entries:[{relPath, size, mode, isDir}], totalBytes}`
- `FT_DATA {transferId, entryIndex, offset}` + raw bytes
- `FT_END  {transferId, sha256}` ; receiver replies `FT_OK {transferId}` / `FT_ERR`.

```ts
export function sendPath(peerGatewayId: string, localPath: string, remotePath: string,
  opts?: { onProgress?: (sent: number, total: number) => void }): Promise<{ bytes: number; entries: number }>;
export function listRemote(peerGatewayId: string, remotePath: string): Promise<DirEntry[]>;
```

Receiver writes under a configured safe root; reject `..` traversal and absolute escapes. Preserve dir structure + file mode. Verify sha256 per file.

## Hub coordinator (LangMartDesign/assist-api) — additions

- `stun-responder.ts`: `dgram` udp4 on `:8087`, echoes sender `{type:'stun', ip:rinfo.address, port:rinfo.port}`.
- gateway manager: handle `transport_open/offer/answer/relay_open/relay_ready/close` → relay to the user-scoped peer via `sendToGateway` (mirror the forward_* relay + ownership gate). 0xFD binary relay: mirror `portForwardByHash` routing + `PF_PEER_BUFFER_CAP`.
- Open UDP :8087 in the SG firewall (and locally for xeenhub dev). assist-api `:8086` stays TCP.

## Test plan
- Unit: reliable-UDP layer over a lossy in-process socket pair (drop/reorder injection).
- e2e dev (xeenhub, 117 dev workers): `forceMode:'relay'` first (no NAT needed), then direct.
- e2e prod (langmart.ai): 117↔123 — EXPECT direct may fail (same home router, no hairpin) → must fall back to relay cleanly. Then Ashburn (157.151.156.122, public IP) ↔ 117/123 → direct hole punch should succeed.
- Ashburn: core only, no web, memory cap + swap; measure RSS first.
