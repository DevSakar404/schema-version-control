import { describeType, type Change } from './diff';
import { sameType, type ColumnType } from './schema';

/**
 * Migration safety classification (design.md §9.2).
 *
 * Row data is out of scope for this tool, but whether a schema change
 * *destroys* data is a property of the schema change, so it is classified and
 * displayed. Respecting a scope boundary should not mean pretending not to
 * know what is on the other side of it.
 */
export type Safety = 'safe' | 'destructive' | 'lossy' | 'blocking';

const INTEGER_RANK: Partial<Record<ColumnType['kind'], number>> = {
  smallint: 1,
  int: 2,
  bigint: 3,
};

/**
 * Whether every value of `from` fits in `to` without truncation or a failed
 * cast. Widening is safe; anything else needs a warning.
 */
export function isWidening(from: ColumnType, to: ColumnType): boolean {
  if (sameType(from, to)) return true;

  const fromRank = INTEGER_RANK[from.kind];
  const toRank = INTEGER_RANK[to.kind];
  if (fromRank !== undefined && toRank !== undefined) return toRank >= fromRank;

  // Any string fits in unbounded text; the reverse can truncate.
  if (from.kind === 'varchar' && to.kind === 'text') return true;
  if (from.kind === 'varchar' && to.kind === 'varchar') return to.length >= from.length;

  if (from.kind === 'numeric' && to.kind === 'numeric') {
    return to.precision >= from.precision && to.scale >= from.scale;
  }

  // Across families (int -> text, text -> uuid, …) Postgres needs an explicit
  // cast that can fail on existing rows.
  return false;
}

export function classifyChange(change: Change): { safety: Safety; note: string | null } {
  switch (change.kind) {
    case 'table_created':
    case 'column_renamed':
    case 'table_renamed':
    case 'constraint_dropped':
    case 'index_dropped':
      return { safety: 'safe', note: null };

    case 'table_dropped':
      return { safety: 'destructive', note: 'Drops the table and every row in it. Irreversible.' };
    case 'column_dropped':
      return { safety: 'destructive', note: 'Drops the column and its data. Irreversible.' };

    case 'column_added':
      if (!change.column.nullable && change.column.default === null) {
        return {
          safety: 'lossy',
          note: 'Adding a NOT NULL column with no default fails if the table has any rows.',
        };
      }
      return { safety: 'safe', note: null };

    case 'column_retyped': {
      if (isWidening(change.from, change.to)) {
        return { safety: 'safe', note: null };
      }
      return {
        safety: 'lossy',
        note: `${describeType(change.from)} → ${describeType(change.to)} can truncate or fail on existing rows.`,
      };
    }

    case 'column_nullability_changed':
      return change.to
        ? { safety: 'safe', note: null }
        : { safety: 'lossy', note: 'SET NOT NULL fails if any existing row holds a null.' };

    case 'column_default_changed':
      // Defaults apply to future inserts only; existing rows are untouched.
      return { safety: 'safe', note: null };

    case 'constraint_added':
      if (change.constraint.kind === 'check' || change.constraint.kind === 'foreign_key') {
        return {
          safety: 'blocking',
          note: 'Validated against every existing row, which locks the table while it runs.',
        };
      }
      return {
        safety: 'blocking',
        note: 'Builds an index over the table, which locks it while it runs.',
      };

    case 'constraint_changed':
      return { safety: 'blocking', note: 'Re-validated against every existing row.' };

    case 'index_added':
    case 'index_changed':
      return {
        safety: 'blocking',
        note: 'CREATE INDEX locks the table for writes. Consider CONCURRENTLY on a large table.',
      };
  }
}
