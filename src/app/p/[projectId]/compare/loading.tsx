import { Skeleton, SkeletonPage, repeat } from '@/components/Skeleton';

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
    </SkeletonPage>
  );
}
