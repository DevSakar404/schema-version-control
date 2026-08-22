import { db } from './client';
import type { Id } from '../core/ids';
import type { Commit } from '../core/history';
import type { Schema } from '../core/schema';

/**
 * Commits are append-only. There is deliberately no update and no delete —
 * history that can be rewritten is not history.
 */
export async function insertCommit(commit: Commit): Promise<Commit> {
  await db()`
    insert into commits (id, project_id, parent_ids, "schema", message, author)
    values (
      ${commit.id}, ${commit.projectId}, ${commit.parentIds},
      ${db().json(commit.schema as never)}, ${commit.message}, ${commit.author}
    )
  `;
  return commit;
}

export async function getCommit(id: Id): Promise<Commit | null> {
  const [row] = await db()`
    select id, project_id, parent_ids, "schema", message, author, created_at
    from commits where id = ${id}
  `;
  return row ? toCommit(row) : null;
}

/** Every commit in a project, keyed by id — the graph merge-base walks over. */
export async function getCommitGraph(projectId: Id): Promise<Map<Id, Commit>> {
  const rows = await db()`
    select id, project_id, parent_ids, "schema", message, author, created_at
    from commits where project_id = ${projectId}
  `;
  return new Map(rows.map((row) => [row.id as Id, toCommit(row)]));
}

function toCommit(row: Record<string, unknown>): Commit {
  return {
    id: row.id as Id,
    projectId: row.project_id as Id,
    parentIds: row.parent_ids as Id[],
    schema: row.schema as Schema,
    message: row.message as string,
    author: row.author as string,
    createdAt: (row.created_at as Date).toISOString(),
  };
}
