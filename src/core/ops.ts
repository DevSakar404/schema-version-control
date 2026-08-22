import type { IdGen, Id } from './ids';
import {
  columnsReferencedBy,
  findColumn,
  findTable,
  type Column,
  type Constraint,
  type Index,
  type Schema,
} from './schema';

/**
 * Schema operations (design.md §4).
 *
 * Every operation is pure: it returns a new Schema and never mutates its
 * input. Id generation is injected so tests can assert on exact values.
 */

/**
 * Omit that distributes over a union.
 *
 * Plain `Omit<Constraint, 'id'>` collapses the four-member Constraint union
 * to its shared keys, silently dropping `columnIds` and `expression`. This
 * keeps each member intact.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A constraint before it has been assigned an id. */
export type ConstraintDraft = DistributiveOmit<Constraint, 'id'>;

/** The patchable surface of a constraint. */
export type ConstraintPatch = Partial<DistributiveOmit<Constraint, 'id' | 'kind' | 'tableId'>>;
export type SchemaOp =
  | { kind: 'create_table'; name: string }
  | { kind: 'drop_table'; tableId: Id }
  | { kind: 'rename_table'; tableId: Id; name: string }
  | {
      kind: 'add_column';
      tableId: Id;
      name: string;
      type: Column['type'];
      nullable: boolean;
      default: string | null;
    }
  | { kind: 'drop_column'; columnId: Id }
  | { kind: 'rename_column'; columnId: Id; name: string }
  | { kind: 'retype_column'; columnId: Id; type: Column['type'] }
  | { kind: 'set_column_nullable'; columnId: Id; nullable: boolean }
  | { kind: 'set_column_default'; columnId: Id; default: string | null }
  | { kind: 'add_constraint'; constraint: ConstraintDraft }
  | { kind: 'drop_constraint'; constraintId: Id }
  | {
      kind: 'alter_constraint';
      constraintId: Id;
      /** `kind` and `tableId` are not patchable — changing either makes it a
       *  different rule, and that is honestly a drop plus an add. */
      patch: ConstraintPatch;
    }
  | { kind: 'add_index'; index: Omit<Index, 'id'> }
  | { kind: 'drop_index'; indexId: Id }
  | { kind: 'alter_index'; indexId: Id; patch: Partial<Omit<Index, 'id' | 'tableId'>> };

class UnknownEntityError extends Error {
  constructor(kind: string, id: Id) {
    super(`${kind} '${id}' does not exist in this schema`);
    this.name = 'UnknownEntityError';
  }
}

export function applyOps(schema: Schema, ops: SchemaOp[], mintId: IdGen): Schema {
  return ops.reduce((s, op) => applyOp(s, op, mintId), schema);
}

export function applyOp(schema: Schema, op: SchemaOp, mintId: IdGen): Schema {
  switch (op.kind) {
    case 'create_table':
      return {
        ...schema,
        tables: [...schema.tables, { id: mintId(), name: op.name, columns: [] }],
      };

    case 'drop_table':
      requireTable(schema, op.tableId);
      return dropTable(schema, op.tableId);

    case 'rename_table':
      requireTable(schema, op.tableId);
      return mapTable(schema, op.tableId, (t) => ({ ...t, name: op.name }));

    case 'add_column': {
      requireTable(schema, op.tableId);
      const column: Column = {
        id: mintId(),
        name: op.name,
        type: op.type,
        nullable: op.nullable,
        default: op.default,
      };
      return mapTable(schema, op.tableId, (t) => ({ ...t, columns: [...t.columns, column] }));
    }

    case 'drop_column':
      requireColumn(schema, op.columnId);
      return dropColumn(schema, op.columnId);

    case 'rename_column':
      return mapColumn(schema, op.columnId, (c) => ({ ...c, name: op.name }));

    case 'retype_column':
      return mapColumn(schema, op.columnId, (c) => ({ ...c, type: op.type }));

    case 'set_column_nullable':
      return mapColumn(schema, op.columnId, (c) => ({ ...c, nullable: op.nullable }));

    case 'set_column_default':
      return mapColumn(schema, op.columnId, (c) => ({ ...c, default: op.default }));

    case 'add_constraint':
      return {
        ...schema,
        constraints: [...schema.constraints, { ...op.constraint, id: mintId() } as Constraint],
      };

    case 'drop_constraint':
      requireConstraint(schema, op.constraintId);
      return {
        ...schema,
        constraints: schema.constraints.filter((c) => c.id !== op.constraintId),
      };

    case 'alter_constraint': {
      requireConstraint(schema, op.constraintId);
      return {
        ...schema,
        constraints: schema.constraints.map((c) =>
          c.id === op.constraintId ? ({ ...c, ...op.patch } as Constraint) : c,
        ),
      };
    }

    case 'add_index':
      return { ...schema, indexes: [...schema.indexes, { ...op.index, id: mintId() }] };

    case 'drop_index':
      requireIndex(schema, op.indexId);
      return { ...schema, indexes: schema.indexes.filter((i) => i.id !== op.indexId) };

    case 'alter_index':
      requireIndex(schema, op.indexId);
      return {
        ...schema,
        indexes: schema.indexes.map((i) => (i.id === op.indexId ? { ...i, ...op.patch } : i)),
      };
  }
}

/* --------------------------------------------------------------- cascades */

/**
 * Deletion is the only place cascade logic is needed. Renames need none,
 * because constraints, indexes, and predicates reference columns by id.
 */
function dropTable(schema: Schema, tableId: Id): Schema {
  const table = findTable(schema, tableId)!;
  const droppedColumns = new Set(table.columns.map((c) => c.id));
  return {
    tables: schema.tables.filter((t) => t.id !== tableId),
    // Constraints on the table, and foreign keys pointing AT it from elsewhere.
    constraints: schema.constraints.filter(
      (c) =>
        c.tableId !== tableId &&
        !(c.kind === 'foreign_key' && c.referencedTableId === tableId) &&
        !columnsReferencedBy(c).some((id) => droppedColumns.has(id)),
    ),
    indexes: schema.indexes.filter(
      (i) => i.tableId !== tableId && !columnsReferencedBy(i).some((id) => droppedColumns.has(id)),
    ),
  };
}

function dropColumn(schema: Schema, columnId: Id): Schema {
  const withoutColumn: Schema = {
    ...schema,
    tables: schema.tables.map((t) => ({
      ...t,
      columns: t.columns.filter((c) => c.id !== columnId),
    })),
  };

  const constraints = withoutColumn.constraints.flatMap((c) => {
    if (!columnsReferencedBy(c).includes(columnId)) return [c];
    switch (c.kind) {
      // A predicate cannot be meaningfully pruned, and a foreign key's arity
      // must match its target, so both go entirely.
      case 'check':
      case 'foreign_key':
        return [];
      case 'primary_key':
      case 'unique': {
        const remaining = c.columnIds.filter((id) => id !== columnId);
        return remaining.length ? [{ ...c, columnIds: remaining }] : [];
      }
    }
  });

  const indexes = withoutColumn.indexes.flatMap((i) => {
    if (!columnsReferencedBy(i).includes(columnId)) return [i];
    if (i.where?.columnIds.includes(columnId)) return [];
    const remaining = i.columnIds.filter((id) => id !== columnId);
    return remaining.length ? [{ ...i, columnIds: remaining }] : [];
  });

  return { tables: withoutColumn.tables, constraints, indexes };
}

/* ---------------------------------------------------------------- helpers */

function mapTable(schema: Schema, tableId: Id, fn: (t: Schema['tables'][number]) => Schema['tables'][number]): Schema {
  return { ...schema, tables: schema.tables.map((t) => (t.id === tableId ? fn(t) : t)) };
}

function mapColumn(schema: Schema, columnId: Id, fn: (c: Column) => Column): Schema {
  requireColumn(schema, columnId);
  return {
    ...schema,
    tables: schema.tables.map((t) => ({
      ...t,
      columns: t.columns.map((c) => (c.id === columnId ? fn(c) : c)),
    })),
  };
}

function requireTable(schema: Schema, id: Id): void {
  if (!findTable(schema, id)) throw new UnknownEntityError('table', id);
}
function requireColumn(schema: Schema, id: Id): void {
  if (!findColumn(schema, id)) throw new UnknownEntityError('column', id);
}
function requireConstraint(schema: Schema, id: Id): void {
  if (!schema.constraints.some((c) => c.id === id)) throw new UnknownEntityError('constraint', id);
}
function requireIndex(schema: Schema, id: Id): void {
  if (!schema.indexes.some((i) => i.id === id)) throw new UnknownEntityError('index', id);
}
