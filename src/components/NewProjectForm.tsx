'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Toast } from './Toast';

export function NewProjectForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error?.message ?? 'could not create project');
        return;
      }
      router.push(`/p/${body.data.id}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="card" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
      <input
        placeholder="project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <button type="submit" className="btn btn-primary" disabled={pending || !name.trim()}>
        {pending ? 'Creating…' : 'New project'}
      </button>
      {error && <Toast message={error} onDismiss={() => setError(null)} />}
    </form>
  );
}
