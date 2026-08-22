import { createProject } from '@/db/projects';
import { insertCommit } from '@/db/commits';
import { createBranch } from '@/db/branches';
import { applyOps, type SchemaOp } from '@/core/ops';
import { emptySchema, type Schema } from '@/core/schema';
import { counterIdGen, nanoIdGen, type Id } from '@/core/ids';
import type { Commit } from '@/core/history';

/** users(id, email) with a primary key — stable ids s1/s2/s3, k1. */
export function seedSchema(): Schema {
  const next = counterIdGen('s');
  let schema = applyOps(emptySchema(), [{ kind: 'create_table', name: 'users' }], next);
  schema = applyOps(schema, [
    { kind: 'add_column', tableId: 's1', name: 'id', type: { kind: 'int' }, nullable: false, default: null },
    { kind: 'add_column', tableId: 's1', name: 'email', type: { kind: 'varchar', length: 255 }, nullable: false, default: null },
  ], next);
  return applyOps(schema, [
    { kind: 'add_constraint', constraint: { name: 'users_pkey', tableId: 's1', kind: 'primary_key', columnIds: ['s2'] } },
  ], counterIdGen('k'));
}

export interface Seeded {
  projectId: Id;
  rootCommitId: Id;
  mainBranchId: Id;
  branch: (name: string, ops: SchemaOp[]) => Promise<{ id: Id; headCommitId: Id }>;
}

/** A project on `main` at a root commit, plus a helper to fork a branch with edits. */
export async function seedProject(): Promise<Seeded> {
  const projectId = `test_${nanoIdGen()}`;
  await createProject('api fixture', projectId);

  const root: Commit = {
    id: nanoIdGen(), projectId, parentIds: [],
    schema: seedSchema(), message: 'initial schema', author: 'seed',
    createdAt: new Date().toISOString(),
  };
  await insertCommit(root);
  const main = await createBranch(projectId, 'main', root.id);

  return {
    projectId,
    rootCommitId: root.id,
    mainBranchId: main.id,
    async branch(name, ops) {
      const commit: Commit = {
        id: nanoIdGen(), projectId, parentIds: [root.id],
        schema: applyOps(root.schema, ops, nanoIdGen),
        message: `${name} changes`, author: name,
        createdAt: new Date().toISOString(),
      };
      await insertCommit(commit);
      const created = await createBranch(projectId, name, commit.id);
      return { id: created.id, headCommitId: commit.id };
    },
  };
}
