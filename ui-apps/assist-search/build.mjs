#!/usr/bin/env node
/* Build the assist-search pane: the ORIGINAL web search page, bundled.
 *
 * JS — esbuild IIFE (CSP script-src 'self': one self-contained file, React inlined,
 * no CDN). The alias plugin is the whole port: '@/…' resolves into web/src, except
 * the four modules whose environment a pane must replace (app-mode/machine contexts,
 * next/navigation, the api-client probes) and the ConsoleTab stub. Identical harness
 * to the assist-sessions pane — only the entry component and the @source scan differ.
 *
 * CSS — web/src/app/globals.css compiled through Tailwind v4 (it IS a Tailwind
 * source: @import "tailwindcss" + @theme tokens). The Google-Fonts import is
 * stripped (pane CSP blocks external hosts), @source directives scope the utility
 * scan to the bundled sources, and src/pane.css is appended for pane sizing.
 *
 * assets/lmui.js is DELIBERATELY untouched: it stays the canonical shared shim so
 * `panes sync` + lmui-shim-identity.test.ts keep governing it (inlining it would
 * strand this pane on stale-shim incidents — docs/ui-panes-deploy.md rule 3).
 */
import esbuild from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const webSrc = path.join(repo, 'web', 'src');
const src = path.join(here, 'src');
const out = path.join(here, 'assets');
const dev = process.argv.includes('--dev');

// ── JS ──────────────────────────────────────────────────────────────────────
const SHIMS = {
  '@/contexts/AppModeContext': path.join(src, 'shims', 'app-mode.tsx'),
  '@/contexts/MachineContext': path.join(src, 'shims', 'machine.tsx'),
  '@/lib/api-client': path.join(src, 'shims', 'api-client.ts'),
};

const paneAlias = {
  name: 'pane-alias',
  setup(build) {
    build.onResolve({ filter: /^@\// }, async (args) => {
      if (args.pluginData?.paneAlias) return undefined;
      if (SHIMS[args.path]) return { path: SHIMS[args.path] };
      const rel = './' + args.path.slice(2);
      const r = await build.resolve(rel, {
        resolveDir: webSrc,
        // Keep the ORIGINAL importer visible to re-triggered hooks — without it the
        // ConsoleTab guard below sees importer:'' and an '@/…/ConsoleTab' specifier
        // would bundle the real tab (latent today; SessionDetail imports relatively).
        importer: args.importer,
        kind: args.kind,
        pluginData: { paneAlias: true },
      });
      return r.errors.length ? undefined : { path: r.path };
    });
    build.onResolve({ filter: /^next\/navigation$/ }, () => ({
      path: path.join(src, 'shims', 'navigation.ts'),
    }));
    // ConsoleTab is imported relatively by SessionDetail — match the specifier,
    // and anchor the importer check on the resolved webSrc path, not a substring.
    build.onResolve({ filter: /\/ConsoleTab$/ }, (args) =>
      args.importer.startsWith(webSrc + path.sep)
        ? { path: path.join(src, 'shims', 'console-tab.tsx') }
        : undefined,
    );
  },
};

const js = await esbuild.build({
  entryPoints: [path.join(src, 'main.tsx')],
  outfile: path.join(out, 'app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  // Honest floor: the bundle uses ES2023 APIs (findLastIndex, Object.hasOwn) that
  // esbuild does NOT polyfill — declaring older targets would only transpile syntax
  // and still crash there at runtime.
  target: ['es2022', 'safari16.4', 'chrome110', 'firefox110'],
  jsx: 'automatic',
  minify: !dev,
  sourcemap: dev,
  legalComments: 'none',
  metafile: true,
  plugins: [paneAlias],
  define: {
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
    'process.env.NEXT_PUBLIC_LOCAL_API_PORT': '"3100"',
  },
});

// ── CSS ─────────────────────────────────────────────────────────────────────
// Assemble the Tailwind input in a temp dir; @source paths are written absolute
// so the scan is independent of where the temp file lands.
let globals = await readFile(path.join(webSrc, 'app', 'globals.css'), 'utf8');
globals = globals.replace(/^@import url\([^)]*googleapis[^)]*\);\s*\n/m, '');
const sources = [
  path.join(webSrc, 'components', 'search'),
  // ChatTab (the session preview pane) lives under components/sessions and brings its
  // own utility classes — the scan must cover it or the preview renders unstyled.
  path.join(webSrc, 'components', 'sessions'),
  src,
].map((p) => `@source "${p}";`).join('\n');
globals = globals.replace('@import "tailwindcss";', `@import "tailwindcss";\n${sources}`);

// The input must sit INSIDE the repo: Tailwind resolves `@import "tailwindcss"`
// from the input file's location, and /tmp has no node_modules.
const cssIn = path.join(src, '.globals.gen.css');
await writeFile(cssIn, globals);
try {
  const result = await postcss([tailwind()]).process(globals, {
    from: cssIn,
    to: path.join(out, 'app.css'),
  });
  const paneCss = await readFile(path.join(src, 'pane.css'), 'utf8');
  await writeFile(path.join(out, 'app.css'), result.css + '\n' + paneCss);
} finally {
  await rm(cssIn, { force: true });
}

const jsBytes = (await readFile(path.join(out, 'app.js'))).length;
const cssBytes = (await readFile(path.join(out, 'app.css'))).length;
console.log(`app.js  ${(jsBytes / 1024).toFixed(1)} KB${dev ? ' (dev)' : ''}`);
console.log(`app.css ${(cssBytes / 1024).toFixed(1)} KB`);
if (js.metafile && process.argv.includes('--why')) {
  console.log(await esbuild.analyzeMetafile(js.metafile));
}
