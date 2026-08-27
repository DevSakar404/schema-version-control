'use client';

/**
 * Compare or merge a branch against any other branch, not only `main`.
 *
 * The original version hardcoded every action against the default branch,
 * which is the common case but not the only one — two people picking up
 * each other's in-progress work, or (as the seeded demo needs) two sibling
 * branches that only conflict against EACH OTHER, never individually
 * against a `main` neither has touched yet. Defaults to `main` since that
 * is still the common case, but the picker makes any pair reachable.
 */

import { useState } from 'react';
import Link from 'next/link';

interface BranchOption {
  id: string;
  name: string;
}

export function BranchActions({
  projectId,
  branch,
  others,
  defaultAgainstId,
}: {
  projectId: string;
  branch: BranchOption;
  others: BranchOption[];
  defaultAgainstId: string;
}) {
  const [againstId, setAgainstId] = useState(defaultAgainstId);

  return (
    <span style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}>
      <span className="text-dim" style={{ fontSize: '0.8rem' }}>vs</span>
      <select
        value={againstId}
        onChange={(e) => setAgainstId(e.target.value)}
        style={{ fontSize: '0.8rem', width: '9rem', textOverflow: 'ellipsis' }}
      >
        {others.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
      <Link className="btn" href={`/p/${projectId}/compare?base=${againstId}&head=${branch.id}`}>
        Compare
      </Link>
      <Link className="btn btn-primary" href={`/p/${projectId}/merge?target=${againstId}&source=${branch.id}`}>
        Merge
      </Link>
    </span>
  );
}
