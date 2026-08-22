import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Schema Version Control',
  description: 'Branch, diff, and merge for database schemas.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
