import type { Id } from './ids';
import { attributeOf, describeChange, diff, subjectOf, type Change } from './diff';
import { validate, type Hazard } from './validate';
import type { ColumnType, Schema, Table } from './schema';

/**
 * Three-way merge (design.md §7).
 *
 * Changes are paired by (entity, attribute), not by entity. That granularity
 * is the point: Ana renaming `email` and Ben retyping `email` touch different
 * attributes of one column and merge cleanly, where a line-oriented tool sees
 * one edited line and reports a conflict.
 */
export type ConflictClass =
  | 'concurrent_rename'
  | 'concurrent_retype'
  | 'concurrent_nullability'
  | 'concurrent_default'
  | 'delete_modify'
  | 'name_collision'
  | 'constraint_divergence'
  | 'index_divergence';

export interface Conflict {
  /** `${entityId}:${attribute}` — stable across previews, so the UI can key on it. */
  id: string;
  class: ConflictClass;
  entity: { kind: 'table' | 'column' | 'constraint' | 'index'; id: Id; displayName: string };
  attribute: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
  /** Plain language, naming both sides. Rendered directly in the UI. */
  description: string;
}

export type Resolution =
  | { conflictId: string; choice: 'ours' }
  | { conflictId: string; choice: 'theirs' }
  | { conflictId: string; choice: 'custom'; value: unknown };

export interface MergeResult {
  schema: Schema;
  /** Unresolved only. */
  conflicts: Conflict[];
  hazards: Hazard[];
  /** Auto-merged changes, for display. */
  applied: Change[];
}

export interface MergeOptions {
  /** Branch labels used in conflict descriptions. */
  oursLabel?: string;
  theirsLabel?: string;
}

export function threeWayMerge(
  base: Schema,
  ours: Schema,
  theirs: Schema,
  resolutions: Resolution[] = [],
  options: MergeOptions = {},
): MergeResult {
  const oursLabel = options.oursLabel ?? 'ours';
  const theirsLabel = options.theirsLabel ?? 'theirs';

  const oursChanges = keyChanges(diff(base, ours));
  const theirsChanges = keyChanges(diff(base, theirs));

  const conflicts: Conflict[] = [];
  const applied: Change[] = [];
  const byResolution = new Map(resolutions.map((r) => [r.conflictId, r]));

  for (const key of new Set([...oursChanges.keys(), ...theirsChanges.keys()])) {
    const mine = oursChanges.get(key);
    const yours = theirsChanges.get(key);

    if (mine && !yours) { applied.push(mine); continue; }
    if (yours && !mine) { applied.push(yours); continue; }
    if (!mine || !yours) continue;

    // Both sides changed the same attribute. Identical targets are convergent
    // — two people reaching the same conclusion is agreement, not conflict.
    if (sameTarget(mine, yours)) { applied.push(mine); continue; }

    const conflict = describeConflict(key, base, mine, yours, oursLabel, theirsLabel);
    const resolution = byResolution.get(conflict.id);
    if (!resolution) { conflicts.push(conflict); continue; }

    const chosen = resolveTo(resolution, mine, yours);
    if (chosen) applied.push(chosen);
  }

  const schema = applyChanges(base, applied);
  return { schema, conflicts, hazards: validate(schema), applied };
}

/* ------------------------------------------------------------- pairing */

function keyChanges(changes: Change[]): Map<string, Change> {
  return new Map(changes.map((c) => [`${subjectOf(c)}:${attributeOf(c)}`, c]));
}

/** The value a change moves an attribute *to*. */
function targetOf(change: Change): unknown {
  switch (change.kind) {
    case 'table_created':
    case 'column_added':
    case 'constraint_added':
    case 'index_added':
      return 'created';
    case 'table_dropped':
    case 'column_dropped':
    case 'constraint_dropped':
    case 'index_dropped':
      return 'dropped';
    case 'table_renamed':
    case 'column_renamed':
    case 'column_retyped':
    case 'column_nullability_changed':
    case 'column_default_changed':
    case 'constraint_changed':
    case 'index_changed':
      return change.to;
  }
}

/** The value the attribute held in the merge base. */
function originOf(change: Change): unknown {
  return 'from' in change ? change.from : null;
}

function sameTarget(a: Change, b: Change): boolean {
  return JSON.stringify(targetOf(a)) === JSON.stringify(targetOf(b));
}

function resolveTo(resolution: Resolution, ours: Change, theirs: Change): Change | null {
  if (resolution.choice === 'ours') return ours;
  if (resolution.choice === 'theirs') return theirs;
  return withTarget(ours, resolution.value);
}

/** Rebuild a change carrying a value neither branch proposed (design.md §7.5). */
function withTarget(change: Change, value: unknown): Change | null {
  switch (change.kind) {
    case 'table_renamed':
    case 'column_renamed':
      return { ...change, to: value as string };
    case 'column_retyped':
      return { ...change, to: value as ColumnType };
    case 'column_nullability_changed':
      return { ...change, to: value as boolean };
    case 'column_default_changed':
      return { ...change, to: value as string | null };
    case 'constraint_changed':
      return { ...change, to: value as (Change & { kind: 'constraint_changed' })['to'] };
    case 'index_changed':
      return { ...change, to: value as (Change & { kind: 'index_changed' })['to'] };
    default:
      // Existence conflicts resolve by choosing a side, not by inventing a value.
      return null;
  }
}

/* -------------------------------------------------------- classification */

function classOf(change: Change, attribute: string): ConflictClass {
  switch (attribute) {
    case 'name': return 'concurrent_rename';
    case 'type': return 'concurrent_retype';
    case 'nullable': return 'concurrent_nullability';
    case 'default': return 'concurrent_default';
    case 'definition':
      return change.kind === 'index_changed' ? 'index_divergence' : 'constraint_divergence';
    default: return 'delete_modify';
  }
}

function entityOf(change: Change, base: Schema): Conflict['entity'] {
  const id = subjectOf(change);
  if ('columnId' in change) {
    const found = base.tables.flatMap((t: Table) => t.columns).find((c) => c.id === id);
    return { kind: 'column', id, displayName: found?.name ?? id };
  }
  if ('constraintId' in change) {
    return { kind: 'constraint', id, displayName: base.constraints.find((c) => c.id === id)?.name ?? id };
  }
  if ('indexId' in change) {
    return { kind: 'index', id, displayName: base.indexes.find((i) => i.id === id)?.name ?? id };
  }
  return { kind: 'table', id, displayName: base.tables.find((t) => t.id === id)?.name ?? id };
}

function describeConflict(
  key: string,
  base: Schema,
  ours: Change,
  theirs: Change,
  oursLabel: string,
  theirsLabel: string,
): Conflict {
  const attribute = attributeOf(ours);
  const entity = entityOf(ours, base);
  return {
    id: key,
    class: classOf(ours, attribute),
    entity,
    attribute,
    base: originOf(ours),
    ours: targetOf(ours),
    theirs: targetOf(theirs),
    description: `${oursLabel}: ${describeChange(ours)}. ${theirsLabel}: ${describeChange(theirs)}.`,
  };
}

/* ------------------------------------------------------------ applying */

/**
 * Apply resolved changes to the base schema.
 *
 * Ordered so a change never lands on something that does not exist yet:
 * creations, then modifications, then deletions.
 */
function applyChanges(base: Schema, changes: Change[]): Schema {
  const phase = (c: Change): number => {
    switch (c.kind) {
      case 'table_created': return 0;
      case 'column_added': return 1;
      case 'table_renamed':
      case 'column_renamed':
      case 'column_retyped':
      case 'column_nullability_changed':
      case 'column_default_changed': return 2;
      case 'constraint_added':
      case 'index_added': return 3;
      case 'constraint_changed':
      case 'index_changed': return 4;
      case 'constraint_dropped':
      case 'index_dropped': return 5;
      case 'column_dropped': return 6;
      case 'table_dropped': return 7;
    }
  };

  return [...changes].sort((a, b) => phase(a) - phase(b)).reduce(applyChange, base);
}

function applyChange(schema: Schema, change: Change): Schema {
  const mapTable = (id: Id, fn: (t: Table) => Table): Schema => ({
    ...schema,
    tables: schema.tables.map((t) => (t.id === id ? fn(t) : t)),
  });

  switch (change.kind) {
    case 'table_created':
      return schema.tables.some((t) => t.id === change.tableId)
        ? schema
        : { ...schema, tables: [...schema.tables, { id: change.tableId, name: change.name, columns: [] }] };

    case 'table_dropped':
      return {
        tables: schema.tables.filter((t) => t.id !== change.tableId),
        constraints: schema.constraints.filter((c) => c.tableId !== change.tableId),
        indexes: schema.indexes.filter((i) => i.tableId !== change.tableId),
      };

    case 'table_renamed':
      return mapTable(change.tableId, (t) => ({ ...t, name: change.to }));

    case 'column_added':
      return mapTable(change.tableId, (t) =>
        t.columns.some((c) => c.id === change.columnId) ? t : { ...t, columns: [...t.columns, change.column] },
      );

    case 'column_dropped':
      return mapTable(change.tableId, (t) => ({
        ...t,
        columns: t.columns.filter((c) => c.id !== change.columnId),
      }));

    case 'column_renamed':
      return mapColumn(schema, change.columnId, (c) => ({ ...c, name: change.to }));
    case 'column_retyped':
      return mapColumn(schema, change.columnId, (c) => ({ ...c, type: change.to }));
    case 'column_nullability_changed':
      return mapColumn(schema, change.columnId, (c) => ({ ...c, nullable: change.to }));
    case 'column_default_changed':
      return mapColumn(schema, change.columnId, (c) => ({ ...c, default: change.to }));

    case 'constraint_added':
      return schema.constraints.some((c) => c.id === change.constraintId)
        ? schema
        : { ...schema, constraints: [...schema.constraints, change.constraint] };
    case 'constraint_dropped':
      return { ...schema, constraints: schema.constraints.filter((c) => c.id !== change.constraintId) };
    case 'constraint_changed':
      return {
        ...schema,
        constraints: schema.constraints.map((c) => (c.id === change.constraintId ? change.to : c)),
      };

    case 'index_added':
      return schema.indexes.some((i) => i.id === change.indexId)
        ? schema
        : { ...schema, indexes: [...schema.indexes, change.index] };
    case 'index_dropped':
      return { ...schema, indexes: schema.indexes.filter((i) => i.id !== change.indexId) };
    case 'index_changed':
      return { ...schema, indexes: schema.indexes.map((i) => (i.id === change.indexId ? change.to : i)) };
  }
}

function mapColumn(schema: Schema, columnId: Id, fn: (c: Table['columns'][number]) => Table['columns'][number]): Schema {
  return {
    ...schema,
    tables: schema.tables.map((t) => ({
      ...t,
      columns: t.columns.map((c) => (c.id === columnId ? fn(c) : c)),
    })),
  };
}
