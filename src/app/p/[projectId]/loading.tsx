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
        <div style={{ display: 'flex', gap: '1rem', padding: '0 0.6rem 0.6rem' }}>
          <Skeleton w="4rem" h="0.7rem" />
          <Skeleton w="6rem" h="0.7rem" />
          <Skeleton w="5rem" h="0.7rem" />
        </div>
        {repeat(5).map((i) => (
          <div
            key={i}
            style={{
              display: 'grid',
              gridTemplateColumns: '14rem 1fr 6rem 17rem',
              gap: '1rem',
              alignItems: 'center',
              padding: '0.85rem 0.6rem',
              borderTop: '1px solid var(--border)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Skeleton w="0.9rem" h="0.9rem" style={{ borderRadius: '3px', flexShrink: 0 }} />
              <Skeleton w={i === 0 ? '3.5rem' : '9rem'} />
              {i === 0 && <Skeleton w="3.5rem" h="1.1rem" style={{ borderRadius: '999px' }} />}
            </div>
            <div>
              <Skeleton w="60%" style={{ marginBottom: '0.35rem' }} />
              <Skeleton w="5rem" h="0.7rem" />
            </div>
            <Skeleton w="3rem" h="0.8rem" />
            {i !== 0 && <Skeleton w="15rem" h="2rem" style={{ marginLeft: 'auto' }} />}
          </div>
        ))}
      </div>
    </SkeletonPage>
  );
}
