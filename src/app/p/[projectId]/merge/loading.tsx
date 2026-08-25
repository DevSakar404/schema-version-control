import { Skeleton, SkeletonPage, repeat } from '@/components/Skeleton';

/** Merge view: action bar, conflict cards, hazards, migration. */
export default function Loading() {
  return (
    <SkeletonPage>
      <Skeleton w="9rem" h="0.8rem" style={{ marginBottom: '0.75rem' }} />
      <Skeleton w="26rem" h="2rem" style={{ marginBottom: '1.5rem' }} />

      <div
        className="card"
        style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginBottom: '1.5rem' }}
      >
        <Skeleton w="9rem" h="2rem" />
        <Skeleton w="16rem" h="2rem" />
      </div>

      <Skeleton w="8rem" h="1.1rem" style={{ marginBottom: '0.75rem' }} />
      <div className="card" style={{ marginBottom: '1rem', borderColor: 'var(--warning)' }}>
        <Skeleton style={{ marginBottom: '0.4rem' }} />
        <Skeleton w="65%" style={{ marginBottom: '0.9rem' }} />
        <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '0.9rem' }}>
          {repeat(3).map((col) => (
            <div key={col}>
              <Skeleton w="3rem" h="0.7rem" style={{ marginBottom: '0.3rem' }} />
              <Skeleton w="7rem" h="0.85rem" />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {repeat(3).map((b) => (
            <Skeleton key={b} w="8rem" h="2rem" />
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <Skeleton w="12rem" h="1.1rem" style={{ marginBottom: '0.4rem' }} />
        <Skeleton w="70%" h="0.8rem" style={{ marginBottom: '0.9rem' }} />
        {repeat(2).map((h) => (
          <div key={h} style={{ padding: '0.5rem 0', borderTop: '1px solid var(--border)' }}>
            <Skeleton w="85%" style={{ marginBottom: '0.3rem' }} />
            <Skeleton w="12rem" h="0.7rem" />
          </div>
        ))}
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '0.75rem' }}>
          <Skeleton w="7rem" h="1.1rem" />
          <Skeleton w="6rem" h="1.9rem" style={{ marginLeft: 'auto' }} />
        </div>
        {repeat(3).map((s) => (
          <div key={s} style={{ display: 'flex', gap: '0.5rem', padding: '0.45rem 0', borderTop: '1px solid var(--border)' }}>
            <Skeleton w="5rem" h="1.1rem" />
            <Skeleton w={`${45 + ((s * 19) % 35)}%`} h="0.85rem" />
          </div>
        ))}
      </div>
    </SkeletonPage>
  );
}
