'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { GitBranch } from 'lucide-react';
import { Toast } from './Toast';

interface BranchOption {
  id: string;
  name: string;
  headCommitId: string;
}

export function NewBranchForm({
  projectId,
  branches,
}: {
  projectId: string;
  branches: BranchOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [fromId, setFromId] = useState(branches.find((b) => b.name === 'main')?.id ?? branches[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const from = branches.find((b) => b.id === fromId);
    if (!from) return;

    const res = await fetch(`/api/projects/${projectId}/branches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), fromCommitId: from.headCommitId }),
    });
    const body = await res.json();

    if (!res.ok) {
      // The server's own message: it names the duplicate branch directly
      // (design.md — inline validation via the DB constraint, not a
      // separate existence lookup).
      setError(body.error?.message ?? 'could not create branch');
      return;
    }

    toast.success(`Branch "${name.trim()}" created`);
    setName('');
    startTransition(() => router.refresh());
  }

  return (
    <form onSubmit={submit} className="card form-row" style={{ maxWidth: '42rem' }}>
      <input
        placeholder="new-branch-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        pattern="[a-zA-Z0-9._\-\/]+"
        title="letters, numbers, dots, dashes, underscores, slashes"
      />
      <span className="text-dim">from</span>
      <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <button type="submit" className="btn btn-primary" disabled={pending || !name.trim()}>
        <GitBranch size={14} strokeWidth={2.25} aria-hidden />
        {pending ? 'Creating…' : 'New branch'}
      </button>
      {error && <Toast message={error} onDismiss={() => setError(null)} />}
    </form>
  );
}
