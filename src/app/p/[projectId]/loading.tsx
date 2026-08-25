import { Skeleton, SkeletonHeader, SkeletonPage, repeat } from '@/components/Skeleton';

/** Branch list: new-branch bar, then a row per branch. */
export default function Loading() {
  return (
    <SkeletonPage>
      <SkeletonHeader titleWidth="14rem" />

      <div className="card" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <Skeleton w="12rem" h="2rem" />
        <Skeleton w="3rem" h="0.8rem" />
        <Skeleton w="10rem" h="2rem" />
        <Skeleton w="7rem" h="2rem" />
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '1rem', padding: '0.5rem 0.25rem', borderBottom: '1px solid var(--border)' }}>
          <Skeleton w="5rem" h="0.8rem" />
          <Skeleton w="7rem" h="0.8rem" />
          <Skeleton w="5rem" h="0.8rem" />
        </div>
        {repeat(5).map((i) => (
          <div
            key={i}
            style={{
              display: 'grid',
              gridTemplateColumns: '14rem 1fr 6rem 16rem',
              gap: '1rem',
              alignItems: 'center',
              padding: '0.75rem 0.25rem',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <Skeleton w={i === 0 ? '4rem' : '11rem'} />
            <div>
              <Skeleton w="70%" style={{ marginBottom: '0.35rem' }} />
              <Skeleton w="5rem" h="0.7rem" />
            </div>
            <Skeleton w="3rem" h="0.8rem" />
            <Skeleton w="14rem" h="2rem" style={{ marginLeft: 'auto' }} />
          </div>
        ))}
      </div>
    </SkeletonPage>
  );
}
