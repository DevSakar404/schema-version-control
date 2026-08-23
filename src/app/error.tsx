'use client';

import { useEffect } from 'react';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="page">
      <div className="card" style={{ borderColor: 'var(--danger)' }}>
        <h1 style={{ marginTop: 0, fontSize: '1.2rem' }}>Something went wrong</h1>
        <p className="text-dim" style={{ fontFamily: 'var(--mono)', fontSize: '0.85rem' }}>{error.message}</p>
        <button type="button" className="btn btn-primary" onClick={reset}>Try again</button>
      </div>
    </main>
  );
}
