'use client';

/**
 * Reseeds the demo project. Used both as the empty-state call to action on a
 * fresh install and as the "reset demo" recovery action once it exists — the
 * same request either way, since seeding is a full reset, not an upsert.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function SeedButton({ label }: { label: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function seed() {
    setPending(true);
    try {
      const res = await fetch('/api/seed', { method: 'POST' });
      const body = await res.json();
      if (res.ok) router.push(`/p/${body.data.projectId}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <button type="button" className="btn btn-primary" onClick={seed} disabled={pending}>
      {pending ? 'Seeding…' : label}
    </button>
  );
}
