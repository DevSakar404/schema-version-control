import { Skeleton, SkeletonPage, CompareDiffSkeleton } from '@/components/Skeleton';

/**
 * Diff view. Reuses the real .diff-* classes so the gutters, hunk rows and
 * line grid are exactly where the loaded diff will put them — the placeholder
 * and the content occupy the same geometry.
 */
export default function Loading() {
  return (
    <SkeletonPage>
      <Skeleton w="9rem" h="0.8rem" style={{ marginBottom: '0.75rem' }} />
      <Skeleton w="24rem" h="2rem" style={{ marginBottom: '1rem' }} />
      <Skeleton w="16rem" h="0.9rem" style={{ marginBottom: '1.25rem' }} />
      <CompareDiffSkeleton />
    </SkeletonPage>
  );
}
