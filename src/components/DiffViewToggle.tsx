'use client';

/**
 * Unified/Split toggle for the compare page.
 *
 * This used to navigate — a `?view=` URL param, a fresh `compareBranches()`
 * server round-trip per click. That was solving a problem that doesn't
 * exist: unified and split show the exact same `tree`, just laid out
 * differently. Re-fetching for a presentation-only change is why this ever
 * needed a loading state at all — first a "stuck after rapid clicks" bug
 * from an in-flight navigation with no guard, then (once guarded) a
 * skeleton that could never match the real diff's shape, because the real
 * shape is exactly what the round-trip was fetching.
 *
 * `tree` is already on the page — switching views is a local state flip,
 * nothing to await, nothing that can get stuck. The URL still updates (via
 * the History API directly, NOT next/navigation's router) so a `?view=`
 * link is still shareable, but that's cosmetic — it doesn't provoke a
 * server request.
 */

import { useState } from 'react';
import { SchemaDiffTree, type DiffView } from './SchemaDiffTree';
import type { DiffTree } from '@/core/difftree';

export function DiffViewToggle({
  tree,
  initialView,
  urlBase,
}: {
  tree: DiffTree;
  initialView: DiffView;
  urlBase: string;
}) {
  const [view, setView] = useState(initialView);

  function go(next: DiffView) {
    if (next === view) return;
    setView(next);
    window.history.replaceState(null, '', `${urlBase}&view=${next}`);
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
        <span className="segmented" role="group" aria-label="Diff view">
          <button type="button" aria-current={view === 'unified' ? 'page' : undefined} onClick={() => go('unified')}>
            Unified
          </button>
          <button type="button" aria-current={view === 'split' ? 'page' : undefined} onClick={() => go('split')}>
            Split
          </button>
        </span>
      </div>

      <SchemaDiffTree tree={tree} view={view} />
    </>
  );
}
