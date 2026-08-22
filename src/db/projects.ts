import { db, expectRow } from './client';
import { nanoIdGen } from '../core/ids';
import type { Id } from '../core/ids';

export interface ProjectRow {
  id: Id;
  name: string;
  createdAt: string;
}

export async function createProject(name: string, id: Id = nanoIdGen()): Promise<ProjectRow> {
  const [row] = await db()`
    insert into projects (id, name) values (${id}, ${name})
    returning id, name, created_at
  `;
  return toProject(expectRow(row, 'insert into projects'));
}

export async function getProject(id: Id): Promise<ProjectRow | null> {
  const [row] = await db()`select id, name, created_at from projects where id = ${id}`;
  return row ? toProject(row) : null;
}

export async function listProjects(): Promise<ProjectRow[]> {
  const rows = await db()`select id, name, created_at from projects order by created_at`;
  return rows.map(toProject);
}

function toProject(row: Record<string, unknown>): ProjectRow {
  return {
    id: row.id as Id,
    name: row.name as string,
    createdAt: (row.created_at as Date).toISOString(),
  };
}
