'use client';

/**
 * The merge screen's interactive state. Not one of the four files Task 19
 * named in the plan — ConflictCard, HazardList, and MigrationPreview stay
 * purely presentational, and this is where their data comes from: the
 * resolutions the user has picked, and the live re-preview that follows
 * every pick.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConflictCard } from './ConflictCard';
import { HazardList } from './HazardList';
import { MigrationPreview } from './MigrationPreview';
import { Toast } from './Toast';
import type { Resolution } from '@/core/merge';
import type { MergePreview } from '@/server/branches-service';

export function MergeBoard({
  projectId,
  targetId,
  sourceId,
  initialPreview,
}: {
  projectId: string;
  targetId: string;
  sourceId: string;
  initialPreview: MergePreview;
}) {
  const router = useRouter();
  const [resolutions, setResolutions] = useState<Resolution[]>([]);
  const [preview, setPreview] = useState<MergePreview>(initialPreview);
  const [previewing, setPreviewing] = useState(false);
  const [author, setAuthor] = useState('');
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<{ message: string; branchMoved: boolean } | null>(null);

  async function fetchPreview(nextResolutions: Resolution[]) {
    setPreviewing(true);
    try {
      const res = await fetch('/api/merge/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: targetId, source: sourceId, resolutions: nextResolutions }),
      });
      const body = await res.json();
      if (res.ok) setPreview(body.data);
    } finally {
      setPreviewing(false);
    }
  }

  function resolve(resolution: Resolution) {
    const next = [...resolutions.filter((r) => r.conflictId !== resolution.conflictId), resolution];
    setResolutions(next);
    fetchPreview(next);
  }

  async function commit() {
    setCommitting(true);
    setCommitError(null);
    try {
      const res = await fetch('/api/merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: targetId, source: sourceId, resolutions,
          expectedHead: preview.target.headCommitId, author,
        }),
      });
      if (res.status === 409) {
        setCommitError({ message: 'This branch moved since you started reviewing this merge.', branchMoved: true });
        return;
      }
      if (!res.ok) {
        const body = await res.json();
        setCommitError({ message: body.error?.message ?? 'merge failed', branchMoved: false });
        return;
      }
      // Straight to the target branch's schema, not the project list — a
      // successful merge is the moment someone most wants to see what
      // actually landed, and the branch list only shows a commit message,
      // not the merged tables themselves.
      router.push(`/p/${projectId}/b/${targetId}`);
    } finally {
      setCommitting(false);
    }
  }

  // A stale head loses nothing here: `resolutions` never gets cleared, so
  // re-previewing against whatever the branch moved to reuses every choice
  // the user already made. Losing that work would be the cruellest possible
  // failure on this screen.
  async function refreshAfterMove() {
    setCommitError(null);
    await fetchPreview(resolutions);
  }

  const commitDisabled = committing || !preview.mergeable || !author.trim();
  const disabledReason = !preview.mergeable
    ? `cannot merge: ${preview.blockedBy}`
    : !author.trim()
      ? 'your name is required'
      : undefined;

  return (
    <div>
      <div
        className="card"
        style={{ position: 'sticky', top: '1rem', zIndex: 1, marginBottom: '1.5rem', display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}
      >
        {previewing && <span className="text-dim">Updating preview…</span>}
        <input placeholder="your name" value={author} onChange={(e) => setAuthor(e.target.value)} style={{ width: '9rem' }} />
        <button type="button" className="btn btn-primary" disabled={commitDisabled} onClick={commit} title={disabledReason}>
          {committing ? 'Merging…' : `Merge ${preview.source.name} into ${preview.target.name}`}
        </button>
      </div>

      {commitError && (
        <Toast
          message={commitError.message}
          action={commitError.branchMoved ? { label: 'Refresh', onClick: refreshAfterMove } : undefined}
          onDismiss={() => setCommitError(null)}
        />
      )}

      {preview.conflicts.length > 0 && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.05rem' }}>
            {preview.conflicts.length} conflict{preview.conflicts.length === 1 ? '' : 's'}
          </h2>
          {preview.conflicts.map((conflict) => (
            <ConflictCard
              key={conflict.id}
              conflict={conflict}
              oursLabel={preview.target.name}
              theirsLabel={preview.source.name}
              resolution={resolutions.find((r) => r.conflictId === conflict.id)}
              onResolve={resolve}
            />
          ))}
        </section>
      )}

      <HazardList hazards={preview.hazards} oursLabel={preview.target.name} theirsLabel={preview.source.name} />

      <MigrationPreview statements={preview.statements} sql={preview.sql} />
    </div>
  );
}
