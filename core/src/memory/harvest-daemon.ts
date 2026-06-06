/**
 * Memory Harvest Daemon -- periodic proposer (Stream A feeder).
 *
 * Runs memory-harvest.js on a schedule so recent sessions are analysed and
 * proposed into ~/.lm-assist/memory-proposals.jsonl automatically.
 *
 * SAFETY: default OFF. Only activates when MEMORY_HARVEST_DAEMON=on.
 * When on, runs in propose-default mode only -- writes proposals, never memory
 * files, never git. Mirrors autosync.ts structure exactly.
 *
 * Env vars:
 *   MEMORY_HARVEST_DAEMON          off (default) | on
 *   MEMORY_HARVEST_INTERVAL_HOURS  interval between sweeps (default 6)
 *   MEMORY_HARVEST_RUN_ON_BOOT     off (default) | on  -- run a tick immediately
 *
 * See docs/plans/2026-06-06-record-level-memory-map-and-sync.md
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";

// --- Constants ----------------------------------------------------

const LOG_DIR  = path.join(os.homedir(), ".cache", "lm-assist");
const LOG_FILE = path.join(LOG_DIR, "memory-harvest-daemon.log");

/**
 * Path to the harvest script, relative to this compiled file.
 *   Compiled: core/dist/memory/harvest-daemon.js
 *   Script  : core/scripts/memory-harvest.js
 *   Relative: ../../scripts/memory-harvest.js
 */
const HARVEST_SCRIPT = path.join(__dirname, "..", "..", "scripts", "memory-harvest.js");

/** API port -- same detection logic as autosync.ts and the script itself. */
const API_PORT = process.env.API_PORT ||
  (__dirname.includes("node_modules") ? "3100" : "3200");

const CONCURRENCY = 8;

// --- Types --------------------------------------------------------

export interface HarvestDaemonStatus {
  enabled: boolean;
  intervalHours: number;
  runOnBoot: boolean;
  running: boolean;
  lastRunMs: number | null;
  nextRunMs: number | null;
  lastProposalCount: number | null;
  lastExitCode: number | null;
  logFile: string;
}

// --- Daemon class -------------------------------------------------

export class MemoryHarvestDaemon {
  private enabled: boolean;
  private intervalHours: number;
  private runOnBoot: boolean;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRunMs: number | null = null;
  private nextRunMs: number | null = null;
  private lastProposalCount: number | null = null;
  private lastExitCode: number | null = null;
  private started = false;

  constructor() {
    this.enabled = (process.env.MEMORY_HARVEST_DAEMON || "").trim().toLowerCase() === "on";
    const raw = parseFloat(process.env.MEMORY_HARVEST_INTERVAL_HOURS || "6");
    this.intervalHours = isFinite(raw) && raw > 0 ? raw : 6;
    this.runOnBoot = (process.env.MEMORY_HARVEST_RUN_ON_BOOT || "").trim().toLowerCase() === "on";
  }

  /** Start the daemon. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;

    if (!this.enabled) {
      this.log("harvest daemon: disabled (MEMORY_HARVEST_DAEMON != on)");
      return;
    }

    const intervalMs = Math.round(this.intervalHours * 3600 * 1000);
    this.log(
      "harvest daemon: started" +
      " interval=" + this.intervalHours + "h" +
      " runOnBoot=" + String(this.runOnBoot) +
      " script=" + HARVEST_SCRIPT +
      " port=" + API_PORT,
    );

    if (this.runOnBoot) {
      // Small delay so the rest-server finishes wiring before the first tick.
      setTimeout(() => { void this.tick(); }, 2000);
    }

    this.scheduleNext(intervalMs);
  }

  /** Stop the daemon (cancel pending timer). Does not abort a running tick. */
  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.log("harvest daemon: stopped");
  }

  getStatus(): HarvestDaemonStatus {
    return {
      enabled: this.enabled,
      intervalHours: this.intervalHours,
      runOnBoot: this.runOnBoot,
      running: this.running,
      lastRunMs: this.lastRunMs,
      nextRunMs: this.nextRunMs,
      lastProposalCount: this.lastProposalCount,
      lastExitCode: this.lastExitCode,
      logFile: LOG_FILE,
    };
  }

  // --- Internal ---------------------------------------------------

  private scheduleNext(intervalMs: number): void {
    this.nextRunMs = Date.now() + intervalMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.scheduleNext(intervalMs));
    }, intervalMs);
    // setTimeout + reschedule in finally() is safer than setInterval:
    // a slow tick never queues a second one before the first finishes.
    if (this.timer.unref) this.timer.unref(); // do not keep process alive solo
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.log("harvest daemon: tick skipped -- previous run still in progress");
      return;
    }
    this.running = true;
    this.lastRunMs = Date.now();
    // Pass --since as epoch-ms so parseSince handles any fractional interval cleanly.
    const sinceMs = Date.now() - Math.round(this.intervalHours * 3600 * 1000);
    const sinceArg = String(sinceMs);
    this.log(
      "harvest daemon: tick start" +
      " since=" + new Date(sinceMs).toISOString() +
      " intervalHours=" + this.intervalHours +
      " concurrency=" + CONCURRENCY,
    );

    try {
      const exitCode = await this.runHarvest(sinceArg);
      this.lastExitCode = exitCode;
      // Count new proposals appended since tick start (best-effort).
      this.lastProposalCount = this.countRecentProposals(this.lastRunMs!);
      this.log(
        "harvest daemon: tick done" +
        " exitCode=" + exitCode +
        " proposals=" + String(this.lastProposalCount),
      );
    } catch (err) {
      this.lastExitCode = -1;
      this.log("harvest daemon: tick error -- " + String(err));
    } finally {
      this.running = false;
    }
  }

  /** Spawn memory-harvest.js and resolve with exit code. */
  private runHarvest(sinceArg: string): Promise<number> {
    return new Promise((resolve) => {
      const args = [
        HARVEST_SCRIPT,
        "--since", sinceArg,
        "--concurrency", String(CONCURRENCY),
        "--port", API_PORT,
      ];
      execFile("node", args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (stdout) this.log("harvest daemon: [stdout] " + stdout.trim().slice(0, 2000));
        if (stderr) this.log("harvest daemon: [stderr] " + stderr.trim().slice(0, 1000));
        // execFile passes non-zero exit as an Error with numeric .code
        const code = err
          ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
              ? Number((err as NodeJS.ErrnoException & { code?: unknown }).code)
              : 1)
          : 0;
        resolve(code);
      });
    });
  }

  /** Best-effort: count proposals written at or after fromMs. */
  private countRecentProposals(fromMs: number): number {
    const proposalFile = path.join(os.homedir(), ".lm-assist", "memory-proposals.jsonl");
    try {
      if (!fs.existsSync(proposalFile)) return 0;
      const lines = fs.readFileSync(proposalFile, "utf-8")
        .split(String.fromCharCode(10))
        .filter(Boolean);
      let count = 0;
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as { _harvestedAt?: number };
          if (typeof obj._harvestedAt === "number" && obj._harvestedAt >= fromMs) count++;
        } catch { /* skip malformed */ }
      }
      return count;
    } catch { return 0; }
  }

  // --- Logging ----------------------------------------------------

  private log(msg: string): void {
    const line = "[" + new Date().toISOString() + "] " + msg;
    console.log(line);
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(LOG_FILE, line + String.fromCharCode(10));
    } catch { /* logging must never throw */ }
  }
}

// --- Singleton ----------------------------------------------------

let instance: MemoryHarvestDaemon | null = null;

export function getHarvestDaemon(): MemoryHarvestDaemon {
  if (!instance) instance = new MemoryHarvestDaemon();
  return instance;
}
