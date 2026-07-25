#!/usr/bin/env node
/**
 * Measure the /sessions page load: request count, per-path duplication,
 * and time-to-first-rows-rendered.
 *
 * Reproduces (and automates) the console measurement:
 *   performance.getEntriesByType("resource") grouped by path
 *
 * Query strings are STRIPPED before grouping/printing — they carry api tokens
 * and must never be logged. Session UUIDs in paths are normalised to <id> so
 * repeated detail fetches group together.
 *
 * Usage:
 *   node web/scripts/measure-sessions-load.js [--url https://localhost:3849/sessions]
 *                                             [--wait 30] [--label before] [--json out.json]
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const os = require('os');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const URL_ = arg('url', 'https://localhost:3849/sessions');
const WAIT_S = Number(arg('wait', '30'));
const LABEL = arg('label', 'run');
const JSON_OUT = arg('json', '');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Strip query (tokens!) + normalise ids so duplicates group. */
function normalisePath(rawUrl) {
  let p;
  try {
    p = new URL(rawUrl).pathname;
  } catch {
    p = String(rawUrl).split('?')[0];
  }
  return p.replace(UUID_RE, '<id>');
}

(async () => {
  const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-sessions-'));

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'shell',
    userDataDir,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--ignore-certificate-errors',
      '--window-size=1440,900',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    // Record, from inside the page, the moment the first session row paints.
    // Session rows carry className="animate-fade-in" (SessionSidebar row);
    // the loading state renders .skeleton placeholders instead.
    await page.evaluateOnNewDocument(() => {
      window.__m = { firstRowAt: null, firstSkeletonAt: null, rowCount: 0, lastRowGrowthAt: null, milestones: [] };
      const check = () => {
        const m = window.__m;
        if (m.firstSkeletonAt === null && document.querySelector('.skeleton')) {
          m.firstSkeletonAt = performance.now();
        }
        const rows = document.querySelectorAll('.animate-fade-in');
        if (rows.length > 0) {
          if (m.firstRowAt === null) m.firstRowAt = performance.now();
          if (rows.length > m.rowCount) {
            m.lastRowGrowthAt = performance.now();
            if (m.milestones.length < 20) m.milestones.push({ t: Math.round(performance.now()), n: rows.length });
          }
          m.rowCount = rows.length;
        }
      };
      const start = () => {
        check();
        new MutationObserver(check).observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      };
      if (document.documentElement) start();
      else document.addEventListener('DOMContentLoaded', start);
    });

    const t0 = Date.now();
    await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const domContentLoadedMs = Date.now() - t0;

    // Let the full fan-out play out.
    await new Promise(r => setTimeout(r, WAIT_S * 1000));

    const data = await page.evaluate(() => ({
      marks: window.__m,
      nav: (() => {
        const n = performance.getEntriesByType('navigation')[0];
        return n ? { domComplete: n.domComplete, loadEventEnd: n.loadEventEnd } : null;
      })(),
      resources: performance.getEntriesByType('resource').map(r => ({
        name: r.name,
        initiatorType: r.initiatorType,
        duration: r.duration,
        startTime: r.startTime,
        transferSize: r.transferSize,
        encodedBodySize: r.encodedBodySize,
      })),
      headerText: (() => {
        const els = Array.from(document.querySelectorAll('div,span,h1,h2,h3'));
        const el = els.find(e => /^Sessions \(/.test((e.textContent || '').trim()));
        return el ? el.textContent.trim().slice(0, 60) : null;
      })(),
      bodyHasError: /Failed to fetch sessions|is not defined/.test(document.body.innerText || ''),
    }));

    // ── Group API calls by normalised path ──
    // "Load phase" = everything the page issued up to the moment the session list
    // stopped growing. Counting the whole observation window is misleading once
    // the page is fast: it finishes early and then just polls, so a FASTER page
    // reports MORE requests. The load-phase number is the apples-to-apples one.
    const loadPhaseEndMs = (data.marks.lastRowGrowthAt ?? data.marks.firstRowAt ?? 0) + 250;

    const groups = new Map();
    for (const r of data.resources) {
      const p = normalisePath(r.name);
      // Only count app/API traffic, not JS/CSS chunks
      if (/\/_next\/|\.(js|css|woff2?|png|svg|ico|map)$/.test(p)) continue;
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(r);
    }

    const rows = [...groups.entries()]
      .map(([p, rs]) => ({
        path: p,
        count: rs.length,
        loadPhaseCount: rs.filter(r => r.startTime <= loadPhaseEndMs).length,
        maxMs: Math.round(Math.max(...rs.map(r => r.duration))),
        totalMs: Math.round(rs.reduce((a, r) => a + r.duration, 0)),
        bytes: rs.reduce((a, r) => a + (r.encodedBodySize || 0), 0),
        loadPhaseBytes: rs.filter(r => r.startTime <= loadPhaseEndMs)
          .reduce((a, r) => a + (r.encodedBodySize || 0), 0),
      }))
      .sort((a, b) => b.totalMs - a.totalMs);

    const apiCount = rows.reduce((a, r) => a + r.count, 0);
    const dupCount = rows.filter(r => r.count > 1).reduce((a, r) => a + (r.count - 1), 0);
    const totalBytes = rows.reduce((a, r) => a + r.bytes, 0);
    const loadCount = rows.reduce((a, r) => a + r.loadPhaseCount, 0);
    const loadDupes = rows.reduce((a, r) => a + Math.max(0, r.loadPhaseCount - 1), 0);
    const loadBytes = rows.reduce((a, r) => a + r.loadPhaseBytes, 0);

    const summary = {
      label: LABEL,
      url: URL_.split('?')[0],
      domContentLoadedMs,
      domCompleteMs: data.nav ? Math.round(data.nav.domComplete) : null,
      firstRowRenderedMs: data.marks.firstRowAt === null ? null : Math.round(data.marks.firstRowAt),
      firstSkeletonMs: data.marks.firstSkeletonAt === null ? null : Math.round(data.marks.firstSkeletonAt),
      listCompleteMs: data.marks.lastRowGrowthAt === null ? null : Math.round(data.marks.lastRowGrowthAt),
      rowMilestones: data.marks.milestones,
      rowsRendered: data.marks.rowCount,
      sidebarHeader: data.headerText,
      visibleError: data.bodyHasError,
      loadPhaseEndMs: Math.round(loadPhaseEndMs),
      loadPhaseRequests: loadCount,
      loadPhaseDuplicates: loadDupes,
      loadPhaseBytes: loadBytes,
      apiRequestCount: apiCount,
      duplicateRequests: dupCount,
      apiBytes: totalBytes,
      perPath: rows,
    };

    const pad = (s, n) => String(s).padEnd(n);
    console.log(`\n╭─ ${LABEL} — ${summary.url}`);
    console.log(`│  DOM complete            ${summary.domCompleteMs} ms`);
    console.log(`│  first skeleton painted  ${summary.firstSkeletonMs} ms`);
    console.log(`│  FIRST ROWS RENDERED     ${summary.firstRowRenderedMs} ms`);
    console.log(`│  LIST COMPLETE           ${summary.listCompleteMs} ms   (${summary.rowsRendered} rows)`);
    console.log(`│  row milestones          ${summary.rowMilestones.map(m => `${m.n}@${m.t}ms`).join('  ')}`);
    console.log(`│  sidebar header          ${summary.sidebarHeader}`);
    console.log(`│  visible error on page   ${summary.visibleError}`);
    console.log(`│  LOAD PHASE (<=${pad(summary.loadPhaseEndMs + 'ms)', 8)} ${summary.loadPhaseRequests} requests, ${summary.loadPhaseDuplicates} duplicates, ${(summary.loadPhaseBytes / 1024).toFixed(0)} KB`);
    console.log(`│  whole ${WAIT_S}s window       ${summary.apiRequestCount} requests, ${summary.duplicateRequests} duplicates, ${(summary.apiBytes / 1024).toFixed(0)} KB`);
    console.log(`├─ per path (query strings stripped) ─────────────────────────────────`);
    console.log(`│  ${pad('load', 6)}${pad('all', 5)}${pad('maxMs', 8)}${pad('KB', 9)}path`);
    for (const r of rows) {
      const flag = r.loadPhaseCount > 1 ? '*' : ' ';
      console.log(`│ ${flag}${pad(r.loadPhaseCount, 6)}${pad(r.count, 5)}${pad(r.maxMs, 8)}${pad((r.bytes / 1024).toFixed(1), 9)}${r.path}`);
    }
    console.log(`╰─ (* = fetched more than once DURING LOAD; 'all' includes post-load polling)\n`);

    if (JSON_OUT) {
      fs.writeFileSync(JSON_OUT, JSON.stringify(summary, null, 2));
      console.log(`wrote ${JSON_OUT}`);
    }
  } finally {
    await browser.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
})().catch(err => {
  console.error('measure failed:', err);
  process.exit(1);
});
