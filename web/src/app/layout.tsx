import type { Metadata } from 'next';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { AppModeProvider } from '@/contexts/AppModeContext';
import { SessionExpiredOverlay } from '@/components/SessionExpiredOverlay';
import './globals.css';

export const metadata: Metadata = {
  title: 'LangMart Assist',
  description: 'Mission Control for AI agent sessions',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
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
