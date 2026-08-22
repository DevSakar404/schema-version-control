import { db, expectRow } from './client';
import { nanoIdGen } from '../core/ids';
import type { Id } from '../core/ids';

export interface BranchRow {
  id: Id;
  projectId: Id;
  name: string;
  headCommitId: Id;
  createdAt: string;
}

export async function listBranches(projectId: Id): Promise<BranchRow[]> {
  const rows = await db()`
    select id, project_id, name, head_commit_id, created_at
    from branches where project_id = ${projectId} order by created_at
  `;
  return rows.map(toBranch);
}

export async function getBranch(id: Id): Promise<BranchRow | null> {
  const [row] = await db()`
    select id, project_id, name, head_commit_id, created_at from branches where id = ${id}
  `;
  return row ? toBranch(row) : null;
}

export async function createBranch(
  projectId: Id,
  name: string,
  headCommitId: Id,
  id: Id = nanoIdGen(),
): Promise<BranchRow> {
  const [row] = await db()`
    insert into branches (id, project_id, name, head_commit_id)
    values (${id}, ${projectId}, ${name}, ${headCommitId})
    returning id, project_id, name, head_commit_id, created_at
  `;
  return toBranch(expectRow(row, 'insert into branches'));
}

/**
 * Advance a branch head by compare-and-swap (design.md §10.1).
 *
 * Returns null when `expected` no longer matches, meaning someone else moved
 * the branch between preview and commit. Never read-then-write: the premise of
 * this product is a team sharing a database, so two people merging into main
 * at once is routine, and last-write-wins would silently discard a merge —
 * an unusually embarrassing bug for a version control system.
 */
export async function advanceHead(
  branchId: Id,
  expected: Id,
  next: Id,
): Promise<BranchRow | null> {
  const [row] = await db()`
    update branches set head_commit_id = ${next}
    where id = ${branchId} and head_commit_id = ${expected}
    returning id, project_id, name, head_commit_id, created_at
  `;
  return row ? toBranch(row) : null;
}

function toBranch(row: Record<string, unknown>): BranchRow {
  return {
    id: row.id as Id,
    projectId: row.project_id as Id,
    name: row.name as string,
    headCommitId: row.head_commit_id as Id,
    createdAt: (row.created_at as Date).toISOString(),
  };
}
