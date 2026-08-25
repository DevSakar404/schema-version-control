import { Skeleton, SkeletonPage } from '@/components/Skeleton';

/** Home: title, tagline, and the seed card. */
export default function Loading() {
  return (
    <SkeletonPage>
      <Skeleton w="22rem" h="2.2rem" style={{ marginBottom: '0.75rem' }} />
      <Skeleton w="18rem" h="1rem" style={{ marginBottom: '2rem' }} />
      <div className="card">
        <Skeleton w="10rem" h="1rem" style={{ marginBottom: '0.75rem' }} />
        <Skeleton h="0.8rem" style={{ marginBottom: '0.4rem' }} />
        <Skeleton w="80%" h="0.8rem" style={{ marginBottom: '1rem' }} />
        <Skeleton w="8rem" h="2rem" />
      </div>
    </SkeletonPage>
  );
}
