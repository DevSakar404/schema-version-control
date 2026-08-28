import type { Id } from './ids';
import { describeChange, describeType, diff, subjectOf, type Change } from './diff';
import {
  findColumn,
  findTable,
  type Column,
  type Constraint,
  type Expression,
  type Index,
  type Schema,
} from './schema';

/**
 * A view model over `diff()` output: the full schema, annotated with what
 * changed, rather than only the changes themselves.
 *
 * `diff()` answers "what is different", which is the right shape for merge
 * and for generating a migration. It is the wrong shape for a human reading
 * a screen: "Dropped constraint `payments_pkey`" tells you nothing about
 * which table that was on, what else lives there, or what the table looked
 * like before. A code review tool doesn't show you four disconnected changed
 * lines — it shows you the file with the changed lines marked in place, and
 * enough untouched context around them to understand what you're looking at.
 *
 * So this walks base ∪ head, matching entities by id (never by name — see
 * design.md §3.1), and emits every table, column, constraint, and index with
 * a status. Unchanged entities are included deliberately: they are the
 * context that makes the changed ones legible.
 *
 * Pure and dependency-free, like everything else in core, so it's testable
 * without a database or a browser.
 */

export type RowStatus = 'unchanged' | 'added' | 'dropped' | 'modified';

export interface DiffRow<T> {
  id: Id;
  status: RowStatus;
  /** Set only when the name itself changed, so the UI can render `old → new`. */
  renamedFrom: string | null;
  before: T | null;
  after: T | null;
  /**
   * One-line renderings of the entity on each side, with column and table
   * names already resolved. A modified row shows both — the old line and the
   * new one — which is what makes this read like a code diff rather than a
   * changelog. Built here rather than in the component because resolving a
   * foreign key's referenced table, or a CHECK predicate's column names,
   * needs the schemas, and name resolution is core's job (design.md §3.4).
   */
  beforeLabel: string | null;
  afterLabel: string | null;
  /** Plain-language descriptions of every change touching this entity. */
  notes: string[];
}

export interface TableDiff {
  id: Id;
  /** Current name, or the old one if the table was dropped. */
  name: string;
  status: RowStatus;
  renamedFrom: string | null;
  columns: DiffRow<Column>[];
  constraints: DiffRow<Constraint>[];
  indexes: DiffRow<Index>[];
  /** Every change anywhere inside this table, including the table row itself. */
  changeCount: number;
}

export interface DiffTree {
  tables: TableDiff[];
  totalChanges: number;
  changedTables: number;
  unchangedTables: number;
}

export function buildDiffTree(base: Schema, head: Schema): DiffTree {
  const changes = diff(base, head);

  const bySubject = new Map<Id, Change[]>();
  for (const change of changes) {
    const key = subjectOf(change);
    bySubject.set(key, [...(bySubject.get(key) ?? []), change]);
  }

  // describeChange resolves a column's display name through a schema. Use
  // whichever side still has the column — a dropped one only exists in base.
  const describe = (change: Change): string =>
    describeChange(change, findColumn(head, subjectOf(change)) ? head : base);

  const rowsFor = <T extends { id: Id; name: string }>(
    before: T[],
    after: T[],
    label: (entity: T, schema: Schema) => string,
  ): DiffRow<T>[] =>
    pair(before, after).map(({ id, before: b, after: a }) => {
      const notes = (bySubject.get(id) ?? []).map(describe);
      return {
        id,
        status: rowStatus(b, a, notes.length),
        renamedFrom: b && a && b.name !== a.name ? b.name : null,
        before: b,
        after: a,
        beforeLabel: b ? label(b, base) : null,
        afterLabel: a ? label(a, head) : null,
        notes,
      };
    });

  const tables: TableDiff[] = pair(base.tables, head.tables).map(({ id, before, after }) => {
    const columns = rowsFor(before?.columns ?? [], after?.columns ?? [], columnLabel);
    const constraints = rowsFor(ownedBy(base.constraints, id), ownedBy(head.constraints, id), constraintLabel);
    const indexes = rowsFor(ownedBy(base.indexes, id), ownedBy(head.indexes, id), indexLabel);

    const tableNotes = (bySubject.get(id) ?? []).map(describe);
    const nested = [...columns, ...constraints, ...indexes];

    return {
      id,
      name: after?.name ?? before?.name ?? id,
      status: rowStatus(before, after, tableNotes.length),
      renamedFrom: before && after && before.name !== after.name ? before.name : null,
      columns,
      constraints,
      indexes,
      changeCount: tableNotes.length + nested.reduce((n, row) => n + row.notes.length, 0),
    };
  });

  return {
    tables,
    totalChanges: changes.length,
    changedTables: tables.filter((t) => t.changeCount > 0).length,
    unchangedTables: tables.filter((t) => t.changeCount === 0).length,
  };
}

function rowStatus<T>(before: T | null, after: T | null, noteCount: number): RowStatus {
  if (!before && after) return 'added';
  if (before && !after) return 'dropped';
  return noteCount > 0 ? 'modified' : 'unchanged';
}

function ownedBy<T extends { tableId: Id }>(entities: T[], tableId: Id): T[] {
  return entities.filter((e) => e.tableId === tableId);
}

/**
 * Match two lists of entities by id, preserving the base schema's ordering so
 * unchanged rows stay where a reader last saw them. Entities that exist only
 * in head are appended — they are new, so they have no prior position.
 */
function pair<T extends { id: Id }>(
  before: T[],
  after: T[],
): { id: Id; before: T | null; after: T | null }[] {
  const afterById = new Map(after.map((e) => [e.id, e]));
  const beforeIds = new Set(before.map((e) => e.id));

  return [
    ...before.map((b) => ({ id: b.id, before: b, after: afterById.get(b.id) ?? null })),
    ...after.filter((a) => !beforeIds.has(a.id)).map((a) => ({ id: a.id, before: null, after: a })),
  ];
}

/* ------------------------------------------------------- entity labels */

export function columnLabel(column: Column): string {
  const parts = [column.name, describeType(column.type)];
  if (!column.nullable) parts.push('NOT NULL');
  if (column.default !== null) parts.push(`DEFAULT ${column.default}`);
  return parts.join(' ');
}

export function constraintLabel(constraint: Constraint, schema: Schema): string {
  const cols = (ids: Id[]) => ids.map((id) => nameOfColumn(schema, id)).join(', ');
  switch (constraint.kind) {
    case 'primary_key':
      return `CONSTRAINT ${constraint.name} PRIMARY KEY (${cols(constraint.columnIds)})`;
    case 'unique':
      return `CONSTRAINT ${constraint.name} UNIQUE (${cols(constraint.columnIds)})`;
    case 'check':
      return `CONSTRAINT ${constraint.name} CHECK (${renderPredicate(constraint.expression, schema)})`;
    case 'foreign_key': {
      const target = findTable(schema, constraint.referencedTableId)?.name ?? constraint.referencedTableId;
      return (
        `CONSTRAINT ${constraint.name} FOREIGN KEY (${cols(constraint.columnIds)}) ` +
        `REFERENCES ${target} (${cols(constraint.referencedColumnIds)})`
      );
    }
  }
}

export function indexLabel(index: Index, schema: Schema): string {
  const cols = index.columnIds.map((id) => nameOfColumn(schema, id)).join(', ');
  const parts = [index.unique ? 'UNIQUE INDEX' : 'INDEX', index.name, `(${cols})`];
  if (index.method !== 'btree') parts.push(`USING ${index.method}`);
  if (index.where) parts.push(`WHERE ${renderPredicate(index.where, schema)}`);
  return parts.join(' ');
}

/** Display-only predicate rendering — unquoted, unlike the Postgres renderer. */
function renderPredicate(expression: Expression, schema: Schema): string {
  return expression.columnIds.reduce(
    (out, id, i) => out.replaceAll(`{${i}}`, nameOfColumn(schema, id)),
    expression.template,
  );
}

/** Falls back to the raw id, which only happens for an already-invalid schema. */
function nameOfColumn(schema: Schema, columnId: Id): string {
  return findColumn(schema, columnId)?.column.name ?? columnId;
}

/* -------------------------------------------------- rendered diff lines */

export type DiffLineKind = 'hunk' | 'context' | 'add' | 'del';

/**
 * A table's rows flattened into numbered diff lines, the shape a code-review
 * diff actually renders: two line-number gutters, a +/-/space marker, and the
 * text.
 *
 * Numbering runs continuously down the whole table rather than restarting per
 * section, because the table is the "file" here — the sections are hunks
 * within it. A replaced row consumes one number on each side (a `del` line
 * and an `add` line), exactly like a changed line in a text diff.
 *
 * Lives in core rather than the component because off-by-one errors in line
 * numbering are easy to introduce and invisible on inspection.
 */
export interface DiffLine {
  kind: DiffLineKind;
  beforeNo: number | null;
  afterNo: number | null;
  text: string;
  notes: string[];
}

export function toDiffLines(table: TableDiff): DiffLine[] {
  const lines: DiffLine[] = [];
  let beforeNo = 0;
  let afterNo = 0;

  const sections: [string, DiffRow<unknown>[]][] = [
    ['columns', table.columns],
    ['constraints', table.constraints],
    ['indexes', table.indexes],
  ];

  for (const [name, rows] of sections) {
    if (rows.length === 0) continue;

    lines.push({
      kind: 'hunk',
      beforeNo: null,
      afterNo: null,
      text: `@@ -${rows.filter((r) => r.before).length} +${rows.filter((r) => r.after).length} @@ ${name}`,
      notes: [],
    });

    for (const row of rows) {
      // A replaced row renders as two lines. Anything else is one.
      if (row.status === 'modified' && row.beforeLabel && row.afterLabel) {
        lines.push({ kind: 'del', beforeNo: ++beforeNo, afterNo: null, text: row.beforeLabel, notes: [] });
        lines.push({ kind: 'add', beforeNo: null, afterNo: ++afterNo, text: row.afterLabel, notes: row.notes });
        continue;
      }
      if (row.status === 'added' && row.afterLabel) {
        lines.push({ kind: 'add', beforeNo: null, afterNo: ++afterNo, text: row.afterLabel, notes: row.notes });
        continue;
      }
      if (row.status === 'dropped' && row.beforeLabel) {
        lines.push({ kind: 'del', beforeNo: ++beforeNo, afterNo: null, text: row.beforeLabel, notes: row.notes });
        continue;
      }
      // Unchanged. Note that beforeLabel and afterLabel can still DIFFER here
      // — an untouched constraint renders with a renamed column's new name —
      // but the entity itself did not change, so it stays context rather than
      // being reported as a modification it isn't. The current state is what
      // a reader wants on a context line.
      lines.push({
        kind: 'context',
        beforeNo: ++beforeNo,
        afterNo: ++afterNo,
        text: row.afterLabel ?? row.beforeLabel ?? '',
        notes: row.notes,
      });
    }
  }

  return lines;
}

/** Added and removed line counts, for a `+N −M` stat. */
export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((l) => l.kind === 'add').length,
    removed: lines.filter((l) => l.kind === 'del').length,
  };
}

/** One line of a side-by-side row, or absent when that side has nothing to show. */
export interface SplitCell {
  no: number;
  text: string;
  changed: boolean;
}

export interface SplitLine {
  kind: 'hunk' | 'row';
  /** Hunk header text; empty for a `row`. */
  text: string;
  left: SplitCell | null;
  right: SplitCell | null;
  notes: string[];
}

/**
 * The same rows as `toDiffLines`, shaped for side-by-side instead of
 * unified rendering: one row per entity, old on the left and new on the
 * right, rather than a del line followed by an add line.
 *
 * Deliberately walks `table`'s rows itself rather than post-processing
 * `toDiffLines`' output by pairing up adjacent del/add lines — two
 * DIFFERENT rows can just as easily land next to each other in that flat
 * list (a dropped constraint immediately followed by an unrelated added
 * one, say), and pairing by adjacency would silently show them as if one
 * had replaced the other. Walking the rows directly has no such ambiguity:
 * each `DiffRow` maps to exactly one `SplitLine`, always.
 */
export function toSplitLines(table: TableDiff): SplitLine[] {
  const lines: SplitLine[] = [];
  let beforeNo = 0;
  let afterNo = 0;

  const sections: [string, DiffRow<unknown>[]][] = [
    ['columns', table.columns],
    ['constraints', table.constraints],
    ['indexes', table.indexes],
  ];

  for (const [name, rows] of sections) {
    if (rows.length === 0) continue;

    lines.push({
      kind: 'hunk',
      text: `@@ -${rows.filter((r) => r.before).length} +${rows.filter((r) => r.after).length} @@ ${name}`,
      left: null,
      right: null,
      notes: [],
    });

    for (const row of rows) {
      if (row.status === 'modified' && row.beforeLabel && row.afterLabel) {
        lines.push({
          kind: 'row',
          text: '',
          left: { no: ++beforeNo, text: row.beforeLabel, changed: true },
          right: { no: ++afterNo, text: row.afterLabel, changed: true },
          notes: row.notes,
        });
        continue;
      }
      if (row.status === 'added' && row.afterLabel) {
        lines.push({
          kind: 'row',
          text: '',
          left: null,
          right: { no: ++afterNo, text: row.afterLabel, changed: true },
          notes: row.notes,
        });
        continue;
      }
      if (row.status === 'dropped' && row.beforeLabel) {
        lines.push({
          kind: 'row',
          text: '',
          left: { no: ++beforeNo, text: row.beforeLabel, changed: true },
          right: null,
          notes: row.notes,
        });
        continue;
      }
      // Unchanged — see the matching comment in toDiffLines: the current
      // label is what a reader wants on a context line, even if a rename
      // elsewhere changed what that label says on each side.
      lines.push({
        kind: 'row',
        text: '',
        left: { no: ++beforeNo, text: row.beforeLabel ?? row.afterLabel ?? '', changed: false },
        right: { no: ++afterNo, text: row.afterLabel ?? row.beforeLabel ?? '', changed: false },
        notes: row.notes,
      });
    }
  }

  return lines;
}
