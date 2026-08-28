'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Database } from 'lucide-react';
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
      toast.success(`Project "${name.trim()}" created`);
      router.push(`/p/${body.data.id}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="card form-row" style={{ maxWidth: '28rem' }}>
      <input
        placeholder="project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <button type="submit" className="btn btn-primary" disabled={pending || !name.trim()}>
        <Database size={14} strokeWidth={2.25} aria-hidden />
        {pending ? 'Creating…' : 'New project'}
      </button>
      {error && <Toast message={error} onDismiss={() => setError(null)} />}
    </form>
  );
}
