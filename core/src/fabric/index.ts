/**
 * Fabric singleton. initFabric(selfNode) is called from the hub-client's
 * `authenticated` handler (the same place initTransport runs, so gatewayId is
 * known). Gated on projectSettings.fabricEnabled — the W1 kill-switch.
 */
import { openChannel } from '../transport';
import { PeerLink, type PeerLinkSnapshot, type LinkChannel } from './peer-link';
import { PeerManager, type PeerLinkLike } from './peer-manager';
import { initEnvelopeCodec, decodeBody } from './envelope';
import { FabricLink, type FabricChannel } from './fabric-link';
import { LinkMetrics, ClassScheduler, type LinkMetricsSnapshot } from './metrics';
import { IdempotencyCache } from './idempotency';
import { createRpcServer, loopbackDispatch, loopbackApiPort } from './rpc-server';
import { offloadResponse, fetchBulk, productionReadSink, type BulkHandle } from './bulk-offload';

export interface FabricStatus {
  enabled: boolean;
  self: { node: string; cluster: string };
  peers: Array<PeerLinkSnapshot & { metrics?: LinkMetricsSnapshot }>;
}

export interface FabricResponse { status: number; data?: unknown; code?: string; message?: string; }
export type FabricAddr = { node: string } | { resource: { kind: string; id: string } };

interface FabricTestDeps {
  selfNode: string;
  cluster: string;
  listPeers: () => Promise<string[]>;
  makeLink: (peer: string) => PeerLinkLike;
}

let mgr: PeerManager | null = null;
let self = { node: '', cluster: 'default' };

/** Per-peer W2 transmission link, attached once its W1 PeerLink connects. */
const fabricLinks = new Map<string, FabricLink>();
/** Shared across every attached link (spec T7): one receiver dedup cache for
 *  this node, keyed by reqId — a retry from ANY peer dedupes against it. */
const sharedIdempotency = new IdempotencyCache();
let codecReady: Promise<void> | null = null;

/** Idempotent: the first caller kicks the (ESM-only, async) msgpack codec
 *  load; every later caller awaits the SAME promise. Must resolve before any
 *  FabricLink does envelope I/O — see initFabric() and attachFabricLink(). */
function ensureCodec(): Promise<void> {
  if (!codecReady) codecReady = initEnvelopeCodec();
  return codecReady;
}

/**
 * Shared kill-switch read (Fix 3): used both to gate PeerManager.reconcile() on
 * every tick (mid-session flips take effect without a restart) and to report
 * getFabricStatus() honestly. Any settings-read failure defaults to enabled —
 * matches the pre-fix boot-time behavior of an unguarded getProjectSettings() call.
 */
function fabricSettingEnabled(): boolean {
  try {
    const { getProjectSettings } = require('../project-settings') as typeof import('../project-settings');
    return getProjectSettings().fabricEnabled;
  } catch {
    return true;
  }
}

/**
 * W1's LinkChannel (peer-link.ts) intentionally narrows the real transport
 * Channel down to `sendControl` only — "W1 carries no payload traffic", per
 * peer-link.ts's own header comment. The live object underneath is always
 * the full transport `Channel` (transport/index.ts's `makeChannel` is the
 * sole constructor feeding both the initiator's `openChannel()` result and
 * the answerer's inbound-routed channel) — it has `send` too; W2 needs the
 * type system to know that. Mirrors the identical narrow/widen cast already
 * used one line below for `openChannel(p) as unknown as Promise<LinkChannel>`.
 */
type FabricCapableChannel = LinkChannel & { send(b: Buffer): void };

/**
 * Wrap a channel so `onClose` supports MULTIPLE subscribers. The underlying
 * LinkChannel's `onClose` is single-slot (transport/index.ts's makeChannel:
 * `onClose: (cb) => { closeCbRef.cb = cb; }` — last registration wins, and
 * inbound-router.ts's own replay wrap forwards the same single-slot
 * semantics). PeerLink.attach() always registers first (its own
 * close→state-transition handler; W1's reconnect/backoff logic depends on it
 * firing) — without this wrap, attachFabricLink()'s `ch.onClose(...)` would
 * silently replace that handler and break W1's link-state tracking.
 * `Object.create` (NOT a spread) so the channel's live `mode`/`via`/`rtt`
 * getters stay live instead of freezing at wrap time — the identical idiom
 * inbound-router.ts's `makeReplayed()` already uses for the same reason.
 * Applied at both places a channel first reaches a PeerLink — the outbound
 * `openChannel` dep below, and `fabricAcceptInbound` — i.e. BEFORE
 * PeerLink.attach() ever calls `onClose`; wrapping any later would be too
 * late (the single slot would already be claimed).
 */
function fanoutClose<T extends LinkChannel>(ch: T): T {
  const subs: Array<(r?: string) => void> = [];
  let closed = false;
  let closeReason: string | undefined;
  ch.onClose((r) => {
    closed = true;
    closeReason = r;
    for (const cb of subs.splice(0)) { try { cb(r); } catch { /* best-effort */ } }
  });
  const wrapped = Object.create(ch as object) as T;
  wrapped.onClose = (cb: (r?: string) => void) => {
    if (closed) { try { cb(closeReason); } catch { /* best-effort */ } return; }
    subs.push(cb);
  };
  return wrapped;
}

export function initFabric(selfNode: string): void {
  // Kick the (ESM-only, async) envelope codec load as early as possible so
  // it's warm well before any handshake completes — attachFabricLink() also
  // awaits it itself, so a link that connects before this resolves still
  // can't do envelope I/O ahead of the codec being ready.
  void ensureCodec();
  // Lazy requires keep boot-order safe (settings/cluster/peer-client each read files).
  if (!fabricSettingEnabled()) { stopFabric(); return; }
  if (mgr && self.node === selfNode) { mgr.retryFailedNow(); return; } // reconnect with same id → keep links, re-kick any failed ones now
  stopFabric();
  const { getMyCluster } = require('../cluster/cluster-config') as typeof import('../cluster/cluster-config');
  const { listOnlineNodeIds } = require('../data/peer-client') as typeof import('../data/peer-client');
  self = { node: selfNode, cluster: safeCluster(getMyCluster) };
  mgr = new PeerManager({
    listPeers: async () => (await listOnlineNodeIds()).filter((id) => id !== selfNode),
    makeLink: (peer) => {
      const link = new PeerLink(peer, {
        openChannel: async (p) => fanoutClose(await openChannel(p) as unknown as LinkChannel),
        selfNode,
        now: () => Date.now(),
        selfTcp: () => selfTcpEndpoint,
      });
      link.onConnected((ch) => { void attachFabricLink(selfNode, peer, link, ch as FabricCapableChannel); });
      return link;
    },
    now: () => Date.now(),
    enabled: fabricSettingEnabled,
  });
  mgr.start();
}

function safeCluster(getMyCluster: () => string): string {
  try { return getMyCluster(); } catch { return 'default'; }
}

export function stopFabric(): void {
  mgr?.stop();
  mgr = null;
  for (const fl of fabricLinks.values()) fl.failInflight(new Error('fabric stopped'));
  fabricLinks.clear();
}

/** This node's direct-TCP endpoint, set by the TCP listener at boot; advertised
 *  to peers in the fabric HELLO so a same-LAN peer can open a kernel-TCP channel. */
let selfTcpEndpoint: import('./protocol').FabricTcpEndpoint | null = null;

export function setFabricSelfTcp(ep: import('./protocol').FabricTcpEndpoint | null): void {
  selfTcpEndpoint = ep;
  // The listener binds AFTER initFabric sent the first HELLOs, so re-advertise
  // on every live link now that our endpoint is known.
  mgr?.readvertiseAll();
}

/** The peer's advertised direct-TCP endpoint (learned via its HELLO on the warm
 *  fabric link), or null if unknown / peer runs no listener / not fabric-linked. */
export function getPeerTcpEndpoint(peer: string): import('./protocol').FabricTcpEndpoint | null {
  return mgr?.peerTcp(peer) ?? null;
}

export function getFabricStatus(): FabricStatus {
  const settingOn = fabricSettingEnabled();
  const peers = (mgr ? mgr.snapshot() : []).map((p) => {
    const fl = fabricLinks.get(p.peer);
    return fl ? { ...p, metrics: fl.metrics.snapshot() } : p;
  });
  return { enabled: !!mgr && settingOn, self: { ...self }, peers };
}

/** Inbound fabric channel (routed by inbound-router). Wrapped the same way as
 *  the outbound openChannel dep (see fanoutClose) — this is the OTHER place a
 *  raw channel first reaches a PeerLink (the answerer side, via
 *  PeerLink.adopt()), so it needs the same onClose multi-subscriber safety
 *  before attachFabricLink() gets a chance to also listen for close. */
export function fabricAcceptInbound(ch: unknown): void {
  mgr?.acceptInbound(fanoutClose(ch as LinkChannel) as unknown as { peerGatewayId?: string });
}

/** Test seam: init with fully injected deps (no transport/hub). */
export function __initFabricForTest(deps: FabricTestDeps): void {
  stopFabric();
  self = { node: deps.selfNode, cluster: deps.cluster };
  mgr = new PeerManager({ listPeers: deps.listPeers, makeLink: deps.makeLink, now: () => Date.now() });
}

// ---------------------------------------------------------------------------
// W2: FabricLink attach + fabricRequest/fabricProbe.
// ---------------------------------------------------------------------------

/** Build and register the W2 transmission link for one connected peer:
 *  facade over its live channel, the RPC server (loopback dispatch + shared
 *  idempotency + bulk offload), and the metrics/scheduler/compression knobs.
 *  Invoked from PeerLink.onConnected() for BOTH directions (initiator and
 *  answerer) — see initFabric()'s makeLink and fabricAcceptInbound above. */
async function attachFabricLink(selfNode: string, peer: string, link: PeerLink, ch: FabricCapableChannel): Promise<void> {
  await ensureCodec();
  const settings = () => {
    const { getProjectSettings } = require('../project-settings') as typeof import('../project-settings');
    return getProjectSettings();
  };
  const metrics = new LinkMetrics();
  const scheduler = new ClassScheduler();
  const applyBulkCap = () => {
    // relay path only: cap the bulk class per settings (MB/s → bytes/s); direct is uncapped.
    scheduler.setCap('bulk', link.policy() === 'relay' ? Math.max(0, settings().fabricRelayBulkCapMBps) * 1_000_000 || null : null);
  };
  applyBulkCap();

  const facade: FabricChannel = {
    peer,
    policy: () => link.policy(),
    peerHasFeature: (f) => link.peerHasFeature(f),
    send: (b) => ch.send(b),
    sendControl: (b) => ch.sendControl(b),
    onData: (cb) => ch.onData(cb),
  };

  const server = createRpcServer({
    dispatch: loopbackDispatch(loopbackApiPort()),
    idempotency: sharedIdempotency,
    rpcEnabled: () => settings().fabricRpcEnabled,
    peerNodeOf: () => peer,
    offloadThreshold: undefined, // default 8MB
    offload: async (bytes, peerNode) => {
      const { enqueueJob, waitForJob } = require('../file-transfer') as typeof import('../file-transfer');
      const os = require('os') as typeof import('os');
      const fsp = require('fs/promises') as typeof import('fs/promises');
      const pathMod = require('path') as typeof import('path');
      let outboxPath: string | null = null;
      const handle = await offloadResponse(bytes, peerNode, {
        enqueueJob, waitForJob,
        writeOutbox: async (transferId, buf) => {
          const dir = pathMod.join(os.tmpdir(), 'lm-fabric-outbox');
          await fsp.mkdir(dir, { recursive: true });
          const p = pathMod.join(dir, `${transferId}.bin`);
          await fsp.writeFile(p, Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
          outboxPath = p;
          return p;
        },
      });
      // offloadResponse awaited waitForJob — the peer has confirmed delivery
      // — before returning, so the local scratch copy is safe to remove now.
      // (Task 11 flagged this outbox temp as an unaddressed leak-on-every-
      // bulk-response; closing the loop here.)
      if (outboxPath) { await fsp.unlink(outboxPath).catch(() => {}); }
      return { handle };
    },
  });

  const fl = new FabricLink(facade, {
    metrics, scheduler,
    onServer: server,
    // W2 owns onData once attached (see fabric-link.ts), so a post-connect
    // re-advertise (W1's readvertise()/readvertiseAll) only ever reaches
    // PeerLink through this forward — must NOT be a no-op (Task 12 review).
    onHello: (hello) => link.ingestPeerHello(hello),
    compressionEnabled: () => settings().fabricCompressionEnabled,
  });
  fabricLinks.set(peer, fl);

  // Fail any in-flight fabricRequest calls fast when the underlying channel
  // drops, instead of leaving them to expire on their own ~30s default
  // timeout (Task 9's report named this "the link-close/teardown hook a
  // future task wires to LinkChannel.onClose"). Safe ONLY because `ch`
  // reaches here already onClose-fanout-wrapped (see fanoutClose, applied at
  // both of this function's callers) — PeerLink's own onClose (registered
  // earlier, inside PeerLink.attach()) keeps firing unchanged alongside this.
  ch.onClose((reason) => {
    fl.failInflight(new Error(`fabric link to ${peer} closed: ${reason ?? 'unknown reason'}`));
  });
}

/** Test/probe accessor: the live FabricLink for a connected peer, or null. */
export function getFabricLink(node: string): FabricLink | null { return fabricLinks.get(node) ?? null; }

/** Test seam: inject a FabricLink directly (bypasses the connect handshake —
 *  used to unit-test fabricRequest/fabricProbe without a live 2-node fabric). */
export function __setFabricLinkForTest(node: string, link: FabricLink): void { fabricLinks.set(node, link); }

/** Test seam: drive the REAL attach wiring (facade + rpc-server + onHello/
 *  onClose plumbing) directly against an injected PeerLink + channel, without
 *  needing a live transport/hub. Callers that want to prove BOTH PeerLink's
 *  own close handling and this attach's failInflight wiring fire side by
 *  side must hand it an onClose-fanout-capable `ch` (see fanoutClose) —
 *  exactly what production guarantees via initFabric()'s makeLink and
 *  fabricAcceptInbound. */
export function __attachFabricLinkForTest(peer: string, link: PeerLink, ch: FabricCapableChannel): Promise<void> {
  return attachFabricLink(self.node || 'test-self', peer, link, ch);
}

async function resolveNode(addr: FabricAddr): Promise<string | null> {
  if ('node' in addr) return addr.node;
  const { getResolutionService } = require('../resolution') as typeof import('../resolution');
  const loc = await getResolutionService().resolve(addr.resource.kind, addr.resource.id) as { node?: string } | null;
  return loc?.node ?? null;
}

/** Issue one RPC over the fabric to `addr`, resolving a resource address to a
 *  node first if needed. Transparently follows a `bulk` handle (Task 11) so
 *  callers never see it — the caller just gets `data`. */
export async function fabricRequest(
  addr: FabricAddr,
  init: { method: string; path: string; body?: unknown; query?: Record<string, string>; reqId?: string; timeoutMs?: number },
): Promise<FabricResponse> {
  await ensureCodec();
  const node = await resolveNode(addr);
  if (!node) throw new Error(`fabric: could not resolve ${JSON.stringify(addr)} to a node`);
  const link = fabricLinks.get(node);
  if (!link) throw new Error(`fabric: no fabric link to ${node} (not connected or legacy peer)`);
  const contentType = init.body != null ? 'application/json' : undefined;
  const res = await link.request({ ...init, contentType });
  const status = res.headers.status ?? 0;
  if (res.headers.code) return { status, code: res.headers.code, message: res.headers.message };
  let data: unknown;
  if (res.headers.bulk) {
    const handle = decodeBody(res.payload) as BulkHandle;
    const { receiveRoot, safeJoin } = require('../file-transfer') as typeof import('../file-transfer');
    const fsp = require('fs/promises') as typeof import('fs/promises');
    try {
      const bytes = await fetchBulk(handle, { readSink: productionReadSink });
      data = decodeBody(bytes);
    } finally {
      // The drop file has done its job whether fetchBulk succeeded OR threw
      // (a checksum/size mismatch) — clean it up on BOTH paths. Nothing else
      // currently sweeps completed fabric-bulk/<id>.bin drops (file-transfer's
      // own TTL sweep only covers .lmpart sidecars), so left alone a failed
      // verify leaks the now-useless (possibly corrupt) file forever, same as
      // an un-cleaned success would (Task 11 flagged the success case; a
      // try/finally here covers both).
      await fsp.unlink(safeJoin(receiveRoot(), handle.sink)).catch(() => {});
    }
  } else {
    data = res.payload.length ? decodeBody(res.payload) : null;
  }
  return { status, data };
}

/** Round-trip a 256KB echo over the fabric link to `node` and report RTT +
 *  approximate throughput. Route/MCP exposure is Task 13; this is the hook. */
export async function fabricProbe(node: string): Promise<{ node: string; rttMs: number | null; mbps: number | null; path: 'direct' | 'relay' | 'none' }> {
  const link = fabricLinks.get(node);
  if (!link) return { node, rttMs: null, mbps: null, path: 'none' };
  const payload = new Uint8Array(256 * 1024); // 256KB echo
  const start = Date.now();
  const rtt = await link.ping(payload);
  const elapsed = Math.max(1, Date.now() - start);
  const mbps = (payload.length * 2) / (elapsed / 1000) / 1_000_000; // round-trip bytes / s
  const path = link.metrics.snapshot().perClass.control.outBps >= 0 ? (rtt >= 0 ? 'direct' : 'relay') : 'none';
  return { node, rttMs: rtt, mbps, path };
}
