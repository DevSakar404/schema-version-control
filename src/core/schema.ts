import type { Id } from './ids';

export type { Id };

/**
 * The schema model. See design.md §3.
 *
 * Two rules hold everywhere below, and everything else follows from them:
 *   1. Entities are identified by `id`. Nothing is ever matched by `name`.
 *   2. References between entities are by id, so a rename propagates for free.
 */

export type ColumnType =
  | { kind: 'smallint' | 'int' | 'bigint' }
  | { kind: 'boolean' | 'uuid' | 'date' | 'timestamptz' | 'jsonb' | 'text' }
  | { kind: 'varchar'; length: number }
  | { kind: 'numeric'; precision: number; scale: number };

export interface Column {
  id: Id;
  name: string;
  type: ColumnType;
  nullable: boolean;
  default: string | null;
}

export interface Table {
  id: Id;
  name: string;
  columns: Column[];
}

export type ReferentialAction = 'no_action' | 'restrict' | 'cascade' | 'set_null';

/**
 * A predicate over columns, stored by reference rather than as free text
 * (design.md §3.4).
 *
 * `CHECK (age > 0)` held as the string "age > 0" would be a name-based
 * reference invisible to rename and drop detection — a hole straight through
 * rule 1 above. Instead the columns are ids and the template carries numbered
 * placeholders; names are substituted only when SQL is rendered.
 */
export interface Expression {
  /** e.g. '{0} > 0 AND {1} IS NOT NULL' — {n} indexes into columnIds. */
  template: string;
  columnIds: Id[];
}

export type Constraint =
  | { id: Id; name: string; tableId: Id; kind: 'primary_key'; columnIds: Id[] }
  | { id: Id; name: string; tableId: Id; kind: 'unique'; columnIds: Id[] }
  | { id: Id; name: string; tableId: Id; kind: 'check'; expression: Expression }
  | {
      id: Id;
      name: string;
      tableId: Id;
      kind: 'foreign_key';
      columnIds: Id[];
      referencedTableId: Id;
      referencedColumnIds: Id[];
      onDelete: ReferentialAction;
      onUpdate: ReferentialAction;
    };

export interface Index {
  id: Id;
  name: string;
  tableId: Id;
  columnIds: Id[];
  unique: boolean;
  method: 'btree' | 'hash' | 'gin';
  where: Expression | null;
}

export interface Schema {
  tables: Table[];
  constraints: Constraint[];
  indexes: Index[];
}

export function emptySchema(): Schema {
  return { tables: [], constraints: [], indexes: [] };
}

/* ---------------------------------------------------------------- lookups */

export function findTable(schema: Schema, tableId: Id): Table | undefined {
  return schema.tables.find((t) => t.id === tableId);
}

export function findColumn(
  schema: Schema,
  columnId: Id,
): { table: Table; column: Column } | undefined {
  for (const table of schema.tables) {
    const column = table.columns.find((c) => c.id === columnId);
    if (column) return { table, column };
  }
  return undefined;
}

export function columnsOf(schema: Schema, tableId: Id): Column[] {
  return findTable(schema, tableId)?.columns ?? [];
}

export function constraintsOf(schema: Schema, tableId: Id): Constraint[] {
  return schema.constraints.filter((c) => c.tableId === tableId);
}

export function indexesOf(schema: Schema, tableId: Id): Index[] {
  return schema.indexes.filter((i) => i.tableId === tableId);
}

/** Every table id a constraint touches — both sides of a foreign key. */
export function tablesReferencedBy(entity: Constraint | Index): Id[] {
  const ids = [entity.tableId];
  if ('kind' in entity && entity.kind === 'foreign_key') ids.push(entity.referencedTableId);
  return [...new Set(ids)];
}

/**
 * Every column id an entity depends on.
 *
 * Exhaustiveness matters more here than anywhere else in the file: validation,
 * deletion cascade, and the merge containment closure all ask this question,
 * so a column missed here becomes a dangling reference nothing downstream
 * catches. Foreign keys reference both sides; checks and partial indexes
 * reference through their Expression.
 */
export function columnsReferencedBy(entity: Constraint | Index): Id[] {
  const ids: Id[] = [];
  if ('kind' in entity) {
    switch (entity.kind) {
      case 'primary_key':
      case 'unique':
        ids.push(...entity.columnIds);
        break;
      case 'check':
        ids.push(...entity.expression.columnIds);
        break;
      case 'foreign_key':
        ids.push(...entity.columnIds, ...entity.referencedColumnIds);
        break;
    }
  } else {
    ids.push(...entity.columnIds);
    if (entity.where) ids.push(...entity.where.columnIds);
  }
  return [...new Set(ids)];
}

/** Structural type equality. Parameterised types compare by value. */
export function sameType(a: ColumnType, b: ColumnType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'varchar' && b.kind === 'varchar') return a.length === b.length;
  if (a.kind === 'numeric' && b.kind === 'numeric') {
    return a.precision === b.precision && a.scale === b.scale;
  }
  return true;
}
