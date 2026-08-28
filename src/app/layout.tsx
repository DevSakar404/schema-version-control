import type { ReactNode } from 'react';
import Link from 'next/link';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { GitBranch } from 'lucide-react';
import { AppToaster } from '@/components/AppToaster';
import { ThemeToggle } from '@/components/ThemeToggle';
import './globals.css';

export const metadata = {
  title: 'Schema Version Control',
  description: 'Branch, diff, and merge for database schemas.',
};

// Sets `data-theme` on <html> before the browser paints anything, from
// whatever was chosen last time (or the OS preference, first visit) — a
// useEffect would run after that first paint and flash the wrong theme.
// Runs as plain script text, not a React-owned attribute, so hydration
// never compares against it (see src/lib/theme.ts for the read side).
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* Purely decorative — fixed behind every route, never intercepts
            input. `.page` (every route's top-level wrapper) sits in a
            stacking context above it, so real content is never at risk of
            being covered even if a future page omits it. */}
        <div className="bg-layer" aria-hidden>
          <div className="bg-grid" />
          <div className="bg-aura">
            <span />
            <span />
            <span />
          </div>
        </div>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden>
                <GitBranch size={18} strokeWidth={2.25} />
              </span>
              Schema Version Control
            </Link>
            <ThemeToggle />
          </div>
        </header>
        {children}
        <AppToaster />
      </body>
    </html>
  );
}
