'use client';

/**
 * Lives once in the root layout, outside `{children}` — Next only
 * unmounts/remounts the route content on navigation, so a toast fired right
 * before a `router.push` (a successful merge, say) survives onto the page
 * it lands on instead of vanishing with the route that queued it.
 */

import { Toaster } from 'sonner';
import { useTheme } from '@/lib/theme';

export function AppToaster() {
  const theme = useTheme();
  // `expand`: sonner's default is a collapsed stack where only the front
  // toast is actually clickable — the ones behind it get `pointer-events:
  // none` until you hover to fan them out. Fine for the occasional single
  // toast, but the schema editor can queue several in a row, and a
  // collapsed close button that only works on whichever happens to be on
  // top reads as broken. Always-expanded trades a little vertical space
  // for every toast staying genuinely clickable.
  return <Toaster theme={theme} position="top-right" closeButton expand />;
}
