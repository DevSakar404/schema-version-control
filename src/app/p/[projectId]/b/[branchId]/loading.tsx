import { Skeleton, SkeletonHeader, SkeletonPage, repeat } from '@/components/Skeleton';

/** Schema editor: the sticky commit bar, then a card per table. */
export default function Loading() {
  return (
    <SkeletonPage>
      <SkeletonHeader titleWidth="12rem" />

      <div
        className="card"
        style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginBottom: '1.5rem' }}
      >
        <Skeleton w="5rem" h="1rem" />
        <Skeleton w="9rem" h="0.8rem" />
        <Skeleton h="2rem" style={{ flex: '1 1 12rem' }} />
        <Skeleton w="9rem" h="2rem" />
        <Skeleton w="5rem" h="2rem" />
      </div>

      {repeat(2).map((card) => (
        <section key={card} className="card" style={{ marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.9rem' }}>
            <Skeleton w="8rem" h="1.3rem" />
            <Skeleton w="5rem" h="0.8rem" />
            <Skeleton w="6rem" h="1.8rem" style={{ marginLeft: 'auto' }} />
          </div>
          {repeat(card === 0 ? 4 : 3).map((row) => (
            <div
              key={row}
              style={{
                display: 'grid',
                gridTemplateColumns: '10rem 7rem 6rem 5rem 1fr',
                gap: '0.6rem',
                alignItems: 'center',
                padding: '0.45rem 0',
                borderTop: '1px solid var(--border)',
              }}
            >
              <Skeleton w="8rem" />
              <Skeleton w="5rem" />
              <Skeleton w="4rem" h="0.8rem" />
              <Skeleton w="3.5rem" h="0.8rem" />
              <Skeleton w="3rem" h="1.7rem" style={{ marginLeft: 'auto' }} />
            </div>
          ))}
          <Skeleton w="6rem" h="0.75rem" style={{ margin: '0.9rem 0 0.4rem' }} />
          {repeat(2).map((row) => (
            <div key={row} style={{ padding: '0.4rem 0', borderTop: '1px solid var(--border)' }}>
              <Skeleton w={row === 0 ? '55%' : '40%'} />
            </div>
          ))}
        </section>
      ))}
    </SkeletonPage>
  );
}
