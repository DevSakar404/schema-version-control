'use client';

import { Moon, Sun } from 'lucide-react';
import { setTheme, useTheme } from '@/lib/theme';

export function ThemeToggle() {
  const theme = useTheme();

  return (
    <button
      type="button"
      className="btn theme-toggle"
      onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
      aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
    >
      {theme === 'light' ? <Sun size={15} strokeWidth={2} aria-hidden /> : <Moon size={15} strokeWidth={2} aria-hidden />}
    </button>
  );
}
