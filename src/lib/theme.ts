'use client';

/**
 * Reads/writes the same `data-theme` attribute the inline script in
 * layout.tsx sets before first paint (see that file's comment) and
 * ThemeToggle reflects. Pulled out here because the toaster needs the
 * current theme too, to render toasts in the same palette as the page
 * rather than defaulting to whatever the OS prefers.
 *
 * `useSyncExternalStore`, not `useState` + a mount effect: the server can't
 * know which theme a returning visitor chose, so its snapshot and the
 * browser's real one can differ. This hook is what React ships for exactly
 * that split — see ThemeToggle's original comment for the fuller version.
 */

import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function getSnapshot(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function getServerSnapshot(): Theme {
  return 'dark';
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function setTheme(next: Theme) {
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('theme', next);
  } catch {
    // Private browsing / storage disabled — the change still applies to
    // this page view, it just won't be remembered next visit.
  }
}
