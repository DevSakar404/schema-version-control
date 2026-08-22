import { BadRequest, NotFound, Conflicted, Unprocessable } from './http';
import { getBranch, listBranches, advanceHead, createBranch } from '@/db/branches';
import { getCommit, getCommitGraph, insertCommit } from '@/db/commits';
import { getProject } from '@/db/projects';
import { aheadBehind, findMergeBase, type Commit } from '@/core/history';
import { threeWayMerge, type Resolution, type MergeResult } from '@/core/merge';
import { plan, renderMigration, type Statement } from '@/core/migrate';
import { diff, tableOf, type Change } from '@/core/diff';
import { validate } from '@/core/validate';
import { applyOps, type SchemaOp } from '@/core/ops';
import { nanoIdGen, type Id } from '@/core/ids';
import type { Schema } from '@/core/schema';

const DEFAULT_BRANCH = 'main';

export interface BranchSummary {
  id: Id;
  name: string;
  headCommitId: Id;
  ahead: number;
  behind: number;
  isDefault: boolean;
  lastMessage: string;
  lastAuthor: string;
  updatedAt: string;
}

export async function getProjectOverview(projectId: Id) {
  const project = await getProject(projectId);
  if (!project) throw new NotFound(`project '${projectId}' does not exist`);

  const [branches, graph] = await Promise.all([
    listBranches(projectId),
    getCommitGraph(projectId),
  ]);
  const main = branches.find((b) => b.name === DEFAULT_BRANCH);

  const summaries: BranchSummary[] = branches.map((branch) => {
    const head = graph.get(branch.headCommitId);
    const counts = main
      ? aheadBehind(graph, branch.headCommitId, main.headCommitId)
      : { ahead: 0, behind: 0 };
    return {
      id: branch.id,
      name: branch.name,
      headCommitId: branch.headCommitId,
      ...counts,
      isDefault: branch.name === DEFAULT_BRANCH,
      lastMessage: head?.message ?? '',
      lastAuthor: head?.author ?? '',
      updatedAt: head?.createdAt ?? branch.createdAt,
    };
  });

  return { project, branches: summaries };
}

export async function getBranchSchema(branchId: Id): Promise<{ schema: Schema; headCommitId: Id }> {
  const branch = await getBranch(branchId);
  if (!branch) throw new NotFound(`branch '${branchId}' does not exist`);
  const head = await getCommit(branch.headCommitId);
  if (!head) throw new NotFound(`commit '${branch.headCommitId}' does not exist`);
  return { schema: head.schema, headCommitId: head.id };
}

export async function branchFrom(projectId: Id, name: string, fromCommitId: Id) {
  const source = await getCommit(fromCommitId);
  if (!source) throw new NotFound(`commit '${fromCommitId}' does not exist`);

  try {
    return await createBranch(projectId, name, fromCommitId);
  } catch (e) {
    // No pre-check SELECT — that's a race (two people naming a branch at the
    // same moment) waiting to happen. Attempt the insert and translate the
    // unique (project_id, name) violation the database already enforces.
    if (isUniqueViolation(e)) {
      throw new BadRequest(`a branch named '${name}' already exists in this project`);
    }
    throw e;
  }
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === '23505';
}

/**
 * Commit a batch of operations to a branch.
 *
 * Refuses to write a schema that would be invalid, so a branch cannot quietly
 * accumulate a broken state that only surfaces at merge time.
 */
export async function commitOps(
  branchId: Id,
  ops: SchemaOp[],
  message: string,
  author: string,
  expectedHead: Id,
) {
  const branch = await getBranch(branchId);
  if (!branch) throw new NotFound(`branch '${branchId}' does not exist`);

  const head = await getCommit(branch.headCommitId);
  if (!head) throw new NotFound(`commit '${branch.headCommitId}' does not exist`);
  if (head.id !== expectedHead) {
    throw new Conflicted('this branch has moved since you loaded it', {
      expectedHead,
      actualHead: head.id,
    });
  }

  const next = applyOps(head.schema, ops, nanoIdGen);
  const errors = validate(next).filter((h) => h.severity === 'error');
  if (errors.length) {
    throw new Unprocessable(
      'these changes would leave the schema invalid',
      'invalid_schema',
      { hazards: errors },
    );
  }

  const commit: Commit = {
    id: nanoIdGen(),
    projectId: branch.projectId,
    parentIds: [head.id],
    schema: next,
    message,
    author,
    createdAt: new Date().toISOString(),
  };
  await insertCommit(commit);

  const moved = await advanceHead(branch.id, head.id, commit.id);
  if (!moved) {
    throw new Conflicted('this branch moved while the commit was being written', {
      expectedHead: head.id,
    });
  }
  // The schema is large and the caller already has it; return metadata only.
  const { schema: _schema, ...meta } = commit;
  return { commit: meta, headCommitId: commit.id };
}

export interface CompareGroup {
  table: { id: Id; name: string } | null;
  changes: Change[];
}

export interface CompareResult {
  changes: Change[];
  groups: CompareGroup[];
  /** Exposed so a server-rendered view can resolve column/table display
   *  names via describeChange(change, headSchema) — see design.md §6.1. */
  headSchema: Schema;
}

export async function compareBranches(baseBranchId: Id, headBranchId: Id): Promise<CompareResult> {
  const [left, right] = await Promise.all([
    getBranchSchema(baseBranchId),
    getBranchSchema(headBranchId),
  ]);
  const changes = diff(left.schema, right.schema);
  return { changes, groups: groupByTable(changes, left.schema, right.schema), headSchema: right.schema };
}

/**
 * Group changes by table, in first-appearance order, so the diff view reads
 * top to bottom the way a person would scan the schema rather than jumping
 * around by change kind.
 */
function groupByTable(changes: Change[], base: Schema, head: Schema): CompareGroup[] {
  const order: (Id | null)[] = [];
  const byTable = new Map<Id | null, CompareGroup>();

  for (const change of changes) {
    const table = tableOf(change, base, head) ?? null;
    const key = table?.id ?? null;
    if (!byTable.has(key)) {
      byTable.set(key, { table, changes: [] });
      order.push(key);
    }
    byTable.get(key)!.changes.push(change);
  }

  return order.map((key) => byTable.get(key)!);
}

export interface MergePreview extends MergeResult {
  base: { commitId: Id | null };
  target: { branchId: Id; name: string; headCommitId: Id };
  source: { branchId: Id; name: string; headCommitId: Id };
  statements: Statement[];
  sql: string;
  mergeable: boolean;
  blockedBy: string | null;
}

/**
 * Compute a merge without writing anything.
 *
 * Read-only by design: the conflict screen re-posts on every resolution the
 * user changes, so this must be free of write risk.
 */
export async function previewMerge(
  targetBranchId: Id,
  sourceBranchId: Id,
  resolutions: Resolution[],
): Promise<MergePreview> {
  const [target, source] = await Promise.all([getBranch(targetBranchId), getBranch(sourceBranchId)]);
  if (!target) throw new NotFound(`branch '${targetBranchId}' does not exist`);
  if (!source) throw new NotFound(`branch '${sourceBranchId}' does not exist`);

  const graph = await getCommitGraph(target.projectId);
  const baseId = findMergeBase(graph, target.headCommitId, source.headCommitId);

  const targetSchema = graph.get(target.headCommitId)?.schema;
  const sourceSchema = graph.get(source.headCommitId)?.schema;
  if (!targetSchema || !sourceSchema) throw new NotFound('branch head commit is missing');
  const baseSchema = baseId ? graph.get(baseId)?.schema : undefined;
  if (!baseSchema) {
    throw new Unprocessable(
      'these branches share no common history, so there is nothing to merge against',
      'no_merge_base',
    );
  }

  const result = threeWayMerge(baseSchema, targetSchema, sourceSchema, resolutions, {
    oursLabel: target.name,
    theirsLabel: source.name,
  });

  const statements = plan(targetSchema, result.schema);
  const errorHazards = result.hazards.filter((h) => h.severity === 'error');
  const blockedBy = result.conflicts.length
    ? `${result.conflicts.length} unresolved conflict${result.conflicts.length === 1 ? '' : 's'}`
    : errorHazards.length
      ? `${errorHazards.length} blocking hazard${errorHazards.length === 1 ? '' : 's'}`
      : null;

  return {
    ...result,
    base: { commitId: baseId },
    target: { branchId: target.id, name: target.name, headCommitId: target.headCommitId },
    source: { branchId: source.id, name: source.name, headCommitId: source.headCommitId },
    statements,
    sql: renderMigration(statements),
    mergeable: blockedBy === null,
    blockedBy,
  };
}

/** Commit a merge. Refuses unless the preview says it is mergeable. */
export async function performMerge(
  targetBranchId: Id,
  sourceBranchId: Id,
  resolutions: Resolution[],
  expectedHead: Id,
  author: string,
) {
  const preview = await previewMerge(targetBranchId, sourceBranchId, resolutions);

  if (preview.target.headCommitId !== expectedHead) {
    throw new Conflicted('this branch has moved since you previewed the merge', {
      expectedHead,
      actualHead: preview.target.headCommitId,
    });
  }
  if (!preview.mergeable) {
    throw new Unprocessable(`cannot merge: ${preview.blockedBy}`, 'not_mergeable', {
      conflicts: preview.conflicts,
      hazards: preview.hazards.filter((h) => h.severity === 'error'),
    });
  }

  const target = await getBranch(targetBranchId);
  if (!target) throw new NotFound(`branch '${targetBranchId}' does not exist`);

  const commit: Commit = {
    id: nanoIdGen(),
    projectId: target.projectId,
    parentIds: [preview.target.headCommitId, preview.source.headCommitId],
    schema: preview.schema,
    message: `Merge ${preview.source.name} into ${preview.target.name}`,
    author,
    createdAt: new Date().toISOString(),
  };
  await insertCommit(commit);

  // The compare-and-swap is what makes two people merging into main at once
  // safe. Losing here means someone else got there first.
  const moved = await advanceHead(target.id, expectedHead, commit.id);
  if (!moved) {
    throw new Conflicted('another merge landed while this one was being written', {
      expectedHead,
    });
  }

  return {
    commitId: commit.id,
    headCommitId: commit.id,
    statements: preview.statements,
    sql: preview.sql,
  };
}
