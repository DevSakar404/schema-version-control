import type { Id } from './ids';
import type { Schema } from './schema';

/**
 * Commit history (design.md §5).
 *
 * Commits store complete schema snapshots, not operation deltas. The usual
 * argument for an operation log is that snapshots lose intent — you cannot
 * tell a rename from a drop-plus-add. Stable ids already preserve that intent,
 * so the argument does not apply, and snapshots make every read O(1) with no
 * replay machinery. Schemas are kilobytes.
 */
export interface Commit {
  id: Id;
  projectId: Id;
  /** 0 for the root, 1 for an ordinary commit, 2 for a merge. */
  parentIds: Id[];
  schema: Schema;
  message: string;
  author: string;
  createdAt: string;
}

export type CommitGraph = ReadonlyMap<Id, Commit>;

/** Every ancestor of `id`, including `id` itself. */
export function ancestorsOf(commits: CommitGraph, id: Id): Set<Id> {
  const seen = new Set<Id>();
  const queue = [id];
  while (queue.length) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const parent of commits.get(current)?.parentIds ?? []) queue.push(parent);
  }
  return seen;
}

/**
 * The best common ancestor of two commits, or null if they are unrelated.
 *
 * "Best" means a common ancestor that is not itself an ancestor of another
 * common ancestor — otherwise a fork would resolve to the root rather than the
 * fork point. A criss-cross history has several equally valid candidates; one
 * is chosen deterministically, which is enough here and matches what a real
 * three-way merge does in that situation.
 *
 * ponytail: quadratic in history size. Histories are tens of commits; if that
 * changes, generation numbers or a bitmap index are the upgrade path.
 */
export function findMergeBase(commits: CommitGraph, a: Id, b: Id): Id | null {
  const left = ancestorsOf(commits, a);
  const right = ancestorsOf(commits, b);
  const common = [...left].filter((id) => right.has(id));
  if (common.length === 0) return null;

  const shadowed = new Set<Id>();
  for (const candidate of common) {
    for (const other of ancestorsOf(commits, candidate)) {
      if (other !== candidate && common.includes(other)) shadowed.add(other);
    }
  }
  const best = common.filter((id) => !shadowed.has(id));

  // Sorted so a criss-cross resolves the same way on every run — an unstable
  // merge base would make merge results non-reproducible.
  return best.sort()[0] ?? common.sort()[0] ?? null;
}

/** How far each side has moved since they diverged. */
export function aheadBehind(
  commits: CommitGraph,
  branchHead: Id,
  compareTo: Id,
): { ahead: number; behind: number } {
  const mine = ancestorsOf(commits, branchHead);
  const theirs = ancestorsOf(commits, compareTo);
  return {
    ahead: [...mine].filter((id) => !theirs.has(id)).length,
    behind: [...theirs].filter((id) => !mine.has(id)).length,
  };
}
