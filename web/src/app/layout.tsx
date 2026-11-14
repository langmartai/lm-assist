import type { Metadata, Viewport } from 'next';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { AppModeProvider } from '@/contexts/AppModeContext';
import { SessionExpiredOverlay } from '@/components/SessionExpiredOverlay';
import { ChunkErrorReloader } from '@/components/ChunkErrorReloader';
import { RouteTracker } from '@/components/RouteTracker';
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
//
// The HTML carries NO credential. This layout renders for anyone who can reach the
// web port (a LAN device, a relayed hub request, a 404 page), and it cannot tell who
// is asking — Host and X-Forwarded-* are caller-controlled. The browser fetches its
// Core token at runtime from Core's GET /auth/browser-token instead (see
// bootstrapBrowserAuth in lib/api-client.ts), and Core decides on the real socket
// peer. Do not inject any secret here.
export const dynamic = 'force-dynamic';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const localApiPort = process.env.LM_LOCAL_API_PORT || '';
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
      </head>
      <body suppressHydrationWarning>
        <ThemeProvider>
          <AppModeProvider>
            <ChunkErrorReloader />
            <RouteTracker />
            <SessionExpiredOverlay />
            {children}
          </AppModeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
