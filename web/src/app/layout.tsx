import type { Metadata, Viewport } from 'next';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { AppModeProvider } from '@/contexts/AppModeContext';
import { SessionExpiredOverlay } from '@/components/SessionExpiredOverlay';
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
            <SessionExpiredOverlay />
            {children}
          </AppModeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
