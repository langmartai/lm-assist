/**
 * Firehose sender — high-throughput, rate-paced, fire-once single-file push.
 *
 * The data plane is the channel's DIRECT UDP socket (channel.sendUnreliable):
 * unreliable, never ACK-clocked, never blocks on a round trip. Loss is repaired
 * out-of-band: the receiver NACKs missing seqs over the reliable relay control
 * plane; the sender re-fires them over the DIRECT plane first, and only escalates
 * a stubborn seq to a reliable RELAY repair after it survives K direct re-fire
 * rounds. Rate adapts with AIMD off the per-interval loss rate. Only an actual
 * connection loss (direct death) stalls the firehose — and even then outstanding
 * chunks are escalated over the relay so the transfer still completes.
 *
 * All coordination (FT_FH_META, FT_NACK, FT_FH_END, FT_FH_REPAIR, FT_OK/FT_ERR)
 * rides channel.sendControl / channel.onData (the reliable relay). Only the bulk
 * chunk bytes ride channel.sendUnreliable (direct).
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
import { Channel } from '../transport';
import { FrameReader, encodeControl } from './frame';
import {
  FIREHOSE_CHUNK,
  packFirehoseDatagram,
  encodeMissingRuns,
  decodeMissingRuns,
} from './firehose-wire';
import { SUBSYSTEM_TAG } from './protocol';
import type { FtFhMeta, FtFhEnd, FtFhRepair, FtNack, FtDelay, FtOk, FtErr, SendResult, SendOpts } from './types';

// --- rate-AIMD constants (the parent tunes these against real e2e) ---
/** AIMD evaluation interval. */
const RATE_INTERVAL_MS = 200;
/** Starting rate (~4 MB/s). */
const RATE_START = 4 * 1024 * 1024;
/** Lower clamp. */
const RATE_MIN = 256 * 1024;
/** Upper clamp. */
const RATE_MAX = 200 * 1024 * 1024;
// Delay-based rate control (Aspera FASP / LEDBAT style): drive the rate from the
// receiver's measured QUEUING DELAY, not from loss. Loss only triggers repair.
/** Target queuing delay (ms) — keep a small, stable standing queue. */
const TARGET_QD_MS = 30;
/** Per-report gain: rate *= 1 + GAIN*clamp((TARGET-qd)/TARGET, -1, 1). */
const DELAY_GAIN = 0.15;

/** Re-fire rounds over DIRECT before a stubborn seq escalates to a RELAY repair. */
const K_REFIRE = 3;

/** Pacing tick granularity for the token bucket. */
const PACE_TICK_MS = 5;

/** How long directReady() must stay false before we escalate ALL outstanding. */
const DIRECT_DEATH_MS = 3000;

export interface FirehoseSendOpts extends SendOpts {
  /** Override the AIMD interval / start rate / K for tests + tuning. */
  rateIntervalMs?: number;
  rateStart?: number;
  kRefire?: number;
  /** Test/diagnostic hook: called each AIMD interval with the current rate. */
  onRate?: (rate: number) => void;
  /** Test/diagnostic hook: called when a relay repair is emitted (cumulative). */
  onRepair?: (count: number) => void;
}

/**
 * Push a single large file over the firehose. Caller has already opened the
 * channel and confirmed channel.directReady(). Resolves on the receiver's FT_OK,
 * rejects on FT_ERR / channel close / fatal error. Returns a SendResult shaped
 * like sendPath's.
 */
export function sendFirehose(
  channel: Channel,
  localPath: string,
  remotePath: string,
  name: string,
  totalBytes: number,
  fileMode: number,
  opts?: FirehoseSendOpts,
): Promise<SendResult> {
  const chunk = FIREHOSE_CHUNK;
  const totalChunks = totalBytes === 0 ? 0 : Math.ceil(totalBytes / chunk);
  const transferId = crypto.randomUUID();
  const rateIntervalMs = opts?.rateIntervalMs ?? RATE_INTERVAL_MS;
  const kRefire = opts?.kRefire ?? K_REFIRE;

  return new Promise<SendResult>((resolve, reject) => {
    let settled = false;
    let fh: fsp.FileHandle | null = null;

    // Pacing + AIMD state.
    let rate = opts?.rateStart ?? RATE_START; // bytes/sec
    let lastQd = 0; // last reported queuing delay (ms)
    // Delay-based rate update (FASP/LEDBAT): raise rate while queuing delay is
    // below target, lower it when above. Loss never touches the rate.
    const handleDelay = (qd: number): void => {
      lastQd = qd;
      const off = Math.max(-1, Math.min(1, (TARGET_QD_MS - qd) / TARGET_QD_MS));
      rate = Math.max(RATE_MIN, Math.min(RATE_MAX, rate * (1 + DELAY_GAIN * off)));
    };
    let tokens = 0; // token bucket (bytes)
    let lastFillAt = Date.now();
    let nextSeq = 0; // next chunk to fire in the first pass
    let firstPassDone = false;

    // Loss accounting (per AIMD interval).
    let sentThisInterval = 0; // chunks fired (first pass + refire) this interval
    let lostThisInterval = 0; // chunks NACKed this interval

    // Repair bookkeeping.
    const refireCount = new Map<number, number>(); // seq -> direct re-fire rounds done
    const escalated = new Set<number>();           // seqs already sent as relay repair

    // Diagnostics (tests read these via opts hooks if provided).
    let repairCount = 0; // FT_FH_REPAIR messages emitted

    // Direct-death tracking. While the direct leg is sustained-down, NACKed seqs
    // are escalated to the reliable relay IMMEDIATELY (effective K = 0) instead of
    // wasting K rounds re-firing into a dead socket — so the transfer completes
    // over the relay even if direct never recovers ("never stuck unless conn").
    let directDownSince = 0;
    let directDead = false;

    let paceTimer: NodeJS.Timeout | null = null;
    let rateTimer: NodeJS.Timeout | null = null;

    const reader = new FrameReader();

    const cleanup = (): void => {
      if (paceTimer) { clearInterval(paceTimer); paceTimer = null; }
      if (rateTimer) { clearInterval(rateTimer); rateTimer = null; }
      if (fh) { fh.close().catch(() => {}); fh = null; }
    };

    const finish = (err?: Error, result?: SendResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(result!);
    };

    // --- read a chunk by seq from the file (used for first pass + refire) ---
    const readChunk = async (seq: number): Promise<Buffer> => {
      const offset = seq * chunk;
      const len = Math.min(chunk, totalBytes - offset);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh!.read(buf, 0, len, offset);
      return bytesRead === len ? buf : buf.subarray(0, bytesRead);
    };

    // --- fire one chunk over the DIRECT plane (unreliable). ---
    const fireDirect = async (seq: number): Promise<void> => {
      const bytes = await readChunk(seq);
      channel.sendUnreliable(packFirehoseDatagram(seq, Date.now(), bytes));
      sentThisInterval += 1;
    };

    // --- escalate one stubborn chunk over the reliable RELAY. ---
    const escalateRelay = async (seq: number): Promise<void> => {
      if (escalated.has(seq)) return;
      escalated.add(seq);
      const bytes = await readChunk(seq);
      const msg: FtFhRepair = {
        type: 'FT_FH_REPAIR',
        transferId,
        seq,
        data: bytes.toString('base64'),
      };
      channel.sendControl(encodeControl(msg));
      repairCount += 1;
      opts?.onRepair?.(repairCount);
    };

    // --- the rate-paced first-pass firehose loop (token bucket). ---
    const startPacing = (): void => {
      lastFillAt = Date.now();
      tokens = chunk; // allow the first chunk immediately
      paceTimer = setInterval(() => {
        if (settled) return;
        const now = Date.now();
        tokens += (rate * (now - lastFillAt)) / 1000;
        lastFillAt = now;
        // Cap the bucket so a stall can't accumulate an unbounded burst.
        const burstCap = Math.max(chunk * 4, (rate * rateIntervalMs) / 1000);
        if (tokens > burstCap) tokens = burstCap;

        // Fire-once first pass while tokens + chunks remain. Never waits on acks.
        const fires: Array<Promise<void>> = [];
        while (!firstPassDone && tokens >= chunk && nextSeq < totalChunks) {
          tokens -= chunk;
          const seq = nextSeq++;
          fires.push(fireDirect(seq).catch(() => {}));
          opts?.onProgress?.(Math.min(totalBytes, nextSeq * chunk), totalBytes);
        }
        if (!firstPassDone && nextSeq >= totalChunks) {
          firstPassDone = true;
          // After the first pass completes, announce END (sha256). The receiver
          // then NACKs whatever it is still missing; we keep refiring until FT_OK.
          void sendEnd();
        }
      }, PACE_TICK_MS);
      paceTimer.unref?.();
    };

    const sendEnd = async (): Promise<void> => {
      try {
        const sha256 = await sha256File(localPath);
        if (settled) return;
        const end: FtFhEnd = { type: 'FT_FH_END', transferId, totalChunks, sha256 };
        channel.sendControl(encodeControl(end));
      } catch (e) {
        finish(e as Error);
      }
    };

    // Delay-based controller: rate is set by handleDelay() off the receiver's
    // queuing-delay reports. This timer only logs + handles direct death (loss is
    // NOT a rate signal — it only schedules repairs).
    const startRateControl = (): void => {
      rateTimer = setInterval(() => {
        if (settled) return;
        const _sent = sentThisInterval, _lost = lostThisInterval;
        sentThisInterval = 0;
        lostThisInterval = 0;
        opts?.onRate?.(rate);
        if (process.env.LM_FHDEBUG) console.log('[fh] rate=' + Math.round(rate / 1024) + 'KB/s sent=' + _sent + ' lost=' + _lost + ' qd=' + lastQd.toFixed(0) + 'ms repairs=' + repairCount + ' seq=' + nextSeq + '/' + totalChunks + ' direct=' + channel.directReady());

        // DIRECT-DEATH escalation: when the direct leg has been down for a
        // sustained window, flip directDead so subsequent NACKs escalate to the
        // relay immediately (effective K = 0). NACKs ride the reliable relay, so
        // they keep arriving even with direct dead; the firehose still completes.
        if (!channel.directReady()) {
          if (directDownSince === 0) directDownSince = Date.now();
          else if (Date.now() - directDownSince >= DIRECT_DEATH_MS) directDead = true;
        } else {
          directDownSince = 0;
          directDead = false;
        }
      }, rateIntervalMs);
      rateTimer.unref?.();
    };

    // --- handle an inbound NACK: refire over direct, escalate stubborn ones. ---
    const handleNack = async (n: FtNack): Promise<void> => {
      if (n.transferId !== transferId || settled) return;
      const missing = decodeMissingRuns(n.missing);
      lostThisInterval += missing.length;
      for (const seq of missing) {
        if (settled) break;
        if (escalated.has(seq)) continue; // already escalated → relay will deliver it
        const rounds = (refireCount.get(seq) ?? 0) + 1;
        refireCount.set(seq, rounds);
        // Stubborn loss (> K direct re-fire rounds) OR a sustained-dead direct
        // leg → escalate to the reliable relay. Otherwise re-fire over direct
        // (next batch — never pauses the firehose).
        if (rounds > kRefire || directDead) {
          await escalateRelay(seq);
        } else {
          await fireDirect(seq).catch(() => {}); // re-fire over direct
        }
      }
    };

    // --- inbound control (FT_NACK / FT_OK / FT_ERR) over the reliable relay. ---
    channel.onData((data) => {
      let frames;
      try { frames = reader.push(data); }
      catch (e) { finish(e as Error); return; }
      for (const f of frames) {
        if (f.kind !== 'control') continue;
        const msg = f.msg as FtNack | FtOk | FtErr | { type: string };
        if (msg.type === 'FT_NACK') { void handleNack(msg as FtNack); }
        else if (msg.type === 'FT_DELAY' && (msg as FtDelay).transferId === transferId) { handleDelay((msg as FtDelay).qd); }
        else if (msg.type === 'FT_OK' && (msg as FtOk).transferId === transferId) {
          finish(undefined, { bytes: totalBytes, entries: 1, mode: channel.mode, via: channel.via });
        }
        else if (msg.type === 'FT_ERR' && (msg as FtErr).transferId === transferId) {
          finish(new Error('sha256 mismatch: ' + (msg as FtErr).error));
        }
      }
    });

    channel.onClose((reason) => {
      finish(new Error('channel closed before FT_OK' + (reason ? ': ' + reason : '')));
    });

    // --- bring-up ---
    (async () => {
      try {
        fh = await fsp.open(localPath, 'r');
        // Announce ourselves + the firehose manifest over the reliable relay.
        channel.sendControl(encodeControl({ type: SUBSYSTEM_TAG } as never));
        const meta: FtFhMeta = {
          type: 'FT_FH_META',
          transferId,
          root: remotePath,
          name,
          size: totalBytes,
          chunk,
          totalChunks,
          mode: 'firehose',
          fileMode,
        };
        channel.sendControl(encodeControl(meta));
        // Empty file: nothing to fire, jump straight to END.
        if (totalChunks === 0) { firstPassDone = true; await sendEnd(); }
        startPacing();
        startRateControl();
      } catch (e) {
        finish(e as Error);
      }
    })();
  });
}

function sha256File(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(absPath);
    rs.on('error', reject);
    rs.on('data', (d) => h.update(d));
    rs.on('end', () => resolve(h.digest('hex')));
  });
}
