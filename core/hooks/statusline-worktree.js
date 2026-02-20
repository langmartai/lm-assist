#!/usr/bin/env node
/**
 * statusline-worktree.js - Cross-platform Claude Code status line script
 *
 * Pure Node.js, no external dependencies. Replaces statusline-worktree.sh.
 * Reads JSON from stdin (Claude Code status line hook input), outputs ANSI-colored
 * status lines to stdout.
 *
 * Supports: Windows, macOS, Linux
 *
 * Output (3 sections):
 *   - Last 4 user prompts (dim older, bold newest, cyan)
 *   - Project dir + worktree context
 *   - System info: ctx%, ram, free mem, pid, uptime, model
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// ANSI Colors
// ---------------------------------------------------------------------------

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// ---------------------------------------------------------------------------
// Read stdin
// ---------------------------------------------------------------------------

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    const timer = setTimeout(() => resolve(chunks.join('')), 5000);
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(chunks.join(''));
    });
  });
}

// ---------------------------------------------------------------------------
// Extract last N user prompts from transcript JSONL
// ---------------------------------------------------------------------------

function extractPrompts(transcriptPath, count) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];

  try {
    // Read last ~200KB of the transcript for performance
    const stat = fs.statSync(transcriptPath);
    const readSize = Math.min(stat.size, 200 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);

    const text = buf.toString('utf-8');
    // If we started mid-line, skip the first partial line
    const startIdx = stat.size > readSize ? text.indexOf('\n') + 1 : 0;
    const lines = text.slice(startIdx).split('\n').filter(Boolean);

    const prompts = [];
    // Walk backward to find user prompts
    for (let i = lines.length - 1; i >= 0 && prompts.length < count; i--) {
      try {
        const d = JSON.parse(lines[i]);
        if (d.type !== 'user') continue;
        const msg = d.message;
        if (!msg) continue;
        const content = typeof msg === 'object' ? (typeof msg.content === 'string' ? msg.content : '') : '';
        if (content && !content.startsWith('<')) {
          prompts.push(content.slice(0, 120));
        }
      } catch {
        // skip unparseable lines
      }
    }
    return prompts;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Detect active worktree from transcript file references
// ---------------------------------------------------------------------------

function detectWorktree(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';

  const cacheDir = path.join(os.tmpdir(), 'statusline-wt-cache');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}

  // Simple hash of transcript path for cache key
  let hash = 0;
  for (let i = 0; i < transcriptPath.length; i++) {
    hash = ((hash << 5) - hash + transcriptPath.charCodeAt(i)) | 0;
  }
  const cacheKey = path.join(cacheDir, Math.abs(hash).toString(36));

  let transcriptSize;
  try {
    transcriptSize = fs.statSync(transcriptPath).size;
  } catch {
    return '';
  }

  // Check cache
  try {
    const cached = fs.readFileSync(cacheKey, 'utf-8').trim();
    const sepIdx = cached.indexOf(':');
    if (sepIdx >= 0) {
      const cachedSize = cached.slice(0, sepIdx);
      const cachedWt = cached.slice(sepIdx + 1);
      if (cachedSize === String(transcriptSize)) {
        return cachedWt;
      }
    }
  } catch {}

  // Scan transcript for worktree references
  let wt = '';
  try {
    // Read last ~300KB for worktree detection
    const stat = fs.statSync(transcriptPath);
    const readSize = Math.min(stat.size, 300 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);

    const text = buf.toString('utf-8');

    // Strong signal: file paths like tier-agent-wt-N/something
    const strongRe = /tier-agent-wt-(\d+)(?=\/[a-zA-Z.])/g;
    const counts = {};
    let match;
    // Walk from end of text by finding all matches then taking last 30
    const allMatches = [];
    while ((match = strongRe.exec(text)) !== null) {
      allMatches.push(match[1]);
    }
    // Take last 30 (most recent)
    const recent = allMatches.slice(-30);
    for (const num of recent) {
      counts[num] = (counts[num] || 0) + 1;
    }

    // Find the most frequent
    let maxCount = 0;
    for (const [num, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        wt = num;
      }
    }

    // Fallback: any mention of tier-agent-wt-N
    if (!wt) {
      const weakRe = /tier-agent-wt-(\d+)/g;
      const weakAll = [];
      while ((match = weakRe.exec(text)) !== null) {
        weakAll.push(match[1]);
      }
      const weakRecent = weakAll.slice(-15);
      const weakCounts = {};
      for (const num of weakRecent) {
        weakCounts[num] = (weakCounts[num] || 0) + 1;
      }
      maxCount = 0;
      for (const [num, count] of Object.entries(weakCounts)) {
        if (count > maxCount) {
          maxCount = count;
          wt = num;
        }
      }
    }
  } catch {}

  // Cache result
  try {
    fs.writeFileSync(cacheKey, `${transcriptSize}:${wt}`);
  } catch {}

  return wt;
}

// ---------------------------------------------------------------------------
// Read worktree details from .env file
// ---------------------------------------------------------------------------

function readWorktreeDetails(wtNum) {
  // Worktree directories follow the pattern /home/ubuntu/tier-agent-wt-N
  // On Windows/macOS this likely doesn't exist — gracefully return empty
  const wtDir = `/home/ubuntu/tier-agent-wt-${wtNum}`;
  const result = { desc: '', branch: '', apiPort: '', dbPort: '' };

  try {
    if (!fs.existsSync(wtDir)) return result;
    const envPath = path.join(wtDir, '.env');
    if (!fs.existsSync(envPath)) return result;
    const envContent = fs.readFileSync(envPath, 'utf-8');

    const descMatch = envContent.match(/^WORKTREE_DESC=["']?(.+?)["']?\s*$/m);
    if (descMatch) result.desc = descMatch[1];

    const apiMatch = envContent.match(/^API_PORT=["']?(\d+)["']?\s*$/m);
    if (apiMatch) result.apiPort = apiMatch[1];

    const dbMatch = envContent.match(/^DB_PORT=["']?(\d+)["']?\s*$/m);
    if (dbMatch) result.dbPort = dbMatch[1];

    try {
      result.branch = execSync(`git -C "${wtDir}" branch --show-current`, {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {}
  } catch {}

  return result;
}

// ---------------------------------------------------------------------------
// Scan all available worktrees
// ---------------------------------------------------------------------------

function scanWorktrees() {
  const worktrees = [];
  const baseDir = '/home/ubuntu';

  try {
    if (!fs.existsSync(baseDir)) return worktrees;
    const entries = fs.readdirSync(baseDir);
    for (const entry of entries) {
      const match = entry.match(/^tier-agent-wt-(\d+)$/);
      if (!match) continue;
      const num = match[1];
      const wtDir = path.join(baseDir, entry);

      let desc = '';
      let status = '--';

      try {
        const envPath = path.join(wtDir, '.env');
        if (fs.existsSync(envPath)) {
          const envContent = fs.readFileSync(envPath, 'utf-8');
          const descMatch = envContent.match(/^WORKTREE_DESC=["']?(.+?)["']?\s*$/m);
          if (descMatch) desc = descMatch[1];
        }
      } catch {}

      // Check if API is running on expected port
      const apiPort = 3100 + parseInt(num, 10);
      try {
        if (process.platform === 'linux') {
          const ssOut = execSync(`ss -tlnp 2>/dev/null`, {
            encoding: 'utf-8',
            timeout: 3000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          if (ssOut.includes(`:${apiPort} `)) status = 'ON';
        }
      } catch {}

      worktrees.push({ num, desc, status });
    }
  } catch {}

  return worktrees;
}

// ---------------------------------------------------------------------------
// Cross-platform process info detection
// ---------------------------------------------------------------------------

function getProcessInfo() {
  const info = { mem: '', pid: '', tty: '', age: '' };
  const platform = process.platform;

  try {
    if (platform === 'linux') {
      // Walk /proc/ PID ancestry
      let pid = process.pid;
      for (let i = 0; i < 8; i++) {
        try {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
          const parts = stat.split(' ');
          const ppid = parseInt(parts[3], 10);
          if (!ppid || ppid <= 1) break;

          const comm = fs.readFileSync(`/proc/${ppid}/comm`, 'utf-8').trim();
          if (comm === 'claude-native' || comm === 'claude') {
            info.pid = String(ppid);

            // RSS from /proc/PID/status
            try {
              const status = fs.readFileSync(`/proc/${ppid}/status`, 'utf-8');
              const rssMatch = status.match(/VmRSS:\s+(\d+)\s+kB/);
              if (rssMatch) {
                info.mem = formatMemory(parseInt(rssMatch[1], 10) * 1024);
              }
            } catch {}

            // TTY + Process age from /proc/PID/stat of the Claude process
            try {
              const ppidStat = fs.readFileSync(`/proc/${ppid}/stat`, 'utf-8').split(' ');

              // TTY (field 7 in /proc/PID/stat, 0-indexed as [6])
              const ttyNr = parseInt(ppidStat[6], 10);
              if (ttyNr > 0) {
                const minor = ttyNr & 0xff;
                info.tty = `pts/${minor}`;
              }
              const startTicks = parseInt(ppidStat[21], 10);
              let clkTck = 100;
              try {
                clkTck = parseInt(execSync('getconf CLK_TCK', {
                  encoding: 'utf-8',
                  timeout: 2000,
                  stdio: ['pipe', 'pipe', 'pipe'],
                }).trim(), 10) || 100;
              } catch {}
              const uptime = parseFloat(fs.readFileSync('/proc/uptime', 'utf-8').split(' ')[0]);
              const nowTicks = Math.floor(uptime * clkTck);
              const ageSec = Math.floor((nowTicks - startTicks) / clkTck);
              const hours = Math.floor(ageSec / 3600);
              const mins = Math.floor((ageSec % 3600) / 60);
              info.age = hours > 0 ? `${hours}h${mins}m` : `${mins}m`;
            } catch {}

            break;
          }
          pid = ppid;
        } catch {
          break;
        }
      }
    } else if (platform === 'darwin') {
      // macOS: use ps command
      try {
        const psOut = execSync('ps -axo pid=,ppid=,rss=,etime=,comm=', {
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const procs = {};
        for (const line of psOut.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 5) continue;
          procs[parts[0]] = {
            ppid: parts[1],
            rss: parseInt(parts[2], 10), // KB
            etime: parts[3],
            comm: parts.slice(4).join(' '),
          };
        }

        // Walk up from our PID
        let pid = String(process.pid);
        for (let i = 0; i < 8; i++) {
          const proc = procs[pid];
          if (!proc) break;
          const ppid = proc.ppid;
          const parent = procs[ppid];
          if (!parent || ppid === '0' || ppid === '1') break;

          const comm = path.basename(parent.comm);
          if (comm === 'claude-native' || comm === 'claude') {
            info.pid = ppid;
            info.mem = formatMemory(parent.rss * 1024); // ps rss is in KB
            info.age = parseEtime(parent.etime);
            break;
          }
          pid = ppid;
        }
      } catch {}
    } else if (platform === 'win32') {
      // Windows: use wmic or just walk ppid chain with limited info
      try {
        const csvOut = execSync(
          'wmic process get ProcessId,ParentProcessId,WorkingSetSize,Name /format:csv',
          { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const procs = {};
        const lines = csvOut.split('\n').filter(l => l.trim());
        // CSV header: Node,Name,ParentProcessId,ProcessId,WorkingSetSize
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].trim().split(',');
          if (cols.length < 5) continue;
          procs[cols[3]] = {
            name: cols[1],
            ppid: cols[2],
            workingSet: parseInt(cols[4], 10) || 0,
          };
        }

        let pid = String(process.pid);
        for (let i = 0; i < 8; i++) {
          const proc = procs[pid];
          if (!proc) break;
          const ppid = proc.ppid;
          const parent = procs[ppid];
          if (!parent || ppid === '0' || ppid === '1') break;

          const name = (parent.name || '').toLowerCase();
          if (name.includes('claude-native') || name === 'claude.exe' || name === 'claude') {
            info.pid = ppid;
            info.mem = formatMemory(parent.workingSet);
            break;
          }
          pid = ppid;
        }
      } catch {}
    }
  } catch {}

  return info;
}

// ---------------------------------------------------------------------------
// Parse ps etime format (e.g. "01:23:45" or "1-02:03:04" or "45:23")
// ---------------------------------------------------------------------------

function parseEtime(etime) {
  if (!etime) return '';
  // Format: [[DD-]HH:]MM:SS
  const dayMatch = etime.match(/^(\d+)-(.+)$/);
  let days = 0;
  let rest = etime;
  if (dayMatch) {
    days = parseInt(dayMatch[1], 10);
    rest = dayMatch[2];
  }
  const parts = rest.split(':').map(Number);
  let hours = 0, mins = 0;
  if (parts.length === 3) {
    hours = parts[0];
    mins = parts[1];
  } else if (parts.length === 2) {
    mins = parts[0];
  }
  hours += days * 24;
  return hours > 0 ? `${hours}h${mins}m` : `${mins}m`;
}

// ---------------------------------------------------------------------------
// Format bytes to human-readable
// ---------------------------------------------------------------------------

function formatMemory(bytes) {
  if (!bytes || bytes <= 0) return '';
  const mb = Math.floor(bytes / (1024 * 1024));
  if (mb >= 1024) {
    const gbInt = Math.floor(mb / 1024);
    const gbFrac = Math.floor((mb % 1024) * 10 / 1024);
    return `${gbInt}.${gbFrac}G`;
  }
  return `${mb}M`;
}

// ---------------------------------------------------------------------------
// Get system free memory (cross-platform via os.freemem)
// ---------------------------------------------------------------------------

function getSystemFreeMemory() {
  return formatMemory(os.freemem());
}

// ---------------------------------------------------------------------------
// Context color based on percentage
// ---------------------------------------------------------------------------

function ctxColor(pct) {
  if (pct >= 80) return RED;
  if (pct >= 50) return YELLOW;
  return GREEN;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let input;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const transcriptPath = input.transcript_path || '';
  const projectDir = (input.workspace && input.workspace.project_dir) || input.cwd || '';
  const ctxPct = Math.floor(
    (input.context_window && input.context_window.used_percentage) || 0
  );
  const model = (input.model && input.model.display_name) || '';

  // --- Extract last 4 user prompts ---
  const prompts = extractPrompts(transcriptPath, 4);

  // --- Detect worktree ---
  const currentWt = detectWorktree(transcriptPath);
  const wtDetails = currentWt ? readWorktreeDetails(currentWt) : null;

  // --- Scan all worktrees ---
  const worktrees = scanWorktrees();

  // --- Process info ---
  const procInfo = getProcessInfo();

  // --- System free memory ---
  const sysFree = getSystemFreeMemory();

  // === Render Line 1: Last 4 user prompts (oldest first, newest bold) ===
  if (prompts.length > 0) {
    // prompts[0] is newest, prompts[N-1] is oldest — render oldest first
    for (let i = prompts.length - 1; i >= 0; i--) {
      if (!prompts[i]) continue;
      if (i === 0) {
        process.stdout.write(`${BOLD}${CYAN}> ${prompts[i]}${RESET}\n`);
      } else {
        process.stdout.write(`${DIM}${CYAN}> ${prompts[i]}${RESET}\n`);
      }
    }
  }

  // === Render Line 2: Project dir + worktree context ===
  let line2 = `${DIM}${projectDir}${RESET}`;
  if (currentWt && wtDetails && wtDetails.desc) {
    const dbLabel = (!wtDetails.dbPort || wtDetails.dbPort === '5432')
      ? 'shared'
      : `isolated:${wtDetails.dbPort}`;
    line2 += ` ${BOLD}${CYAN}wt-${currentWt}${RESET}`;
    line2 += ` ${GREEN}${wtDetails.desc}${RESET}`;
    line2 += ` ${DIM}[${wtDetails.branch || '?'}] api:${wtDetails.apiPort || '?'} db:${dbLabel}${RESET}`;
  } else if (currentWt) {
    line2 += ` ${BOLD}${YELLOW}wt-${currentWt}${RESET} ${DIM}(not found)${RESET}`;
  } else {
    line2 += ` ${BOLD}${BLUE}main${RESET}`;
  }
  process.stdout.write(line2 + '\n');

  // === Render Line 3: Worktree list + system info ===
  let line3 = '';

  if (worktrees.length > 0) {
    const parts = worktrees.map(wt => {
      let desc = wt.desc;
      if (desc.length > 20) desc = desc.slice(0, 18) + '..';

      if (wt.num === currentWt) {
        if (wt.status === 'ON') {
          return `${BOLD}${GREEN}*${wt.num}${RESET}${DIM}:${desc}${RESET}`;
        }
        return `${BOLD}${YELLOW}*${wt.num}${RESET}${DIM}:${desc}${RESET}`;
      }
      if (wt.status === 'ON') {
        return `${GREEN}${wt.num}${RESET}${DIM}:${desc}${RESET}`;
      }
      return `${DIM}${wt.num}:${desc}${RESET}`;
    });
    line3 += 'wt: ' + parts.join(' ');
  } else {
    line3 += `${DIM}no worktrees${RESET}`;
  }

  // System info
  line3 += ` ${ctxColor(ctxPct)}ctx:${ctxPct}%${RESET}`;
  if (procInfo.mem) line3 += ` ${DIM}ram:${procInfo.mem}${RESET}`;
  if (sysFree) line3 += ` ${DIM}free:${sysFree}${RESET}`;
  if (procInfo.pid) line3 += ` ${DIM}pid:${procInfo.pid}${RESET}`;
  if (procInfo.tty) line3 += ` ${DIM}${procInfo.tty}${RESET}`;
  if (procInfo.age) line3 += ` ${DIM}up:${procInfo.age}${RESET}`;
  if (model) line3 += ` ${DIM}${model}${RESET}`;

  process.stdout.write(line3 + '\n');
}

main().catch(() => process.exit(0));
