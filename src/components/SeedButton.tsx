'use client';

/**
 * Reseeds the demo project. Used both as the empty-state call to action on a
 * fresh install and as the "reset demo" recovery action once it exists — the
 * same request either way, since seeding is a full reset, not an upsert.
 */

import type { ReactNode } from 'react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

export function SeedButton({ label, icon }: { label: string; icon?: ReactNode }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function seed() {
    setPending(true);
    try {
      const res = await fetch('/api/seed', { method: 'POST' });
      const body = await res.json();
      if (res.ok) {
        toast.success('Demo seeded');
        router.push(`/p/${body.data.projectId}`);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <button type="button" className="btn btn-primary" onClick={seed} disabled={pending}>
      {icon}
      {pending ? 'Seeding…' : label}
    </button>
  );
}
