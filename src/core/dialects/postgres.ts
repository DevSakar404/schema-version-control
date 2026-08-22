import type { Change } from '../diff';
import type { RenameStep } from '../renames';
import type { ColumnType, Constraint, Expression, Index, Schema } from '../schema';

/**
 * Postgres DDL rendering (design.md §9.3).
 *
 * One dialect, no plugin layer. The model is dialect-neutral because it
 * describes tables and types rather than syntax; only this final step varies
 * by engine, and an interface with a single implementation is indirection
 * without a payer.
 */

/**
 * Identifier quoting. Names are user input, so this is a trust boundary:
 * everything is double-quoted and embedded quotes are doubled, which both
 * preserves mixed case and reserved words and makes the value inert.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function renderType(type: ColumnType): string {
  switch (type.kind) {
    case 'varchar':
      return `varchar(${type.length})`;
    case 'numeric':
      return `numeric(${type.precision},${type.scale})`;
    case 'timestamptz':
      return 'timestamptz';
    default:
      return type.kind;
  }
}

/**
 * Resolves entity ids to the name they hold at the point a statement runs.
 *
 * Renames are emitted before creations and alterations, so by the time those
 * statements execute every surviving entity already carries its final name —
 * hence `to` wins. Dropped entities exist only in `from`.
 */
export interface Namer {
  table(id: string): string;
  column(id: string): string;
}

export function namerFor(from: Schema, to: Schema): Namer {
  const tables = new Map<string, string>();
  const columns = new Map<string, string>();
  for (const schema of [from, to]) {
    for (const table of schema.tables) {
      tables.set(table.id, table.name);
      for (const column of table.columns) columns.set(column.id, column.name);
    }
  }
  return {
    table: (id) => quoteIdent(tables.get(id) ?? id),
    column: (id) => quoteIdent(columns.get(id) ?? id),
  };
}

/**
 * Substitutes current column names into a stored predicate (design.md §3.4).
 *
 * Because the predicate holds ids rather than text, a renamed column renders
 * with its new name automatically and the constraint itself needs no
 * migration at all.
 */
export function renderExpression(expression: Expression, namer: Namer): string {
  return expression.template.replace(/\{(\d+)\}/g, (_match, index: string) => {
    const columnId = expression.columnIds[Number(index)];
    return columnId === undefined ? '?' : namer.column(columnId);
  });
}

function renderConstraintBody(constraint: Constraint, namer: Namer): string {
  switch (constraint.kind) {
    case 'primary_key':
      return `PRIMARY KEY (${constraint.columnIds.map(namer.column).join(', ')})`;
    case 'unique':
      return `UNIQUE (${constraint.columnIds.map(namer.column).join(', ')})`;
    case 'check':
      return `CHECK (${renderExpression(constraint.expression, namer)})`;
    case 'foreign_key':
      return (
        `FOREIGN KEY (${constraint.columnIds.map(namer.column).join(', ')}) ` +
        `REFERENCES ${namer.table(constraint.referencedTableId)} ` +
        `(${constraint.referencedColumnIds.map(namer.column).join(', ')})` +
        ` ON DELETE ${referentialAction(constraint.onDelete)}` +
        ` ON UPDATE ${referentialAction(constraint.onUpdate)}`
      );
  }
}

function referentialAction(action: string): string {
  return action.replace('_', ' ').toUpperCase();
}

export function renderIndex(index: Index, namer: Namer): string {
  const unique = index.unique ? 'UNIQUE ' : '';
  const method = index.method === 'btree' ? '' : ` USING ${index.method}`;
  const where = index.where ? ` WHERE ${renderExpression(index.where, namer)}` : '';
  return (
    `CREATE ${unique}INDEX ${quoteIdent(index.name)} ON ${namer.table(index.tableId)}` +
    `${method} (${index.columnIds.map(namer.column).join(', ')})${where};`
  );
}

/** A rename step, which carries its own names and so bypasses the Namer. */
export function renderRename(step: RenameStep, namer: Namer): string {
  return step.scope === 'table'
    ? `ALTER TABLE ${quoteIdent(step.from)} RENAME TO ${quoteIdent(step.to)};`
    : `ALTER TABLE ${namer.table(step.scope)} RENAME COLUMN ${quoteIdent(step.from)} TO ${quoteIdent(step.to)};`;
}

export interface RenderContext {
  namer: Namer;
  schemas: Schema[];
  /** Columns to inline into a CREATE TABLE, keyed by table id. */
  newTableColumns: Map<string, { name: string; type: ColumnType; nullable: boolean; default: string | null }[]>;
}

export function renderChange(change: Change, ctx: RenderContext): string {
  const { namer } = ctx;
  const table = (id: string) => namer.table(id);

  switch (change.kind) {
    case 'table_created': {
      const columns = ctx.newTableColumns.get(change.tableId) ?? [];
      if (columns.length === 0) return `CREATE TABLE ${quoteIdent(change.name)} ();`;
      const body = columns
        .map((c) => {
          const nullable = c.nullable ? '' : ' NOT NULL';
          const dflt = c.default === null ? '' : ` DEFAULT ${c.default}`;
          return `  ${quoteIdent(c.name)} ${renderType(c.type)}${nullable}${dflt}`;
        })
        .join(',\n');
      return `CREATE TABLE ${quoteIdent(change.name)} (\n${body}\n);`;
    }

    case 'table_dropped':
      return `DROP TABLE ${quoteIdent(change.name)};`;

    case 'table_renamed':
      return `ALTER TABLE ${quoteIdent(change.from)} RENAME TO ${quoteIdent(change.to)};`;

    case 'column_added': {
      const nullable = change.column.nullable ? '' : ' NOT NULL';
      const dflt = change.column.default === null ? '' : ` DEFAULT ${change.column.default}`;
      return (
        `ALTER TABLE ${table(change.tableId)} ADD COLUMN ` +
        `${quoteIdent(change.column.name)} ${renderType(change.column.type)}${nullable}${dflt};`
      );
    }

    case 'column_dropped':
      return `ALTER TABLE ${table(change.tableId)} DROP COLUMN ${quoteIdent(change.name)};`;

    case 'column_renamed':
      return (
        `ALTER TABLE ${table(change.tableId)} RENAME COLUMN ` +
        `${quoteIdent(change.from)} TO ${quoteIdent(change.to)};`
      );

    case 'column_retyped': {
      // USING is required whenever Postgres has no implicit cast between the
      // two types; harmless to state explicitly and clearer in a reviewed
      // migration than relying on which casts happen to be implicit.
      const target = renderType(change.to);
      const using = ` USING ${namer.column(change.columnId)}::${target}`;
      return (
        `ALTER TABLE ${table(change.tableId)} ALTER COLUMN ` +
        `${namer.column(change.columnId)} TYPE ${target}${using};`
      );
    }

    case 'column_nullability_changed':
      return (
        `ALTER TABLE ${table(change.tableId)} ALTER COLUMN ${namer.column(change.columnId)} ` +
        `${change.to ? 'DROP NOT NULL' : 'SET NOT NULL'};`
      );

    case 'column_default_changed':
      return (
        `ALTER TABLE ${table(change.tableId)} ALTER COLUMN ${namer.column(change.columnId)} ` +
        `${change.to === null ? 'DROP DEFAULT' : `SET DEFAULT ${change.to}`};`
      );

    case 'constraint_added':
      return (
        `ALTER TABLE ${table(change.constraint.tableId)} ADD CONSTRAINT ` +
        `${quoteIdent(change.constraint.name)} ${renderConstraintBody(change.constraint, namer)};`
      );

    case 'constraint_dropped':
      return `ALTER TABLE ${ownerTableOfConstraint(change.constraintId, ctx)} DROP CONSTRAINT ${quoteIdent(change.name)};`;

    case 'constraint_changed':
      // Postgres cannot alter a constraint in place; it is dropped and re-added.
      return (
        `ALTER TABLE ${table(change.to.tableId)} DROP CONSTRAINT ${quoteIdent(change.from.name)};\n` +
        `ALTER TABLE ${table(change.to.tableId)} ADD CONSTRAINT ${quoteIdent(change.to.name)} ` +
        `${renderConstraintBody(change.to, namer)};`
      );

    case 'index_added':
      return renderIndex(change.index, namer);

    case 'index_dropped':
      return `DROP INDEX ${quoteIdent(change.name)};`;

    case 'index_changed':
      return `DROP INDEX ${quoteIdent(change.from.name)};\n${renderIndex(change.to, namer)}`;
  }
}

function ownerTableOfConstraint(constraintId: string, ctx: RenderContext): string {
  for (const schema of ctx.schemas) {
    const found = schema.constraints.find((c) => c.id === constraintId);
    if (found) return ctx.namer.table(found.tableId);
  }
  return '"unknown"';
}
