import type { Metadata, Viewport } from 'next';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { AppModeProvider } from '@/contexts/AppModeContext';
import { SessionExpiredOverlay } from '@/components/SessionExpiredOverlay';
import { ChunkErrorReloader } from '@/components/ChunkErrorReloader';
import './globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  title: 'LangMart Assist',
  description: 'Mission Control for AI agent sessions',
};

// Read the local core API port at REQUEST time (not build time). LM_LOCAL_API_PORT
// is intentionally NOT prefixed NEXT_PUBLIC_, so Next.js does not inline it into
// client bundles — the server reads the running process's env. This lets ONE build
// serve both the prod web (:3848 → core :3100, env unset → default) and the dev web
// (:3948 → core :3200, launched with LM_LOCAL_API_PORT=3200). Injected into the
// client as window.__LM_LOCAL_API_PORT__; detectAppMode() prefers it. Domain/port
// agnostic — nothing hardcoded.
export const dynamic = 'force-dynamic';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const localApiPort = process.env.LM_LOCAL_API_PORT || '';
  // Read the worker's rotating API token (server-side; this layout runs on the
  // worker host in local mode). Injected to the browser so local-mode fetches
  // can send x-api-key. In hub mode there is no local file -> empty -> the hub
  // relay injects the token server-side instead.
  let lmApiToken = '';
  try {
    const _fs = require('fs'); const _os = require('os'); const _path = require('path');
    const _dir = process.env.LM_ASSIST_DATA_DIR || _path.join(_os.homedir(), '.lm-assist');
    lmApiToken = _fs.readFileSync(_path.join(_dir, 'api-token'), 'utf8').trim();
  } catch { /* hub mode / no file */ }
  return (
    <html lang="en">
      <head>
        {localApiPort ? (
          <script
            dangerouslySetInnerHTML={{
              __html: `window.__LM_LOCAL_API_PORT__=${JSON.stringify(localApiPort)};`,
            }}
          />
        ) : null}
        {lmApiToken ? (
          <script
            dangerouslySetInnerHTML={{
              __html: `window.__LM_API_TOKEN__=${JSON.stringify(lmApiToken)};`,
            }}
          />
        ) : null}
      </head>
      <body suppressHydrationWarning>
        <ThemeProvider>
          <AppModeProvider>
            <ChunkErrorReloader />
            <SessionExpiredOverlay />
            {children}
          </AppModeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
