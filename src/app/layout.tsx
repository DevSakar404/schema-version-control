import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Schema Version Control',
  description: 'Branch, diff, and merge for database schemas.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Purely decorative — fixed behind every route, never intercepts
            input. `.page` (every route's top-level wrapper) sits in a
            stacking context above it, so real content is never at risk of
            being covered even if a future page omits it. */}
        <div className="bg-lines" aria-hidden>
          {Array.from({ length: 5 }, (_, i) => (
            <span className="bg-line" key={i} />
          ))}
        </div>
        {children}
      </body>
    </html>
  );
}
