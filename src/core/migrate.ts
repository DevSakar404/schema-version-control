import { diff, type Change } from './diff';
import { classifyChange, type Safety } from './safety';
import { occupiedKey, orderRenames, type RenameStep } from './renames';
import { namerFor, renderChange, renderRename, type RenderContext } from './dialects/postgres';
import type { Column, Schema } from './schema';

/**
 * Migration planning (design.md §9).
 *
 * The merged schema answers an academic question. The migration answers the
 * user's actual question: what do I run on Monday.
 */
export interface Statement {
  id: string;
  /** The change this statement carries out. Renames may be synthesised. */
  op: Change | { kind: 'rename_step'; step: RenameStep };
  sql: string;
  safety: Safety;
  /** Why it carries that classification. Rendered beside the badge. */
  note: string | null;
}

/**
 * Fixed dependency phases, not a topological sort over statements.
 *
 * A graph sort looks like the right tool until you notice foreign keys can be
 * legitimately circular — users.org_id -> orgs.id alongside orgs.owner_id ->
 * users.id — and a topological sort has no answer for a cycle. Separating
 * table creation from foreign key creation into different phases makes the
 * ordering immune to cycles by construction.
 *
 * Renames sit at phase 3, ahead of every creation. Putting creates first
 * breaks on ordinary name reuse: renaming `users` to `accounts` and then
 * creating a new `users` is a valid end state reached by an invalid path.
 * Ordering *within* the rename phase is its own problem — see renames.ts.
 */
const PHASE = {
  dropIndex: 0,
  dropForeignKey: 1,
  dropConstraint: 2,
  rename: 3,
  createTable: 4,
  addColumn: 5,
  retype: 6,
  alterColumn: 7,
  addConstraint: 8,
  addForeignKey: 9,
  addIndex: 10,
  dropColumn: 11,
  dropTable: 12,
} as const;

function phaseOf(change: Change): number {
  switch (change.kind) {
    case 'index_dropped':
      return PHASE.dropIndex;
    case 'index_changed':
      return PHASE.addIndex;
    case 'constraint_dropped':
      return PHASE.dropConstraint;
    case 'constraint_changed':
      return PHASE.addConstraint;
    case 'table_renamed':
    case 'column_renamed':
      return PHASE.rename;
    case 'table_created':
      return PHASE.createTable;
    case 'column_added':
      return PHASE.addColumn;
    case 'column_retyped':
      return PHASE.retype;
    case 'column_nullability_changed':
    case 'column_default_changed':
      return PHASE.alterColumn;
    case 'constraint_added':
      return change.constraint.kind === 'foreign_key' ? PHASE.addForeignKey : PHASE.addConstraint;
    case 'index_added':
      return PHASE.addIndex;
    case 'column_dropped':
      return PHASE.dropColumn;
    case 'table_dropped':
      return PHASE.dropTable;
  }
}

export function plan(from: Schema, to: Schema): Statement[] {
  const changes = diff(from, to);
  const namer = namerFor(from, to);

  const createdTableIds = new Set(
    changes.filter((c) => c.kind === 'table_created').map((c) => c.tableId),
  );

  // Columns of a brand-new table are inlined into its CREATE TABLE rather
  // than emitted as separate ALTERs.
  const newTableColumns = new Map<string, Column[]>();
  for (const tableId of createdTableIds) {
    const table = to.tables.find((t) => t.id === tableId);
    if (table) newTableColumns.set(tableId, table.columns);
  }

  const ctx: RenderContext = { namer, schemas: [to, from], newTableColumns };

  const renameSteps = toRenameSteps(changes, from);
  const ordered = orderRenames(renameSteps, occupiedNames(from, to));

  const statements: Statement[] = [];

  // Phase 3 — renames, ordered and cycle-broken.
  for (const [index, step] of ordered.entries()) {
    statements.push({
      id: `rename-${index}`,
      op: { kind: 'rename_step', step },
      sql: renderRename(step, namer),
      safety: 'safe',
      note: step.temporary
        ? 'Temporary name. Two entities are swapping names, which has no valid two-statement ordering, so one moves aside first.'
        : null,
    });
  }

  const remaining = changes.filter(
    (c) =>
      c.kind !== 'table_renamed' &&
      c.kind !== 'column_renamed' &&
      // already inlined into CREATE TABLE
      !(c.kind === 'column_added' && createdTableIds.has(c.tableId)),
  );

  const sorted = [...remaining].sort((a, b) => phaseOf(a) - phaseOf(b));
  const beforeRename = sorted.filter((c) => phaseOf(c) < PHASE.rename);
  const afterRename = sorted.filter((c) => phaseOf(c) > PHASE.rename);

  const build = (change: Change, index: number): Statement => {
    const { safety, note } = classifyChange(change);
    return { id: `stmt-${index}`, op: change, sql: renderChange(change, ctx), safety, note };
  };

  return [
    ...beforeRename.map((c, i) => build(c, i)),
    ...statements,
    ...afterRename.map((c, i) => build(c, i + beforeRename.length)),
  ];
}

/** Renames pulled out of the change list, tagged with the scope their name lives in. */
function toRenameSteps(changes: Change[], from: Schema): RenameStep[] {
  const steps: RenameStep[] = [];
  for (const change of changes) {
    if (change.kind === 'table_renamed') {
      steps.push({ entityId: change.tableId, scope: 'table', from: change.from, to: change.to });
    }
    if (change.kind === 'column_renamed') {
      steps.push({
        entityId: change.columnId,
        scope: change.tableId,
        from: change.from,
        to: change.to,
      });
    }
  }
  return steps.filter((s) => scopeExists(s, from));
}

function scopeExists(step: RenameStep, from: Schema): boolean {
  return step.scope === 'table' || from.tables.some((t) => t.id === step.scope);
}

/** Every name live in either schema, so a generated temporary cannot collide. */
function occupiedNames(from: Schema, to: Schema): Set<string> {
  const names = new Set<string>();
  for (const schema of [from, to]) {
    for (const table of schema.tables) {
      names.add(occupiedKey('table', table.name));
      for (const column of table.columns) names.add(occupiedKey(table.id, column.name));
    }
  }
  return names;
}

/** The full migration as copy-pasteable SQL, grouped with safety comments. */
export function renderMigration(statements: Statement[]): string {
  return statements
    .map((s) => (s.safety === 'safe' ? s.sql : `-- ${s.safety.toUpperCase()}: ${s.note ?? ''}\n${s.sql}`))
    .join('\n\n');
}
