import type { CSSProperties, ReactNode } from 'react';

/**
 * Loading placeholders.
 *
 * Each route has its own `loading.tsx` built from these, shaped like the page
 * it stands in for — same headings, same card structure, same row counts.
 * The point is that the layout doesn't jump when the real content arrives,
 * which a single centred "Loading…" cannot do.
 */

export function Skeleton({
  w = '100%',
  h = '0.9rem',
  style,
}: {
  w?: string;
  h?: string;
  style?: CSSProperties;
}) {
  // aria-hidden: the bars are decorative. SkeletonPage announces the state.
  return <span className="skeleton" style={{ width: w, height: h, ...style }} aria-hidden />;
}

/**
 * Page shell for a loading state. Marks the region busy so assistive tech
 * announces it rather than reading out a screenful of empty boxes.
 */
export function SkeletonPage({ children }: { children: ReactNode }) {
  return (
    <main className="page" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {children}
    </main>
  );
}

/** Breadcrumb + title, the header every page inside a project shares. */
export function SkeletonHeader({ titleWidth = '18rem' }: { titleWidth?: string }) {
  return (
    <>
      <Skeleton w="9rem" h="0.8rem" style={{ marginBottom: '0.75rem' }} />
      <Skeleton w={titleWidth} h="2rem" style={{ marginBottom: '1.5rem' }} />
    </>
  );
}

export function repeat(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * The diff body's placeholder rows — shared by compare/loading.tsx (a full
 * first navigation into the route) and DiffViewSwitcher (an in-place
 * Unified/Split toggle, which keeps the real header and buttons on screen
 * and only swaps this part out).
 */
export function CompareDiffSkeleton() {
  return (
    <>
      {repeat(2).map((file) => (
        <div key={file} className="diff-file">
          <div className="diff-file-header">
            <Skeleton w="7rem" h="1rem" />
            <Skeleton w="6rem" h="1.1rem" />
            <Skeleton w="4rem" h="0.8rem" style={{ marginLeft: 'auto' }} />
          </div>
          <div className="diff-body">
            <div className="diff-hunk">
              <Skeleton w="12rem" h="0.7rem" />
            </div>
            {repeat(file === 0 ? 6 : 4).map((line) => (
              <div className="diff-line diff-line--context" key={line}>
                <span className="diff-num" />
                <span className="diff-num" />
                <span className="diff-code" style={{ paddingTop: '0.2rem' }}>
                  <Skeleton w={`${30 + ((line * 17) % 45)}%`} h="0.75rem" />
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
