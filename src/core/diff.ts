import type { Id } from './ids';
import {
  sameType,
  type Column,
  type ColumnType,
  type Constraint,
  type Index,
  type Schema,
  type Table,
} from './schema';

/**
 * Structural diff (design.md §6).
 *
 * Entities are matched by id, never by name — which is what makes a rename a
 * rename rather than a drop plus an add.
 *
 * One entity modified in two ways produces two changes. That is not cosmetic:
 * it sets the granularity of conflict detection, so two people editing
 * different attributes of the same column merge cleanly (§6.1).
 */
export type Change =
  | { kind: 'table_created'; tableId: Id; name: string }
  | { kind: 'table_dropped'; tableId: Id; name: string }
  | { kind: 'table_renamed'; tableId: Id; from: string; to: string }
  | { kind: 'column_added'; tableId: Id; columnId: Id; column: Column }
  | { kind: 'column_dropped'; tableId: Id; columnId: Id; name: string }
  | { kind: 'column_renamed'; tableId: Id; columnId: Id; from: string; to: string }
  | { kind: 'column_retyped'; tableId: Id; columnId: Id; from: ColumnType; to: ColumnType }
  | { kind: 'column_nullability_changed'; tableId: Id; columnId: Id; from: boolean; to: boolean }
  | { kind: 'column_default_changed'; tableId: Id; columnId: Id; from: string | null; to: string | null }
  | { kind: 'constraint_added'; constraintId: Id; constraint: Constraint }
  | { kind: 'constraint_dropped'; constraintId: Id; name: string }
  | { kind: 'constraint_changed'; constraintId: Id; from: Constraint; to: Constraint }
  | { kind: 'index_added'; indexId: Id; index: Index }
  | { kind: 'index_dropped'; indexId: Id; name: string }
  | { kind: 'index_changed'; indexId: Id; from: Index; to: Index };

/** The entity a change is about. Merge keys on this. */
export function subjectOf(change: Change): Id {
  if ('columnId' in change) return change.columnId;
  if ('constraintId' in change) return change.constraintId;
  if ('indexId' in change) return change.indexId;
  return change.tableId;
}

/**
 * Which attribute a change touches. `__exists` covers creation and deletion.
 * Merge pairs changes by (subject, attribute), so two edits to different
 * attributes of one entity never collide.
 */
export function attributeOf(change: Change): string {
  switch (change.kind) {
    case 'table_created':
    case 'table_dropped':
    case 'column_added':
    case 'column_dropped':
    case 'constraint_added':
    case 'constraint_dropped':
    case 'index_added':
    case 'index_dropped':
      return '__exists';
    case 'table_renamed':
    case 'column_renamed':
      return 'name';
    case 'column_retyped':
      return 'type';
    case 'column_nullability_changed':
      return 'nullable';
    case 'column_default_changed':
      return 'default';
    case 'constraint_changed':
    case 'index_changed':
      return 'definition';
  }
}

export function diff(a: Schema, b: Schema): Change[] {
  return [...diffTables(a, b), ...diffConstraints(a, b), ...diffIndexes(a, b)];
}

function diffTables(a: Schema, b: Schema): Change[] {
  const changes: Change[] = [];
  const before = byId(a.tables);
  const after = byId(b.tables);

  for (const table of b.tables) {
    const prior = before.get(table.id);
    if (!prior) {
      // A created table reports itself plus its columns; a dropped one reports
      // only itself, since its columns went with it.
      changes.push({ kind: 'table_created', tableId: table.id, name: table.name });
      for (const column of table.columns) {
        changes.push({ kind: 'column_added', tableId: table.id, columnId: column.id, column });
      }
      continue;
    }
    if (prior.name !== table.name) {
      changes.push({ kind: 'table_renamed', tableId: table.id, from: prior.name, to: table.name });
    }
    changes.push(...diffColumns(prior, table));
  }

  for (const table of a.tables) {
    if (!after.has(table.id)) {
      changes.push({ kind: 'table_dropped', tableId: table.id, name: table.name });
    }
  }

  return changes;
}

function diffColumns(before: Table, after: Table): Change[] {
  const changes: Change[] = [];
  const prior = byId(before.columns);
  const current = byId(after.columns);

  for (const column of after.columns) {
    const was = prior.get(column.id);
    if (!was) {
      changes.push({ kind: 'column_added', tableId: after.id, columnId: column.id, column });
      continue;
    }
    const at = { tableId: after.id, columnId: column.id };
    if (was.name !== column.name) {
      changes.push({ kind: 'column_renamed', ...at, from: was.name, to: column.name });
    }
    if (!sameType(was.type, column.type)) {
      changes.push({ kind: 'column_retyped', ...at, from: was.type, to: column.type });
    }
    if (was.nullable !== column.nullable) {
      changes.push({ kind: 'column_nullability_changed', ...at, from: was.nullable, to: column.nullable });
    }
    if (was.default !== column.default) {
      changes.push({ kind: 'column_default_changed', ...at, from: was.default, to: column.default });
    }
  }

  for (const column of before.columns) {
    if (!current.has(column.id)) {
      changes.push({ kind: 'column_dropped', tableId: after.id, columnId: column.id, name: column.name });
    }
  }

  return changes;
}

function diffConstraints(a: Schema, b: Schema): Change[] {
  const changes: Change[] = [];
  const before = byId(a.constraints);
  const after = byId(b.constraints);

  for (const constraint of b.constraints) {
    const was = before.get(constraint.id);
    if (!was) {
      changes.push({ kind: 'constraint_added', constraintId: constraint.id, constraint });
    } else if (!deepEqual(was, constraint)) {
      changes.push({ kind: 'constraint_changed', constraintId: constraint.id, from: was, to: constraint });
    }
  }
  for (const constraint of a.constraints) {
    if (!after.has(constraint.id)) {
      changes.push({ kind: 'constraint_dropped', constraintId: constraint.id, name: constraint.name });
    }
  }
  return changes;
}

function diffIndexes(a: Schema, b: Schema): Change[] {
  const changes: Change[] = [];
  const before = byId(a.indexes);
  const after = byId(b.indexes);

  for (const index of b.indexes) {
    const was = before.get(index.id);
    if (!was) {
      changes.push({ kind: 'index_added', indexId: index.id, index });
    } else if (!deepEqual(was, index)) {
      changes.push({ kind: 'index_changed', indexId: index.id, from: was, to: index });
    }
  }
  for (const index of a.indexes) {
    if (!after.has(index.id)) {
      changes.push({ kind: 'index_dropped', indexId: index.id, name: index.name });
    }
  }
  return changes;
}

/** Plain-language rendering. These strings go straight into the UI. */
export function describeChange(change: Change): string {
  switch (change.kind) {
    case 'table_created':
      return `Created table \`${change.name}\``;
    case 'table_dropped':
      return `Dropped table \`${change.name}\``;
    case 'table_renamed':
      return `Renamed table \`${change.from}\` → \`${change.to}\``;
    case 'column_added':
      return `Added column \`${change.column.name}\` (${describeType(change.column.type)})`;
    case 'column_dropped':
      return `Dropped column \`${change.name}\``;
    case 'column_renamed':
      return `Renamed column \`${change.from}\` → \`${change.to}\``;
    case 'column_retyped':
      return `Changed type of \`${change.columnId}\` from ${describeType(change.from)} to ${describeType(change.to)}`;
    case 'column_nullability_changed':
      return change.to ? 'Made column nullable' : 'Made column NOT NULL';
    case 'column_default_changed':
      return change.to === null ? 'Removed default' : `Set default to \`${change.to}\``;
    case 'constraint_added':
      return `Added ${change.constraint.kind.replace('_', ' ')} \`${change.constraint.name}\``;
    case 'constraint_dropped':
      return `Dropped constraint \`${change.name}\``;
    case 'constraint_changed':
      return `Changed ${change.to.kind.replace('_', ' ')} \`${change.to.name}\``;
    case 'index_added':
      return `Added index \`${change.index.name}\``;
    case 'index_dropped':
      return `Dropped index \`${change.name}\``;
    case 'index_changed':
      return `Changed index \`${change.to.name}\``;
  }
}

export function describeType(type: ColumnType): string {
  if (type.kind === 'varchar') return `varchar(${type.length})`;
  if (type.kind === 'numeric') return `numeric(${type.precision},${type.scale})`;
  return type.kind;
}

function byId<T extends { id: Id }>(items: T[]): Map<Id, T> {
  return new Map(items.map((i) => [i.id, i]));
}

/** Structural equality over plain JSON-shaped values. */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
